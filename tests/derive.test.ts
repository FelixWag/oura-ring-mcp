import { describe, expect, it } from 'vitest';
import {
  compareMetric,
  comparePeriods,
  linearSlope,
  periodAverages,
  rollingMean,
  trendFromSlope,
} from '../src/oura/derive.js';
import type { CompactDay } from '../src/oura/shape.js';

function day(
  d: string,
  sleep?: number,
  readiness?: number,
  activity?: number,
  steps?: number,
): CompactDay {
  return {
    day: d,
    sleep: sleep === undefined ? null : { day: d, score: sleep, contributors: undefined },
    readiness:
      readiness === undefined
        ? null
        : { day: d, score: readiness, temperature_deviation: undefined, contributors: undefined },
    activity:
      activity === undefined
        ? null
        : {
            day: d,
            score: activity,
            active_calories: undefined,
            total_calories: undefined,
            steps,
            high_activity_minutes: undefined,
            medium_activity_minutes: undefined,
            low_activity_minutes: undefined,
            sedentary_minutes: undefined,
          },
  };
}

describe('periodAverages', () => {
  it('averages only the days that have a metric', () => {
    const days = [
      day('2026-05-01', 80, 70, 60, 8000),
      day('2026-05-02', 90, undefined, 80, 10_000),
    ];
    const avg = periodAverages(days);
    expect(avg.count).toBe(2);
    expect(avg.sleep_score).toBe(85);
    expect(avg.readiness_score).toBe(70);
    expect(avg.activity_score).toBe(70);
    expect(avg.steps).toBe(9000);
  });

  it('returns undefined when no day has a metric', () => {
    const avg = periodAverages([day('2026-05-01')]);
    expect(avg.sleep_score).toBeUndefined();
    expect(avg.readiness_score).toBeUndefined();
  });
});

describe('compareMetric', () => {
  it('reports up when a > b beyond the threshold', () => {
    const r = compareMetric(85, 75);
    expect(r.delta).toBe(10);
    expect(r.delta_pct).toBeCloseTo(13.33, 2);
    expect(r.direction).toBe('up');
  });

  it('reports down when a < b beyond the threshold', () => {
    const r = compareMetric(70, 80);
    expect(r.direction).toBe('down');
  });

  it('reports flat when within ±2%', () => {
    const r = compareMetric(80, 80.5);
    expect(r.direction).toBe('flat');
  });

  it('treats undefined inputs as flat with undefined delta', () => {
    const r = compareMetric(undefined, 80);
    expect(r.direction).toBe('flat');
    expect(r.delta).toBeUndefined();
  });
});

describe('comparePeriods', () => {
  it('produces a delta entry per metric', () => {
    const a = periodAverages([day('a1', 90, 90, 80, 12_000)]);
    const b = periodAverages([day('b1', 70, 70, 80, 12_000)]);
    const diff = comparePeriods(a, b);
    expect(diff.sleep_score.direction).toBe('up');
    expect(diff.activity_score.direction).toBe('flat');
    expect(diff.steps.direction).toBe('flat');
  });
});

describe('rollingMean', () => {
  it('produces a centered window mean of the given size', () => {
    const out = rollingMean([1, 2, 3, 4, 5], 3);
    // edges fall back to partial windows
    expect(out[0]).toBeCloseTo(1.5);
    expect(out[1]).toBeCloseTo(2);
    expect(out[2]).toBeCloseTo(3);
    expect(out[3]).toBeCloseTo(4);
    expect(out[4]).toBeCloseTo(4.5);
  });

  it('skips undefined entries', () => {
    const out = rollingMean([1, undefined, 3], 3);
    expect(out[1]).toBeCloseTo(2);
  });
});

describe('linearSlope / trendFromSlope', () => {
  it('detects an improving series', () => {
    const slope = linearSlope([70, 72, 75, 78, 80]);
    expect(slope).toBeGreaterThan(0);
    expect(trendFromSlope(slope)).toBe('improving');
  });

  it('detects a declining series', () => {
    const slope = linearSlope([80, 78, 75, 72, 70]);
    expect(slope).toBeLessThan(0);
    expect(trendFromSlope(slope)).toBe('declining');
  });

  it('detects stable when slope is small', () => {
    const slope = linearSlope([80, 80, 80, 80, 80]);
    expect(trendFromSlope(slope)).toBe('stable');
  });

  it('returns stable for too-few finite points', () => {
    expect(trendFromSlope(linearSlope([undefined, undefined]))).toBe('stable');
    expect(trendFromSlope(linearSlope([5]))).toBe('stable');
  });
});
