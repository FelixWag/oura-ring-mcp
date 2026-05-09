/**
 * Generic repo for Oura daily-score tables (daily_sleep, daily_readiness,
 * daily_activity, daily_spo2). Each row keys on `day`. Re-syncing a day
 * upserts: `last_synced_at` advances, `first_seen_at` is preserved, the raw
 * `data` JSON is overwritten (Oura may have re-scored that day).
 */

import type { Db } from '../index.js';

export type DailyTable = 'daily_sleep' | 'daily_readiness' | 'daily_activity' | 'daily_spo2';

export interface DailyRow {
  day: string; // YYYY-MM-DD
  score: number | null;
  data: unknown; // parsed JSON
  first_seen_at: string;
  last_synced_at: string;
}

interface RawDailyRow {
  day: string;
  score: number | null;
  data: string;
  first_seen_at: string;
  last_synced_at: string;
}

function parse(row: RawDailyRow): DailyRow {
  return {
    day: row.day,
    score: row.score,
    data: JSON.parse(row.data) as unknown,
    first_seen_at: row.first_seen_at,
    last_synced_at: row.last_synced_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function pickDay(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = (raw as Record<string, unknown>).day;
  return typeof v === 'string' ? v : null;
}

function pickScore(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = (raw as Record<string, unknown>).score;
  return typeof v === 'number' ? v : null;
}

export class DailyCollectionRepo {
  constructor(
    private readonly db: Db,
    public readonly table: DailyTable,
  ) {}

  /**
   * Upsert one raw Oura daily row. `oura_row` must include a `day` field.
   * Returns true if a row was inserted, false if an existing row was updated.
   */
  upsert(oura_row: unknown): boolean {
    const day = pickDay(oura_row);
    if (!day) throw new Error(`${this.table}: row missing "day" field; cannot upsert.`);
    const score = pickScore(oura_row);
    const data = JSON.stringify(oura_row);
    const now = nowIso();

    const existing = this.db
      .prepare<unknown[], { day: string }>(`SELECT day FROM ${this.table} WHERE day = ?`)
      .get(day);

    if (existing) {
      this.db
        .prepare(
          `UPDATE ${this.table}
              SET score = ?, data = ?, last_synced_at = ?
            WHERE day = ?`,
        )
        .run(score, data, now, day);
      return false;
    }

    this.db
      .prepare(
        `INSERT INTO ${this.table} (day, score, data, first_seen_at, last_synced_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(day, score, data, now, now);
    return true;
  }

  /** Bulk upsert. Returns counts. */
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

  get(day: string): DailyRow | null {
    const row = this.db
      .prepare<unknown[], RawDailyRow>(`SELECT * FROM ${this.table} WHERE day = ?`)
      .get(day);
    return row ? parse(row) : null;
  }

  /**
   * List rows in [start_date, end_date] inclusive, sorted by day ascending.
   */
  listRange(start_date: string, end_date: string): DailyRow[] {
    const rows = this.db
      .prepare<
        unknown[],
        RawDailyRow
      >(`SELECT * FROM ${this.table} WHERE day BETWEEN ? AND ? ORDER BY day ASC`)
      .all(start_date, end_date);
    return rows.map(parse);
  }

  /** Return the most recent `day` we've stored, or null if empty. */
  maxDay(): string | null {
    const row = this.db
      .prepare<unknown[], { day: string | null }>(`SELECT MAX(day) AS day FROM ${this.table}`)
      .get();
    return row?.day ?? null;
  }
}
