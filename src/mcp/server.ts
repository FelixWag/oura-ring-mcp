import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { OuraClient } from '../oura/client.js';
import { registerTools } from './tools.js';

export function createServer(client: OuraClient): McpServer {
  const server = new McpServer({
    name: 'oura-ring-mcp',
    version: '0.2.0',
  });
  registerTools(server, client);
  return server;
}

export async function runStdioServer(client: OuraClient): Promise<void> {
  const server = createServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
