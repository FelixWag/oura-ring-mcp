/**
 * What every headless agent session is isolated from, decided in one place.
 *
 * `canUseTool` is not the whole boundary. Probed on SDK 0.3.144:
 *
 *   - Without `settingSources: []` the session loads user, project and local
 *     settings from its cwd, and their allow-rules are evaluated BEFORE
 *     `canUseTool` — an allow-rule runs a command the callback would deny.
 *   - Even with settings isolated, reads inside the session's cwd (`Read`, and
 *     read-only Bash such as `cat`) are auto-approved without `canUseTool`
 *     being consulted at all.
 *
 * Both agents used to run with the repo root as cwd, beside a `.env` holding
 * every secret this project has. So a session gets no settings, and a cwd that
 * is an empty directory: the reads that skip the callback find nothing. Which
 * built-in tools exist at all is the caller's `tools` list, per agent.
 */

import { chmodSync, mkdirSync, readdirSync } from 'node:fs';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { defaultAgentCwd } from '../config.js';

/** Finder drops these into any directory it displays; they hold nothing. */
const IGNORED_ENTRIES = new Set(['.DS_Store']);

/**
 * Create the agent cwd if needed and prove it is empty, on every call.
 *
 * Refusing to run beats running beside whatever appeared there: a file in this
 * directory is readable by any agent without a permission check.
 */
export function ensureEmptyAgentCwd(dir: string = defaultAgentCwd()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode does not apply to a directory that already existed.
  chmodSync(dir, 0o700);

  const entries = readdirSync(dir).filter((name) => !IGNORED_ENTRIES.has(name));
  if (entries.length > 0) {
    throw new Error(
      `agent working directory ${dir} is not empty (${entries.slice(0, 3).join(', ')}); ` +
        'refusing to start an agent there, since reads inside it bypass the tool allowlist',
    );
  }
  return dir;
}

/** Spread into every `query()` options object. */
export function isolatedSessionOptions(): Pick<Options, 'settingSources' | 'cwd'> {
  return { settingSources: [], cwd: ensureEmptyAgentCwd() };
}
