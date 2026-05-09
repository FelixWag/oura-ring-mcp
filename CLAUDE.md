# Oura MCP Project

## Goal

A small personal Model Context Protocol server that lets Claude Code (and any
MCP client) read Oura Ring data through the official Oura API v2 — and store
the user's own contextual annotations in a local SQLite database for richer
LLM analysis.

This is a personal project, but kept clean enough to publish on GitHub.

## Current State (May 2026)

- **v0.1** — shipped. Read-only OAuth2 client, five core MCP tools.
- **v0.2** — shipped. Compact-by-default responses, derived metrics
  (`oura_get_recent_summary`, `oura_compare_periods`, `oura_get_trends`),
  429 / Retry-After handling.
- **v0.3** — in progress. Local SQLite annotations + Oura `enhanced_tag` reads.
- **v0.4 onward** — see Roadmap below.

See `DECISIONS.md` for a chronological log of architectural decisions and
the reasoning behind each one. New decisions belong there too.

## Hard Constraints

### The Oura API is read-only

Confirmed against the official OpenAPI spec
(`https://cloud.ouraring.com/v2/static/json/openapi-1.29.json`):
**every user-data endpoint supports `GET` only.** The only write endpoints in
the entire API are webhook-subscription management. There is no public way to
create, update, or delete tags, workouts, sessions, or any other piece of user
data via the API.

This means: any "write tags from Claude" feature lives in our **local SQLite
database**, not in Oura's servers. Our local annotation schema is designed to
mirror Oura's `EnhancedTagModel` 1:1 so the two data sources can be queried
uniformly.

### Local annotations mirror Oura's enhanced_tag schema

Our `annotations` table columns map directly to Oura's `EnhancedTagModel`
(`tag_type_code`, `start_time`, `end_time`, `start_day`, `end_day`, `comment`,
`custom_name`) plus two extras (`source`, `oura_id`) so v0.4 can sync Oura
enhanced_tags into the same table without losing track of provenance. See
`DECISIONS.md` for the rationale.

### Tag types are constrained, with `custom` as the escape hatch

Following Oura's own design: `tag_type_code` must be `null`, `'custom'`, or
one of a known shortlist of canonical codes. `'custom'` requires a
`custom_name`. The shortlist is seeded with common codes for v0.3; v0.4 will
add a sync that pulls the user's actual tag history to expand the list
dynamically.

### Score values can change after the day ends

Oura re-scores days as more data arrives (a nap added later in the day will
update that day's sleep score). Any future local sync (v0.4+) must be
**idempotent on `(metric, day)` with a `last_synced_at` timestamp**, so we can
re-fetch and overwrite same-day records correctly.

## Tech Stack

- **TypeScript / Node.js** (engines.node >= 22 from v0.3 onward).
- **MCP SDK**: `@modelcontextprotocol/sdk` (official).
- **OAuth2**: Authorization Code flow, no PKCE (Oura is a confidential client).
- **HTTP**: native `fetch` (Node 20+).
- **Validation**: zod.
- **Local DB (v0.3+)**: `better-sqlite3` (synchronous, mature, well-typed).
- **Tests**: vitest.
- **Format**: prettier.
- **Transport**: stdio only (default for Claude Code).

## OAuth Scopes

Currently requested: `daily heartrate workout session spo2 personal`.

If/when we add `oura_get_enhanced_tags` (v0.3), we will need the `tag` scope as
well. Re-running `npm run oauth-login` re-authorizes with the updated scope set.

## Project Structure

```text
oura-ring-mcp/
  src/
    index.ts              # binary entry
    config.ts             # env loading, paths
    mcp/
      server.ts
      tools.ts
    oura/
      auth.ts             # OAuth2 + token storage
      client.ts           # API client with auto-refresh + 429 retry
      endpoints.ts
      shape.ts            # raw → compact projections
      derive.ts           # averages, deltas, rolling means, trend
      tags.ts             # (v0.3) shape helpers for enhanced_tag
    db/                   # (v0.3+)
      index.ts            # open + bootstrap
      schema.ts           # DDL + migrations
      annotations.ts      # typed CRUD repo
      tag_types.ts        # canonical tag_type_code shortlist
  scripts/
    oauth-login.ts
    setup.ts
  .env.example
  PRIVACY.md
  TERMS.md
  README.md
  CLAUDE.md               # this file
  DECISIONS.md            # chronological architectural log
```

## Authentication & Token Storage

- Credentials read from env: `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`,
  `OURA_REDIRECT_URI`. `.env` loaded automatically.
- `npm run oauth-login` runs the full Authorization Code flow, captures the
  callback on a local loopback HTTP server (default
  `http://localhost:8765/callback`), and stores tokens to
  `~/.config/oura-ring-mcp/tokens.json` with `0600` perms.
- Listener binds to whatever hostname the redirect URI specifies (so
  `localhost` works on IPv6-default systems).
- Tokens refresh automatically on 401 and proactively when within 60 s of
  expiry. Refresh-token rotation is honored (new refresh token persisted).

## Security Requirements

- Never commit `.env`, token files, or local database files (all in `.gitignore`).
- All file writes that touch credentials or DB use `0600` perms (parent dir 0700).
- All SQL via prepared statements with parameter binding — never string interpolation.
- All HTTP requests over HTTPS; loopback HTTP only for the OAuth redirect listener.
- Logging: errors only by default; tokens, codes, and full API bodies redacted.
  `OURA_DEBUG=1` enables verbose stderr logs that still redact secrets.
- Tools are **read-only against the Oura API** at every version. Local DB
  writes (v0.3+) only touch `~/.config/oura-ring-mcp/data.sqlite`.
- All tool inputs validated with zod; future-dated date ranges rejected upfront.
- No shell exec, no arbitrary file-system access exposed via MCP tools.

## Roadmap

- ✅ **v0.1** — read-only OAuth2 + five raw tools.
- ✅ **v0.2** — derived metrics, compact-by-default, rate-limit handling.
- 🚧 **v0.3** — local SQLite annotations (mirroring `EnhancedTagModel`),
  read-only Oura enhanced_tag tool, `include_annotations` join into summary tools.
- **v0.4** — full local sync of Oura data into the same SQLite database
  (idempotent on `(metric, day)` with `last_synced_at`), enabling long-range
  analysis without re-hitting the API. Adds a "refresh tag_type_codes from
  your data" capability.
- **v0.5** — exports, weekly/monthly reports, possibly visualizations.

## Development Process

Before making code changes, first create a plan in chat. The plan must include:

1. Proposed architecture.
2. Files to create or modify.
3. Exact MCP tools to implement.
4. OAuth flow / scope changes (if any).
5. Security considerations.
6. Testing strategy.
7. Any assumptions or open questions.

**Do not start implementation until I approve the plan.**

When a plan is approved and implemented, append a one-paragraph entry to
`DECISIONS.md` summarizing what was decided and why.

## Workflow

- **Branch per change**: never commit directly to `main`. Create
  `feat/<name>` or `fix/<name>` branches.
- **PR per change**: push the branch, open a PR via the GitHub URL, merge
  through the GitHub UI.
- **CI gate**: every PR runs typecheck, tests, build, and `format:check`
  on Node 20/22/24 (matrix may evolve as we drop older versions).
- **After merge**: switch back to `main`, `git pull`, delete the local
  branch, run `npm run build` so Claude Code spawns the new binary.
