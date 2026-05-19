# Decisions Log

A running, chronological log of architectural and product decisions for
oura-ring-mcp. Append-only — once a decision is recorded, don't rewrite
history. If a later decision supersedes an earlier one, add a new entry that
references and overrides the previous one.

Each entry: short title, date, context, decision, rationale. Keep entries
short — link to PRs / commits / external docs for detail.

---

## 2026-05-06 — TypeScript / Node + official MCP SDK

**Context.** Choosing the implementation language and MCP framework for v0.1.

**Decision.** TypeScript on Node.js 20+, using `@modelcontextprotocol/sdk`
(the official SDK) over stdio.

**Rationale.** TS gives us strong types for MCP tool schemas (via zod) with
zero exotic dependencies. The official SDK is well-maintained, matches the
spec, and stdio is the default transport Claude Code expects. npm chosen
over pnpm for stargazer-friction reasons.

---

## 2026-05-06 — OAuth2 Authorization Code with local loopback redirect

**Context.** Oura requires OAuth2; no personal-access-token shortcut for
third-party apps.

**Decision.** Use the standard Authorization Code flow with a one-shot
local HTTP listener at `http://127.0.0.1:8765/callback` (default; later
changed to `localhost`, see 2026-05-07 entry). Tokens persisted to
`~/.config/oura-ring-mcp/tokens.json` with `0600` perms.

**Rationale.** Loopback redirect is the standard pattern for CLI/desktop
OAuth clients. No web server required. Atomic-write + chmod keeps tokens
safe at rest.

---

## 2026-05-06 — Oura API is read-only — confirmed against OpenAPI spec

**Context.** The original v0.3 plan in `CLAUDE.md` assumed we could write
tags via the Oura API. Needed to verify before planning v0.3.

**Decision.** Confirmed by inspecting the official OpenAPI spec at
`https://cloud.ouraring.com/v2/static/json/openapi-1.29.json`:
**every user-data endpoint supports GET only.** The only write endpoints
in the entire API are `/v2/webhook/subscription*` (partner notifications).

**Rationale.** This is a hard product constraint, not a choice we made.
Implication: the "write tags from Claude" feature lives in our **local
SQLite database**, not in Oura's servers. The plan for v0.3 pivoted from
"write to Oura" to "give Claude memory of things Oura can't measure."

---

## 2026-05-06 — Compact-by-default tool responses (v0.2)

**Context.** A 7-day call to `oura_get_daily_summary` in v0.1 returned
~173,000 characters and exceeded the MCP response size limit. The bulk
was nested timeseries data the LLM almost never needs.

**Decision.** Every date-range tool gains a `verbose: boolean` parameter
(default `false`). Compact mode strips deep nested structures (per-minute
HRV / movement / breathing arrays) and keeps scores, key contributors, and
durations. `src/oura/shape.ts` owns the projection.

**Rationale.** Cuts response sizes by ~10–20×. Raw access remains available
for ad-hoc inspection (`verbose: true`) and is still planned to bypass the
shape layer entirely for v0.4 bulk archival sync.

---

## 2026-05-06 — `include_annotations: true` default in summary tools (v0.3)

**Context.** When summary tools return Oura data, should they automatically
join in local annotations from SQLite, or require an opt-in flag?

**Decision.** Default `include_annotations: true` in
`oura_get_daily_summary` and `oura_get_recent_summary`.

**Rationale.** Annotations _are_ the cross-context the LLM most needs
(e.g. "did your sleep score correlate with alcohol days?"). Defaulting to
`true` makes the join automatic; the LLM doesn't need to remember to ask.
The cost is small because annotations are typically a handful of rows per
day at most.

---

## 2026-05-06 — Local annotation schema mirrors Oura's `EnhancedTagModel` (v0.3)

**Context.** Original v0.3 plan had a custom `(day, type, note)` schema for
local annotations. Question raised: shouldn't this match Oura's tag schema
exactly so the two data sources merge cleanly?

**Decision.** Yes. The `annotations` table columns map 1:1 to Oura's
`EnhancedTagModel` (`tag_type_code`, `start_time`, `end_time`, `start_day`,
`end_day`, `comment`, `custom_name`) plus two extras:

