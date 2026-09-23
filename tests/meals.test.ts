/**
 * Meals: confirmation, projection, supersession, and the failures each rule
 * exists to prevent.
 *
 * Synthetic fixtures only — the repo is public.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/index.js';
import { MealsRepo, MealValidationError } from '../src/db/repos/meals.ts';
import { validateMealTotals, validateMealConsistency } from '../src/health/nutrition_bounds.ts';

let db: Db;
let repo: MealsRepo;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  repo = new MealsRepo(db);
});

const MEAL = {
  eaten_epoch: 1_767_225_000,
  local_day: '2026-01-01',
  local_time: '12:30:00',
  tz: 'Europe/Vienna',
  tz_source: 'configured' as const,
};

/** Internally consistent totals: macros imply roughly the stated calories. */
function totals(overrides: Record<string, number> = {}): Record<string, number> {
  return {
    dietary_energy_consumed: 640,
    dietary_protein: 44,
    dietary_carbohydrates: 71,
    dietary_fat_total: 19,
    dietary_fat_saturated: 5,
    dietary_sugar: 8,
    dietary_fiber: 6,
    dietary_sodium: 890,
    dietary_potassium: 700,
    dietary_cholesterol: 95,
    ...overrides,
  };
}

function extraction(overrides: Record<string, unknown> = {}) {
  return {
    model: 'test-model',
    prompt_version: 'v1',
    confidence: 0.72,
    description: 'chicken bowl',
    totals: totals(),
    ...overrides,
  };
}

function nutritionRows(mealId?: number): number {
  const sql =
    mealId === undefined
      ? 'SELECT COUNT(*) AS n FROM health_samples'
      : `SELECT COUNT(*) AS n FROM health_samples WHERE meal_id = ${mealId}`;
  return (db.prepare(sql).get() as { n: number }).n;
}

describe('confirmation gates projection', () => {
  it('writes nothing until the meal is confirmed', () => {
    // A 0.7-confidence guess must not silently become intake.
    const mealId = repo.createMeal(MEAL);
    repo.addExtraction(mealId, extraction());

    expect(nutritionRows()).toBe(0);
  });

  it('projects one row per nutrient on confirmation', () => {
    const mealId = repo.createMeal(MEAL);
    repo.addExtraction(mealId, extraction());
    repo.confirm(mealId, 'telegram');

    expect(nutritionRows(mealId)).toBe(10);
    const kcal = db
      .prepare(
        "SELECT value, unit, local_day, meal_id FROM health_samples WHERE sample_type='dietary_energy_consumed'",
      )
      .get() as { value: number; unit: string; local_day: string; meal_id: number };
    expect(kcal).toMatchObject({
      value: 640,
      unit: 'kcal',
      local_day: '2026-01-01',
      meal_id: mealId,
    });
  });

  it('keeps a pending meal visible, so silence is not read as "did not eat"', () => {
    // The failure this prevents: an unconfirmed dinner makes the day look
    // like a deficit, and the nutrition agent recommends eating more.
    const mealId = repo.createMeal(MEAL);
    repo.addExtraction(mealId, extraction());

    expect(repo.pendingByDay('2026-01-01', '2026-01-01')).toEqual([
      { local_day: '2026-01-01', pending: 1 },
    ]);

    repo.confirm(mealId, 'telegram');
    expect(repo.pendingByDay('2026-01-01', '2026-01-01')).toEqual([]);
  });
});

describe('re-extraction', () => {
  it('replaces the projection instead of adding to it', () => {
    // THE BUG THIS PINS: with INSERT OR IGNORE, a corrected total that rounds
    // to a different value does not collide, so both rows survive and the
    // meal is counted twice in every daily SUM.
    const mealId = repo.createMeal(MEAL);
    repo.addExtraction(mealId, extraction());
    repo.confirm(mealId, 'telegram');

    repo.addExtraction(
      mealId,
      extraction({
        model: 'better-model',
        totals: totals({
          dietary_energy_consumed: 820,
          dietary_protein: 60,
          dietary_carbohydrates: 90,
          dietary_fat_total: 25,
        }),
      }),
    );

    expect(nutritionRows(mealId)).toBe(10); // not 20
    const kcal = db
      .prepare("SELECT value FROM health_samples WHERE sample_type='dietary_energy_consumed'")
      .get() as { value: number };
    expect(kcal.value).toBe(820);
  });

  it('keeps the old extraction and points it at the new one', () => {
    const mealId = repo.createMeal(MEAL);
    const first = repo.addExtraction(mealId, extraction());
    const second = repo.addExtraction(mealId, extraction({ model: 'better-model' }));

    const rows = db
      .prepare('SELECT id, superseded_by FROM meal_extractions ORDER BY id')
      .all() as Array<{ id: number; superseded_by: number | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: first, superseded_by: second });
    expect(rows[1]?.superseded_by).toBeNull();
  });

  it('gives the new extraction its own items', () => {
    const mealId = repo.createMeal(MEAL);
    repo.addExtraction(mealId, extraction({ items: [{ name: 'rice', portion_text: '1 cup' }] }));
    repo.addExtraction(
      mealId,
      extraction({ items: [{ name: 'brown rice', portion_text: '1.5 cups' }] }),
    );

    const items = db.prepare('SELECT name FROM meal_items ORDER BY id').all() as Array<{
      name: string;
    }>;
    expect(items.map((i) => i.name)).toEqual(['rice', 'brown rice']);
  });
});

