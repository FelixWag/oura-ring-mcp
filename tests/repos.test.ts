import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/index.js';
import { DailyCollectionRepo } from '../src/db/repos/daily.js';
import { DiscoveredTagTypesRepo } from '../src/db/repos/discovered_tag_types.js';
import { EventCollectionRepo } from '../src/db/repos/events.js';
import { SyncRunsRepo } from '../src/db/repos/sync_runs.js';

let db: Db;

beforeEach(async () => {
  db = await openDatabase(':memory:');
});

describe('DailyCollectionRepo', () => {
  it('upserts on (table, day) — re-syncing same day overwrites and refreshes last_synced_at', async () => {
    const repo = new DailyCollectionRepo(db, 'daily_sleep');
    repo.upsert({ day: '2026-05-07', score: 70, contributors: { rem_sleep: 60 } });
    const first = repo.get('2026-05-07')!;
    expect(first.score).toBe(70);
    expect(first.first_seen_at).toBe(first.last_synced_at);

    // Tiny pause so last_synced_at strictly advances.
    await new Promise((r) => setTimeout(r, 2));
    repo.upsert({ day: '2026-05-07', score: 82, contributors: { rem_sleep: 96 } });
    const second = repo.get('2026-05-07')!;
    expect(second.score).toBe(82);
    expect(second.first_seen_at).toBe(first.first_seen_at); // preserved
    expect(second.last_synced_at).not.toBe(first.last_synced_at); // advanced
    expect((second.data as { contributors: { rem_sleep: number } }).contributors.rem_sleep).toBe(
      96,
    );
  });

  it('listRange returns rows sorted by day ascending', () => {
    const repo = new DailyCollectionRepo(db, 'daily_readiness');
    repo.upsert({ day: '2026-05-09', score: 80 });
    repo.upsert({ day: '2026-05-07', score: 75 });
    repo.upsert({ day: '2026-05-08', score: 78 });
    const rows = repo.listRange('2026-05-07', '2026-05-09');
    expect(rows.map((r) => r.day)).toEqual(['2026-05-07', '2026-05-08', '2026-05-09']);
  });

  it('maxDay returns the most recent day, or null when empty', () => {
    const repo = new DailyCollectionRepo(db, 'daily_activity');
    expect(repo.maxDay()).toBeNull();
    repo.upsert({ day: '2026-05-01', score: 60 });
    repo.upsert({ day: '2026-05-08', score: 80 });
    expect(repo.maxDay()).toBe('2026-05-08');
  });

  it('rejects rows missing a "day" field', () => {
    const repo = new DailyCollectionRepo(db, 'daily_sleep');
    expect(() => repo.upsert({ score: 70 })).toThrow(/day/);
  });

  it('upsertMany returns separate inserted/updated counts', () => {
    const repo = new DailyCollectionRepo(db, 'daily_sleep');
    repo.upsert({ day: '2026-05-01', score: 80 });
    const result = repo.upsertMany([
      { day: '2026-05-01', score: 85 }, // existing → updated
      { day: '2026-05-02', score: 70 }, // new → inserted
      { day: '2026-05-03', score: 75 }, // new → inserted
    ]);
    expect(result).toEqual({ inserted: 2, updated: 1 });
  });
});

describe('EventCollectionRepo', () => {
  it('keys on oura_id and derives day from event payload', () => {
    const repo = new EventCollectionRepo(db, 'workouts');
    repo.upsert({
      id: 'workout_a',
      day: '2026-05-08',
      activity: 'running',
      duration: 1800,
    });
    const all = repo.listRange('2026-05-01', '2026-05-31');
    expect(all).toHaveLength(1);
    expect(all[0]!.oura_id).toBe('workout_a');
    expect(all[0]!.day).toBe('2026-05-08');
  });

  it('falls back to start_datetime / bedtime_start when day is absent', () => {
    const repo = new EventCollectionRepo(db, 'sleep_periods');
    repo.upsert({
      id: 's1',
      bedtime_start: '2026-05-05T23:30:00+02:00',
      total_sleep_duration: 25_200,
    });
    expect(repo.listRange('2026-05-05', '2026-05-05')).toHaveLength(1);
  });

  it('rejects rows missing both id and day-deriving fields', () => {
    const repo = new EventCollectionRepo(db, 'sessions');
    expect(() => repo.upsert({ duration: 600 })).toThrow(/id/);
  });
});

describe('DiscoveredTagTypesRepo', () => {
  it('counts repeated observations and reports new codes only on first observe', () => {
    const repo = new DiscoveredTagTypesRepo(db);
    expect(repo.observe('tag_sleep_alcohol')).toBe(true);
    expect(repo.observe('tag_sleep_alcohol')).toBe(false);
    const all = repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.occurrence_count).toBe(2);
  });

  it('observeMany returns only the codes that were newly discovered', () => {
    const repo = new DiscoveredTagTypesRepo(db);
    repo.observe('tag_sleep_alcohol');
    const newly = repo.observeMany([
      'tag_sleep_alcohol',
      'tag_generic_tea',
      'tag_generic_airplane',
      'tag_generic_tea',
    ]);
    expect(newly.sort()).toEqual(['tag_generic_airplane', 'tag_generic_tea']);
  });

  it('has() reflects observations', () => {
    const repo = new DiscoveredTagTypesRepo(db);
    expect(repo.has('tag_generic_tea')).toBe(false);
    repo.observe('tag_generic_tea');
    expect(repo.has('tag_generic_tea')).toBe(true);
  });
});

describe('SyncRunsRepo', () => {
  it('records start, finishOk, and lastSuccessAt', async () => {
    const repo = new SyncRunsRepo(db);
    const id = repo.start('daily_sleep', '2026-05-01', '2026-05-09');
    await new Promise((r) => setTimeout(r, 2));
    repo.finishOk(id, 9);
    const at = repo.lastSuccessAt('daily_sleep');
    expect(at).toBeTruthy();
    const recent = repo.recent(5);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.ok).toBe(1);
    expect(recent[0]!.rows_upserted).toBe(9);
  });

  it('finishError stores a truncated error string', () => {
    const repo = new SyncRunsRepo(db);
    const id = repo.start('workouts', '2026-05-01', '2026-05-09');
    repo.finishError(id, 'kaboom');
    const recent = repo.recent(1)[0]!;
    expect(recent.ok).toBe(0);
    expect(recent.error).toBe('kaboom');
    expect(repo.lastSuccessAt('workouts')).toBeNull();
  });
});

describe('Annotation validator with discovered codes', () => {
  it('accepts codes that are absent from the static list but present in discovered_tag_types', async () => {
    const { AnnotationRepo } = await import('../src/db/annotations.js');
    const annRepo = new AnnotationRepo(db);
    const discovered = new DiscoveredTagTypesRepo(db);
    const newCode = 'tag_generic_some_unseen_code';

    expect(() =>
      annRepo.add({
        tag_type_code: newCode,
        start_time: '2026-05-09T10:00:00Z',
        start_day: '2026-05-09',
      }),
    ).toThrow(/Unknown tag_type_code/);

    discovered.observe(newCode);

    const row = annRepo.add({
      tag_type_code: newCode,
      start_time: '2026-05-09T10:00:00Z',
      start_day: '2026-05-09',
    });
    expect(row.tag_type_code).toBe(newCode);
  });
});
