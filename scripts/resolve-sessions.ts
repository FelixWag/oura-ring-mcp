/**
 * Rebuild the `resolved_sessions` table from `workouts` + `external_workouts`.
 *
 *   npm run resolve-sessions
 *   npm run resolve-sessions -- --exclude Hevy,SomeOtherApp
 *   npm run resolve-sessions -- --since 2026-01-01
 *
 * Deduplication lives in `src/health/resolve.ts` and can't be expressed in
 * SQL (transitive overlap clustering with source precedence). SQL-only
 * consumers — reporting agents, dashboards — would otherwise count one gym
 * session up to four times, so this materialises the resolver's output for
 * them.
 *
 * The table is a cache: it is rebuilt wholesale, and dropping it loses
 * nothing. Re-run after every sync or import.
 */

import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { resolveSessions, type WorkoutCandidate } from '../src/health/resolve.js';
import { auditSessions } from '../src/health/audit.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const since = argValue('--since') ?? '1970-01-01';
  const exclude = (argValue('--exclude') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const config = loadConfig();
  const db = await openDatabase(config.dbPath);

  const apiRows = db
    .prepare<unknown[], { data: string }>('SELECT data FROM workouts WHERE day >= ?')
    .all(since);
  const apiCandidates: WorkoutCandidate[] = apiRows.map((r) => {
    const d = JSON.parse(r.data) as Record<string, string>;
    return {
      origin: 'oura_api',
      source_name: 'Oura',
      activity_type: d['activity'] ?? 'Unknown',
      start_time: d['start_datetime'] ?? '',
      end_time: d['end_datetime'] ?? '',
    };
  });

  const extRows = db
    .prepare<
      unknown[],
      {
        source_name: string;
        activity_type: string;
        start_time: string;
        end_time: string;
        energy_kcal: number | null;
        avg_heart_rate: number | null;
        device: string | null;
      }
    >('SELECT * FROM external_workouts WHERE start_time >= ?')
    .all(since);
  const extCandidates: WorkoutCandidate[] = extRows.map((r) => ({
    origin: 'apple_health',
    source_name: r.source_name,
    activity_type: r.activity_type,
    start_time: r.start_time,
    end_time: r.end_time,
    energy_kcal: r.energy_kcal,
    avg_heart_rate: r.avg_heart_rate,
    device: r.device,
  }));

  const sessions = resolveSessions([...apiCandidates, ...extCandidates], {
    ...(exclude.length > 0 ? { excludeSources: exclude } : {}),
  });

  const resolvedAt = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR REPLACE INTO resolved_sessions
       (start_time, end_time, day, activity, is_resistance, duration_min,
        energy_kcal, avg_heart_rate, source, member_count, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const rebuild = db.transaction(() => {
    db.prepare('DELETE FROM resolved_sessions').run();
    for (const s of sessions) {
      insert.run(
        s.start_time,
        s.end_time,
        // Local calendar day — the offset is preserved in start_time, so a
        // late-evening session stays on the day it felt like.
        s.start_time.slice(0, 10),
        s.activity,
        s.is_resistance ? 1 : 0,
        s.duration_min,
        s.energy_kcal,
        s.avg_heart_rate,
        s.source,
        s.members.length,
        resolvedAt,
      );
    }
  });
  rebuild();

  // Audit every rebuild, not on request: a dedupe rule that quietly stops
  // working produces a plausible-looking number, which nobody questions.
  const knownSources = db
    .prepare<unknown[], { source_name: string }>(
      'SELECT DISTINCT source_name FROM external_workouts',
    )
    .all()
    .map((r) => r.source_name);
  const findings = auditSessions({
    candidates: [...apiCandidates, ...extCandidates],
    sessions,
    knownSources: argValue('--known')?.split(',') ?? knownSources,
  });

  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  if (findings.length > 0) {
    process.stdout.write('\naudit:\n');
    for (const f of findings) {
      const where = f.day ? ` [${f.day}]` : '';
      process.stdout.write(`  ${f.severity.toUpperCase()}${where} ${f.code}: ${f.message}\n`);
    }
  }

  const resistance = sessions.filter((s) => s.is_resistance).length;
  process.stdout.write(
    `resolved ${apiCandidates.length + extCandidates.length} records → ` +
      `${sessions.length} sessions (${resistance} resistance)` +
      (exclude.length > 0 ? `, excluding ${exclude.join(', ')}` : '') +
      `\nwritten to resolved_sessions in ${config.dbPath}\n` +
      (findings.length === 0
        ? 'audit: clean\n'
        : `audit: ${errors.length} error(s), ${warnings.length} warning(s)\n`),
  );

  // Non-zero on errors so a scheduled rebuild fails loudly instead of
  // publishing double-counted numbers.
  if (errors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`resolve-sessions: ${(err as Error).message}\n`);
  process.exit(1);
});
