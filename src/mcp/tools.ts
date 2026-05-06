import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OuraClient } from '../oura/client.js';
import { ENDPOINTS } from '../oura/endpoints.js';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 90;

const dateSchema = z.string().regex(DATE_REGEX, 'Date must be in YYYY-MM-DD format');

const datetimeSchema = z
  .string()
  .refine(
    (v) => !Number.isNaN(Date.parse(v)),
    'Datetime must be ISO 8601 (e.g. 2026-01-15T08:30:00Z)',
  );

function diffDays(start: string, end: string): number {
  const a = Date.parse(start + 'T00:00:00Z');
  const b = Date.parse(end + 'T00:00:00Z');
  return (b - a) / (1000 * 60 * 60 * 24);
}

function validateDateRange(start: string, end: string): string | null {
  const days = diffDays(start, end);
  if (Number.isNaN(days)) return 'Invalid dates.';
  if (days < 0) return 'end_date must be on or after start_date.';
  if (days > MAX_RANGE_DAYS) {
    return `Date range too large (${days} days). Maximum is ${MAX_RANGE_DAYS} days. Make multiple smaller requests.`;
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

export function registerTools(server: McpServer, client: OuraClient): void {
  const dateRangeShape = {
    start_date: dateSchema.describe('Start date, inclusive (YYYY-MM-DD).'),
    end_date: dateSchema.describe('End date, inclusive (YYYY-MM-DD).'),
  };

  server.registerTool(
    'oura_get_daily_summary',
    {
      title: 'Oura: Daily summary',
      description:
        'Fetch combined daily Oura summaries (sleep, readiness, activity) for a date range. ' +
        'Returns one merged record per date when available. Max 90 days per call.',
      inputSchema: dateRangeShape,
    },
    async ({ start_date, end_date }) => {
      const err = validateDateRange(start_date, end_date);
      if (err) return errorResult(err);
      return handle(async () => {
        const q = { start_date, end_date };
        const [sleep, readiness, activity] = await Promise.all([
          client.getCollection<Record<string, unknown>>(ENDPOINTS.dailySleep, q),
          client.getCollection<Record<string, unknown>>(ENDPOINTS.dailyReadiness, q),
          client.getCollection<Record<string, unknown>>(ENDPOINTS.dailyActivity, q),
        ]);
        const byDay = new Map<string, Record<string, unknown>>();
        const merge = (rows: Record<string, unknown>[], key: string) => {
          for (const row of rows) {
            const day = (row.day ?? row.date) as string | undefined;
            if (!day) continue;
            const entry = byDay.get(day) ?? { day };
            entry[key] = row;
            byDay.set(day, entry);
          }
        };
        merge(sleep.data, 'sleep');
        merge(readiness.data, 'readiness');
        merge(activity.data, 'activity');
        const days = [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
        return {
          range: { start_date, end_date },
          truncated: sleep.truncated || readiness.truncated || activity.truncated,
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
        'Fetch detailed sleep records (one per sleep period) for a date range. Max 90 days per call.',
      inputSchema: dateRangeShape,
    },
    async ({ start_date, end_date }) => {
      const err = validateDateRange(start_date, end_date);
      if (err) return errorResult(err);
      return handle(async () => {
        const r = await client.getCollection(ENDPOINTS.sleep, { start_date, end_date });
        return { range: { start_date, end_date }, ...r, count: r.data.length };
      });
    },
  );

  server.registerTool(
    'oura_get_activity',
    {
      title: 'Oura: Activity',
      description: 'Fetch daily activity records for a date range. Max 90 days per call.',
      inputSchema: dateRangeShape,
    },
    async ({ start_date, end_date }) => {
      const err = validateDateRange(start_date, end_date);
      if (err) return errorResult(err);
      return handle(async () => {
        const r = await client.getCollection(ENDPOINTS.dailyActivity, { start_date, end_date });
        return { range: { start_date, end_date }, ...r, count: r.data.length };
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
}
