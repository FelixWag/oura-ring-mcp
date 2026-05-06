import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { saveTokens, type StoredTokens } from '../src/oura/auth.js';
import { OuraClient } from '../src/oura/client.js';

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
});
