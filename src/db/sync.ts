/**
 * Sync orchestrator: pulls Oura collections into the local SQLite database.
 *
 * Behavior:
 *   - For each collection, picks a `from_date` based on the most recent local
 *     row, minus a re-fetch window (default 7 days) to handle Oura's
 *     same-day re-scoring. First-time runs default to ~30 days back.
 *   - Issues paginated API requests via the existing OuraClient (the
 *     existing 401 / 429 retry behavior keeps things robust).
 *   - Upserts rows into the appropriate repo, tracking a per-run audit log.
 *   - Concurrent across collections, sequential within a collection.
 *
 * Out of scope (per v0.4 plan):
 *   - heartrate timeseries (too high-volume; on-demand via MCP tool)
 *   - personal_info (rarely changes; on-demand)
 */

import { AnnotationRepo } from './annotations.js';
import { ENDPOINTS } from '../oura/endpoints.js';
import type { OuraClient } from '../oura/client.js';
import type { Db } from './index.js';
import { DailyCollectionRepo, type DailyTable } from './repos/daily.js';
import { DiscoveredTagTypesRepo } from './repos/discovered_tag_types.js';
import { EventCollectionRepo, type EventTable } from './repos/events.js';
import { SyncRunsRepo, type SyncCollection } from './repos/sync_runs.js';

export const RECENT_REFETCH_DAYS_DEFAULT = 7;
export const FIRST_RUN_LOOKBACK_DAYS_DEFAULT = 30;
const MAX_RANGE_DAYS = 90; // Oura caps a single request at 90 days; we page if needed.

export interface SyncOptions {
  /** Force-refetch the last N days (regardless of stored state). Mutually exclusive with `full`. */
  since_days?: number;
  /** Re-fetch every collection from `firstRunLookbackDays` days back to today. */
  full?: boolean;
  /** Only sync the `enhanced_tag` collection and refresh discovered tag codes. */
  tags_only?: boolean;
  /** Override the default 7-day window applied to incremental syncs. */
  recentRefetchDays?: number;
  /** Override the default 30-day lookback used on a first run with no local data. */
  firstRunLookbackDays?: number;
  /** Override `today` for testability. */
  todayUtc?: string;
}

export interface CollectionResult {
  collection: SyncCollection;
  ok: boolean;
  rows_upserted: number;
  from_date: string;
  to_date: string;
  error?: string;
  newly_discovered_tag_codes?: string[]; // only set for enhanced_tag
}

export interface SyncResult {
  ran_at: string;
  collections: CollectionResult[];
}

export interface SyncDeps {
  client: OuraClient;
  db: Db;
}

