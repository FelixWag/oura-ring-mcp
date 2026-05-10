import type { Database } from 'better-sqlite3';

/**
 * Schema migrations, applied in order.
 *
 * Each migration is idempotent (uses IF NOT EXISTS / UPSERT) so re-running
 * the bootstrap is safe. The schema version is tracked in `schema_meta` so
 * future migrations can be applied conditionally without "drop and recreate".
 *
 * Adding a new migration:
 *   1. Append a new entry to MIGRATIONS with the next version number.
 *   2. Never edit a migration that has already shipped — write a new one.
 */

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'annotations + schema_meta',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Mirrors Oura's EnhancedTagModel 1:1 (tag_type_code, start/end_time,
      -- start/end_day, comment, custom_name) plus two columns we use to track
      -- where each row came from. v0.4 will sync Oura enhanced_tags into this
      -- same table with source='oura' and oura_id populated, upserting on
      -- oura_id (which is UNIQUE).
      CREATE TABLE IF NOT EXISTS annotations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        tag_type_code   TEXT,
        custom_name     TEXT,
        start_time      TEXT NOT NULL,
        end_time        TEXT,
        start_day       TEXT NOT NULL,
        end_day         TEXT,
        comment         TEXT,
        source          TEXT NOT NULL DEFAULT 'local',
        oura_id         TEXT UNIQUE,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,

        CHECK (source IN ('local', 'oura')),
        CHECK (
          tag_type_code IS NULL
          OR tag_type_code = 'custom'
          OR length(tag_type_code) > 0
        ),
        CHECK (tag_type_code != 'custom' OR (custom_name IS NOT NULL AND length(custom_name) > 0)),
        CHECK (tag_type_code IS NOT NULL OR (comment IS NOT NULL AND length(comment) > 0))
      );

      CREATE INDEX IF NOT EXISTS idx_annotations_start_day ON annotations(start_day);
      CREATE INDEX IF NOT EXISTS idx_annotations_tag_type  ON annotations(tag_type_code);
      CREATE INDEX IF NOT EXISTS idx_annotations_source    ON annotations(source);
    `,
  },
  {
    version: 2,
    // Background: the v0.3 KNOWN_TAG_TYPE_CODES seed list used bare names
    // (alcohol, caffeine, traveled, …) that did not match Oura's actual
    // canonical codes (tag_sleep_alcohol, tag_generic_caffeine, …) once we
    // inspected real data via the enhanced_tag endpoint. Any rows already
    // inserted with the v0.3 guesses need to be remapped so they validate
    // against the new code list (and so they will join cleanly with v0.4
    // synced Oura rows).
    //
    // We only remap codes we KNOW (have observed in real Oura data). Codes
    // we never saw in the user's history are left untouched — if a user
    // somehow inserted one, the v0.3.1 validator will surface it on the
    // next update and they can correct it manually.
    //
    // This migration is idempotent: re-running it just no-ops on already-
    // migrated rows.
    name: 'remap v0.3 guess-codes to canonical Oura codes',
    sql: `
      UPDATE annotations
         SET tag_type_code = 'tag_sleep_alcohol',
             updated_at    = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE tag_type_code = 'alcohol';
    `,
  },
  {
    version: 3,
    // v0.4: local mirror of Oura data.
    //
    // Hybrid storage shape (see DECISIONS.md, "v0.4 plan approved"):
    //   - Indexed key columns: day / oura_id, score (where present),
    //     last_synced_at, first_seen_at.
    //   - Raw `data` TEXT column carrying the entire Oura row as JSON,
    //     verbatim. Lossless; no schema churn when Oura adds fields.
    //
    // Daily families key on `day` (one row per UTC day). Event families
    // (sleep_periods, workouts, sessions) key on Oura's `oura_id` (multiple
    // events possible per day). Both use INSERT ON CONFLICT(...) DO UPDATE
    // to upsert idempotently — `last_synced_at` advances on every sync,
    // `first_seen_at` is preserved.
    //
    // enhanced_tag is NOT mirrored here: those rows go into the existing
    // `annotations` table with source='oura' and oura_id populated, per the
    // v0.3 schema-mirroring decision.
    name: 'v0.4: oura data mirror tables',
    sql: `
      -- Daily score families. One row per (table, day).
      CREATE TABLE IF NOT EXISTS daily_sleep (
        day             TEXT PRIMARY KEY,
        score           INTEGER,
        data            TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        last_synced_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_daily_sleep_synced ON daily_sleep(last_synced_at);

      CREATE TABLE IF NOT EXISTS daily_readiness (
        day             TEXT PRIMARY KEY,
        score           INTEGER,
        data            TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        last_synced_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_daily_readiness_synced ON daily_readiness(last_synced_at);

      CREATE TABLE IF NOT EXISTS daily_activity (
        day             TEXT PRIMARY KEY,
        score           INTEGER,
        data            TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        last_synced_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_daily_activity_synced ON daily_activity(last_synced_at);

      CREATE TABLE IF NOT EXISTS daily_spo2 (
        day             TEXT PRIMARY KEY,
        score           INTEGER,           -- nullable: spo2 may not have a "score" — kept for shape parity
        data            TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        last_synced_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_daily_spo2_synced ON daily_spo2(last_synced_at);

      -- Per-period sleep records. Multiple per day possible (nap + main sleep).
      CREATE TABLE IF NOT EXISTS sleep_periods (
        oura_id         TEXT PRIMARY KEY,
        day             TEXT NOT NULL,
        data            TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        last_synced_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sleep_periods_day    ON sleep_periods(day);
      CREATE INDEX IF NOT EXISTS idx_sleep_periods_synced ON sleep_periods(last_synced_at);

      -- Event collections.
      CREATE TABLE IF NOT EXISTS workouts (
        oura_id         TEXT PRIMARY KEY,
        day             TEXT NOT NULL,
        data            TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        last_synced_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workouts_day    ON workouts(day);
      CREATE INDEX IF NOT EXISTS idx_workouts_synced ON workouts(last_synced_at);

      CREATE TABLE IF NOT EXISTS sessions (
        oura_id         TEXT PRIMARY KEY,
        day             TEXT NOT NULL,
        data            TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        last_synced_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_day    ON sessions(day);
      CREATE INDEX IF NOT EXISTS idx_sessions_synced ON sessions(last_synced_at);

      -- Codes observed in synced enhanced_tag rows. Feeds back into the
      -- annotation validator so v0.3.1 inferences converge to reality.
      CREATE TABLE IF NOT EXISTS discovered_tag_types (
        code              TEXT PRIMARY KEY,
        first_seen_at     TEXT NOT NULL,
        last_seen_at      TEXT NOT NULL,
        occurrence_count  INTEGER NOT NULL DEFAULT 1
      );

      -- Audit log: one row per sync run per collection.
      CREATE TABLE IF NOT EXISTS sync_runs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        collection      TEXT NOT NULL,
        started_at      TEXT NOT NULL,
        finished_at     TEXT,
        ok              INTEGER,                  -- 1 = success, 0 = failure, NULL = in progress
        error           TEXT,
        rows_upserted   INTEGER,
        from_date       TEXT,
        to_date         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sync_runs_collection ON sync_runs(collection, started_at DESC);
    `,
  },
  {
    version: 4,
    // v0.4.2: cover the remaining daily collections + rest_mode_period.
    //
    // Schema-design note (see DECISIONS.md, "JSON-first storage for daily
    // collections without a numeric score"):
    //   - daily_sleep / daily_readiness / daily_activity / daily_spo2 each
    //     surface a numeric `score` field. We mirror that into the indexed
    //     `score INTEGER` column for fast WHERE / ORDER BY.
    //   - daily_stress has no `score` field (returns recovery_high /
    //     stress_high separately).
    //   - daily_resilience has a `level` STRING (ok / good / great / …),
    //     not an integer score.
    //   - daily_cardiovascular_age, vo2_max have numeric values under
    //     different field names (`vascular_age`, `vo2_max`) that we copy
    //     into the indexed `score` column.
    //   - sleep_time has no score at all — it's bedtime recommendations.
    //
    //   Convention: the `data` JSON column is the lossless source of
    //   truth. The `score` column is a fast-lookup convenience that's
    //   NULL for tables without a single canonical scalar score. Code
    //   that needs the resilience level or stress sub-fields uses
    //   `extractField()` / `extractFieldRange()` on the repo, which
    //   wrap SQLite's `json_extract`. See DailyCollectionRepo.
    name: 'v0.4.2: daily_stress / daily_resilience / daily_cardiovascular_age / vo2_max / sleep_time + rest_mode_periods',
    sql: `
      CREATE TABLE IF NOT EXISTS daily_stress (
        day             TEXT PRIMARY KEY,
        score           INTEGER,           -- NULL: stress has no aggregate score; see data.day_summary etc.
        data            TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        last_synced_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_daily_stress_synced ON daily_stress(last_synced_at);

      CREATE TABLE IF NOT EXISTS daily_resilience (
        day             TEXT PRIMARY KEY,
        score           INTEGER,           -- NULL: resilience uses a STRING level (ok / good / great / exceptional); see data.level
        data            TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        last_synced_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_daily_resilience_synced ON daily_resilience(last_synced_at);

      CREATE TABLE IF NOT EXISTS daily_cardiovascular_age (
        day             TEXT PRIMARY KEY,
        score           INTEGER,           -- vascular_age (years), copied from data
        data            TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        last_synced_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_daily_cv_age_synced ON daily_cardiovascular_age(last_synced_at);

      CREATE TABLE IF NOT EXISTS vo2_max (
        day             TEXT PRIMARY KEY,
        score           INTEGER,           -- vo2_max value (rounded to int for the index; full float in data)
        data            TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        last_synced_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vo2_max_synced ON vo2_max(last_synced_at);

      CREATE TABLE IF NOT EXISTS sleep_time (
        day             TEXT PRIMARY KEY,
        score           INTEGER,           -- NULL: sleep_time is bedtime recommendations, no score
        data            TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        last_synced_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sleep_time_synced ON sleep_time(last_synced_at);

      -- rest_mode_period: time spans where the ring was in "rest mode"
      -- (typically logged manually around illness/recovery). Multiple
      -- episodes may be nested inside the data column.
      CREATE TABLE IF NOT EXISTS rest_mode_periods (
        oura_id         TEXT PRIMARY KEY,
        day             TEXT NOT NULL,    -- start_day, indexed for date-range queries
        data            TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        last_synced_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rest_mode_day    ON rest_mode_periods(day);
      CREATE INDEX IF NOT EXISTS idx_rest_mode_synced ON rest_mode_periods(last_synced_at);
    `,
  },
  {
    version: 5,
    // v0.4.4: high-resolution heart-rate timeseries.
    //
    // Unlike daily collections, heartrate is keyed on (timestamp, source)
    // because Oura occasionally emits the same instant under two sources
    // during state transitions (sleep onset bridges 'rest' and 'sleep').
    // Without the composite key we'd lose rows on upsert.
    //
    // Volume: tens of thousands of rows per ~6 months of ring data, but
    // SQLite handles this trivially. The `data` JSON column is preserved
    // for losslessness even though every Oura field today is captured by
    // (timestamp, bpm, source); future fields land there automatically
    // without a schema change.
    name: 'v0.4.4: heartrate timeseries',
    sql: `
      CREATE TABLE IF NOT EXISTS heartrate (
        timestamp       TEXT NOT NULL,
        source          TEXT NOT NULL,
        bpm             INTEGER NOT NULL,
        data            TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        last_synced_at  TEXT NOT NULL,
        PRIMARY KEY (timestamp, source)
      );
      CREATE INDEX IF NOT EXISTS idx_heartrate_timestamp ON heartrate(timestamp);
      CREATE INDEX IF NOT EXISTS idx_heartrate_synced    ON heartrate(last_synced_at);
    `,
  },
];

export function currentSchemaVersion(db: Database): number {
  // schema_meta might not exist on a fresh DB; treat that as version 0.
  const exists = db
    .prepare<
      unknown[],
      { name: string }
    >("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'")
    .get();
  if (!exists) return 0;
  const row = db
    .prepare<unknown[], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
    .get('version');
  return row ? Number(row.value) : 0;
}

export function applyMigrations(db: Database): { from: number; to: number; applied: number[] } {
  const startedAt = currentSchemaVersion(db);
  const applied: number[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= startedAt) continue;
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      // Prepared inside the tx — the very first migration creates schema_meta,
      // so we can't prepare this statement before the loop runs.
      db.prepare(
        'INSERT INTO schema_meta(key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run('version', String(migration.version));
    });
    tx();
    applied.push(migration.version);
  }

  return { from: startedAt, to: currentSchemaVersion(db), applied };
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
