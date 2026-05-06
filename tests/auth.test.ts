import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  isExpired,
  loadTokens,
  saveTokens,
  type StoredTokens,
} from '../src/oura/auth.js';

function makeTokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    access_token: 'a',
    refresh_token: 'r',
    expires_at: Date.now() + 3_600_000,
    scope: 'daily',
    obtained_at: Date.now(),
    ...overrides,
  };
}

describe('buildAuthorizeUrl', () => {
  it('includes required OAuth params', () => {
    const url = buildAuthorizeUrl({
      clientId: 'CID',
      redirectUri: 'http://127.0.0.1:8765/callback',
      state: 'abc',
      scopes: ['daily', 'heartrate'],
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://cloud.ouraring.com/oauth/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('CID');
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8765/callback');
    expect(u.searchParams.get('scope')).toBe('daily heartrate');
    expect(u.searchParams.get('state')).toBe('abc');
  });
});

describe('isExpired', () => {
  it('treats tokens within skew as expired', () => {
    expect(isExpired(makeTokens({ expires_at: Date.now() + 30_000 }))).toBe(true);
    expect(isExpired(makeTokens({ expires_at: Date.now() + 5 * 60_000 }))).toBe(false);
  });
});

describe('saveTokens / loadTokens', () => {
  it('round-trips tokens with 0600 perms', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oura-test-'));
    const path = join(dir, 'tokens.json');
    const tokens = makeTokens();
    await saveTokens(path, tokens);

    const loaded = await loadTokens(path);
    expect(loaded).toEqual(tokens);

    const s = await stat(path);
    // mode lower bits should be 0600 on POSIX
    if (process.platform !== 'win32') {
      expect(s.mode & 0o777).toBe(0o600);
    }

    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('access_token');
  });

  it('returns null when file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oura-test-'));
    expect(await loadTokens(join(dir, 'nope.json'))).toBeNull();
  });
});
