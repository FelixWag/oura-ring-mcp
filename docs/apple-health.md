# Apple Health import via iOS Shortcut

Bridge HealthKit data (nutrition, steps, weight, anything else iOS apps
write to Apple Health) into your local SQLite mirror. v0.7+.

## Architecture in one diagram

```
 iPhone (HealthKit)                  Mac mini (24/7, on Tailscale)
 ──────────────────                  ──────────────────────────────────
 Apps that write to Health:
   SnapCalorie, Cronometer,
   MyFitnessPal, Apple Watch, …
   │
   ▼
 Shortcut: Find Health Samples
   │  (scheduled by Personal Automation,
   │   or run on demand)
   ▼
 POST  http://<mac-tailscale-ip>:8771/v1/health/import
       Authorization: Bearer <HEALTH_IMPORT_TOKEN>
       body: [ { sample_type, value, unit, start_time, end_time,
                 source_name }, … ]
   │
   ▼
                                   `npm run health-server` (Express)
                                     • auth → normalize → validate
                                     • INSERT OR IGNORE into health_samples
                                     • append summary to logs/health.log
   ▲
   │ 200 OK { ok, total_received, inserted, deduped, duration_ms }
 Shortcut Quick Look (optional)
```

The endpoint runs as a separate process on its own port (`:8771`) so
voice ingestion (`:8770`) and health import don't share a blast radius —
restart one without disturbing the other, rotate tokens independently.

## Prerequisites

- v0.7+ of `oura-ring-mcp` on the Mac mini.
- Tailscale signed into the same tailnet on the Mac mini and the iPhone.
- An iOS app that writes nutrition (or any other type) to Apple Health.
  Tested examples: **SnapCalorie**, **Cronometer**, **MyFitnessPal**.
  Open the iOS **Health** app → **Browse** → **Nutrition** to confirm
  you have data before building the Shortcut.

## 1. Generate the token

On the Mac mini:

```bash
openssl rand -hex 32
```

Copy the output. Add it to your `.env`:

```
HEALTH_IMPORT_TOKEN=<paste-here>
```

This is distinct from `VOICE_LOG_TOKEN` so you can rotate them
independently. Keep it secret — anyone with the token + tailnet access
can write samples into your DB.

## 2. Start the health server

```bash
npm run build
npm run health-server
```

You should see:

```
oura-ring-mcp health server listening on http://0.0.0.0:8771
  log file:  /path/to/oura-ring-mcp/logs/health.log
  endpoint:  POST /v1/health/import  (Authorization: Bearer <HEALTH_IMPORT_TOKEN>)
```

Smoke-test from the same mini:

```bash
TOKEN=$(grep ^HEALTH_IMPORT_TOKEN .env | cut -d= -f2-)
curl -i -X POST http://127.0.0.1:8771/v1/health/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{"sample_type":"dietary_energy_consumed","value":"447.0515","unit":"kcal","start_time":"2026-06-08T13:23:59+01:00","end_time":"2026-06-08T13:23:59+01:00","source_name":"curl"}]'
```

Expect `200 OK` with `{ ok: true, inserted: 1, deduped: 0 }`.

## 3. Find your Mac mini's Tailscale IP

Look at the Tailscale menu bar app on the mini, or run `tailscale ip -4`
if you've enabled the CLI. Note the `100.x.y.z` address.

## 4. Build the iOS Shortcut

Open **Shortcuts** → **+** → New Shortcut. Add these actions in order.
This is the configuration verified end-to-end against a real
SnapCalorie batch on iOS 18; if your iOS version produces a different
on-the-wire shape, the server's payload parser is forgiving — see
"Accepted body shapes" near the bottom.

| #   | Action                            | Configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Find Health Samples Where**     | Sample Type: **Dietary Energy** (start narrow; you can extend to other macros later). Sort by: Start Date. Order: Latest First. Limit: 100 (or whatever covers the batch interval you want).                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | **Repeat with Each**              | Items: the **Health Samples** from step 1. Step 2a lives inside.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2a  | **Dictionary** (inside loop)      | Add six fields, all type **Text**: <br/> • `sample_type` → type the literal string `dietary_energy_consumed` <br/> • `value` → **Repeat Item** → Get Details of Health Sample → **Value** <br/> • `unit` → **Repeat Item** → Get Details → **Unit** <br/> • `start_time` → **Repeat Item** → Get Details → **Start Date** → Format Date → **ISO 8601**. **Toggle "Include ISO 8601 Time" ON** — without it you only get the date portion and every meal collapses to midnight. <br/> • `end_time` → same as `start_time` but pick **End Date** <br/> • `source_name` → **Repeat Item** → Get Details → **Source**                        |
| 2b  | (end of loop body)                | The Dictionary must be the LAST action inside Repeat. Do NOT use "Add to Variable" inside the loop — it concatenates as text and breaks list serialization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 3   | (auto) **End Repeat**             | Inserted automatically. Exposes a magic variable called **Repeat Results** containing the list of all per-iteration Dictionaries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 4   | **Dictionary** (after End Repeat) | One field: <br/> • Key: `samples` <br/> • Type: **Array** (tap the type indicator on the left, default Text → switch to Array) <br/> • Value: the **Repeat Results** magic variable                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5   | **Get Contents of URL**           | URL: `http://100.x.y.z:8771/v1/health/import` (your Tailscale IP) <br/> Method: **POST** <br/> Headers: `Authorization: Bearer <HEALTH_IMPORT_TOKEN>` and `Content-Type: application/json` <br/> Request Body: **File** — pick the **Dictionary** from step 4 as the file. <br/> _Why File and not JSON_: JSON body type re-serializes the variable through Apple's encoder, which collapses or stringifies lists-of-dictionaries inconsistently across iOS versions. File body sends the Dictionary's raw JSON bytes, which preserves the array structure. The server's parser handles the resulting `{samples: [...]}` shape verbatim. |
| 6   | **Quick Look** (optional)         | Input: Contents of URL. Shows the server's `{total_received, inserted, deduped}` response inline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Save as **"Import to Oura DB"** or similar.

