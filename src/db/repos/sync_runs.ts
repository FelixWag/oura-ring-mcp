/**
 * Audit log of sync runs. One row per (collection, run). Used both for
 * debugging ("when did each collection last finish syncing?") and for
 * resumability heuristics in future versions.
 */

import type { Db } from '../index.js';

export type SyncCollection =
  | 'daily_sleep'
  | 'daily_readiness'
  | 'daily_activity'
  | 'daily_spo2'
  | 'daily_stress'
  | 'daily_resilience'
  | 'daily_cardiovascular_age'
  | 'vo2_max'
  | 'sleep_time'
  | 'sleep_periods'
  | 'workouts'
  | 'sessions'
  | 'rest_mode_periods'
  | 'enhanced_tag'
  | 'heartrate';

export interface SyncRun {
  id: number;
  collection: SyncCollection;
  started_at: string;
  finished_at: string | null;
  ok: 0 | 1 | null; // 1 success, 0 failure, null in-progress
  error: string | null;
  rows_upserted: number | null;
  from_date: string | null;
  to_date: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class SyncRunsRepo {
  constructor(private readonly db: Db) {}

  start(collection: SyncCollection, from_date: string, to_date: string): number {
    const info = this.db
      .prepare(
        `INSERT INTO sync_runs (collection, started_at, from_date, to_date)
         VALUES (?, ?, ?, ?)`,
      )
      .run(collection, nowIso(), from_date, to_date);
    return Number(info.lastInsertRowid);
  }

  finishOk(id: number, rows_upserted: number): void {
    this.db
      .prepare(
        `UPDATE sync_runs SET finished_at = ?, ok = 1, rows_upserted = ?
          WHERE id = ?`,
      )
      .run(nowIso(), rows_upserted, id);
  }

  finishError(id: number, error: string): void {
    this.db
      .prepare(
        `UPDATE sync_runs SET finished_at = ?, ok = 0, error = ?
          WHERE id = ?`,
      )
      .run(nowIso(), error.slice(0, 1000), id);
  }

  /** Most recent successful sync timestamp for a given collection, or null. */
  lastSuccessAt(collection: SyncCollection): string | null {
    const row = this.db
      .prepare<unknown[], { finished_at: string }>(
        `SELECT finished_at FROM sync_runs WHERE collection = ? AND ok = 1
          ORDER BY id DESC LIMIT 1`,
      )
      .get(collection);
    return row?.finished_at ?? null;
  }

  recent(limit = 20): SyncRun[] {
    return this.db
      .prepare<unknown[], SyncRun>(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?`)
      .all(limit);
  }
}
