# Oura MCP Project

## Goal

Build a small personal Model Context Protocol server that allows Claude Code to query my Oura Ring data through the official Oura API.

This is a personal fun project, but it should be clean enough to publish on GitHub.

The first version should be intentionally minimal: read-only access to Oura data. Later versions may add tag/activity creation and a local database for longer-term analysis.

## Current Scope: v0.1

Implement a basic MCP server that can:

1. Authenticate with the Oura API using OAuth2.
2. Store and refresh tokens locally.
3. Expose simple read-only MCP tools for querying Oura data.
4. Return clean JSON summaries that are easy for an LLM to inspect.

The Oura API uses OAuth2. Do not assume that personal access tokens are available. Use the official Oura API v2 and OAuth2 flow.

Relevant Oura scopes may include:

- `daily`
- `heartrate`
- `workout`
- `session`
- `spo2`
- `tag`
- `personal`

For v0.1, request the smallest useful set of scopes, probably `daily heartrate workout session spo2 personal`. Only include `tag` if needed for reading tags.

## Preferred Tech Stack

Use TypeScript / Node.js unless there is a strong reason not to.

Use the official MCP TypeScript SDK where possible.

The MCP server should run locally and be connectable from Claude Code.

## Expected Tools

Implement a small set of MCP tools first:

### `oura_get_daily_summary`

Fetch daily Oura summaries for a given date range.

Inputs:

- `start_date`: string, format `YYYY-MM-DD`
- `end_date`: string, format `YYYY-MM-DD`

Should return sleep, readiness, and activity summaries if available.

### `oura_get_sleep`

Fetch sleep-related data for a given date range.

Inputs:

- `start_date`
- `end_date`

### `oura_get_activity`

Fetch daily activity data for a given date range.

Inputs:

- `start_date`
- `end_date`

### `oura_get_heartrate`

Fetch heart-rate time series for a given date range or datetime range.

Inputs:

- `start_datetime`
- `end_datetime`

### `oura_get_personal_info`

Fetch basic personal metadata from Oura, if the required scope is available.

## Authentication Requirements

Implement OAuth2 carefully.

The server should support:

1. Reading credentials from environment variables:
   - `OURA_CLIENT_ID`
   - `OURA_CLIENT_SECRET`
   - `OURA_REDIRECT_URI`

2. A local OAuth setup command or helper script that:
   - opens or prints the Oura authorization URL,
   - receives or accepts the callback code,
   - exchanges the code for access and refresh tokens,
   - stores tokens locally.

3. Token storage:
   - store tokens outside the Git repository by default,
   - never commit tokens,
   - add token files to `.gitignore`,
   - document the expected token path clearly.

4. Refresh handling:
   - refresh the access token automatically when needed,
   - persist the new refresh token if Oura rotates refresh tokens.

## Security Requirements

This project handles sensitive health data.

Important rules:

- Never commit `.env`, tokens, or local database files.
- Keep OAuth client secrets out of source control.
- Add `.env.example`.
- Add clear warnings in the README.
- Avoid logging access tokens, refresh tokens, authorization codes, or full API responses unless explicitly in debug mode.
- Keep the MCP tools read-only in v0.1.
- Validate all tool inputs.
- Do not expose arbitrary shell execution or file-system access.

## Project Structure Suggestion

Use a clean structure similar to:

```text
oura-mcp/
  src/
    index.ts
    mcp/
      server.ts
      tools.ts
    oura/
      client.ts
      auth.ts
      endpoints.ts
    config.ts
  scripts/
    oauth-login.ts
  .env.example
  .gitignore
  package.json
  tsconfig.json
  README.md
  CLAUDE.md