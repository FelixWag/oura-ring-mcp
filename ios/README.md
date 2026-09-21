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

The Xcode project is generated from `project.yml` by
[XcodeGen](https://github.com/yonaskolb/XcodeGen). It is deliberately **not**
committed: Xcode writes `DEVELOPMENT_TEAM` — a personal Apple Developer
identifier — into the project file as soon as you choose a signing team, and
this repository is public. Xcode 16 or newer, iOS 17 or newer.

```bash
brew install xcodegen      # once
cd ios && xcodegen generate
```

1. Open `ios/HealthBridge.xcodeproj`.
2. **Xcode → Settings → Accounts** → add your Apple ID.
3. Select the **HealthBridge** target → **Signing & Capabilities** → pick your
   team. If Xcode says the bundle identifier is taken, change it to anything
   unique — it only has to be unique to your team.
4. Connect the iPhone by cable, unlock it, tap **Trust**. On iOS 16+ enable
   **Settings → Privacy & Security → Developer Mode** (the phone restarts).
5. Choose the iPhone as the run destination and press **⌘R**.
6. With a free Apple ID, the first launch is blocked until you trust the
   certificate: **Settings → General → VPN & Device Management**.
7. In the app, enter the server URL (`http://<host>:8771`) and your
   `HEALTH_IMPORT_TOKEN`, tap **Sync now**, and allow every Health category.

Health permissions, the HealthKit entitlement with Background Delivery, and
the App Transport Security exception are already set in `project.yml`.

After editing `project.yml`, regenerate with `cd ios && xcodegen generate`
rather than editing the `.xcodeproj` by hand. Your signing team lives only in
your local copy, which is the point.

> **HTTP on a private network.** `project.yml` allows plain HTTP because the
> server is normally reached over a private network such as Tailscale. An App
> Store build should require HTTPS instead (for example via `tailscale serve`)
> and drop `NSAllowsArbitraryLoads`.

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
