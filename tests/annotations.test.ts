import { beforeEach, describe, expect, it } from 'vitest';
import { AnnotationRepo, AnnotationValidationError } from '../src/db/annotations.js';
import { openDatabase, type Db } from '../src/db/index.js';

let db: Db;
let repo: AnnotationRepo;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  repo = new AnnotationRepo(db);
});

describe('AnnotationRepo.add', () => {
  it('inserts a known-type annotation and returns the row', () => {
    const row = repo.add({
      tag_type_code: 'tag_sleep_alcohol',
      start_time: '2026-05-02T22:00:00Z',
      start_day: '2026-05-02',
      comment: '2 beers',
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.tag_type_code).toBe('tag_sleep_alcohol');
    expect(row.source).toBe('local');
    expect(row.created_at).toBeTruthy();
    expect(row.created_at).toBe(row.updated_at);
  });

  it('accepts a multi-day annotation with end_day and end_time', () => {
    const row = repo.add({
      tag_type_code: 'tag_generic_airplane',
      start_time: '2026-05-10T08:00:00Z',
      end_time: '2026-05-12T20:00:00Z',
      start_day: '2026-05-10',
      end_day: '2026-05-12',
      comment: 'Berlin trip',
    });
    expect(row.end_day).toBe('2026-05-12');
    expect(row.end_time).toBe('2026-05-12T20:00:00Z');
  });

  it('rejects an unknown tag_type_code with a useful message', () => {
    expect(() =>
      repo.add({
        tag_type_code: 'not_a_real_oura_code',
        start_time: '2026-05-02T22:00:00Z',
        start_day: '2026-05-02',
      }),
    ).toThrow(AnnotationValidationError);
  });

  it('requires custom_name when tag_type_code is "custom"', () => {
    expect(() =>
      repo.add({
        tag_type_code: 'custom',
        start_time: '2026-05-02T22:00:00Z',
        start_day: '2026-05-02',
      }),
    ).toThrow(/custom_name/);
  });

  it('accepts text-only annotations (tag_type_code=null) with a comment', () => {
    const row = repo.add({
      tag_type_code: null,
      start_time: '2026-05-02T10:00:00Z',
      start_day: '2026-05-02',
      comment: 'Felt great after morning walk',
    });
    expect(row.tag_type_code).toBeNull();
    expect(row.comment).toBe('Felt great after morning walk');
  });

  it('rejects text-only annotations without a comment', () => {
    expect(() =>
      repo.add({
        tag_type_code: null,
        start_time: '2026-05-02T10:00:00Z',
        start_day: '2026-05-02',
      }),
    ).toThrow(/comment/);
  });

  it('rejects end_day before start_day', () => {
    expect(() =>
      repo.add({
        tag_type_code: 'tag_generic_airplane',
        start_time: '2026-05-10T08:00:00Z',
        start_day: '2026-05-10',
        end_day: '2026-05-09',
        comment: 'wrong',
      }),
    ).toThrow(/end_day/);
  });

  it('honors source="oura" with an oura_id', () => {
    const row = repo.add({
      tag_type_code: 'tag_generic_tea',
      start_time: '2026-05-02T07:00:00Z',
      start_day: '2026-05-02',
      source: 'oura',
      oura_id: 'oura_abc123',
    });
    expect(row.source).toBe('oura');
    expect(row.oura_id).toBe('oura_abc123');
  });

  it('rejects source="oura" without an oura_id', () => {
    expect(() =>
      repo.add({
        tag_type_code: 'tag_generic_tea',
        start_time: '2026-05-02T07:00:00Z',
        start_day: '2026-05-02',
        source: 'oura',
      }),
    ).toThrow(/oura_id/);
  });
});

describe('AnnotationRepo.list', () => {
  beforeEach(() => {
    repo.add({
      tag_type_code: 'tag_sleep_alcohol',
      start_time: '2026-05-01T22:00:00Z',
      start_day: '2026-05-01',
      comment: 'wine',
    });
    repo.add({
      tag_type_code: 'tag_generic_diarrhea',
      start_time: '2026-05-03T10:00:00Z',
      start_day: '2026-05-03',
    });
    repo.add({
      tag_type_code: 'tag_sleep_alcohol',
      start_time: '2026-05-05T20:00:00Z',
      start_day: '2026-05-05',
      comment: 'beer',
    });
    repo.add({
      tag_type_code: 'tag_generic_tea',
      start_time: '2026-05-06T07:00:00Z',
      start_day: '2026-05-06',
      source: 'oura',
      oura_id: 'oura_x',
    });
  });

  it('returns all rows sorted by start_day ASC when no filter', () => {
    const rows = repo.list();
    expect(rows.map((r) => r.start_day)).toEqual([
      '2026-05-01',
      '2026-05-03',
      '2026-05-05',
      '2026-05-06',
    ]);
  });

  it('filters by start_date / end_date inclusively', () => {
    const rows = repo.list({ start_date: '2026-05-03', end_date: '2026-05-05' });
    expect(rows.map((r) => r.start_day)).toEqual(['2026-05-03', '2026-05-05']);
  });

  it('filters by tag_type_code', () => {
    const rows = repo.list({ tag_type_code: 'tag_sleep_alcohol' });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tag_type_code === 'tag_sleep_alcohol')).toBe(true);
  });

  it('filters by source', () => {
    expect(repo.list({ source: 'oura' })).toHaveLength(1);
    expect(repo.list({ source: 'local' })).toHaveLength(3);
  });
});

describe('AnnotationRepo.update', () => {
  it('partially updates and re-validates', async () => {
    const row = repo.add({
      tag_type_code: 'tag_sleep_alcohol',
      start_time: '2026-05-02T22:00:00Z',
      start_day: '2026-05-02',
      comment: '1 beer',
    });
    // Tiny pause so updated_at strictly advances past created_at (ISO has ms resolution).
    await new Promise((r) => setTimeout(r, 2));
    const updated = repo.update(row.id, { comment: '2 beers (corrected)' });
    expect(updated?.comment).toBe('2 beers (corrected)');
    expect(updated?.tag_type_code).toBe('tag_sleep_alcohol'); // unchanged
    expect(updated?.updated_at).not.toBe(row.updated_at);
  });

  it('rejects updates that would invalidate the row', () => {
    const row = repo.add({
      tag_type_code: 'custom',
      custom_name: 'jet_lag',
      start_time: '2026-05-02T10:00:00Z',
      start_day: '2026-05-02',
    });
    // Trying to drop custom_name while keeping tag_type_code='custom' must fail.
    expect(() => repo.update(row.id, { custom_name: null })).toThrow(/custom_name/);
  });

  it('returns null when id does not exist', () => {
    expect(repo.update(99_999, { comment: 'x' })).toBeNull();
  });
});

describe('AnnotationRepo.delete', () => {
  it('returns true when a row was deleted, false otherwise', () => {
    const row = repo.add({
      tag_type_code: 'tag_sleep_alcohol',
      start_time: '2026-05-02T22:00:00Z',
      start_day: '2026-05-02',
      comment: 'wine',
    });
    expect(repo.delete(row.id)).toBe(true);
    expect(repo.get(row.id)).toBeNull();
    expect(repo.delete(row.id)).toBe(false);
  });
});
