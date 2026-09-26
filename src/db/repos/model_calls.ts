/**
 * Repository for the `model_calls` table: one row per model invocation.
 *
 * A row is started when the call begins and finished exactly once, in the
 * same transaction as whatever the call wrote — so an accepted estimate and
 * the record of the call that produced it commit together or not at all. A
 * row left with `outcome` NULL is a process that died mid-call.
 *
 * `raw_response` keeps what the model said, failures included; it never goes
 * to the log, which gets only the id, purpose and outcome.
 */

import type { Db } from '../index.js';

export type ModelCallPurpose = 'route' | 'extract_photo' | 'extract_text' | 'correct';
export type ModelCallOutcome = 'ok' | 'not_food' | 'mismatch' | 'ambiguous' | 'invalid' | 'failed';

export interface StartModelCall {
  purpose: ModelCallPurpose;
  telegram_update_id?: number | null;
  meal_id?: number | null;
  model: string;
  prompt_version: string;
  /** Ids shown to the model, never text. */
  context?: unknown;
}

export interface FinishModelCall {
  outcome: ModelCallOutcome;
  meal_id?: number | null;
  extraction_id?: number | null;
  decision?: string | null;
  raw_response?: string | null;
  error?: string | null;
  usage?: unknown;
  cost_usd?: number | null;
  duration_ms?: number | null;
}

export interface ModelCallRow {
  id: number;
  purpose: ModelCallPurpose;
  telegram_update_id: number | null;
  meal_id: number | null;
  extraction_id: number | null;
  model: string;
  prompt_version: string;
  started_epoch: number;
  duration_ms: number | null;
  outcome: ModelCallOutcome | null;
  decision: string | null;
  context: string | null;
  raw_response: string | null;
  error: string | null;
  usage: string | null;
  cost_usd: number | null;
}

export class ModelCallsRepo {
  constructor(private readonly db: Db) {}

  start(call: StartModelCall): number {
    const info = this.db
      .prepare(
        `INSERT INTO model_calls
           (purpose, telegram_update_id, meal_id, model, prompt_version, started_epoch, context)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        call.purpose,
        call.telegram_update_id ?? null,
        call.meal_id ?? null,
        call.model,
        call.prompt_version,
        Math.floor(Date.now() / 1000),
        call.context === undefined ? null : JSON.stringify(call.context),
      );
    return Number(info.lastInsertRowid);
  }

  /**
   * Record how the call ended. Only an unfinished row is updated, so a call
   * cannot be finished twice with different stories.
   */
  finish(id: number, result: FinishModelCall): void {
    const info = this.db
      .prepare(
        `UPDATE model_calls
            SET outcome = ?, meal_id = COALESCE(?, meal_id), extraction_id = ?, decision = ?,
                raw_response = ?, error = ?, usage = ?, cost_usd = ?, duration_ms = ?
          WHERE id = ? AND outcome IS NULL`,
      )
      .run(
        result.outcome,
        result.meal_id ?? null,
        result.extraction_id ?? null,
        result.decision ?? null,
        result.raw_response ?? null,
        result.error === undefined || result.error === null ? null : result.error.slice(0, 1000),
        result.usage === undefined ? null : JSON.stringify(result.usage),
        result.cost_usd ?? null,
        result.duration_ms ?? null,
        id,
      );
    if (info.changes !== 1) throw new Error(`model call ${id} is unknown or already finished`);
  }

  /**
   * Calls of these purposes started in the last `withinHours`. Unfinished
   * calls count: a call in flight is spending.
   */
  countSince(purposes: readonly ModelCallPurpose[], withinHours: number): number {
    const since = Math.floor(Date.now() / 1000) - withinHours * 3600;
    const placeholders = purposes.map(() => '?').join(', ');
    const row = this.db
      .prepare<
        unknown[],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM model_calls WHERE purpose IN (${placeholders}) AND started_epoch >= ?`)
      .get(...purposes, since);
    return row?.n ?? 0;
  }

  get(id: number): ModelCallRow | undefined {
    return this.db
      .prepare<[number], ModelCallRow>('SELECT * FROM model_calls WHERE id = ?')
      .get(id);
  }
}
