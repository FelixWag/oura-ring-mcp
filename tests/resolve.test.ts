/**
 * Deduplication rules for HealthKit workouts.
 *
 * Every case here is a real shape observed in a HealthKit export, restated
 * with synthetic times/values. The comments name the trap each one guards.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSessions,
  canonicalActivity,
  isResistance,
  type WorkoutCandidate,
} from '../src/health/resolve.js';
import { auditSessions } from '../src/health/audit.js';

function hk(
  source_name: string,
  activity_type: string,
  start: string,
  end: string,
  extra: Partial<WorkoutCandidate> = {},
): WorkoutCandidate {
  return {
    origin: 'apple_health',
    source_name,
    activity_type,
    start_time: `2026-01-15T${start}:00+02:00`,
    end_time: `2026-01-15T${end}:00+02:00`,
    ...extra,
  };
}

describe('resolveSessions', () => {
  it('collapses the typed row and its phone-recorded wrapper into one session', () => {
    const sessions = resolveSessions([
      hk('Oura', 'TraditionalStrengthTraining', '12:08', '12:59', { energy_kcal: 279 }),
      hk('Oura', 'Other', '12:08', '13:00', {
        energy_kcal: 332,
        avg_heart_rate: 104,
        device: '<<HKDevice: name:iPhone>>',
      }),
    ]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.activity).toBe('strength_training');
    expect(sessions[0]?.is_resistance).toBe(true);
    // The typed row wins, but the wrapper's heart rate is still carried over.
    expect(sessions[0]?.end_time).toContain('12:59');
    expect(sessions[0]?.avg_heart_rate).toBe(104);
    expect(sessions[0]?.members).toHaveLength(2);
  });

  it('keeps strength followed by cardio as two sessions', () => {
    // The trap: adjacent, non-overlapping records are separate workouts.
    const sessions = resolveSessions([
      hk('Oura', 'TraditionalStrengthTraining', '12:08', '12:59'),
      hk('Oura', 'Cycling', '13:00', '13:35'),
    ]);

    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.activity)).toEqual(['strength_training', 'cycling']);
  });

  it("does not treat a standalone 'Other' row as a duplicate", () => {
    // Most 'Other' rows are real sessions (commonly stretching), not twins.
    const sessions = resolveSessions([hk('Oura', 'Other', '07:25', '07:30')]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.activity).toBe('other');
    expect(sessions[0]?.is_resistance).toBe(false);
  });

  it('drops excluded writers, and lets Oura win when they are included', () => {
    const candidates = [
      hk('Oura', 'TraditionalStrengthTraining', '12:08', '12:59'),
      // A lifting tracker recording the same session with a long-running timer.
      hk('LiftingApp', 'TraditionalStrengthTraining', '12:21', '13:40'),
    ];

    const excluded = resolveSessions(candidates, { excludeSources: ['LiftingApp'] });
    expect(excluded).toHaveLength(1);
    expect(excluded[0]?.source).toBe('apple_health:Oura');
    expect(excluded[0]?.end_time).toContain('12:59');

    // Included, the two overlap enough to be one session — and Oura still
    // wins it, because the third-party timer runs long.
    const included = resolveSessions(candidates);
    expect(included).toHaveLength(1);
    expect(included[0]?.source).toBe('apple_health:Oura');
  });

  it('prefers the Oura API row over the HealthKit copy of the same session', () => {
    const sessions = resolveSessions([
      {
        origin: 'oura_api',
        source_name: 'Oura',
        activity_type: 'strengthTraining',
        start_time: '2026-01-20T08:49:00+02:00',
        end_time: '2026-01-20T09:09:00+02:00',
      },
      {
        origin: 'apple_health',
        source_name: 'Oura',
        activity_type: 'FunctionalStrengthTraining',
        start_time: '2026-01-20T08:49:00+02:00',
        end_time: '2026-01-20T09:09:00+02:00',
        energy_kcal: 134,
      },
    ]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.source).toBe('oura_api:Oura');
    // The API row carries no calories; the HealthKit twin supplies them.
    expect(sessions[0]?.energy_kcal).toBe(134);
  });

  it('discards an unstopped live activity instead of letting it swallow the day', () => {
    // A live activity the user forgot to stop: it runs into the next day.
    const sessions = resolveSessions([
      {
        origin: 'apple_health',
        source_name: 'Oura',
        activity_type: 'Other',
        start_time: '2026-01-15T18:22:00+02:00',
        end_time: '2026-01-16T22:03:00+02:00',
        device: '<<HKDevice: name:iPhone>>',
        energy_kcal: 318,
      },
    ]);

    // Left in, its 27h window overlaps every walk that day and chains them
    // all into one bogus session.
    expect(sessions).toHaveLength(0);
  });

  it('keeps same-day walks separate from a discarded 27h wrapper', () => {
    const sessions = resolveSessions([
      {
        origin: 'apple_health',
        source_name: 'Oura',
        activity_type: 'Other',
        start_time: '2026-01-15T18:22:00+02:00',
        end_time: '2026-01-16T22:03:00+02:00',
        device: '<<HKDevice: name:iPhone>>',
      },
      hk('Oura', 'TraditionalStrengthTraining', '18:22', '19:02'),
      hk('Oura', 'Walking', '21:45', '22:01'),
    ]);

    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.activity)).toEqual(['strength_training', 'walking']);
  });

  it('lets a typed row beat an overlapping 27h wrapper', () => {
    const sessions = resolveSessions([
      {
        origin: 'apple_health',
        source_name: 'Oura',
        activity_type: 'Other',
        start_time: '2026-01-15T18:22:00+02:00',
        end_time: '2026-01-16T22:03:00+02:00',
        device: '<<HKDevice: name:iPhone>>',
      },
      {
        origin: 'apple_health',
        source_name: 'Oura',
        activity_type: 'TraditionalStrengthTraining',
        start_time: '2026-01-15T18:22:00+02:00',
        end_time: '2026-01-15T19:02:00+02:00',
      },
    ]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.activity).toBe('strength_training');
    expect(sessions[0]?.duration_min).toBe(40);
  });
});

describe('handoff merging (one effort split across two apps)', () => {
  const rec = (
    source_name: string,
    activity_type: string,
    start: string,
    end: string,
  ): WorkoutCandidate => ({
    origin: 'apple_health',
    source_name,
    activity_type,
    start_time: `2026-01-31T${start}:00+02:00`,
    end_time: `2026-01-31T${end}:00+02:00`,
  });

  it('merges a run two apps each caught half of', () => {
    // The real shape: a run tracker stops at 11:37, the ring picks up 11:36.
    const sessions = resolveSessions([
      rec('RunTracker', 'Running', '11:21', '11:37'),
      rec('Oura', 'Running', '11:36', '11:57'),
    ]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.activity).toBe('running');
    // Oura still supplies the window — precedence is unchanged by merging.
    expect(sessions[0]?.source).toBe('apple_health:Oura');
    expect(sessions[0]?.members).toHaveLength(2);
  });

  it('keeps two back-to-back records from the SAME app separate', () => {
    // Interval work, or simply two walks. Same writer means two sessions.
    const sessions = resolveSessions([
      rec('Oura', 'Running', '11:21', '11:37'),
      rec('Oura', 'Running', '11:38', '11:57'),
    ]);

    expect(sessions).toHaveLength(2);
  });

  it('does not merge different activities across apps', () => {
    // A run then core training is two workouts, not one handoff.
    const sessions = resolveSessions([
      rec('RunTracker', 'Running', '11:21', '11:37'),
      rec('Watch', 'CoreTraining', '11:39', '11:50'),
    ]);

    expect(sessions).toHaveLength(2);
  });

  it('does not merge across a gap wider than the handoff window', () => {
    const sessions = resolveSessions([
      rec('RunTracker', 'Running', '11:21', '11:37'),
      rec('Oura', 'Running', '11:50', '12:10'),
    ]);

    expect(sessions).toHaveLength(2);
  });

  it('will not chain short records into an implausible super-session', () => {
    // Alternating writers, each 5 min apart, must not accumulate past the cap.
    const candidates: WorkoutCandidate[] = [];
    for (let i = 0; i < 40; i += 1) {
      const startMin = i * 15;
      const pad = (n: number) => String(n).padStart(2, '0');
      candidates.push(
        rec(
          i % 2 === 0 ? 'AppA' : 'AppB',
          'Walking',
          `${pad(6 + Math.floor(startMin / 60))}:${pad(startMin % 60)}`,
          `${pad(6 + Math.floor((startMin + 10) / 60))}:${pad((startMin + 10) % 60)}`,
        ),
      );
    }
    const sessions = resolveSessions(candidates);

    expect(sessions.length).toBeGreaterThan(1);
    for (const s of sessions) {
      const minutes = (Date.parse(s.end_time) - Date.parse(s.start_time)) / 60000;
      expect(minutes).toBeLessThanOrEqual(6 * 60);
    }
  });

  it('keeps strength then cardio separate even across apps', () => {
    // The pattern that must never merge, now tested cross-source too.
    const sessions = resolveSessions([
      rec('Oura', 'TraditionalStrengthTraining', '12:08', '12:59'),
      rec('OtherApp', 'Cycling', '13:00', '13:35'),
    ]);

    expect(sessions).toHaveLength(2);
  });
});

describe('activity labels', () => {
  it('treats both strength-training flavours as resistance', () => {
    // The same gym visit is labelled differently across days.
    expect(canonicalActivity('TraditionalStrengthTraining')).toBe('strength_training');
    expect(canonicalActivity('FunctionalStrengthTraining')).toBe('strength_training');
    expect(canonicalActivity('strengthTraining')).toBe('strength_training');
    expect(isResistance('FunctionalStrengthTraining')).toBe(true);
    expect(isResistance('Cycling')).toBe(false);
  });

  it('snake_cases everything else', () => {
    expect(canonicalActivity('TableTennis')).toBe('table_tennis');
    expect(canonicalActivity('Walking')).toBe('walking');
  });
});

describe('auditSessions', () => {
  const session = (activity: string, start: string, end: string, source = 'apple_health:Oura') => ({
    start_time: `2026-01-15T${start}:00+02:00`,
    end_time: `2026-01-15T${end}:00+02:00`,
    duration_min: 30,
    activity,
    is_resistance: activity === 'strength_training',
    energy_kcal: null,
    avg_heart_rate: null,
    source,
    members: [],
  });

  it('is silent on a clean resolve', () => {
    const findings = auditSessions({
      candidates: [],
      sessions: [
        session('strength_training', '12:08', '12:59'),
        session('cycling', '13:00', '13:35'),
      ],
    });

    expect(findings).toEqual([]);
  });

  it('errors when two counted sessions overlap', () => {
    // The failure mode that matters: the same workout counted twice.
    const findings = auditSessions({
      candidates: [],
      sessions: [
        session('strength_training', '12:08', '12:59'),
        session('strength_training', '12:10', '12:55', 'apple_health:OtherApp'),
      ],
    });

    expect(findings.some((f) => f.code === 'overlapping_sessions' && f.severity === 'error')).toBe(
      true,
    );
  });

  it('flags a writer it has never seen before', () => {
    const findings = auditSessions({
      candidates: [
        {
          origin: 'apple_health',
          source_name: 'BrandNewTracker',
          activity_type: 'Running',
          start_time: '2026-01-15T07:00:00+02:00',
          end_time: '2026-01-15T07:30:00+02:00',
        },
      ],
      sessions: [],
      knownSources: ['Oura'],
    });

    expect(findings.some((f) => f.code === 'new_writer')).toBe(true);
  });

  it('flags near-miss duplicates from different sources', () => {
    // Clocks drifted too far for the overlap rule, but it smells like one session.
    const findings = auditSessions({
      candidates: [],
      sessions: [
        session('strength_training', '12:08', '12:40'),
        session('strength_training', '12:50', '13:30', 'apple_health:OtherApp'),
      ],
    });

    expect(findings.some((f) => f.code === 'possible_cross_source_duplicate')).toBe(true);
  });
});

describe('same-app artefacts', () => {
  it("merges one app's two overlapping records of the same activity", () => {
    // One app cannot have you lifting twice at once.
    const sessions = resolveSessions([
      hk('Oura', 'TraditionalStrengthTraining', '20:06', '20:25'),
      hk('Oura', 'TraditionalStrengthTraining', '20:12', '20:22'),
    ]);

    expect(sessions).toHaveLength(1);
  });

  it("leaves one app's overlapping records of DIFFERENT activities alone", () => {
    // A walk detected inside a ride: which is real is not this code's call.
    // 29% overlap — past the same-activity threshold, short of the generic one.
    const sessions = resolveSessions([
      hk('Oura', 'Cycling', '11:27', '11:55'),
      hk('Oura', 'Walking', '11:47', '12:15'),
    ]);

    expect(sessions).toHaveLength(2);
  });
});

describe('detection fragments', () => {
  const at = (start: string, end: string, source = 'Oura'): WorkoutCandidate => ({
    origin: 'apple_health',
    source_name: source,
    activity_type: 'Running',
    start_time: `2026-01-15T${start}+02:00`,
    end_time: `2026-01-15T${end}+02:00`,
  });

  it('absorbs a seconds-long blip into the real session beside it', () => {
    // Observed: a 21-second "run" 19 seconds before the actual run.
    const sessions = resolveSessions([at('18:02:58', '18:03:19'), at('18:03:38', '18:15:04')]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.duration_min).toBeCloseTo(11.4, 1);
  });

  it('keeps a short workout that stands alone', () => {
    // Brief but real: nothing adjacent to absorb it into.
    const sessions = resolveSessions([at('18:02:58', '18:04:30')]);

    expect(sessions).toHaveLength(1);
  });

  it('still keeps genuine back-to-back intervals apart', () => {
    // Both well past fragment length, so the rule doesn't touch them.
    const sessions = resolveSessions([at('11:21:00', '11:37:00'), at('11:38:00', '11:57:00')]);

    expect(sessions).toHaveLength(2);
  });
});

describe('a live-activity wrapper must not swallow the day', () => {
  const rec = (
    activity_type: string,
    start: string,
    end: string,
    extra: Partial<WorkoutCandidate> = {},
  ): WorkoutCandidate => ({
    origin: 'apple_health',
    source_name: 'Oura',
    activity_type,
    start_time: `2026-01-15T${start}+02:00`,
    end_time: `2026-01-15T${end}+02:00`,
    ...extra,
  });

  it('keeps the gym session when a wrapper overruns into an unrelated blip', () => {
    // The real failure: a 52-min wrapper ran 1 min past the strength session,
    // caught a 21-second "run", bridged the two into one cluster, and the
    // API-sourced blip then won it — the gym session disappeared entirely.
    const sessions = resolveSessions([
      rec('Other', '17:11:32', '18:03:30', { device: '<<HKDevice: name:iPhone>>' }),
      rec('TraditionalStrengthTraining', '17:11:35', '18:02:33'),
      {
        origin: 'oura_api',
        source_name: 'Oura',
        activity_type: 'running',
        start_time: '2026-01-15T18:02:58+02:00',
        end_time: '2026-01-15T18:03:19+02:00',
      },
      rec('Running', '18:03:38', '18:15:04'),
    ]);

    const strength = sessions.filter((s) => s.is_resistance);
    expect(strength).toHaveLength(1);
    expect(strength[0]?.duration_min).toBeCloseTo(51, 0);

    // And the blip is absorbed by the real run rather than counted.
    const runs = sessions.filter((s) => s.activity === 'running');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.duration_min).toBeGreaterThan(10);
  });

  it('still keeps a wrapper that has no typed twin', () => {
    const sessions = resolveSessions([
      rec('Other', '07:25:00', '07:55:00', { device: '<<HKDevice: name:iPhone>>' }),
    ]);

    expect(sessions).toHaveLength(1);
  });
});
