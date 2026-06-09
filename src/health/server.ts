/**
 * HTTP server for Apple Health (HealthKit) sample ingestion.
 *
 * Single endpoint: POST /v1/health/import
 *   Auth:  Authorization: Bearer <HEALTH_IMPORT_TOKEN>
 *   Body:  flexible — see normalizePayload() for accepted shapes
 *   Flow:  validate → coerce → batch insert (INSERT OR IGNORE) → respond
 *
 * The endpoint deliberately accepts multiple body shapes because iOS
 * Shortcuts serializes lists-of-dictionaries inconsistently across
 * versions. Forgiving on input, strict in storage.
 *
 * Designed to live on a Mac mini reachable over Tailscale, alongside
 * the v0.6 voice server but on its own port and with its own bearer
 * token so they can be rotated independently.
 */

import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import { loadConfig, loadHealthConfig, type HealthConfig } from '../config.js';
import { openDatabase, type Db } from '../db/index.js';
import { HealthSamplesRepo, type HealthSample } from '../db/repos/health_samples.js';

interface HealthServerDeps {
  db: Db;
  healthConfig: HealthConfig;
  /** Override the log-append sink (tests). */
  appendLog?: (line: string) => Promise<void>;
}

export function buildHealthApp(deps: HealthServerDeps): express.Express {
  const { db, healthConfig } = deps;
  const appendLog =
    deps.appendLog ??
    (async (line: string) => {
      await mkdir(dirname(healthConfig.logPath), { recursive: true });
      await appendFile(healthConfig.logPath, line + '\n', 'utf8');
    });

  const app = express();
  // HealthKit batches can be hundreds of samples per import. 2mb is
  // plenty for years of nutrition + steps data per request.
  app.use(express.json({ limit: '2mb' }));

  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('Authorization') ?? '';
    const expected = `Bearer ${healthConfig.token}`;
    if (header.length === expected.length && header === expected) {
      next();
      return;
    }
    res.status(401).json({ ok: false, error: 'unauthorized' });
  };

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'oura-ring-mcp health server' });
  });

  app.post('/v1/health/import', requireAuth, async (req, res) => {
    const t0 = Date.now();
    let samples: HealthSample[];
    try {
      samples = normalizePayload(req.body);
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
      return;
    }

    if (samples.length === 0) {
      res.status(400).json({ ok: false, error: 'no samples in payload' });
      return;
    }

    const validation = validateAndCoerce(samples);
    if (validation.errors.length > 0) {
      res.status(400).json({
        ok: false,
        error: 'one or more samples failed validation',
        details: validation.errors.slice(0, 10), // cap to avoid huge responses
        rejected: validation.errors.length,
        accepted: validation.samples.length,
      });
      return;
    }

    const repo = new HealthSamplesRepo(db);
    const result = repo.insertBatch(validation.samples);
    const duration_ms = Date.now() - t0;

    await appendLog(
      `${new Date().toISOString()}  /v1/health/import  ok  received=${result.total_received}  ` +
        `inserted=${result.inserted}  deduped=${result.deduped}  ${duration_ms}ms`,
    );

    res.json({
      ok: true,
      total_received: result.total_received,
      inserted: result.inserted,
      deduped: result.deduped,
      duration_ms,
    });
  });

  return app;
}

/**
 * Accept four shapes the iOS Shortcut might send and produce a flat array
 * of sample envelopes. Each is intentionally lenient — strict typing happens
 * downstream in validateAndCoerce.
 *
 *   1. proper JSON array of dicts: [ {…}, {…} ]
 *   2. object wrapping an array:   { "samples": [ {…}, {…} ] }
 *   3. object wrapping NDJSON:     { "samples": "<json>\n<json>\n…" }
 *   4. single sample dict:         { … }
 */
