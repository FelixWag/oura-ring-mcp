/**
 * Telegram inbound server.
 *
 *   npm run telegram-server
 *
 * Long polling, so there is no inbound port and no public endpoint: the
 * process only makes outbound HTTPS calls. Receive-and-store only — nothing
 * here interprets a message.
 *
 * The ordering that matters, and the one most implementations get wrong:
 * insert the batch, COMMIT, and only then advance the offset. Telegram
 * treats the offset as an acknowledgement and discards everything below it
 * permanently, so advancing first loses messages that can never be refetched.
 *
 * Media arrives in a second phase after the commit, because better-sqlite3
 * transactions are synchronous and cannot await a download.
 */

import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadTelegramConfig, type TelegramConfig } from '../config.js';
import { openDatabase, type Db } from '../db/index.js';
import {
  TelegramUpdatesRepo,
  type NewTelegramUpdate,
  type TelegramKind,
} from '../db/repos/telegram_updates.js';
import { TelegramClient, type TelegramMessage, type TelegramUpdate } from './client.js';
import { downloadMedia } from './media.js';
import { MealsRepo } from '../db/repos/meals.js';
import { BotMessagesRepo, type BotMessageKind } from '../db/repos/bot_messages.js';
import type { QueryRunner } from './extractor.js';
import {
  processPhoto,
  readConfirmation,
  resolvePendingTarget,
  applyCorrection,
  formatEstimate,
  mealLabel,
  rejectMeal,
  type CorrectionResult,
  type PendingMeal,
  type ProcessPhotoResult,
} from './meal_flow.js';

export interface ClassifiedMessage {
  kind: TelegramKind;
  text: string | null;
  file_id: string | null;
  file_unique_id: string | null;
  photo_width: number | null;
  photo_height: number | null;
}

/**
 * What kind of message this is, and which file to fetch.
 *
 * `document` is not an afterthought: a photo sent from iOS at full size
 * arrives as a document, not a photo, and people do that deliberately to
 * preserve quality. Dropping it would silently lose exactly the meal photos
 * this system exists to capture.
 */
export function isForwarded(message: TelegramMessage): boolean {
  return (
    message.forward_origin != null ||
    message.forward_from != null ||
    message.forward_sender_name != null ||
    message.via_bot != null
  );
}

/**
 * What a forward keeps: that it arrived, when, in which chat. Everything else
 * — text, caption, media names, story, poll, origin — is someone else's, and
 * nothing reads a forward's content (it is classified 'other' and its media
 * is never downloaded), so an allowlist loses nothing. The names of dropped
 * keys are kept, so an unknown kind stays visible rather than silent.
 */
const KEPT_FORWARD_KEYS = new Set([
  'message_id',
  'date',
  'edit_date',
  'chat',
  'from',
  'media_group_id',
]);

/**
 * Other people carried inside the owner's own messages. A list of known
 * shapes, not a guarantee: the owner's own content has to stay lossless, so an
 * allowlist would lose it whenever Telegram adds a field.
 */
const THIRD_PARTY_KEYS = [
  'quote', // the quoted part of a replied-to message
  'external_reply', // a reply to a message in another chat: names its sender
  'contact', // a contact card: someone's name, phone number, user id
  'story', // a shared story: its poster's chat
  'reply_to_story',
  'pinned_message', // a whole nested message, forwards included
  'users_shared',
  'chat_shared',
  'giveaway',
  'giveaway_winners', // a list of users
  'checklist', // tasks record who completed them
] as const;

/**
 * Strip a nested third party out of an update before it is stored.
 *
 * `reply_to_message` and `quote` embed another person's message wholesale —
 * their user id, their name, their words — inside an update whose envelope is
 * the owner's. "Nothing about a third party is stored" has to survive the
 * nesting, not just the top level — and forwards, contacts, stories and
 * replies to other chats are nestings too.
 */
