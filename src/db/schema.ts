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
