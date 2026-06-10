import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { openDatabase, type Db } from '../src/db/index.js';
import { buildHealthApp, normalizePayload, validateAndCoerce } from '../src/health/server.ts';
import { HealthSamplesRepo } from '../src/db/repos/health_samples.ts';

const TOKEN = 'test-health-token-xyz';

let db: Db;
let appendedLines: string[];

beforeEach(async () => {
  db = await openDatabase(':memory:');
  appendedLines = [];
});

function buildApp() {
  return buildHealthApp({
    db,
    healthConfig: {
      token: TOKEN,
      port: 0,
      logPath: '/tmp/never-written-health.log',
    },
    appendLog: async (line: string) => {
      appendedLines.push(line);
    },
  });
}

// A canonical sample matching what the iOS Shortcut actually sends.
function sample(overrides: Record<string, unknown> = {}) {
  return {
    sample_type: 'dietary_energy_consumed',
    value: '447.0515',
    unit: 'kcal',
    start_date: '2026-06-08T13:23:59+01:00',
    end_date: '2026-06-08T13:23:59+01:00',
    source_name: 'SnapCalorie',
    // Server uses start_time/end_time; iOS sends start_date/end_date. We accept
    // either at the normalizePayload boundary by also setting these:
    start_time: '2026-06-08T13:23:59+01:00',
    end_time: '2026-06-08T13:23:59+01:00',
    ...overrides,
  };
}

describe('POST /v1/health/import — auth', () => {
  it('rejects missing Authorization with 401', async () => {
    const res = await request(buildApp()).post('/v1/health/import').send([sample()]);
    expect(res.status).toBe(401);
  });

  it('rejects wrong token with 401', async () => {
    const res = await request(buildApp())
      .post('/v1/health/import')
      .set('Authorization', 'Bearer nope')
      .send([sample()]);
    expect(res.status).toBe(401);
  });

  it('accepts correct token with 200', async () => {
    const res = await request(buildApp())
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send([sample()]);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.inserted).toBe(1);
  });
});