export function redactNested(update: TelegramUpdate): TelegramUpdate {
  const clean = JSON.parse(JSON.stringify(update)) as TelegramUpdate;
  for (const message of [clean.message, clean.edited_message]) {
    if (!message) continue;
    const fields = message as unknown as Record<string, unknown>;

    if (isForwarded(message)) {
      const origin = message.forward_origin as { type?: unknown } | undefined;
      const originType = typeof origin?.type === 'string' ? origin.type : 'unknown';
      const dropped = Object.keys(fields).filter((key) => !KEPT_FORWARD_KEYS.has(key));
      for (const key of dropped) delete fields[key];
      fields['forwarded'] = { origin_type: originType, dropped_keys: dropped.sort() };
      continue;
    }

    for (const key of THIRD_PARTY_KEYS) delete fields[key];
    // A mention by name (`text_mention`) carries that person's user record;
    // text pasted from a group can bring one along. Keep where it is, drop who.
    for (const key of ['entities', 'caption_entities'] as const) {
      const entities = fields[key];
      if (!Array.isArray(entities)) continue;
      for (const entity of entities as Array<Record<string, unknown>>) delete entity['user'];
    }

    // Keep the id, drop the message. The id is the only thing that binds a
    // reply to a meal, and it carries no one's name or words. Deleting it too
    // made every reply arrive as a bare message: from v0.11 to v0.12.1 no
    // correction or "no" could name its meal, and each asked "which meal?".
    const replyTo = asMessageId(message.reply_to_message?.message_id);
    delete message.reply_to_message;
    if (replyTo !== undefined) {
      message.reply_to_message = { message_id: replyTo } as TelegramMessage;
    }
  }
  return clean;
}

/**
 * A Telegram message id, or undefined. Telegram always sends a positive
 * integer; anything else (a `null` would match a meal whose prompt was never
 * sent, since `prompt_message_id` is NULL there) is treated as no target.
 */
function asMessageId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * The message a stored text replied to, if any — read from the redacted `raw`
 * that `redactNested` produced. One reader, shared with the tests, so the id
 * the matcher sees is the id that storage actually kept. Edits too: an edited
 * reply without its target would fall back to "the only recent meal", which
 * can be a different one.
 */
export function replyTargetOf(raw: string): number | undefined {
  type Stored = { reply_to_message?: { message_id?: unknown } };
  const parsed = JSON.parse(raw) as { message?: Stored; edited_message?: Stored };
  return asMessageId((parsed.message ?? parsed.edited_message)?.reply_to_message?.message_id);
}

export function classifyMessage(message: TelegramMessage): ClassifiedMessage {
  // A forward carries the owner's envelope and a stranger's words. Today that
  // would put a third party's text in an indexed column; once a caption
  // becomes a prompt, it is attacker-chosen text on the trusted path. So the
  // message is recorded as having arrived, and its text is not adopted.
  if (isForwarded(message)) {
    return {
      kind: 'other',
      text: null,
      file_id: null,
      file_unique_id: null,
      photo_width: null,
      photo_height: null,
    };
  }

  const text = message.text ?? message.caption ?? null;

  if (message.photo && message.photo.length > 0) {
    // Telegram sends several sizes; take the largest. Recording which one we
    // took is what later answers "was this estimate made from a thumbnail?".
    const largest = [...message.photo].sort((a, b) => a.width * a.height - b.width * b.height)[
      message.photo.length - 1
    ]!;
    return {
      kind: 'photo',
      text,
      file_id: largest.file_id,
      file_unique_id: largest.file_unique_id,
      photo_width: largest.width,
      photo_height: largest.height,
    };
  }

  if (message.voice) {
    return {
      kind: 'voice',
      text,
      file_id: message.voice.file_id,
      file_unique_id: message.voice.file_unique_id,
      photo_width: null,
      photo_height: null,
    };
  }

  if (message.document) {
    return {
      kind: 'document',
      text,
      file_id: message.document.file_id,
      file_unique_id: message.document.file_unique_id,
      photo_width: null,
      photo_height: null,
    };
  }

  if (message.text) {
    return {
      kind: 'text',
      text,
      file_id: null,
      file_unique_id: null,
      photo_width: null,
      photo_height: null,
    };
  }

  // Video, sticker, location, whatever Telegram adds next. Stored verbatim
  // rather than dropped, so an unhandled kind is visible instead of silent.
  return {
    kind: 'other',
    text,
    file_id: null,
    file_unique_id: null,
    photo_width: null,
    photo_height: null,
  };
}

