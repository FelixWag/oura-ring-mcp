import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
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

function diffDays(start: string, end: string): number {
  const a = Date.parse(start + 'T00:00:00Z');
  const b = Date.parse(end + 'T00:00:00Z');
  return (b - a) / (1000 * 60 * 60 * 24);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Subtract `days` from `from` (YYYY-MM-DD), returning a YYYY-MM-DD string.
 * Pure UTC arithmetic so we don't get bitten by DST.
 */
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

/**
 * Fetch the three daily collections for a date range and merge them into a
 * single sorted list of compact day records. Used by both
 * `oura_get_daily_summary` and the new derived-metric tools.
 */
async function fetchCompactDays(
  client: OuraClient,
  start_date: string,
  end_date: string,
): Promise<{
  days: ReturnType<typeof mergeDays>;
  truncated: boolean;
}> {
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

export function registerTools(server: McpServer, client: OuraClient): void {
  const dateRangeShape = {
    start_date: dateSchema.describe('Start date, inclusive (YYYY-MM-DD).'),
    end_date: dateSchema.describe('End date, inclusive (YYYY-MM-DD).'),
    verbose: verboseSchema,
  };

  // -------------------------- Existing tools (compact-by-default) --------

  server.registerTool(
    'oura_get_daily_summary',
    {
      title: 'Oura: Daily summary',
      description:
        'Fetch combined daily Oura summaries (sleep, readiness, activity) for a date range. ' +
        'Returns one merged record per date. Compact by default; pass verbose:true for raw rows. ' +
        'Max 90 days per call.',
      inputSchema: dateRangeShape,
    },
    async ({ start_date, end_date, verbose }) => {
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
        return {
          range: { start_date, end_date },
          truncated,
          count: days.length,
          days,
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
      inputSchema: dateRangeShape,
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
      inputSchema: dateRangeShape,
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
        'oura_get_daily_summary plus the resolved date range.',
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_RANGE_DAYS)
          .describe('How many days back from today (1–90). Today is included.'),
      },
    },
    async ({ days }) => {
      return handle(async () => {
        const end = todayUtc();
        const start = shiftDate(end, -(days - 1));
        const { days: rows, truncated } = await fetchCompactDays(client, start, end);
        return {
          range: { start_date: start, end_date: end, days },
          truncated,
          count: rows.length,
          days: rows,
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
}
