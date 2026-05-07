import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { saveTokens, type StoredTokens } from '../src/oura/auth.js';
import { OuraClient, parseRetryAfter } from '../src/oura/client.js';

function tokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: Date.now() + 3_600_000,
    scope: 'daily',
    obtained_at: Date.now(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OuraClient', () => {
  it('builds URL with query params and authorization header', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oura-cli-'));
    const path = join(dir, 'tokens.json');
    await saveTokens(path, tokens());

    const fetchImpl = vi.fn(async (url: URL | RequestInfo) =>
      jsonResponse({ data: [{ day: '2026-01-01' }], next_token: null }),
    );

    const client = new OuraClient({
      clientId: 'cid',
      clientSecret: 'csec',
      tokenPath: path,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.getCollection('/usercollection/daily_sleep', {
      start_date: '2026-01-01',
      end_date: '2026-01-02',
    });

    expect(result.data).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledUrl = fetchImpl.mock.calls[0]![0] as URL;
    expect(calledUrl.toString()).toContain('start_date=2026-01-01');
    expect(calledUrl.toString()).toContain('end_date=2026-01-02');
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access');
  });

  it('follows next_token across pages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oura-cli-'));
    const path = join(dir, 'tokens.json');
    await saveTokens(path, tokens());

    const responses = [
      jsonResponse({ data: [{ day: 'd1' }], next_token: 'cursor1' }),
      jsonResponse({ data: [{ day: 'd2' }], next_token: 'cursor2' }),
      jsonResponse({ data: [{ day: 'd3' }], next_token: null }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);

    const client = new OuraClient({
      clientId: 'cid',
      clientSecret: 'csec',
      tokenPath: path,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const r = await client.getCollection<{ day: string }>('/usercollection/daily_sleep', {
      start_date: '2026-01-01',
      end_date: '2026-01-03',
    });
    expect(r.data.map((x) => x.day)).toEqual(['d1', 'd2', 'd3']);
    expect(r.truncated).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('refreshes once on 401 and retries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oura-cli-'));
    const path = join(dir, 'tokens.json');
    await saveTokens(path, tokens({ access_token: 'old' }));

    const calls: { url: string; auth: string }[] = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const u = url instanceof URL ? url : new URL(String(url));
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? '';
      calls.push({ url: u.toString(), auth });
      if (u.pathname.endsWith('/oauth/token')) {
        return jsonResponse({
          access_token: 'new',
          refresh_token: 'r2',
          expires_in: 3600,
          scope: 'daily',
          token_type: 'Bearer',
        });
      }
      if (auth === 'Bearer old') {
        return new Response('unauthorized', { status: 401 });
      }
      return jsonResponse({ data: [{ day: 'd1' }], next_token: null });
    });

    const client = new OuraClient({
      clientId: 'cid',
      clientSecret: 'csec',
      tokenPath: path,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const r = await client.getCollection('/usercollection/daily_sleep', {
      start_date: '2026-01-01',
      end_date: '2026-01-02',
    });
    expect(r.data).toHaveLength(1);
    // 1st call: 401 with old token. 2nd: token refresh. 3rd: retry with new token.
    expect(calls.map((c) => (c.auth.startsWith('Bearer ') ? c.auth : 'basic'))).toEqual([
      'Bearer old',
      'basic',
      'Bearer new',
    ]);
  });

  it('throws AuthError when no tokens file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oura-cli-'));
    const client = new OuraClient({
      clientId: 'cid',
      clientSecret: 'csec',
      tokenPath: join(dir, 'missing.json'),
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    await expect(client.getCollection('/usercollection/daily_sleep', {})).rejects.toThrow(
      /No saved tokens/,
    );
  });

  it('retries once on 429 honoring Retry-After', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oura-cli-'));
    const path = join(dir, 'tokens.json');
    await saveTokens(path, tokens());

    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      }
      return jsonResponse({ data: [{ day: 'd1' }], next_token: null });
    });

    const sleepCalls: number[] = [];
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };

    const client = new OuraClient({
      clientId: 'cid',
      clientSecret: 'csec',
      tokenPath: path,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    const r = await client.getCollection('/usercollection/daily_sleep', {
      start_date: '2026-01-01',
      end_date: '2026-01-02',
    });
    expect(r.data).toHaveLength(1);
    expect(calls).toBe(2);
    expect(sleepCalls).toEqual([0]);
  });

  it('gives up after the rate-limit retry budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oura-cli-'));
    const path = join(dir, 'tokens.json');
    await saveTokens(path, tokens());

    const fetchImpl = vi.fn(
      async () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } }),
    );
    const sleepImpl = async () => {};

    const client = new OuraClient({
      clientId: 'cid',
      clientSecret: 'csec',
      tokenPath: path,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    await expect(
      client.getCollection('/usercollection/daily_sleep', {
        start_date: '2026-01-01',
        end_date: '2026-01-02',
      }),
    ).rejects.toThrow(/429/);
    // Initial + 2 retries = 3 calls total.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('parseRetryAfter', () => {
  it('parses integer seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000);
  });

  it('parses fractional seconds', () => {
    expect(parseRetryAfter('1.5')).toBe(1500);
  });

  it('parses HTTP-date strings', () => {
    const future = new Date(Date.now() + 2000).toUTCString();
    const result = parseRetryAfter(future);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(2000);
  });

  it('returns undefined on missing or unparseable input', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('not a date')).toBeUndefined();
  });
});
