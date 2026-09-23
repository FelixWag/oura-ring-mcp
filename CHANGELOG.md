# Changelog

All notable changes to this project. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For the architectural rationale behind each change, see [DECISIONS.md](DECISIONS.md).

## [0.9.0] — 2026-09-22

### Added

- **Telegram inbound** (`npm run telegram-server`, schema v14). Owns a bot by
  long polling, so there is no public endpoint and no inbound port — the
  process only makes outbound calls. Messages from the one allowlisted private
  chat are stored in `telegram_updates`; photos, voice notes and documents are
  downloaded to a media root beside the database (`0700`/`0600`), named by
  content hash. Receive-and-store only: nothing interprets a message yet.
  Setup: [`docs/telegram.md`](docs/telegram.md).

### Security

- **A forwarded message is recorded but its text is not adopted.** A forward
  carries the owner's `chat.id` and `from.id`, so the envelope check passes
  while the words belong to someone else. Its text is dropped, the row is
  flagged `is_forwarded`, and nested `reply_to_message` / `quote` payloads —
  which embed a third party's id, name and words — are stripped before the
  update is stored. Today that keeps a stranger out of the database; once a
  caption becomes a prompt for an agent holding write tools, it is the
  difference between data and instructions.
- **Media downloads are streamed against a byte counter**, so a response with
  no `content-length` cannot be buffered whole before a limit applies, with
  `redirect: 'error'` (a 3xx could otherwise aim the fetch at the voice or
  health server on localhost) and a 60s timeout.
- **A persistent poll failure now backs off and says so in the chat.** Failing
  closed is right — the offset only moves on committed rows — but a wedged
  loop was indistinguishable from a quiet day, and Telegram discards
  undelivered updates after ~24h.
- **The pre-commit hook learned two new patterns**: Telegram bot tokens and
  chat ids matched neither existing secret pattern. (The first version pinned
  the token to exactly 35 characters and let a 36-character fixture through.)

### Notes

- **The poll offset is derived from stored rows, never stored separately.**
  `getUpdates(offset=N)` acknowledges everything below N and Telegram then
  discards it permanently, so an offset that advances before a durable write
  loses messages irrecoverably.
- **Rejected updates still move the cursor**, via a high-water mark rather
  than a row. Without it the next poll refetches the same rejected update
  forever and one stranger's message pins the queue; with a row per rejection,
  a flood of spam would become a flood of rows in a health database.
- **Media downloads run after the commit**, because better-sqlite3
  transactions are synchronous and cannot await. `pending` names that gap.
- **An edited message is kept as a second row** whose predecessor points at
  it, so a corrected meal is not counted twice.

## [0.8.1] — 2026-09-22

### Fixed

- **Mixed units in `health_samples`** (schema v13). The same logger wrote
  dietary energy as both `kcal` and `J`, and sodium and cholesterol as both
  `mg` and `g`, so `SUM(value)` mixed them silently — one day totalled
  6,682,560 "kcal" because 31 rows were joules. Units are now canonical per
  sample type, converted on write (`src/health/units.ts`), and the migration
  converts the existing rows. Verified before converting: every joule row had
  a kcal twin at the same instant matching `value / 4184` exactly.
- **The same sample stored twice.** `health_samples` deduped on `start_time`
  as text, so one instant written with different UTC offsets — an iOS
  Shortcut at `+01:00`, an Apple Health export re-stamping it `+02:00` —
  passed the key twice. Migration 13 adds `start_epoch`/`end_epoch`, collapses
  the duplicates and indexes on the instant. Same defect migration 11 fixed
  for `external_workouts`.
- **Nutrition attributed to the wrong day.** Consumers grouped by
  `date(start_time)`, which converts to UTC first, so a 00:30 meal landed on
  the previous day and the boundary moved at each DST change. Rows now carry
  `local_day` and `local_time`, the day the source itself asserted.

## [0.8.0] — 2026-09-17