/**
 * Is this update from the one chat we accept?
 *
 * Three conditions, not one. A group chat would let every member write to a
 * health database, and `from.id` guards the case where the allowed chat is
 * ever not a private one-to-one chat.
 */
export function isAllowed(update: TelegramUpdate, allowedChatId: number): boolean {
  const message = update.message ?? update.edited_message;
  if (!message) return false;
  if (message.chat.id !== allowedChatId) return false;
  if (message.chat.type !== 'private') return false;
  if (message.from && message.from.id !== allowedChatId) return false;
  return true;
}

export interface ProcessResult {
  accepted: number;
  rejected: number;
  duplicates: number;
}

/**
 * Turn a polled batch into rows. Pure apart from the repo write, so the
 * filtering and classification rules are testable without a network.
 */
export function processBatch(
  updates: TelegramUpdate[],
  repo: TelegramUpdatesRepo,
  config: TelegramConfig,
): ProcessResult {
  const accepted: NewTelegramUpdate[] = [];
  let rejectedHighWater: number | null = null;
  let rejected = 0;

  for (const update of updates) {
    if (!isAllowed(update, config.allowedChatId)) {
      // Never inserted — a stranger's name and chat id do not belong in a
      // health database. But the id must still move the offset, or the next
      // poll refetches this same update forever and one message from anyone
      // pins the queue. The high-water mark carries it instead.
      rejected += 1;
      rejectedHighWater = Math.max(rejectedHighWater ?? 0, update.update_id);
      continue;
    }

    const message = (update.message ?? update.edited_message)!;
    const classified = classifyMessage(message);
    const isEdit = update.edited_message != null;

    accepted.push({
      bot_id: config.botId,
      update_id: update.update_id,
      chat_id: message.chat.id,
      message_id: message.message_id,
      media_group_id: message.media_group_id ?? null,
      kind: classified.kind,
      text: classified.text,
      // Telegram's own instant. An edit reports when it was edited.
      sent_epoch: message.edit_date ?? message.date,
      tz_assumed: config.tz,
      file_id: classified.file_id,
      file_unique_id: classified.file_unique_id,
      photo_width: classified.photo_width,
      photo_height: classified.photo_height,
      needs_media: classified.file_id != null,
      raw: JSON.stringify(redactNested(update)),
      edits_message_id: isEdit ? message.message_id : null,
      is_forwarded: isForwarded(message),
    });
  }

  const { inserted, duplicates } = repo.storeBatch(
    config.botId,
    accepted,
    rejectedHighWater,
    rejected,
  );

  return { accepted: inserted, rejected, duplicates };
}

/**
 * Second phase: fetch what the committed rows still lack. Runs outside any
 * transaction — a model-length or network-length operation must never hold a
 * write lock on a database three other processes share.
 */
export async function drainMedia(
  repo: TelegramUpdatesRepo,
  client: TelegramClient,
  config: TelegramConfig,
  log: (line: string) => Promise<void>,
): Promise<number> {
  const rows = repo.pendingMedia();
  let stored = 0;

  for (const row of rows) {
    if (!row.file_id) continue;
    try {
      // Resolved immediately before use: the path expires after ~1 hour.
      const filePath = await client.getFilePath(row.file_id);
      const media = await downloadMedia(
        client.fileUrl(filePath),
        config.mediaDir,
        row.sent_epoch,
        filePath,
      );
      repo.markStored(row.id, media.relativePath, media.sha256, media.bytes);
      stored += 1;
    } catch (err) {
      const message = (err as Error).message;
      repo.markFailed(row.id, message);
      await log(`media download failed for update ${row.update_id}: ${message}`);
    }
  }

  return stored;
}

/**
 * Meals awaiting confirmation, newest first, with the message that produced
 * each one so an explicit reply can be matched to it.
 */
function pendingMeals(db: Db): PendingMeal[] {
  return (
    db
      .prepare<[], Omit<PendingMeal, 'bot_message_ids'>>(
        `SELECT m.id AS meal_id, t.message_id AS source_id,
              m.prompt_message_id AS prompt_message_id, e.description AS description
         FROM meals m
         JOIN meal_media mm ON mm.meal_id = m.id AND mm.source_kind = 'telegram'
         JOIN telegram_updates t ON t.id = mm.source_id
         LEFT JOIN meal_extractions e ON e.id = m.current_extraction_id
        WHERE m.status = 'unconfirmed'
        ORDER BY m.id DESC`,
      )
      .all()
      // A pending meal has had no estimate presented beyond its first prompt.
      .map((meal) => ({ ...meal, bot_message_ids: [] }))
  );
}

