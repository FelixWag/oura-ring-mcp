/**
 * In-memory request dedupe for the voice endpoint.
 *
 * Siri Shortcuts occasionally retry on flaky network and we don't want
 * the same dictation to land in the database twice. This module hashes
 * `(text + captured_at)` and rejects any duplicate within a sliding TTL.
 *
 * In-memory is fine: a Mac mini restart loses the dedupe state, but that
 * also coincides with the server restarting, so any retry after a restart
 * is genuinely a new request. No DB-backed dedupe needed for v0.6.
 */

import { createHash } from 'node:crypto';

const DEFAULT_TTL_MS = 60 * 1000;

export interface DedupeOptions {
  ttlMs?: number;
  /** Override for tests. */
  now?: () => number;
}

export interface DedupeCheck {
  /** True if this is a duplicate of a recent request still within the TTL. */
  duplicate: boolean;
  /** Stable hash for the (text, captured_at) tuple. Logged so we can correlate. */
  hash: string;
}

export class Deduper {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: DedupeOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Compute the hash for (text, captured_at). If we've seen this hash
   * within the TTL, return `{ duplicate: true }`. Otherwise record it and
   * return `{ duplicate: false }`.
   *
   * Idempotent on repeated check() calls — once recorded, subsequent
   * checks within the TTL all see it as a duplicate.
   */
  check(text: string, captured_at: string): DedupeCheck {
    const hash = createHash('sha256').update(text).update('|').update(captured_at).digest('hex');
    const now = this.now();
    this.evictExpired(now);

    const existing = this.seen.get(hash);
    if (existing !== undefined && existing + this.ttlMs > now) {
      return { duplicate: true, hash };
    }
    this.seen.set(hash, now);
    return { duplicate: false, hash };
  }

  /** Visible for tests. */
  size(): number {
    return this.seen.size;
  }

  private evictExpired(now: number): void {
    // Cheap O(n) sweep — `seen` stays small for personal use, never more
    // than a few hundred entries even at high voice-note rates.
    for (const [hash, ts] of this.seen) {
      if (ts + this.ttlMs <= now) this.seen.delete(hash);
    }
  }
}
