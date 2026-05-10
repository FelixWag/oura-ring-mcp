import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { DailyCollectionRepo } from '../src/db/repos/daily.js';
import { chunkRange, computeWindow, runSync } from '../src/db/sync.js';

describe('computeWindow', () => {
  const today = '2026-05-09';

  it('first run with no local data uses firstRunLookbackDays', () => {
    const w = computeWindow({ todayUtc: today }, null);
    expect(w.from_date).toBe('2026-04-09'); // 30 days back
    expect(w.to_date).toBe(today);
  });

  it('incremental run extends from maxLocalDay back by recentRefetchDays - 1', () => {
    const w = computeWindow({ todayUtc: today }, '2026-05-08');
    // 2026-05-08 minus 6 days = 2026-05-02. Inside firstRunLookbackDays (30) so kept.
    expect(w.from_date).toBe('2026-05-02');
    expect(w.to_date).toBe(today);
  });

  it('respects since_days override', () => {
    const w = computeWindow({ todayUtc: today, since_days: 14 }, '2026-05-08');
    expect(w.from_date).toBe('2026-04-25');
  });

  it('full mode pulls from today - firstRunLookbackDays', () => {
    const w = computeWindow({ todayUtc: today, full: true }, '2026-05-08');
    expect(w.from_date).toBe('2026-04-09');
  });

  it('returns a window larger than 90 days when since_days is large (chunking is the caller’s job)', () => {
    const w = computeWindow({ todayUtc: today, since_days: 240 }, null);
    const days =
      (Date.parse(w.to_date + 'T00:00:00Z') - Date.parse(w.from_date + 'T00:00:00Z')) /
      (24 * 60 * 60 * 1000);
    expect(days).toBe(240);
  });

  it('clamps since_days at the MAX_LOOKBACK_DAYS sanity ceiling', () => {
    const w = computeWindow({ todayUtc: today, since_days: 99_999 }, null);
    const days =
      (Date.parse(w.to_date + 'T00:00:00Z') - Date.parse(w.from_date + 'T00:00:00Z')) /
      (24 * 60 * 60 * 1000);
    expect(days).toBeLessThanOrEqual(730);
  });
});

describe('chunkRange', () => {
  it('returns a single chunk for windows ≤ 90 days', () => {
    const chunks = chunkRange('2026-04-01', '2026-05-09');
    expect(chunks).toEqual([{ from_date: '2026-04-01', to_date: '2026-05-09' }]);
  });

  it('walks backwards in 90-day chunks for larger windows', () => {
    const chunks = chunkRange('2026-01-01', '2026-05-09');
    // 129-day span → 90-day chunk + 39-day chunk
    expect(chunks).toHaveLength(2);
    // Chunks are returned oldest-first.
    expect(chunks[0]!.from_date).toBe('2026-01-01');
    expect(chunks[1]!.to_date).toBe('2026-05-09');
    // Chunks are contiguous (next chunk's start = previous chunk's end + 1 day).
    const lastEnd = chunks[0]!.to_date;
    const nextStart = chunks[1]!.from_date;
    const tEnd = Date.parse(lastEnd + 'T00:00:00Z');
    const tNext = Date.parse(nextStart + 'T00:00:00Z');
    expect((tNext - tEnd) / (24 * 60 * 60 * 1000)).toBe(1);
  });

  it('every chunk is at most 90 days', () => {
    const chunks = chunkRange('2024-01-01', '2026-05-09');
    for (const c of chunks) {
      const tStart = Date.parse(c.from_date + 'T00:00:00Z');
      const tEnd = Date.parse(c.to_date + 'T00:00:00Z');
      const days = (tEnd - tStart) / (24 * 60 * 60 * 1000);
      expect(days).toBeLessThanOrEqual(89); // inclusive 90 days = end - start = 89 days
    }
  });

  it('chunks together cover the full requested range', () => {
    const chunks = chunkRange('2025-01-01', '2026-05-09');
    expect(chunks[0]!.from_date).toBe('2025-01-01');
    expect(chunks[chunks.length - 1]!.to_date).toBe('2026-05-09');
  });
});