/**
 * "ok": confirm a meal still waiting for it, and say what happened.
 *
 * Meals are saved on arrival, so usually nothing waits; a meal is left
 * unconfirmed only when its estimate failed the plausibility bounds. With two
 * waiting, a bare "ok" asks which rather than confirming the wrong one.
 */
export function confirmPending(db: Db, replyToMessageId: number | undefined): string {
  const pending = pendingMeals(db);
  if (pending.length === 0) return 'Already saved — meals count as soon as they arrive.';

  const { target, ambiguous } = resolvePendingTarget(pending, replyToMessageId);
  if (ambiguous || !target) {
    const names = pending.map((p) => p.description ?? 'a meal').join(', ');
    return `I have ${pending.length} meals waiting (${names}). Reply to the one you mean.`;
  }

  const repo = new MealsRepo(db);
  repo.confirm(target.meal_id, 'telegram');
  const meal = repo.get(target.meal_id);
  return `Saved ${meal ? mealLabel(target.description, meal) : `"${target.description ?? 'meal'}"`}.`;
}

/** A log line, with the log-only technical reason when there is one. */
function withDetail(line: string, detail: string | undefined): string {
  return detail ? `${line} (${detail})` : line;
}

/**
 * Is this row an edit of a message the bot already acted on?
 *
 * An edit arrives as a new row for the same message, and the drain loops pick
 * up any row not yet handled. Re-running it was wrong both ways: an edited
 * correction was applied on top of its own result, and an edited photo caption
 * created a second meal from the same photo that counted twice. So the edit is
 * recorded, not re-run, and the reply says so.
 */
export function isEditOfHandledMessage(
  db: Db,
  row: { id: number; bot_id: number; chat_id: number; message_id: number },
): boolean {
  // bot_id: message ids are numbered per bot and restart at 1 for a new bot,
  // so without it a new bot's messages would collide with the old bot's.
  return (
    db
      .prepare(
        `SELECT 1 FROM telegram_updates
          WHERE bot_id = ? AND chat_id = ? AND message_id = ? AND id <> ?
            AND extracted_at IS NOT NULL
          LIMIT 1`,
      )
      .get(row.bot_id, row.chat_id, row.message_id, row.id) !== undefined
  );
}

// General on purpose: the original may have been a failed photo or a question,
// so there is not always a "Saved:" message to point at.
const EDIT_NOT_RERUN =
  "I've already answered that message, so I haven't re-run the edit. Send the " +
  'change as a new message, or reply to the meal\'s "Saved:" message.';

/**
 * Send a reply and record it, so a later reply to THIS message can find its
 * meal. Only the first estimate used to be remembered; a reply to "Updated:"
 * or "Removed" matched nothing.
 */
interface SentMessageMeta {
  kind: BotMessageKind;
  meal_id?: number | undefined;
  answers_update_id?: number | undefined;
  model_call_id?: number | undefined;
}

/**
 * What each outcome's reply is recorded as. Total on purpose: a new status
 * must decide whether its reply presents a meal (and so binds a reply to it)
 * instead of silently becoming 'reply'.
 */
const PHOTO_REPLY_KIND: Record<ProcessPhotoResult['status'], BotMessageKind> = {
  extracted: 'estimate',
  failed: 'failed',
  not_food: 'reply',
  refused: 'reply',
  capped: 'reply',
};
const CORRECTION_REPLY_KIND: Record<CorrectionResult['status'], BotMessageKind> = {
  corrected: 'amended',
  mismatch: 'mismatch',
  failed: 'failed',
  ambiguous: 'ambiguous',
  refused: 'reply',
  capped: 'reply',
  no_target: 'reply',
};

/**
 * A log that cannot stop a reply. A failed log write used to skip the rest of
 * the loop body: the change was saved and marked, and the user never told.
 */
function quietly(log: (line: string) => Promise<void>): (line: string) => Promise<void> {
  return async (line) => {
    try {
      await log(line);
    } catch (err) {
      process.stderr.write(`telegram log write failed: ${(err as Error).name}\n`);
    }
  };
}

