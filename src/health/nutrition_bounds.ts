/**
 * Plausibility bounds for a single meal's nutrients.
 *
 * `toCanonical()` fixes a wrong *label* — joules presented as kilocalories.
 * It cannot fix a wrong *number*, and from v0.10 the numbers come from a
 * vision model looking at a photograph rather than from a barcode or a
 * kitchen scale. A model that misreads a portion, drops a decimal, or
 * hallucinates an item produces a number that passes every existing check and
 * is simply false.
 *
 * That matters more here than it would elsewhere: this project's recurring
 * failure is not a crash, it is a plausible wrong number nobody questions —
 * a day that summed to 6,682,560 "kcal" went unnoticed because nothing looked
 * at it, and zero resistance training read as a behaviour problem for weeks.
 *
 * So the bounds are deliberately wide. They are a sanity filter against an
 * order-of-magnitude error, not a nutritional opinion about what a meal
 * should contain.
 */

export interface NutrientBound {
  /** Canonical unit, matching CANONICAL_UNITS in units.ts. */
  unit: string;
  /** Largest value that could still be one real meal. */
  max: number;
}

/**
 * Upper bounds per meal. A very large restaurant meal runs to roughly
 * 2,000-2,500 kcal, so these sit far above anything real while still
 * catching a factor-of-ten mistake.
 */
export const MEAL_BOUNDS: Readonly<Record<string, NutrientBound>> = {
  dietary_energy_consumed: { unit: 'kcal', max: 5000 },
  dietary_protein: { unit: 'g', max: 300 },
  dietary_carbohydrates: { unit: 'g', max: 800 },
  dietary_fat_total: { unit: 'g', max: 400 },
  dietary_fat_saturated: { unit: 'g', max: 200 },
  dietary_sugar: { unit: 'g', max: 500 },
  dietary_fiber: { unit: 'g', max: 150 },
  dietary_sodium: { unit: 'mg', max: 15000 },
  dietary_potassium: { unit: 'mg', max: 15000 },
  dietary_cholesterol: { unit: 'mg', max: 3000 },
  dietary_water: { unit: 'mL', max: 5000 },
};

/** How far a nutrient's energy contribution may stray from its stated total. */
const ENERGY_TOLERANCE = 0.35;

export interface BoundsViolation {
  nutrient: string;
  value: number;
  reason: string;
}

/**
 * Check one meal's totals. Returns every violation rather than the first, so
 * a rejection message can name all of them at once.
 */
export function validateMealTotals(totals: Readonly<Record<string, number>>): BoundsViolation[] {
  const violations: BoundsViolation[] = [];

  for (const [nutrient, value] of Object.entries(totals)) {
    const bound = MEAL_BOUNDS[nutrient];
    if (!bound) continue; // unknown nutrients pass through, as elsewhere

    if (!Number.isFinite(value)) {
      violations.push({ nutrient, value, reason: 'not a finite number' });
      continue;
    }
    if (value < 0) {
      // Nothing edible has negative protein. A sign flip is a parse error.
      violations.push({ nutrient, value, reason: 'negative' });
      continue;
    }
    if (value > bound.max) {
      violations.push({
        nutrient,
        value,
        reason: `above the per-meal ceiling of ${bound.max} ${bound.unit}`,
      });
    }
  }

  // Macros and calories are not independent: 4 kcal/g for protein and carbs,
  // 9 for fat. If they disagree badly, one of the numbers is wrong and there
  // is no way to tell which — so the meal is rejected rather than stored
  // half-right.
  const kcal = totals['dietary_energy_consumed'];
  const protein = totals['dietary_protein'] ?? 0;
  const carbs = totals['dietary_carbohydrates'] ?? 0;
  const fat = totals['dietary_fat_total'] ?? 0;
  if (typeof kcal === 'number' && kcal > 0 && protein + carbs + fat > 0) {
    const fromMacros = protein * 4 + carbs * 4 + fat * 9;
    const drift = Math.abs(fromMacros - kcal) / kcal;
    if (drift > ENERGY_TOLERANCE) {
      violations.push({
        nutrient: 'dietary_energy_consumed',
        value: kcal,
        reason:
          `disagrees with the macros by ${Math.round(drift * 100)}% ` +
          `(protein/carbs/fat imply ~${Math.round(fromMacros)} kcal)`,
      });
    }
  }

  return violations;
}

/** Saturated fat cannot exceed total fat, fibre and sugar cannot exceed carbs. */
export function validateMealConsistency(
  totals: Readonly<Record<string, number>>,
): BoundsViolation[] {
  const violations: BoundsViolation[] = [];
  const pairs: Array<[string, string]> = [
    ['dietary_fat_saturated', 'dietary_fat_total'],
    ['dietary_sugar', 'dietary_carbohydrates'],
    ['dietary_fiber', 'dietary_carbohydrates'],
  ];

  for (const [part, whole] of pairs) {
    const partValue = totals[part];
    const wholeValue = totals[whole];
    if (typeof partValue !== 'number' || typeof wholeValue !== 'number') continue;
    // A little slack: these are estimates, and rounding can invert a near-tie.
    if (partValue > wholeValue * 1.05 + 1) {
      violations.push({
        nutrient: part,
        value: partValue,
        reason: `exceeds ${whole} (${wholeValue})`,
      });
    }
  }

  return violations;
}