describe('POST /v1/health/import — body shapes', () => {
  it('accepts a proper JSON array of samples', async () => {
    const res = await request(buildApp())
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send([sample(), sample({ start_time: '2026-06-08T14:00:00+01:00', value: '500' })]);
    expect(res.status).toBe(200);
    expect(res.body.total_received).toBe(2);
    expect(res.body.inserted).toBe(2);
  });

  it('accepts {samples: [...]} object-wrapped array', async () => {
    const res = await request(buildApp())
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ samples: [sample()] });
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
  });

  it('accepts {samples: ["<NDJSON string>"]} — iOS Dictionary+Array quirk', async () => {
    const a = sample();
    const b = sample({ start_time: '2026-06-08T14:00:00+01:00', value: '500' });
    const ndjson = JSON.stringify(a) + '\n' + JSON.stringify(b);
    const res = await request(buildApp())
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ samples: [ndjson] }); // ← array wrapping one NDJSON string
    expect(res.status).toBe(200);
    expect(res.body.total_received).toBe(2);
    expect(res.body.inserted).toBe(2);
  });

  it('accepts {samples: "<NDJSON string>"} from the legacy iOS pattern', async () => {
    const a = sample();
    const b = sample({ start_time: '2026-06-08T14:00:00+01:00', value: '500' });
    const ndjson = JSON.stringify(a) + '\n' + JSON.stringify(b);
    const res = await request(buildApp())
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ samples: ndjson });
    expect(res.status).toBe(200);
    expect(res.body.total_received).toBe(2);
    expect(res.body.inserted).toBe(2);
  });

  it('accepts a single sample dict (wraps in a list of one)', async () => {
    const res = await request(buildApp())
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(sample());
    expect(res.status).toBe(200);
    expect(res.body.total_received).toBe(1);
    expect(res.body.inserted).toBe(1);
  });

  it('rejects garbage with 400', async () => {
    const res = await request(buildApp())
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send('hello' as unknown as object);
    expect(res.status).toBe(400);
  });

  it('rejects empty array with 400', async () => {
    const res = await request(buildApp())
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send([]);
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/health/import — validation + coercion', () => {
  it('coerces string values to numbers (iOS sends "447.0515")', async () => {
    await request(buildApp())
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send([sample()]);
    const repo = new HealthSamplesRepo(db);
    const rows = repo.recentByType('dietary_energy_consumed', 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBeCloseTo(447.0515, 4);
    expect(typeof rows[0]!.value).toBe('number');
  });

  it('rejects samples missing required fields with details', async () => {
    const bad = sample({ sample_type: '' });
    const res = await request(buildApp())
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send([bad]);
    expect(res.status).toBe(400);
    expect(res.body.details[0].error).toMatch(/sample_type/);
  });

  it('rejects non-numeric values', async () => {
    const bad = sample({ value: 'not a number' });
    const res = await request(buildApp())
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send([bad]);
    expect(res.status).toBe(400);
    expect(res.body.details[0].error).toMatch(/value/);
  });

  it('rejects malformed start_time', async () => {
    const bad = sample({ start_time: 'not-a-date' });
    const res = await request(buildApp())
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send([bad]);
    expect(res.status).toBe(400);
  });

  it('defaults end_time to start_time when missing', () => {
    const result = validateAndCoerce([
      sample({ end_time: undefined as unknown as string }) as never,
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.samples[0]!.end_time).toBe(result.samples[0]!.start_time);
  });

  it('allows source_name to be missing → stored as NULL', async () => {
    const noSource = sample({ source_name: undefined });
    await request(buildApp())
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send([noSource]);
    const repo = new HealthSamplesRepo(db);
    const rows = repo.recentByType('dietary_energy_consumed', 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_name).toBeNull();
  });
});

describe('POST /v1/health/import — dedup', () => {
  it('re-importing the same batch is idempotent', async () => {
    const app = buildApp();
    const batch = [sample(), sample({ start_time: '2026-06-08T14:00:00+01:00', value: '500' })];

    const first = await request(app)
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(batch);
    expect(first.body.inserted).toBe(2);
    expect(first.body.deduped).toBe(0);

    const second = await request(app)
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(batch);
    expect(second.body.inserted).toBe(0);
    expect(second.body.deduped).toBe(2);

    const repo = new HealthSamplesRepo(db);
    expect(repo.countAll()).toBe(2);
  });

  it('different sources at the same instant do NOT dedup', async () => {
    const app = buildApp();
    const a = sample({ source_name: 'SnapCalorie' });
    const b = sample({ source_name: 'Cronometer' }); // same time, same value, different source
    await request(app)
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send([a, b]);
    const repo = new HealthSamplesRepo(db);
    expect(repo.countAll()).toBe(2);
  });
});

describe('POST /v1/health/import — log sink', () => {
  it('appends a one-line summary per successful import', async () => {
    await request(buildApp())
      .post('/v1/health/import')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send([sample()]);
    expect(appendedLines).toHaveLength(1);
    expect(appendedLines[0]).toMatch(/\/v1\/health\/import\s+ok\s+received=1\s+inserted=1/);
  });
});

describe('GET /healthz', () => {
  it('returns ok without auth', async () => {
    const res = await request(buildApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('normalizePayload — unit', () => {
  it('passes through arrays', () => {
    const arr = [sample()] as never;
    expect(normalizePayload(arr)).toHaveLength(1);
  });

  it('unwraps {samples: [...]}', () => {
    const obj = { samples: [sample(), sample()] } as never;
    expect(normalizePayload(obj)).toHaveLength(2);
  });

  it('parses NDJSON-as-string', () => {
    const s = `${JSON.stringify(sample())}\n${JSON.stringify(sample())}\n`;
    const obj = { samples: s } as never;
    expect(normalizePayload(obj)).toHaveLength(2);
  });

  it('wraps single sample dict', () => {
    expect(normalizePayload(sample() as never)).toHaveLength(1);
  });

  it('throws on garbage', () => {
    expect(() => normalizePayload('hi' as never)).toThrow();
    expect(() => normalizePayload(null as never)).toThrow();
    expect(() => normalizePayload({ samples: 42 } as never)).toThrow();
  });

  it('reports the NDJSON line number on parse failure', () => {
    const s = `${JSON.stringify(sample())}\n{not valid json\n${JSON.stringify(sample())}`;
    expect(() => normalizePayload({ samples: s } as never)).toThrow(/line 2/);
  });
});