export function normalizePayload(body: unknown): HealthSample[] {
  if (Array.isArray(body)) {
    return body as HealthSample[];
  }
  if (body !== null && typeof body === 'object') {
    const rec = body as Record<string, unknown>;
    if ('samples' in rec) {
      const s = rec['samples'];
      if (Array.isArray(s)) return s as HealthSample[];
      if (typeof s === 'string') return parseNdjson(s);
      throw new Error('`samples` must be an array or a newline-delimited JSON string');
    }
    // Looks like a single sample envelope — wrap it.
    return [body as HealthSample];
  }
  throw new Error('request body must be a JSON array, object, or NDJSON-wrapping object');
}

function parseNdjson(s: string): HealthSample[] {
  const out: HealthSample[] = [];
  const lines = s.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed) as HealthSample);
    } catch {
      throw new Error(`NDJSON parse error at line ${i + 1}: not valid JSON`);
    }
  }
  return out;
}

interface ValidatedBatch {
  samples: HealthSample[];
  errors: Array<{ index: number; error: string }>;
}

/**
 * Per-sample sanity check. iOS may send `value` as a string ("447.0515")
 * rather than a number — coerce it. Anything outright missing or unparseable
 * gets reported back so the user knows which row(s) the Shortcut botched.
 */
export function validateAndCoerce(input: HealthSample[]): ValidatedBatch {
  const samples: HealthSample[] = [];
  const errors: Array<{ index: number; error: string }> = [];

  input.forEach((raw, index) => {
    const sample_type = typeof raw.sample_type === 'string' ? raw.sample_type.trim() : '';
    if (!sample_type) {
      errors.push({ index, error: 'sample_type is required and must be a non-empty string' });
      return;
    }

    const start_time = typeof raw.start_time === 'string' ? raw.start_time : '';
    if (!start_time || Number.isNaN(Date.parse(start_time))) {
      errors.push({ index, error: 'start_time is required and must be an ISO 8601 date' });
      return;
    }
    const end_time =
      typeof raw.end_time === 'string' && raw.end_time.length > 0 ? raw.end_time : start_time;
    if (Number.isNaN(Date.parse(end_time))) {
      errors.push({ index, error: 'end_time must be an ISO 8601 date when provided' });
      return;
    }

    // iOS sometimes sends value as a string. Accept both.
    const valueNum = typeof raw.value === 'number' ? raw.value : Number(raw.value);
    if (!Number.isFinite(valueNum)) {
      errors.push({
        index,
        error: 'value must be a finite number (got ' + String(raw.value) + ')',
      });
      return;
    }

    const unit = typeof raw.unit === 'string' ? raw.unit.trim() : '';
    if (!unit) {
      errors.push({ index, error: 'unit is required and must be a non-empty string' });
      return;
    }

    const source_name =
      typeof raw.source_name === 'string' && raw.source_name.length > 0 ? raw.source_name : null;

    samples.push({
      sample_type,
      start_time,
      end_time,
      value: valueNum,
      unit,
      source_name,
      raw: JSON.stringify(raw),
    });
  });

  return { samples, errors };
}

/**
 * Entry point used by `npm run health-server`.
 */
async function main(): Promise<void> {
  // loadConfig() force-validates Oura credentials so the operator notices
  // a broken .env early. We never use the return value here, but the side
  // effects (clear error messages on misconfig) are worth it.
  loadConfig();
  const healthConfig = loadHealthConfig();

  // Reuse the same DB as the MCP / voice server — one source of truth.
  const ouraConfig = (await import('../config.js')).loadConfig();
  const db = await openDatabase(ouraConfig.dbPath);

  const app = buildHealthApp({ db, healthConfig });

  app.listen(healthConfig.port, '0.0.0.0', () => {
    process.stdout.write(
      `oura-ring-mcp health server listening on http://0.0.0.0:${healthConfig.port}\n` +
        `  log file:  ${healthConfig.logPath}\n` +
        `  endpoint:  POST /v1/health/import  (Authorization: Bearer <HEALTH_IMPORT_TOKEN>)\n`,
    );
  });
}

const isEntry =
  typeof process.argv[1] === 'string' && process.argv[1] === fileURLToPath(import.meta.url);

if (isEntry) {
  main().catch((err) => {
    process.stderr.write(`health-server: fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
