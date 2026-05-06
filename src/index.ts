#!/usr/bin/env node
import { ConfigError, loadConfig } from './config.js';
import { runStdioServer } from './mcp/server.js';
import { OuraClient } from './oura/client.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`oura-ring-mcp: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const client = new OuraClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tokenPath: config.tokenPath,
    debug: config.debug,
  });

  await runStdioServer(client);
}

main().catch((err) => {
  process.stderr.write(`oura-ring-mcp: fatal error: ${(err as Error).message}\n`);
  process.exit(1);
});