async function sendAndRecord(
  db: Db,
  client: TelegramClient,
  config: TelegramConfig,
  text: string,
  meta: SentMessageMeta,
): Promise<number | null> {
  const messageId = await client.sendMessage(config.allowedChatId, text);
  if (messageId !== null) {
    new BotMessagesRepo(db).record({
      bot_id: config.botId,
      chat_id: config.allowedChatId,
      message_id: messageId,
      kind: meta.kind,
      meal_id: meta.meal_id ?? null,
      answers_update_id: meta.answers_update_id ?? null,
      model_call_id: meta.model_call_id ?? null,
      text,
    });
  }
  return messageId;
}

/** A log line naming the model call, when there was one. */
function withCall(line: string, modelCallId: number | undefined): string {
  return modelCallId === undefined ? line : `${line} (call ${modelCallId})`;
}

/** Mark a row handled without acting on it, and tell the user why. */
async function skipEdit(
  db: Db,
  client: TelegramClient,
  config: TelegramConfig,
  log: (line: string) => Promise<void>,
  kind: 'photo' | 'text',
  id: number,
): Promise<void> {
  new TelegramUpdatesRepo(db).markHandled(id);
  await log(`${kind} ${id}: edit of a handled message, not re-run`);
  await sendAndRecord(db, client, config, EDIT_NOT_RERUN, { kind: 'reply', answers_update_id: id });
}

/**
 * Analyse photos whose file has landed. One extraction per message, and the
 * reply always says what happened — a photo silently left unanalysed is
 * believed to have been logged.
 */
async function drainPhotos(
  db: Db,
  repo: TelegramUpdatesRepo,
  client: TelegramClient,
  config: TelegramConfig,
  log: (line: string) => Promise<void>,
): Promise<void> {
  const note = quietly(log);
  const rows = db
    .prepare<[], { id: number; bot_id: number; chat_id: number; message_id: number }>(
      `SELECT t.id, t.bot_id, t.chat_id, t.message_id FROM telegram_updates t
        WHERE t.status = 'stored' AND t.kind IN ('photo', 'document')
          AND t.media_path IS NOT NULL AND t.superseded_by IS NULL
          AND t.extracted_at IS NULL
        ORDER BY t.id LIMIT 5`,
    )
    .all();

  for (const { id, bot_id, chat_id, message_id } of rows) {
    if (isEditOfHandledMessage(db, { id, bot_id, chat_id, message_id })) {
      await skipEdit(db, client, config, note, 'photo', id);
      continue;
    }
    const row = db
      .prepare<
        [number],
        Parameters<typeof processPhoto>[1]
      >('SELECT * FROM telegram_updates WHERE id = ?')
      .get(id);
    if (!row) continue;

    try {
      const result = await processPhoto(db, row, config.mediaDir);
      // Outcomes that ran a model are already marked, in the transaction that
      // saved them. This marks the ones that wrote nothing (refused, capped),
      // so they are not retried every cycle, repeating the reply.
      new TelegramUpdatesRepo(db).markHandled(id);
      await note(
        withDetail(withCall(`photo ${id}: ${result.status}`, result.model_call_id), result.detail),
      );

      const promptId = await sendAndRecord(db, client, config, result.reply, {
        kind: PHOTO_REPLY_KIND[result.status],
        meal_id: result.meal_id,
        answers_update_id: id,
        model_call_id: result.model_call_id,
      });
      // Remember which message asked, so the reply can be matched to this
      // meal. If the send failed, prompt_message_id stays NULL and
      // drainPrompts asks again — a meal nobody was told about is the silent
      // failure this flow exists to prevent.
      if (result.meal_id !== undefined && promptId !== null) {
        new MealsRepo(db).setPromptMessageId(result.meal_id, promptId);
      }
    } catch (err) {
      // A crash is different from a refusal: leave extracted_at unset so a
      // transient fault (a model hiccup, a full disk) gets another chance.
      await note(`photo ${id}: extraction crashed: ${(err as Error).name}`);
    }
  }
}

