/**
 * Repository for the `heartrate` timeseries table.
 *
 * Schema: composite primary key on (timestamp, source) — Oura occasionally
 * emits the same instant under two sources during state transitions
 * (sleep onset bridges 'rest' and 'sleep'). Both rows are kept.
 *
 * Storage stays per-sample and lossless. Aggregation (hourly summary)
 * happens at read time via SQL — see `summarizeByHour`. This means future
 * tools can introduce different aggregations without re-syncing data.
 */

import type { Db } from '../index.js';

export interface HeartrateRow {
  timestamp: string; // ISO 8601
  source: string; // e.g. 'awake' | 'rest' | 'sleep' | 'workout' | 'live'
  bpm: number;
  data: unknown;
  first_seen_at: string;
  last_synced_at: string;
}

export interface HeartrateHourSummary {
  hour_start: string; // ISO 8601, top-of-hour
  source: string;
  bpm_avg: number;
  bpm_min: number;
  bpm_max: number;
  sample_count: number;
}

interface RawHeartrateRow {
  timestamp: string;
  source: string;
  bpm: number;
  data: string;
  first_seen_at: string;
  last_synced_at: string;
}

function parse(row: RawHeartrateRow): HeartrateRow {
  return {
    timestamp: row.timestamp,
    source: row.source,
    bpm: row.bpm,
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

function pickNumber(raw: unknown, key: string): number | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = (raw as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export class HeartrateRepo {
  constructor(private readonly db: Db) {}

  /**
   * Upsert one Oura heartrate sample. Returns true on insert, false on
   * update (an existing (timestamp, source) row had its bpm/data refreshed).
   */
  upsert(oura_row: unknown): boolean {
    const timestamp = pickString(oura_row, 'timestamp');
    const source = pickString(oura_row, 'source');
    const bpm = pickNumber(oura_row, 'bpm');
    if (!timestamp || !source || bpm === null) {
      throw new Error(
        `heartrate: row missing timestamp/source/bpm; got timestamp=${timestamp ?? 'null'}, ` +
          `source=${source ?? 'null'}, bpm=${bpm ?? 'null'}`,
      );
    }
    const data = JSON.stringify(oura_row);
    const now = nowIso();

    const existing = this.db
      .prepare<
        unknown[],
        { timestamp: string }
      >('SELECT timestamp FROM heartrate WHERE timestamp = ? AND source = ?')
      .get(timestamp, source);

    if (existing) {
      this.db
        .prepare(
          `UPDATE heartrate
              SET bpm = ?, data = ?, last_synced_at = ?
            WHERE timestamp = ? AND source = ?`,
        )
        .run(bpm, data, now, timestamp, source);
      return false;
    }

    this.db
      .prepare(
        `INSERT INTO heartrate (timestamp, source, bpm, data, first_seen_at, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(timestamp, source, bpm, data, now, now);
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

  /**
   * Raw samples in [start_datetime, end_datetime] inclusive. Sorted ascending.
   * Datetimes compared as ISO 8601 strings — works because the format sorts
   * lexicographically.
   */
  listRange(start_datetime: string, end_datetime: string): HeartrateRow[] {
    const rows = this.db
      .prepare<unknown[], RawHeartrateRow>(
        `SELECT * FROM heartrate WHERE timestamp BETWEEN ? AND ?
            ORDER BY timestamp ASC, source ASC`,
      )
      .all(start_datetime, end_datetime);
    return rows.map(parse);
  }

  /**
   * Aggregated heart-rate summary, one row per (hour, source) bucket in
   * [start_datetime, end_datetime]. SQLite's `strftime` truncates each
   * timestamp to the top of its hour; AVG/MIN/MAX/COUNT collapse the
   * samples within. Output sorted by hour ascending then source.
   *
   * This is the default projection returned by the MCP tool — it keeps
   * a 24-hour window at ~24–40 rows instead of ~300 raw samples.
   */
  summarizeByHour(start_datetime: string, end_datetime: string): HeartrateHourSummary[] {
    return this.db
      .prepare<unknown[], HeartrateHourSummary>(
        `SELECT
           substr(timestamp, 1, 13) || ':00:00Z' AS hour_start,
           source,
           ROUND(AVG(bpm), 1) AS bpm_avg,
           MIN(bpm)           AS bpm_min,
           MAX(bpm)           AS bpm_max,
           COUNT(*)           AS sample_count
         FROM heartrate
         WHERE timestamp BETWEEN ? AND ?
         GROUP BY hour_start, source
         ORDER BY hour_start ASC, source ASC`,
      )
      .all(start_datetime, end_datetime);
  }

  /**
   * Most recent timestamp stored, or null when empty. Used by the sync
   * orchestrator to compute the incremental window.
   */
  maxTimestamp(): string | null {
    const row = this.db
      .prepare<unknown[], { ts: string | null }>('SELECT MAX(timestamp) AS ts FROM heartrate')
      .get();
    return row?.ts ?? null;
  }
}
