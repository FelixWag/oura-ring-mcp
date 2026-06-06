/**
 * HTTP server for voice ingestion.
 *
 * Single endpoint: POST /v1/log
 *   Auth:  Authorization: Bearer <VOICE_LOG_TOKEN>
 *   Body:  { text, captured_at, timezone, source }
 *   Flow:  validate → dedupe → start voice_log row → run agent →
 *          link annotations → append voice.log → respond
 *
 * Designed to live on a Mac mini reachable over Tailscale. No public
 * internet exposure. See README and docs/siri-shortcut.md for setup.
 */

import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import { loadConfig, loadVoiceConfig, type VoiceConfig } from '../config.js';
import { openDatabase, type Db } from '../db/index.js';
import { VoiceLogsRepo } from '../db/repos/voice_logs.js';
import { Deduper } from './dedupe.js';
import { runExtractionAgent } from './agent.js';

interface LogBody {
  text?: unknown;
  captured_at?: unknown;
  timezone?: unknown;
  source?: unknown;
}

interface VoiceServerDeps {
  db: Db;
  voiceConfig: VoiceConfig;
  /** Override the dedupe instance (tests). */
  deduper?: Deduper;
  /**
   * Override the agent runner (tests). Same signature as runExtractionAgent.
   */
  runAgent?: typeof runExtractionAgent;
  /** Override the log-append sink (tests). */
  appendLog?: (line: string) => Promise<void>;
}

/**
 * Construct the Express app. Exported separately from `start()` so tests
 * can drive it with supertest without binding a port.
 */
