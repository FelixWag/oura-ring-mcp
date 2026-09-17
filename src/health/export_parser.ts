/**
 * Streaming parser for Apple Health's `export.xml`.
 *
 * The file is ~900 MB for a few years of data, so this reads it as a stream
 * and never builds a DOM. Apple's export is machine-generated and regular:
 * one element per line, attributes in a stable order, `<Workout>` optionally
 * wrapping `<WorkoutStatistics>` children.
 *
 * Only what we store is extracted: workouts, plus the quantity records that
 * fill known gaps (body weight, nutrition). Everything else is skipped, which
 * is most of the file — heart rate alone is ~450k records we already mirror
 * from Oura.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ExternalWorkout } from '../db/repos/external_workouts.js';
import type { HealthSample } from '../db/repos/health_samples.js';

/** HealthKit record types worth importing, mapped to our sample_type names. */
export const IMPORTED_RECORD_TYPES: Readonly<Record<string, string>> = {
  HKQuantityTypeIdentifierBodyMass: 'body_mass',
  HKQuantityTypeIdentifierBodyFatPercentage: 'body_fat_percentage',
  HKQuantityTypeIdentifierLeanBodyMass: 'lean_body_mass',
  HKQuantityTypeIdentifierDietaryEnergyConsumed: 'dietary_energy_consumed',
  HKQuantityTypeIdentifierDietaryProtein: 'dietary_protein',
  HKQuantityTypeIdentifierDietaryCarbohydrates: 'dietary_carbohydrates',
  HKQuantityTypeIdentifierDietaryFatTotal: 'dietary_fat_total',
  HKQuantityTypeIdentifierDietaryFatSaturated: 'dietary_fat_saturated',
  HKQuantityTypeIdentifierDietarySugar: 'dietary_sugar',
  HKQuantityTypeIdentifierDietaryFiber: 'dietary_fiber',
  HKQuantityTypeIdentifierDietarySodium: 'dietary_sodium',
  HKQuantityTypeIdentifierDietaryPotassium: 'dietary_potassium',
  HKQuantityTypeIdentifierDietaryCholesterol: 'dietary_cholesterol',
  HKQuantityTypeIdentifierDietaryWater: 'dietary_water',
};

export interface ParsedExport {
  workouts: ExternalWorkout[];
  samples: HealthSample[];
  /** Records seen but not imported, by type — useful to spot new data sources. */
  skipped: Record<string, number>;
}

const ATTR_RE = /(\w+)="([^"]*)"/g;

export function parseAttributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(line)) !== null) {
    const [, key, value] = m;
    if (key !== undefined && value !== undefined) out[key] = decodeEntities(value);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Apple writes dates as `2024-03-01 12:08:18 +0200`. Turn that into ISO 8601
 * with the offset preserved — local time matters for "which day was this".
 */
export function toIso(appleDate: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})$/.exec(appleDate.trim());
  if (!m) return null;
  const [, date, time, offset] = m;
  return `${date}T${time}${offset?.slice(0, 3)}:${offset?.slice(3)}`;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Strip the HK prefix: 'HKWorkoutActivityTypeRowing' → 'Rowing'. */
export function shortActivityType(raw: string): string {
  return raw.replace(/^HKWorkoutActivityType/, '');
}

/**
 * Parse an export file. Workout statistics (energy, distance, heart rate) are
 * nested children in newer exports and attributes in older ones; both are
 * handled.
 */
export async function parseHealthExport(path: string): Promise<ParsedExport> {
  const workouts: ExternalWorkout[] = [];
  const samples: HealthSample[] = [];
  const skipped: Record<string, number> = {};

  let current: { attrs: Record<string, string>; stats: Record<string, number> } | null = null;

  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const flushWorkout = (): void => {
    if (!current) return;
    const a = current.attrs;
    const start = toIso(a['startDate'] ?? '');
    const end = toIso(a['endDate'] ?? '');
    if (start && end) {
      const energy = current.stats['ActiveEnergyBurned'] ?? num(a['totalEnergyBurned']);
      const distance =
        current.stats['DistanceWalkingRunning'] ??
        current.stats['DistanceCycling'] ??
        current.stats['DistanceSwimming'] ??
        num(a['totalDistance']);
      workouts.push({
        source: 'apple_health',
        source_name: a['sourceName'] ?? 'unknown',
        activity_type: shortActivityType(a['workoutActivityType'] ?? 'Unknown'),
        start_time: start,
        end_time: end,
        duration_min: num(a['duration']),
        energy_kcal: energy ?? null,
        distance_km: distance ?? null,
        avg_heart_rate: current.stats['HeartRate'] ?? null,
        device: a['device'] ?? null,
        created_at: toIso(a['creationDate'] ?? '') ?? null,
        raw: JSON.stringify({ ...a, ...current.stats }),
      });
    }
    current = null;
  };

  for await (const line of rl) {
    const trimmed = line.trimStart();

    if (trimmed.startsWith('<Workout ')) {
      flushWorkout();
      current = { attrs: parseAttributes(trimmed), stats: {} };
      // Self-closing (older exports carry everything as attributes).
      if (trimmed.includes('/>')) flushWorkout();
      continue;
    }

    if (current && trimmed.startsWith('<WorkoutStatistics ')) {
      const s = parseAttributes(trimmed);
      const type = (s['type'] ?? '').replace('HKQuantityTypeIdentifier', '');
      const value = num(s['sum']) ?? num(s['average']);
      if (type && value !== null) current.stats[type] = value;
      continue;
    }

    if (current && trimmed.startsWith('</Workout>')) {
      flushWorkout();
      continue;
    }

    if (trimmed.startsWith('<Record ')) {
      const a = parseAttributes(trimmed);
      const type = a['type'] ?? '';
      const mapped = IMPORTED_RECORD_TYPES[type];
      if (!mapped) {
        skipped[type] = (skipped[type] ?? 0) + 1;
        continue;
      }
      const start = toIso(a['startDate'] ?? '');
      const end = toIso(a['endDate'] ?? '') ?? start;
      const value = num(a['value']);
      if (!start || !end || value === null) continue;
      samples.push({
        sample_type: mapped,
        start_time: start,
        end_time: end,
        value,
        unit: a['unit'] ?? '',
        source_name: a['sourceName'] ?? null,
        raw: JSON.stringify(a),
      });
    }
  }

  flushWorkout();
  return { workouts, samples, skipped };
}