- `source` — `'local'` or `'oura'` to track provenance.
- `oura_id` — the Oura tag's id when source='oura'; `UNIQUE` for upsert.

**Rationale.** Unifies local annotations and (future) synced Oura tags in
one queryable table. v0.4 sync becomes "insert with `source='oura'` upserting
on `oura_id`." No migration needed later. Matches Oura's mental model
exactly, including multi-day spans and start/end times.

---

## 2026-05-06 — Drop legacy `oura_get_tags`, ship only `oura_get_enhanced_tags` (v0.3)

**Context.** Both `tag` (legacy) and `enhanced_tag` exist as Oura endpoints.
The two have different schemas and serve overlapping purposes — concern that
shipping both would confuse the LLM.

**Decision.** Ship only `oura_get_enhanced_tags`. Drop the legacy tool from
the v0.3 plan.

**Rationale.** The legacy `Tag` model maps to Oura's deprecated `ASSANote`
type. Current Oura app activity flows into enhanced_tag. Only old accounts
might have data in the legacy endpoint, and we can add a tool for it later
in 5 minutes if needed. Keeping the tool surface lean reduces LLM tool-pick
ambiguity.

---

## 2026-05-06 — Constrained `tag_type_code` with `custom` escape hatch (v0.3)

**Context.** Should our local annotations accept any string as the type, or
constrain to a known set?

**Decision.** Match Oura's own design exactly:

- `tag_type_code` must be `null`, `'custom'`, or one of a known shortlist
  (`KNOWN_TAG_TYPE_CODES` in `src/db/tag_types.ts`).
- If `'custom'`, `custom_name` is required.
- If `null`, `comment` is required (text-only annotation).

The shortlist is seeded with common codes for v0.3 (alcohol, caffeine, sick,
traveled, napped, etc.). v0.4 will add a sync that pulls the user's actual
enhanced_tag history and refreshes the canonical list dynamically.

**Rationale.** Constraints catch typos and keep data joinable. The `custom`
hatch keeps it flexible. Mirrors how Oura's own UI works.

---

## 2026-05-06 — `better-sqlite3` for the local database (v0.3+)

**Context.** Choice between `better-sqlite3` (mature npm library, native
compilation) vs `node:sqlite` (built-in to Node 22+, zero deps).

**Decision.** `better-sqlite3`.

**Rationale.** Industry-standard, synchronous API (great fit for our
single-user use), excellent TS types, mature ecosystem. Native compilation
via node-gyp succeeds first-try for almost every macOS/Linux user. Zero-deps
appeal of `node:sqlite` is real but its API is smaller, the ergonomics
weaker, and it requires bumping `engines.node` to `>=22`. We can revisit
this decision in v0.4+ once `node:sqlite` is more battle-tested.

---

## 2026-05-06 — Score values can change after the day ends (forward note)

**Context.** During v0.2 testing, a sleep score of 68 became 82 a few hours
later because the user took a nap and Oura reprocessed the day.

**Decision.** Record this constraint now even though we don't act on it
until v0.4. The future SQLite sync of Oura data must be **idempotent on
`(metric, day)` with a `last_synced_at` timestamp**. Insert-or-update,
never append-only.

**Rationale.** Append-only would produce duplicate rows per day. Without
`last_synced_at` we can't answer "is this row stale?" or implement smart
"only re-fetch days within the last N days" optimizations.

---

## 2026-05-06 — Branch + PR workflow, never direct to `main`

**Context.** First-time GitHub workflow for this project.

**Decision.** Every change goes on a `feat/<name>` or `fix/<name>` branch
and ships through a PR (even when working solo). CI runs on every PR.