function todayUtcString(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(from: string, days: number): string {
  const t = Date.parse(from + 'T00:00:00Z');
  return new Date(t + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

interface FromTo {
  from_date: string;
  to_date: string;
}

/**
 * Compute the date window for a collection sync.
 *
 *   - `full`: from `today - firstRunLookbackDays` to today.
 *   - `since_days`: from `today - since_days` to today.
 *   - default (incremental):
 *       from = max(maxLocalDay - recentRefetchDays + 1, today - firstRunLookbackDays)
 *       to   = today
 *     If the table is empty: from = today - firstRunLookbackDays.
 *
 * Caps `to - from <= MAX_RANGE_DAYS`. If the user wants more history, the
 * underlying client paginates; for sync orchestration we keep things simple
 * and rely on the next run to extend the window further if needed.
 */
export function computeWindow(
  options: Pick<
    SyncOptions,
    'since_days' | 'full' | 'recentRefetchDays' | 'firstRunLookbackDays' | 'todayUtc'
  >,
  maxLocalDay: string | null,
): FromTo {
  const today = options.todayUtc ?? todayUtcString();
  const firstRun = options.firstRunLookbackDays ?? FIRST_RUN_LOOKBACK_DAYS_DEFAULT;
  const refetch = options.recentRefetchDays ?? RECENT_REFETCH_DAYS_DEFAULT;

  let from_date: string;
  if (options.full) {
    from_date = shiftDate(today, -firstRun);
  } else if (typeof options.since_days === 'number') {
    from_date = shiftDate(today, -options.since_days);
  } else if (!maxLocalDay) {
    from_date = shiftDate(today, -firstRun);
  } else {
    const incremental = shiftDate(maxLocalDay, -(refetch - 1));
    const fallback = shiftDate(today, -firstRun);
    from_date = incremental > fallback ? incremental : fallback;
  }

  // Cap window to MAX_RANGE_DAYS — if larger is needed, run sync repeatedly
  // (in v0.5 we'll add chunked syncing).
  const tStart = Date.parse(from_date + 'T00:00:00Z');
  const tEnd = Date.parse(today + 'T00:00:00Z');
  const days = (tEnd - tStart) / (1000 * 60 * 60 * 24);
  if (days > MAX_RANGE_DAYS) {
    from_date = shiftDate(today, -MAX_RANGE_DAYS);
  }

  return { from_date, to_date: today };
}

const DAILY_PLAN: Array<{ collection: SyncCollection; table: DailyTable; path: string }> = [
  { collection: 'daily_sleep', table: 'daily_sleep', path: ENDPOINTS.dailySleep },
  { collection: 'daily_readiness', table: 'daily_readiness', path: ENDPOINTS.dailyReadiness },
  { collection: 'daily_activity', table: 'daily_activity', path: ENDPOINTS.dailyActivity },
  { collection: 'daily_spo2', table: 'daily_spo2', path: ENDPOINTS.spo2 },
];

const EVENT_PLAN: Array<{ collection: SyncCollection; table: EventTable; path: string }> = [
  { collection: 'sleep_periods', table: 'sleep_periods', path: ENDPOINTS.sleep },
  { collection: 'workouts', table: 'workouts', path: ENDPOINTS.workout },
  { collection: 'sessions', table: 'sessions', path: ENDPOINTS.session },
];

async function syncDaily(
  deps: SyncDeps,
  options: SyncOptions,
  collection: SyncCollection,
  table: DailyTable,
  path: string,
): Promise<CollectionResult> {
  const repo = new DailyCollectionRepo(deps.db, table);
  const runs = new SyncRunsRepo(deps.db);
  const window = computeWindow(options, repo.maxDay());
  const runId = runs.start(collection, window.from_date, window.to_date);
  try {
    const r = await deps.client.getCollection<unknown>(path, {
      start_date: window.from_date,
      end_date: window.to_date,
    });
    const result = repo.upsertMany(r.data);
    const total = result.inserted + result.updated;
    runs.finishOk(runId, total);
    return { collection, ok: true, rows_upserted: total, ...window };
  } catch (err) {
    const msg = (err as Error).message;
    runs.finishError(runId, msg);
    return { collection, ok: false, rows_upserted: 0, error: msg, ...window };
  }
}

async function syncEvents(
  deps: SyncDeps,
  options: SyncOptions,
  collection: SyncCollection,
  table: EventTable,
  path: string,
): Promise<CollectionResult> {
  const repo = new EventCollectionRepo(deps.db, table);
  const runs = new SyncRunsRepo(deps.db);
  const window = computeWindow(options, repo.maxDay());
  const runId = runs.start(collection, window.from_date, window.to_date);
  try {
    const r = await deps.client.getCollection<unknown>(path, {
      start_date: window.from_date,
      end_date: window.to_date,
    });
    const result = repo.upsertMany(r.data);
    const total = result.inserted + result.updated;
    runs.finishOk(runId, total);
    return { collection, ok: true, rows_upserted: total, ...window };
  } catch (err) {
    const msg = (err as Error).message;
    runs.finishError(runId, msg);
    return { collection, ok: false, rows_upserted: 0, error: msg, ...window };
  }
}

interface OuraEnhancedTagRow {
  id?: string;
  tag_type_code?: string | null;
  custom_name?: string | null;
  start_time?: string;
  end_time?: string | null;
  start_day?: string;
  end_day?: string | null;
  comment?: string | null;
}

async function syncEnhancedTags(deps: SyncDeps, options: SyncOptions): Promise<CollectionResult> {
  const annotations = new AnnotationRepo(deps.db);
  const runs = new SyncRunsRepo(deps.db);
  const discovered = new DiscoveredTagTypesRepo(deps.db);

  // Find the latest start_day among source='oura' rows in the annotations table.
  const maxRow = deps.db
    .prepare<
      unknown[],
      { day: string | null }
    >("SELECT MAX(start_day) AS day FROM annotations WHERE source = 'oura'")
    .get();
  const window = computeWindow(options, maxRow?.day ?? null);
  const runId = runs.start('enhanced_tag', window.from_date, window.to_date);

  try {
    const r = await deps.client.getCollection<OuraEnhancedTagRow>(ENDPOINTS.enhancedTag, {
      start_date: window.from_date,
      end_date: window.to_date,
    });

    // Track every tag_type_code we see (including null/'custom') so the
    // discovered_tag_types table reflects reality. Skip null because it's not
    // a code; skip 'custom' because it's already a special-case literal.
    const codes = r.data
      .map((row) => row.tag_type_code)
      .filter((c): c is string => typeof c === 'string' && c !== 'custom');
    const newly = discovered.observeMany(codes);

    // Upsert each Oura tag into the annotations table with source='oura'.
    let upserted = 0;
    const tx = deps.db.transaction((rows: OuraEnhancedTagRow[]) => {
      const upd = deps.db.prepare(
        `UPDATE annotations
            SET tag_type_code = @tag_type_code,
                custom_name   = @custom_name,
                start_time    = @start_time,
                end_time      = @end_time,
                start_day     = @start_day,
                end_day       = @end_day,
                comment       = @comment,
                updated_at    = @now
          WHERE oura_id = @oura_id`,
      );
      const ins = deps.db.prepare(
        `INSERT INTO annotations
           (tag_type_code, custom_name, start_time, end_time, start_day, end_day,
            comment, source, oura_id, created_at, updated_at)
         VALUES
           (@tag_type_code, @custom_name, @start_time, @end_time, @start_day, @end_day,
            @comment, 'oura', @oura_id, @now, @now)`,
      );
      const now = new Date().toISOString();
      for (const row of rows) {
        if (!row.id || !row.start_time || !row.start_day) continue;
        const params = {
          tag_type_code: row.tag_type_code ?? null,
          custom_name: row.custom_name ?? null,
          start_time: row.start_time,
          end_time: row.end_time ?? null,
          start_day: row.start_day,
          end_day: row.end_day ?? null,
          comment: row.comment ?? null,
          oura_id: row.id,
          now,
        };
        const info = upd.run(params);
        if (info.changes === 0) ins.run(params);
        upserted += 1;
      }
    });
    tx(r.data);

    runs.finishOk(runId, upserted);
    return {
      collection: 'enhanced_tag',
      ok: true,
      rows_upserted: upserted,
      newly_discovered_tag_codes: newly,
      ...window,
    };
  } catch (err) {
    const msg = (err as Error).message;
    runs.finishError(runId, msg);
    return {
      collection: 'enhanced_tag',
      ok: false,
      rows_upserted: 0,
      error: msg,
      ...window,
    };
  }
}

export async function runSync(deps: SyncDeps, options: SyncOptions = {}): Promise<SyncResult> {
  const ran_at = new Date().toISOString();

  // Tag-only mode: just enhanced_tag.
  if (options.tags_only) {
    const result = await syncEnhancedTags(deps, options);
    return { ran_at, collections: [result] };
  }

  const dailyPromises = DAILY_PLAN.map((p) =>
    syncDaily(deps, options, p.collection, p.table, p.path),
  );
  const eventPromises = EVENT_PLAN.map((p) =>
    syncEvents(deps, options, p.collection, p.table, p.path),
  );
  const tagPromise = syncEnhancedTags(deps, options);

  const collections = await Promise.all([...dailyPromises, ...eventPromises, tagPromise]);
  return { ran_at, collections };
}
