/**
 * Repository for `telegram_updates` — inbound chat messages.
 *
 * Two things here are load-bearing and easy to break:
 *
 * 1. **The poll offset is derived, not stored.** `getUpdates(offset=N)`
 *    *acknowledges* everything below N and Telegram then discards it
 *    permanently, so an offset that advances before a durable write loses
 *    messages irrecoverably. Deriving it from committed rows makes that
 *    impossible.
 * 2. **Rejected updates still move the offset.** They are never inserted, so
 *    they cannot raise `MAX(update_id)` — and the next poll would request
 *    the same rejected update forever, pinning the queue behind one stranger's
 *    message. A high-water mark, written in the same transaction as the batch,
 *    covers them without storing a third party's name and chat id in a health
 *    database, and without letting a flood of spam become a flood of rows.
 */

import type { Db } from '../index.js';

export type TelegramKind = 'text' | 'photo' | 'voice' | 'document' | 'other';
export type TelegramStatus = 'pending' | 'stored' | 'failed' | 'dead';

export interface TelegramUpdateRow {
  id: number;
  bot_id: number;
  update_id: number;
  chat_id: number;
  message_id: number;
  media_group_id: string | null;
  kind: TelegramKind;
  text: string | null;
  sent_epoch: number;
  received_epoch: number;
  tz_assumed: string;
  file_id: string | null;
  file_unique_id: string | null;
  photo_width: number | null;
  photo_height: number | null;
  media_path: string | null;
  sha256: string | null;
  bytes: number | null;
  status: TelegramStatus;
  attempts: number;
  error: string | null;
  superseded_by: number | null;
  is_forwarded: number;
  raw: string;
}

export interface NewTelegramUpdate {
  bot_id: number;
  update_id: number;
  chat_id: number;
  message_id: number;
  media_group_id?: string | null;
  kind: TelegramKind;
  text?: string | null;
  sent_epoch: number;
  tz_assumed: string;
  file_id?: string | null;
  file_unique_id?: string | null;
  photo_width?: number | null;
  photo_height?: number | null;
  /** True when the update carries media we still have to fetch. */
  needs_media: boolean;
  raw: string;
  /** Set when this update is an edit of a message we already stored. */
  edits_message_id?: number | null;
  /** True when the text came from someone other than the account owner. */
  is_forwarded: boolean;
}

export interface StoreBatchResult {
  inserted: number;
  duplicates: number;
}

const HIGH_WATER_KEY = 'telegram_rejected_high_water';
const REJECTED_COUNT_KEY = 'telegram_rejected_count';

export class TelegramUpdatesRepo {
  constructor(private readonly db: Db) {}