**Rationale.** Forces a moment of review (the PR diff view catches things
the editor doesn't), keeps `main` always shippable, and creates a
searchable history. ~30 s of overhead per change is worth it.

---

## 2026-05-09 — 🐛 Known issue: custom Oura tags don't appear in the API

**Context.** A user-named "custom" tag created in the Oura mobile app does
not appear in either the `enhanced_tag` or legacy `tag` API endpoints,
even after waiting. Verified by:

1. `curl` straight to `/v2/usercollection/enhanced_tag` (bypassing our MCP
   stack entirely) — 37 rows returned, **zero with `tag_type_code='custom'`,
   zero with `custom_name` set**.
2. Our compact and verbose paths return identical row counts and identical
   shapes — so the bug is not in our parsing/filtering.
3. `cache-control: no-cache` on the response rules out a stale-cache theory.

**Status.** Open. Flagged for later investigation; the v0.3.1 patch unblocks
the canonical tag-code list separately.

**Hypotheses (untested):**

1. **Sync delay** — Oura's cloud sync may take longer than expected for new
   tags, especially custom ones.
2. **Custom tags are stored as comments on canonical tags** — the 7 rows in
   the user's data with non-empty comments (e.g. "Chilli cici" on a
   `tag_generic_spicy_meal`) suggest the dominant pattern is "canonical type
   - free-form comment," not a true custom row.
3. **The Oura API simply doesn't expose user-named custom tags** — would be
   unusual given the schema explicitly defines `tag_type_code='custom'`,
   but possible.

**Next test (no code changes required):** log a known canonical tag (e.g.
`tag_generic_tea`) in the app, wait 30+ minutes, re-query. If the canonical
tag appears but the custom one still doesn't, hypothesis 1 is ruled out and
we focus on 2/3.

---

## 2026-05-09 — v0.3.1: real Oura `tag_type_code` shortlist + v2 migration

**Context.** v0.3 seeded `KNOWN_TAG_TYPE_CODES` with bare guesses (`alcohol`,
`caffeine`, `traveled`, …). Once we queried the user's real
`enhanced_tag` history, the actual codes turned out to follow a two-prefix
scheme (`tag_sleep_*` and `tag_generic_*`) and use slightly normalized names
(e.g. `late_screen_time` → `tag_sleep_late_screentime`,
`sleeping_aids` → `tag_sleep_aid`). None of the v0.3 guesses matched.

**Decision.** Replace the seed list with ~170 codes derived from the user's
in-app tag picker, classified into `TAG_SLEEP_CODES` and `TAG_GENERIC_CODES`
in `src/db/tag_types.ts`. Mark observed codes with `// ✓` and treat the rest
as inferred. Add schema migration v2 that renames the existing v0.3 row
(`tag_type_code='alcohol'`) to `tag_sleep_alcohol` so it validates against
the new list.

**Rationale.** Empirical data > guesses. The list is 10× larger now so the
LLM can use precise codes proactively (instead of falling back to `custom`
for everything). Inferred codes are flagged so v0.4's planned "refresh
canonical list from synced enhanced_tags" can correct them automatically;
any local rows using a wrong inferred code can be migrated with the same
pattern as v2 (a one-line UPDATE inside a versioned migration).

---

## 2026-05-09 — v0.4 plan approved: local SQLite mirror of Oura data

**Context.** Up through v0.3.1, every MCP tool that reads Oura data hits the
API on every call. That works but (a) eats rate limits on long-window
analyses, (b) re-fetches data that hasn't changed in months, and (c) blocks
reasoning over multi-month / multi-year windows because each request is
capped at 90 days. Time to mirror Oura's daily data into the existing
SQLite database.

**Decision.** Ship v0.4 with the following scope:

1. **Hybrid storage shape** — for each mirrored collection: indexed key
   columns (`day` / `oura_id`, `score` where present, `last_synced_at`,
   `first_seen_at`) plus a raw `data` JSON column carrying the entire Oura
   row verbatim. Lossless storage; queryable via SQL; no migration churn
   when Oura adds fields.

2. **Tables added (schema migration v3):** `daily_sleep`, `daily_readiness`,
   `daily_activity`, `daily_spo2`, `sleep_periods`, `workouts`, `sessions`,
   `discovered_tag_types`, `sync_runs`. `enhanced_tag` continues to land in
   the existing `annotations` table with `source='oura'` (the schema-
   mirroring decision from v0.3 pays off).

3. **`npm run sync` script** — incremental by default; re-fetches the **last
   7 days** every run regardless of state, addressing the "Oura re-scores
   recent days as more data arrives" constraint recorded for v0.2. Flags:
   `--full`, `--since N`, `--tags-only`. Concurrent across collections,
   sequential within a collection (paginated). Logs each run to `sync_runs`.

