/**
 * One canonical unit per sample type, and the conversions into it.
 *
 * Why this exists: the same nutrient arrived in different units from
 * different writers — dietary energy as both `kcal` and `J`, sodium and
 * cholesterol as both `mg` and `g`. Stored verbatim, `SUM(value)` silently
 * mixes them: one day's intake read as 6.68 million because 31 rows were
 * joules. Nothing downstream can detect that, because the number looks like
 * a number.
 *
 * So units are normalised on write. `raw` keeps whatever the source sent.
 */

/** The unit every row of a given sample type is stored in. */
export const CANONICAL_UNITS: Readonly<Record<string, string>> = {
  dietary_energy_consumed: 'kcal',
  dietary_carbohydrates: 'g',
  dietary_protein: 'g',
  dietary_fat_total: 'g',
  dietary_fat_saturated: 'g',
  dietary_sugar: 'g',
  dietary_fiber: 'g',
  dietary_sodium: 'mg',
  dietary_potassium: 'mg',
  dietary_cholesterol: 'mg',
  dietary_water: 'mL',
  body_mass: 'kg',
  lean_body_mass: 'kg',
  body_fat_percentage: '%',
  steps: 'count',
  active_energy_burned: 'kcal',
};

/**
 * Multipliers into the canonical unit, keyed `from->to`. Only conversions
 * that have actually been observed, or are one HealthKit setting away, are
 * listed: an unknown pair is left alone and reported rather than guessed at.
 */
const FACTORS: Readonly<Record<string, number>> = {
  // Energy. 1 kcal = 4184 J exactly (thermochemical), which is the factor
  // HealthKit itself uses — verified against 31 rows that arrived in both
  // units for the same instant, matching to the last decimal.
  'J->kcal': 1 / 4184,
  'kJ->kcal': 1 / 4.184,
  'cal->kcal': 1 / 1000,
  'kcal->J': 4184,
  // Mass.
  'g->mg': 1000,
  'mg->g': 1 / 1000,
  'kg->g': 1000,
  'g->kg': 1 / 1000,
  'mcg->mg': 1 / 1000,
  'µg->mg': 1 / 1000,
  // Volume.
  'L->mL': 1000,
  'mL->L': 1 / 1000,
  // Percent: HealthKit's percent unit is a fraction (0.25 for 25%).
  'fraction->%': 100,
};

export interface NormalizedValue {
  value: number;
  unit: string;
  /** Set when the value could not be converted, for the caller to report. */
  unconvertible?: string;
}

/**
 * Convert a sample into its canonical unit.
 *
 * Unknown sample types pass through untouched — the table is deliberately
 * generic and a new type shouldn't need a code change to be stored. An
 * unknown *conversion* for a known type is different: it's the exact shape
 * of the joules bug, so it's surfaced rather than silently accepted.
 */
export function toCanonical(sampleType: string, value: number, unit: string): NormalizedValue {
  const canonical = CANONICAL_UNITS[sampleType];
  if (!canonical) return { value, unit };

  const from = unit.trim();

  // Percent is checked BEFORE the matching-unit shortcut: HealthKit labels a
  // fraction '%' (0.25 for 25%), so the unit string agreeing proves nothing.
  if (canonical === '%') {
    return value <= 1
      ? { value: round2(value * 100), unit: '%' }
      : { value: round2(value), unit: '%' };
  }

  if (from === canonical) return { value: round2(value), unit: canonical };

  const factor = FACTORS[`${from}->${canonical}`];
  if (factor === undefined) {
    return { value, unit: from, unconvertible: `${from}->${canonical}` };
  }
  return { value: round2(value * factor), unit: canonical };
}

/**
 * Rounded because `value` participates in the dedupe key: float noise
 * (0.246 vs 0.246000000000000002 for one reading arriving by two routes)
 * otherwise stores the same sample twice.
 */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
