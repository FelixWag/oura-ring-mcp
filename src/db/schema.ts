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
  {
    version: 6,
    // v0.6: voice ingestion.
    //
    // The voice server accepts dictated text from an iPhone Siri Shortcut,
    // forwards it to a headless Claude Agent SDK session, and Claude calls
    // oura_add_annotation N times to extract structured annotations.
    //
    // Each request creates ONE row in `voice_logs` capturing the raw text +
    // metadata. Each extracted annotation gets a FK back to that voice_log
    // (NULL when source != voice). This gives us a clean audit trail
    // ("which voice note produced this annotation?") without duplicating
    // the dictation across N annotations' comment fields.
    //
    // No CHECK constraint changes on `annotations.source`: voice-extracted
    // annotations are still `source='local'` — the FK + raw text in
    // voice_logs is what distinguishes them.
    name: 'v0.6: voice_logs + annotations.voice_log_id FK',
    sql: `
      CREATE TABLE IF NOT EXISTS voice_logs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        raw_text          TEXT NOT NULL,
        source            TEXT NOT NULL,       -- e.g. 'siri'
        captured_at       TEXT NOT NULL,       -- ISO 8601 from the iPhone
        timezone          TEXT,                -- IANA name from the iPhone, e.g. 'Europe/Berlin'
        received_at       TEXT NOT NULL,       -- ISO 8601 when the server received it
        finished_at       TEXT,                -- ISO 8601 when the agent finished
        ok                INTEGER,             -- 1 = success, 0 = agent error, NULL = in progress
        error             TEXT,                -- truncated error string if ok=0
        annotation_count  INTEGER,             -- number of annotations the agent created
        claude_summary    TEXT,                -- short human-readable summary for the Siri banner
        duration_ms       INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_voice_logs_received_at ON voice_logs(received_at);

      ALTER TABLE annotations ADD COLUMN voice_log_id INTEGER REFERENCES voice_logs(id);
      CREATE INDEX IF NOT EXISTS idx_annotations_voice_log_id ON annotations(voice_log_id);
    `,
  },
  {
    version: 7,
    // v0.7: Apple Health import.
    //
    // Generic samples table that holds anything an iOS HealthKit-backed
    // source POSTs at us — nutrition first, but the same shape handles
    // steps, weight, mindfulness minutes, body temperature, etc. via the
    // `sample_type` discriminator.
    //
    // Dedup key is (sample_type, start_time, source_name, value):
    // HealthKit UUIDs don't come through iOS Shortcuts reliably, and a
    // single source can't legitimately emit the same value at the same
    // millisecond twice. False-positive collision risk is essentially
    // zero in practice.
    //
    // `raw` keeps the original per-sample JSON envelope so future fields
    // (metadata, device, uuid if iOS ever exposes it) can be backfilled
    // without a schema change — same pattern as `data` on the Oura
    // mirror tables.
    name: 'v0.7: health_samples (Apple Health import)',
    sql: `
      CREATE TABLE IF NOT EXISTS health_samples (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        sample_type     TEXT NOT NULL,    -- 'dietary_energy_consumed', 'dietary_protein', 'steps', ...
        start_time      TEXT NOT NULL,    -- ISO 8601 with offset, as iOS sends it
        end_time        TEXT NOT NULL,    -- usually == start_time for point samples
        value           REAL NOT NULL,    -- numeric quantity (CAST from string at write time)
        unit            TEXT NOT NULL,    -- 'kcal', 'g', 'count', 'kJ', ...
        source_name     TEXT,             -- 'SnapCalorie', 'Cronometer', 'Apple Watch', NULL allowed
        imported_at     TEXT NOT NULL,    -- server's UTC timestamp at insert
        raw             TEXT,             -- raw per-sample JSON, for losslessness
        UNIQUE(sample_type, start_time, source_name, value)
      );
      CREATE INDEX IF NOT EXISTS idx_health_samples_type_time ON health_samples(sample_type, start_time);
      CREATE INDEX IF NOT EXISTS idx_health_samples_imported  ON health_samples(imported_at);
    `,
  },
  {
    version: 8,
    name: 'v0.8: external_workouts (HealthKit workout records)',
    sql: `
      -- HealthKit HKWorkout records, which the Oura API does NOT return for
      -- live-tracked sessions. One row per source record, stored verbatim —
      -- dedupe happens at READ time, never here. The rules (and why) live in
      -- the wiki page "HealthKit workouts — how to count them exactly once".
      --
      -- Key facts encoded by this shape:
      --   * the same session legitimately appears several times (typed row,
      --     live-activity wrapper, plus any third-party app), so there is no
      --     UNIQUE constraint across sources;
      --   * activity_type 'Other' is NOT a duplicate marker — it's what Oura
      --     writes for anything Apple has no type for (e.g. stretching);
      --   * an unstopped live activity can span >24h, so duration is not
      --     trustworthy on its own.
      CREATE TABLE IF NOT EXISTS external_workouts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        source          TEXT NOT NULL,    -- 'apple_health' (future: other bridges)
        source_name     TEXT NOT NULL,    -- writing app: 'Oura', a lifting tracker, ...
        activity_type   TEXT NOT NULL,    -- HK type minus prefix: 'TraditionalStrengthTraining', 'Other', ...
        start_time      TEXT NOT NULL,    -- ISO 8601 with offset
        end_time        TEXT NOT NULL,
        duration_min    REAL,             -- as reported; sanity-check before use
        energy_kcal     REAL,
        distance_km     REAL,
        avg_heart_rate  REAL,             -- present on phone-recorded wrapper rows
        device          TEXT,             -- HKDevice string; non-null ⇒ phone-recorded
        created_at      TEXT,             -- HK creationDate (when the app wrote it)
        imported_at     TEXT NOT NULL,
        raw             TEXT,             -- full attribute set, for losslessness
        UNIQUE(source_name, start_time, end_time, activity_type)
      );
      CREATE INDEX IF NOT EXISTS idx_external_workouts_start  ON external_workouts(start_time);
      CREATE INDEX IF NOT EXISTS idx_external_workouts_source ON external_workouts(source_name, start_time);
    `,
  },
  {
    version: 9,
    name: 'v0.8: resolved_sessions (materialised dedupe output)',
    sql: `
      -- Derived cache, NOT a source of truth: the output of resolveSessions()
      -- over 'workouts' + 'external_workouts'. Rebuilt wholesale by
      -- \`npm run resolve-sessions\`, so it can be dropped and regenerated.
      --
      -- It exists because SQL can't express the dedupe (transitive overlap
      -- clustering with source precedence), and consumers that speak only SQL
      -- would otherwise count the same session several times.
      CREATE TABLE IF NOT EXISTS resolved_sessions (
        start_time      TEXT NOT NULL,
        end_time        TEXT NOT NULL,
        day             TEXT NOT NULL,    -- local calendar day of start_time
        activity        TEXT NOT NULL,    -- canonical: 'strength_training', 'walking', ...
        is_resistance   INTEGER NOT NULL, -- 0/1, so SQL can SUM() it
        duration_min    REAL,
        energy_kcal     REAL,
        avg_heart_rate  REAL,
        source          TEXT NOT NULL,    -- winning record, e.g. 'apple_health:Oura'
        member_count    INTEGER NOT NULL, -- source records collapsed into this session
        resolved_at     TEXT NOT NULL,
        PRIMARY KEY (start_time, activity)
      );
      CREATE INDEX IF NOT EXISTS idx_resolved_sessions_day ON resolved_sessions(day);
      CREATE INDEX IF NOT EXISTS idx_resolved_sessions_res ON resolved_sessions(is_resistance, day);
    `,
  },
  {
    version: 10,
    name: 'v0.8: external_workouts.external_id (HealthKit UUID)',
    sql: `
      -- HealthKit gives every sample a stable UUID. iOS Shortcuts drops it,
      -- which is why the original dedupe key was (source_name, start, end,
      -- type) — a heuristic that breaks if an app edits a workout's times.
      -- A native reader can send the UUID, making re-import dedupe exact.
      ALTER TABLE external_workouts ADD COLUMN external_id TEXT;

      -- Partial index: rows imported from an export (no UUID) still collide
      -- on the older heuristic key, which stays in force alongside this one.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_workouts_uuid
        ON external_workouts(source_name, external_id)
        WHERE external_id IS NOT NULL;
    `,
  },
  {
    version: 11,
    name: 'v0.8: dedupe workouts by instant, not by timestamp text',
    sql: `
      -- The original key compared ISO strings, which silently failed across
      -- UTC offsets: Apple's export stamps every record with the offset in
      -- force on export day (e.g. +02:00 for a January workout), while a
      -- native reader uses the offset that actually applied then (+01:00).
      -- Same instant, different text, so 327 rows imported twice.
      --
      -- Epoch seconds are offset-free, so this compares what the times mean
      -- rather than how they were written. The columns are maintained by the
      -- repo rather than GENERATED, because SQLite won't index date/time
      -- functions (it can't prove they're deterministic).
      ALTER TABLE external_workouts ADD COLUMN start_epoch INTEGER;
      ALTER TABLE external_workouts ADD COLUMN end_epoch INTEGER;

      UPDATE external_workouts
         SET start_epoch = CAST(strftime('%s', start_time) AS INTEGER),
             end_epoch   = CAST(strftime('%s', end_time) AS INTEGER);

      -- Collapse the rows that got in before the fix, keeping the copy that
      -- carries a HealthKit UUID (exact identity for future syncs) and
      -- otherwise the one imported first.
      DELETE FROM external_workouts
       WHERE id NOT IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (
             PARTITION BY source_name, activity_type, start_epoch, end_epoch
             ORDER BY (external_id IS NULL), id
           ) AS rn
           FROM external_workouts
         )
         WHERE rn = 1
       );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_workouts_instant
        ON external_workouts(source_name, activity_type, start_epoch, end_epoch);
    `,
  },
  {
    version: 12,
    name: 'v0.8: store percentages as percentage points',
    sql: `
      -- HealthKit's percent unit is a FRACTION: 25% body fat arrives as 0.25.
      -- Stored verbatim next to unit '%', it reads as "0.25 %" — a trap for
      -- anything querying this table, and body fat is now a tracked goal.
      -- Percentage points are what every consumer means by '%'.
      --
      -- Guarded on value <= 1 so it can't double-apply: no human body
      -- composition reading is legitimately below 1%.
      --
      -- Duplicates must go first. The UNIQUE key includes value, a REAL,
      -- so float noise defeats it: the export parsed "0.246" to exactly
      -- 0.246 while the app sent 0.246000000000000002, and both were stored.
      -- Rounding makes them equal, which would break this UPDATE, so the
      -- older copy of each pair is dropped before rescaling.
      DELETE FROM health_samples
       WHERE sample_type LIKE '%_percentage'
         AND id NOT IN (
           SELECT MIN(id) FROM health_samples
            WHERE sample_type LIKE '%_percentage'
            GROUP BY sample_type, start_time, source_name,
                     ROUND(CASE WHEN value <= 1.0 THEN value * 100.0 ELSE value END, 2)
         );

      UPDATE health_samples
         SET value = ROUND(value * 100.0, 2)
       WHERE sample_type LIKE '%_percentage'
         AND value <= 1.0;
    `,
  },
  {
    version: 13,
    name: 'v0.8.1: health_samples integrity — units, instants, local days',
    sql: `
      -- Three defects, one table, all invisible to anything reading it.
      --
      -- 1. MIXED UNITS. Dietary energy arrived as both kcal and J, sodium and
      --    cholesterol as both mg and g. SUM(value) mixed them silently: one
      --    day read as 6,682,560 "kcal". Verified before converting — all 31
      --    joule rows had a kcal twin at the same instant, and value/4184
      --    matched it exactly.
      -- 2. DUPLICATE INSTANTS. The UNIQUE key compares start_time as TEXT, so
      --    the same moment written with different UTC offsets (Shortcut at
      --    +01:00 in Oxford, export re-stamped at +02:00 in Vienna) was stored
      --    twice. June intake was inflated up to 3x. Same class of bug as
      --    migration 11 fixed for external_workouts.
      -- 3. WRONG DAY. Consumers group by date(start_time), which converts to
      --    UTC first, so a 00:30 meal lands on the previous day and the
      --    boundary moves with DST. local_day is the day the source asserted.
      --
      -- ORDER MATTERS: duplicates are collapsed BEFORE units are converted.
      -- Converting first makes a joule row equal its kcal twin and the
      -- pre-existing UNIQUE(sample_type, start_time, source_name, value)
      -- rejects the UPDATE. So the comparison below converts inline instead.

      ALTER TABLE health_samples ADD COLUMN start_epoch INTEGER;
      ALTER TABLE health_samples ADD COLUMN end_epoch INTEGER;
      ALTER TABLE health_samples ADD COLUMN local_day TEXT;
      ALTER TABLE health_samples ADD COLUMN local_time TEXT;

      UPDATE health_samples
         SET start_epoch = CAST(strftime('%s', start_time) AS INTEGER),
             end_epoch   = CAST(strftime('%s', end_time) AS INTEGER),
             -- The literal local date the source wrote, NOT date(start_time):
             -- the latter converts to UTC and moves the boundary.
             local_day   = substr(start_time, 1, 10),
             local_time  = substr(start_time, 12, 8);

      -- Collapse duplicates, comparing canonical values at one decimal. The
      -- key is already one sample type from one source at one instant, so two
      -- readings that close are the same reading; distinct items logged in the
      -- same second differ by far more (3.4, 205.4 and 300 kcal at 18:20 on
      -- one observed day). Rounding to one decimal also absorbs conversion
      -- drift: 1969859.4 J becomes 470.81 kcal where its twin says 470.8.
      DELETE FROM health_samples
       WHERE id NOT IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (
             PARTITION BY sample_type, source_name, start_epoch,
               ROUND(CASE
                 WHEN sample_type = 'dietary_energy_consumed' AND unit = 'J'  THEN value / 4184.0
                 WHEN sample_type = 'dietary_energy_consumed' AND unit = 'kJ' THEN value / 4.184
                 WHEN sample_type IN ('dietary_sodium', 'dietary_potassium', 'dietary_cholesterol')
                      AND unit = 'g' THEN value * 1000.0
                 WHEN sample_type = 'dietary_water' AND unit = 'L' THEN value * 1000.0
                 ELSE value END, 1)
             -- Keep the row already in the canonical unit; then the earliest.
             ORDER BY CASE
               WHEN unit IN ('J', 'kJ') THEN 1
               WHEN sample_type IN ('dietary_sodium', 'dietary_potassium', 'dietary_cholesterol')
                    AND unit = 'g' THEN 1
               WHEN sample_type = 'dietary_water' AND unit = 'L' THEN 1
               ELSE 0 END, id
           ) AS rn
           FROM health_samples
         )
         WHERE rn = 1
       );

      -- Now convert whatever rogue-unit rows had no canonical twin.
      UPDATE health_samples
         SET value = ROUND(value / 4184.0, 2), unit = 'kcal'
       WHERE sample_type = 'dietary_energy_consumed' AND unit = 'J';
      UPDATE health_samples
         SET value = ROUND(value / 4.184, 2), unit = 'kcal'
       WHERE sample_type = 'dietary_energy_consumed' AND unit = 'kJ';
      UPDATE health_samples
         SET value = ROUND(value * 1000.0, 2), unit = 'mg'
       WHERE sample_type IN ('dietary_sodium', 'dietary_potassium', 'dietary_cholesterol')
         AND unit = 'g';
      UPDATE health_samples
         SET value = ROUND(value * 1000.0, 2), unit = 'mL'
       WHERE sample_type = 'dietary_water' AND unit = 'L';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_health_samples_instant
        ON health_samples(sample_type, source_name, start_epoch, ROUND(value, 1));
      CREATE INDEX IF NOT EXISTS idx_health_samples_local_day
        ON health_samples(sample_type, local_day);
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
