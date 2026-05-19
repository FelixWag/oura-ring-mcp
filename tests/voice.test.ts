import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { openDatabase, type Db } from '../src/db/index.js';
import { buildVoiceApp } from '../src/voice/server.ts';
import { Deduper } from '../src/voice/dedupe.ts';
import { buildSystemPrompt } from '../src/voice/prompts.ts';
import { VoiceLogsRepo } from '../src/db/repos/voice_logs.ts';

const TOKEN = 'test-token-abc';
const MCP_ENTRY = '/tmp/fake-mcp-entry.js';

let db: Db;
let appendedLines: string[];

beforeEach(async () => {
  db = await openDatabase(':memory:');
  appendedLines = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface BuildOpts {
  runAgentOverride?: typeof import('../src/voice/agent.ts').runExtractionAgent;
  deduperOverride?: Deduper;
}

function buildApp(opts: BuildOpts = {}) {
  const fakeAgent =
    opts.runAgentOverride ??
    (async () => ({
      ok: true,
      annotation_count: 0,
      summary: 'No health-relevant items extracted.',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    }));
  return buildVoiceApp({
    db,
    voiceConfig: {
      token: TOKEN,
      port: 0,
      logPath: '/tmp/never-written.log',
      mcpEntryPath: MCP_ENTRY,
    },
    deduper: opts.deduperOverride,
    runAgent: fakeAgent,
    appendLog: async (line: string) => {
      appendedLines.push(line);
    },
  });
}

describe('POST /v1/log — auth', () => {
  it('rejects missing Authorization header with 401', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/v1/log')
      .send({ text: 'hi', captured_at: '2026-05-19T08:00:00Z', timezone: 'UTC' });
    expect(res.status).toBe(401);
  });

  it('rejects wrong token with 401', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/v1/log')
      .set('Authorization', 'Bearer wrong')
      .send({ text: 'hi', captured_at: '2026-05-19T08:00:00Z', timezone: 'UTC' });
    expect(res.status).toBe(401);
  });

  it('accepts correct token with 200', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/v1/log')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ text: 'hi', captured_at: '2026-05-19T08:00:00Z', timezone: 'UTC' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /v1/log — validation', () => {
  it('rejects empty text', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/v1/log')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ text: '   ', captured_at: '2026-05-19T08:00:00Z', timezone: 'UTC' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text/);
  });

  it('rejects missing captured_at', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/v1/log')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ text: 'hi', timezone: 'UTC' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/captured_at/);
  });

  it('rejects malformed captured_at', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/v1/log')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ text: 'hi', captured_at: 'not-a-date', timezone: 'UTC' });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/log — dedupe', () => {
  it('rejects duplicates within 60s with deduplicated:true', async () => {
    const deduper = new Deduper({ ttlMs: 60_000 });
    const app = buildApp({ deduperOverride: deduper });
    const body = {
      text: 'I had 2 beers',
      captured_at: '2026-05-19T22:00:00Z',
      timezone: 'Europe/Berlin',
    };
    const first = await request(app)
      .post('/v1/log')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);
    expect(first.body.deduplicated).toBeUndefined();
    const second = await request(app)
      .post('/v1/log')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);
    expect(second.body.deduplicated).toBe(true);
  });

  it('accepts the same text again after the TTL window', async () => {
    let nowMs = 1_000_000;
    const deduper = new Deduper({ ttlMs: 60_000, now: () => nowMs });
    const app = buildApp({ deduperOverride: deduper });
    const body = {
      text: 'hello',
      captured_at: '2026-05-19T22:00:00Z',
      timezone: 'UTC',
    };
    await request(app).post('/v1/log').set('Authorization', `Bearer ${TOKEN}`).send(body);
    nowMs += 61_000;
    const second = await request(app)
      .post('/v1/log')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);
    expect(second.body.deduplicated).toBeUndefined();
  });
});

