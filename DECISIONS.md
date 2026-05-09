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
