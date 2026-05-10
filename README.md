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
- Fourteen MCP tools across four categories:
  - **Raw access**: `oura_get_daily_summary` / `oura_get_sleep` / `oura_get_activity` / `oura_get_heartrate` (per-hour summary by default) / `oura_get_personal_info`
  - **Derived metrics**: `oura_get_recent_summary` / `oura_compare_periods` / `oura_get_trends`
  - **Tags & annotations** (v0.3): `oura_get_enhanced_tags` (read Oura tags), plus local SQLite annotations (`oura_add_annotation` / `oura_list_annotations` / `oura_update_annotation` / `oura_delete_annotation`).
  - **Local mirror** (v0.4): `oura_sync` mirrors **15 collections** of Oura data into local SQLite so summary tools answer instantly without hitting the API. Includes heart-rate timeseries (v0.4.4).
- Local annotations mirror Oura's enhanced_tag schema, so the LLM can
  reason about both Oura-logged tags and your own context (illness, alcohol,
  travel, etc.) in one uniform shape.
- **Local-first reads** (v0.4): `oura_get_daily_summary` and `oura_get_recent_summary` use the local SQLite mirror by default. Stable past days come instantly from cache; today/yesterday and missing days fall back to the API.
- **Self-correcting tag-code list**: every sync of `enhanced_tag` records the codes Oura actually returns; the annotation validator accepts both the static seed list and your discovered codes.
- Compact-by-default responses keep payloads small enough for LLMs to reason over.
- Automatic token refresh + 429 / Retry-After-aware rate-limit handling.
- Local data at `~/.config/oura-ring-mcp/` (tokens + SQLite, both `0600`).
- TypeScript, MIT licensed.

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

Restart Claude Code, then run `/mcp` — you should see `oura` listed with all fourteen tools (`oura_get_daily_summary`, `oura_get_sleep`, …, `oura_sync`).
Try asking: _"Show my Oura daily summary for the last 7 days."_

> **Upgrading scopes**: re-run `npm run oauth-login` once after upgrading
> from any earlier version. v0.3 added the `tag` scope (for enhanced_tag);
> v0.4.3 adds `stress` (for daily_resilience) and `heart_health` (for
> daily_cardiovascular_age, vO2_max, and the future heartrate sync). If you
> see a `Token is not authorized access … scope` error from `npm run sync`,
> that's the symptom — `npm run oauth-login` is the fix.

### Optional: prime the local cache

```bash
npm run sync
```

This is optional but recommended. It pulls your last ~30 days of Oura data
into the local SQLite mirror so every subsequent summary / trend query
answers instantly from cache. Future runs are incremental — see
`npm run sync -- --help` for flags. You can also trigger this from inside
Claude Code with the `oura_sync` tool.

## Tools

### Raw access

| Tool                     | Inputs                                                  | Notes                                                                               |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `oura_get_daily_summary` | `start_date`, `end_date`, `verbose?`                    | Merges daily sleep, readiness, activity per date.                                   |
| `oura_get_sleep`         | `start_date`, `end_date`, `verbose?`                    | Detailed per-sleep-period records.                                                  |
| `oura_get_activity`      | `start_date`, `end_date`, `verbose?`                    | Daily activity rows.                                                                |
| `oura_get_heartrate`     | `start_datetime`, `end_datetime`, `verbose?`, `prefer?` | Per-hour summary by source by default; `verbose:true` for raw samples. Local-first. |
| `oura_get_personal_info` | none                                                    | Profile metadata.                                                                   |

### Derived metrics (v0.2)

| Tool                      | Inputs                                            | Notes                                             |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| `oura_get_recent_summary` | `days` (1–90), `prefer?`                          | Convenience wrapper for "the last N days".        |
| `oura_compare_periods`    | `days` **or** `a_start`/`a_end`/`b_start`/`b_end` | Per-metric averages + deltas + direction.         |
| `oura_get_trends`         | `start_date`, `end_date`, `window?` (default 7)   | Rolling averages + linear trend (improving/etc.). |

### Tags & annotations (v0.3)

| Tool                     | Inputs                                                  | Notes                                                                  |
| ------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `oura_get_enhanced_tags` | `start_date`, `end_date`, `verbose?`                    | Read tags you logged in the Oura app. Compact projection by default.   |
| `oura_add_annotation`    | tag fields (see below)                                  | Store a local annotation in SQLite. Mirrors Oura's enhanced_tag shape. |
| `oura_list_annotations`  | `start_date?`, `end_date?`, `tag_type_code?`, `source?` | List local annotations (and any synced Oura tags).                     |
| `oura_update_annotation` | `id`, partial tag fields                                | Patch an annotation; re-validated on every change.                     |
| `oura_delete_annotation` | `id`                                                    | Delete by id.                                                          |

