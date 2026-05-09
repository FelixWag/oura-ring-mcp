import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  AnnotationValidationError,
  type Annotation,
  type AnnotationRepo,
} from '../db/annotations.js';
import { acceptedTagTypeCodes } from '../db/tag_types.js';
import type { OuraClient } from '../oura/client.js';
import {
  comparePeriods,
  linearSlope,
  periodAverages,
  rollingMean,
  trendFromSlope,
} from '../oura/derive.js';
import { ENDPOINTS } from '../oura/endpoints.js';
import {
  mergeDays,
  shapeDailyActivity,
  shapeDailyReadiness,
  shapeDailySleep,
  shapeSleep,
} from '../oura/shape.js';
import { shapeEnhancedTag } from '../oura/tags.js';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 90;

const dateSchema = z.string().regex(DATE_REGEX, 'Date must be in YYYY-MM-DD format');

const datetimeSchema = z
  .string()
  .refine(
    (v) => !Number.isNaN(Date.parse(v)),
    'Datetime must be ISO 8601 (e.g. 2026-01-15T08:30:00Z)',
  );

const verboseSchema = z
  .boolean()
  .optional()
  .describe(
    'When true, returns the raw API rows (large; can blow past response limits). ' +
      'Default false returns compact records — scores, key contributors, and counts.',
  );

const includeAnnotationsSchema = z
  .boolean()
  .optional()
  .describe(
    'When true (default), each day record gains an `annotations` array of locally-stored ' +
      'context entries (and any synced Oura enhanced_tags) overlapping that date. ' +
      'Pass false to skip the local-DB join entirely.',
  );

