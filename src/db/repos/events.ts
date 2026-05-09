/**
 * Generic repo for event-keyed Oura tables: sleep_periods, workouts,
 * sessions. Each row keys on the Oura `id` (a UUID-ish string). Multiple
 * rows per day are normal.
 *
 * Conflict semantics: ON CONFLICT(oura_id) DO UPDATE — if Oura re-emits the
 * same event with different content (e.g. a workout that gets re-classified
 * later), we overwrite `data` and refresh `last_synced_at` while preserving
 * `first_seen_at`.
 */

import type { Db } from '../index.js';

export type EventTable = 'sleep_periods' | 'workouts' | 'sessions' | 'rest_mode_periods';

export interface EventRow {
  oura_id: string;
  day: string;
  data: unknown;
  first_seen_at: string;
  last_synced_at: string;
}

interface RawEventRow {
  oura_id: string;
  day: string;
  data: string;
  first_seen_at: string;
  last_synced_at: string;
}

function parse(row: RawEventRow): EventRow {
  return {
    oura_id: row.oura_id,
    day: row.day,
    data: JSON.parse(row.data) as unknown,
    first_seen_at: row.first_seen_at,
    last_synced_at: row.last_synced_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function pickString(raw: unknown, key: string): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = (raw as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

/**
 * Pull the per-row "day" out of a raw event payload. Different Oura
 * collections use different fields:
 *   - sleep:    `day`
 *   - workouts: `day`
 *   - sessions: `day`
 * If absent, we fall back to the date portion of `start_datetime` /
 * `bedtime_start` so we always have something indexable.
 */
function dayFromEvent(raw: unknown): string | null {
  const direct = pickString(raw, 'day');
  if (direct) return direct;
  for (const key of ['start_datetime', 'bedtime_start', 'start_time']) {
    const dt = pickString(raw, key);
    if (dt && /^\d{4}-\d{2}-\d{2}/.test(dt)) return dt.slice(0, 10);
  }
  return null;
}

export class EventCollectionRepo {
  constructor(
    private readonly db: Db,
    public readonly table: EventTable,
  ) {}

  upsert(oura_row: unknown): boolean {
    const id = pickString(oura_row, 'id');
    if (!id) throw new Error(`${this.table}: row missing "id" field; cannot upsert.`);
    const day = dayFromEvent(oura_row);
    if (!day) throw new Error(`${this.table} (id=${id}): could not derive a day for the event.`);
    const data = JSON.stringify(oura_row);
    const now = nowIso();

    const existing = this.db
      .prepare<
        unknown[],
        { oura_id: string }
      >(`SELECT oura_id FROM ${this.table} WHERE oura_id = ?`)
      .get(id);

    if (existing) {
      this.db
        .prepare(
          `UPDATE ${this.table}
              SET day = ?, data = ?, last_synced_at = ?
            WHERE oura_id = ?`,
        )
        .run(day, data, now, id);
      return false;
    }

    this.db
      .prepare(
        `INSERT INTO ${this.table} (oura_id, day, data, first_seen_at, last_synced_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, day, data, now, now);
    return true;
  }

  upsertMany(rows: unknown[]): { inserted: number; updated: number } {
    let inserted = 0;
    let updated = 0;
    const tx = this.db.transaction((rs: unknown[]) => {
      for (const r of rs) {
        if (this.upsert(r)) inserted += 1;
        else updated += 1;
      }
    });
    tx(rows);
    return { inserted, updated };
  }

  listRange(start_date: string, end_date: string): EventRow[] {
    const rows = this.db
      .prepare<
        unknown[],
        RawEventRow
      >(`SELECT * FROM ${this.table} WHERE day BETWEEN ? AND ? ORDER BY day ASC, oura_id ASC`)
      .all(start_date, end_date);
    return rows.map(parse);
  }

  maxDay(): string | null {
    const row = this.db
      .prepare<unknown[], { day: string | null }>(`SELECT MAX(day) AS day FROM ${this.table}`)
      .get();
    return row?.day ?? null;
  }
}