describe('POST /v1/log — agent invocation', () => {
  it('passes text + captured_at + timezone + mcpEntryPath to the agent', async () => {
    const calls: Parameters<typeof import('../src/voice/agent.ts').runExtractionAgent>[1][] = [];
    const fakeAgent = vi.fn(async (_db: Db, input) => {
      calls.push(input);
      return {
        ok: true,
        annotation_count: 2,
        summary: 'Logged 2',
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      };
    });
    const app = buildApp({ runAgentOverride: fakeAgent });
    await request(app).post('/v1/log').set('Authorization', `Bearer ${TOKEN}`).send({
      text: 'I had 2 beers',
      captured_at: '2026-05-19T22:00:00Z',
      timezone: 'Europe/Berlin',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe('I had 2 beers');
    expect(calls[0]!.captured_at).toBe('2026-05-19T22:00:00Z');
    expect(calls[0]!.user_timezone).toBe('Europe/Berlin');
    expect(calls[0]!.mcpEntryPath).toBe(MCP_ENTRY);
  });

  it('creates a voice_logs row regardless of agent success', async () => {
    const fakeAgent = vi.fn(async () => ({
      ok: false,
      error: 'simulated failure',
      annotation_count: 0,
      summary: '',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    }));
    const app = buildApp({ runAgentOverride: fakeAgent });
    const res = await request(app).post('/v1/log').set('Authorization', `Bearer ${TOKEN}`).send({
      text: 'something',
      captured_at: '2026-05-19T22:00:00Z',
      timezone: 'UTC',
    });
    expect(res.status).toBe(502);

    const repo = new VoiceLogsRepo(db);
    const recent = repo.recent(5);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.ok).toBe(0);
    expect(recent[0]!.error).toBe('simulated failure');
  });

  it('appends a line to the log sink on success', async () => {
    const fakeAgent = vi.fn(async () => ({
      ok: true,
      annotation_count: 1,
      summary: 'Logged 1: tag_sleep_alcohol',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    }));
    const app = buildApp({ runAgentOverride: fakeAgent });
    await request(app).post('/v1/log').set('Authorization', `Bearer ${TOKEN}`).send({
      text: 'I had a beer',
      captured_at: '2026-05-19T22:00:00Z',
      timezone: 'UTC',
    });
    expect(appendedLines).toHaveLength(1);
    expect(appendedLines[0]).toMatch(/voice_log=1\s+ok\s+1 annotations/);
  });
});

describe('GET /healthz', () => {
  it('returns ok without auth', async () => {
    const app = buildApp();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('buildSystemPrompt', () => {
  it('includes captured_at, timezone, and resolved local date', () => {
    const prompt = buildSystemPrompt({
      captured_at: '2026-05-19T22:00:00Z',
      user_timezone: 'America/New_York',
    });
    expect(prompt).toContain('2026-05-19T22:00:00Z');
    expect(prompt).toContain('America/New_York');
    // 22:00 UTC = 18:00 EDT (May → DST). Date is still 2026-05-19.
    expect(prompt).toMatch(/today \(local date\):\s+2026-05-19/);
    expect(prompt).toMatch(/time of day \(local\):\s+18:00/);
  });

  it('handles timezone change for travel: same UTC moment, different local date', () => {
    // 2026-05-19T22:00:00Z is 2026-05-20 in Europe/Berlin (+02:00 in May).
    const prompt = buildSystemPrompt({
      captured_at: '2026-05-19T22:00:00Z',
      user_timezone: 'Europe/Berlin',
    });
    expect(prompt).toMatch(/today \(local date\):\s+2026-05-20/);
    expect(prompt).toMatch(/time of day \(local\):\s+00:00/);
  });

  it('instructs the agent to call oura_add_annotation and only oura_* tools', () => {
    const prompt = buildSystemPrompt({
      captured_at: '2026-05-19T08:00:00Z',
      user_timezone: 'UTC',
    });
    expect(prompt).toContain('oura_add_annotation');
    expect(prompt).toContain('Do NOT write a text response');
    expect(prompt).toContain('ONE tool call per distinct event');
  });
});

describe('Deduper unit', () => {
  it('returns duplicate=true on second identical check within TTL', () => {
    const d = new Deduper({ ttlMs: 60_000 });
    const r1 = d.check('hello', '2026-05-19T22:00:00Z');
    const r2 = d.check('hello', '2026-05-19T22:00:00Z');
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect(r1.hash).toBe(r2.hash);
  });

  it('different text → different hash → no dedupe', () => {
    const d = new Deduper();
    const r1 = d.check('beer', '2026-05-19T22:00:00Z');
    const r2 = d.check('wine', '2026-05-19T22:00:00Z');
    expect(r2.duplicate).toBe(false);
    expect(r1.hash).not.toBe(r2.hash);
  });

  it('evicts expired entries over time', () => {
    let nowMs = 0;
    const d = new Deduper({ ttlMs: 1000, now: () => nowMs });
    d.check('a', 't');
    expect(d.size()).toBe(1);
    nowMs = 2000;
    d.check('b', 't');
    // 'a' should have been evicted during the size sweep.
    expect(d.size()).toBe(1);
  });
});
