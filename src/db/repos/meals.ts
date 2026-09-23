/**
 * Meals: the eating event, its extractions, and the projection into
 * `health_samples`.
 *
 * Three rules hold this together, each of them paid for by an earlier bug:
 *
 * 1. **Confirmation gates projection.** An unconfirmed meal writes no
 *    `health_samples` rows at all — not flagged rows every consumer must
 *    remember to filter. A 0.4-confidence guess must not become intake.
 * 2. **But pending must stay visible.** Silence reads as "did not eat", and a
 *    day that looks like a deficit gets a "eat more" recommendation. Hence
 *    `pendingByDay()`: a day with pending meals is flagged, never averaged.
 * 3. **Projection deletes by `meal_id` first.** `INSERT OR IGNORE` is the
 *    idiom everywhere else in this codebase and is wrong here — see
 *    `project()`.
 */

import type { Db } from '../index.js';
import { toCanonical, CANONICAL_UNITS } from '../../health/units.js';
import {
  validateMealTotals,
  validateMealConsistency,
  type BoundsViolation,
} from '../../health/nutrition_bounds.js';

export type MealStatus = 'unconfirmed' | 'confirmed' | 'voided';
export type TzSource = 'exif' | 'configured' | 'user';
export type SourceKind = 'telegram' | 'voice' | 'manual' | 'healthkit';

export interface NewMeal {
  eaten_epoch: number;
  local_day: string;
  local_time: string;
  tz: string;
  tz_source: TzSource;
}

export interface NewExtraction {
  model: string;
  prompt_version: string;
  confidence?: number | null;
  description?: string | null;
  /** Nutrient totals keyed by sample_type, in whatever unit the model used. */
  totals: Record<string, number>;
  /** The unit each total arrived in, if not already canonical. */
  units?: Record<string, string>;
  raw_response?: string | null;
  items?: NewItem[];
}

export interface NewItem {
  name: string;
  portion_text?: string | null;
  grams?: number | null;
  food_id?: string | null;
  confidence?: number | null;
}

export interface MealRow {
  id: number;
  eaten_epoch: number;
  local_day: string;
  local_time: string;
  tz: string;
  tz_source: TzSource;
  status: MealStatus;
  current_extraction_id: number | null;
  confirmed_at: string | null;
  confirmed_via: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  prompt_message_id: number | null;
}

export class MealValidationError extends Error {
  constructor(readonly violations: BoundsViolation[]) {
    super(
      'meal rejected: ' +
        violations.map((v) => `${v.nutrient} ${v.value} — ${v.reason}`).join('; '),
    );
    this.name = 'MealValidationError';
  }
}

const NUTRIENT_TYPES = Object.keys(CANONICAL_UNITS).filter((t) => t.startsWith('dietary_'));

function nowIso(): string {
  return new Date().toISOString();
}

export class MealsRepo {
  constructor(private readonly db: Db) {}

  createMeal(meal: NewMeal): number {
    const info = this.db
      .prepare(
        `INSERT INTO meals (eaten_epoch, local_day, local_time, tz, tz_source, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'unconfirmed', ?)`,
      )
      .run(meal.eaten_epoch, meal.local_day, meal.local_time, meal.tz, meal.tz_source, nowIso());
    return Number(info.lastInsertRowid);
  }

