/**
 * Repository for `external_workouts` — HealthKit HKWorkout records.
 *
 * Exists because Oura's API silently drops workouts recorded through Live
 * Activity Tracking, while the Oura app *does* write them to Apple Health.
 * HealthKit is therefore the only route to those sessions.
 *
 * Storage is deliberately lossless and duplicate-tolerant: one row per source
 * record, no cross-source merging. Deduplication is a read-time concern —
 * see `resolveSessions()` in `src/health/resolve.ts`.
 */

import type { Db } from '../index.js';

export interface ExternalWorkout {
  source: string;
  /**
   * HealthKit's own UUID for the record. Present when a native reader sent
   * it; absent for rows parsed out of an export, where iOS drops it. When
   * present it makes re-import dedupe exact rather than heuristic.
   */
  external_id?: string | null;
  source_name: string;
  activity_type: string;
  start_time: string;
  end_time: string;
  duration_min?: number | null;
  energy_kcal?: number | null;
  distance_km?: number | null;
  avg_heart_rate?: number | null;
  device?: string | null;
  created_at?: string | null;
  raw?: string | null;
}

export interface ExternalWorkoutRow extends ExternalWorkout {
  id: number;
  imported_at: string;
}

export interface InsertResult {
  total_received: number;
  inserted: number;
  deduped: number;
}

export class ExternalWorkoutsRepo {
  constructor(private readonly db: Db) {}

  /** Idempotent batch insert; collisions on the UNIQUE key are skipped. */
  insertBatch(workouts: ExternalWorkout[]): InsertResult {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO external_workouts
         (source, source_name, activity_type, start_time, end_time, duration_min,
          energy_kcal, distance_km, avg_heart_rate, device, created_at, imported_at, raw,
          external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const importedAt = new Date().toISOString();
    let inserted = 0;

    const tx = this.db.transaction((rows: ExternalWorkout[]) => {
      for (const w of rows) {
        const info = stmt.run(
          w.source,
          w.source_name,
          w.activity_type,
          w.start_time,
          w.end_time,
          w.duration_min ?? null,
          w.energy_kcal ?? null,
          w.distance_km ?? null,
          w.avg_heart_rate ?? null,
          w.device ?? null,
          w.created_at ?? null,
          importedAt,
          w.raw ?? null,
          w.external_id ?? null,
        );
        if (info.changes > 0) inserted += 1;
      }
    });
    tx(workouts);

    return {
      total_received: workouts.length,
      inserted,
      deduped: workouts.length - inserted,
    };
  }

  /** All rows overlapping [from, to), oldest first. Dates are ISO 8601. */
  inRange(from: string, to: string): ExternalWorkoutRow[] {
    return this.db
      .prepare<
        unknown[],
        ExternalWorkoutRow
      >(`SELECT * FROM external_workouts WHERE end_time > ? AND start_time < ? ORDER BY start_time`)
      .all(from, to);
  }

  countAll(): number {
    const row = this.db
      .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM external_workouts')
      .get();
    return row?.n ?? 0;
  }
}