The `oura_get_daily_summary` and `oura_get_recent_summary` tools default to
`include_annotations: true` — each day record is joined with any matching
local annotations so the LLM can correlate context with metrics in one call.
Pass `include_annotations: false` to skip the join.

### Local mirror (v0.4)

| Tool        | Inputs                                                          | Notes                                                                                                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oura_sync` | `since_days?` (1–730), `full?`, `tags_only?`, `with_heartrate?` | Pull recent Oura data into local SQLite. Mirrors **15 collections** (sleep, readiness, activity, spo2, stress, resilience, cardiovascular_age, vo2_max, sleep_time, sleep_periods, workouts, sessions, rest_mode_periods, enhanced_tags, heartrate). Default: incremental + 7-day re-fetch overlap. Chunked > 90-day spans. |

For a one-time historical backfill (e.g. you've had the ring for 6 months
and want everything local), pass a larger `since_days` and the sync will
split it into ≤90-day API requests transparently:

```bash
npm run sync -- --since 240   # ~8 months
```

The cap is 730 days (≈2 years). Future incremental runs fall back to the
default 7-day overlap on top of what's already mirrored.

#### Querying mirrored data directly

Most consumers should use the MCP tools, but if you want to pull data
straight from the SQLite file (e.g. for ad-hoc analysis in a notebook),
the schema is documented in `src/db/schema.ts` and uses a hybrid shape:

- Each daily/event table has indexed key columns (`day` / `oura_id`,
  `score`, `last_synced_at`, `first_seen_at`) plus a raw `data` JSON
  column holding the entire Oura payload verbatim.
- For tables without a single numeric score (`daily_stress`,
  `daily_resilience`, `sleep_time`), `score` is NULL — the relevant
  fields live inside `data`. Use SQLite's `json_extract` or the
  `DailyCollectionRepo.extractField()` / `extractFieldRange()` helpers:

```ts
import { openDatabase } from 'oura-ring-mcp/db';
import { DailyCollectionRepo } from 'oura-ring-mcp/db/repos/daily';

const db = await openDatabase('~/.config/oura-ring-mcp/data.sqlite');
const resilience = new DailyCollectionRepo(db, 'daily_resilience');

// Single day:
resilience.extractField<string>('2026-05-09', '$.level');
// → 'good'

// Range:
resilience.extractFieldRange<string>('2026-05-01', '2026-05-09', '$.level');
// → [{ day: '2026-05-01', value: 'great' }, { day: '2026-05-02', value: 'good' }, …]
```

The same helpers work for any nested JSON path — e.g. `daily_stress` →
`'$.recovery_high'`, or contributors with `'$.contributors.sleep_balance'`.

`oura_get_daily_summary` and `oura_get_recent_summary` gained a new `prefer`
parameter:

- `auto` (default) — read from local SQLite when available; fall back to
  the API for missing days and for today/yesterday (still being re-scored
  by Oura). API results are upserted into local for next time.
- `local` — offline mode; missing days return empty.
- `api` — force-refetch from Oura on every call (still upserts local).

Each response carries a `source: 'local' | 'api' | 'mixed'` field for
traceability.

The same code path is also exposed as `npm run sync` for cron-style
backfilling. Heart-rate timeseries are intentionally **not** mirrored —
their volume is too high; use the `oura_get_heartrate` tool for ad-hoc
windows.

#### Annotation schema

Annotations are stored locally in SQLite at `~/.config/oura-ring-mcp/data.sqlite`
and use the **same column names as Oura's `EnhancedTagModel`** so the two
sources are interchangeable:

| Field           | Type    | Notes                                                                             |
| --------------- | ------- | --------------------------------------------------------------------------------- |
| `tag_type_code` | string? | Canonical Oura type (e.g. `alcohol`, `sick`, `traveled`), or `custom`, or `null`. |
| `custom_name`   | string? | Required iff `tag_type_code = 'custom'`.                                          |
| `start_time`    | string  | ISO 8601 datetime.                                                                |
| `end_time`      | string? | ISO 8601 datetime; optional, for events with duration.                            |
| `start_day`     | string  | YYYY-MM-DD.                                                                       |
| `end_day`       | string? | YYYY-MM-DD; optional, for multi-day events like travel.                           |
| `comment`       | string? | Free-form text. Required when `tag_type_code = null` (text-only annotation).      |
| `source`        | string  | `'local'` for entries you add; `'oura'` for synced Oura tags (v0.4+).             |
| `oura_id`       | string? | The Oura tag's id when `source='oura'`.                                           |

The canonical `tag_type_code` list lives in `src/db/tag_types.ts`. As of v0.3.1
it follows the two-prefix scheme observed in real Oura API responses:

- `tag_sleep_*` for events framed as sleep impact (alcohol, late_meal, sauna,
  stress, sleep environment items, …).
- `tag_generic_*` for everything else (drinks, activities, social events,
  illness, mood, medical, reproductive, …).

The seed list in v0.3.1 is ~170 entries derived from the Oura mobile app's
predefined types. Codes marked `// ✓` were observed in real API data; the
rest are inferred from naming patterns and will be auto-corrected in v0.4
when we sync your actual tag history. Anything not in the list uses
`tag_type_code='custom'` with a `custom_name`.

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
| `OURA_DB_PATH`       | `~/.config/oura-ring-mcp/data.sqlite` | Local SQLite database (annotations + Oura mirror).             |
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
    tags.ts         # enhanced_tag shape helper (v0.3)
  db/                       # local SQLite layer (v0.3+)
    index.ts        # open + bootstrap with migrations
    schema.ts       # versioned DDL
    annotations.ts  # typed CRUD repo (mirrors EnhancedTagModel)
    tag_types.ts    # canonical tag_type_code shortlist
    sync.ts         # v0.4 sync orchestrator
    repos/
      daily.ts                  # daily_sleep / daily_readiness / daily_activity / daily_spo2
      events.ts                 # sleep_periods / workouts / sessions
      discovered_tag_types.ts   # observed Oura tag_type_codes (self-correcting)
      sync_runs.ts              # sync audit log
