import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ConfigError, defaultTokenPath, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const original = { ...process.env };
  beforeEach(() => {
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;
    delete process.env.OURA_REDIRECT_URI;
    delete process.env.OURA_TOKEN_PATH;
    delete process.env.OURA_DEBUG;
  });
  afterEach(() => {
    Object.assign(process.env, original);
  });

  it('throws ConfigError when client id/secret missing', () => {
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it('returns config with defaults when env is set', () => {
    process.env.OURA_CLIENT_ID = 'cid';
    process.env.OURA_CLIENT_SECRET = 'csec';
    const c = loadConfig();
    expect(c.clientId).toBe('cid');
    expect(c.clientSecret).toBe('csec');
    expect(c.redirectUri).toBe('http://127.0.0.1:8765/callback');
    expect(c.debug).toBe(false);
    expect(c.tokenPath.length).toBeGreaterThan(0);
  });

  it('honors OURA_DEBUG=1', () => {
    process.env.OURA_CLIENT_ID = 'cid';
    process.env.OURA_CLIENT_SECRET = 'csec';
    process.env.OURA_DEBUG = '1';
    expect(loadConfig().debug).toBe(true);
  });
});

describe('defaultTokenPath', () => {
  it('contains the project name', () => {
    expect(defaultTokenPath()).toContain('oura-ring-mcp');
    expect(defaultTokenPath().endsWith('tokens.json')).toBe(true);
  });
});
