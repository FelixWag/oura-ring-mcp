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
