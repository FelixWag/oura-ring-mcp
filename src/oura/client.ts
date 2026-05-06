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

export class OuraClient {
  private tokens: StoredTokens | null = null;
  private readonly fetchImpl: typeof fetch;
  private refreshPromise: Promise<StoredTokens> | null = null;

  constructor(private readonly opts: OuraClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
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
      this.debug('401 received — refreshing tokens and retrying once');
      await this.refresh();
      return this.request(path, query, attempt + 1);
    }

    if (!res.ok) {
      let detail = '';
      try {
        const text = await res.text();
        detail = text.slice(0, 500);
      } catch {
        // ignore
      }
      throw new OuraApiError(
        res.status,
        `Oura API ${res.status} for ${path}${detail ? ` — ${detail}` : ''}`,
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
