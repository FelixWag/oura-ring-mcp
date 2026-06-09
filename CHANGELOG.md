# Changelog

All notable changes to this project. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For the architectural rationale behind each change, see [DECISIONS.md](DECISIONS.md).

## [0.7.0] — 2026-06-08

### Added

- **Apple Health import via iOS Shortcut.** New `npm run health-server`
  (Express on `0.0.0.0:8771`) accepts `POST /v1/health/import` with a
  batch of HealthKit samples from an iOS Shortcut and writes them into
  a new generic `health_samples` SQLite table. Same shape works for
  nutrition (`dietary_energy_consumed`, `dietary_protein`, …), activity
  (`steps`, `active_energy_burned`), body composition (`body_mass`),
  or anything else iOS apps write to Apple Health. Setup guide:
  [`docs/apple-health.md`](docs/apple-health.md).
- **`health_samples` table** (schema migration v7) with a composite
  `UNIQUE(sample_type, start_time, source_name, value)` for idempotent
  re-imports. Raw per-sample JSON envelope preserved in a `raw` column
  for lossless re-shaping later.
- **`HealthSamplesRepo`** with `insertBatch()` (single-transaction
  `INSERT OR IGNORE`), `recentByType()`, `countAll()`.
- **Forgiving request parser.** The endpoint accepts four body shapes
  (proper JSON array, `{samples: [...]}` wrapped array, `{samples:
"<NDJSON>"}` stringified accumulation, or a single sample dict) to
  paper over how iOS Shortcuts serializes lists-of-dictionaries
  inconsistently across iOS versions.
- 25 new tests (`tests/health-import.test.ts`) covering auth, all four
  body shapes, validation + coercion, dedup, log appending.
- New `.env.example` section documenting `HEALTH_IMPORT_TOKEN`,
  `OURA_HEALTH_PORT`, `OURA_HEALTH_LOG_PATH`.

### Changed

- Bumped MCP server version to `0.7.0`.
- The voice server and health server are **separate processes on
  separate ports** with **separate bearer tokens** by design — restart
  or rotate either independently.

### Security

- `HEALTH_IMPORT_TOKEN` is distinct from `VOICE_LOG_TOKEN`. Same
  defense-in-depth posture as v0.6: bearer token + Tailscale, no
  public-internet story.

## [0.6.0] — 2026-05-19

### Added

- **Voice logging via Siri Shortcut.** New `npm run voice-server` (Express
  on `0.0.0.0:8770`) accepts `POST /v1/log` with `{ text, captured_at,
timezone, source }`, runs a headless Claude Agent under the user's
  Claude Code subscription credentials (`~/.claude/`), and lets the agent
  call `oura_add_annotation` (and read-only `oura_get_*`) over the same
  local MCP server. One Shortcut, one tap, structured annotations land in
  SQLite. Setup guide: [`docs/siri-shortcut.md`](docs/siri-shortcut.md).
- **`voice_logs` table** with provenance (`raw_text`, `captured_at`,
  `timezone`, `ok`, `error`, `annotation_count`, `claude_summary`,
  `duration_ms`) plus an `annotations.voice_log_id` FK. Annotations
  created during a voice run are linked back via a time-window UPDATE
  after the agent finishes — no parsing of individual tool results
  required.
- **Tool allowlist for the voice agent.** The Claude Agent SDK's
  `canUseTool` hook denies anything outside a fixed set of `mcp__oura__*`
  tool names, so even with a misbehaving model the blast radius is
  bounded.
- **In-memory dedupe** (`SHA-256(text||captured_at)`, 60s TTL) so a
  double-tap on the Shortcut doesn't write the same annotations twice.
- **Travel-aware time context.** The Shortcut sends the iPhone's current
  `timezone`; the system prompt computes the local date and time-of-day
  via `Intl.DateTimeFormat` so "this morning" resolves correctly when
  you're abroad.
- 23 new tests (`tests/voice.test.ts`) covering auth, validation, dedupe,
  agent invocation, log appending, and the system-prompt builder.

### Changed

- Bumped MCP server version to `0.6.0`.
- `.env.example` gained a v0.6 section (`VOICE_LOG_TOKEN`,
  `OURA_VOICE_PORT`, `OURA_VOICE_LOG_PATH`, `OURA_VOICE_MODEL`,
  `OURA_MCP_ENTRY_PATH`).
- `logs/` is gitignored so voice activity logs stay local-only.

### Security