### Added

- **HealthKit workout import.** New `external_workouts` table (schema v8)
  stores `HKWorkout` records. This is the only route to workouts recorded
  with Oura's **Live Activity Tracking**, which the Oura API does not
  return — `/v2/usercollection/workout` omits them entirely, so anything
  tracked live is invisible to API-only consumers.
- **`npm run import-health-export -- <export.xml>`** backfills history from
  an Apple Health export (Health app → profile → Export All Health Data).
  Streams the file, so a ~900 MB export parses in about five seconds without
  loading it into memory. Also imports body-composition and nutrition
  records, which closes the same gap for `body_mass` and `dietary_*`.
- **Read-time session resolution** (`src/health/resolve.ts`). One session can
  produce several records — a typed row, a phone-recorded live-activity
  wrapper, plus any third-party app writing the same workout. `resolveSessions()`
  collapses overlapping records into one session, preferring the Oura API,
  then Oura via HealthKit, and excluding configured third-party writers.

- **`npm run resolve-sessions`** materialises the resolver's output into a
  `resolved_sessions` table (schema v9) for consumers that speak only SQL.
  The deduplication can't be expressed in SQL — it needs transitive overlap
  clustering with source precedence — so without this, SQL-only consumers
  count one session several times.

- **`POST /v1/health/workouts`** accepts HKWorkout records from a native
  client, including HealthKit's UUID (`external_id`, schema v10), which makes
  re-import dedupe exact rather than a guess from timestamps.
- **Dedupe audit** runs on every `resolve-sessions` rebuild: resolved sessions
  must not overlap, previously unseen writer apps are flagged, and near-miss
  cross-source pairs are surfaced. Errors exit non-zero so a scheduled rebuild
  fails loudly instead of publishing double-counted numbers.
- **`ios/HealthBridge`** — a SwiftUI companion app that reads HealthKit and
  posts to the two endpoints. It exists because Shortcuts cannot read workouts
  at all; see [`ios/README.md`](ios/README.md).

- **Two narrower dedupe rules**, both found by auditing real data:
  a _handoff_ — one continuous effort that two different apps each caught part
  of (a run tracker stopping as the ring picks up) — now resolves to one
  session when the records sit within 5 minutes and agree on the activity; and
  a single app's two overlapping records of the _same_ activity now collapse,
  since one app cannot have you doing a thing twice at once. Both are
  deliberately narrow: a wrong merge erases a real session, whereas a missed
  merge only leaves a duplicate the audit flags.

- **Dedupe by instant, not by timestamp text** (schema v11). Apple's export
  stamps every record with the UTC offset in force on export day, while a
  native reader uses the offset that applied on the day itself — the same
  moment written two ways, so 327 workouts were stored twice. Epoch columns
  now carry identity; the migration collapses the existing duplicates.
- **A live-activity wrapper can no longer swallow neighbouring records.**
  Wrappers attach to a cluster but never build one: one that overran its
  workout by a minute used to bridge that session to an unrelated record and
  cost it its identity. A seconds-long fragment can no longer represent a
  cluster containing a real session either, whatever its source.

- **Percentages are stored as percentage points** (schema v12). HealthKit's
  percent unit is a fraction, so 25% body fat arrived as `0.25` alongside unit
  `'%'` — which reads as "0.25 %" to anything querying the table. Values are
  normalised on write, covering every route in, and rounded, because `value`
  is part of the UNIQUE key and float noise (`0.246` vs `0.246000000000000002`
  for one reading arriving by two routes) otherwise stored it twice.

### Notes

- Storage stays lossless: every source record is kept, and deduplication
  happens at read time, so a rule change needs no re-import.
- Adjacent records are never merged — strength training immediately followed
  by cardio is a normal pattern and stays two sessions.
- Live activities that were never stopped (multi-day durations) are discarded
  before clustering; left in, one spans a whole day and absorbs every workout
  it overlaps.

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
