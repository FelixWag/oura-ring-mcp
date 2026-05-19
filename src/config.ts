import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

// Load .env relative to the compiled binary, not process.cwd(). This matters
// because Claude Code (and any other MCP host) spawns the server with its
// own working directory, which is almost never the project directory — so
// `import 'dotenv/config'` would silently load nothing and the user would
// see "Missing OURA_CLIENT_ID" even though their .env file exists.
//
// Layout: this file compiles to dist/config.js, so `..` from there is the
// project root. Source-mode (`tsx src/...`) hits src/, so we also try the
// parent of src/. Either way: walk up one directory from where we are.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
loadDotenv({ path: join(projectRoot, '.env'), quiet: true });

export interface Config {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenPath: string;
  dbPath: string;
  debug: boolean;
}

export interface VoiceConfig {
  /** Shared secret iOS Shortcut includes as `Authorization: Bearer <token>`. */
  token: string;
  /** TCP port the voice server binds to. Default 8770. */
  port: number;
  /**
   * File the server appends a one-line summary to after each /v1/log call.
   * Defaults to `./logs/voice.log` relative to the project root so you can
   * `tail -f` it inside the repo directory.
   */
  logPath: string;
  /**
   * Absolute path to the compiled MCP entry the agent should spawn for
   * its MCP transport. Defaults to <projectRoot>/dist/index.js.
   */
  mcpEntryPath: string;
  /** Optional model override for the agent. */
  model?: string;
}

export const OURA_AUTH_URL = 'https://cloud.ouraring.com/oauth/authorize';
export const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';
export const OURA_API_BASE = 'https://api.ouraring.com/v2';

// Scopes by version:
//   v0.1: daily, heartrate, workout, session, spo2, personal
//   v0.3: + tag           (for /v2/usercollection/enhanced_tag)
//   v0.4.2.1: + stress, heart_health
//     stress       → /v2/usercollection/daily_resilience
//     heart_health → /v2/usercollection/daily_cardiovascular_age,
//                    /v2/usercollection/vO2_max,
//                    and likely /v2/usercollection/heartrate (relevant for v0.4.3+)
// Note: /v2/usercollection/daily_stress works under the `daily` scope despite
// its name — Oura's scoping is empirical, not predictable from endpoint names.
//
// Re-run `npm run oauth-login` after upgrading to pick up new scopes.
export const OURA_SCOPES = [
  'daily',
  'heartrate',
  'workout',
  'session',
  'spo2',
  'tag',
  'stress',
  'heart_health',
  'personal',
];

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

/**
 * Default voice-log file path: ./logs/voice.log relative to the project
 * root (resolved via the same anchor we use for .env so it works whether
 * the server is launched from inside or outside the project directory).
 */
export function defaultVoiceLogPath(): string {
  return join(projectRoot, 'logs', 'voice.log');
}

/**
 * Default MCP entry the voice agent spawns. dist/index.js relative to
 * the project root.
 */
export function defaultMcpEntryPath(): string {
  return join(projectRoot, 'dist', 'index.js');
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

export function loadVoiceConfig(): VoiceConfig {
  const token = process.env.VOICE_LOG_TOKEN?.trim() ?? '';
  const portRaw = process.env.OURA_VOICE_PORT?.trim();
  const port = portRaw ? Number(portRaw) : 8770;
  const logPath = process.env.OURA_VOICE_LOG_PATH?.trim() || defaultVoiceLogPath();
  const mcpEntryPath = process.env.OURA_MCP_ENTRY_PATH?.trim() || defaultMcpEntryPath();
  const model = process.env.OURA_VOICE_MODEL?.trim() || undefined;

  if (!token) {
    throw new ConfigError(
      'Missing VOICE_LOG_TOKEN. Generate a random string (e.g. `openssl rand -hex 32`) ' +
        'and add it to your .env. See the .env.example for the full list of voice settings.',
    );
  }
  if (!Number.isFinite(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`OURA_VOICE_PORT must be a valid TCP port; got "${portRaw}".`);
  }

  return { token, port, logPath, mcpEntryPath, model };
}
