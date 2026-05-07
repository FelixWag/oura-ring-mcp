#!/usr/bin/env tsx
import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { ConfigError, loadConfig } from '../src/config.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  generateState,
  saveTokens,
} from '../src/oura/auth.js';

function openInBrowser(url: string): void {
  const cmd =
    platform() === 'darwin'
      ? `open "${url}"`
      : platform() === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      // Fall back to printing — the user can open it manually.
    }
  });
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n  ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const redirectUrl = new URL(config.redirectUri);
  if (redirectUrl.hostname !== '127.0.0.1' && redirectUrl.hostname !== 'localhost') {
    console.error(
      `\n  OURA_REDIRECT_URI must point to a local loopback address (127.0.0.1 or localhost).\n` +
        `  Current value: ${config.redirectUri}\n`,
    );
    process.exit(1);
  }
  const port = Number(redirectUrl.port || (redirectUrl.protocol === 'https:' ? 443 : 80));
  const callbackPath = redirectUrl.pathname || '/callback';

  const state = generateState();
  const authUrl = buildAuthorizeUrl({
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    state,
  });

  console.log('\nOpening Oura authorization page in your browser...');
  console.log('If it does not open automatically, paste this URL:\n');
  console.log(`  ${authUrl}\n`);

  const codePromise = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        if (!req.url) return;
        const u = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
        if (u.pathname !== callbackPath) {
          res.writeHead(404).end('Not found.');
          return;
        }
        const error = u.searchParams.get('error');
        if (error) {
          res
            .writeHead(400, { 'Content-Type': 'text/html' })
            .end(`<h1>Authorization failed</h1><p>${error}</p>`);
          server.close();
          reject(new Error(`Oura returned error: ${error}`));
          return;
        }
        const returnedState = u.searchParams.get('state');
        const code = u.searchParams.get('code');
        if (!code) {
          res.writeHead(400).end('Missing code.');
          return;
        }
        if (returnedState !== state) {
          res.writeHead(400).end('State mismatch — possible CSRF.');
          server.close();
          reject(new Error('OAuth state mismatch.'));
          return;
        }
        res
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end('<h1>Success!</h1><p>You can close this tab and return to the terminal.</p>');
        server.close();
        resolve(code);
      } catch (err) {
        reject(err as Error);
      }
    });
    server.on('error', reject);
    // Bind to whatever the redirect URI says. If "localhost", let Node resolve
    // it (handles IPv6-default systems where ::1 resolves first); otherwise
    // bind to the literal IP. Hardcoding 127.0.0.1 here would break setups
    // where `localhost` resolves to ::1.
    const listenHost = redirectUrl.hostname === 'localhost' ? 'localhost' : redirectUrl.hostname;
    server.listen(port, listenHost, () => {
      // Wait briefly so the listener is ready before we open the browser.
      setTimeout(() => openInBrowser(authUrl), 250);
    });
  });

  let code: string;
  try {
    code = await codePromise;
  } catch (err) {
    console.error(`\n  OAuth flow failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  console.log('\nExchanging authorization code for tokens...');
  const tokens = await exchangeCodeForTokens({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    code,
    redirectUri: config.redirectUri,
  });
  await saveTokens(config.tokenPath, tokens);

  console.log(`\n  Tokens saved to: ${config.tokenPath}`);
  console.log(`  Scopes granted:  ${tokens.scope || '(none reported)'}`);
  console.log(`  Expires in:      ${Math.round((tokens.expires_at - Date.now()) / 1000)}s`);
  console.log('\nDone. You can now run the MCP server with `npm start`.\n');
}

main().catch((err) => {
  console.error(`\n  Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