  /**
   * Insert accepted updates and record the highest rejected id, in ONE
   * transaction. Both must land together: the offset is computed from them,
   * and a partial write would either replay accepted messages or skip
   * rejected ones forever.
   */
  storeBatch(
    botId: number,
    accepted: NewTelegramUpdate[],
    rejectedHighWater: number | null,
    rejectedCount: number,
  ): StoreBatchResult {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO telegram_updates
         (bot_id, update_id, chat_id, message_id, media_group_id, kind, text,
          sent_epoch, received_epoch, tz_assumed, file_id, file_unique_id,
          photo_width, photo_height, status, raw, is_forwarded)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // An edit arrives as a new update carrying the same message_id. Keep both
    // and point the older at the newer, so a consumer reading the message
    // later can tell which version is current rather than counting both.
    const supersede = this.db.prepare(
      `UPDATE telegram_updates SET superseded_by = ?
        WHERE chat_id = ? AND message_id = ? AND id <> ? AND superseded_by IS NULL`,
    );
    const setMeta = this.db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    const readMeta = this.db.prepare<[string], { value: string }>(
      'SELECT value FROM schema_meta WHERE key = ?',
    );

    let inserted = 0;

    const tx = this.db.transaction(() => {
      const receivedEpoch = Math.floor(Date.now() / 1000);
      for (const u of accepted) {
        const info = insert.run(
          u.bot_id,
          u.update_id,
          u.chat_id,
          u.message_id,
          u.media_group_id ?? null,
          u.kind,
          u.text ?? null,
          u.sent_epoch,
          receivedEpoch,
          u.tz_assumed,
          u.file_id ?? null,
          u.file_unique_id ?? null,
          u.photo_width ?? null,
          u.photo_height ?? null,
          // A row with media is incomplete until the file is on disk, and the
          // download cannot run in here: better-sqlite3 transactions are
          // synchronous and cannot await.
          u.needs_media ? 'pending' : 'stored',
          u.raw,
          u.is_forwarded ? 1 : 0,
        );
        if (info.changes > 0) {
          inserted += 1;
          if (u.edits_message_id != null) {
            supersede.run(
              Number(info.lastInsertRowid),
              u.chat_id,
              u.edits_message_id,
              Number(info.lastInsertRowid),
            );
          }
        }
      }

      if (rejectedHighWater != null) {
        const key = `${HIGH_WATER_KEY}:${botId}`;
        const current = Number(readMeta.get(key)?.value ?? 0);
        // Monotonic: a late batch must never move the mark backwards.
        if (rejectedHighWater > current) setMeta.run(key, String(rejectedHighWater));
      }
      if (rejectedCount > 0) {
        // Not for accounting — a rising count is the signal that someone has
        // found the bot and is probing it.
        const key = `${REJECTED_COUNT_KEY}:${botId}`;
        const current = Number(readMeta.get(key)?.value ?? 0);
        setMeta.run(key, String(current + rejectedCount));
      }
    });
    tx();

    return { inserted, duplicates: accepted.length - inserted };
  }

  /**
   * The offset for the next poll: one past everything we have observed,
   * accepted or rejected. Scoped to this bot, because `update_id` restarts
   * for a different token.
   */
  nextOffset(botId: number): number {
    const row = this.db
      .prepare<
        [number],
        { max_id: number | null }
      >('SELECT MAX(update_id) AS max_id FROM telegram_updates WHERE bot_id = ?')
      .get(botId);
    const stored = row?.max_id ?? 0;

    const meta = this.db
      .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
      .get(`${HIGH_WATER_KEY}:${botId}`);
    const rejected = Number(meta?.value ?? 0);

    const highest = Math.max(stored, rejected);
    return highest > 0 ? highest + 1 : 0;
  }

  /** Rows whose media still has to be fetched, oldest first. */
  pendingMedia(limit = 20): TelegramUpdateRow[] {
    return this.db
      .prepare<[number], TelegramUpdateRow>(
        `SELECT * FROM telegram_updates
          WHERE status IN ('pending', 'failed') AND file_id IS NOT NULL
          ORDER BY update_id LIMIT ?`,
      )
      .all(limit);
  }

  markStored(id: number, mediaPath: string, sha256: string, bytes: number): void {
    this.db
      .prepare(
        `UPDATE telegram_updates
            SET status = 'stored', media_path = ?, sha256 = ?, bytes = ?, error = NULL
          WHERE id = ?`,
      )
      .run(mediaPath, sha256, bytes, id);
  }

  /**
   * Record a failed download. After `maxAttempts` the row goes to 'dead'
   * rather than retrying forever: every retry costs a request, and later a
   * model call.
   */
  markFailed(id: number, error: string, maxAttempts = 5): void {
    this.db
      .prepare(
        `UPDATE telegram_updates
            SET attempts = attempts + 1,
                error = ?,
                status = CASE WHEN attempts + 1 >= ? THEN 'dead' ELSE 'failed' END
          WHERE id = ?`,
      )
      .run(error, maxAttempts, id);
  }

  countAll(): number {
    const row = this.db
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM telegram_updates')
      .get();
    return row?.n ?? 0;
  }
}