- The voice server has no public-internet story by design. Bearer token
  (`VOICE_LOG_TOKEN`) + Tailscale identity-based VPN is the boundary;
  the README and Siri setup doc are explicit about not port-forwarding.
- The voice agent runs **without** `--dangerously-skip-permissions`; the
  `canUseTool` allowlist is the sandbox.

## [0.5.1] — 2026-05-11

### Fixed

- **Critical: `.env` is now loaded relative to the binary's location, not
  `process.cwd()`.** Previously, when Claude Code (or any MCP host) spawned
  the server with a cwd outside the project directory, dotenv silently
  loaded nothing and the server died with "Missing OURA_CLIENT_ID" — even
  though `.env` existed. Every fresh user was blocked by this; thanks to
  the early adopters who flagged it.
- dotenv loads with `quiet: true` so its boot banner doesn't pollute stderr.

### Added

- `package.json` metadata fields (`author`, `repository`, `bugs`, `homepage`)
  for proper GitHub-side rendering and discoverability.
- Expanded demo-capture instructions in `docs/README.md` with a basic →
  impressive prompt progression.

### Removed

- `CLAUDE.md` (internal AI-assistant instructions; not useful for end
  users). Added to `.gitignore` along with `.claude/`.

## [0.5.0] — 2026-05-10

### Added

- README hero with tagline, badges, demo GIF, and a "What you can ask Claude"
  prompt gallery — the project is now publishable.
- `npm run init` chains `setup` → `oauth-login` → `sync` so first-time setup
  is one command.
- `CHANGELOG.md` (this file).

### Changed

- README setup flow tightened from six steps to three explicit user-facing
  commands: `npm install`, `npm run build`, `npm run init`.
- Privacy / Terms URL placeholders replaced with real GitHub URLs.

## [0.4.5] — 2026-05-10

### Fixed

- Heartrate sync now chunks at 30-day windows instead of 90 — the Oura
  `/usercollection/heartrate` endpoint enforces a stricter per-request range
  cap than daily collections. Previously the very first chunk of a >30-day
  backfill returned a 400. Discovered empirically; not in the OpenAPI spec.

### Added

- `MAX_HEARTRATE_RANGE_DAYS = 30` cap on `oura_get_heartrate` tool input.
- Empirical per-endpoint range table in `DECISIONS.md`.

## [0.4.4] — 2026-05-10

### Added

- Heart-rate timeseries mirror — schema migration v5 adds the `heartrate`
  table with composite primary key `(timestamp, source)`. Default-on in
  `npm run sync`; opt out via `--no-heartrate` (or `with_heartrate: false`
  on the `oura_sync` MCP tool).
- `oura_get_heartrate` is now local-first and compact-by-default. Returns
  per-hour-by-source aggregation (`avg/min/max/count`) computed via
  SQLite's `strftime` + `GROUP BY` at read time. `verbose: true` returns
  raw samples. `prefer: 'auto' | 'local' | 'api'` matches summary tools.
- Per-call `pageLimit` parameter on `getCollection`; heartrate sync uses
  100 instead of the daily 5.

## [0.4.3] — 2026-05-09

### Added

- `stress` and `heart_health` OAuth scopes — required for
  `daily_resilience`, `daily_cardiovascular_age`, and `vO2_max`. Existing
  users re-run `npm run oauth-login` once to grant them.
- API client surfaces a clear "run `npm run oauth-login` to re-authorize"
  hint when a 401 response body mentions "scope".

### Changed

