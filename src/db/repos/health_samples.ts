/**
 * Repository for the `health_samples` table.
 *
 * Generic store for HealthKit-derived samples imported from iOS. One row
 * per (sample_type, start_time, source_name, value) tuple — that's the
 * UNIQUE key used for idempotent re-imports. HealthKit's own UUIDs don't
 * come through iOS Shortcuts reliably, so we synthesize dedup from the
 * sample's intrinsic identity.
 *
 * Inserts use INSERT OR IGNORE on the UNIQUE constraint so re-running the
 * same Shortcut (or scheduled export) doesn't produce duplicates.
 */

import type { Db } from '../index.js';

export interface HealthSample {
  sample_type: string;
  start_time: string;
  end_time: string;
  value: number;
  unit: string;
  source_name?: string | null;
  /** Raw per-sample JSON envelope; preserved verbatim for losslessness. */
  raw?: string | null;
}

export interface HealthSampleRow extends Required<HealthSample> {
  id: number;
  imported_at: string;
  raw: string | null;
}

export interface InsertBatchResult {
  total_received: number;
  inserted: number;
  deduped: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class HealthSamplesRepo {
  constructor(private readonly db: Db) {}

  /**
   * Insert a batch of samples. Idempotent: rows that collide on the UNIQUE
   * constraint are silently skipped and counted as `deduped`.
   *
   * Wraps the batch in a single transaction — important when iOS POSTs
   * a few hundred samples at once.
   */
  insertBatch(samples: HealthSample[]): InsertBatchResult {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO health_samples
         (sample_type, start_time, end_time, value, unit, source_name, imported_at, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const importedAt = nowIso();
    // HealthKit reports percentages as fractions (0.25 for 25%), whatever
    // the unit string says. Normalising here covers every route in — the
    // app, the export importer and the Shortcut — so no consumer has to
    // know which source a row came from. `raw` keeps the original value.
    // Rounded as well as rescaled: `value` is part of the UNIQUE key, and
    // float noise (0.246 vs 0.246000000000000002, the same reading from two
    // routes) otherwise slips past it and stores the row twice.
    const normalized = samples.map((s) =>
      s.sample_type.endsWith('_percentage')
        ? { ...s, value: Math.round((s.value <= 1 ? s.value * 100 : s.value) * 100) / 100 }
        : s,
    );
    let inserted = 0;

    const tx = this.db.transaction((rows: HealthSample[]) => {
      for (const s of rows) {
        const info = stmt.run(
          s.sample_type,
          s.start_time,
          s.end_time,
          s.value,
          s.unit,
          s.source_name ?? null,
          importedAt,
          s.raw ?? null,
        );
        if (info.changes > 0) inserted += 1;
      }
    });
    tx(normalized);

    return {
      total_received: normalized.length,
      inserted,
      deduped: normalized.length - inserted,
    };
  }

  /** Fetch recent samples for a given type. Useful for tests + MCP tools. */
  recentByType(sample_type: string, limit = 20): HealthSampleRow[] {
    return this.db
      .prepare<unknown[], HealthSampleRow>(
        `SELECT * FROM health_samples
          WHERE sample_type = ?
          ORDER BY start_time DESC
          LIMIT ?`,
      )
      .all(sample_type, limit);
  }

  /** Count rows total — handy in tests. */
  countAll(): number {
    const row = this.db
      .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM health_samples')
      .get();
    return row?.n ?? 0;
  }
}
