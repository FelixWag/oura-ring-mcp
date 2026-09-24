/**
 * Every headless agent session is isolated: no filesystem settings, only the
 * MCP servers it is given, no persisted transcript or auto-memory, an empty
 * cwd, an explicit list of built-in tools, and a pinned model and effort.
 *
 * The SDK is mocked, so no test calls a model — and so no test here can notice
 * the SDK changing what these options mean. That was probed by hand; see
 * src/agent/session.ts. Synthetic fixtures only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const { captured } = vi.hoisted(() => ({ captured: [] as Record<string, unknown>[] }));

// One canned reply for every session. It is a meal estimate so the extractor
// can parse it; the voice agent ignores the text.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    captured.push(options);
    return (async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: '{"description":"test plate","items":[],"totals":{"dietary_energy_consumed":500},"confidence":0.5}',
            },
          ],
        },
      };
      yield { type: 'result', subtype: 'success', result: '' };
    })();
  },
}));

import type { Db } from '../src/db/index.js';
import { requireEmptyAgentCwd } from '../src/agent/session.js';
import { defaultAgentCwd } from '../src/config.js';
import { runExtractionAgent } from '../src/voice/agent.js';
import { correctMeal, extractMeal } from '../src/telegram/extractor.js';

type CanUseTool = (name: string, input: Record<string, unknown>) => Promise<{ behavior: string }>;

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

let tmp: string;
const originalDbPath = process.env.OURA_DB_PATH;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'oura-isolation-'));
  // Never let a test create the agent cwd beside the real database.
  process.env.OURA_DB_PATH = join(tmp, 'data.sqlite');
  captured.length = 0;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (originalDbPath === undefined) delete process.env.OURA_DB_PATH;
  else process.env.OURA_DB_PATH = originalDbPath;
});

function lastOptions(): Record<string, unknown> {
  const options = captured.at(-1);
  if (!options) throw new Error('query() was never called');
  return options;
}

const voiceInput = {
  text: 'had two coffees this morning',
  captured_at: '2026-01-15T08:00:00Z',
  user_timezone: 'UTC',
  mcpEntryPath: '/nonexistent/dist/index.js',
};

const mealContext = () => ({
  photoPath: join(tmp, 'telegram-media', 'photo.jpg'),
  caption: null,
  localTime: '12:30',
  localDay: '2026-01-15',
  timezone: 'UTC',
});

/** What isolatedSessionOptions() must have contributed, whoever the caller. */
function expectIsolated(options: Record<string, unknown>): void {
  expect(options.settingSources).toEqual([]);
  expect(options.strictMcpConfig).toBe(true);
  expect(options.persistSession).toBe(false);
  expect((options.env as Record<string, string>).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  expect(options.cwd).toBe(defaultAgentCwd());
}

describe('requireEmptyAgentCwd', () => {
  it('creates the directory 0700 when it is absent', () => {
    const dir = join(tmp, 'agent-cwd');
    expect(requireEmptyAgentCwd(dir)).toBe(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('tightens a directory that already existed with looser permissions', () => {
    const dir = join(tmp, 'agent-cwd');
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    requireEmptyAgentCwd(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a directory with anything in it, since reads there skip the allowlist', () => {
    const dir = join(tmp, 'agent-cwd');
    mkdirSync(dir);
    writeFileSync(join(dir, '.env'), 'SECRET=synthetic');
    expect(() => requireEmptyAgentCwd(dir)).toThrow(/not empty/);
  });

  it('ignores the .DS_Store Finder leaves behind', () => {
    const dir = join(tmp, 'agent-cwd');
    mkdirSync(dir);
    writeFileSync(join(dir, '.DS_Store'), '');
    expect(() => requireEmptyAgentCwd(dir)).not.toThrow();
  });

  it('lives outside the repo, so the repo .env is not inside the auto-approved cwd', () => {
    // Uses the real default resolution, not the test's temporary one.
    delete process.env.OURA_DB_PATH;
    expect(relative(REPO_ROOT, defaultAgentCwd()).startsWith('..')).toBe(true);
  });
});

describe('voice agent session', () => {
  it('is isolated and has no built-in tools', async () => {
    const result = await runExtractionAgent(null as unknown as Db, voiceInput);
    expect(result.ok).toBe(true);

    const options = lastOptions();
    expectIsolated(options);
    expect(options.tools).toEqual([]);
    expect(readdirSync(options.cwd as string)).toEqual([]);
  });

  it('passes no env to its MCP server, since that config lands on the command line', async () => {
    await runExtractionAgent(null as unknown as Db, voiceInput);
    const servers = lastOptions().mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.oura).toBeDefined();
    expect(servers.oura.env).toBeUndefined();
  });

  // Literal on purpose: changing the model or effort should be a decision
  // someone makes here too, not a side effect of editing a constant.
  it('pins Opus 5 at medium effort rather than inheriting operator settings', async () => {
    await runExtractionAgent(null as unknown as Db, voiceInput);
    expect(lastOptions().model).toBe('claude-opus-5');
    expect(lastOptions().effort).toBe('medium');
  });

  it('still honours an explicit model override', async () => {
    await runExtractionAgent(null as unknown as Db, { ...voiceInput, model: 'claude-sonnet-5' });
    expect(lastOptions().model).toBe('claude-sonnet-5');
  });

  it('fails loudly, without starting a session, when the agent cwd is not empty', async () => {
    mkdirSync(defaultAgentCwd(), { recursive: true });
    writeFileSync(join(defaultAgentCwd(), 'stray.txt'), 'x');

    const result = await runExtractionAgent(null as unknown as Db, voiceInput);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not empty/);
    expect(captured).toHaveLength(0);
  });
});

describe('meal extractor session', () => {
  it('is isolated and keeps only Read', async () => {
    const result = await extractMeal(mealContext());
    expect(result.ok).toBe(true);

    const options = lastOptions();
    expectIsolated(options);
    expect(options.tools).toEqual(['Read']);
    expect(options.model).toBe('claude-opus-5');
    expect(options.effort).toBe('medium');
  });

  it('gets no Read tool for a text-only correction with no stored photo', async () => {
    await correctMeal({ ...mealContext(), photoPath: '', previous: {} });
    expect(lastOptions().tools).toEqual([]);
  });

  it('allows Read of the named photo and nothing else', async () => {
    const ctx = mealContext();
    await extractMeal(ctx);
    const canUseTool = lastOptions().canUseTool as CanUseTool;

    expect((await canUseTool('Read', { file_path: ctx.photoPath })).behavior).toBe('allow');
    expect((await canUseTool('Read', { file_path: join(REPO_ROOT, '.env') })).behavior).toBe(
      'deny',
    );
    expect((await canUseTool('Bash', { command: 'cat .env' })).behavior).toBe('deny');
  });
});

describe('every SDK call site', () => {
  function tsFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return tsFiles(path);
      return entry.name.endsWith('.ts') ? [path] : [];
    });
  }

  // Any value import counts, not just `query`: an alias (`query as run`) or a
  // namespace import would otherwise slip past the counts below unexamined.
  const importsSdkValue = /^import\s+(?!type\b)[^;]*from\s*'@anthropic-ai\/claude-agent-sdk'/m;
  const callers = () =>
    tsFiles(SRC)
      .filter((file) => importsSdkValue.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file))
      .sort();

  // The v0.11 extractor was a second call site that repeated the omission the
  // voice agent already had. A rule written down elsewhere did not stop it;
  // this does. A new caller must be added here on purpose, and then pass the
  // checks below.
  it('is one of the known callers', () => {
    expect(callers()).toEqual(['telegram/extractor.ts', 'voice/agent.ts']);
  });

  it('isolates last, lists tools, and pins model and effort in every query() call', () => {
    for (const name of callers()) {
      const source = readFileSync(join(SRC, name), 'utf8');
      // The text of each `query({ ... })` call, so a `model` elsewhere in the
      // file cannot stand in for one missing from the call.
      const calls = [...source.matchAll(/\bquery\(\{([\s\S]*?)\n\s*\}\);/g)].map((m) => m[1] ?? '');
      expect(
        calls.length,
        `${name}: every query( call is a query({ ... }); call (prose "query()" excluded)`,
      ).toBe(source.match(/\bquery\((?!\))/g)?.length);

      for (const call of calls) {
        // `name` is on both sides so a failure says which file.
        expect({
          name,
          isolatedLast: /\.\.\.isolatedSessionOptions\(\),\s*\},?\s*$/.test(call),
          tools: /^\s*tools: /m.test(call),
          model: /^\s*model[,:]/m.test(call),
          effort: /^\s*effort: /m.test(call),
        }).toEqual({ name, isolatedLast: true, tools: true, model: true, effort: true });
      }
    }
  });
});
