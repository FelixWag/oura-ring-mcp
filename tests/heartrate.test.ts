import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../src/db/index.js';
import { HeartrateRepo } from '../src/db/repos/heartrate.js';
import { runSync } from '../src/db/sync.js';

let db: Db;

beforeEach(async () => {
  db = await openDatabase(':memory:');
});

describe('HeartrateRepo', () => {
  it('upserts on (timestamp, source) — same instant in two sources both kept', () => {
    const repo = new HeartrateRepo(db);
    repo.upsert({ timestamp: '2026-05-09T07:00:00+00:00', source: 'rest', bpm: 60 });
    repo.upsert({ timestamp: '2026-05-09T07:00:00+00:00', source: 'sleep', bpm: 58 });
    const all = repo.listRange('2026-05-09T00:00:00+00:00', '2026-05-09T23:59:59+00:00');
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.source).sort()).toEqual(['rest', 'sleep']);
  });

  it('idempotent re-upsert refreshes bpm + last_synced_at, preserves first_seen_at', async () => {
    const repo = new HeartrateRepo(db);
    repo.upsert({ timestamp: '2026-05-09T07:00:00+00:00', source: 'awake', bpm: 70 });
    const first = repo.listRange('2026-05-09T00:00:00+00:00', '2026-05-09T23:59:59+00:00')[0]!;
    await new Promise((r) => setTimeout(r, 2));
    repo.upsert({ timestamp: '2026-05-09T07:00:00+00:00', source: 'awake', bpm: 75 });
    const second = repo.listRange('2026-05-09T00:00:00+00:00', '2026-05-09T23:59:59+00:00')[0]!;
    expect(second.bpm).toBe(75);
    expect(second.first_seen_at).toBe(first.first_seen_at);
    expect(second.last_synced_at).not.toBe(first.last_synced_at);
  });

  it('rejects rows missing timestamp / source / bpm', () => {
    const repo = new HeartrateRepo(db);
    expect(() => repo.upsert({ source: 'awake', bpm: 70 })).toThrow(/timestamp/);
    expect(() => repo.upsert({ timestamp: 'x', bpm: 70 })).toThrow(/source/);
    expect(() => repo.upsert({ timestamp: '2026-05-09T07:00:00+00:00', source: 'awake' })).toThrow(
      /bpm/,
    );
  });

  it('summarizeByHour collapses multiple samples into avg/min/max/count per (hour, source)', () => {
    const repo = new HeartrateRepo(db);
    // Three samples in 07:00–08:00 hour, awake.
    repo.upsert({ timestamp: '2026-05-09T07:05:00+00:00', source: 'awake', bpm: 60 });
    repo.upsert({ timestamp: '2026-05-09T07:25:00+00:00', source: 'awake', bpm: 80 });
    repo.upsert({ timestamp: '2026-05-09T07:55:00+00:00', source: 'awake', bpm: 70 });
    // One sample in 07:00–08:00 hour, workout (parallel transition).
    repo.upsert({ timestamp: '2026-05-09T07:30:00+00:00', source: 'workout', bpm: 145 });
    // One sample in the next hour.
    repo.upsert({ timestamp: '2026-05-09T08:15:00+00:00', source: 'awake', bpm: 72 });

    const summary = repo.summarizeByHour('2026-05-09T00:00:00+00:00', '2026-05-09T23:59:59+00:00');
    // Expect 3 rows: (07, awake), (07, workout), (08, awake).
    expect(summary).toHaveLength(3);

    const sevenAwake = summary.find(
      (r) => r.hour_start.startsWith('2026-05-09T07') && r.source === 'awake',
    )!;
    expect(sevenAwake.bpm_min).toBe(60);
    expect(sevenAwake.bpm_max).toBe(80);
    expect(sevenAwake.bpm_avg).toBe(70);
    expect(sevenAwake.sample_count).toBe(3);

    const sevenWorkout = summary.find((r) => r.source === 'workout')!;
    expect(sevenWorkout.bpm_min).toBe(145);
    expect(sevenWorkout.sample_count).toBe(1);
  });

  it('listRange filters by datetime range inclusively', () => {
    const repo = new HeartrateRepo(db);
    repo.upsert({ timestamp: '2026-05-08T23:59:00+00:00', source: 'sleep', bpm: 55 });
    repo.upsert({ timestamp: '2026-05-09T07:00:00+00:00', source: 'awake', bpm: 70 });
    repo.upsert({ timestamp: '2026-05-10T07:00:00+00:00', source: 'awake', bpm: 70 });
    const rows = repo.listRange('2026-05-09T00:00:00+00:00', '2026-05-09T23:59:59+00:00');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.timestamp.startsWith('2026-05-09T')).toBe(true);
  });

  it('maxTimestamp returns the latest timestamp or null', () => {
    const repo = new HeartrateRepo(db);
    expect(repo.maxTimestamp()).toBeNull();
    repo.upsert({ timestamp: '2026-05-08T07:00:00+00:00', source: 'awake', bpm: 70 });
    repo.upsert({ timestamp: '2026-05-09T07:00:00+00:00', source: 'awake', bpm: 70 });
    expect(repo.maxTimestamp()).toBe('2026-05-09T07:00:00+00:00');
  });

  it('minTimestamp returns the earliest timestamp or null', () => {
    const repo = new HeartrateRepo(db);
    expect(repo.minTimestamp()).toBeNull();
    repo.upsert({ timestamp: '2026-05-09T07:00:00+00:00', source: 'awake', bpm: 70 });
    repo.upsert({ timestamp: '2026-05-08T07:00:00+00:00', source: 'awake', bpm: 70 });
    expect(repo.minTimestamp()).toBe('2026-05-08T07:00:00+00:00');
  });
});

