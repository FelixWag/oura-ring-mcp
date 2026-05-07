/**
 * Pure projection helpers: take raw Oura API objects and emit compact records.
 *
 * Why this module exists: the LLM rarely needs the deep nested timeseries data
 * that Oura ships in every response. A 7-day daily summary returned ~173k
 * characters of mostly nested HRV / movement / per-minute arrays — enough to
 * blow past MCP response size limits.
 *
 * These functions are intentionally permissive (input typed as `unknown`) so
 * they survive Oura adding or removing fields. Tools call them; raw access
 * stays available via `verbose: true` on the tool inputs.
 *
 * Future v0.4 SQLite sync should NOT use these — it should persist the raw
 * API objects so the local database is lossless.
 */

type Json = unknown;

function getString(obj: unknown, key: string): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

function getNumber(obj: unknown, key: string): number | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : undefined;
}

function getRecord(obj: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

export interface CompactDailySleep {
  day: string;
  score: number | undefined;
  contributors: Record<string, number | undefined> | undefined;
}

export interface CompactDailyReadiness {
  day: string;
  score: number | undefined;
  temperature_deviation: number | undefined;
  contributors: Record<string, number | undefined> | undefined;
}

export interface CompactDailyActivity {
  day: string;
  score: number | undefined;
  active_calories: number | undefined;
  total_calories: number | undefined;
  steps: number | undefined;
  high_activity_minutes: number | undefined;
  medium_activity_minutes: number | undefined;
  low_activity_minutes: number | undefined;
  sedentary_minutes: number | undefined;
}

export interface CompactSleep {
  day: string;
  bedtime_start: string | undefined;
  bedtime_end: string | undefined;
  total_sleep_seconds: number | undefined;
  rem_sleep_seconds: number | undefined;
  deep_sleep_seconds: number | undefined;
  light_sleep_seconds: number | undefined;
  awake_seconds: number | undefined;
  efficiency: number | undefined;
  average_heart_rate: number | undefined;
  lowest_heart_rate: number | undefined;
  average_hrv: number | undefined;
}

function shapeContributors(raw: unknown): Record<string, number | undefined> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const out: Record<string, number | undefined> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = typeof v === 'number' ? v : undefined;
  }
  return out;
}

export function shapeDailySleep(row: Json): CompactDailySleep {
  return {
    day: getString(row, 'day') ?? '',
    score: getNumber(row, 'score'),
    contributors: shapeContributors(getRecord(row, 'contributors')),
  };
}

export function shapeDailyReadiness(row: Json): CompactDailyReadiness {
  return {
    day: getString(row, 'day') ?? '',
    score: getNumber(row, 'score'),
    temperature_deviation: getNumber(row, 'temperature_deviation'),
    contributors: shapeContributors(getRecord(row, 'contributors')),
  };
}

export function shapeDailyActivity(row: Json): CompactDailyActivity {
  return {
    day: getString(row, 'day') ?? '',
    score: getNumber(row, 'score'),
    active_calories: getNumber(row, 'active_calories'),
    total_calories: getNumber(row, 'total_calories'),
    steps: getNumber(row, 'steps'),
    high_activity_minutes: getNumber(row, 'high_activity_time')
      ? Math.round((getNumber(row, 'high_activity_time') ?? 0) / 60)
      : undefined,
    medium_activity_minutes: getNumber(row, 'medium_activity_time')
      ? Math.round((getNumber(row, 'medium_activity_time') ?? 0) / 60)
      : undefined,
    low_activity_minutes: getNumber(row, 'low_activity_time')
      ? Math.round((getNumber(row, 'low_activity_time') ?? 0) / 60)
      : undefined,
    sedentary_minutes: getNumber(row, 'sedentary_time')
      ? Math.round((getNumber(row, 'sedentary_time') ?? 0) / 60)
      : undefined,
  };
}

export function shapeSleep(row: Json): CompactSleep {
  return {
    day: getString(row, 'day') ?? '',
    bedtime_start: getString(row, 'bedtime_start'),
    bedtime_end: getString(row, 'bedtime_end'),
    total_sleep_seconds: getNumber(row, 'total_sleep_duration'),
    rem_sleep_seconds: getNumber(row, 'rem_sleep_duration'),
    deep_sleep_seconds: getNumber(row, 'deep_sleep_duration'),
    light_sleep_seconds: getNumber(row, 'light_sleep_duration'),
    awake_seconds: getNumber(row, 'awake_time'),
    efficiency: getNumber(row, 'efficiency'),
    average_heart_rate: getNumber(row, 'average_heart_rate'),
    lowest_heart_rate: getNumber(row, 'lowest_heart_rate'),
    average_hrv: getNumber(row, 'average_hrv'),
  };
}

/**
 * Merged daily record used by `oura_get_daily_summary` and friends.
 * One row per date, with the three score families as nested objects (or null
 * if Oura didn't return a row for that family on that day).
 */
export interface CompactDay {
  day: string;
  sleep: CompactDailySleep | null;
  readiness: CompactDailyReadiness | null;
  activity: CompactDailyActivity | null;
}

export function mergeDays(
  sleep: CompactDailySleep[],
  readiness: CompactDailyReadiness[],
  activity: CompactDailyActivity[],
): CompactDay[] {
  const byDay = new Map<string, CompactDay>();
  const ensure = (day: string): CompactDay => {
    let entry = byDay.get(day);
    if (!entry) {
      entry = { day, sleep: null, readiness: null, activity: null };
      byDay.set(day, entry);
    }
    return entry;
  };
  for (const r of sleep) if (r.day) ensure(r.day).sleep = r;
  for (const r of readiness) if (r.day) ensure(r.day).readiness = r;
  for (const r of activity) if (r.day) ensure(r.day).activity = r;
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}
