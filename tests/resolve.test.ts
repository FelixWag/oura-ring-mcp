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