describe('runSync — heartrate handling', () => {
  function makeFakeClient(perPath: Record<string, unknown[]>): {
    client: { getCollection: ReturnType<typeof vi.fn> };
    calls: { path: string; query: Record<string, unknown> }[];
  } {
    const calls: { path: string; query: Record<string, unknown> }[] = [];
    const getCollection = vi.fn(async (path: string, query: Record<string, unknown>) => {
      calls.push({ path, query });
      return { data: perPath[path] ?? [], truncated: false };
    });
    return {
      client: { getCollection } as unknown as { getCollection: ReturnType<typeof vi.fn> },
      calls,
    };
  }

  it('--no-heartrate (no_heartrate option) skips the heartrate sync entirely', async () => {
    const fakeData: Record<string, unknown[]> = {
      '/usercollection/daily_sleep': [],
      '/usercollection/daily_readiness': [],
      '/usercollection/daily_activity': [],
      '/usercollection/daily_spo2': [],
      '/usercollection/daily_stress': [],
      '/usercollection/daily_resilience': [],
      '/usercollection/daily_cardiovascular_age': [],
      '/usercollection/vO2_max': [],
      '/usercollection/sleep_time': [],
      '/usercollection/sleep': [],
      '/usercollection/workout': [],
      '/usercollection/session': [],
      '/usercollection/rest_mode_period': [],
      '/usercollection/enhanced_tag': [],
      '/usercollection/heartrate': [
        { timestamp: '2026-05-08T08:00:00+00:00', source: 'awake', bpm: 72 },
      ],
    };
    const { client, calls } = makeFakeClient(fakeData);

    const result = await runSync(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, db },
      { no_heartrate: true, todayUtc: '2026-05-09' },
    );

    // 14 collections succeeded, heartrate was not in the result list at all.
    expect(result.collections).toHaveLength(14);
    expect(result.collections.find((c) => c.collection === 'heartrate')).toBeUndefined();

    // No /usercollection/heartrate API calls were made.
    expect(calls.filter((c) => c.path === '/usercollection/heartrate')).toHaveLength(0);

    // And the local table is empty.
    const repo = new HeartrateRepo(db);
    expect(repo.maxTimestamp()).toBeNull();
  });

  it('heartrate sync uses datetime params, smaller 30-day chunks, and a higher pageLimit', async () => {
    const fakeData: Record<string, unknown[]> = {
      '/usercollection/daily_sleep': [],
      '/usercollection/daily_readiness': [],
      '/usercollection/daily_activity': [],
      '/usercollection/daily_spo2': [],
      '/usercollection/daily_stress': [],
      '/usercollection/daily_resilience': [],
      '/usercollection/daily_cardiovascular_age': [],
      '/usercollection/vO2_max': [],
      '/usercollection/sleep_time': [],
      '/usercollection/sleep': [],
      '/usercollection/workout': [],
      '/usercollection/session': [],
      '/usercollection/rest_mode_period': [],
      '/usercollection/enhanced_tag': [],
      '/usercollection/heartrate': [
        { timestamp: '2026-05-08T08:00:00+00:00', source: 'awake', bpm: 72 },
      ],
    };
    const { client, calls } = makeFakeClient(fakeData);

    await runSync(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, db },
      { todayUtc: '2026-05-09' },
    );

    const heartrateCalls = calls.filter((c) => c.path === '/usercollection/heartrate');
    // 30-day default first-run window splits into 2 chunks under the
    // 30-day-max-per-request cap (30-day inclusive span > 29-day chunk
    // window). All datetimes use the T00/T23:59 day-boundary form.
    expect(heartrateCalls).toHaveLength(2);
    for (const c of heartrateCalls) {
      const q = c.query as { start_datetime: string; end_datetime: string };
      expect(q.start_datetime).toMatch(/T00:00:00Z$/);
      expect(q.end_datetime).toMatch(/T23:59:59Z$/);
    }
  });

  it('a 60-day heartrate sync produces 3 chunks of ≤30 days each', async () => {
    const fakeData: Record<string, unknown[]> = {
      '/usercollection/daily_sleep': [],
      '/usercollection/daily_readiness': [],
      '/usercollection/daily_activity': [],
      '/usercollection/daily_spo2': [],
      '/usercollection/daily_stress': [],
      '/usercollection/daily_resilience': [],
      '/usercollection/daily_cardiovascular_age': [],
      '/usercollection/vO2_max': [],
      '/usercollection/sleep_time': [],
      '/usercollection/sleep': [],
      '/usercollection/workout': [],
      '/usercollection/session': [],
      '/usercollection/rest_mode_period': [],
      '/usercollection/enhanced_tag': [],
      '/usercollection/heartrate': [],
    };
    const { client, calls } = makeFakeClient(fakeData);
    await runSync(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, db },
      { since_days: 60, todayUtc: '2026-05-09' },
    );
    const heartrateCalls = calls.filter((c) => c.path === '/usercollection/heartrate');
    // 60-day span at 30-day chunk size → 2 full 30-day chunks + 1 boundary
    // 1-day chunk = 3 chunks total. Each chunk's window is ≤30 days, well
    // under Oura's "≤30 days" cap.
    expect(heartrateCalls).toHaveLength(3);
    // For comparison, daily_sleep (90-day max) handles 60 days in 1 chunk.
    expect(calls.filter((c) => c.path === '/usercollection/daily_sleep')).toHaveLength(1);
  });
});
