/**
 * Read-time deduplication: many workout records → one session list.
 *
 * A single session can legitimately produce several HealthKit records: the
 * recording app's typed row, its phone-recorded live-activity wrapper, and a
 * second app tracking the same session twice over — plus possibly an Oura API
 * row. Storage keeps them all; this module decides which one *is* the session.
 *
 * The rules, in order:
 *
 *   1. Oura API wins. If an API workout overlaps, that's the session.
 *   2. Then Oura via HealthKit — the only route to live-tracked sessions.
 *   3. Third-party writers can be excluded via `excludeSources` — a lifting
 *      tracker's timer typically runs well past the real session, and the
 *      detail justifying it (sets/reps) stays in its own app anyway.
 *   4. Same-source overlap collapses to one session, preferring the typed row
 *      over the phone-recorded wrapper (`device` set, type often 'Other').
 *   5. Adjacent records are NEVER merged — strength immediately followed by
 *      cardio is a real, common pattern.
 *
 * Trap this encodes: 'Other' is not a duplicate marker. Most 'Other' rows are
 * standalone real sessions — Oura writes 'Other' for anything Apple has no
 * type for, stretching being the common case.
 */

/** Overlap needed (as a fraction of the shorter record) to call it one session. */
const OVERLAP_FRACTION = 0.5;

/**
 * Live activities that were never stopped run for >24h. Anything longer than
 * this is a wrapper artefact: it may not win its cluster, and its duration is
 * not reported.
 */
const MAX_PLAUSIBLE_DURATION_MIN = 6 * 60;

/**
 * Edge-to-edge gap within which two *different* apps recording the same
 * activity are treated as one interrupted session rather than two. Kept
 * small: a genuine back-to-back pair is usually further apart, and a missed
 * merge only produces a duplicate the audit flags, whereas a wrong merge
 * erases a real session.
 */
const CROSS_SOURCE_HANDOFF_GAP_MIN = 5;

/**
 * A record this short sitting beside a same-activity record is a detection
 * fragment, not a session — observed: a 21-second "run" recorded 19 seconds
 * before the real 11-minute one. Absorbed into its neighbour rather than
 * dropped, so its energy still counts; a fragment with no neighbour stays a
 * session, because a genuinely brief workout is still a workout.
 */
const FRAGMENT_MAX_MIN = 2;
const FRAGMENT_GAP_MIN = 2;

/**
 * Overlap at which one app's two records of the SAME activity are treated as
 * one session. Lower than {@link OVERLAP_FRACTION} because a single app
 * recording itself twice is a detection artefact, not two workouts.
 */
const SAME_SOURCE_SAME_ACTIVITY_OVERLAP = 0.15;

/**
 * Writers whose records are stored but not counted. Empty by default: which
 * apps to trust is deployment-specific. Pass `excludeSources` to drop a
 * third-party tracker whose timer runs long, keeping its rows on disk.
 */
export const DEFAULT_EXCLUDED_SOURCES: readonly string[] = [];

export interface WorkoutCandidate {
  /** 'oura_api' | 'apple_health' */
  origin: string;
  /** Writing app for HealthKit rows ('Oura', a lifting tracker, …). */
  source_name: string;
  /** Raw type as the source spells it ('strengthTraining', 'Other', ...). */
  activity_type: string;
  start_time: string;
  end_time: string;
  energy_kcal?: number | null;
  avg_heart_rate?: number | null;
  /** HKDevice string; non-null means the phone recorded it (wrapper row). */
  device?: string | null;
}

export interface ResolvedSession {
  start_time: string;
  end_time: string;
  duration_min: number | null;
  /** Canonical activity label, e.g. 'strength_training', 'walking'. */
  activity: string;
  is_resistance: boolean;
  energy_kcal: number | null;
  avg_heart_rate: number | null;
  /** Winning record's origin + writer, e.g. 'apple_health:Oura'. */
  source: string;
  /** Every record that collapsed into this session, winner first. */
  members: WorkoutCandidate[];
}