/**
 * Handle text messages: confirmations, rejections, corrections, notes.
 *
 * Drained rather than handled in the batch loop, because a correction runs a
 * model. A correction marks its message inside the transaction that stores
 * it, so a restart cannot apply the same amendment twice; the mark at the end
 * of this loop covers only outcomes that wrote nothing.
 */
export async function drainText(
  db: Db,
  client: TelegramClient,
  config: TelegramConfig,
  log: (line: string) => Promise<void>,
  /** Tests only: a stand-in model, so the loop can run without calling one. */
  options: { runner?: QueryRunner } = {},
): Promise<void> {
  const note = quietly(log);
  const rows = db
    .prepare<
      [],
      {
        id: number;
        bot_id: number;
        chat_id: number;
        message_id: number;
        text: string | null;
        raw: string;
        is_forwarded: number;
      }
    >(
      `SELECT id, bot_id, chat_id, message_id, text, raw, is_forwarded FROM telegram_updates
        WHERE kind = 'text' AND extracted_at IS NULL AND superseded_by IS NULL
        ORDER BY id LIMIT 5`,
    )
    .all();

  for (const row of rows) {
    if (isEditOfHandledMessage(db, row)) {
      await skipEdit(db, client, config, note, 'text', row.id);
      continue;
    }
    const intent = readConfirmation(row.text, replyTargetOf(row.raw));

    let reply: string;
    let meta: SentMessageMeta = { kind: 'reply', answers_update_id: row.id };
    try {
      if (intent.kind === 'confirm') {
        reply = confirmPending(db, intent.replyToMessageId);
      } else if (intent.kind === 'reject') {
        // Logged, with the meal: a removal cannot be undone from chat, so the
        // log is what links a voided meal to the message that asked for it.
        const result = rejectMeal(db, intent.replyToMessageId, config.botId);
        await note(
          `text ${row.id}: no ${result.status}` +
            (result.meal_id !== undefined ? ` (meal ${result.meal_id})` : ''),
        );
        reply = result.reply;
        meta = {
          ...meta,
          kind: result.status === 'removed' ? 'removed' : 'reply',
          meal_id: result.meal_id,
        };
      } else if (intent.kind === 'correct') {
        const result = await applyCorrection(
          db,
          {
            text: intent.text,
            ...(intent.replyToMessageId !== undefined
              ? { replyToMessageId: intent.replyToMessageId }
              : {}),
            isForwarded: row.is_forwarded === 1,
            updateId: row.id,
            botId: config.botId,
          },
          config.mediaDir,
          options,
        );
        await note(
          withDetail(
            withCall(`text ${row.id}: correction ${result.status}`, result.model_call_id),
            result.detail,
          ),
        );
        reply = result.reply;
        meta = {
          ...meta,
          kind: CORRECTION_REPLY_KIND[result.status],
          meal_id: result.meal_id,
          model_call_id: result.model_call_id,
        };
      } else {
        reply = 'Got it — noted.';
      }
    } catch (err) {
      // Left unmarked so a transient fault gets another attempt; the attempt
      // limit per message stops one that repeats.
      await note(`text ${row.id}: failed: ${(err as Error).name}`);
      continue;
    }

    new TelegramUpdatesRepo(db).markHandled(row.id);
    await sendAndRecord(db, client, config, reply, meta);
  }
}

/**
 * Ask again about meals whose original question never made it.
 *
 * Normally a no-op. It matters on a flaky connection: the estimate is stored
 * but the message telling the user was lost, leaving a meal that counts for
 * nothing and a user who thinks nothing was logged.
 */
async function drainPrompts(
  db: Db,
  client: TelegramClient,
  config: TelegramConfig,
  log: (line: string) => Promise<void>,
): Promise<void> {
  const repo = new MealsRepo(db);
  for (const pending of repo.awaitingPrompt()) {
    const totals = JSON.parse(pending.totals) as Record<string, number>;
    const text = formatEstimate({
      description: pending.description ?? 'Meal',
      totals,
      confidence: pending.confidence,
    });
    const promptId = await sendAndRecord(db, client, config, text, {
      kind: 'estimate',
      meal_id: pending.meal_id,
    });
    if (promptId !== null) {
      repo.setPromptMessageId(pending.meal_id, promptId);
      await log(`meal ${pending.meal_id}: asked for confirmation`);
    }
  }
}