scripts/
  oauth-login.ts    # interactive OAuth flow
  setup.ts          # writes .env interactively
  sync.ts           # CLI: pull Oura data into the local mirror
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

- `.env`, `tokens.json`, and `data.sqlite*` are git-ignored.
- Token and DB files are written with `0600` perms; the parent dir with `0700`.
- All SQL uses prepared statements with parameter binding — never string interpolation.
- Refresh tokens rotate; the client saves the new one immediately.
- Tools are **read-only against the Oura API**. v0.3 annotation tools write
  only to the local SQLite database — never to any external service.
- The MCP server only exposes the documented tools — no shell exec, no
  arbitrary fs access.

## Roadmap

- ✅ **v0.1** — read-only OAuth2, five raw tools.
- ✅ **v0.2** — derived metrics, compact-by-default responses, 429 handling.
- ✅ **v0.3** — local SQLite annotations (mirroring `EnhancedTagModel`),
  read-only Oura enhanced_tag tool, automatic annotation join in summary tools.
- ✅ **v0.4** — local sync of Oura data into SQLite (idempotent on
  `(collection, day)` with `last_synced_at`), local-first reads in summary
  tools, self-correcting `tag_type_code` list via `discovered_tag_types`.
- ✅ **v0.4.1** — chunked historical backfill up to 730 days; transparent
  90-day-window pagination.
- ✅ **v0.4.2** — covers the remaining daily collections (`daily_stress`,
  `daily_resilience`, `daily_cardiovascular_age`, `vo2_max`, `sleep_time`)
  and `rest_mode_periods`. Adds `extractField` / `extractFieldRange`
  helpers for JSON-stored fields (resilience level, stress sub-scores).
- ✅ **v0.4.3** — adds `stress` and `heart_health` OAuth scopes (unblocks
  `daily_resilience`, `daily_cardiovascular_age`, `vO2_max`); the API
  client surfaces a clear "re-run `oauth-login`" hint on scope-related 401s.
- ✅ **v0.4.4** — heart-rate timeseries mirror (default-on, opt-out via
  `--no-heartrate`). `oura_get_heartrate` is now local-first and
  compact-by-default (per-hour-by-source summary; `verbose:true` for
  raw samples). 15 collections total.
- ✅ **v0.4.5** — heartrate sync chunked at 30 days (Oura's per-request
  cap on this endpoint, distinct from the 90-day cap on daily collections).
  `oura_get_heartrate` input range capped at 30 days to match.
- **v0.5** — exports, weekly/monthly reports, optional
  `interbeat_interval` mirror, per-source-period heartrate aggregation.

## License

[MIT](LICENSE).