/** HealthKit + Oura activity names that count as resistance training. */
const RESISTANCE_TYPES = new Set([
  'traditionalstrengthtraining',
  'functionalstrengthtraining',
  'strengthtraining',
  'coretraining',
  'crosstraining',
]);

/** Origin ranking: lower wins. */
function originRank(origin: string): number {
  return origin === 'oura_api' ? 0 : 1;
}

/**
 * Writer ranking: Oura is the reference for every timing figure. Other apps
 * only win a cluster Oura isn't in — and then only if they aren't excluded.
 */
function sourceRank(sourceName: string): number {
  return sourceName.toLowerCase() === 'oura' ? 0 : 1;
}

function ms(iso: string): number {
  return Date.parse(iso);
}

function durationMin(c: WorkoutCandidate): number {
  return (ms(c.end_time) - ms(c.start_time)) / 60000;
}

function isWrapper(c: WorkoutCandidate): boolean {
  return (
    (c.device != null && c.activity_type.toLowerCase() === 'other') ||
    durationMin(c) > MAX_PLAUSIBLE_DURATION_MIN
  );
}

/**
 * Canonical label for a raw source type. Traditional vs functional strength
 * training is a distinction the sources make inconsistently for the same gym
 * visit, so both collapse to 'strength_training'.
 */
export function canonicalActivity(rawType: string): string {
  const t = rawType.toLowerCase();
  if (RESISTANCE_TYPES.has(t)) return 'strength_training';
  // camelCase / PascalCase → snake_case ('TableTennis' → 'table_tennis')
  return rawType
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
}

export function isResistance(rawType: string): boolean {
  return RESISTANCE_TYPES.has(rawType.toLowerCase());
}

/** Fraction of the shorter record that the two records share in time. */
function overlapFraction(a: WorkoutCandidate, b: WorkoutCandidate): number {
  const start = Math.max(ms(a.start_time), ms(b.start_time));
  const end = Math.min(ms(a.end_time), ms(b.end_time));
  const shared = end - start;
  if (shared <= 0) return 0;
  const shortest = Math.min(ms(a.end_time) - ms(a.start_time), ms(b.end_time) - ms(b.start_time));
  return shortest <= 0 ? 0 : shared / shortest;
}

/**
 * Pick the record that represents the session: best origin, then a typed row
 * over a wrapper, then the longer record (an interrupted recording is likelier
 * to be the truncated one).
 */
function pickWinner(cluster: WorkoutCandidate[]): WorkoutCandidate {
  const longest = Math.max(...cluster.map(durationMin));
  // A seconds-long detection blip must not speak for a cluster that contains
  // a real session, however good its source. Observed: a 21-second Oura API
  // "run" outranking a 51-minute gym session and erasing it from the day.
  const isFragment = (c: WorkoutCandidate): boolean =>
    durationMin(c) <= FRAGMENT_MAX_MIN && longest > FRAGMENT_MAX_MIN;

  const sorted = [...cluster].sort((a, b) => {
    const fragment = Number(isFragment(a)) - Number(isFragment(b));
    if (fragment !== 0) return fragment;
    const rank = originRank(a.origin) - originRank(b.origin);
    if (rank !== 0) return rank;
    const writer = sourceRank(a.source_name) - sourceRank(b.source_name);
    if (writer !== 0) return writer;
    const wrapper = Number(isWrapper(a)) - Number(isWrapper(b));
    if (wrapper !== 0) return wrapper;
    const typed =
      Number(a.activity_type.toLowerCase() === 'other') -
      Number(b.activity_type.toLowerCase() === 'other');
    if (typed !== 0) return typed;
    return durationMin(b) - durationMin(a);
  });
  // Non-null: callers only build clusters from at least one candidate.
  return sorted[0] as WorkoutCandidate;
}

export interface ResolveOptions {
  /** Writers to ignore entirely. Defaults to {@link DEFAULT_EXCLUDED_SOURCES}. */
  excludeSources?: string[];
}