export function buildVoiceApp(deps: VoiceServerDeps): express.Express {
  const { db, voiceConfig } = deps;
  const deduper = deps.deduper ?? new Deduper();
  const runAgent = deps.runAgent ?? runExtractionAgent;
  const appendLog =
    deps.appendLog ??
    (async (line: string) => {
      await mkdir(dirname(voiceConfig.logPath), { recursive: true });
      await appendFile(voiceConfig.logPath, line + '\n', 'utf8');
    });

  const app = express();
  // 16kb is plenty for voice transcripts; HealthKit batches can be much
  // larger (hundreds of samples per import). Use a single generous limit
  // for the whole app — JSON-only, so the upper bound is what matters.
  app.use(express.json({ limit: '2mb' }));

  // Bearer-token middleware — applied per route since we want /healthz to
  // remain auth-free for liveness checks (no body, just "is the server up").
  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('Authorization') ?? '';
    const expected = `Bearer ${voiceConfig.token}`;
    // Constant-time-ish compare via length + char check — not crypto-grade
    // but token rotation is the real defense here.
    if (header.length === expected.length && header === expected) {
      next();
      return;
    }
    res.status(401).json({ ok: false, error: 'unauthorized' });
  };

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'oura-ring-mcp voice server' });
  });

  app.post('/v1/log', requireAuth, async (req, res) => {
    const t0 = Date.now();
    const body = (req.body ?? {}) as LogBody;

    // ── Validate ─────────────────────────────────────────────────────
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const captured_at = typeof body.captured_at === 'string' ? body.captured_at : '';
    const timezone = typeof body.timezone === 'string' ? body.timezone : '';
    const source = typeof body.source === 'string' ? body.source : 'siri';

    if (text.length === 0) {
      res.status(400).json({ ok: false, error: 'text is required and must be non-empty' });
      return;
    }
    if (!captured_at || Number.isNaN(Date.parse(captured_at))) {
      res.status(400).json({ ok: false, error: 'captured_at is required and must be ISO 8601' });
      return;
    }
    if (!timezone) {
      // Allow missing tz but warn — server has no good fallback in a
      // travel scenario. UTC is rarely what the user wants.
      console.warn(
        '[voice] missing timezone in request body; falling back to server TZ. iOS Shortcut should send "timezone".',
      );
    }
    const userTimezone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    // ── Dedupe ───────────────────────────────────────────────────────
    const dedupe = deduper.check(text, captured_at);
    if (dedupe.duplicate) {
      res.json({
        ok: true,
        deduplicated: true,
        hash: dedupe.hash,
        message: 'duplicate request rejected within 60s window',
      });
      return;
    }

    // ── Start voice_log row ──────────────────────────────────────────
    const repo = new VoiceLogsRepo(db);
    const voice_log_id = repo.start({
      raw_text: text,
      source,
      captured_at,
      timezone: userTimezone,
    });

    // ── Run the extraction agent ─────────────────────────────────────
    try {
      const result = await runAgent(db, {
        text,
        captured_at,
        user_timezone: userTimezone,
        mcpEntryPath: voiceConfig.mcpEntryPath,
        ...(voiceConfig.model ? { model: voiceConfig.model } : {}),
      });

      if (!result.ok) {
        repo.finishError(voice_log_id, result.error ?? 'unknown agent error', Date.now() - t0);
        await appendLog(
          `${new Date().toISOString()}  voice_log=${voice_log_id}  ERROR  ${result.error ?? 'unknown'}`,
        );
        res.status(502).json({
          ok: false,
          voice_log_id,
          error: result.error ?? 'agent failed',
          annotations_logged: result.annotation_count,
        });
        return;
      }

      // Link any annotations created during the agent run back to this
      // voice_log. We use a time-window UPDATE rather than parsing every
      // tool result — sufficient because runs are sequential per voice_log
      // and the dedupe + per-call locking prevents overlap in normal use.
      const updated = db
        .prepare(
          `UPDATE annotations
              SET voice_log_id = ?
            WHERE voice_log_id IS NULL
              AND source = 'local'
              AND created_at >= ?
              AND created_at <= ?`,
        )
        .run(voice_log_id, result.started_at, result.finished_at);

      repo.finishOk(voice_log_id, result.annotation_count, result.summary, Date.now() - t0);

      const line = `${new Date().toISOString()}  voice_log=${voice_log_id}  ok  ${result.annotation_count} annotations  "${truncate(text, 80)}"`;
      await appendLog(line);

      res.json({
        ok: true,
        voice_log_id,
        annotations_logged: result.annotation_count,
        annotations_linked: Number(updated.changes),
        claude_summary: result.summary,
        duration_ms: Date.now() - t0,
      });
    } catch (err) {
      const msg = (err as Error).message;
      repo.finishError(voice_log_id, msg, Date.now() - t0);
      await appendLog(`${new Date().toISOString()}  voice_log=${voice_log_id}  EXCEPTION  ${msg}`);
      res.status(500).json({ ok: false, voice_log_id, error: msg });
    }
  });

  // ── Health debug endpoint (v0.7 inspector) ─────────────────────────
  // Throwaway probe used to capture raw payloads from the iOS "Find
  // Health Samples" Shortcut so we can design the real schema against
  // real data. Writes the body verbatim to a timestamped file under the
  // same dir as voice.log. Reuses the bearer token; no validation, no
  // schema. Delete this route once health_samples is wired up.
  app.post('/v1/health/debug', requireAuth, async (req, res) => {
    const body = req.body ?? null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `health-debug-${stamp}.json`;
    const filepath = join(dirname(voiceConfig.logPath), filename);

    try {
      await mkdir(dirname(filepath), { recursive: true });
      const payload = JSON.stringify(body, null, 2);
      await writeFile(filepath, payload, 'utf8');

      // Summarize what we got so the iPhone shows something useful in Quick Look.
      let topLevel: string;
      let count: number | null = null;
      if (Array.isArray(body)) {
        topLevel = 'array';
        count = body.length;
      } else if (body !== null && typeof body === 'object') {
        topLevel = 'object';
        count = Object.keys(body as Record<string, unknown>).length;
      } else {
        topLevel = typeof body;
      }

      res.json({
        ok: true,
        saved_to: filepath,
        bytes: Buffer.byteLength(payload, 'utf8'),
        top_level: topLevel,
        count,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  return app;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/**
 * Entry point used by `npm run voice-server`.
 */
async function main(): Promise<void> {
  // Force-load OURA_CLIENT_ID etc so the MCP child process inherits a usable
  // env (otherwise the MCP server will exit complaining about missing creds).
  const ouraConfig = loadConfig();
  const voiceConfig = loadVoiceConfig();
  const db = await openDatabase(ouraConfig.dbPath);

  const app = buildVoiceApp({ db, voiceConfig });

  // Bind to 0.0.0.0 so Tailscale (and any same-LAN device) can reach us.
  // The bearer token + Tailscale's identity-based VPN is the actual
  // security boundary here.
  app.listen(voiceConfig.port, '0.0.0.0', () => {
    process.stdout.write(
      `oura-ring-mcp voice server listening on http://0.0.0.0:${voiceConfig.port}\n` +
        `  log file:  ${voiceConfig.logPath}\n` +
        `  MCP entry: ${voiceConfig.mcpEntryPath}\n` +
        `  tail -f the log file in another tmux pane to watch activity.\n`,
    );
  });
}

// Only run main() when invoked directly (not when imported by tests).
// process.argv[1] is the entry script path; compare against this module's
// file path to detect direct invocation by either `tsx src/voice/server.ts`
// or `node dist/voice/server.js`.
const isEntry =
  typeof process.argv[1] === 'string' && process.argv[1] === fileURLToPath(import.meta.url);

if (isEntry) {
  main().catch((err) => {
    process.stderr.write(`voice-server: fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
