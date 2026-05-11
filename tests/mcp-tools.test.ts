import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { AnnotationRepo } from '../src/db/annotations.js';
import { openDatabase } from '../src/db/index.js';
import { DailyCollectionRepo } from '../src/db/repos/daily.js';
import { HeartrateRepo } from '../src/db/repos/heartrate.js';
import { registerTools } from '../src/mcp/tools.js';

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { type: 'text'; text: string }[];
}>;

function fakeServer(): {
  server: McpServer;
  handlers: Map<string, ToolHandler>;
} {
  const handlers = new Map<string, ToolHandler>();
  return {
    server: {
      registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      },
    } as unknown as McpServer,
    handlers,
  };
}

function parseResult(result: Awaited<ReturnType<ToolHandler>>): unknown {
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]!.text) as unknown;
}

function upsertDailyRange(
  repos: {
    sleep: DailyCollectionRepo;
    readiness: DailyCollectionRepo;
    activity: DailyCollectionRepo;
  },
  days: string[],
): void {
  for (const [i, day] of days.entries()) {
    repos.sleep.upsert({ day, score: 80 + i });
    repos.readiness.upsert({ day, score: 70 + i, temperature_deviation: 0 });
    repos.activity.upsert({ day, score: 60 + i, steps: 10_000 + i });
  }
}

describe('MCP tools', () => {
  it('joins multi-day annotations onto every overlapping summary day', async () => {
    const db = await openDatabase(':memory:');
    const annotations = new AnnotationRepo(db);
    const daily = {
      sleep: new DailyCollectionRepo(db, 'daily_sleep'),
      readiness: new DailyCollectionRepo(db, 'daily_readiness'),
      activity: new DailyCollectionRepo(db, 'daily_activity'),
    };
    upsertDailyRange(daily, ['2020-05-02', '2020-05-03', '2020-05-04']);
    annotations.add({
      tag_type_code: 'tag_generic_sick',
      start_time: '2020-05-01T09:00:00Z',
      end_time: '2020-05-03T18:00:00Z',
      start_day: '2020-05-01',
      end_day: '2020-05-03',
      comment: 'cold',
    });

    const { server, handlers } = fakeServer();
    const client = {
      getCollection: vi.fn(async () => {
        throw new Error('summary should be served from local data');
      }),
    };
    registerTools(server, { client: client as never, annotations, daily });

    const result = await handlers.get('oura_get_daily_summary')!({
      start_date: '2020-05-02',
      end_date: '2020-05-04',
    });
    const body = parseResult(result) as {
      days: { day: string; annotations: { comment: string }[] }[];
    };

    expect(body.days.map((d) => [d.day, d.annotations.map((a) => a.comment)])).toEqual([
      ['2020-05-02', ['cold']],
      ['2020-05-03', ['cold']],
      ['2020-05-04', []],
    ]);
  });

  it('compare periods uses local-first daily repos instead of forcing API calls', async () => {
    const db = await openDatabase(':memory:');
    const daily = {
      sleep: new DailyCollectionRepo(db, 'daily_sleep'),
      readiness: new DailyCollectionRepo(db, 'daily_readiness'),
      activity: new DailyCollectionRepo(db, 'daily_activity'),
    };
    upsertDailyRange(daily, [
      '2020-05-01',
      '2020-05-02',
      '2020-05-03',
      '2020-05-04',
      '2020-05-05',
      '2020-05-06',
    ]);

    const { server, handlers } = fakeServer();
    const client = {
      getCollection: vi.fn(async () => {
        throw new Error('compare should be served from local data');
      }),
    };
    registerTools(server, { client: client as never, daily });

    const result = await handlers.get('oura_compare_periods')!({
      a_start: '2020-05-04',
      a_end: '2020-05-06',
      b_start: '2020-05-01',
      b_end: '2020-05-03',
    });
    const body = parseResult(result) as {
      period_a: { count: number };
      period_b: { count: number };
    };

    expect(client.getCollection).not.toHaveBeenCalled();
    expect(body.period_a.count).toBe(3);
    expect(body.period_b.count).toBe(3);
  });

  it('heartrate auto mode falls back to API when local data does not cover the requested start', async () => {
    const db = await openDatabase(':memory:');
    const heartrate = new HeartrateRepo(db);
    heartrate.upsert({ timestamp: '2020-05-10T12:00:00+00:00', source: 'awake', bpm: 72 });

    const { server, handlers } = fakeServer();
    const client = {
      getCollection: vi.fn(async () => ({
        data: [{ timestamp: '2020-05-01T12:30:00+00:00', source: 'awake', bpm: 68 }],
        truncated: false,
      })),
    };
    registerTools(server, { client: client as never, heartrate });

    const result = await handlers.get('oura_get_heartrate')!({
      start_datetime: '2020-05-01T12:00:00Z',
      end_datetime: '2020-05-01T13:00:00Z',
    });
    const body = parseResult(result) as { source: string; count: number };

    expect(client.getCollection).toHaveBeenCalledTimes(1);
    expect(body.source).toBe('api');
    expect(body.count).toBe(1);
  });
});
