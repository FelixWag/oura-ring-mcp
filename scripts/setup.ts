#!/usr/bin/env tsx
import { existsSync } from 'node:fs';
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { join } from 'node:path';

const ROOT = process.cwd();
const ENV_PATH = join(ROOT, '.env');
const ENV_EXAMPLE_PATH = join(ROOT, '.env.example');

async function prompt(
  rl: ReturnType<typeof createInterface>,
  q: string,
  fallback?: string,
): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : '';
  const ans = (await rl.question(`${q}${suffix}: `)).trim();
  return ans || fallback || '';
}

async function main(): Promise<void> {
  console.log('\noura-ring-mcp setup\n');

  if (!existsSync(ENV_EXAMPLE_PATH)) {
    console.error('  .env.example is missing — are you in the project root?');
    process.exit(1);
  }

  if (!existsSync(ENV_PATH)) {
    await copyFile(ENV_EXAMPLE_PATH, ENV_PATH);
    console.log('  Created .env from .env.example.\n');
  }

  const current = await readFile(ENV_PATH, 'utf8');
  const env = parseEnv(current);

  console.log('Step 1. Register an OAuth application at:');
  console.log('    https://cloud.ouraring.com/oauth/applications');
  console.log('');
  console.log('  - Set the redirect URI to exactly:');
  console.log(`    ${env.OURA_REDIRECT_URI || 'http://127.0.0.1:8765/callback'}`);
  console.log('  - Copy the Client ID and Client Secret it gives you.\n');

  const rl = createInterface({ input, output });
  try {
    const clientId = await prompt(rl, 'Oura Client ID', env.OURA_CLIENT_ID);
    const clientSecret = await prompt(rl, 'Oura Client Secret', env.OURA_CLIENT_SECRET);
    const redirectUri = await prompt(
      rl,
      'Redirect URI',
      env.OURA_REDIRECT_URI || 'http://127.0.0.1:8765/callback',
    );

    if (!clientId || !clientSecret) {
      console.error('\n  Client ID and Client Secret are required.');
      process.exit(1);
    }

    env.OURA_CLIENT_ID = clientId;
    env.OURA_CLIENT_SECRET = clientSecret;
    env.OURA_REDIRECT_URI = redirectUri;
    await writeFile(ENV_PATH, serializeEnv(env), { mode: 0o600 });
    await chmod(ENV_PATH, 0o600).catch(() => {});
    console.log(`\n  Wrote ${ENV_PATH}`);
  } finally {
    rl.close();
  }

  console.log('\nStep 2. Run `npm run oauth-login` to authorize the app and store tokens.\n');
}

function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1]) out[m[1]] = (m[2] ?? '').replace(/^"|"$/g, '');
  }
  return out;
}

function serializeEnv(env: Record<string, string>): string {
  const order = [
    'OURA_CLIENT_ID',
    'OURA_CLIENT_SECRET',
    'OURA_REDIRECT_URI',
    'OURA_TOKEN_PATH',
    'OURA_DEBUG',
  ];
  const lines: string[] = [];
  for (const k of order) {
    if (env[k] !== undefined) lines.push(`${k}=${env[k]}`);
  }
  for (const [k, v] of Object.entries(env)) {
    if (!order.includes(k)) lines.push(`${k}=${v}`);
  }
  return lines.join('\n') + '\n';
}

main().catch((err) => {
  console.error(`\n  Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
