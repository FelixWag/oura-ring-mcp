#!/usr/bin/env tsx
/**
 * `npm run sync` — pulls Oura data into the local SQLite mirror.
 *
 * Flags:
 *   --full         re-fetch the full lookback window for every collection
 *   --since N      force-refetch the last N days (regardless of state)
 *   --tags-only    only sync enhanced_tag and refresh discovered_tag_types
 *   -h, --help     print this help
 *
 * Default behavior is incremental: each collection picks up where it left
 * off, plus a 7-day overlap so Oura's same-day re-scoring is captured.
 */

import { ConfigError, loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { runSync, type SyncOptions } from '../src/db/sync.js';
import { OuraClient } from '../src/oura/client.js';

interface CliArgs {
  since?: number;
  full: boolean;
  tags_only: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { full: false, tags_only: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--full') out.full = true;
    else if (a === '--tags-only') out.tags_only = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--since') {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error('--since requires a positive number of days, e.g. --since 14');
      }
      out.since = n;
      i += 1;
    } else if (a && a.startsWith('--since=')) {
      const n = Number(a.slice('--since='.length));
      if (!Number.isFinite(n) || n < 1) {
        throw new Error('--since requires a positive number of days, e.g. --since=14');
      }
      out.since = n;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return out;
}

const HELP = `
oura-ring-mcp sync

Pulls Oura data into the local SQLite mirror so MCP queries answer locally.

Usage:
  npm run sync                  # incremental, default (recommended)
  npm run sync -- --full        # re-fetch the full lookback window
  npm run sync -- --since 14    # re-fetch the last 14 days
  npm run sync -- --tags-only   # only enhanced_tag (and discovered codes)

Notes:
  - First run pulls ~30 days back. Subsequent runs incremental + 7-day overlap.
  - Heart-rate timeseries is NOT mirrored (use the oura_get_heartrate tool).
`;

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

async function main(): Promise<void> {
  let cli: CliArgs;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`\n  ${(err as Error).message}\n${HELP}`);
    process.exit(2);
  }

  if (cli.help) {
    process.stdout.write(HELP);
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n  ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const client = new OuraClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tokenPath: config.tokenPath,
    debug: config.debug,
  });
  const db = await openDatabase(config.dbPath);

  const options: SyncOptions = {
    since_days: cli.since,
    full: cli.full,
    tags_only: cli.tags_only,
  };

  process.stdout.write('Syncing Oura data...\n');
  const t0 = Date.now();
  const result = await runSync({ client, db }, options);
  const elapsed = fmtDuration(Date.now() - t0);

  // Per-collection summary table.
  process.stdout.write('\n  collection         status   rows   range\n');
  process.stdout.write('  ' + '-'.repeat(64) + '\n');
  let okCount = 0;
  let failCount = 0;
  let totalRows = 0;
  for (const c of result.collections) {
    const status = c.ok ? 'ok    ' : 'failed';
    const range = `${c.from_date} → ${c.to_date}`;
    const rows = String(c.rows_upserted).padStart(5);
    process.stdout.write(`  ${c.collection.padEnd(18)} ${status}  ${rows}   ${range}\n`);
    if (c.ok) {
      okCount += 1;
      totalRows += c.rows_upserted;
    } else {
      failCount += 1;
    }
  }
  process.stdout.write('  ' + '-'.repeat(64) + '\n');
  process.stdout.write(
    `  ${okCount} ok, ${failCount} failed, ${totalRows} rows upserted in ${elapsed}\n`,
  );

  // Show errors detail.
  for (const c of result.collections) {
    if (!c.ok) {
      process.stdout.write(`\n  ${c.collection} error: ${c.error}\n`);
    }
  }

  // Show newly-discovered tag codes (from the enhanced_tag sync).
  const tagsCol = result.collections.find((c) => c.collection === 'enhanced_tag');
  if (tagsCol?.newly_discovered_tag_codes && tagsCol.newly_discovered_tag_codes.length > 0) {
    process.stdout.write(
      `\n  Discovered ${tagsCol.newly_discovered_tag_codes.length} new tag_type_code(s) ` +
        'not in the static seed list:\n',
    );
    for (const code of tagsCol.newly_discovered_tag_codes) {
      process.stdout.write(`    - ${code}\n`);
    }
    process.stdout.write(
      '\n  These are accepted by the annotation validator already (via the dynamic ' +
        '`discovered_tag_types` table). Optionally promote frequently-seen codes to ' +
        'src/db/tag_types.ts so they ship as part of the seed list.\n',
    );
  }

  db.close();

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`\n  Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
