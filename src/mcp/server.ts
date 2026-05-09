import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AnnotationRepo } from '../db/annotations.js';
import type { DailyCollectionRepo } from '../db/repos/daily.js';
import type { SyncOptions, SyncResult } from '../db/sync.js';
import type { OuraClient } from '../oura/client.js';
import { registerTools } from './tools.js';

export interface CreateServerOptions {
  client: OuraClient;
  annotations?: AnnotationRepo;
  daily?: {
    sleep: DailyCollectionRepo;
    readiness: DailyCollectionRepo;
    activity: DailyCollectionRepo;
  };
  sync?: (options: SyncOptions) => Promise<SyncResult>;
}

export function createServer(opts: CreateServerOptions): McpServer {
  const server = new McpServer({
    name: 'oura-ring-mcp',
    version: '0.4.2',
  });
  registerTools(server, opts);
  return server;
}

export async function runStdioServer(opts: CreateServerOptions): Promise<void> {
  const server = createServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