/**
 * Merge "handoffs": one continuous effort that two apps split between them,
 * each capturing a different slice. Observed shape — a run tracker recording
 * 11:21-11:37 and the ring auto-detecting 11:36-11:57. Barely any overlap, so
 * the overlap rule leaves them as two sessions; in reality it's one run.
 *
 * The conditions are deliberately narrow, because the cost of a wrong merge
 * (a real session disappears) is worse than the cost of a missed one (a
 * duplicate, which the audit then flags):
 *
 *   - DIFFERENT writers. Two records from the same app that don't overlap are
 *     two sessions — that's how interval work and strength-then-cardio look.
 *   - SAME canonical activity. A run next to strength training is a superset
 *     workout, not a handoff.
 *   - Edge-to-edge gap within CROSS_SOURCE_HANDOFF_GAP_MIN, measured between
 *     the clusters, not their starts.
 *   - The union stays within MAX_PLAUSIBLE_DURATION_MIN, so a chain of short
 *     records can't silently grow into an all-day "session".
 *
 * Merging only affects *counting*: the winning record still supplies the
 * window and metrics, per the source precedence rules.
 */
function mergeHandoffs(clusters: WorkoutCandidate[][]): WorkoutCandidate[][] {
  if (clusters.length < 2) return clusters;

  const span = (cluster: WorkoutCandidate[]): { start: number; end: number } => ({
    start: Math.min(...cluster.map((c) => ms(c.start_time))),
    end: Math.max(...cluster.map((c) => ms(c.end_time))),
  });
  const sources = (cluster: WorkoutCandidate[]): Set<string> =>
    new Set(cluster.map((c) => c.source_name.toLowerCase()));
  const activities = (cluster: WorkoutCandidate[]): Set<string> =>
    new Set(cluster.map((c) => canonicalActivity(c.activity_type)));

  const ordered = [...clusters].sort((a, b) => span(a).start - span(b).start);
  const merged: WorkoutCandidate[][] = [];

  for (const cluster of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push(cluster);
      continue;
    }

    const gapMin = (span(cluster).start - span(previous).end) / 60000;
    const unionMin = (span(cluster).end - span(previous).start) / 60000;
    const sharedActivity = [...activities(cluster)].some((a) => activities(previous).has(a));
    // Disjoint writers: if the same app appears on both sides, these are its
    // own two sessions and must stay separate.
    const disjointSources = [...sources(cluster)].every((s) => !sources(previous).has(s));

    // A fragment may be absorbed by the SAME writer too: one app emitting a
    // blip next to the real record is the common case. Interval work is
    // unaffected, since those records are far longer than a fragment.
    const shorterMin = Math.min(
      (span(cluster).end - span(cluster).start) / 60000,
      (span(previous).end - span(previous).start) / 60000,
    );
    const isFragment = shorterMin <= FRAGMENT_MAX_MIN && gapMin <= FRAGMENT_GAP_MIN;
    const isHandoff = disjointSources && gapMin <= CROSS_SOURCE_HANDOFF_GAP_MIN;

    if (sharedActivity && (isHandoff || isFragment) && unionMin <= MAX_PLAUSIBLE_DURATION_MIN) {
      previous.push(...cluster);
    } else {
      merged.push(cluster);
    }
  }

  return merged;
}

/**
 * Collapse overlapping workout records into one session each.
 *
 * Clustering is transitive on overlap only: A joins a cluster if it overlaps
 * any member by >= OVERLAP_FRACTION of the shorter record. Records that merely
 * touch (strength 12:08-12:59 then cycling 13:00-13:35) stay separate.
 */
