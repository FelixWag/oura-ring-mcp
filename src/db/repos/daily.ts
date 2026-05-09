/**
 * Generic repo for Oura daily-keyed collections (daily_sleep, daily_readiness,
 * daily_activity, daily_spo2, daily_stress, daily_resilience,
 * daily_cardiovascular_age, vo2_max, sleep_time). Each row keys on `day`.
 *
 * Re-syncing a day upserts: `last_synced_at` advances, `first_seen_at` is
 * preserved, the raw `data` JSON is overwritten (Oura may have re-scored
 * that day).
 *
 * ## Storage convention
 *
 * Every row carries the entire Oura payload verbatim in the JSON `data`
 * column (lossless source of truth). The indexed `score INTEGER` column is
 * a fast-lookup convenience for tables that have a single canonical numeric
 * score; per-table extraction is configured in `SCORE_FIELDS`.
 *
 * Tables without a single numeric score (`daily_stress`, `daily_resilience`,
 * `sleep_time`) leave `score` NULL. Code that needs string-typed or
 * sub-fields (e.g. resilience `level`, stress `recovery_high`) uses
 * `extractField()` / `extractFieldRange()` which wrap SQLite's
 * `json_extract`. See DECISIONS.md for the design rationale.
 */

import type { Db } from '../index.js';

export type DailyTable =
  | 'daily_sleep'
  | 'daily_readiness'
  | 'daily_activity'
  | 'daily_spo2'
  | 'daily_stress'
  | 'daily_resilience'
  | 'daily_cardiovascular_age'
  | 'vo2_max'
  | 'sleep_time';

/**
 * Per-table mapping of "which field on the raw Oura row gets copied to the
 * indexed `score` column". `null` means leave score NULL — those tables
 * either have no aggregate score or use a non-numeric one (resilience.level
 * is a string; sleep_time has no score).
 *
 * vo2_max returns a float; we round it for the indexed column. The exact
 * float stays in `data`. Filterable by extracted-int score is good enough.
 */
const SCORE_FIELDS: Readonly<Record<DailyTable, string | null>> = {
  daily_sleep: 'score',
  daily_readiness: 'score',
  daily_activity: 'score',
  daily_spo2: 'score',
  daily_stress: null, // no aggregate score field
  daily_resilience: null, // string-valued `level`, not a numeric score
  daily_cardiovascular_age: 'vascular_age',
  vo2_max: 'vo2_max',
  sleep_time: null, // bedtime recommendations, no score
};

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

function pickScoreFor(table: DailyTable, raw: unknown): number | null {
  const field = SCORE_FIELDS[table];
  if (field === null) return null;
  if (typeof raw !== 'object' || raw === null) return null;
  const v = (raw as Record<string, unknown>)[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  // Floats (e.g. vo2_max) are rounded for the indexed column. The unrounded
  // value remains in the `data` JSON; queries that need it use extractField.
  return Number.isInteger(v) ? v : Math.round(v);
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
    const score = pickScoreFor(this.table, oura_row);
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

  // ────────────────────────────────────────────────────────────────────
  // JSON-field accessors
  //
  // For tables that store everything inside the `data` JSON blob (typically
  // because their values aren't a single integer score that fits the
  // `score` column — e.g. daily_resilience.level, daily_stress.recovery_high)
  // these helpers wrap SQLite's json_extract so callers don't have to write
  // raw SQL or parse the JSON in JS.
  //
  // `path` is a SQLite JSON path expression, always starting with `$.`:
  //   '$.level'                         → top-level field
  //   '$.contributors.sleep_balance'    → nested
  //   '$.episodes[0].type'              → array index
  //
  // SQLite returns the value typed (number / text / null) — TypeScript users
  // can pin the expected type via the generic.
  // ────────────────────────────────────────────────────────────────────

  /**
   * Extract a single field from a single day's stored payload.
   * Returns `null` if the row doesn't exist or the path resolves to null.
   *
   * @example
   *   const repo = new DailyCollectionRepo(db, 'daily_resilience');
   *   const level = repo.extractField<string>('2026-05-09', '$.level');
   *   // → 'good' | 'great' | … | null
   */
  extractField<T>(day: string, path: string): T | null {
    const row = this.db
      .prepare<
        unknown[],
        { value: T | null }
      >(`SELECT json_extract(data, ?) AS value FROM ${this.table} WHERE day = ?`)
      .get(path, day);
    return row?.value ?? null;
  }

  /**
   * Extract a single field across a date range, returning one entry per day
   * present in the table. Days without the field (or with null) yield
   * `value: null` — the row order is by day ascending.
   *
   * @example
   *   const repo = new DailyCollectionRepo(db, 'daily_stress');
   *   const series = repo.extractFieldRange<number>('2026-05-01', '2026-05-09', '$.stress_high');
   *   // → [{ day: '2026-05-01', value: 12_000 }, …]
   */
  extractFieldRange<T>(
    start_date: string,
    end_date: string,
    path: string,
  ): { day: string; value: T | null }[] {
    return this.db
      .prepare<unknown[], { day: string; value: T | null }>(
        `SELECT day, json_extract(data, ?) AS value FROM ${this.table}
            WHERE day BETWEEN ? AND ?
            ORDER BY day ASC`,
      )
      .all(path, start_date, end_date);
  }
}