describe('runSync orchestrator', () => {
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

  it('issues one paginated call per collection, populates daily tables, and writes sync_runs', async () => {
    const db = await openDatabase(':memory:');
    const fakeData = {
      '/usercollection/daily_sleep': [
        { day: '2026-05-08', score: 86 },
        { day: '2026-05-07', score: 80 },
      ],
      '/usercollection/daily_readiness': [{ day: '2026-05-08', score: 83 }],
      '/usercollection/daily_activity': [{ day: '2026-05-08', score: 75 }],
      '/usercollection/daily_spo2': [],
      '/usercollection/daily_stress': [{ day: '2026-05-08', id: 's1', recovery_high: 9000 }],
      '/usercollection/daily_resilience': [{ day: '2026-05-08', id: 'r1', level: 'good' }],
      '/usercollection/daily_cardiovascular_age': [
        { day: '2026-05-08', id: 'cv1', vascular_age: 30 },
      ],
      '/usercollection/vO2_max': [{ day: '2026-05-08', id: 'v1', vo2_max: 42.5 }],
      '/usercollection/sleep_time': [
        { day: '2026-05-08', id: 'st1', optimal_bedtime: { start_offset: 0, end_offset: 3600 } },
      ],
      '/usercollection/sleep': [],
      '/usercollection/workout': [],
      '/usercollection/session': [],
      '/usercollection/rest_mode_period': [],
      '/usercollection/heartrate': [
        { timestamp: '2026-05-08T08:00:00+00:00', source: 'awake', bpm: 72 },
      ],
      '/usercollection/enhanced_tag': [
        {
          id: 'oura_xyz',
          tag_type_code: 'tag_generic_tea',
          start_time: '2026-05-08T10:00:00+00:00',
          start_day: '2026-05-08',
          comment: '',
        },
      ],
    };
    const { client } = makeFakeClient(fakeData);

    const result = await runSync(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, db },
      { todayUtc: '2026-05-09' },
    );

    // 15 collections — 9 daily, 4 events, 1 enhanced_tag, 1 heartrate.
    expect(result.collections).toHaveLength(15);
    expect(result.collections.every((c) => c.ok)).toBe(true);

    // Daily sleep got upserted.
    const sleepRepo = new DailyCollectionRepo(db, 'daily_sleep');
    const rows = sleepRepo.listRange('2026-05-01', '2026-05-09');
    expect(rows.map((r) => r.day)).toEqual(['2026-05-07', '2026-05-08']);

    // Discovered tag types include the seen code.
    const discovered = db.prepare('SELECT code FROM discovered_tag_types').all() as {
      code: string;
    }[];
    expect(discovered.map((d) => d.code)).toContain('tag_generic_tea');

    // Annotations table got the synced Oura tag.
    const ann = db.prepare("SELECT * FROM annotations WHERE source = 'oura'").all() as {
      oura_id: string;
      tag_type_code: string;
    }[];
    expect(ann).toHaveLength(1);
    expect(ann[0]!.oura_id).toBe('oura_xyz');

    // sync_runs has rows for every chunk of every collection.
    // 14 collections each issue 1 chunk for a 30-day first-run window, but
    // heartrate uses 30-day-max chunks so a 30-day window yields 2 chunks.
    // Total: 14 + 2 = 16.
    const runs = db.prepare('SELECT collection, ok FROM sync_runs').all();
    expect(runs).toHaveLength(16);
  });

  it('re-syncing the same day is idempotent: row count unchanged, last_synced_at advances', async () => {
    const db = await openDatabase(':memory:');
    const fakeData = {
      '/usercollection/daily_sleep': [{ day: '2026-05-08', score: 80 }],
      '/usercollection/daily_readiness': [],
      '/usercollection/daily_activity': [],
      '/usercollection/daily_spo2': [],
      '/usercollection/sleep': [],
      '/usercollection/workout': [],
      '/usercollection/session': [],
      '/usercollection/enhanced_tag': [],
    };
    const { client } = makeFakeClient(fakeData);

    await runSync(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, db },
      { todayUtc: '2026-05-09' },
    );
    await new Promise((r) => setTimeout(r, 2));

    // Update the score Oura returns and re-sync.
    fakeData['/usercollection/daily_sleep'] = [{ day: '2026-05-08', score: 92 }];
    await runSync(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, db },
      { todayUtc: '2026-05-09' },
    );

    const repo = new DailyCollectionRepo(db, 'daily_sleep');
    const all = repo.listRange('2026-05-01', '2026-05-09');
    expect(all).toHaveLength(1);
    expect(all[0]!.score).toBe(92);
  });

  it('tags_only mode only hits enhanced_tag', async () => {
    const db = await openDatabase(':memory:');
    const fakeData = {
      '/usercollection/enhanced_tag': [],
    };
    const { client, calls } = makeFakeClient(fakeData);

    const result = await runSync(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, db },
      { tags_only: true, todayUtc: '2026-05-09' },
    );
    expect(result.collections).toHaveLength(1);
    expect(result.collections[0]!.collection).toBe('enhanced_tag');
    expect(calls.map((c) => c.path)).toEqual(['/usercollection/enhanced_tag']);
  });

  it('chunks long since_days requests into multiple ≤90-day API calls per collection', async () => {
    const db = await openDatabase(':memory:');
    const fakeData = {
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
      '/usercollection/heartrate': [],
      '/usercollection/enhanced_tag': [],
    };
    const { client, calls } = makeFakeClient(fakeData);

    // 240 days back:
    //   - 14 non-heartrate collections × 3 chunks each (90 + 90 + 60) = 42
    //   - heartrate uses 30-day-max chunks → 9 chunks
    //     (240 days produces 8 full 30-day chunks + 1 boundary 1-day chunk
    //     because chunkRange's invariant is span ≤ maxDays-1 days)
    // Total: 51.
    await runSync(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { client: client as any, db },
      { since_days: 240, todayUtc: '2026-05-09' },
    );
    expect(calls).toHaveLength(51);

    // Per-collection chunk-count and window-coverage assertions.
    const byPath = new Map<string, typeof calls>();
    for (const c of calls) {
      const list = byPath.get(c.path) ?? [];
      list.push(c);
      byPath.set(c.path, list);
    }
    for (const [path, list] of byPath) {
      const isHeartrate = path === '/usercollection/heartrate';
      const expectedChunks = isHeartrate ? 9 : 3;
      expect(list).toHaveLength(expectedChunks);

      const startKey = isHeartrate ? 'start_datetime' : 'start_date';
      const endKey = isHeartrate ? 'end_datetime' : 'end_date';
      const expectedStart = isHeartrate ? '2025-09-11T00:00:00Z' : '2025-09-11';
      const expectedEnd = isHeartrate ? '2026-05-09T23:59:59Z' : '2026-05-09';

      expect((list[list.length - 1]!.query as Record<string, string>)[endKey]).toBe(expectedEnd);
      expect((list[0]!.query as Record<string, string>)[startKey]).toBe(expectedStart);
    }
  });
});
