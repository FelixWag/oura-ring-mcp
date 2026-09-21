/**
 * Dedupe audit: catch double-counting *before* it reaches a report.
 *
 * The resolver's clustering is a heuristic, and heuristics rot — a new app
 * starts writing to HealthKit, a vendor changes how it timestamps, a session
 * gets edited after the fact. Silent failure here looks like a plausible
 * number, which is the worst kind of wrong: the whole reason this module
 * exists is that "1 resistance session in 30 days" read as a real finding for
 * weeks when the truth was six.
 *
 * So: after every resolve, assert the invariants that must hold, and report
 * the near-misses that suggest the rules need revisiting.
 */

import { resolveSessions, type ResolvedSession, type WorkoutCandidate } from './resolve.js';

/** Overlap below the merge threshold but above this is worth a human look. */
const NEAR_MISS_MIN_OVERLAP = 0.15;

/** Same activity from different writers starting this close is suspicious. */
const SUSPICIOUS_START_GAP_MIN = 45;

export type AuditSeverity = 'error' | 'warning' | 'info';

export interface AuditFinding {
  severity: AuditSeverity;
  code: string;
  message: string;
  /** Local day the finding concerns, for grouping in reports. */
  day?: string;
}

export interface AuditInput {
  candidates: WorkoutCandidate[];
  sessions: ResolvedSession[];
  /** Writer names seen in previous runs; anything new is flagged. */
  knownSources?: string[];
}

function ms(iso: string): number {
  return Date.parse(iso);
}

function overlapFraction(
  a: { start_time: string; end_time: string },
  b: { start_time: string; end_time: string },
): number {
  const shared =
    Math.min(ms(a.end_time), ms(b.end_time)) - Math.max(ms(a.start_time), ms(b.start_time));
  if (shared <= 0) return 0;
  const shortest = Math.min(ms(a.end_time) - ms(a.start_time), ms(b.end_time) - ms(b.start_time));
  return shortest <= 0 ? 0 : shared / shortest;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Run every check. Callers decide what to do with the findings; `error`
 * means a resolved list is definitely wrong, `warning` means it might be.
 */
export function auditSessions(input: AuditInput): AuditFinding[] {
  const { candidates, sessions } = input;
  const findings: AuditFinding[] = [];

  // 1. INVARIANT: resolved sessions must not overlap each other. If they do,
  //    clustering failed and the same workout is counted twice.
  for (let i = 0; i < sessions.length; i += 1) {
    for (let j = i + 1; j < sessions.length; j += 1) {
      const a = sessions[i];
      const b = sessions[j];
      if (!a || !b) continue;
      const fraction = overlapFraction(a, b);
      if (fraction >= NEAR_MISS_MIN_OVERLAP) {
        const severity: AuditSeverity = fraction >= 0.5 ? 'error' : 'warning';
        findings.push({
          severity,
          code: 'overlapping_sessions',
          day: day(a.start_time),
          message:
            `${a.activity} ${a.start_time.slice(11, 16)} and ${b.activity} ` +
            `${b.start_time.slice(11, 16)} overlap by ${Math.round(fraction * 100)}% ` +
            `but were counted separately (${a.source} vs ${b.source})`,
        });
      }
    }
  }

  // 2. A new writer appearing in HealthKit is the likeliest future cause of
  //    double counting: it silently adds a second record per session.
  if (input.knownSources) {
    const known = new Set(input.knownSources.map((s) => s.toLowerCase()));
    const unseen = new Set<string>();
    for (const c of candidates) {
      if (!known.has(c.source_name.toLowerCase())) unseen.add(c.source_name);
    }
    for (const name of unseen) {
      findings.push({
        severity: 'warning',
        code: 'new_writer',
        message:
          `'${name}' is writing workouts and has not been seen before — ` +
          'check whether it duplicates an existing source before trusting counts',
      });
    }
  }

  // 3. Same activity, different writers, starting close together but not
  //    merged: exactly the shape of a cross-app duplicate whose clocks drift
  //    too far apart for the overlap rule to catch.
  const byActivity = new Map<string, ResolvedSession[]>();
  for (const s of sessions) {
    const key = `${day(s.start_time)}|${s.activity}`;
    byActivity.set(key, [...(byActivity.get(key) ?? []), s]);
  }
  for (const group of byActivity.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        if (!a || !b || a.source === b.source) continue;
        const gapMin = Math.abs(ms(a.start_time) - ms(b.start_time)) / 60000;
        if (gapMin <= SUSPICIOUS_START_GAP_MIN && overlapFraction(a, b) < NEAR_MISS_MIN_OVERLAP) {
          findings.push({
            severity: 'warning',
            code: 'possible_cross_source_duplicate',
            day: day(a.start_time),
            message:
              `two ${a.activity} sessions ${Math.round(gapMin)} min apart from ` +
              `different sources (${a.source}, ${b.source}) — possibly one session`,
          });
        }
      }
    }
  }

  // 4. Records the resolver dropped for implausible length. Expected
  //    occasionally (an unstopped live activity), alarming in bulk.
  const dropped = candidates.filter((c) => (ms(c.end_time) - ms(c.start_time)) / 60000 > 6 * 60);
  if (dropped.length > 0) {
    findings.push({
      severity: dropped.length > 5 ? 'warning' : 'info',
      code: 'implausible_duration_dropped',
      message:
        `${dropped.length} record(s) longer than 6h were discarded ` +
        '(usually a live activity that was never stopped)',
    });
  }

  return findings;
}

/** Convenience: resolve and audit in one call. */
export function resolveAndAudit(
  candidates: WorkoutCandidate[],
  options: { excludeSources?: string[]; knownSources?: string[] } = {},
): { sessions: ResolvedSession[]; findings: AuditFinding[] } {
  const sessions = resolveSessions(
    candidates,
    options.excludeSources ? { excludeSources: options.excludeSources } : {},
  );
  const findings = auditSessions({
    candidates,
    sessions,
    ...(options.knownSources ? { knownSources: options.knownSources } : {}),
  });
  return { sessions, findings };
}
