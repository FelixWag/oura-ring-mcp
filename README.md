# oura-ring-mcp

> Natural-language access to your Oura data through Claude. Local SQLite mirror, natural-language annotations, and MCP tools for actually asking questions about your health data.

[![CI](https://github.com/FelixWag/oura-ring-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/FelixWag/oura-ring-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue.svg)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen.svg)](https://github.com/FelixWag/oura-ring-mcp/actions)
[![Node](https://img.shields.io/badge/Node-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)

![Demo: logging beers and asking Claude about next-day readiness recovery](docs/demo.gif)

Oura already tracks sleep, readiness, activity, heart rate, stress, and tags.

But the interesting questions are usually more personal:

- "Does alcohol actually affect my readiness?"
- "Do late coffees hurt my deep sleep?"
- "Why has my energy been low lately?"
- "How long do I take to recover after travel or hard workouts?"
- "What changed on the nights where I slept really well?"

`oura-ring-mcp` lets Claude analyze your Oura data locally through MCP, with your own annotations and context stored in SQLite.

You can log things naturally:

- "I had 2 beers Thursday from 7pm to midnight. Log it."
- "I was sick from Monday to Wednesday."
- "Late coffee today at 4pm."

And then actually ask questions about the patterns behind your health data.

Everything is local-first. After sync, most queries run against your local SQLite mirror instead of repeatedly hitting the Oura API.

> Sensitive data warning: this project works with personal health data. Tokens and synced data are stored locally at `~/.config/oura-ring-mcp/` with `0600` permissions and are never sent anywhere by this software except to `api.ouraring.com` for Oura API requests. Your MCP client may see whatever data you ask it to analyze.

---

## Why I Built This

I wanted something more useful than another dashboard.

The raw metrics from Oura are already good. The missing piece is context:
coffee, alcohol, illness, travel, late meals, stressful weeks, bad sleep hygiene, or whatever else was actually happening in life.

This project gives an LLM memory for the things Oura does not capture. The result feels much closer to talking to a health journal than scrolling through charts.

---

## What It Does

- Syncs your Oura data into a local SQLite database.
- Exposes your data through MCP tools for Claude Code and other MCP clients.
- Lets you store natural-language annotations locally.
- Makes it easy to analyze trends, recovery, sleep, stress, workouts, and habits over time.
- Keeps everything local-first and your MCP client may see whatever data you ask it to analyze..

Currently supports:

- sleep
- readiness
- activity
- heart rate
- stress
- resilience
- SpO2
- VO2 max
- cardiovascular age
- sleep periods
- workouts
- sessions
- rest mode periods
- enhanced tags
- local annotations

---

## Example Prompts

### Sleep and recovery

- "Show me my last 14 days of sleep, readiness, and activity."
- "Which night this month had the worst sleep, and what changed?"
- "How long did it take my resting heart rate to recover after my last alcohol day?"
- "Walk me through last night's sleep periods and heart-rate pattern."

### Trends and comparisons

- "Compare this week's sleep to the previous week."
- "Show my readiness rolling average over the last 60 days."
- "Compare weekdays vs weekends for sleep score and bedtime."
- "What is my VO2 max trajectory?"

### Logging context

- "I had 2 beers Thursday from 7pm to midnight. Log it."
- "I was sick from Monday to Wednesday. Log a cold annotation."
- "I had a late coffee today at 4pm. Log it."
- "List all my alcohol annotations from the last 3 months."

### The fun part

- "Across my alcohol annotations, what usually happens to next-day readiness?"
- "Is there a relationship between caffeine days and deep sleep?"
- "Do hard workout days change my sleep or recovery?"
- "My energy has been low lately. What patterns should I look at?"

---

## Quick Start

You need Node.js 20+ and an Oura account.

### 1. Register an Oura OAuth App

Go to <https://cloud.ouraring.com/oauth/applications> and create a new app.

- Redirect URI: `http://127.0.0.1:8765/callback`
- Privacy Policy URL: `https://github.com/FelixWag/oura-ring-mcp/blob/main/PRIVACY.md`
- Terms of Service URL: `https://github.com/FelixWag/oura-ring-mcp/blob/main/TERMS.md`

Copy the Client ID and Client Secret.

### 2. Clone, Install, Build

```bash
git clone https://github.com/FelixWag/oura-ring-mcp.git
cd oura-ring-mcp
npm install
npm run build
```

### 3. Configure, Authorize, Sync

```bash
npm run init
```

That one command:

1. writes your local `.env`,
2. opens the Oura OAuth login,
3. stores tokens locally,
4. syncs your recent Oura history into SQLite.

Want more history?

```bash
npm run sync -- --since 240
```

---

## Connect Claude Code

```bash
claude mcp add oura node "$(pwd)/dist/index.js"
```

Restart Claude Code, run `/mcp`, and check that `oura` is listed.

Then try:

```text
Show me my last 7 days of Oura summaries with annotations.
```

---

## Voice Logging via Siri (v0.6)

Talk to Siri, describe your day, and have a headless Claude agent extract
structured annotations into your local SQLite database.

```text
👤 "Hey Siri, log my day."
👤 "Two coffees this morning, cycled 11k, felt tired in the afternoon."
📱 Banner: "Logged 3: tag_generic_coffee, tag_generic_workout, tag_generic_tired"
```

How it works:

1. iOS Shortcut dictates text and POSTs it (with `captured_at` + `timezone`)
   to a tiny Express server running on a Mac mini.
2. The server spawns a headless Claude Agent (using your Claude Code
   subscription credentials from `~/.claude/`) with a tool allowlist that
   permits only `oura_add_annotation` and read-only `oura_get_*` tools.
3. The agent extracts one tool call per distinct event and writes them into
   the same local SQLite as your manual annotations, linked back to a
   `voice_logs` row for provenance.

Run it:

```bash
echo "VOICE_LOG_TOKEN=$(openssl rand -hex 32)" >> .env
npm run build
npm run voice-server
```

The server binds to `0.0.0.0:8770`. Bearer token + Tailscale is the
security boundary — **do not expose this port to the public internet.**

Full setup (iOS Shortcut steps, Tailscale, troubleshooting):
[`docs/siri-shortcut.md`](docs/siri-shortcut.md).

---

## Apple Health Import (v0.7)

Bring HealthKit data — nutrition (calories, protein, carbs), steps,
weight, anything iOS apps write to Apple Health — into the same local
SQLite. Useful because Oura's API doesn't expose meals or glucose;
Apple Health does, and many apps (Cronometer, SnapCalorie, MyFitnessPal,
Apple Watch) already write to it.

How it works:

1. A second Express server runs on `:8771` next to the voice server.
2. An iOS Shortcut (Personal Automation, scheduled daily) reads recent
   HealthKit samples and POSTs them to `/v1/health/import`.
3. Samples land in a generic `health_samples` table — same shape for
   every type, discriminated by a `sample_type` column.

Run it:

```bash
echo "HEALTH_IMPORT_TOKEN=$(openssl rand -hex 32)" >> .env
npm run build
npm run health-server
```

Voice and health are **separate processes on separate ports with
separate tokens** — restart or rotate either independently. Bearer token

- Tailscale is the security boundary.

Full setup (iOS Shortcut steps, sample types, troubleshooting):
[`docs/apple-health.md`](docs/apple-health.md).

---

## Why Local-First Matters

This project stores your synced data and annotations locally in SQLite instead of forwarding everything through another cloud service.

After sync, most reads happen locally:

- faster queries,
- less API usage,
- offline-friendly access,
- easier experimentation,
- and more privacy.

The Oura API is read-only for user data. Local annotations intentionally stay local.

---

## Development

```bash
npm run dev
npm test
npm run typecheck
npm run build
```

The stack is intentionally simple:

- TypeScript
- Node.js
- SQLite
- MCP SDK
- zod
- Vitest

---

## Security

- Tokens and SQLite files use `0600` permissions.
- `.env` and local databases are ignored by git.
- SQL uses prepared statements.
- No shell execution or arbitrary filesystem access.
- The Oura API remains read-only.
- This is not medical advice or a medical device.

---

### Raw Access

| Tool                     | Inputs                                                  | Notes                                                                          |
| ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `oura_get_daily_summary` | `start_date`, `end_date`, `verbose?`, `prefer?`         | Merges daily sleep, readiness, and activity. Includes annotations by default.  |
| `oura_get_sleep`         | `start_date`, `end_date`, `verbose?`                    | Detailed sleep-period records.                                                 |
| `oura_get_activity`      | `start_date`, `end_date`, `verbose?`                    | Daily activity rows.                                                           |
| `oura_get_heartrate`     | `start_datetime`, `end_datetime`, `verbose?`, `prefer?` | Local-first heart-rate query. Compact mode returns hourly summaries by source. |
| `oura_get_personal_info` | none                                                    | Basic profile metadata exposed by the Oura API.                                |

### Derived Metrics

| Tool                      | Inputs                              | Notes                                     |
| ------------------------- | ----------------------------------- | ----------------------------------------- |
| `oura_get_recent_summary` | `days` (1-90), `prefer?`            | Convenience wrapper for recent days.      |
| `oura_compare_periods`    | `days` or explicit date ranges      | Period averages, deltas, and direction.   |
| `oura_get_trends`         | `start_date`, `end_date`, `window?` | Rolling averages and simple trend labels. |

### Tags And Annotations

| Tool                     | Inputs                                                  | Notes                                                                   |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| `oura_get_enhanced_tags` | `start_date`, `end_date`, `verbose?`                    | Reads tags logged in the Oura app.                                      |
| `oura_add_annotation`    | Oura-style tag fields                                   | Stores a local annotation in SQLite.                                    |
| `oura_list_annotations`  | `start_date?`, `end_date?`, `tag_type_code?`, `source?` | Lists local annotations and synced Oura tags. Date filters use overlap. |
| `oura_update_annotation` | `id`, partial tag fields                                | Updates a local annotation.                                             |
| `oura_delete_annotation` | `id`                                                    | Deletes a local annotation.                                             |

Local annotations mirror Oura's `EnhancedTagModel` fields:
`tag_type_code`, `custom_name`, `start_time`, `end_time`, `start_day`,
`end_day`, and `comment`, plus `source` and `oura_id` for provenance.

Because the public Oura API is read-only for user data, annotation writes are
local only. This is intentional: it gives the LLM memory for things Oura does
not capture without pretending to write back to Oura.

### Local Mirror

| Tool        | Inputs                                                  | Notes                                                                              |
| ----------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `oura_sync` | `since_days?`, `full?`, `tags_only?`, `with_heartrate?` | Pulls Oura data into SQLite. Incremental by default with a 7-day re-fetch overlap. |

Read preference for local-first tools:

- `auto` (default): use local data when available; fetch missing/recent data
  from Oura and upsert it locally.
- `local`: offline mode; only return what is already in SQLite.
- `api`: force a fresh Oura API read and upsert the result locally.

## Configuration

| Variable               | Default                               | Purpose                                                                             |
| ---------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| `OURA_CLIENT_ID`       | -                                     | Required. From your Oura OAuth app.                                                 |
| `OURA_CLIENT_SECRET`   | -                                     | Required. From your Oura OAuth app.                                                 |
| `OURA_REDIRECT_URI`    | `http://127.0.0.1:8765/callback`      | Must match your Oura app exactly.                                                   |
| `OURA_TOKEN_PATH`      | `~/.config/oura-ring-mcp/tokens.json` | OAuth token file.                                                                   |
| `OURA_DB_PATH`         | `~/.config/oura-ring-mcp/data.sqlite` | SQLite database for synced data/annotations.                                        |
| `OURA_DEBUG`           | unset                                 | Set to `1` for verbose stderr logs.                                                 |
| `VOICE_LOG_TOKEN`      | -                                     | Required for `npm run voice-server`. Bearer token the Siri Shortcut must send.      |
| `OURA_VOICE_PORT`      | `8770`                                | Port the voice server listens on.                                                   |
| `OURA_VOICE_LOG_PATH`  | `<repo>/logs/voice.log`               | Append-only activity log for voice ingestion.                                       |
| `OURA_MCP_ENTRY_PATH`  | `<repo>/dist/index.js`                | MCP server entry the voice agent spawns.                                            |
| `OURA_VOICE_MODEL`     | unset (SDK default)                   | Optional model override for the voice agent.                                        |
| `HEALTH_IMPORT_TOKEN`  | -                                     | Required for `npm run health-server`. Bearer token the Apple Health Shortcut sends. |
| `OURA_HEALTH_PORT`     | `8771`                                | Port the health server listens on.                                                  |
| `OURA_HEALTH_LOG_PATH` | `<repo>/logs/health.log`              | Append-only activity log for health imports.                                        |

`.env` is loaded from the project root, even when an MCP host starts the
binary from another working directory.

---

## Troubleshooting

**`No saved tokens at ...`**  
Run `npm run oauth-login`.

**`invalid_client` during OAuth**  
Check that `OURA_CLIENT_ID` and `OURA_CLIENT_SECRET` in `.env` match the Oura
application you created.

**`Address already in use :::8765`**  
Change the port in `OURA_REDIRECT_URI`, update the same redirect URI in Oura's
application settings, then run `npm run oauth-login` again.

**Scope-related 401 during sync**  
Run `npm run oauth-login` again so Oura grants the latest scope set.

---

## License

[MIT](LICENSE)
