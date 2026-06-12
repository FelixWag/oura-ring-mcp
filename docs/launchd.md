# Auto-sync every hour with launchd (macOS)

Keep the local SQLite mirror fresh without manual `npm run sync` runs.
launchd is macOS's init system — it runs the job on a fixed interval,
survives reboots, and starts automatically at login.

Hourly incremental sync is cheap: the default re-fetches only the last
7 days per collection (~15–20 API calls per run), far below Oura's rate
limits even at 24 runs/day.

## 1. Create the plist

Save the following as `~/Library/LaunchAgents/com.oura-ring-mcp.sync.plist`,
**adjusting the two paths** (repo location appears three times):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.oura-ring-mcp.sync</string>

  <key>WorkingDirectory</key>
  <string>/Users/you/path/to/oura-ring-mcp</string>

  <!-- IMPORTANT: launchd's login shell (-l) reads ~/.zprofile and
       ~/.zshenv but NOT ~/.zshrc — where nvm and often Homebrew put
       their PATH setup. Prepend your node directory explicitly:
       run `dirname "$(which npm)"` in a normal terminal and put the
       result here in place of /opt/homebrew/bin. -->
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>export PATH="/opt/homebrew/bin:$PATH" &amp;&amp; npm run sync</string>
  </array>

  <!-- Every hour. Also runs once at load/login. -->
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/you/path/to/oura-ring-mcp/logs/sync.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/path/to/oura-ring-mcp/logs/sync.launchd.err.log</string>
</dict>
</plist>
```

## 2. Load it

```bash
launchctl load ~/Library/LaunchAgents/com.oura-ring-mcp.sync.plist

# Verify it's registered (second column is the last exit code, 0 = good):
launchctl list | grep oura

# Watch the first run:
tail -f logs/sync.launchd.log
```

From now on the sync runs hourly and at every login. No terminal needed.

## Managing it

```bash
# Stop:
launchctl unload ~/Library/LaunchAgents/com.oura-ring-mcp.sync.plist

# Trigger a run right now (without waiting for the interval):
launchctl kickstart gui/$(id -u)/com.oura-ring-mcp.sync

# After editing the plist, unload + load again to apply.
```

## Troubleshooting

- **`command not found: npm` in the err.log** — the most common failure.
  launchd's `zsh -lc` is a login shell, which skips `~/.zshrc` — exactly
  where nvm (and sometimes Homebrew) initialize PATH. Fix: run
  `dirname "$(which npm)"` in a normal terminal and prepend that
  directory in the plist's command string (see the template above).
  Note for nvm users: that directory changes when you upgrade Node —
  re-check the plist after `nvm install`.
- **Exit code 78 in `launchctl list`** — usually a malformed plist;
  validate with `plutil -lint <path>`.
- **Job loaded but never fires** — check the plist filename matches the
  `Label` value, and that it lives in `~/Library/LaunchAgents/` (not
  `/Library/LaunchAgents/`, which is system-wide and needs root).

## Notes

- **Re-runs never duplicate data.** Every table upserts on its primary
  key (`day`, `oura_id`, or `(timestamp, source)` for heartrate) — an
  hourly cadence just refreshes the last 7 days in place.
- **Tokens refresh automatically.** The sync uses the same auto-refresh
  OAuth flow as the MCP server; no interaction needed unless Oura
  revokes the grant entirely (then `npm run oauth-login` once).
- **Missed intervals don't pile up.** If the machine was asleep, launchd
  runs the job once on wake, not N times.
- **Log rotation:** the log grows ~1 KB/run. Truncate occasionally
  (`> logs/sync.launchd.log`) or leave it — a year is ~9 MB.
- The same plist pattern works for `npm run voice-server` and
  `npm run health-server` (swap the label, command, and log paths, and
  add `<key>KeepAlive</key><true/>` so crashed servers restart). We'll
  ship those templates when the server surfaces stabilize.
