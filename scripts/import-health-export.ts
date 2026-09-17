/**
 * One-off backfill from an Apple Health export.
 *
 *   npm run import-health-export -- ~/Downloads/apple_health_export/export.xml
 *   npm run import-health-export -- <path> --dry-run
 *
 * Imports HealthKit workouts (the only route to Oura live-tracked sessions)
 * plus the quantity types we care about (body weight, nutrition). Both writes
 * are idempotent, so re-running the same export changes nothing.
 *
 * Use this for history. Ongoing sync is the job of the import endpoints.
 */

import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { ExternalWorkoutsRepo } from '../src/db/repos/external_workouts.js';
import { HealthSamplesRepo } from '../src/db/repos/health_samples.js';
import { parseHealthExport } from '../src/health/export_parser.js';

function summarize(items: Array<{ source_name?: string | null }>): string {
  const counts = new Map<string, number>();
  for (const i of items) {
    const k = i.source_name ?? 'unknown';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`)
    .join(', ');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const path = args.find((a) => !a.startsWith('--'));

  if (!path) {
    process.stderr.write(
      'usage: npm run import-health-export -- <path/to/export.xml> [--dry-run]\n',
    );
    process.exit(1);
  }

  process.stdout.write(`parsing ${path} …\n`);
  const t0 = Date.now();
  const { workouts, samples, skipped } = await parseHealthExport(path);
  const parseMs = Date.now() - t0;

  process.stdout.write(
    `  workouts: ${workouts.length}  (${summarize(workouts)})\n` +
      `  samples:  ${samples.length}  (${summarize(samples)})\n` +
      `  parsed in ${(parseMs / 1000).toFixed(1)}s\n`,
  );

  const topSkipped = Object.entries(skipped)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, n]) => `${t.split('Identifier')[1] ?? t}=${n}`)
    .join(', ');
  if (topSkipped) process.stdout.write(`  skipped record types (top 5): ${topSkipped}\n`);

  if (dryRun) {
    process.stdout.write('\n--dry-run: nothing written\n');
    return;
  }

  const config = loadConfig();
  const db = await openDatabase(config.dbPath);

  const workoutResult = new ExternalWorkoutsRepo(db).insertBatch(workouts);
  const sampleResult = new HealthSamplesRepo(db).insertBatch(samples);

  process.stdout.write(
    `\nwritten to ${config.dbPath}\n` +
      `  external_workouts: inserted=${workoutResult.inserted} already-present=${workoutResult.deduped}\n` +
      `  health_samples:    inserted=${sampleResult.inserted} already-present=${sampleResult.deduped}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`import-health-export: ${(err as Error).message}\n`);
  process.exit(1);
});
