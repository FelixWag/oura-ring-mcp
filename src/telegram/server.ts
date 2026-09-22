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
export function classifyMessage(message: TelegramMessage): ClassifiedMessage {
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
      raw: JSON.stringify(update),
      edits_message_id: isEdit ? message.message_id : null,
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

  for (;;) {
    try {
      const offset = repo.nextOffset(config.botId);
      const updates = await client.getUpdates(offset);
      if (updates.length > 0) {
        const result = processBatch(updates, repo, config);
        if (result.accepted > 0 || result.rejected > 0) {
          await log(
            `batch: accepted=${result.accepted} duplicates=${result.duplicates} ` +
              `rejected=${result.rejected}`,
          );
        }

        // Acknowledge receipt, but only to the allowed chat: replying to a
        // stranger confirms the bot exists and answers to them.
        for (const update of updates) {
          if (!isAllowed(update, config.allowedChatId)) continue;
          const message = (update.message ?? update.edited_message)!;
          if (update.edited_message) continue; // an edit does not need a second ack
          const kind = classifyMessage(message).kind;
          const ack =
            kind === 'text'
              ? 'Got it — saved.'
              : `Got it — ${kind} saved. (Nothing reads it yet; that comes next.)`;
          await client.sendMessage(message.chat.id, ack);
        }

        const stored = await drainMedia(repo, client, config, log);
        if (stored > 0) await log(`media: stored=${stored}`);
      }
    } catch (err) {
      // Never let one bad cycle kill the process: launchd would restart it,
      // but a tight crash loop would burn the 24h window Telegram keeps
      // undelivered updates for.
      await log(`poll error: ${(err as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
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
