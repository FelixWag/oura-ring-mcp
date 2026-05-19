/**
 * Repository for the `voice_logs` table.
 *
 * One row per POST to /v1/log. Stores the raw dictation plus metadata
 * about the resulting agent run (success/failure, count of annotations
 * extracted, duration). Annotations created during the run link back
 * via the `annotations.voice_log_id` foreign key.
 */

import type { Db } from '../index.js';

export type VoiceSource = 'siri' | string; // open string — future sources welcome

export interface VoiceLogRow {
  id: number;
  raw_text: string;
  source: VoiceSource;
  captured_at: string;
  timezone: string | null;
  received_at: string;
  finished_at: string | null;
  ok: 0 | 1 | null;
  error: string | null;
  annotation_count: number | null;
  claude_summary: string | null;
  duration_ms: number | null;
}

export interface NewVoiceLog {
  raw_text: string;
  source: VoiceSource;
  captured_at: string;
  timezone?: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class VoiceLogsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Create the initial "in progress" row. Returns its id so the server can
   * later mark it ok / error and attach extracted annotations to it.
   */
  start(input: NewVoiceLog): number {
    const info = this.db
      .prepare(
        `INSERT INTO voice_logs (raw_text, source, captured_at, timezone, received_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.raw_text, input.source, input.captured_at, input.timezone ?? null, nowIso());
    return Number(info.lastInsertRowid);
  }

  /**
   * Mark a voice-log run successful.
   */
  finishOk(
    id: number,
    annotation_count: number,
    claude_summary: string,
    duration_ms: number,
  ): void {
    this.db
      .prepare(
        `UPDATE voice_logs
            SET ok = 1, finished_at = ?, annotation_count = ?, claude_summary = ?, duration_ms = ?
          WHERE id = ?`,
      )
      .run(nowIso(), annotation_count, claude_summary, duration_ms, id);
  }

  /**
   * Mark a voice-log run failed. Error string is truncated to 1000 chars.
   */
  finishError(id: number, error: string, duration_ms: number): void {
    this.db
      .prepare(
        `UPDATE voice_logs
            SET ok = 0, finished_at = ?, error = ?, duration_ms = ?
          WHERE id = ?`,
      )
      .run(nowIso(), error.slice(0, 1000), duration_ms, id);
  }

  get(id: number): VoiceLogRow | null {
    const row = this.db
      .prepare<unknown[], VoiceLogRow>('SELECT * FROM voice_logs WHERE id = ?')
      .get(id);
    return row ?? null;
  }

  /** Most recent N entries, newest first. */
  recent(limit = 20): VoiceLogRow[] {
    return this.db
      .prepare<unknown[], VoiceLogRow>('SELECT * FROM voice_logs ORDER BY id DESC LIMIT ?')
      .all(limit);
  }
}
