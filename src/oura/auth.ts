import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OURA_AUTH_URL, OURA_SCOPES, OURA_TOKEN_URL } from '../config.js';

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  obtained_at: number;
}

interface OuraTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const url = new URL(OURA_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', (params.scopes ?? OURA_SCOPES).join(' '));
  url.searchParams.set('state', params.state);
  return url.toString();
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

function tokensFromResponse(resp: OuraTokenResponse): StoredTokens {
  const now = Date.now();
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expires_at: now + resp.expires_in * 1000,
    scope: resp.scope ?? '',
    obtained_at: now,
  };
}

async function postTokenRequest(
  clientId: string,
  clientSecret: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<OuraTokenResponse> {
  const res = await fetchImpl(OURA_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(clientId, clientSecret),
      Accept: 'application/json',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AuthError(
      `Token request failed (HTTP ${res.status}). ${text ? 'Server said: ' + text : ''}`.trim(),
    );
  }
  return (await res.json()) as OuraTokenResponse;
}

export async function exchangeCodeForTokens(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
  });
  const resp = await postTokenRequest(params.clientId, params.clientSecret, body, params.fetchImpl);
  return tokensFromResponse(resp);
}

export async function refreshTokens(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
  });
  const resp = await postTokenRequest(params.clientId, params.clientSecret, body, params.fetchImpl);
  return tokensFromResponse(resp);
}

export async function loadTokens(path: string): Promise<StoredTokens | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredTokens>;
    if (
      typeof parsed.access_token === 'string' &&
      typeof parsed.refresh_token === 'string' &&
      typeof parsed.expires_at === 'number'
    ) {
      return {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expires_at: parsed.expires_at,
        scope: parsed.scope ?? '',
        obtained_at: parsed.obtained_at ?? 0,
      };
    }
    return null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveTokens(path: string, tokens: StoredTokens): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
  // Defensive chmod in case rename preserved older perms.
  await chmod(path, 0o600).catch(() => {});
}

export function isExpired(tokens: StoredTokens, skewMs = 60_000): boolean {
  return Date.now() + skewMs >= tokens.expires_at;
}

export function generateState(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
