import Database from 'better-sqlite3';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { applyMigrations } from './schema.js';

export type Db = Database.Database;

/**
 * Open the SQLite database at `path`, ensuring the parent directory exists,
 * applying any pending schema migrations, and tightening file permissions
 * (0600 — same posture as the OAuth token file).
 *
 * Pass ":memory:" for tests. In-memory DBs skip the chmod/mkdir steps.
 */
export async function openDatabase(path: string): Promise<Db> {
  const isMemory = path === ':memory:';
  if (!isMemory) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  }

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);

  if (!isMemory) {
    // Defensive: don't leave the DB world-readable. Failing chmod is non-fatal
    // (e.g. on a filesystem that doesn't support POSIX perms).
    await chmod(path, 0o600).catch(() => {});
  }
  return db;
}
