/**
 * Turning a photo into a stored meal, and a chat reply into a confirmation.
 *
 * Two problems this file exists to solve, both found in review rather than in
 * code:
 *
 * 1. **Which meal does "ok" refer to?** A bare confirmation after two photos
 *    is ambiguous. Telegram gives `reply_to_message` only when the user
 *    deliberately replies to a specific message, which is the minority case.
 * 2. **A cap that is silent is a bug.** If a photo is not processed because a
 *    limit was hit, the user believes the meal was logged. Say it in chat.
 */

import type { Db } from '../db/index.js';
import { MealsRepo, MealValidationError, type NewExtraction } from '../db/repos/meals.js';
import {
  ModelCallsRepo,
  type FinishModelCall,
  type ModelCallOutcome,
} from '../db/repos/model_calls.js';
import { TelegramUpdatesRepo, type TelegramUpdateRow } from '../db/repos/telegram_updates.js';
import {
  extractMeal,
  correctMeal,
  DEFAULT_MODEL,
  type CallMetrics,
  type ExtractedMeal,
  type ExtractionResult,
  type QueryRunner,
} from './extractor.js';
import { CORRECTION_PROMPT_VERSION, PROMPT_VERSION } from './prompts.js';

/**
 * Estimates per rolling window, photos and corrections together. Every one
 * spends money; a flood should not. Rolling, not per calendar day: the old
 * per-day counter was keyed by the meal's day, which left corrections to
 * yesterday's meals uncapped.
 */
export const ESTIMATE_CAP = 40;
export const ESTIMATE_CAP_WINDOW_HOURS = 24;
/** Routing calls are not estimates; the router caps them separately. */
const ESTIMATE_PURPOSES = ['extract_photo', 'extract_text', 'correct'] as const;

/**
 * Model calls one message may cause before it is given up on. A save that
 * fails the same way every cycle is not a transient fault, and each retry is a
 * paid call: unbounded, one message spent the whole day's cap.
 */
export const MAX_ATTEMPTS_PER_MESSAGE = 3;

/** How a call ended, with what the model said and what it cost. */
function finishRecord(
  outcome: ModelCallOutcome,
  result: { raw_response?: string } & Partial<CallMetrics>,
  extra: Pick<FinishModelCall, 'meal_id' | 'extraction_id' | 'decision' | 'error'> = {},
): FinishModelCall {
  return {
    outcome,
    raw_response: result.raw_response ?? null,
    usage: result.usage,
    cost_usd: result.cost_usd ?? null,
    duration_ms: result.duration_ms ?? null,
    ...extra,
  };
}

/**
 * End a model call. Its outcome, whatever it wrote, and the handled mark
 * commit together: a restart between any two either pays for the call again
 * or applies its result twice.
 */
function settleCall<T>(
  db: Db,
  call: { id: number; updateId: number },
  write: () => { record: FinishModelCall; result: T },
): T {
  return db.transaction(() => {
    const { record, result } = write();
    new ModelCallsRepo(db).finish(call.id, record);
    new TelegramUpdatesRepo(db).markHandled(call.updateId);
    return result;
  })();
}

/** An accepted estimate in the shape addExtraction stores. */
function storedEstimate(
  result: { model: string; prompt_version: string; raw_response?: string },
  meal: ExtractedMeal,
  description: string,
): NewExtraction {
  return {
    model: result.model,
    prompt_version: result.prompt_version,
    confidence: meal.confidence,
    description,
    totals: meal.totals,
    raw_response: result.raw_response ?? null,
    items: meal.items.map((item) => ({
      name: item.name,
      portion_text: item.portion_text ?? null,
      grams: item.grams ?? null,
      confidence: item.confidence ?? null,
    })),
  };
}

/**
 * A plausibility violation as the end of a sentence: "(energy consumed above
 * …)". A violation's `reason` is written to follow "<nutrient> <value> — ", so
 * on its own it needs its nutrient to read as a sentence.
 */
function violationClause(err: unknown): string {
  const violation = err instanceof MealValidationError ? err.violations[0] : undefined;
  return violation
    ? ` (${violation.nutrient.replace(/^dietary_/, '').replace(/_/g, ' ')} ${violation.reason})`
    : '';
}

