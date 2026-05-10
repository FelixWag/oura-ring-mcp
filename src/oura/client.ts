import { OURA_API_BASE } from '../config.js';
import {
  AuthError,
  isExpired,
  loadTokens,
  refreshTokens,
  saveTokens,
  type StoredTokens,
} from './auth.js';

export interface OuraClientOptions {
  clientId: string;
  clientSecret: string;
  tokenPath: string;
  debug?: boolean;
  fetchImpl?: typeof fetch;
  /**
   * Sleep helper used by the 429 retry path. Override in tests so they don't
   * actually wait. Defaults to a real `setTimeout`.
   */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface PaginatedResponse<T> {
  data: T[];
  next_token: string | null;
}

export class OuraApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'OuraApiError';
    this.status = status;
  }
}

const DEFAULT_PAGE_LIMIT = 5;
const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_DEFAULT_BACKOFF_MS = 1000;
const RATE_LIMIT_MAX_BACKOFF_MS = 30_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Parse a `Retry-After` header. Oura sends seconds; the spec also allows an
 * HTTP-date. Returns milliseconds, or undefined if the header is missing or
 * unparseable. Caller falls back to a sane default.
 */
export function parseRetryAfter(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const asDate = Date.parse(headerValue);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

export class OuraClient {
  private tokens: StoredTokens | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private refreshPromise: Promise<StoredTokens> | null = null;

  constructor(private readonly opts: OuraClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? defaultSleep;
  }

  private debug(msg: string): void {
    if (this.opts.debug) {
      // Log to stderr so it doesn't pollute MCP stdio output.
      process.stderr.write(`[oura-mcp] ${msg}\n`);
    }
  }

  private async ensureTokens(): Promise<StoredTokens> {
    if (!this.tokens) {
      const loaded = await loadTokens(this.opts.tokenPath);
      if (!loaded) {
        throw new AuthError(
          `No saved tokens at ${this.opts.tokenPath}. Run \`npm run oauth-login\` first.`,
        );
      }
      this.tokens = loaded;
    }
    if (isExpired(this.tokens)) {
      this.tokens = await this.refresh();
    }
    return this.tokens;
  }

  private async refresh(): Promise<StoredTokens> {
    if (this.refreshPromise) return this.refreshPromise;
    if (!this.tokens) throw new AuthError('Cannot refresh: no tokens loaded.');
    const refreshToken = this.tokens.refresh_token;
    this.refreshPromise = (async () => {
      this.debug('refreshing access token');
      const next = await refreshTokens({
        clientId: this.opts.clientId,
        clientSecret: this.opts.clientSecret,
        refreshToken,
        fetchImpl: this.fetchImpl,
      });
      await saveTokens(this.opts.tokenPath, next);
      this.tokens = next;
      return next;
    })();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async request(
    path: string,
    query: Record<string, string | undefined>,
    attempt = 0,
    rateLimitRetries = 0,
  ): Promise<unknown> {
    const tokens = await this.ensureTokens();
    const url = new URL(OURA_API_BASE + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
    this.debug(`GET ${path} ${url.searchParams.toString()}`);
    const res = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/json',
      },
    });

    if (res.status === 401 && attempt === 0) {
      // Peek at the body to distinguish "expired token" (refresh helps) from
      // "missing scope" (refresh doesn't help — user must re-authorize).
      // We clone first so we can still read the body in the error path below.
      const probe = res.clone();
      let probeBody = '';
      try {
        probeBody = await probe.text();
      } catch {
        // ignore
      }
      if (/scope/i.test(probeBody)) {
        this.debug('401 missing-scope — refresh would not help, surfacing error directly');
        // Fall through to the error block below using the original `res`.
      } else {
        this.debug('401 received — refreshing tokens and retrying once');
        await this.refresh();
        return this.request(path, query, attempt + 1, rateLimitRetries);
      }
    }

    if (res.status === 429 && rateLimitRetries < RATE_LIMIT_MAX_RETRIES) {
      const headerValue = res.headers.get('Retry-After');
      const baseDelay = parseRetryAfter(headerValue);
      // Exponential backoff if Retry-After is missing or zero.
      const fallback = Math.min(
        RATE_LIMIT_DEFAULT_BACKOFF_MS * Math.pow(2, rateLimitRetries),
        RATE_LIMIT_MAX_BACKOFF_MS,
      );
      const delay = Math.min(baseDelay ?? fallback, RATE_LIMIT_MAX_BACKOFF_MS);
      this.debug(`429 received — sleeping ${delay}ms before retry ${rateLimitRetries + 1}`);
      await this.sleepImpl(delay);
      return this.request(path, query, attempt, rateLimitRetries + 1);
    }

    if (!res.ok) {
      let detail = '';
      try {
        const text = await res.text();
        detail = text.slice(0, 500);
      } catch {
        // ignore
      }
      // 401 with "scope" in the body almost always means the user upgraded
      // the project (which added new scopes to OURA_SCOPES) but didn't
      // re-run `npm run oauth-login`, so the stored token still has the
      // older scope set. Surface the fix instead of a raw API error.
      const scopeHint =
        res.status === 401 && /scope/i.test(detail)
          ? ' — your saved token is missing a required scope; run `npm run oauth-login` to re-authorize.'
          : '';
      throw new OuraApiError(
        res.status,
        `Oura API ${res.status} for ${path}${detail ? ` — ${detail}` : ''}${scopeHint}`,
      );
    }

    return res.json();
  }

  /**
   * Fetch a paginated collection, following next_token up to `pageLimit` pages.
   */
  async getCollection<T>(
    path: string,
    query: Record<string, string | undefined>,
    pageLimit = DEFAULT_PAGE_LIMIT,
  ): Promise<{ data: T[]; truncated: boolean }> {
    let all: T[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    let truncated = false;

    while (true) {
      pages += 1;
      const resp = (await this.request(path, {
        ...query,
        ...(nextToken ? { next_token: nextToken } : {}),
      })) as PaginatedResponse<T>;
      if (Array.isArray(resp.data)) all = all.concat(resp.data);
      const nt = resp.next_token;
      if (!nt) break;
      if (pages >= pageLimit) {
        truncated = true;
        break;
      }
      nextToken = nt;
    }
    return { data: all, truncated };
  }

  async getOne<T>(path: string): Promise<T> {
    return (await this.request(path, {})) as T;
  }
}
