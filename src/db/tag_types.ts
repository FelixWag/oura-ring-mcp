/**
 * Canonical Oura `tag_type_code` values.
 *
 * The Oura API does not expose a "list all tag types" endpoint, so this file
 * is the source of truth for what we accept on local annotations.
 *
 * ## Two-prefix scheme (observed in real data)
 *
 *   tag_sleep_*    — events / states framed as sleep impact
 *                    (alcohol, late_meal, sauna, stress, sleep environment, …)
 *   tag_generic_*  — everything else
 *                    (activities, foods, drinks, social, illness, mood, medical, …)
 *
 * Same physical thing can map to either depending on framing, e.g.:
 *   - "I had a beer"  →  tag_generic_beer
 *   - "alcohol affected my sleep"  →  tag_sleep_alcohol
 *
 * The Oura mobile app exposes both as separate tags. Both can co-occur on the
 * same day in the API (verified in user data, April 17 2026).
 *
 * ## Confidence levels
 *
 *   ✓ — observed in real Oura API data for this user (high confidence).
 *   (no marker) — inferred from the bare name + observed prefix patterns.
 *
 * Inferred codes follow these rules:
 *   - Bare name → bare name + prefix (e.g. `airplane` → `tag_generic_airplane` ✓).
 *   - Spaces / underscores in compound words sometimes collapse — observed:
 *       social_gathering → tag_generic_socialgathering
 *       late_screen_time → tag_sleep_late_screentime
 *       late_meal        → tag_sleep_latemeal
 *       sleeping_aids    → tag_sleep_aid (also a rename — plural → singular)
 *   - Hyphens probably become underscores (covid-19 → covid_19) — unverified.
 *
 * If you discover an inferred code is wrong, fix this file and ship a v0.x.x
 * migration that rewrites existing rows (see schema.ts version 2 for the
 * pattern).
 *
 * ## Custom tags
 *
 * Inputs that don't match a known code can still be stored, but only via
 * `tag_type_code = 'custom'` plus a required `custom_name` — exactly how
 * Oura's own UI handles it.
 *
 * ## Future work (v0.4)
 *
 * A `npm run sync` script will pull the user's actual enhanced_tag history
 * and refresh this list dynamically (replacing inferences with verified
 * codes). At that point this file becomes a bootstrap-only seed.
 */

/**
 * Sleep-impact tags. Logged in Oura when an event affected the night,
 * the bedroom environment, sleep aids, or sleep states.
 */
export const TAG_SLEEP_CODES = [
  // ── Observed in real data ──
  'tag_sleep_aid', // ✓
  'tag_sleep_alcohol', // ✓
  'tag_sleep_latemeal', // ✓ ("late_meal" — collapsed)
  'tag_sleep_late_screentime', // ✓ ("late_screen_time" — partial collapse)
  'tag_sleep_latework', // ✓ ("late_work" — collapsed)
  'tag_sleep_sauna', // ✓
  'tag_sleep_stress', // ✓

  // ── Substances framed as sleep impact ──
  'tag_sleep_caffeine',
  'tag_sleep_nicotine',
  'tag_sleep_melatonin',
  'tag_sleep_valerian',

  // ── "Late X" disrupted-sleep patterns ──
  'tag_sleep_late_caffeine',
  'tag_sleep_late_exercise',
  'tag_sleep_late_work',

  // ── "No X" sleep-protective behaviors ──
  'tag_sleep_no_alcohol',
  'tag_sleep_no_caffeine',
  'tag_sleep_no_late_exercise',
  'tag_sleep_no_late_meal',
  'tag_sleep_no_melatonin',
  'tag_sleep_no_nap',

  // ── Sleep events / states ──
  'tag_sleep_dreams',
  'tag_sleep_insomnia',
  'tag_sleep_jet_lag',
  'tag_sleep_night_sweats',
  'tag_sleep_nightmares',
  'tag_sleep_snoring',

  // ── Sleep environment ──
  'tag_sleep_air_conditioning',
  'tag_sleep_air_quality',
  'tag_sleep_blackout_curtains',
  'tag_sleep_blue_light_blockers',
  'tag_sleep_bright_bedroom',
  'tag_sleep_cool_bedroom',
  'tag_sleep_cpap',
  'tag_sleep_dark_bedroom',
  'tag_sleep_ear_plugs',
  'tag_sleep_hot_bedroom',
  'tag_sleep_new_bed',
  'tag_sleep_night_guard',
  'tag_sleep_noisy',
  'tag_sleep_shared_bed',
  'tag_sleep_sleep_mask',
  'tag_sleep_sleep_solo',
  'tag_sleep_sleep_therapy',
  'tag_sleep_sunlight_alarm',
  'tag_sleep_weighted_blanket',
  'tag_sleep_white_noise',
  'tag_sleep_wind_down_routine',
] as const;

