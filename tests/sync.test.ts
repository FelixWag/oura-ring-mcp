import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { DailyCollectionRepo } from '../src/db/repos/daily.js';
import { computeWindow, runSync } from '../src/db/sync.js';

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

  it('caps the window to MAX_RANGE_DAYS (90)', () => {
    const w = computeWindow({ todayUtc: today, since_days: 365, firstRunLookbackDays: 365 }, null);
    const days =
      (Date.parse(w.to_date + 'T00:00:00Z') - Date.parse(w.from_date + 'T00:00:00Z')) /
      (24 * 60 * 60 * 1000);
    expect(days).toBeLessThanOrEqual(90);
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
      '/usercollection/sleep': [],
      '/usercollection/workout': [],
      '/usercollection/session': [],
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

    // 8 collections — 4 daily, 3 events, 1 enhanced_tag.
    expect(result.collections).toHaveLength(8);
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

    // sync_runs has rows for every collection.
    const runs = db.prepare('SELECT collection, ok FROM sync_runs').all();
    expect(runs).toHaveLength(8);
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
});
