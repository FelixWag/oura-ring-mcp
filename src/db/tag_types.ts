/**
 * Canonical Oura `tag_type_code` values.
 *
 * The OpenAPI spec only types this field as `string | null`, but in practice
 * the Oura mobile app picks from a fixed enum. We seed our local annotation
 * validation with a shortlist of common codes; v0.4 will add a sync that
 * pulls the user's actual enhanced_tag history and refreshes this list
 * dynamically (so the canonical set tracks reality, not guesses).
 *
 * Inputs that don't match a known code can still be stored, but only via
 * `tag_type_code = 'custom'` plus a required `custom_name` — exactly how
 * Oura's own UI handles it.
 *
 * If you discover an Oura code missing from this list, append it here and
 * open a PR. Order doesn't matter; the `Set` lookup is what's used.
 */
export const KNOWN_TAG_TYPE_CODES = [
  // Substances
  'alcohol',
  'caffeine',
  'nicotine',
  // Wellbeing & state
  'sick',
  'stressed',
  'mood_good',
  'mood_bad',
  // Lifestyle
  'traveled',
  'ate_late',
  'napped',
  'meditated',
  // Activity
  'workout',
  // Cycle / reproductive
  'period',
  'intercourse',
] as const;

export type KnownTagTypeCode = (typeof KNOWN_TAG_TYPE_CODES)[number];

const KNOWN_SET = new Set<string>(KNOWN_TAG_TYPE_CODES);

export function isKnownTagTypeCode(code: string): code is KnownTagTypeCode {
  return KNOWN_SET.has(code);
}

/** Returns the full set of accepted values for `tag_type_code` inputs. */
export function acceptedTagTypeCodes(): readonly string[] {
  return [...KNOWN_TAG_TYPE_CODES, 'custom'];
}