/**
 * Generic activity / state / event tags. Activities, drinks, foods, social,
 * medical, mood, anything not framed as sleep-specific.
 */
export const TAG_GENERIC_CODES = [
  // ── Observed in real data ──
  'tag_generic_airplane', // ✓
  'tag_generic_anxiety', // ✓
  'tag_generic_beer', // ✓
  'tag_generic_caffeine', // ✓ (added v0.4.1: discovered during the first 240-day backfill)
  'tag_generic_cold', // ✓ (added v0.4.1: discovered during the first 240-day backfill)
  'tag_generic_diarrhea', // ✓
  'tag_generic_flu_shot', // ✓
  'tag_generic_reading_before_bed', // ✓
  'tag_generic_sad', // ✓
  'tag_generic_socialgathering', // ✓ ("social_gathering" — collapsed)
  'tag_generic_spicy_meal', // ✓
  'tag_generic_tea', // ✓

  // ── Drinks & substances (the substance itself, not the sleep impact) ──
  'tag_generic_coffee',
  'tag_generic_liquor',
  'tag_generic_sugar',
  'tag_generic_wine',

  // ── Activities & lifestyle ──
  'tag_generic_breathwork',
  'tag_generic_car',
  'tag_generic_cold_exposure',
  'tag_generic_cold_shower',
  'tag_generic_evening_sunlight',
  'tag_generic_fasting',
  'tag_generic_float_tank',
  'tag_generic_foam_roller',
  'tag_generic_full_moon',
  'tag_generic_heat_training',
  'tag_generic_high_altitude',
  'tag_generic_home_office',
  'tag_generic_hot_bath',
  'tag_generic_hot_shower',
  'tag_generic_hotel',
  'tag_generic_keto_diet',
  'tag_generic_light_therapy',
  'tag_generic_massage',
  'tag_generic_massage_gun',
  'tag_generic_meditation',
  'tag_generic_morning_sunlight',
  'tag_generic_muscle_stimulator',
  'tag_generic_nap',
  'tag_generic_office',
  'tag_generic_outdoors',
  'tag_generic_party',
  'tag_generic_pets',
  'tag_generic_shift_work',
  'tag_generic_steam_room',
  'tag_generic_sun',
  'tag_generic_train',
  'tag_generic_travel',
  'tag_generic_vacation',
  'tag_generic_work',

  // ── Mood, emotional state ──
  'tag_generic_anger',
  'tag_generic_argument',
  'tag_generic_awe',
  'tag_generic_calm',
  'tag_generic_confidence',
  'tag_generic_connected',
  'tag_generic_crying',
  'tag_generic_emotionally_exhausted',
  'tag_generic_energized',
  'tag_generic_excited',
  'tag_generic_gratitude',
  'tag_generic_happy',
  'tag_generic_in_control',
  'tag_generic_irritability',
  'tag_generic_lonely',
  'tag_generic_love',
  'tag_generic_low_motivation',
  'tag_generic_mood_swings',
  'tag_generic_overwhelmed',
  'tag_generic_physically_exhausted',
  'tag_generic_relaxed',
  'tag_generic_tired',

  // ── Medical / treatments / supplements ──
  'tag_generic_acupuncture',
  'tag_generic_blood_donation',
  'tag_generic_cbd',
  'tag_generic_chiropractic',
  'tag_generic_collagen',
  'tag_generic_compression',
  'tag_generic_covid_19_vaccine',
  'tag_generic_cryotherapy',
  'tag_generic_glp_1_medication',
  'tag_generic_hormone_replacement_therapy',
  'tag_generic_hyperbaric_oxygen_therapy',
  'tag_generic_insulin',
  'tag_generic_magnesium',
  'tag_generic_medication',
  'tag_generic_painkiller',
  'tag_generic_physiotherapy',
  'tag_generic_supplements',
  'tag_generic_surgery',
  'tag_generic_vaccination',

  // ── Physical state / symptoms / illness ──
  'tag_generic_acne',
  'tag_generic_allergies',
  'tag_generic_ankle_swelling',
  'tag_generic_back_pain',
  'tag_generic_bloating',
  'tag_generic_common_cold',
  'tag_generic_confirmed_covid_19',
  'tag_generic_constipation',
  'tag_generic_cramps',
  'tag_generic_difficulty_concentrating',
  'tag_generic_dizziness',
  'tag_generic_erectile_dysfunction',
  'tag_generic_fatigue',
  'tag_generic_feet_swelling',
  'tag_generic_fever',
  'tag_generic_flu',
  'tag_generic_food_aversion',
  'tag_generic_food_cravings',
  'tag_generic_forgetfulness',
  'tag_generic_frequent_urination',
  'tag_generic_hair_thickening',
  'tag_generic_hangover',
  'tag_generic_headache',
  'tag_generic_heartburn',
  'tag_generic_hot_flashes',
  'tag_generic_indigestion',
  'tag_generic_injured',
  'tag_generic_itchy_skin',
  'tag_generic_joint_pain',
  'tag_generic_leg_pain',
  'tag_generic_lightheaded',
  'tag_generic_migraine',
  'tag_generic_nasal_congestion',
  'tag_generic_nausea',
  'tag_generic_newly_visible_veins',
  'tag_generic_pain',
  'tag_generic_sick',
  'tag_generic_skin_changes',
  'tag_generic_sore_throat',
  'tag_generic_soreness',
  'tag_generic_urinary_issues',
  'tag_generic_vision_changes',
  'tag_generic_vomiting',

  // ── Reproductive / cycle / pregnancy ──
  'tag_generic_baby_care',
  'tag_generic_birth',
  'tag_generic_birth_control',
  'tag_generic_braxton_hicks_contractions',
  'tag_generic_breastfeeding',
  'tag_generic_c_section',
  'tag_generic_cervical_mucus',
  'tag_generic_contractions',
  'tag_generic_emergency_contraceptive',
  'tag_generic_high_sexual_desire',
  'tag_generic_induced_labor',
  'tag_generic_kids',
  'tag_generic_labor',
  'tag_generic_linea_nigra',
  'tag_generic_low_sexual_desire',
  'tag_generic_low_sperm_count',
  'tag_generic_mastitis',
  'tag_generic_menopause_symptoms',
  'tag_generic_ovulation',
  'tag_generic_pelvic_pain',
  'tag_generic_perimenopause_symptoms',
  'tag_generic_pitocin',
  'tag_generic_pms',
  'tag_generic_positive_lh_test',
  'tag_generic_positive_pregnancy_test',
  'tag_generic_postmenopause_symptoms',
  'tag_generic_postpartum',
  'tag_generic_pregnancy_loss',
  'tag_generic_round_ligament_pain',
  'tag_generic_sex',
  'tag_generic_spotting',
  'tag_generic_tender_breasts',
  'tag_generic_vaginal_birth',
  'tag_generic_vaginal_discharge',
  'tag_generic_vaginal_dryness',
] as const;

export const KNOWN_TAG_TYPE_CODES = [...TAG_SLEEP_CODES, ...TAG_GENERIC_CODES] as const;

export type KnownTagTypeCode = (typeof KNOWN_TAG_TYPE_CODES)[number];

const KNOWN_SET = new Set<string>(KNOWN_TAG_TYPE_CODES);

export function isKnownTagTypeCode(code: string): code is KnownTagTypeCode {
  return KNOWN_SET.has(code);
}

/** Returns the full set of accepted values for `tag_type_code` inputs. */
export function acceptedTagTypeCodes(): readonly string[] {
  return [...KNOWN_TAG_TYPE_CODES, 'custom'];
}