export function resolveSessions(
  candidates: WorkoutCandidate[],
  options: ResolveOptions = {},
): ResolvedSession[] {
  const excluded = new Set(
    (options.excludeSources ?? DEFAULT_EXCLUDED_SOURCES).map((s) => s.toLowerCase()),
  );
  const usable = candidates
    .filter((c) => !excluded.has(c.source_name.toLowerCase()))
    .filter((c) => Number.isFinite(ms(c.start_time)) && Number.isFinite(ms(c.end_time)))
    // Discard never-stopped live activities *before* clustering. One 27h
    // wrapper otherwise chains through every walk it spans and swallows a
    // whole day into a single session. Oura always writes a typed row
    // alongside, so nothing real is lost.
    .filter((c) => durationMin(c) <= MAX_PLAUSIBLE_DURATION_MIN)
    .sort((a, b) => ms(a.start_time) - ms(b.start_time));

  // Wrappers are attached to a cluster but never used to build one. A live
  // activity left running past its workout (e.g. a 52-min wrapper around a
  // 51-min gym session) otherwise acts as a bridge: an unrelated record that
  // happens to fall inside it joins the same cluster, and the gym session
  // then loses its identity to whatever wins there.
  const seeds = usable.filter((c) => !isWrapper(c));
  const wrappers = usable.filter((c) => isWrapper(c));

  const clusters: WorkoutCandidate[][] = [];
  for (const candidate of seeds) {
    const target = clusters.find((cluster) =>
      cluster.some(
        (member) =>
          overlapFraction(member, candidate) >= OVERLAP_FRACTION ||
          // One app cannot have you doing the same activity twice at once, so
          // any real overlap between its own same-activity records is an
          // artefact of its detection, not two sessions. Deliberately narrow:
          // different activities from one app (it auto-detected a walk inside
          // a ride) stay separate, because which one is real is a judgement
          // this code shouldn't make silently.
          (member.source_name.toLowerCase() === candidate.source_name.toLowerCase() &&
            canonicalActivity(member.activity_type) ===
              canonicalActivity(candidate.activity_type) &&
            overlapFraction(member, candidate) >= SAME_SOURCE_SAME_ACTIVITY_OVERLAP),
      ),
    );
    if (target) target.push(candidate);
    else clusters.push([candidate]);
  }

  // Attach each wrapper to whichever cluster it shares the most *time* with —
  // not the highest overlap fraction, which a seconds-long record would win
  // outright. A wrapper matching nothing stands alone, so a live activity
  // recorded without a typed twin is still a session.
  for (const wrapper of wrappers) {
    let best: WorkoutCandidate[] | null = null;
    let bestShared = 0;
    for (const cluster of clusters) {
      const shared = Math.max(
        ...cluster.map((m) =>
          Math.max(
            0,
            Math.min(ms(m.end_time), ms(wrapper.end_time)) -
              Math.max(ms(m.start_time), ms(wrapper.start_time)),
          ),
        ),
      );
      if (shared > bestShared) {
        bestShared = shared;
        best = cluster;
      }
    }
    if (best) best.push(wrapper);
    else clusters.push([wrapper]);
  }
  clusters.sort((a, b) => ms(a[0]?.start_time ?? '') - ms(b[0]?.start_time ?? ''));

  return mergeHandoffs(clusters).map((cluster) => {
    const winner = pickWinner(cluster);
    const members = [winner, ...cluster.filter((c) => c !== winner)];
    const minutes = durationMin(winner);
    // A wrapper that still won (nothing better overlapped it) keeps its window
    // but not its implausible duration — see the 27h Aug 19 record.
    const plausible = minutes <= MAX_PLAUSIBLE_DURATION_MIN;
    // Prefer a real measurement from any member over the winner's blank.
    const kcal = members.find((m) => m.energy_kcal != null)?.energy_kcal ?? null;
    const hr = members.find((m) => m.avg_heart_rate != null)?.avg_heart_rate ?? null;
    // If the winner is an untyped wrapper, take a typed label from the cluster.
    const typedMember =
      winner.activity_type.toLowerCase() === 'other'
        ? (members.find((m) => m.activity_type.toLowerCase() !== 'other') ?? winner)
        : winner;

    return {
      start_time: winner.start_time,
      end_time: winner.end_time,
      duration_min: plausible ? Math.round(minutes * 10) / 10 : null,
      activity: canonicalActivity(typedMember.activity_type),
      is_resistance: isResistance(typedMember.activity_type),
      energy_kcal: kcal ?? null,
      avg_heart_rate: hr ?? null,
      source: `${winner.origin}:${winner.source_name}`,
      members,
    };
  });
}
