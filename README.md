# oura-ring-mcp

A small [Model Context Protocol](https://modelcontextprotocol.io) server that lets
[Claude Code](https://claude.com/claude-code) (and any MCP client) read your
[Oura Ring](https://ouraring.com) data through the official Oura API v2.

Read-only, OAuth2, runs locally over stdio. Personal project — but clean and easy to set up.

> **Sensitive data warning**: this tool reads personal health data. Tokens are stored
> locally with `0600` permissions and are never logged. Don't commit `.env` or your
> token file. Don't share them.

## Features

- OAuth2 authorization-code flow with automatic token refresh.
- Eight read-only MCP tools — five raw-data tools plus three derived-metric tools:
  - `oura_get_daily_summary` / `oura_get_sleep` / `oura_get_activity` / `oura_get_heartrate` / `oura_get_personal_info`
  - `oura_get_recent_summary` — last N days, no date math required
  - `oura_compare_periods` — averages + deltas between two periods (this week vs last, etc.)
  - `oura_get_trends` — rolling averages + linear trend direction
- Compact-by-default responses keep payloads small enough for LLMs to reason over.
- Automatic token refresh + 429 / Retry-After-aware rate-limit handling.
- Local token storage at `~/.config/oura-ring-mcp/tokens.json`.
- TypeScript, no exotic dependencies, MIT licensed.

## Quick start

You need [Node.js 20+](https://nodejs.org) and an Oura account.

```bash
git clone https://github.com/<you>/oura-ring-mcp.git
cd oura-ring-mcp
npm install
npm run build
```

### 1. Create an Oura OAuth application

1. Go to <https://cloud.ouraring.com/oauth/applications> and click **New application**.
2. Set **Redirect URI** to exactly:
   ```
   http://127.0.0.1:8765/callback
   ```
3. Save the application. Copy the **Client ID** and **Client Secret**.

### 2. Configure and authorize

```bash
npm run setup        # interactive: writes .env with your client id/secret
npm run oauth-login  # opens your browser, captures the callback, stores tokens
```

After `oauth-login` succeeds, your access and refresh tokens are saved to
`~/.config/oura-ring-mcp/tokens.json` (override with `OURA_TOKEN_PATH`).

### 3. Connect to Claude Code

Add the server to Claude Code:

```bash
claude mcp add oura node "$(pwd)/dist/index.js"
```

Or edit `~/.claude.json` manually:

```json
{
  "mcpServers": {
    "oura": {
      "command": "node",
      "args": ["/absolute/path/to/oura-ring-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Code, then run `/mcp` — you should see `oura` listed with all eight tools.
Try asking: _"Show my Oura daily summary for the last 7 days."_

## Tools

### Raw access

| Tool                     | Inputs                                      | Notes                                             |
| ------------------------ | ------------------------------------------- | ------------------------------------------------- |
| `oura_get_daily_summary` | `start_date`, `end_date`, `verbose?`        | Merges daily sleep, readiness, activity per date. |
| `oura_get_sleep`         | `start_date`, `end_date`, `verbose?`        | Detailed per-sleep-period records.                |
| `oura_get_activity`      | `start_date`, `end_date`, `verbose?`        | Daily activity rows.                              |
| `oura_get_heartrate`     | `start_datetime`, `end_datetime` (ISO 8601) | Time-series; prefer narrow windows.               |
| `oura_get_personal_info` | none                                        | Profile metadata.                                 |

### Derived metrics (v0.2)

| Tool                      | Inputs                                            | Notes                                             |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| `oura_get_recent_summary` | `days` (1–90)                                     | Convenience wrapper for "the last N days".        |
| `oura_compare_periods`    | `days` **or** `a_start`/`a_end`/`b_start`/`b_end` | Per-metric averages + deltas + direction.         |
| `oura_get_trends`         | `start_date`, `end_date`, `window?` (default 7)   | Rolling averages + linear trend (improving/etc.). |

### Notes

- All date-range tools cap requests at 90 days. Pagination follows up to 5 pages
  (Oura's `next_token`). The response includes `truncated: true` when there is more.
- **`verbose` defaults to `false`** — responses are compact projections (scores,
  key contributors, durations). Pass `verbose: true` when you actually need the
  raw nested API rows. Compact responses are typically 10–20× smaller and far
  easier for an LLM to reason over.
- Future-dated requests are rejected before any API call is made.

## Configuration

| Variable             | Default                               | Purpose                                                        |
| -------------------- | ------------------------------------- | -------------------------------------------------------------- |
| `OURA_CLIENT_ID`     | —                                     | Required. From your Oura OAuth app.                            |
| `OURA_CLIENT_SECRET` | —                                     | Required. From your Oura OAuth app.                            |
| `OURA_REDIRECT_URI`  | `http://127.0.0.1:8765/callback`      | Must match what you registered with Oura.                      |
| `OURA_TOKEN_PATH`    | `~/.config/oura-ring-mcp/tokens.json` | Token file location.                                           |
| `OURA_DEBUG`         | unset                                 | Set to `1` for verbose logs on stderr (still redacts secrets). |

`.env` in the project root is loaded automatically.

## Development

```bash
npm run dev         # tsx, no build step
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run format      # prettier --write .
```

Source layout:

```
src/
  config.ts         # env loading, paths, scopes
  index.ts          # binary entry
  mcp/
    server.ts       # MCP wiring
    tools.ts        # tool definitions
  oura/
    auth.ts         # OAuth helpers, token storage
    client.ts       # API client with auto-refresh + 429 retry
    endpoints.ts    # endpoint paths
    shape.ts        # raw API → compact projections
    derive.ts       # averages, deltas, rolling means, trend
scripts/
  oauth-login.ts    # interactive OAuth flow
  setup.ts          # writes .env interactively
```

## Troubleshooting

**`No saved tokens at …`** — run `npm run oauth-login` first.

**`Token request failed (HTTP 400) … invalid_client`** — the Client ID / Secret in
your `.env` doesn't match the Oura application. Double-check both values, then re-run
`npm run oauth-login`.

**`Address already in use :::8765`** — port 8765 is taken. Edit `OURA_REDIRECT_URI`
to use a free port (e.g. `:8780`), update the same value in your Oura application
settings, then re-run `npm run oauth-login`.

**The OAuth page redirects but the terminal doesn't continue** — your browser may
have followed an HTTPS upgrade. The redirect URI must use plain `http://` for
loopback addresses.

**Want to inspect what the server returns?** Run with `OURA_DEBUG=1` and watch
stderr; tokens are never logged.

## Security

- `.env` and `tokens.json` are git-ignored.
- Token files are written atomically with `0600` perms.
- Refresh tokens rotate; the client saves the new one immediately.
- Tools are strictly read-only in this version.
- The MCP server only exposes the eight tools above — no shell exec, no fs access.

## Roadmap

- ✅ **v0.1** — read-only OAuth2, five raw tools.
- ✅ **v0.2** — derived metrics, compact-by-default responses, 429 handling.
- **v0.3** — write tools (tags, manual annotations like illness, alcohol, travel).
- **v0.4** — local SQLite mirror so the LLM can reason over long histories without
  re-hitting the API.
- **v0.5** — exports and reports.

## License

[MIT](LICENSE).