- 401-with-"scope" responses skip the refresh-and-retry path (refresh
  doesn't help — only re-authorization does). Saves a wasted API call.

## [0.4.2] — 2026-05-09

### Added

- 6 missing daily / event collections via schema migration v4:
  `daily_stress`, `daily_resilience`, `daily_cardiovascular_age`,
  `vO2_max`, `sleep_time`, `rest_mode_periods`. `oura_sync` now covers
  14 collections (was 8).
- `extractField<T>(day, '$.path')` and `extractFieldRange<T>(start, end, '$.path')`
  helpers on `DailyCollectionRepo` — typed wrappers around SQLite's
  `json_extract` for tables without a single canonical numeric score
  (e.g. `daily_resilience.level` is a string, not an integer).

### Changed

- Per-table `SCORE_FIELDS` mapping in `DailyCollectionRepo`. Tables
  without a numeric score leave the indexed `score` column NULL;
  raw JSON in `data` remains the lossless source of truth.
- Float scores (e.g. `vo2_max`) rounded for the indexed column;
  exact value preserved in `data`.

## [0.4.1] — 2026-05-09

### Added

- Chunked historical backfill — `--since` accepts up to 730 days (≈2 years).
  Requests > 90 days are split into ≤90-day chunks transparently. New
  `chunkRange(from, to, maxDays)` helper.

### Changed

- One `sync_runs` row per chunk per collection (not per collection),
  for accurate audit on partial-failure.

## [0.4.0] — 2026-05-09

### Added

- **Local SQLite mirror** of Oura data (8 collections at the time:
  `daily_sleep`, `daily_readiness`, `daily_activity`, `daily_spo2`,
  `sleep_periods`, `workouts`, `sessions`, `enhanced_tag`).
  Hybrid storage: indexed key columns (`day` / `oura_id`, `score`,
  `last_synced_at`, `first_seen_at`) plus a raw `data` JSON column
  carrying the entire Oura row verbatim.
- `npm run sync` script + `oura_sync` MCP tool. Incremental by default,
  with a 7-day re-fetch window so Oura's same-day re-scoring is captured
  (the v0.2 nap → score-update observation).
- **Local-first reads** in `oura_get_daily_summary` and
  `oura_get_recent_summary`. `prefer: 'auto' | 'local' | 'api'`
  parameter; `auto` reads local for stable days, falls back to the API
  for today / yesterday / missing days. `source` field on responses
  for traceability.
- `discovered_tag_types` table — every `enhanced_tag` sync upserts each
  observed code, so the annotation validator self-corrects v0.3.1's
  inferred codes.
- `sync_runs` audit log.
- Schema migration v3.

## [0.3.1] — 2026-05-09

### Changed

- Replaced the v0.3 `KNOWN_TAG_TYPE_CODES` guess-list with ~170 codes
  from the Oura mobile app's actual predefined tag set, classified by
  empirically-observed prefix (`tag_sleep_*` for sleep-impact framing,
  `tag_generic_*` for everything else).
- Schema migration v2 rewrites any existing `tag_type_code='alcohol'`
  rows to `'tag_sleep_alcohol'` (the real Oura code).

### Documented

- Known issue: user-defined custom Oura tags don't appear in the
  `enhanced_tag` (or legacy `tag`) API endpoints. Verified by
  bypassing the MCP stack with `curl`. Three hypotheses + retest
  plan recorded in `DECISIONS.md`.

## [0.3.0] — 2026-05-09

### Added

- **Local annotations** stored in SQLite (`annotations` table) with
  columns mirroring Oura's `EnhancedTagModel` 1:1 plus `source`
  (`'local'` / `'oura'`) and `oura_id` (`UNIQUE`). Schema migration v1.
- 5 new MCP tools: `oura_get_enhanced_tags` (read Oura tags),
  `oura_add_annotation` / `oura_list_annotations` /
  `oura_update_annotation` / `oura_delete_annotation`.
- `tag` OAuth scope.
- `include_annotations: true` default on summary tools — each day
  record is auto-joined with matching local annotations.

### Changed

- 12 → 13 MCP tools.
- Confirmed via the official OpenAPI spec that the Oura API is
  read-only. The "write tags from Claude" feature lives in our local
  SQLite, not Oura's servers.

## [0.2.0] — 2026-05-09

### Added

- 3 new MCP tools: `oura_get_recent_summary`, `oura_compare_periods`,
  `oura_get_trends`. Pure-function modules `src/oura/derive.ts`
  (averages / deltas / rolling means / linear-trend slope) and
  `src/oura/shape.ts` (raw API → compact projections).
- `verbose` parameter on date-range tools (default `false`).
- 429 / Retry-After-aware retry handling in `OuraClient`.
- Future-date guard in tool input validation.

### Changed

- Compact-by-default responses cut a 7-day daily-summary payload from
  ~173,000 characters (above the MCP response size limit) to ~5,000.
- 5 → 8 MCP tools.

## [0.1.0] — 2026-05-06

### Added

- Initial release.
- OAuth2 authorization-code flow with auto-refresh on 401 and on
  near-expiry. Tokens stored at `~/.config/oura-ring-mcp/tokens.json`
  with `0600` perms.
- Loopback OAuth listener for the redirect callback.
- 5 MCP tools: `oura_get_daily_summary`, `oura_get_sleep`,
  `oura_get_activity`, `oura_get_heartrate`, `oura_get_personal_info`.
- Read-only against Oura. `npm run setup` interactive `.env` writer.
- TypeScript + zod + official MCP SDK.
- GitHub Actions CI on Node 20 / 22 / 24.
- 12 unit tests.
