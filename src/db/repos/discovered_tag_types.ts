/**
 * Discovered Oura tag_type_codes — populated by every enhanced_tag sync.
 *
 * Annotation validation now accepts any code that's EITHER in the static
 * KNOWN_TAG_TYPE_CODES list (from src/db/tag_types.ts) OR in this table.
 * The static list is a bootstrap; this table is empirical truth.
 */

import type { Db } from '../index.js';

export interface DiscoveredTagType {
  code: string;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class DiscoveredTagTypesRepo {
  constructor(private readonly db: Db) {}

  /**
   * Record one observation. If the code is new, insert with count=1.
   * Otherwise increment count and refresh last_seen_at.
   * Returns true when the code was newly discovered (first time seen).
   */
  observe(code: string): boolean {
    const existing = this.db
      .prepare<unknown[], { code: string }>('SELECT code FROM discovered_tag_types WHERE code = ?')
      .get(code);
    const now = nowIso();
    if (existing) {
      this.db
        .prepare(
          `UPDATE discovered_tag_types
              SET last_seen_at = ?, occurrence_count = occurrence_count + 1
            WHERE code = ?`,
        )
        .run(now, code);
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO discovered_tag_types (code, first_seen_at, last_seen_at, occurrence_count)
         VALUES (?, ?, ?, 1)`,
      )
      .run(code, now, now);
    return true;
  }

  /**
   * Bulk-observe all codes in a list. Returns the set of codes that were
   * newly discovered on this call (so the sync script can print them).
   */
  observeMany(codes: string[]): string[] {
    const newly: string[] = [];
    const tx = this.db.transaction((cs: string[]) => {
      for (const c of cs) {
        if (this.observe(c)) newly.push(c);
      }
    });
    tx(codes);
    return newly;
  }

  has(code: string): boolean {
    const row = this.db
      .prepare<unknown[], { code: string }>('SELECT code FROM discovered_tag_types WHERE code = ?')
      .get(code);
    return !!row;
  }

  list(): DiscoveredTagType[] {
    return this.db
      .prepare<
        unknown[],
        DiscoveredTagType
      >('SELECT * FROM discovered_tag_types ORDER BY occurrence_count DESC, code ASC')
      .all();
  }
}
