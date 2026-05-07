/**
 * Pure derivation helpers: averages, deltas, rolling means, trend direction.
 *
 * Lives separately from `shape.ts` so tools call: client → shape → derive.
 * No I/O, no dates beyond pure math, fully unit-testable.
 */

import type { CompactDay } from './shape.js';

const FLAT_THRESHOLD_PCT = 2; // |delta_pct| ≤ 2 → flat
const TREND_FLAT_SLOPE = 0.05; // |slope| (units/day) ≤ 0.05 → stable

export type Direction = 'up' | 'down' | 'flat';
export type Trend = 'improving' | 'declining' | 'stable';

function avg(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pickNumbers<T>(rows: T[], picker: (row: T) => number | undefined | null): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const v = picker(row);
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * Metrics computable directly from `CompactDay`. We deliberately keep this
 * scoped — a future caller that has detailed sleep records can build a richer
 * averages helper without changing this one.
 */
export interface PeriodAverages {
  count: number;
  sleep_score: number | undefined;
  readiness_score: number | undefined;
  activity_score: number | undefined;
  temperature_deviation: number | undefined;
  steps: number | undefined;
  active_calories: number | undefined;
}

/**
 * Compute the average of every metric across a list of compact days.
 * Days missing a metric simply don't contribute to that metric's average.
 */
export function periodAverages(days: CompactDay[]): PeriodAverages {
  return {
    count: days.length,
    sleep_score: avg(pickNumbers(days, (d) => d.sleep?.score)),
    readiness_score: avg(pickNumbers(days, (d) => d.readiness?.score)),
    activity_score: avg(pickNumbers(days, (d) => d.activity?.score)),
    temperature_deviation: avg(pickNumbers(days, (d) => d.readiness?.temperature_deviation)),
    steps: avg(pickNumbers(days, (d) => d.activity?.steps)),
    active_calories: avg(pickNumbers(days, (d) => d.activity?.active_calories)),
  };
}

export interface MetricDelta {
  a_avg: number | undefined;
  b_avg: number | undefined;
  delta: number | undefined;
  delta_pct: number | undefined;
  direction: Direction;
}

/**
 * Compare metric "a" (typically the more recent period) to metric "b" (older).
 * Direction: "up" means a > b, "down" means a < b, "flat" if within threshold.
 */
export function compareMetric(a: number | undefined, b: number | undefined): MetricDelta {
  if (a === undefined || b === undefined) {
    return { a_avg: a, b_avg: b, delta: undefined, delta_pct: undefined, direction: 'flat' };
  }
  const delta = a - b;
  const delta_pct = b === 0 ? undefined : (delta / b) * 100;
  let direction: Direction = 'flat';
  if (delta_pct !== undefined) {
    if (delta_pct > FLAT_THRESHOLD_PCT) direction = 'up';
    else if (delta_pct < -FLAT_THRESHOLD_PCT) direction = 'down';
  }
  return { a_avg: a, b_avg: b, delta, delta_pct, direction };
}

/** Per-metric comparison of two pre-averaged periods. */
export function comparePeriods(
  a: PeriodAverages,
  b: PeriodAverages,
): Omit<Record<keyof PeriodAverages, MetricDelta>, 'count'> {
  const keys: Exclude<keyof PeriodAverages, 'count'>[] = [
    'sleep_score',
    'readiness_score',
    'activity_score',
    'temperature_deviation',
    'steps',
    'active_calories',
  ];
  const out = {} as Record<Exclude<keyof PeriodAverages, 'count'>, MetricDelta>;
  for (const k of keys) {
    out[k] = compareMetric(a[k], b[k]);
  }
  return out;
}

/**
 * Centered-window rolling mean over a numeric series.
 * Returns one value per input index; positions without enough neighbors fall
 * back to the partial-window mean. Missing values (undefined) are skipped.
 */
export function rollingMean(
  values: (number | undefined)[],
  window: number,
): (number | undefined)[] {
  if (window < 1) return values.slice();
  const half = Math.floor(window / 2);
  const out: (number | undefined)[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const start = Math.max(0, i - half);
    const end = Math.min(values.length - 1, i + half);
    const slice: number[] = [];
    for (let j = start; j <= end; j += 1) {
      const v = values[j];
      if (typeof v === 'number' && Number.isFinite(v)) slice.push(v);
    }
    out.push(slice.length > 0 ? slice.reduce((a, b) => a + b, 0) / slice.length : undefined);
  }
  return out;
}

/**
 * Simple least-squares slope of values vs. their integer indices.
 * Returns `undefined` if fewer than 2 finite values are present.
 */
export function linearSlope(values: (number | undefined)[]): number | undefined {
  const points: { x: number; y: number }[] = [];
  values.forEach((v, i) => {
    if (typeof v === 'number' && Number.isFinite(v)) points.push({ x: i, y: v });
  });
  if (points.length < 2) return undefined;
  const n = points.length;
  const sumX = points.reduce((a, p) => a + p.x, 0);
  const sumY = points.reduce((a, p) => a + p.y, 0);
  const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
  const sumXX = points.reduce((a, p) => a + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return undefined;
  return (n * sumXY - sumX * sumY) / denom;
}

export function trendFromSlope(slope: number | undefined): Trend {
  if (slope === undefined) return 'stable';
  if (slope > TREND_FLAT_SLOPE) return 'improving';
  if (slope < -TREND_FLAT_SLOPE) return 'declining';
  return 'stable';
}
