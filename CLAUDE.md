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
```

## Future Roadmap

Do not implement these unless asked, but design the code so they are possible later:

## v0.2

* Better summaries and derived metrics.
* Natural language helper tools, e.g. “compare last 7 days to previous 7 days”.
* Better error handling and API rate-limit handling.

## v0.3

* Read/write support for tags, if supported by the Oura API.
* Ability to add annotations such as illness, alcohol, travel, workout, stress, etc.

## v0.4

* Local SQLite database.
* Sync Oura data locally.
* Query historical data without repeatedly hitting the Oura API.
* Let the LLM analyze longer-term patterns.

## v0.5

* Visualizations or export tools.
* Weekly/monthly health reports.

## Development Process

Before making code changes, first create a plan.

The plan should include:

1. Proposed architecture.
2. Files to create or modify.
3. Exact MCP tools to implement.
4. OAuth flow approach.
5. Security considerations.
6. Testing strategy.
7. Any assumptions or open questions.

Do not start implementation until I approve the plan.

## Definition of Done for v0.1

The first version is done when:

1. The project installs with npm install.
2. The project builds with npm run build.
3. The MCP server can be started locally.
4. Claude Code can connect to it as an MCP server.
5. At least one Oura API query tool works end-to-end.
6. Tokens and secrets are not committed.
7. README explains setup clearly.
8. .env.example documents required variables.

## Prompt for Claude Code

```text
I want to build a personal Oura Ring MCP server for Claude Code.

Please read the repository context and the `CLAUDE.md` file carefully first.

Important: do not start coding immediately. First create a detailed implementation plan and wait for my approval.

The goal for v0.1 is a minimal read-only MCP server that lets Claude Code query my Oura Ring data through the official Oura API v2 using OAuth2.

Please plan the project with the following priorities:

1. TypeScript / Node.js implementation.
2. Use the official MCP TypeScript SDK where appropriate.
3. Implement OAuth2 authentication for Oura.
4. Store tokens locally but never commit them.
5. Add `.env.example` and `.gitignore`.
6. Implement a small number of read-only MCP tools first:
   - `oura_get_daily_summary`
   - `oura_get_sleep`
   - `oura_get_activity`
   - `oura_get_heartrate`
   - optionally `oura_get_personal_info`
7. Keep the code clean and GitHub-publishable.
8. Include a README with setup instructions for Claude Code.
9. Keep future extensions in mind, especially:
   - adding tags/activities later,
   - syncing data into a local SQLite database later,
   - allowing longer-term LLM analysis.

In your plan, please include:

- proposed architecture,
- file structure,
- exact packages to install,
- OAuth flow design,
- MCP server design,
- Oura API endpoints you intend to call,
- local token storage design,
- security considerations,
- testing strategy,
- expected commands for setup and running,
- how to connect the MCP server to Claude Code.

After presenting the plan, stop and ask me for approval before implementing.