/** Consecutive poll failures before the server says so in the chat itself. */
const ALERT_AFTER_FAILURES = 5;

/** Entry point used by `npm run telegram-server`. */
async function main(): Promise<void> {
  loadConfig(); // fail early and loudly on a broken .env
  const config = loadTelegramConfig();
  const ouraConfig = (await import('../config.js')).loadConfig();
  const db: Db = await openDatabase(ouraConfig.dbPath);
  const repo = new TelegramUpdatesRepo(db);
  const client = new TelegramClient(config.botToken);

  const log = async (line: string): Promise<void> => {
    const stamped = `${new Date().toISOString()}  ${line}`;
    process.stdout.write(stamped + '\n');
    await mkdir(dirname(config.logPath), { recursive: true });
    await appendFile(config.logPath, stamped + '\n', 'utf8');
  };

  await mkdir(config.mediaDir, { recursive: true, mode: 0o700 });

  // A webhook set on this bot makes getUpdates return 409 forever, which
  // looks exactly like "nobody sent anything".
  await client.deleteWebhook();

  await log(
    `telegram server started; bot ${config.botId}, chat ${config.allowedChatId}, ` +
      `tz ${config.tz}, media ${config.mediaDir}`,
  );

  let consecutiveFailures = 0;
  let lastRejectionLog = 0;

  for (;;) {
    try {
      const offset = repo.nextOffset(config.botId);
      const updates = await client.getUpdates(offset);
      if (updates.length > 0) {
        const result = processBatch(updates, repo, config);
        // Rejected-only batches are logged at most hourly: the log file is
        // the one unbounded resource a stranger can grow, one line per batch.
        const rejectedOnly = result.accepted === 0 && result.duplicates === 0;
        const now = Date.now();
        if (!rejectedOnly || now - lastRejectionLog > 3_600_000) {
          if (rejectedOnly) lastRejectionLog = now;
          await log(
            `batch: accepted=${result.accepted} duplicates=${result.duplicates} ` +
              `rejected=${result.rejected}`,
          );
        }

        // Text is NOT handled here. A correction is a model call: slow, and
        // on a flaky connection frequently failing. Handled inline it would
        // block polling and have no retry path — the same lesson the photo
        // drain already learned one message type earlier.
      }

      // Outside the batch check on purpose: work can be left over from an
      // earlier cycle — a download that failed, a photo stored just before a
      // restart — and tying the drain to "a new message arrived" would leave
      // it waiting for unrelated traffic. Found by running it: two photos sat
      // analysed-never because nothing new had been sent since.
      const stored = await drainMedia(repo, client, config, log);
      if (stored > 0) await log(`media: stored=${stored}`);
      await drainPhotos(db, repo, client, config, log);
      await drainText(db, client, config, log);
      await drainPrompts(db, client, config, log);
      consecutiveFailures = 0;
    } catch (err) {
      // Never let one bad cycle kill the process: launchd would restart it,
      // but a tight crash loop would burn the 24h window Telegram keeps
      // undelivered updates for.
      //
      // Failing closed is right — the offset only moves on committed rows, so
      // a transient fault loses nothing. The danger is that a PERSISTENT
      // fault looks identical to a quiet day: the loop retries forever, makes
      // no progress, and after ~24h Telegram drops the backlog for good.
      // launchd cannot help, because the wedged state is in the database, not
      // the process. So back off, and eventually say so out loud on the one
      // channel this process already holds.
      consecutiveFailures += 1;
      const message = (err as Error).message;
      await log(`poll error (${consecutiveFailures} in a row): ${message}`);

      if (consecutiveFailures === ALERT_AFTER_FAILURES) {
        try {
          await client.sendMessage(
            config.allowedChatId,
            `⚠️ Telegram ingestion has failed ${consecutiveFailures} times in a row and is ` +
              `not storing messages. Last error: ${message}`,
          );
        } catch {
          // If even this fails the network is gone; the log line above stands.
        }
      }

      const backoffMs = Math.min(5000 * 2 ** Math.min(consecutiveFailures - 1, 6), 300_000);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

const isEntry =
  typeof process.argv[1] === 'string' && process.argv[1] === fileURLToPath(import.meta.url);

if (isEntry) {
  main().catch((err) => {
    process.stderr.write(`telegram-server: fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
