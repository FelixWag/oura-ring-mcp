import { homedir } from 'node:os';
import { join } from 'node:path';
import 'dotenv/config';

export interface Config {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenPath: string;
  dbPath: string;
  debug: boolean;
}

export const OURA_AUTH_URL = 'https://cloud.ouraring.com/oauth/authorize';
export const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';
export const OURA_API_BASE = 'https://api.ouraring.com/v2';

// `tag` added in v0.3 so we can call /v2/usercollection/enhanced_tag.
// Re-run `npm run oauth-login` after upgrading to pick up the new scope.
export const OURA_SCOPES = ['daily', 'heartrate', 'workout', 'session', 'spo2', 'tag', 'personal'];

function configBaseDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'oura-ring-mcp');
}

export function defaultTokenPath(): string {
  return join(configBaseDir(), 'tokens.json');
}

export function defaultDbPath(): string {
  return join(configBaseDir(), 'data.sqlite');
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(): Config {
  const clientId = process.env.OURA_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.OURA_CLIENT_SECRET?.trim() ?? '';
  const redirectUri = process.env.OURA_REDIRECT_URI?.trim() || 'http://127.0.0.1:8765/callback';
  const tokenPath = process.env.OURA_TOKEN_PATH?.trim() || defaultTokenPath();
  const dbPath = process.env.OURA_DB_PATH?.trim() || defaultDbPath();
  const debug = process.env.OURA_DEBUG === '1' || process.env.OURA_DEBUG === 'true';

  if (!clientId || !clientSecret) {
    throw new ConfigError(
      'Missing OURA_CLIENT_ID or OURA_CLIENT_SECRET. Copy .env.example to .env and fill them in, ' +
        'or set them as environment variables. See README for setup.',
    );
  }

  return { clientId, clientSecret, redirectUri, tokenPath, dbPath, debug };
}
