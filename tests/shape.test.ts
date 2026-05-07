import { describe, expect, it } from 'vitest';
import {
  mergeDays,
  shapeDailyActivity,
  shapeDailyReadiness,
  shapeDailySleep,
  shapeSleep,
} from '../src/oura/shape.js';

describe('shapeDailySleep', () => {
  it('extracts day, score, and contributors', () => {
    const out = shapeDailySleep({
      day: '2026-05-01',
      score: 80,
      contributors: { rem_sleep: 70, deep_sleep: 90 },
      timestamp: 'ignored',
    });
    expect(out.day).toBe('2026-05-01');
    expect(out.score).toBe(80);
    expect(out.contributors).toEqual({ rem_sleep: 70, deep_sleep: 90 });
  });

  it('returns undefined for missing fields', () => {
    const out = shapeDailySleep({ day: '2026-05-01' });
    expect(out.score).toBeUndefined();
    expect(out.contributors).toBeUndefined();
  });

  it('coerces empty day to empty string', () => {
    expect(shapeDailySleep({}).day).toBe('');
  });
});

describe('shapeDailyReadiness', () => {
  it('includes temperature_deviation', () => {
    const out = shapeDailyReadiness({
      day: '2026-05-02',
      score: 75,
      temperature_deviation: -0.3,
      contributors: { hrv_balance: 80 },
    });
    expect(out.temperature_deviation).toBe(-0.3);
    expect(out.contributors?.hrv_balance).toBe(80);
  });
});

describe('shapeDailyActivity', () => {
  it('converts seconds to minutes for activity-time fields', () => {
    const out = shapeDailyActivity({
      day: '2026-05-03',
      score: 70,
      active_calories: 500,
      total_calories: 2400,
      steps: 9000,
      high_activity_time: 600, // 10 min
      medium_activity_time: 1800, // 30 min
      low_activity_time: 3600, // 60 min
      sedentary_time: 18000, // 300 min
    });
    expect(out.high_activity_minutes).toBe(10);
    expect(out.medium_activity_minutes).toBe(30);
    expect(out.low_activity_minutes).toBe(60);
    expect(out.sedentary_minutes).toBe(300);
    expect(out.steps).toBe(9000);
  });
});

describe('shapeSleep', () => {
  it('keeps durations as seconds and exposes HR/HRV', () => {
    const out = shapeSleep({
      day: '2026-05-01',
      bedtime_start: '2026-04-30T23:15:00+00:00',
      bedtime_end: '2026-05-01T07:00:00+00:00',
      total_sleep_duration: 25_200, // 7h
      rem_sleep_duration: 5_400,
      deep_sleep_duration: 4_800,
      light_sleep_duration: 15_000,
      awake_time: 600,
      efficiency: 92,
      average_heart_rate: 55,
      lowest_heart_rate: 48,
      average_hrv: 62,
    });
    expect(out.total_sleep_seconds).toBe(25_200);
    expect(out.lowest_heart_rate).toBe(48);
    expect(out.average_hrv).toBe(62);
  });
});

describe('mergeDays', () => {
  it('joins three lists by day, sorted ascending', () => {
    const sleep = [
      { day: '2026-05-02', score: 80, contributors: undefined },
      { day: '2026-05-01', score: 70, contributors: undefined },
    ];
    const readiness = [
      { day: '2026-05-01', score: 75, temperature_deviation: 0, contributors: undefined },
    ];
    const activity = [
      {
        day: '2026-05-02',
        score: 60,
        active_calories: undefined,
        total_calories: undefined,
        steps: undefined,
        high_activity_minutes: undefined,
        medium_activity_minutes: undefined,
        low_activity_minutes: undefined,
        sedentary_minutes: undefined,
      },
    ];
    const merged = mergeDays(sleep, readiness, activity);
    expect(merged.map((d) => d.day)).toEqual(['2026-05-01', '2026-05-02']);
    expect(merged[0]!.sleep?.score).toBe(70);
    expect(merged[0]!.readiness?.score).toBe(75);
    expect(merged[0]!.activity).toBeNull();
    expect(merged[1]!.activity?.score).toBe(60);
    expect(merged[1]!.readiness).toBeNull();
  });
});
