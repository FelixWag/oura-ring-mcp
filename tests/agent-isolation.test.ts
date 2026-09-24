/**
 * Every headless agent session is isolated: no filesystem settings, an empty
 * cwd, an explicit list of built-in tools, and a pinned model and effort.
 *
 * The SDK is mocked, so no test calls a model. What these options defend
 * against was probed by hand against the real SDK — see src/agent/sandbox.ts.
 * Synthetic fixtures only.
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
import { ensureEmptyAgentCwd } from '../src/agent/sandbox.js';
import { defaultAgentCwd } from '../src/config.js';
import { runExtractionAgent } from '../src/voice/agent.js';
import { extractMeal } from '../src/telegram/extractor.js';

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

describe('ensureEmptyAgentCwd', () => {
  it('creates the directory 0700 when it is absent', () => {
    const dir = join(tmp, 'agent-cwd');
    expect(ensureEmptyAgentCwd(dir)).toBe(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('tightens a directory that already existed with looser permissions', () => {
    const dir = join(tmp, 'agent-cwd');
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    ensureEmptyAgentCwd(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a directory with anything in it, since reads there skip the allowlist', () => {
    const dir = join(tmp, 'agent-cwd');
    mkdirSync(dir);
    writeFileSync(join(dir, '.env'), 'SECRET=synthetic');
    expect(() => ensureEmptyAgentCwd(dir)).toThrow(/not empty/);
  });

  it('ignores the .DS_Store Finder leaves behind', () => {
    const dir = join(tmp, 'agent-cwd');
    mkdirSync(dir);
    writeFileSync(join(dir, '.DS_Store'), '');
    expect(() => ensureEmptyAgentCwd(dir)).not.toThrow();
  });
});

describe('voice agent session', () => {
  it('loads no settings, has no built-in tools, and runs in the empty agent cwd', async () => {
    const result = await runExtractionAgent(null as unknown as Db, voiceInput);
    expect(result.ok).toBe(true);

    const options = lastOptions();
    expect(options.settingSources).toEqual([]);
    expect(options.tools).toEqual([]);
    expect(options.cwd).toBe(defaultAgentCwd());
    expect(readdirSync(options.cwd as string)).toEqual([]);
  });

  it('pins Opus 5 at medium effort rather than inheriting the operator settings', async () => {
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
  it('loads no settings, keeps only Read, and runs in the empty agent cwd', async () => {
    const result = await extractMeal(mealContext());
    expect(result.ok).toBe(true);

    const options = lastOptions();
    expect(options.settingSources).toEqual([]);
    expect(options.tools).toEqual(['Read']);
    expect(options.cwd).toBe(defaultAgentCwd());
    expect(options.model).toBe('claude-opus-5');
    expect(options.effort).toBe('medium');
  });

  it('runs outside the repo, so the repo .env is not inside the auto-approved cwd', async () => {
    await extractMeal(mealContext());
    const cwd = lastOptions().cwd as string;
    expect(relative(REPO_ROOT, cwd).startsWith('..')).toBe(true);
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

  // The v0.11 extractor was a second call site that repeated the omission the
  // voice agent already had. A rule written down elsewhere did not stop it;
  // this does.
  it('spreads isolatedSessionOptions() and names its tools in every query() call', () => {
    const importsQuery =
      /import\s*\{[^}]*\bquery\b[^}]*\}\s*from\s*'@anthropic-ai\/claude-agent-sdk'/;
    const callers = tsFiles(SRC).filter((file) => importsQuery.test(readFileSync(file, 'utf8')));
    expect(callers.length).toBeGreaterThan(0);

    for (const file of callers) {
      const source = readFileSync(file, 'utf8');
      const calls = source.match(/\bquery\(\{/g)?.length ?? 0;
      const isolated = source.match(/\.\.\.isolatedSessionOptions\(\)/g)?.length ?? 0;
      const toolLists = source.match(/^\s*tools: \[/gm)?.length ?? 0;
      const name = relative(SRC, file);
      expect({ name, isolated, toolLists }).toEqual({ name, isolated: calls, toolLists: calls });
    }
  });
});