/** A duplicate the unique keys refused: the change is already there. */
function isUniqueConflict(err: unknown): boolean {
  return (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export type ConfirmIntent =
  | { kind: 'confirm'; replyToMessageId?: number }
  | { kind: 'reject'; replyToMessageId?: number }
  | { kind: 'correct'; text: string; replyToMessageId?: number }
  | { kind: 'none' };

/** How many amendments before a re-send serves better than another guess. */
export const MAX_CORRECTION_DEPTH = 3;

/** How far back a bare correction may reach. */
export const CORRECTION_WINDOW_HOURS = 24;

/** A nutrient moving by less than this is not worth reporting. */
const REPORTABLE_CHANGE = 0.05;

const CONFIRM_WORDS = new Set(['ok', 'okay', 'yes', 'y', 'yep', 'correct', 'right', '👍', '✅']);
const REJECT_WORDS = new Set(['no', 'nope', 'wrong', 'delete', 'remove', 'void', '❌']);

/**
 * Meals are saved as soon as they are estimated, rather than waiting for a
 * reply.
 *
 * The earlier design made confirmation a gate: nothing counted until the user
 * said "ok". Correct in principle, wrong in practice — it taxes every single
 * meal to protect against the rare wrong one, and a logging tool that asks
 * for a reply six times a day stops being used, which loses far more data
 * than a bad estimate ever would.
 *
 * What makes this safe is that correction stays cheap: an amended meal
 * supersedes its extraction, and "no" voids it, removing the numbers while
 * keeping the record. Auto-saving is reversible; an abandoned tool is not.
 */
export const AUTO_CONFIRM = true;

/**
 * Read a short reply as a confirmation, a rejection, or neither.
 *
 * Only *short* messages count. "ok" is a confirmation; "ok so I also had a
 * coffee afterwards" is a correction that a human should handle, and treating
 * it as a bare yes would confirm an estimate the user was in the middle of
 * amending.
 */
export function readConfirmation(text: string | null, replyToMessageId?: number): ConfirmIntent {
  if (!text) return { kind: 'none' };
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  if (normalized.length <= 12) {
    // Only SHORT text can be a bare yes or no. "ok so I also had a coffee" is
    // an amendment, and reading it as a confirmation would save an estimate
    // the user was in the middle of changing. Longer text falls through to the
    // correction branch rather than being dropped.
    if (CONFIRM_WORDS.has(normalized)) {
      return replyToMessageId === undefined
        ? { kind: 'confirm' }
        : { kind: 'confirm', replyToMessageId };
    }
    if (REJECT_WORDS.has(normalized)) {
      return replyToMessageId === undefined
        ? { kind: 'reject' }
        : { kind: 'reject', replyToMessageId };
    }
  }

  // Anything else that answers a bot message, or is long enough to carry
  // meaning, is treated as a correction to attempt. Whether it can be bound to
  // a meal is a separate question, answered by resolveCorrectionTarget.
  if (replyToMessageId !== undefined) {
    return { kind: 'correct', text: text.trim(), replyToMessageId };
  }
  if (normalized.length >= 3) return { kind: 'correct', text: text.trim() };

  return { kind: 'none' };
}

export interface CorrectableMeal {
  meal_id: number;
  source_id: number;
  prompt_message_id: number | null;
  bot_message_ids: number[];
  description: string | null;
  depth: number;
}

/**
 * The meal a Telegram reply points at: the bot's estimate first, then the
 * user's photo. One matcher for corrections, confirmations and removals, so
 * the three cannot disagree about which meal a reply means.
 */
export function mealRepliedTo<
  T extends { prompt_message_id: number | null; source_id: number; bot_message_ids: number[] },
>(meals: T[], replyToMessageId: number): T | undefined {
  return (
    meals.find((m) => m.prompt_message_id === replyToMessageId) ??
    meals.find((m) => m.bot_message_ids.includes(replyToMessageId)) ??
    meals.find((m) => m.source_id === replyToMessageId)
  );
}

/**
 * Which meal a correction refers to.
 *
 * Same conservative rule as confirmation: an explicit reply is exact,
 * otherwise a bare correction binds only when exactly one meal is
 * correctable. Rewriting the wrong dinner is silent, and the diff reply would
 * look perfectly plausible.
 */
export function resolveCorrectionTarget(
  correctable: CorrectableMeal[],
  replyToMessageId?: number,
): { target?: CorrectableMeal; ambiguous: boolean } {
  if (correctable.length === 0) return { ambiguous: false };

  if (replyToMessageId !== undefined) {
    const match = mealRepliedTo(correctable, replyToMessageId);
    if (match) return { target: match, ambiguous: false };
  }

  if (correctable.length === 1) return { target: correctable[0]!, ambiguous: false };
  return { ambiguous: true };
}

/**
 * Every nutrient that moved, not just the ones the correction mentioned.
 *
 * A correction returns a whole object, so "closer to 800 kcal" is licence to
 * re-estimate sodium too. Reporting only what was asked about would let an
 * unrelated tripling pass unseen.
 */
export function describeChanges(
  before: Record<string, number>,
  after: Record<string, number>,
): string[] {
  const labels: Record<string, [string, string]> = {
    dietary_energy_consumed: ['kcal', ''],
    dietary_protein: ['protein', ' g'],
    dietary_carbohydrates: ['carbs', ' g'],
    dietary_fat_total: ['fat', ' g'],
    dietary_fat_saturated: ['sat fat', ' g'],
    dietary_sugar: ['sugar', ' g'],
    dietary_fiber: ['fibre', ' g'],
    dietary_sodium: ['sodium', ' mg'],
    dietary_potassium: ['potassium', ' mg'],
    dietary_cholesterol: ['cholesterol', ' mg'],
  };

  const changes: string[] = [];
  for (const [nutrient, [label, unit]] of Object.entries(labels)) {
    const from = before[nutrient];
    const to = after[nutrient];
    if (from === undefined && to === undefined) continue;
    const fromValue = from ?? 0;
    const toValue = to ?? 0;
    const delta = Math.abs(toValue - fromValue);
    const scale = Math.max(Math.abs(fromValue), 1);
    if (delta / scale < REPORTABLE_CHANGE) continue;
    changes.push(`${label} ${Math.round(fromValue)}${unit} → ${Math.round(toValue)}${unit}`);
  }
  return changes;
}

export interface CorrectionResult {
  status: 'corrected' | 'mismatch' | 'ambiguous' | 'refused' | 'capped' | 'failed' | 'no_target';
  meal_id?: number;
  model_call_id?: number;
  reply: string;
  /**
   * Log-only. Comes from the extractor's error, whose throw sites keep model
   * text out (see `jsonObjectIn`); keep it so when adding one.
   */
  detail?: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * How a reply names a meal: `"Chicken bowl" (Mon 5 Jan, 12:30)`.
 *
 * Every reply about a stored meal says which one, from the STORED description
 * and time, not the model's new wording. A correction sent in reply to the
 * wrong photo was otherwise invisible: the user saw "couldn't apply that"
 * with no hint that the bot had been looking at a different meal.
 */
export function mealLabel(
  description: string | null,
  meal: { local_day: string; local_time: string },
): string {
  const text = (description ?? 'meal').trim() || 'meal';
  const short = text.length > 50 ? `${text.slice(0, 49).trimEnd()}…` : text;
  const [year, month, day] = meal.local_day.split('-').map(Number) as [number, number, number];
  // local_day is already the meal's calendar date in its own zone. Read it as
  // a UTC date so the server's zone cannot shift the weekday.
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `"${short}" (${weekday} ${day} ${MONTHS[month - 1]}, ${meal.local_time.slice(0, 5)})`;
}

/**
 * Apply a free-text correction to a stored meal.
 *
 * Every branch replies. A correction that silently fails to bind is worse
 * than one that never ran: the user believes the number was fixed.
 */
export async function applyCorrection(
  db: Db,
  correction: {
    text: string;
    replyToMessageId?: number;
    isForwarded: boolean;
    /**
     * The telegram_updates row being handled. Required: it is marked in the
     * same write as the amendment, and it is half of the key that stops one
     * message amending a meal twice — a NULL there collides with nothing.
     */
    updateId: number;
    /** The bot the message came through; scopes reply lookups. */
    botId?: number;
  },
  mediaRoot: string,
  options: { runner?: QueryRunner; model?: string } = {},
): Promise<CorrectionResult> {
  const repo = new MealsRepo(db);

  // Same rule as the photo path: a forward is someone else's words under the
  // owner's envelope, and a correction's entire job is to rewrite numbers.
  if (correction.isForwarded) {
    return { status: 'refused', reply: "That looks forwarded, so I haven't changed anything." };
  }

  const correctable = repo.correctableMeals(CORRECTION_WINDOW_HOURS, 10, correction.botId);

  // A reply names its meal or nothing. It never falls back to "the only recent
  // meal": that rewrote a different meal than the message replied to — a
  // removed one, an old one, or a bot message that was never about a meal.
  const replyTo = correction.replyToMessageId;
  if (replyTo !== undefined && !mealRepliedTo(correctable, replyTo)) {
    const known = repo.findByTelegramMessage(replyTo, correction.botId);
    return {
      status: 'refused',
      ...(known ? { meal_id: known.meal_id } : {}),
      reply: !known
        ? "That message isn't one of your meals, so nothing changed. Reply to the meal's " +
          '"Saved:" message with the change.'
        : known.status === 'voided'
          ? "That meal was removed, so there's nothing to correct."
          : `That meal is older than ${CORRECTION_WINDOW_HOURS}h, so I can't change it from here.`,
    };
  }

  const { target, ambiguous } = resolveCorrectionTarget(correctable, replyTo);

  if (ambiguous) {
    // Say that nothing changed and exactly how to retry. Listing the meals by
    // name invited an answer by name — which nothing reads, so the answer was
    // taken as a new correction and got this same question back.
    return {
      status: 'ambiguous',
      reply:
        `I haven't changed anything: there are ${correctable.length} meals from the last ` +
        `${CORRECTION_WINDOW_HOURS}h and I can't tell which one you mean. Swipe to reply to ` +
        `that meal's "Saved:" message and send the correction again.`,
    };
  }
  if (!target) {
    return {
      status: 'no_target',
      reply: `I don't have a meal from the last ${CORRECTION_WINDOW_HOURS}h to correct. Noted as a message.`,
    };
  }

  const meal = repo.get(target.meal_id);
  const previous = repo.currentEstimate(target.meal_id);
  if (!meal || !previous) return { status: 'failed', reply: "I couldn't find that meal any more." };
  const label = mealLabel(target.description, meal);

  const calls = new ModelCallsRepo(db);
  // Checked before paying for a model call, not left to the unique key to
  // catch afterwards.
  if (calls.hasAccepted(correction.updateId, target.meal_id)) {
    return {
      status: 'refused',
      meal_id: target.meal_id,
      reply: `That change is already applied to ${label}.`,
    };
  }
  if (calls.countForUpdate(correction.updateId) >= MAX_ATTEMPTS_PER_MESSAGE) {
    new TelegramUpdatesRepo(db).markHandled(correction.updateId);
    return {
      status: 'failed',
      meal_id: target.meal_id,
      reply: `I tried that change ${MAX_ATTEMPTS_PER_MESSAGE} times and couldn't save it, so I've stopped. ${label} is unchanged.`,
      detail: `gave up after ${MAX_ATTEMPTS_PER_MESSAGE} attempts`,
    };
  }

  if (target.depth >= MAX_CORRECTION_DEPTH) {
    return {
      status: 'refused',
      meal_id: target.meal_id,
      reply:
        `${label} has already been corrected ${target.depth} times — the photo may not be ` +
        `readable. Send a new one and I'll start fresh.`,
    };
  }

  const budget = estimateBudget(db);
  if (budget.remaining <= 0) {
    return {
      status: 'capped',
      meal_id: target.meal_id,
      reply: `I've hit the limit of ${ESTIMATE_CAP} analyses in ${ESTIMATE_CAP_WINDOW_HOURS} hours, so I haven't changed ${label}.`,
    };
  }

  const photo = db
    .prepare<[number], { media_path: string | null }>(
      `SELECT t.media_path FROM meal_media mm
         JOIN telegram_updates t ON t.id = mm.source_id
        WHERE mm.meal_id = ? AND mm.source_kind = 'telegram' AND t.media_path IS NOT NULL
        LIMIT 1`,
    )
    .get(target.meal_id);

  // Chosen once, so the call's row records the model that actually ran.
  const model = options.model ?? DEFAULT_MODEL;
  const call = {
    id: calls.start({
      purpose: 'correct',
      telegram_update_id: correction.updateId,
      meal_id: target.meal_id,
      model,
      prompt_version: CORRECTION_PROMPT_VERSION,
    }),
    updateId: correction.updateId,
  };
  const before = repo.projectedTotals(target.meal_id);
  const result = await correctMeal(
    {
      photoPath: photo?.media_path ? `${mediaRoot}/${photo.media_path}` : '',
      caption: correction.text,
      localTime: meal.local_time,
      localDay: meal.local_day,
      timezone: meal.tz,
      previous,
    },
    { ...options, model },
  );

  if (result.kind === 'mismatch') {
    // The model says the correction is about a different meal. Nothing is
    // written: storing an unchanged extraction would spend one of the meal's
    // corrections and report "nothing changed" as if it had been applied.
    const reason = result.reason ? ` (${result.reason.replace(/\.$/, '')})` : '';
    return settleCall(db, call, () => ({
      record: finishRecord('mismatch', result),
      result: {
        status: 'mismatch',
        meal_id: target.meal_id,
        model_call_id: call.id,
        reply:
          `That doesn't seem to be about ${label}${reason}, so nothing changed. If you meant ` +
          `another meal, swipe to reply to its "Saved:" message and send it again.`,
      },
    }));
  }
  if (result.kind === 'failed') {
    // Plain words: the parser's reason ("model response has no totals") means
    // nothing to the person reading this in a chat.
    return settleCall(db, call, () => ({
      record: finishRecord('failed', result, { error: result.error }),
      result: {
        status: 'failed',
        meal_id: target.meal_id,
        model_call_id: call.id,
        reply: `I couldn't apply that to ${label}, so nothing changed. Try rephrasing it.`,
        detail: result.error,
      },
    }));
  }

  try {
    // The amendment, the call's outcome and the handled mark commit together.
    // Marking afterwards left a window — a failed log write was enough — in
    // which a restart applied the same correction again on top of itself.
    settleCall(db, call, () => {
      const extractionId = repo.addExtraction(
        target.meal_id,
        storedEstimate(
          result,
          result.meal,
          result.meal.description || target.description || 'meal',
        ),
      );
      return {
        record: finishRecord('ok', result, {
          meal_id: target.meal_id,
          extraction_id: extractionId,
        }),
        result: undefined,
      };
    });
  } catch (err) {
    // Nothing was stored, so the original stands untouched. Each cause says
    // what it was: "numbers I don't believe" for every failure blamed the
    // model for a duplicate or a database fault.
    const [reply, detail] =
      err instanceof MealValidationError
        ? [
            `That correction gave numbers I don't believe for ${label}, so I've left it as it was${violationClause(err)}.`,
            'amendment failed plausibility bounds',
          ]
        : isUniqueConflict(err)
          ? [`That change is already applied to ${label}.`, 'amendment already stored']
          : [
              `I couldn't save that change to ${label}, so nothing changed.`,
              `amendment not stored: ${(err as Error).name}`,
            ];
    return settleCall(db, call, () => ({
      record: finishRecord('failed', result, { error: detail }),
      result: { status: 'failed', meal_id: target.meal_id, model_call_id: call.id, reply, detail },
    }));
  }

  // Read back what was actually written rather than what was computed: the
  // reply is the user's only window onto the data, and "900 → 780" must be
  // true of the database, not of an intention.
  const after = repo.projectedTotals(target.meal_id);
  const changes = describeChanges(before, after);
  const depthNote = target.depth >= 1 ? ` (correction ${target.depth + 1} of this meal)` : '';

  return {
    status: 'corrected',
    meal_id: target.meal_id,
    model_call_id: call.id,
    reply:
      changes.length > 0
        ? `Updated ${label}:\n${changes.join('\n')}${depthNote}`
        : `Noted for ${label} — nothing changed materially.${depthNote}`,
  };
}

export interface RemovalResult {
  status: 'removed' | 'needs_reply' | 'already_removed' | 'too_old' | 'not_counted' | 'not_a_meal';
  meal_id?: number;
  reply: string;
}

/**
 * "no": remove a saved meal from the totals, keeping its record.
 *
 * Reads saved meals. It used to share the "waiting for confirmation" list,
 * which has been empty since meals started saving on arrival, so the undo
 * every estimate advertises answered "nothing waiting" and the meal kept
 * counting.
 *
 * Only as a reply to the meal. Stricter than a correction about guessing
 * which meal, because it removes something and chat cannot undo that: a bare
 * "no" is as likely to mean "you're wrong" to the last bot message as "delete
 * the meal", and a reply to anything that is not a meal never falls back to
 * "the only recent one".
 */
export function rejectMeal(
  db: Db,
  replyToMessageId: number | undefined,
  botId?: number,
): RemovalResult {
  if (replyToMessageId === undefined) {
    return {
      status: 'needs_reply',
      reply: 'Nothing was removed. To remove a meal, swipe to reply "no" to its "Saved:" message.',
    };
  }

  const repo = new MealsRepo(db);
  const target = mealRepliedTo(
    repo.correctableMeals(CORRECTION_WINDOW_HOURS, 10, botId),
    replyToMessageId,
  );
  if (!target) {
    const known = repo.findByTelegramMessage(replyToMessageId, botId);
    const cutoff = Math.floor(Date.now() / 1000) - CORRECTION_WINDOW_HOURS * 3600;
    if (known?.status === 'voided') {
      return {
        status: 'already_removed',
        meal_id: known.meal_id,
        reply: 'That meal was already removed.',
      };
    }
    if (known && known.eaten_epoch < cutoff) {
      return {
        status: 'too_old',
        meal_id: known.meal_id,
        reply: `That meal is older than ${CORRECTION_WINDOW_HOURS}h, so I can't remove it from here. Nothing was removed.`,
      };
    }
    if (known) {
      return {
        status: 'not_counted',
        meal_id: known.meal_id,
        reply: "That meal isn't counted towards anything, so there's nothing to remove.",
      };
    }
    return {
      status: 'not_a_meal',
      reply:
        'That message isn\'t one of your meals, so nothing was removed. Reply "no" to the ' +
        'meal\'s "Saved:" message.',
    };
  }

  const meal = repo.get(target.meal_id);
  repo.void(target.meal_id, 'rejected in chat');
  const label = meal ? mealLabel(target.description, meal) : `"${target.description ?? 'meal'}"`;
  return {
    status: 'removed',
    meal_id: target.meal_id,
    reply: `Removed ${label}. It no longer counts towards anything; the record is kept.`,
  };
}

export interface PendingMeal {
  meal_id: number;
  /** message_id of the user's photo. */
  source_id: number;
  /** message_id of the bot's "reply ok to save this" message. */
  prompt_message_id: number | null;
  /** Other bot messages presenting the meal (none for a meal still pending). */
  bot_message_ids: number[];
  description: string | null;
}

/**
 * Which meal a confirmation refers to.
 *
 * With an explicit reply, the answer is exact. Without one, a bare "ok" is
 * only safe when exactly one meal is waiting: with two pending, confirming
 * the wrong dinner is worse than asking which.
 */
export function resolvePendingTarget(
  pending: PendingMeal[],
  replyToMessageId?: number,
): { target?: PendingMeal; ambiguous: boolean } {
  if (pending.length === 0) return { ambiguous: false };

  if (replyToMessageId !== undefined) {
    const match = mealRepliedTo(pending, replyToMessageId);
    if (match) return { target: match, ambiguous: false };
  }

  if (pending.length === 1) return { target: pending[0]!, ambiguous: false };
  return { ambiguous: true };
}

/**
 * Estimates in the rolling window, and whether there is room for another.
 * Counted from `model_calls` by when each call started, unfinished calls
 * included: a call in flight is spending.
 */
export function estimateBudget(db: Db): { used: number; remaining: number } {
  const used = new ModelCallsRepo(db).countSince(ESTIMATE_PURPOSES, ESTIMATE_CAP_WINDOW_HOURS);
  return { used, remaining: Math.max(0, ESTIMATE_CAP - used) };
}

/**
 * The calendar day and wall-clock time an instant falls on IN A GIVEN ZONE.
 *
 * Not `toISOString().slice(0, 10)`: that is UTC, so a 00:30 Vienna meal would
 * land on the previous day and a 23:30 one could jump forward — the exact
 * boundary error migration 13 was written to fix, reintroduced at the point
 * where meals are created.
 */
export function localDayAndTime(epoch: number, timeZone: string): [string, string] {
  const date = new Date(epoch * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  // Intl renders midnight as 24 in some locales/versions.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return [day, `${hour}:${get('minute')}:${get('second')}`];
}

export interface ProcessPhotoResult {
  status: 'extracted' | 'refused' | 'capped' | 'not_food' | 'failed';
  meal_id?: number;
  model_call_id?: number;
  reply: string;
  /**
   * Log-only. Comes from the extractor's error, whose throw sites keep model
   * text out (see `jsonObjectIn`); keep it so when adding one.
   */
  detail?: string;
}

/**
 * One stored photo → one pending meal, or a reason why not.
 *
 * Every branch returns a `reply`: a photo that is silently not processed is
 * the same silent-wrongness failure as a wrong number, because the user
 * believes it was logged.
 */
export async function processPhoto(
  db: Db,
  row: TelegramUpdateRow,
  mediaRoot: string,
  options: { runner?: QueryRunner; model?: string } = {},
): Promise<ProcessPhotoResult> {
  const repo = new MealsRepo(db);

  // A forwarded message carries someone else's words under the owner's
  // envelope. The flag exists for exactly this moment.
  if (row.is_forwarded) {
    return {
      status: 'refused',
      reply: "That looks forwarded, so I haven't logged it — send your own photo and I will.",
    };
  }

  if (!row.media_path) {
    return { status: 'failed', reply: "I couldn't find the photo file for that message." };
  }

  const [localDay, localTime] = localDayAndTime(row.sent_epoch, row.tz_assumed);
  const calls = new ModelCallsRepo(db);
  if (calls.countForUpdate(row.id) >= MAX_ATTEMPTS_PER_MESSAGE) {
    new TelegramUpdatesRepo(db).markHandled(row.id);
    return {
      status: 'failed',
      reply: `I tried that photo ${MAX_ATTEMPTS_PER_MESSAGE} times and couldn't save it, so I've stopped. Send it again if you like.`,
      detail: `gave up after ${MAX_ATTEMPTS_PER_MESSAGE} attempts`,
    };
  }
  const budget = estimateBudget(db);
  if (budget.remaining <= 0) {
    return {
      status: 'capped',
      reply:
        `I've hit the limit of ${ESTIMATE_CAP} analyses in ${ESTIMATE_CAP_WINDOW_HOURS} hours, ` +
        `so this photo is stored but not analysed. Send it again later and I'll run it.`,
    };
  }

  // Chosen once, so the call's row records the model that actually ran.
  const model = options.model ?? DEFAULT_MODEL;
  const call = {
    id: calls.start({
      purpose: 'extract_photo',
      telegram_update_id: row.id,
      model,
      prompt_version: PROMPT_VERSION,
    }),
    updateId: row.id,
  };
  const extraction: ExtractionResult = await extractMeal(
    {
      photoPath: `${mediaRoot}/${row.media_path}`,
      caption: row.text,
      localTime,
      localDay,
      timezone: row.tz_assumed,
    },
    { ...options, model },
  );

  if (!extraction.ok || !extraction.meal) {
    return settleCall(db, call, () => ({
      record: finishRecord('failed', extraction, { error: extraction.error ?? null }),
      result: {
        status: 'failed',
        model_call_id: call.id,
        reply:
          "I couldn't get an estimate out of that photo, so nothing was saved. Try sending it again.",
        ...(extraction.error ? { detail: extraction.error } : {}),
      },
    }));
  }
  if (extraction.meal.not_food) {
    return settleCall(db, call, () => ({
      record: finishRecord('not_food', extraction),
      result: {
        status: 'not_food',
        model_call_id: call.id,
        reply: "That doesn't look like food, so I haven't logged it.",
      },
    }));
  }

  // One write, after the model has answered: the meal, its link to this
  // message, the estimate, the confirmation, the call's outcome and the
  // handled mark commit together or not at all. As separate commits, a fault
  // after createMeal left the message unmarked, and the retry created a
  // second meal from the same photo that was counted twice.
  const meal = extraction.meal;
  try {
    return settleCall<ProcessPhotoResult>(db, call, () => {
      const mealId = repo.createMeal({
        eaten_epoch: row.sent_epoch,
        local_day: localDay,
        local_time: localTime,
        tz: row.tz_assumed,
        // Telegram strips EXIF from compressed photos, so for this path the
        // zone is the server's assumption, recorded as such.
        tz_source: 'configured',
      });
      repo.linkMedia(mealId, 'telegram', row.id);
      try {
        const extractionId = repo.addExtraction(
          mealId,
          storedEstimate(extraction, meal, meal.description),
        );
        if (AUTO_CONFIRM) repo.confirm(mealId, 'telegram-auto');
        return {
          record: finishRecord('ok', extraction, { meal_id: mealId, extraction_id: extractionId }),
          result: {
            status: 'extracted',
            meal_id: mealId,
            model_call_id: call.id,
            reply: formatEstimate(meal),
          },
        };
      } catch (err) {
        if (!(err instanceof MealValidationError)) throw err;
        // The numbers failed plausibility. The meal row stays (the photo is
        // real and pending is visible), but nothing is projected and the user
        // is told rather than left with a silently missing meal.
        return {
          record: finishRecord('failed', extraction, {
            meal_id: mealId,
            error: 'estimate failed plausibility bounds',
          }),
          result: {
            status: 'failed',
            meal_id: mealId,
            model_call_id: call.id,
            reply: `I read that meal but the numbers didn't look right, so I haven't saved an estimate${violationClause(err)}.`,
            detail: 'estimate failed plausibility bounds',
          },
        };
      }
    });
  } catch (err) {
    // The save was rolled back, so nothing was stored. Recorded and marked
    // rather than left for a retry: a fault that repeats would otherwise pay
    // for a fresh model call every cycle until the day's cap was gone.
    const detail = `estimate not stored: ${(err as Error).name}`;
    return settleCall(db, call, () => ({
      record: finishRecord('failed', extraction, { error: detail }),
      result: {
        status: 'failed',
        model_call_id: call.id,
        reply: "I couldn't save that estimate, so nothing was logged. Try sending the photo again.",
        detail,
      },
    }));
  }
}

/** The message the user actually reads. Numbers first, confidence stated plainly. */
export function formatEstimate(meal: {
  description: string;
  totals: Record<string, number>;
  confidence: number | null;
  notes?: string | null;
}): string {
  const kcal = meal.totals['dietary_energy_consumed'];
  const protein = meal.totals['dietary_protein'];
  const carbs = meal.totals['dietary_carbohydrates'];
  const fat = meal.totals['dietary_fat_total'];

  const headline = meal.description || 'Meal';
  const macros = [
    kcal !== undefined ? `${Math.round(kcal)} kcal` : null,
    protein !== undefined ? `${Math.round(protein)} g protein` : null,
    carbs !== undefined ? `${Math.round(carbs)} g carbs` : null,
    fat !== undefined ? `${Math.round(fat)} g fat` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const confidence =
    meal.confidence === null
      ? ''
      : `\nConfidence ${Math.round(meal.confidence * 100)}%${
          meal.confidence < 0.5 ? ' — low, worth a correction if that looks off' : ''
        }`;
  const notes = meal.notes ? `\n${meal.notes}` : '';

  // Saved already: the message reports what happened rather than asking
  // permission. Only a correction needs the user to do anything.
  return `Saved: ${headline}\n${macros}${confidence}${notes}\n\nReply "no" to remove it, or tell me what to change.`;
}
