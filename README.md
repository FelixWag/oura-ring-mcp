# oura-ring-mcp

> **Talk to your Oura Ring data through Claude.** Local SQLite mirror, 14 MCP tools, OAuth2, ~5-minute setup.

[![CI](https://github.com/FelixWag/oura-ring-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/FelixWag/oura-ring-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue.svg)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/tests-103%20passing-brightgreen.svg)](https://github.com/FelixWag/oura-ring-mcp/actions)
[![Node](https://img.shields.io/badge/Node-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)

![demo](docs/demo.gif)

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets
[Claude Code](https://claude.com/claude-code) (and any MCP client) read and reason
over your [Oura Ring](https://ouraring.com) data — sleep, readiness, activity,
heart rate, stress, resilience, tags, and more — through one fast local SQLite
mirror.

**Ask Claude things like:**

- _"Did my readiness drop after the alcohol days last week?"_
- _"Compare my sleep this week to last week and tell me what changed."_
- _"What was my heart rate during yesterday's workout?"_
- _"Show me my resilience trend over the past month."_
- _"My energy has been low lately — anything in the data that explains it?"_

Everything answers locally from your synced mirror — no rate limits, no
re-fetching, no privacy concerns. Multi-month analysis is one prompt away.

> **Sensitive data warning**: this tool reads personal health data. Tokens and
> data are stored locally at `~/.config/oura-ring-mcp/` with `0600` permissions
> and are never logged or transmitted anywhere except `api.ouraring.com`. Don't
> commit `.env` or your token / database files.

## Features

- 🩺 **14 MCP tools** spanning raw Oura access, derived metrics (rolling
  averages, period comparisons, trends), tags + local annotations, and a
  local-mirror sync.
- 💾 **Local SQLite mirror** of 15 Oura collections (sleep, readiness, activity,
  spo2, stress, resilience, cardiovascular age, vO2 max, sleep time, sleep
  periods, workouts, sessions, rest mode periods, enhanced tags, heartrate).
  Up to 730 days of historical backfill, chunked transparently.
- ⚡ **Local-first by default** — summary tools serve instantly from cache,
  fall back to the API only for today / yesterday / missing days.
- 🏷️ **Tags + annotations** — read Oura's tags, log your own (illness,
  alcohol, travel, etc.) in a schema that mirrors Oura's `EnhancedTagModel`
  so both data sources query uniformly.
- 🔐 **OAuth2 with auto-refresh**, 429 / Retry-After handling, scope-aware
  401 hints. Tokens stored with `0600` perms.
- 🧪 **Tested** — 103 unit + integration tests on Node 20 / 22 / 24.
- 📜 **TypeScript**, MIT licensed.

## Quick start (~5 minutes)

You need [Node.js 20+](https://nodejs.org) and an Oura account.

### 1. Register an Oura OAuth app

Go to <https://cloud.ouraring.com/oauth/applications> → **New application**.

- **Redirect URI** (exactly): `http://127.0.0.1:8765/callback`
- **Privacy Policy URL**: `https://github.com/FelixWag/oura-ring-mcp/blob/main/PRIVACY.md`
- **Terms of Service URL**: `https://github.com/FelixWag/oura-ring-mcp/blob/main/TERMS.md`

Save. Copy the **Client ID** and **Client Secret** — you'll paste them in step 3.

### 2. Clone, install, build

```bash
git clone https://github.com/FelixWag/oura-ring-mcp.git
cd oura-ring-mcp
npm install
npm run build
```

### 3. Configure, authorize, sync — one command

```bash
npm run init
```

This chains three steps:

1. **`setup`** — interactively writes `.env` (asks for client id/secret).
2. **`oauth-login`** — opens your browser to authorize, then stores the
   refresh token at `~/.config/oura-ring-mcp/tokens.json`.
3. **`sync`** — pulls your last ~30 days of Oura data into a local SQLite
   mirror at `~/.config/oura-ring-mcp/data.sqlite`.

Want a longer history backfill? After `init`, run e.g.
`npm run sync -- --since 240` to pull 8 months. Up to 730 days supported.

### 4. Connect to Claude Code

```bash
claude mcp add oura node "$(pwd)/dist/index.js"
```

Or paste this into `~/.claude.json` manually:

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

Restart Claude Code, run `/mcp` — `oura` should be listed with all 14 tools.
Now ask: _"Show me my last 7 days of Oura data."_

> **Upgrading scopes**: re-run `npm run oauth-login` once after upgrading
> from any earlier version. v0.3 added the `tag` scope (for enhanced_tag);
> v0.4.3 adds `stress` (for daily_resilience) and `heart_health` (for
> daily_cardiovascular_age, vO2_max, and the future heartrate sync). If you
> see a `Token is not authorized access … scope` error from `npm run sync`,
> that's the symptom — `npm run oauth-login` is the fix.

### Optional: prime the local cache

```bash
npm run sync                  # pulls last ~30 days
npm run sync -- --since 240   # backfill 8 months of history
```

`npm run init` runs this automatically. Future runs are incremental + a
7-day re-fetch overlap (handles Oura's same-day re-scoring). Up to 730
days; chunked transparently. See `npm run sync -- --help`. You can also
trigger from inside Claude Code with the `oura_sync` tool.

## What you can ask Claude

A starter prompt gallery. Copy-paste any of these into Claude Code after
connecting the server.

### Sleep & recovery

- _"Show me my last 14 days of summaries with annotations."_
- _"Which night this month had the worst sleep, and why? Look at the contributors."_
- _"How long did it take me to recover (resting HR back to baseline) after my last alcohol day?"_
- _"Walk me through last night's sleep — when did I fall asleep, REM cycles, anything unusual?"_

### Trends & comparisons

- _"Compare my sleep this week to the previous week. What changed?"_
- _"Show me my readiness rolling average over the last 60 days. Improving or declining?"_
- _"Compare weekday vs weekend sleep over the past month."_
- _"What's my resilience level distribution since I got the ring?"_

### Workouts & activity

- _"What was my heart rate during yesterday's workout? Hour-by-hour."_
- _"Compare my workout days to my rest days — sleep score, recovery, RHR."_
- _"Find days where I had >10,000 steps and tell me how I slept those nights."_
- _"What's my VO2 Max trajectory?"_

### Logging context

- _"I had 4 beers Thursday from 6pm to midnight. Log it."_
- _"I was sick from Monday to Wednesday — log a cold annotation across those days."_
- _"List all my alcohol annotations from the past 3 months and group them by day of the week."_

### Causal-ish reasoning (the killer feature)

- _"Did my readiness drop after the alcohol days?"_
- _"Is there a relationship between my caffeine days and my deep sleep?"_
- _"My energy has been low lately — anything in the data that explains it?"_
- _"On which annotated context days do I sleep worst?"_

### Refresh / housekeeping

- _"Sync the latest Oura data."_ (calls `oura_sync`)
- _"Pull just the tags from the last week."_
- _"Show me what new Oura tag types you've discovered."_

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