4. **`oura_sync` MCP tool** — thin wrapper around the same code path, so the
   LLM can refresh before an analysis without dropping to the shell.
   No auto-sync on MCP startup (would slow spawn time and add magic).

5. **Local-first summary tools** — `oura_get_daily_summary` and
   `oura_get_recent_summary` modified in place to prefer local rows for
   stable days, falling back to the API for missing/recent days.
   Response shape unchanged; new `prefer: 'auto'|'local'|'api'` parameter
   defaults to `auto`. Adds a `source: 'local'|'api'|'mixed'` field to
   responses for traceability.

6. **`tag_type_code` self-correction** — every `enhanced_tag` sync upserts
   each row's code into `discovered_tag_types` (with `first_seen_at`,
   `last_seen_at`, `occurrence_count`). The annotation validator now
   accepts a code if it's in `KNOWN_TAG_TYPE_CODES` **or** in
   `discovered_tag_types`. v0.3.1's inferred codes converge to reality
   without manual edits; the static list becomes a bootstrap.

7. **Out of scope:** heartrate timeseries (too high-volume for v0.4 local
   storage; on-demand via the existing tool), personal_info (single row,
   refresh on demand), auto-sync on startup.

**Rationale.** Hybrid schema is the right tradeoff between query
ergonomics and lossless mirroring. Re-fetch window of 7 days is
empirically motivated by the nap → score-update behavior we already
observed. Local-first is the actual user value of v0.4 (instant queries,
no rate limits, no payload caps); modifying the existing tools in place
keeps the LLM's tool surface unchanged. `discovered_tag_types` resolves
the v0.3.1 inference risk cleanly without forcing manual list curation.

---

## 2026-05-09 — v0.4.1: chunked historical sync