function diffDays(start: string, end: string): number {
  const a = Date.parse(start + 'T00:00:00Z');
  const b = Date.parse(end + 'T00:00:00Z');
  return (b - a) / (1000 * 60 * 60 * 24);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(from: string, days: number): string {
  const t = Date.parse(from + 'T00:00:00Z');
  const shifted = new Date(t + days * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function validateDateRange(start: string, end: string): string | null {
  const days = diffDays(start, end);
  if (Number.isNaN(days)) return 'Invalid dates.';
  if (days < 0) return 'end_date must be on or after start_date.';
  if (days > MAX_RANGE_DAYS) {
    return `Date range too large (${days} days). Maximum is ${MAX_RANGE_DAYS} days. Make multiple smaller requests.`;
  }
  if (Date.parse(start + 'T00:00:00Z') > Date.parse(todayUtc() + 'T00:00:00Z')) {
    return 'start_date cannot be in the future.';
  }
  return null;
}

function validateDatetimeRange(start: string, end: string): string | null {
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return 'Invalid datetimes.';
  if (b < a) return 'end_datetime must be on or after start_datetime.';
  const days = (b - a) / (1000 * 60 * 60 * 24);
  if (days > MAX_RANGE_DAYS) {
    return `Datetime range too large (${days.toFixed(1)} days). Maximum is ${MAX_RANGE_DAYS} days.`;
  }
  if (a > Date.now()) return 'start_datetime cannot be in the future.';
  return null;
}

function textResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

async function handle<T>(fn: () => Promise<T>) {
  try {
    return textResult(await fn());
  } catch (err) {
    const e = err as Error;
    return errorResult(`${e.name ?? 'Error'}: ${e.message}`);
  }
}

async function fetchCompactDays(
  client: OuraClient,
  start_date: string,
  end_date: string,
): Promise<{ days: ReturnType<typeof mergeDays>; truncated: boolean }> {
  const q = { start_date, end_date };
  const [sleep, readiness, activity] = await Promise.all([
    client.getCollection<unknown>(ENDPOINTS.dailySleep, q),
    client.getCollection<unknown>(ENDPOINTS.dailyReadiness, q),
    client.getCollection<unknown>(ENDPOINTS.dailyActivity, q),
  ]);
  const days = mergeDays(
    sleep.data.map(shapeDailySleep),
    readiness.data.map(shapeDailyReadiness),
    activity.data.map(shapeDailyActivity),
  );
  return { days, truncated: sleep.truncated || readiness.truncated || activity.truncated };
}

/**
 * Group annotations by their `start_day`. Multi-day annotations (with end_day)
 * are emitted under start_day only — the LLM can reason about the span from
 * the row itself. Keeping it simple here avoids cross-day duplication.
 */
function annotationsByDay(rows: Annotation[]): Map<string, Annotation[]> {
  const out = new Map<string, Annotation[]>();
  for (const row of rows) {
    const list = out.get(row.start_day);
    if (list) list.push(row);
    else out.set(row.start_day, [row]);
  }
  return out;
}

export interface RegisterToolsOptions {
  client: OuraClient;
  /** Required. v0.3+ tools that touch the local DB are skipped if absent. */
  annotations?: AnnotationRepo;
}

export function registerTools(server: McpServer, opts: RegisterToolsOptions): void {
  const { client, annotations: repo } = opts;

  const dateRangeShape = {
    start_date: dateSchema.describe('Start date, inclusive (YYYY-MM-DD).'),
    end_date: dateSchema.describe('End date, inclusive (YYYY-MM-DD).'),
    verbose: verboseSchema,
    include_annotations: includeAnnotationsSchema,
  };

  // -------------------------- Existing tools (compact-by-default) --------

  server.registerTool(
    'oura_get_daily_summary',
    {
      title: 'Oura: Daily summary',
      description:
        'Fetch combined daily Oura summaries (sleep, readiness, activity) for a date range. ' +
        'Returns one merged record per date. Compact by default; pass verbose:true for raw rows. ' +
        'Joins local annotations onto each day by default (set include_annotations:false to skip). ' +
        'Max 90 days per call.',
      inputSchema: dateRangeShape,
    },
    async ({ start_date, end_date, verbose, include_annotations }) => {
      const err = validateDateRange(start_date, end_date);
      if (err) return errorResult(err);
      return handle(async () => {
        if (verbose) {
          const q = { start_date, end_date };
          const [sleep, readiness, activity] = await Promise.all([
            client.getCollection<Record<string, unknown>>(ENDPOINTS.dailySleep, q),
            client.getCollection<Record<string, unknown>>(ENDPOINTS.dailyReadiness, q),
            client.getCollection<Record<string, unknown>>(ENDPOINTS.dailyActivity, q),
          ]);
          return {
            range: { start_date, end_date },
            verbose: true,
            truncated: sleep.truncated || readiness.truncated || activity.truncated,
            sleep: sleep.data,
            readiness: readiness.data,
            activity: activity.data,
          };
        }
        const { days, truncated } = await fetchCompactDays(client, start_date, end_date);
        const wantAnnotations = include_annotations !== false;
        const annsByDay =
          wantAnnotations && repo ? annotationsByDay(repo.list({ start_date, end_date })) : null;
        return {
          range: { start_date, end_date },
          truncated,
          count: days.length,
          days: days.map((d) => ({
            ...d,
            ...(annsByDay ? { annotations: annsByDay.get(d.day) ?? [] } : {}),
          })),
        };
      });
    },
  );

  server.registerTool(
    'oura_get_sleep',
    {
      title: 'Oura: Sleep',
      description:
        'Fetch detailed sleep records (one per sleep period) for a date range. ' +
        'Compact by default; pass verbose:true for raw rows. Max 90 days per call.',
      inputSchema: {
        start_date: dateSchema.describe('Start date, inclusive (YYYY-MM-DD).'),
        end_date: dateSchema.describe('End date, inclusive (YYYY-MM-DD).'),
        verbose: verboseSchema,
      },
    },
    async ({ start_date, end_date, verbose }) => {
      const err = validateDateRange(start_date, end_date);
      if (err) return errorResult(err);
      return handle(async () => {
        const r = await client.getCollection<unknown>(ENDPOINTS.sleep, { start_date, end_date });
        const data = verbose ? r.data : r.data.map(shapeSleep);
        return {
          range: { start_date, end_date },
          verbose: !!verbose,
          truncated: r.truncated,
          count: data.length,
          data,
        };
      });
    },
  );

  server.registerTool(
    'oura_get_activity',
    {
      title: 'Oura: Activity',
      description:
        'Fetch daily activity records for a date range. ' +
        'Compact by default; pass verbose:true for raw rows. Max 90 days per call.',
      inputSchema: {
        start_date: dateSchema.describe('Start date, inclusive (YYYY-MM-DD).'),
        end_date: dateSchema.describe('End date, inclusive (YYYY-MM-DD).'),
        verbose: verboseSchema,
      },
    },
    async ({ start_date, end_date, verbose }) => {
      const err = validateDateRange(start_date, end_date);
      if (err) return errorResult(err);
      return handle(async () => {
        const r = await client.getCollection<unknown>(ENDPOINTS.dailyActivity, {
          start_date,
          end_date,
        });
        const data = verbose ? r.data : r.data.map(shapeDailyActivity);
        return {
          range: { start_date, end_date },
          verbose: !!verbose,
          truncated: r.truncated,
          count: data.length,
          data,
        };
      });
    },
  );

  server.registerTool(
    'oura_get_heartrate',
    {
      title: 'Oura: Heart rate',
      description:
        'Fetch heart-rate time-series samples between two ISO 8601 datetimes. Max 90 days per call. ' +
        'Responses can be large; prefer narrow windows.',
      inputSchema: {
        start_datetime: datetimeSchema.describe(
          'ISO 8601 start datetime, e.g. 2026-01-15T00:00:00Z.',
        ),
        end_datetime: datetimeSchema.describe('ISO 8601 end datetime, e.g. 2026-01-15T23:59:59Z.'),
      },
    },
    async ({ start_datetime, end_datetime }) => {
      const err = validateDatetimeRange(start_datetime, end_datetime);
      if (err) return errorResult(err);
      return handle(async () => {
        const r = await client.getCollection(ENDPOINTS.heartrate, {
          start_datetime,
          end_datetime,
        });
        return {
          range: { start_datetime, end_datetime },
          ...r,
          count: r.data.length,
        };
      });
    },
  );

  server.registerTool(
    'oura_get_personal_info',
    {
      title: 'Oura: Personal info',
      description:
        'Fetch basic personal metadata (age, sex, height, weight, biological/email if exposed by scope).',
      inputSchema: {},
    },
    async () => handle(() => client.getOne(ENDPOINTS.personalInfo)),
  );

  // -------------------------- v0.2: derived metric tools --------------

  server.registerTool(
    'oura_get_recent_summary',
    {
      title: 'Oura: Recent summary',
      description:
        'Convenience wrapper for "the last N days". Computes start/end dates internally so the ' +
        'caller does not have to do date arithmetic. Returns the same compact shape as ' +
        'oura_get_daily_summary. Joins local annotations by default (set ' +
        'include_annotations:false to skip).',
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_RANGE_DAYS)
          .describe('How many days back from today (1–90). Today is included.'),
        include_annotations: includeAnnotationsSchema,
      },
    },
    async ({ days, include_annotations }) => {
      return handle(async () => {
        const end = todayUtc();
        const start = shiftDate(end, -(days - 1));
        const { days: rows, truncated } = await fetchCompactDays(client, start, end);
        const wantAnnotations = include_annotations !== false;
        const annsByDay =
          wantAnnotations && repo
            ? annotationsByDay(repo.list({ start_date: start, end_date: end }))
            : null;
        return {
          range: { start_date: start, end_date: end, days },
          truncated,
          count: rows.length,
          days: rows.map((d) => ({
            ...d,
            ...(annsByDay ? { annotations: annsByDay.get(d.day) ?? [] } : {}),
          })),
        };
      });
    },
  );

  server.registerTool(
    'oura_compare_periods',
    {
      title: 'Oura: Compare periods',
      description:
        'Compare averages between two date ranges. Two modes: ' +
        '(simple) pass `days` and the tool compares the last N days to the prior N days; ' +
        '(explicit) pass a_start, a_end, b_start, b_end for arbitrary ranges. ' +
        'Returns per-metric deltas and direction (up / down / flat). ' +
        'Direction threshold: |Δ%| ≤ 2% counts as flat.',
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_RANGE_DAYS)
          .optional()
          .describe(
            'Simple mode: compare last N days to the prior N days. Mutually exclusive with explicit ranges.',
          ),
        a_start: dateSchema
          .optional()
          .describe('Period A start (YYYY-MM-DD). Required if not using `days`.'),
        a_end: dateSchema
          .optional()
          .describe('Period A end (YYYY-MM-DD). Required if not using `days`.'),
        b_start: dateSchema
          .optional()
          .describe('Period B start (YYYY-MM-DD). Required if not using `days`.'),
        b_end: dateSchema
          .optional()
          .describe('Period B end (YYYY-MM-DD). Required if not using `days`.'),
      },
    },
    async ({ days, a_start, a_end, b_start, b_end }) => {
      let aStart: string;
      let aEnd: string;
      let bStart: string;
      let bEnd: string;

      if (days !== undefined) {
        if (a_start || a_end || b_start || b_end) {
          return errorResult('Pass either `days` or all four explicit dates, not both.');
        }
        aEnd = todayUtc();
        aStart = shiftDate(aEnd, -(days - 1));
        bEnd = shiftDate(aStart, -1);
        bStart = shiftDate(bEnd, -(days - 1));
      } else {
        if (!a_start || !a_end || !b_start || !b_end) {
          return errorResult(
            'In explicit mode, a_start, a_end, b_start, and b_end are all required.',
          );
        }
        aStart = a_start;
        aEnd = a_end;
        bStart = b_start;
        bEnd = b_end;
      }

      for (const [s, e, label] of [
        [aStart, aEnd, 'A'],
        [bStart, bEnd, 'B'],
      ] as const) {
        const err = validateDateRange(s, e);
        if (err) return errorResult(`Period ${label}: ${err}`);
      }

      return handle(async () => {
        const [a, b] = await Promise.all([
          fetchCompactDays(client, aStart, aEnd),
          fetchCompactDays(client, bStart, bEnd),
        ]);
        const aAvg = periodAverages(a.days);
        const bAvg = periodAverages(b.days);
        const diff = comparePeriods(aAvg, bAvg);
        return {
          period_a: { start_date: aStart, end_date: aEnd, count: aAvg.count },
          period_b: { start_date: bStart, end_date: bEnd, count: bAvg.count },
          averages: { a: aAvg, b: bAvg },
          deltas: diff,
        };
      });
    },
  );

  server.registerTool(
    'oura_get_trends',
    {
      title: 'Oura: Trends',
      description:
        'Compute rolling averages and a simple linear trend (improving / declining / stable) ' +
        'for sleep, readiness, and activity scores across a date range. Useful for spotting ' +
        'multi-week trajectory. Default rolling window is 7 days.',
      inputSchema: {
        start_date: dateSchema.describe('Start date, inclusive (YYYY-MM-DD).'),
        end_date: dateSchema.describe('End date, inclusive (YYYY-MM-DD).'),
        window: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe('Rolling-mean window size in days. Default 7.'),
      },
    },
    async ({ start_date, end_date, window }) => {
      const err = validateDateRange(start_date, end_date);
      if (err) return errorResult(err);
      const w = window ?? 7;
      return handle(async () => {
        const { days, truncated } = await fetchCompactDays(client, start_date, end_date);
        const sleepSeries = days.map((d) => d.sleep?.score);
        const readinessSeries = days.map((d) => d.readiness?.score);
        const activitySeries = days.map((d) => d.activity?.score);
        const sleepRolling = rollingMean(sleepSeries, w);
        const readinessRolling = rollingMean(readinessSeries, w);
        const activityRolling = rollingMean(activitySeries, w);
        return {
          range: { start_date, end_date },
          window: w,
          truncated,
          count: days.length,
          series: days.map((d, i) => ({
            day: d.day,
            sleep_score: sleepSeries[i] ?? null,
            sleep_score_rolling: sleepRolling[i] ?? null,
            readiness_score: readinessSeries[i] ?? null,
            readiness_score_rolling: readinessRolling[i] ?? null,
            activity_score: activitySeries[i] ?? null,
            activity_score_rolling: activityRolling[i] ?? null,
          })),
          trend: {
            sleep_score: trendFromSlope(linearSlope(sleepSeries)),
            readiness_score: trendFromSlope(linearSlope(readinessSeries)),
            activity_score: trendFromSlope(linearSlope(activitySeries)),
          },
        };
      });
    },
  );

  // -------------------------- v0.3: Oura tag read --------------------

  server.registerTool(
    'oura_get_enhanced_tags',
    {
      title: 'Oura: Enhanced tags',
      description:
        "Fetch tags you've logged in the Oura app (the modern enhanced_tag endpoint). " +
        'Compact by default. Each row carries a tag_type_code, optional custom_name, ' +
        'start/end times and days, and an optional comment. Max 90 days per call.',
      inputSchema: {
        start_date: dateSchema.describe('Start date, inclusive (YYYY-MM-DD).'),
        end_date: dateSchema.describe('End date, inclusive (YYYY-MM-DD).'),
        verbose: verboseSchema,
      },
    },
    async ({ start_date, end_date, verbose }) => {
      const err = validateDateRange(start_date, end_date);
      if (err) return errorResult(err);
      return handle(async () => {
        const r = await client.getCollection<unknown>(ENDPOINTS.enhancedTag, {
          start_date,
          end_date,
        });
        const data = verbose ? r.data : r.data.map(shapeEnhancedTag);
        return {
          range: { start_date, end_date },
          verbose: !!verbose,
          truncated: r.truncated,
          count: data.length,
          data,
        };
      });
    },
  );

  // -------------------------- v0.3: local annotations ----------------

  if (!repo) return; // Annotation tools require the local DB; skip if absent.

  // Reusable bits for the annotation input schema. All field shapes match
  // Oura's EnhancedTagModel so locally-stored rows are interchangeable with
  // (future) synced Oura rows.
  const tagTypeCodeSchema = z
    .string()
    .nullable()
    .optional()
    .describe(
      `Canonical Oura tag type. Accepted: ${acceptedTagTypeCodes().join(', ')}, or null. ` +
        'Use "custom" with a custom_name for ad-hoc types.',
    );
  const customNameSchema = z
    .string()
    .optional()
    .describe('Required iff tag_type_code="custom". 1–60 chars.');
  const startTimeSchema = datetimeSchema.describe('ISO 8601 start datetime.');
  const endTimeSchema = datetimeSchema
    .nullable()
    .optional()
    .describe('Optional ISO 8601 end datetime for events with duration.');
  const startDaySchema = dateSchema.describe('Start day (YYYY-MM-DD).');
  const endDaySchema = dateSchema
    .nullable()
    .optional()
    .describe('Optional end day (YYYY-MM-DD) for multi-day events like travel.');
  const commentSchema = z
    .string()
    .nullable()
    .optional()
    .describe('Free-form note. Required when tag_type_code is null (text-only annotation).');

  function annotationCallError(err: unknown): {
    isError: boolean;
    content: { type: 'text'; text: string }[];
  } {
    const e = err as Error;
    const prefix =
      e instanceof AnnotationValidationError ? 'Validation error' : (e.name ?? 'Error');
    return errorResult(`${prefix}: ${e.message}`);
  }

  server.registerTool(
    'oura_add_annotation',
    {
      title: 'Annotations: Add',
      description:
        "Store a contextual annotation in the local SQLite database. Fields mirror Oura's " +
        'enhanced_tag schema so this data is shape-compatible with tags you log in the Oura app. ' +
        'Use this for things Oura does not capture: illness, alcohol, travel, naps, mood, etc.',
      inputSchema: {
        tag_type_code: tagTypeCodeSchema,
        custom_name: customNameSchema,
        start_time: startTimeSchema,
        end_time: endTimeSchema,
        start_day: startDaySchema,
        end_day: endDaySchema,
        comment: commentSchema,
      },
    },
    async (input) => {
      try {
        const row = repo.add({
          tag_type_code: input.tag_type_code ?? null,
          custom_name: input.custom_name ?? null,
          start_time: input.start_time,
          end_time: input.end_time ?? null,
          start_day: input.start_day,
          end_day: input.end_day ?? null,
          comment: input.comment ?? null,
        });
        return textResult({ created: row });
      } catch (err) {
        return annotationCallError(err);
      }
    },
  );

  server.registerTool(
    'oura_list_annotations',
    {
      title: 'Annotations: List',
      description:
        'List local annotations, optionally filtered by date range, tag_type_code, or source ' +
        '("local" for entries you added via this MCP, "oura" for synced Oura tags).',
      inputSchema: {
        start_date: dateSchema.optional().describe('Filter: rows with start_day >= this.'),
        end_date: dateSchema.optional().describe('Filter: rows with start_day <= this.'),
        tag_type_code: z.string().optional().describe('Filter to a specific tag_type_code.'),
        source: z
          .enum(['local', 'oura'])
          .optional()
          .describe('Filter by row source: "local" or "oura".'),
      },
    },
    async (filter) => {
      try {
        const rows = repo.list(filter);
        return textResult({ count: rows.length, annotations: rows });
      } catch (err) {
        return annotationCallError(err);
      }
    },
  );

  server.registerTool(
    'oura_update_annotation',
    {
      title: 'Annotations: Update',
      description:
        'Partial update of an existing annotation by id. Pass only the fields you want to change. ' +
        'The merged row is re-validated, so you cannot leave it in an invalid state.',
      inputSchema: {
        id: z.number().int().positive().describe('Annotation id.'),
        tag_type_code: tagTypeCodeSchema,
        custom_name: customNameSchema,
        start_time: datetimeSchema.optional().describe('ISO 8601 start datetime.'),
        end_time: endTimeSchema,
        start_day: dateSchema.optional().describe('Start day (YYYY-MM-DD).'),
        end_day: endDaySchema,
        comment: commentSchema,
      },
    },
    async ({ id, ...patch }) => {
      try {
        const row = repo.update(id, patch);
        if (!row) return errorResult(`No annotation with id=${id}.`);
        return textResult({ updated: row });
      } catch (err) {
        return annotationCallError(err);
      }
    },
  );

  server.registerTool(
    'oura_delete_annotation',
    {
      title: 'Annotations: Delete',
      description: 'Delete an annotation by id. Returns whether the row existed.',
      inputSchema: {
        id: z.number().int().positive().describe('Annotation id.'),
      },
    },
    async ({ id }) => {
      try {
        const deleted = repo.delete(id);
        return textResult({ deleted, id });
      } catch (err) {
        return annotationCallError(err);
      }
    },
  );
}