> **The "Include ISO 8601 Time" toggle is easy to miss.** In the Format
> Date sub-action, picking ISO 8601 as the format gives you only the date
> portion (`2026-06-10`) by default. The toggle labeled **Include ISO
> 8601 Time** sits below the format picker; flip it ON and you get a
> full timestamp like `2026-06-10T09:36:31+01:00`. Without the time,
> every sample collapses to midnight and the dedup key (which includes
> the timestamp) starts colliding across same-day rows.

## 5. Schedule it

In Shortcuts, switch to the **Automation** tab → **+** → **New Automation**:

- Trigger: **Time of Day** → e.g. 23:30 daily
- Action: **Run Shortcut** → pick the one you just built
- **Run Immediately**: ON (skip the "tap to confirm" prompt)

The phone will now POST a fresh batch to the mini every night. Re-imports
are idempotent — running it more often produces duplicates that the server
silently skips (`deduped` count in the response).

## 6. Verify it landed

In a Claude Code session connected to the MCP server:

```text
> Show me my dietary energy samples from the last 24 hours.
```

Or directly via SQLite:

```bash
sqlite3 ~/.config/oura-ring-mcp/data.sqlite \
  "SELECT start_time, value, unit, source_name FROM health_samples
    WHERE sample_type = 'dietary_energy_consumed'
    ORDER BY start_time DESC LIMIT 10;"
```

## Adding more sample types

For each additional type you want (protein, carbs, steps, weight, etc.),
duplicate the Repeat block in your Shortcut and change:

- Step 1's **Sample Type** dropdown to the new type (e.g. Dietary Protein)
- Step 2a's `sample_type` literal to the matching snake_case string
  (e.g. `dietary_protein`)

Build all the dictionaries first, then concatenate them with a `Combine`
action and pass the combined list as the request body. Or fire one
request per type — the dedup key includes `sample_type`, so they won't
collide.

Suggested snake_case mappings (use whatever you like; the server doesn't
care, only your queries do):

- Dietary Energy → `dietary_energy_consumed`
- Dietary Protein → `dietary_protein`
- Dietary Carbohydrates → `dietary_carbohydrates`
- Dietary Fat Total → `dietary_fat_total`
- Dietary Water → `dietary_water`
- Steps → `steps`
- Body Mass → `body_mass`
- Active Energy Burned → `active_energy_burned`

## Accepted body shapes

The endpoint is intentionally forgiving about how the array of samples
is wrapped, because iOS Shortcuts serializes lists-of-dictionaries
differently depending on the body type, the variable type, and the iOS
version. All of the following normalize to the same flat array of
samples server-side:

1. Top-level JSON array of sample dicts:
   `[{sample_type, value, ...}, {...}, ...]`
2. Object wrapping an array of dicts:
   `{"samples": [{sample_type, ...}, {...}]}`
3. Object wrapping an array containing NDJSON strings (this is what the
   Dictionary+Array+File approach above produces):
   `{"samples": ["{...}\n{...}\n{...}"]}`
4. Object wrapping a single NDJSON string:
   `{"samples": "{...}\n{...}\n..."}`
5. A single sample dict — wrapped server-side as a one-element list.

The recommended Shortcut configuration produces shape #3. If you hit a
shape this list doesn't cover, the server returns 400 with a clear
error message — usually enough to either fix the Shortcut or add a new
case to `normalizePayload` in `src/health/server.ts`.

## Troubleshooting

| Symptom                                       | Likely cause                                                       | Fix                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `401 unauthorized`                            | `HEALTH_IMPORT_TOKEN` mismatch                                     | Verify `.env` value matches the Shortcut's Authorization header byte-for-byte. Restart server after editing `.env`.  |
| `400 — no samples in payload`                 | Find Health Samples returned empty                                 | Confirm you have data in iOS Health → Browse → Nutrition. Widen the date range in the Shortcut.                      |
| `400 — one or more samples failed validation` | A field is missing or malformed                                    | Check the `details` array in the response — each entry has the index and the specific error.                         |
| `count: 1` when you expected many             | iOS sent only the last iteration                                   | "Add to Variable" inside Repeat collapses dicts to text. Remove it and point the body at **Repeat Results** instead. |
| Request times out from iPhone                 | Tailscale disconnected on the iPhone, OR health server not running | Open Tailscale on iPhone → confirm green. `lsof -i :8771` on mini.                                                   |
| Same rows reappear with each run              | Working as designed — `INSERT OR IGNORE` makes re-imports safe     | The `deduped` count in the response shows how many were skipped.                                                     |

## Why iOS Shortcuts and not Health Auto Export?

Both work. Shortcuts is free and lives on your iPhone; Health Auto Export
is a paid iOS app that handles scheduling, retry, and field richness more
robustly. The server accepts the same payload shapes either way — pick
whichever feels right for your tolerance for iOS quirks.

## Security notes

- **Token + Tailscale is the security boundary.** Bearer token required
  on every request; the server binds `0.0.0.0` but only Tailscale peers
  can reach `:8771` in practice.
- **Don't expose `:8771` to the public internet.** No port-forward, no
  public DNS.
- **Rotate the token periodically** (`openssl rand -hex 32`; update
  `.env`, the Shortcut, and any other clients).
- **The DB is the only thing the endpoint writes.** No shell execution,
  no filesystem reads beyond the configured log path.
