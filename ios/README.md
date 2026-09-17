# Health Bridge — iOS companion app

Reads HealthKit and pushes it to your own `oura-ring-mcp` health server. It
exists because **iOS Shortcuts cannot read workouts at all** (`Find Health
Samples` only exposes quantity and category types, and `HKWorkout` is
neither), and because Oura's API never returns sessions recorded with Live
Activity Tracking — so for those, HealthKit is the only route.

What it syncs:

- **Workouts** → `POST /v1/health/workouts` → `external_workouts`
- **Body composition** (weight, body fat, lean mass) and **nutrition**
  → `POST /v1/health/import` → `health_samples`

## Why a native app beats a Shortcut

- **Workouts are reachable.** Shortcuts simply cannot see them.
- **Dedupe becomes exact.** Every HealthKit sample carries a UUID, which the
  app sends as `external_id`. Shortcuts drops it, leaving the server to guess
  from timestamps.
- **Anchored queries.** HealthKit returns only what changed since the last
  sync, so runs are small and re-running is free.
- **It runs itself.** Background delivery wakes the app when new data lands.

## Build it

Xcode 16 or newer, iOS 17 or newer.

1. **New project** → iOS → App. Product name `HealthBridge`, interface
   SwiftUI, language Swift.
2. Delete the generated `ContentView.swift` and `HealthBridgeApp.swift`, then
   drag in the three files from `HealthBridge/` here.
3. **Signing & Capabilities** → select your team → **+ Capability** →
   **HealthKit**, and tick **Background Delivery**.
4. **Info** tab → add:
   - `NSHealthShareUsageDescription` — "Reads your workouts, weight and
     nutrition so they can be saved to your own server."
   - (No write description: the app never writes to HealthKit.)
5. Run on the device. Grant the Health permissions when asked.
6. Enter the server URL (`http://<host>:8771`) and your `HEALTH_IMPORT_TOKEN`,
   then tap **Sync now**.

> **HTTP on a private network.** If the server isn't behind TLS, add an App
> Transport Security exception for that host in Info.plist, or put the server
> behind HTTPS. Don't disable ATS wholesale.

### Signing lifetimes

- **Free Apple ID:** the build stops launching after **7 days**; re-install
  from Xcode to renew.
- **Apple Developer Program ($99/year):** a year per install.

## After a sync

Workout records need resolving into sessions before anything counts them:

```bash
npm run resolve-sessions          # rebuilds resolved_sessions + audits
```

The audit runs automatically and exits non-zero if two counted sessions
overlap — i.e. if something is being double-counted. Watch for the
`new_writer` warning in particular: a newly installed app writing to
HealthKit is the likeliest cause of duplicates appearing later.

## Adding a data type

Add one line to `quantityTypes` in `HealthKitReader.swift` — the identifier,
the `sample_type` string the server should store, and the unit. Nothing on the
server changes: `health_samples` is generic.