describe('two distinct meals', () => {
  it('keeps both even when their nutrients are identical', () => {
    // The other direction of the same index problem: two identical snacks at
    // the same instant collided on (sample_type, source_name, start_epoch,
    // ROUND(value,1)) and INSERT OR IGNORE dropped one SILENTLY.
    const first = repo.createMeal(MEAL);
    repo.addExtraction(first, extraction());
    repo.confirm(first, 'telegram');

    const second = repo.createMeal(MEAL); // same epoch, same day
    repo.addExtraction(second, extraction());
    repo.confirm(second, 'telegram');

    expect(nutritionRows(first)).toBe(10);
    expect(nutritionRows(second)).toBe(10);
    const total = db
      .prepare(
        "SELECT SUM(value) AS kcal FROM health_samples WHERE sample_type='dietary_energy_consumed'",
      )
      .get() as { kcal: number };
    expect(total.kcal).toBe(1280);
  });
});

describe('voiding', () => {
  it('removes the numbers but keeps the record', () => {
    // Supersession means "that description was wrong"; voiding means "that
    // meal never happened" — a hallucinated item or someone else's plate.
    const mealId = repo.createMeal(MEAL);
    repo.addExtraction(mealId, extraction());
    repo.confirm(mealId, 'telegram');
    expect(nutritionRows(mealId)).toBe(10);

    repo.void(mealId, 'not my plate');

    expect(nutritionRows(mealId)).toBe(0);
    expect(repo.get(mealId)).toMatchObject({ status: 'voided', void_reason: 'not my plate' });
  });

  it('refuses to be re-confirmed back into the data', () => {
    const mealId = repo.createMeal(MEAL);
    repo.addExtraction(mealId, extraction());
    repo.void(mealId, 'test photo');
    repo.confirm(mealId, 'telegram');

    expect(nutritionRows(mealId)).toBe(0);
    expect(repo.get(mealId)?.status).toBe('voided');
  });
});

describe('units and plausibility', () => {
  it('converts a model that answered in the wrong unit', () => {
    const mealId = repo.createMeal(MEAL);
    repo.addExtraction(
      mealId,
      extraction({
        totals: totals({ dietary_energy_consumed: 2677760 }),
        units: { dietary_energy_consumed: 'J' },
      }),
    );
    repo.confirm(mealId, 'telegram');

    const kcal = db
      .prepare("SELECT value, unit FROM health_samples WHERE sample_type='dietary_energy_consumed'")
      .get() as { value: number; unit: string };
    expect(kcal.value).toBeCloseTo(640, 0);
    expect(kcal.unit).toBe('kcal');
  });

  it('rejects an implausible meal instead of storing it flagged', () => {
    // toCanonical fixes a wrong label; it cannot fix a wrong number, and a
    // model now produces the numbers.
    const mealId = repo.createMeal(MEAL);

    expect(() =>
      repo.addExtraction(
        mealId,
        extraction({ totals: totals({ dietary_energy_consumed: 50000 }) }),
      ),
    ).toThrow(MealValidationError);

    expect(db.prepare('SELECT COUNT(*) AS n FROM meal_extractions').get()).toMatchObject({ n: 0 });
  });

  it('rejects a negative value', () => {
    const mealId = repo.createMeal(MEAL);
    expect(() =>
      repo.addExtraction(mealId, extraction({ totals: totals({ dietary_protein: -5 }) })),
    ).toThrow(MealValidationError);
  });

  it('catches calories that disagree with the macros', () => {
    // A dropped decimal in one field leaves the others self-consistent.
    const violations = validateMealTotals(totals({ dietary_energy_consumed: 64 }));
    expect(violations.some((v) => v.reason.includes('disagrees with the macros'))).toBe(true);
  });

  it('catches saturated fat exceeding total fat', () => {
    const violations = validateMealConsistency(
      totals({ dietary_fat_total: 10, dietary_fat_saturated: 30 }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.nutrient).toBe('dietary_fat_saturated');
  });

  it('accepts a plausible meal', () => {
    expect(validateMealTotals(totals())).toEqual([]);
    expect(validateMealConsistency(totals())).toEqual([]);
  });
});

describe('double-logging across estimators', () => {
  it('flags a day whose nutrition came from two sources', () => {
    // Not a schema problem, an operational one: a meal logged in another app
    // AND photographed here is counted twice, because nothing filters
    // health_samples by source_name.
    const mealId = repo.createMeal(MEAL);
    repo.addExtraction(mealId, extraction());
    repo.confirm(mealId, 'telegram');

    db.prepare(
      `INSERT INTO health_samples
         (sample_type, start_time, end_time, value, unit, source_name, imported_at,
          start_epoch, end_epoch, local_day, local_time)
       VALUES ('dietary_energy_consumed', '2026-01-01T19:00:00+01:00',
               '2026-01-01T19:00:00+01:00', 700, 'kcal', 'OtherApp', '2026-01-01T19:05:00Z',
               1767250800, 1767250800, '2026-01-01', '19:00:00')`,
    ).run();

    const overlaps = repo.overlappingSources('2026-01-01', '2026-01-01');
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.sources).toContain('meal');
    expect(overlaps[0]?.sources).toContain('OtherApp');
  });
});

describe('provenance', () => {
  it('links several source messages to one meal', () => {
    // An album is many messages and one breakfast.
    const mealId = repo.createMeal(MEAL);
    repo.linkMedia(mealId, 'telegram', 11);
    repo.linkMedia(mealId, 'telegram', 12);
    repo.linkMedia(mealId, 'telegram', 12); // idempotent

    const rows = db
      .prepare('SELECT source_id FROM meal_media WHERE meal_id = ? ORDER BY source_id')
      .all(mealId) as Array<{ source_id: number }>;
    expect(rows.map((r) => r.source_id)).toEqual([11, 12]);
  });
});
