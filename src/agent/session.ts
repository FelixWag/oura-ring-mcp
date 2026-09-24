/**
 * What every headless agent session is isolated from, decided in one place.
 *
 * `canUseTool` is not the whole boundary. Probed on SDK 0.3.144 (the tests
 * mock the SDK and cannot catch a change here — re-probe on upgrade: a session
 * whose `canUseTool` denies everything, asked to `Read` a file in its cwd):
 *
 *   - Without `settingSources: []` the session loads user settings
 *     (`~/.claude`) and project/local settings (from its cwd). Their allow-rules
 *     are evaluated BEFORE `canUseTool`, so an allow-rule runs a command the
 *     callback would deny, and they bring MCP servers and connectors with them.
 *   - Even with settings isolated, reads inside the session's cwd (`Read`, and
 *     read-only Bash such as `cat`) are approved without `canUseTool` being
 *     consulted at all. Reads in a sibling directory are not.
 *
 * Both agents used to run with the repo root as cwd, beside `.env` (the OAuth
 * client secret and every bearer token). So a session gets no settings, only
 * the MCP servers passed to it, no persisted transcript or auto-memory (the CLI
 * approves reads in its own directories without a check too), and a cwd that is
 * an empty directory: the reads that skip the callback find nothing. Which
 * built-in tools exist at all is the caller's `tools` list, per agent.
 */

import { chmodSync, mkdirSync, readdirSync } from 'node:fs';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { defaultAgentCwd } from '../config.js';

/** Finder drops these into any directory it displays; they hold nothing. */
const IGNORED_ENTRIES = new Set(['.DS_Store']);

/**
 * Create the agent cwd if needed and refuse to proceed unless it is empty.
 * Checked on every call, never cleared: a file here is readable by any agent
 * without a permission check, so the right response is to stop, not to delete.
 */
export function requireEmptyAgentCwd(dir: string = defaultAgentCwd()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode does not apply to a directory that already existed.
  chmodSync(dir, 0o700);

  const entries = readdirSync(dir).filter((name) => !IGNORED_ENTRIES.has(name));
  if (entries.length > 0) {
    throw new Error(
      `agent working directory ${dir} is not empty (${entries.slice(0, 3).join(', ')}); ` +
        'reads inside it bypass the tool allowlist, so no agent will start there. ' +
        'Find out what wrote it, then empty the directory.',
    );
  }
  return dir;
}

type IsolatedOptions = Required<
  Pick<Options, 'settingSources' | 'cwd' | 'strictMcpConfig' | 'persistSession' | 'env'>
>;

/**
 * Spread LAST into every `query()` options object, so nothing above it can
 * override isolation. Creates the agent cwd and throws if it is not empty —
 * call it where a throw becomes a failed run.
 */
export function isolatedSessionOptions(): IsolatedOptions {
  return {
    settingSources: [],
    cwd: requireEmptyAgentCwd(),
    // Only the MCP servers passed in `mcpServers`: never the user's connectors.
    strictMcpConfig: true,
    // No transcript under ~/.claude/projects: it would copy voice notes, query
    // results and photos out of the database into plaintext, in a directory
    // the CLI reads without asking `canUseTool`. Not everything: large tool
    // results are still spilled to files there (seen in a probe; the
    // directory is 0700).
    persistSession: false,
    // Auto-memory is loaded into later sessions and writable without a check.
    env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
  };
}