**Context.** v0.4 capped `--since N` at 90 days because the Oura API
practically enforces a per-request range limit. A real user wanting to
backfill 6–8 months of history (the natural "I just got my data, give me
everything" case) had to run multiple syncs manually with no clean way to
extend the window. New stargazers would hit the same friction immediately.

**Decision.** Ship v0.4.1: lift the orchestration cap to 730 days
(`MAX_LOOKBACK_DAYS`, ≈2 years) while keeping the per-request cap at 90
days (`MAX_RANGE_DAYS_PER_REQUEST`). A new `chunkRange` helper splits
larger windows into contiguous ≤90-day chunks; each per-collection sync
loops through them sequentially, recording one `sync_runs` row per chunk
for audit. The `--since` CLI flag and `oura_sync` MCP tool's `since_days`
parameter both accept up to 730. No new flag — chunking is transparent.

**Rationale.** Historical backfill is the obvious cold-start scenario for
any user with existing Oura data. Manual multi-run workarounds are
fragile and the wrong shape for "stargazer-friendly" UX. Per-chunk
audit rows keep the failure model precise (a partial backfill failure
shows exactly which window threw, not a mystery aggregate). Sequential
chunks within a collection let the existing 429-handling stay simple.

---

## 2026-05-09 — v0.4.2: missing daily collections + JSON-first storage convention

**Context.** v0.4 shipped 4 daily-keyed collections (`daily_sleep`,
`daily_readiness`, `daily_activity`, `daily_spo2`) and 3 event-keyed ones
(`sleep`, `workout`, `session`). The Oura API exposes more: `daily_stress`,
`daily_resilience`, `daily_cardiovascular_age`, `vO2_max`, `sleep_time`,
and `rest_mode_period`. After auditing the spec for completeness — to make
sure no analytically-useful data is missing from the local mirror — these
six were identified as v0.4.2 scope. Heart rate / IBI / device metadata
remain out of scope (heartrate already planned for v0.4.3).

**Decision.** Schema migration v4 adds 6 tables matching the existing
patterns (5 daily + 1 event). `ENDPOINTS`, `DAILY_PLAN`, `EVENT_PLAN`, and
the type unions extend by 6 entries. `oura_sync` automatically picks them
up — no new MCP tool. Result: `oura_sync` now covers 14 collections.

**Sub-decision: JSON-first storage for non-numeric / multi-field scores.**
Some new collections don't fit the existing `(day, score INTEGER, data
TEXT)` shape:

- `daily_stress` returns `recovery_high` and `stress_high` separately,
  no aggregate score.
- `daily_resilience` returns a STRING `level` (`ok`/`good`/`great`/…),
  not a numeric score.
- `sleep_time` is a recommendations object, no score.
- `daily_cardiovascular_age` and `vo2_max` use different field names
  (`vascular_age`, `vo2_max`) for their numeric value.

Adopted convention: the `data` JSON column is the lossless source of
truth for every daily table. The indexed `score INTEGER` column is a
fast-lookup convenience populated via a per-table `SCORE_FIELDS`
mapping (in `src/db/repos/daily.ts`). Tables without a single canonical
numeric score leave `score` NULL. Floats (vo2_max) are rounded for the
indexed column; the exact value remains in `data`.

To make the JSON path ergonomic, `DailyCollectionRepo` gains
`extractField<T>(day, '$.path')` and
`extractFieldRange<T>(start, end, '$.path')` — thin wrappers around
SQLite's `json_extract` returning typed values. Future tools that
correlate, e.g., resilience level with sleep score across a date range
use these without writing raw SQL.

**Rationale.** Forcing every daily collection into a single integer
`score` column would either (a) drop information (resilience.level), (b)
arbitrarily map strings to numbers, or (c) require per-table schema
divergence. JSON-first preserves data losslessly with a single
storage shape, while the indexed `score` stays available where it makes
sense. The `extractField*` helpers keep query ergonomics good without
spreading raw SQL across the codebase.

**Out of scope (deferred to v0.4.3+):** `heartrate`, `interbeat_interval`,
`ring_battery_level`, `ring_configuration`. Heart rate is the next
meaningful addition; the others are ring-telemetry rather than
health data and may never be added.

---

## 2026-05-09 — v0.4.3: missing OAuth scopes (`stress`, `heart_health`)

**Context.** The first real `npm run sync` after v0.4.2 surfaced 401
errors on three of the new collections — `daily_resilience` (needs the
`stress` scope), `daily_cardiovascular_age` and `vO2_max` (both need
`heart_health`). The OpenAPI spec doesn't formally declare per-endpoint
scope requirements, so the only way to discover them empirically was to
ship and observe.

Curiously, `daily_stress` itself works under the existing `daily` scope
despite the name — so scope mappings are not predictable from endpoint
names. Empirical mapping (current as of 2026-05-09):

| Collection                   | Required scope        |
| ---------------------------- | --------------------- |
| `daily_resilience`           | `stress`              |
| `daily_cardiovascular_age`   | `heart_health`        |
| `vO2_max`                    | `heart_health`        |
| `heartrate` (planned v0.4.4) | likely `heart_health` |

**Decision.** Add `stress` and `heart_health` to `OURA_SCOPES`. Existing
users re-run `npm run oauth-login` once to grant them; new users get
them automatically on first auth. Also: the API client now detects 401
responses whose body mentions "scope" and surfaces a clear
`run \`npm run oauth-login\` to re-authorize` hint, instead of the raw
"Token is not authorized" message. Refresh-on-401 is skipped for
scope-related errors (refresh wouldn't help) — saves a wasted API call.

**Rationale.** Scopes are additive; granting more never breaks anything.
Re-authorizing once is a tolerable upgrade cost given how rarely it
happens. The improved error hint costs ~10 lines but turns a confusing
error into a self-explanatory one — exactly the kind of UX polish that
matters for a public repo.

---

## 2026-05-10 — v0.4.4: heart-rate mirror with hourly aggregation

**Context.** Heart-rate was the last meaningful data gap. v0.4 deliberately
deferred it because of volume concerns; with v0.4.1's chunking and
better-sqlite3's actual performance, those concerns turned out to be
overstated — ~50–100k rows per ~6 months of data is trivial for SQLite.
Adding heartrate completes the local-mirror story before publishing the
project on GitHub.

**Decision.** Ship v0.4.4 with the following choices:

1. **Schema (migration v5)** — single `heartrate` table with composite
   primary key `(timestamp, source)`. The composite key is required:
   Oura emits the same instant under two sources during state
   transitions (e.g. sleep onset bridges 'rest' and 'sleep'); a single
   `timestamp` PK would silently drop one row.

2. **Default-on sync** with a `--no-heartrate` (`with_heartrate: false`)
   opt-out. Volume is not the issue; UX is. "Run sync, get everything"
   beats "remember the flag." The opt-out exists for fast incremental
   refreshes that only touch daily scores.

3. **Datetime chunking** — heartrate uses `start_datetime` /
   `end_datetime` rather than date params. The orchestrator reuses the
   existing `chunkRange` helper and converts each daily 90-day chunk
   into its datetime equivalent (`T00:00:00Z` → `T23:59:59Z`).

4. **Higher page limit** — `getCollection` already accepts a per-call
   `pageLimit`; heartrate sync passes `100` (vs the daily-collection
   default of 5). A 90-day heartrate window can span many pages of
   per-sample data; 5 would silently truncate.

5. **`oura_get_heartrate` becomes local-first + compact-by-default.**
   Per-hour-by-source aggregation as the default response (one row per
   `(hour, source)` bucket: avg / min / max / count). Computed at read
   time via SQLite's `strftime` + `GROUP BY` — storage stays per-sample
   for future flexibility. `verbose: true` returns raw samples.
   `prefer: 'auto' | 'local' | 'api'` matches the summary tools.

6. **Aggregation deferred to v0.5+:** per-source-period (option C from
   the v0.4.4 plan), `interbeat_interval` mirror, daily HR roll-ups.

**Rationale.** Storage stays lossless (raw samples in `data` JSON column
plus indexed `bpm`/`source`/`timestamp`); aggregations live as SQL
projections. Future tools layering on top — different aggregations,
event correlation, exports — don't require re-syncing. Default-on
heartrate is a defensible UX choice given that the marginal cost is a
few seconds and a few MB; the opt-out is there for power-users who
care about that. Per-call `pageLimit` keeps daily collections defensive
against accidental over-fetch while letting timeseries explicitly
opt into broader pagination.

---

## 2026-05-10 — v0.4.5: heartrate chunked at 30 days, not 90

**Context.** v0.4.4 shipped heartrate sync using the same 90-day chunk
size as daily collections. The first real `npm run sync -- --since 240`
returned a 400: _"Timerange between start and endtime has to be less
than or equal to 30 days."_ Heartrate has a stricter per-request cap
than the daily endpoints — discovered empirically because the OpenAPI
spec doesn't document per-endpoint range limits.

**Decision.** Introduce `HEARTRATE_MAX_RANGE_DAYS = 30` in
`src/db/sync.ts` and pass it as the third argument to `chunkRange` from
`syncHeartrate`. Mirror the constraint in `src/mcp/tools.ts` with a
`MAX_HEARTRATE_RANGE_DAYS = 30` used by `oura_get_heartrate`'s input
validation (the tool's API force-fresh path can't exceed what the API
itself accepts). Daily collections keep their 90-day cap.

Empirical per-endpoint range mapping (so far):

| Endpoint family                                                      | Per-request cap                                   |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| Daily collections (sleep, readiness, activity, …)                    | 90 days                                           |
| Event collections (sleep, workout, session, enhanced_tag, rest_mode) | 90 days                                           |
| **heartrate**                                                        | **30 days**                                       |
| (future) interbeat_interval                                          | unknown — likely 30, given the timeseries pattern |

**Rationale.** The fix is a one-line orchestration change because
`chunkRange` already supports a per-call cap. Tool-side validation
mirrors the API constraint so users don't hit confusing 400s on
force-fresh queries. The empirical mapping table belongs in this log
because future timeseries additions (IBI, ring_battery_level) will
likely need their own caps too — and the OpenAPI spec won't tell us.

---

## 2026-05-11 — Public-launch polish and local-first correctness fixes

**Context.** Pre-publication review found a few issues that would undermine the
project's GitHub launch story: `.env` permissions could remain too broad after
copying from `.env.example`; multi-day annotations only appeared on their start
day in summary joins; `oura_compare_periods` bypassed the local mirror; and
heart-rate auto reads could return empty local results for older unsynced
windows if recent heart-rate data existed. The README also carried stale
version-era details and referenced a not-yet-captured demo GIF.

**Decision.** Tighten `.env` permissions with an explicit chmod, make annotation
date filters and summary joins use span overlap, route period comparisons
through the daily repos, require heart-rate local reads to cover both requested
boundaries before serving from cache, and update README / docs / privacy copy
for public launch. Keep `DECISIONS.md` public because it contains no sensitive
data and helps explain why the project is designed around local-first storage,
read-only Oura API access, and local annotations.

**Rationale.** These changes make the public promise match the actual behavior:
health data stays local, annotations are useful for correlation prompts, and
the README sells the current product instead of narrating every past version.
The demo guidance stays focused on the strongest story — natural-language
context logging followed by recovery analysis — while avoiding accidental
exposure of raw personal data.

---

## 2026-05-19 — Promote observed `tag_sleep_latework` code

**Context.** A real 240-day Oura sync discovered `tag_sleep_latework` as an
enhanced-tag `tag_type_code` that was not in the static seed list. The dynamic
`discovered_tag_types` table already accepted it locally, but fresh installs
would not know the code until after syncing a matching historical tag.

**Decision.** Add `tag_sleep_latework` to `TAG_SLEEP_CODES` and mark it as
observed. Keep the previously inferred `tag_sleep_late_work` entry for now so
any local annotations created with the inferred spelling still validate.

**Rationale.** Observed Oura API data is higher confidence than inferred naming
patterns. Promoting the code improves fresh-install behavior and keeps the
static seed list aligned with real enhanced-tag values while preserving
backward compatibility.

---

## 2026-05-19 — v0.6: voice ingestion via headless Claude Agent

**Context.** v0.6 needed a way to log annotations by voice without
re-implementing extraction logic on-device. The natural fit was to let
Claude do the extraction — same model, same MCP server, same tools as a
normal Claude Code session.

**Decision.** A small Express server on a Mac mini accepts a POSTed
transcript from an iOS Siri Shortcut and spawns a headless Claude Agent
via `@anthropic-ai/claude-agent-sdk`. The agent reuses the project's MCP
server (`dist/index.js`) over stdio and is restricted to a fixed
allowlist of `mcp__oura__*` tools via the SDK's `canUseTool` hook.

**Rationale.** Three things had to be cheap and safe: (1) reusing the
existing annotation tool (no duplicate write path), (2) running without
an Anthropic API key by letting the SDK read the user's Claude Code
subscription credentials from `~/.claude/`, and (3) hard-capping the
agent's blast radius. `canUseTool` gives a clean allowlist without
disabling permissions wholesale (`--dangerously-skip-permissions` was
explicitly avoided). The Shortcut sends both `captured_at` and the
iPhone's current `timezone`, which the system prompt resolves to a local
date/time so phrases like "this morning" still work when traveling.

---

## 2026-05-19 — `voice_logs` table + time-window FK linkage

**Context.** Each voice request can produce zero or many annotations, and
we wanted provenance ("which voice note created this row?") without
parsing every tool result the agent emits.

**Decision.** Added a `voice_logs` table (raw transcript, capture
metadata, agent outcome, duration) and a nullable `annotations.voice_log_id`
FK. After the agent finishes, the server runs a single
`UPDATE annotations SET voice_log_id = ? WHERE voice_log_id IS NULL AND
source = 'local' AND created_at BETWEEN started_at AND finished_at` to
link any rows the agent created during its run.

**Rationale.** Voice runs are sequential per voice_log (the dedupe
window prevents overlap in normal use), so a time-window UPDATE is both
sufficient and order-independent — and far simpler than threading
context through every tool call. `source` stays `'local'` (no new value
to migrate); the FK is what distinguishes voice-extracted rows.

---

## 2026-05-19 — Tailscale + bearer token as the only network boundary

**Context.** The voice server has to be reachable from the iPhone over
the cellular network, but exposing an LLM-backed write endpoint to the
public internet would be reckless.

**Decision.** The server binds `0.0.0.0:8770` but the deployment story
requires Tailscale on both ends and a bearer token (`VOICE_LOG_TOKEN`)
in `Authorization`. No reverse-proxy, no port-forward, no public DNS.
README and `docs/siri-shortcut.md` are explicit about this.

**Rationale.** Tailscale gives identity-bound encrypted transport for
free; the bearer token is defense-in-depth in case another tailnet
device is compromised. Anything fancier (mTLS, OIDC) is overkill for a
single-user setup and would block adoption.
