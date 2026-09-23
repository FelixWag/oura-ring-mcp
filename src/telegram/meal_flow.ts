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
import { MealsRepo, MealValidationError } from '../db/repos/meals.js';
import type { TelegramUpdateRow } from '../db/repos/telegram_updates.js';
import { extractMeal, correctMeal, type ExtractionResult, type QueryRunner } from './extractor.js';

/** Extractions per day. Every one spends money; a flood should not. */
export const DAILY_EXTRACTION_CAP = 40;
const CAP_KEY = 'telegram_extractions';

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
  description: string | null;
  totals: string;
  depth: number;
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
    const match =
      correctable.find((m) => m.prompt_message_id === replyToMessageId) ??
      correctable.find((m) => m.source_id === replyToMessageId);
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
  status: 'corrected' | 'ambiguous' | 'refused' | 'capped' | 'failed' | 'no_target';
  meal_id?: number;
  reply: string;
}

/**
 * Apply a free-text correction to a stored meal.
 *
 * Every branch replies. A correction that silently fails to bind is worse
 * than one that never ran: the user believes the number was fixed.
 */
export async function applyCorrection(
  db: Db,
  correction: { text: string; replyToMessageId?: number; isForwarded: boolean },
  mediaRoot: string,
  options: { runner?: QueryRunner; model?: string } = {},
): Promise<CorrectionResult> {
  const repo = new MealsRepo(db);

  // Same rule as the photo path: a forward is someone else's words under the
  // owner's envelope, and a correction's entire job is to rewrite numbers.
  if (correction.isForwarded) {
    return { status: 'refused', reply: "That looks forwarded, so I haven't changed anything." };
  }

  const correctable = repo.correctableMeals(CORRECTION_WINDOW_HOURS);
  const { target, ambiguous } = resolveCorrectionTarget(correctable, correction.replyToMessageId);

  if (ambiguous) {
    const names = correctable
      .slice(0, 4)
      .map((m) => m.description ?? 'a meal')
      .join('; ');
    return {
      status: 'ambiguous',
      reply: `Which meal do you mean? Reply to one of: ${names}`,
    };
  }
  if (!target) {
    return {
      status: 'no_target',
      reply: `I don't have a meal from the last ${CORRECTION_WINDOW_HOURS}h to correct. Noted as a message.`,
    };
  }

  if (target.depth >= MAX_CORRECTION_DEPTH) {
    return {
      status: 'refused',
      meal_id: target.meal_id,
      reply:
        `That meal has already been corrected ${target.depth} times — the photo may not be ` +
        `readable. Send a new one and I'll start fresh.`,
    };
  }

  const meal = repo.get(target.meal_id);
  if (!meal) return { status: 'failed', reply: "I couldn't find that meal any more." };

  const budget = extractionBudget(db, meal.local_day);
  if (budget.remaining <= 0) {
    return {
      status: 'capped',
      meal_id: target.meal_id,
      reply: `I've hit today's analysis limit, so I haven't applied that correction.`,
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

  const before = repo.projectedTotals(target.meal_id);
  const result: ExtractionResult = await correctMeal(
    {
      photoPath: photo?.media_path ? `${mediaRoot}/${photo.media_path}` : '',
      caption: correction.text,
      localTime: meal.local_time,
      localDay: meal.local_day,
      timezone: meal.tz,
      previous: JSON.parse(target.totals) as Record<string, unknown>,
    },
    options,
  );
  recordExtraction(db, meal.local_day);

  if (!result.ok || !result.meal) {
    return {
      status: 'failed',
      meal_id: target.meal_id,
      reply: `I couldn't apply that: ${result.error}. The meal is unchanged.`,
    };
  }

  try {
    repo.addExtraction(target.meal_id, {
      model: result.model,
      prompt_version: result.prompt_version,
      confidence: result.meal.confidence,
      description: result.meal.description || target.description || 'meal',
      totals: result.meal.totals,
      raw_response: result.raw_response ?? null,
      items: result.meal.items.map((item) => ({
        name: item.name,
        portion_text: item.portion_text ?? null,
        grams: item.grams ?? null,
        confidence: item.confidence ?? null,
      })),
    });
  } catch (err) {
    // Bounds rejected the amendment, so the original stands untouched.
    return {
      status: 'failed',
      meal_id: target.meal_id,
      reply: `That correction gave numbers I don't believe, so I've left the meal as it was. ${
        (err as Error).message
      }`,
    };
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
    reply:
      changes.length > 0
        ? `Updated: ${result.meal.description || target.description}\n${changes.join('\n')}${depthNote}`
        : `Noted — nothing changed materially.${depthNote}`,
  };
}

export interface PendingMeal {
  meal_id: number;
  /** message_id of the user's photo. */
  source_id: number;
  /** message_id of the bot's "reply ok to save this" message. */
  prompt_message_id: number | null;
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
    // The bot's own question first: that is what a user actually replies to.
    // Matching only the photo's id was the original bug — every reply fell
    // through to "which meal do you mean?".
    const match =
      pending.find((p) => p.prompt_message_id === replyToMessageId) ??
      pending.find((p) => p.source_id === replyToMessageId);
    if (match) return { target: match, ambiguous: false };
  }

  if (pending.length === 1) return { target: pending[0]!, ambiguous: false };
  return { ambiguous: true };
}

/** How many extractions have run today, and whether there is room for another. */
export function extractionBudget(db: Db, day: string): { used: number; remaining: number } {
  const row = db
    .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
    .get(`${CAP_KEY}:${day}`);
  const used = Number(row?.value ?? 0);
  return { used, remaining: Math.max(0, DAILY_EXTRACTION_CAP - used) };
}

export function recordExtraction(db: Db, day: string): void {
  const key = `${CAP_KEY}:${day}`;
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
  ).run(key);
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
  reply: string;
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
  const budget = extractionBudget(db, localDay);
  if (budget.remaining <= 0) {
    return {
      status: 'capped',
      reply:
        `I've hit today's limit of ${DAILY_EXTRACTION_CAP} photo analyses, so this one is ` +
        `stored but not analysed. Tell me and I'll run it tomorrow.`,
    };
  }

  const extraction: ExtractionResult = await extractMeal(
    {
      photoPath: `${mediaRoot}/${row.media_path}`,
      caption: row.text,
      localTime,
      localDay,
      timezone: row.tz_assumed,
    },
    options,
  );
  recordExtraction(db, localDay);

  if (!extraction.ok || !extraction.meal) {
    return { status: 'failed', reply: `I couldn't read that one: ${extraction.error}` };
  }
  if (extraction.meal.not_food) {
    return { status: 'not_food', reply: "That doesn't look like food, so I haven't logged it." };
  }

  const mealId = repo.createMeal({
    eaten_epoch: row.sent_epoch,
    local_day: localDay,
    local_time: localTime,
    tz: row.tz_assumed,
    // Telegram strips EXIF from compressed photos, so for this path the zone
    // is the server's assumption, recorded as such.
    tz_source: 'configured',
  });
  repo.linkMedia(mealId, 'telegram', row.id);

  try {
    repo.addExtraction(mealId, {
      model: extraction.model,
      prompt_version: extraction.prompt_version,
      confidence: extraction.meal.confidence,
      description: extraction.meal.description,
      totals: extraction.meal.totals,
      raw_response: extraction.raw_response ?? null,
      items: extraction.meal.items.map((item) => ({
        name: item.name,
        portion_text: item.portion_text ?? null,
        grams: item.grams ?? null,
        confidence: item.confidence ?? null,
      })),
    });
  } catch (err) {
    if (err instanceof MealValidationError) {
      // The numbers failed plausibility. The meal row stays (the photo is real
      // and pending is visible), but nothing is projected and the user is told
      // rather than left with a silently missing meal.
      return {
        status: 'failed',
        meal_id: mealId,
        reply:
          "I read that meal but the numbers didn't look right, so I haven't saved an " +
          `estimate. ${err.violations[0]?.reason ?? ''}`.trim(),
      };
    }
    throw err;
  }

  if (AUTO_CONFIRM) repo.confirm(mealId, 'telegram-auto');

  return { status: 'extracted', meal_id: mealId, reply: formatEstimate(extraction.meal) };
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