  /**
   * Record an extraction and make it current. Totals are converted to
   * canonical units and checked against plausibility bounds *before* the row
   * exists: a model that drops a decimal or hallucinates a portion produces a
   * number that passes every other check and is simply false.
   *
   * Throws {@link MealValidationError} rather than storing a flagged row —
   * storing it would mean every future reader has to remember to check.
   */
  addExtraction(mealId: number, extraction: NewExtraction): number {
    const canonicalTotals: Record<string, number> = {};
    for (const [nutrient, rawValue] of Object.entries(extraction.totals)) {
      const unit = extraction.units?.[nutrient] ?? CANONICAL_UNITS[nutrient] ?? '';
      const converted = toCanonical(nutrient, rawValue, unit);
      canonicalTotals[nutrient] = converted.value;
    }

    const violations = [
      ...validateMealTotals(canonicalTotals),
      ...validateMealConsistency(canonicalTotals),
    ];
    if (violations.length > 0) throw new MealValidationError(violations);

    const tx = this.db.transaction(() => {
      const previous = this.db
        .prepare<
          [number],
          { current_extraction_id: number | null }
        >('SELECT current_extraction_id FROM meals WHERE id = ?')
        .get(mealId);

      const info = this.db
        .prepare(
          `INSERT INTO meal_extractions
             (meal_id, model, prompt_version, confidence, description, totals,
              raw_response, extracted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          mealId,
          extraction.model,
          extraction.prompt_version,
          extraction.confidence ?? null,
          extraction.description ?? null,
          JSON.stringify(canonicalTotals),
          extraction.raw_response ?? null,
          nowIso(),
        );
      const extractionId = Number(info.lastInsertRowid);

      // History is kept; the old row points at the new one.
      if (previous?.current_extraction_id) {
        this.db
          .prepare('UPDATE meal_extractions SET superseded_by = ? WHERE id = ?')
          .run(extractionId, previous.current_extraction_id);
      }

      const insertItem = this.db.prepare(
        `INSERT INTO meal_items
           (extraction_id, position, name, portion_text, grams, food_id, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      (extraction.items ?? []).forEach((item, index) => {
        insertItem.run(
          extractionId,
          index,
          item.name,
          item.portion_text ?? null,
          item.grams ?? null,
          item.food_id ?? null,
          item.confidence ?? null,
        );
      });

      this.db
        .prepare('UPDATE meals SET current_extraction_id = ? WHERE id = ?')
        .run(extractionId, mealId);

      return extractionId;
    });

    const extractionId = tx();

    // A confirmed meal that gets re-extracted keeps its projection in step.
    const meal = this.get(mealId);
    if (meal?.status === 'confirmed') this.project(mealId);

    return extractionId;
  }

  linkMedia(mealId: number, sourceKind: SourceKind, sourceId: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO meal_media (meal_id, source_kind, source_id) VALUES (?, ?, ?)`,
      )
      .run(mealId, sourceKind, sourceId);
  }

  /** Confirm a meal and project its current extraction into `health_samples`. */
  confirm(mealId: number, via: string): void {
    this.db
      .prepare(
        `UPDATE meals SET status = 'confirmed', confirmed_at = ?, confirmed_via = ?
          WHERE id = ? AND status <> 'voided'`,
      )
      .run(nowIso(), via, mealId);
    this.project(mealId);
  }

  /**
   * "That meal never happened." Distinct from superseding an extraction,
   * which means "that description was wrong". Removes the projection so the
   * numbers stop counting, keeps the row so the history is intact.
   */
  void(mealId: number, reason: string): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE meals SET status = 'voided', voided_at = ?, void_reason = ? WHERE id = ?`)
        .run(nowIso(), reason, mealId);
      this.db.prepare('DELETE FROM health_samples WHERE meal_id = ?').run(mealId);
    });
    tx();
  }

  /**
   * Rewrite this meal's rows in `health_samples`.
   *
   * The DELETE is mandatory and must not be replaced with `INSERT OR IGNORE`,
   * however tempting the codebase's prevailing idiom is. The unique index that
   * makes OR IGNORE safe elsewhere is `(sample_type, source_name, start_epoch,
   * ROUND(value,1))`, which cannot express a meal's identity: a corrected
   * total that rounds to a different value does not collide, so both rows
   * survive and the meal is counted twice in every daily SUM.
   *
   * Runs in one transaction — a half-projected meal is worse than an
   * unprojected one, because it looks complete.
   */
  project(mealId: number): number {
    const meal = this.get(mealId);
    if (!meal || meal.status !== 'confirmed' || !meal.current_extraction_id) {
      // Unconfirmed and voided meals contribute nothing. Callers rely on this
      // rather than filtering later.
      this.db.prepare('DELETE FROM health_samples WHERE meal_id = ?').run(mealId);
      return 0;
    }

    const extraction = this.db
      .prepare<[number], { totals: string }>('SELECT totals FROM meal_extractions WHERE id = ?')
      .get(meal.current_extraction_id);
    if (!extraction) return 0;

    const totals = JSON.parse(extraction.totals) as Record<string, number>;
    const startTime = isoFromEpoch(meal.eaten_epoch, meal.local_day, meal.local_time);
    const importedAt = nowIso();

    const insert = this.db.prepare(
      `INSERT INTO health_samples
         (sample_type, start_time, end_time, value, unit, source_name, imported_at, raw,
          start_epoch, end_epoch, local_day, local_time, meal_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let written = 0;
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM health_samples WHERE meal_id = ?').run(mealId);
      for (const nutrient of NUTRIENT_TYPES) {
        const value = totals[nutrient];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        insert.run(
          nutrient,
          startTime,
          startTime,
          value,
          CANONICAL_UNITS[nutrient] ?? '',
          'meal',
          importedAt,
          null,
          meal.eaten_epoch,
          meal.eaten_epoch,
          meal.local_day,
          meal.local_time,
          mealId,
        );
        written += 1;
      }
    });
    tx();

    return written;
  }

  /** Remember which bot message asked about this meal, so a reply can match it. */
  setPromptMessageId(mealId: number, messageId: number): void {
    this.db.prepare('UPDATE meals SET prompt_message_id = ? WHERE id = ?').run(messageId, mealId);
  }

  /**
   * Meals the user was never told about.
   *
   * Normally empty. It fills when the message itself failed — a dropped
   * network call on a flaky connection — and those meals would otherwise
   * count silently, with the user never having seen the estimate and so
   * never having had the chance to correct it.
   */
  awaitingPrompt(limit = 5): Array<{
    meal_id: number;
    totals: string;
    description: string | null;
    confidence: number | null;
  }> {
    return this.db
      .prepare<
        [number],
        { meal_id: number; totals: string; description: string | null; confidence: number | null }
      >(
        `SELECT m.id AS meal_id, e.totals AS totals, e.description AS description,
                e.confidence AS confidence
           FROM meals m
           JOIN meal_extractions e ON e.id = m.current_extraction_id
          WHERE m.status <> 'voided' AND m.prompt_message_id IS NULL
          ORDER BY m.id LIMIT ?`,
      )
      .all(limit);
  }

  get(mealId: number): MealRow | undefined {
    return this.db.prepare<[number], MealRow>('SELECT * FROM meals WHERE id = ?').get(mealId);
  }

  /**
   * Meals awaiting confirmation, grouped by day.
   *
   * This exists so that "no data" and "not yet confirmed" are distinguishable.
   * Without it an unconfirmed dinner makes the day look like a deficit, and
   * the nutrition specialist recommends eating more — the same misreading as
   * treating an under-logged day as under-eaten.
   */
  pendingByDay(fromDay: string, toDay: string): Array<{ local_day: string; pending: number }> {
    return this.db
      .prepare<[string, string], { local_day: string; pending: number }>(
        `SELECT local_day, COUNT(*) AS pending FROM meals
          WHERE status = 'unconfirmed' AND local_day BETWEEN ? AND ?
          GROUP BY local_day ORDER BY local_day`,
      )
      .all(fromDay, toDay);
  }

  /**
   * Days where nutrition came from more than one estimator.
   *
   * Not a schema problem — an operational one. A meal logged in a third-party
   * app AND photographed here is counted twice, because nothing filters
   * `health_samples` by `source_name`. This surfaces it the same day rather
   * than a month later.
   */
  overlappingSources(
    fromDay: string,
    toDay: string,
  ): Array<{ local_day: string; sources: string }> {
    return this.db
      .prepare<[string, string], { local_day: string; sources: string }>(
        `SELECT local_day, GROUP_CONCAT(DISTINCT source_name) AS sources
           FROM health_samples
          WHERE sample_type = 'dietary_energy_consumed' AND local_day BETWEEN ? AND ?
          GROUP BY local_day
         HAVING COUNT(DISTINCT source_name) > 1
          ORDER BY local_day`,
      )
      .all(fromDay, toDay);
  }
}

/**
 * Rebuild an ISO timestamp with the offset the meal was recorded under, so
 * `start_time` reads the same way as every other row in `health_samples`.
 */
function isoFromEpoch(epoch: number, localDay: string, localTime: string): string {
  const offsetMinutes = (Date.parse(`${localDay}T${localTime}Z`) - epoch * 1000) / 60000;
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(Math.round(abs % 60)).padStart(2, '0');
  return `${localDay}T${localTime}${sign}${hh}:${mm}`;
}
