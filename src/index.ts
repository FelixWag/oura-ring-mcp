#!/usr/bin/env node
import { ConfigError, loadConfig } from './config.js';
import { AnnotationRepo } from './db/annotations.js';
import { openDatabase } from './db/index.js';
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

  const db = await openDatabase(config.dbPath);
  const annotations = new AnnotationRepo(db);

  // Close the DB on shutdown so WAL files flush cleanly. MCP stdio servers
  // typically exit via parent kill, but SIGINT/SIGTERM handlers cost nothing.
  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // Best-effort.
    }
  };
  process.on('SIGINT', () => {
    closeDb();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    closeDb();
    process.exit(0);
  });

  await runStdioServer({ client, annotations });
}

main().catch((err) => {
  process.stderr.write(`oura-ring-mcp: fatal error: ${(err as Error).message}\n`);
  process.exit(1);
});
