# Voice logging via Siri Shortcut

Talk to Siri, describe your day, and have Claude extract structured
annotations into your local Oura SQLite database. Setup is one-time
(~5 minutes).

## Architecture in one diagram

```
 iPhone                            Mac mini (24/7, on Tailscale)
 ──────                            ──────────────────────────────────
 "Hey Siri, log my day"
   │
   ▼
 Shortcut: Dictate Text
   │
   ▼
 POST  http://<mac-tailscale-ip>:8770/v1/log
       Authorization: Bearer <VOICE_LOG_TOKEN>
       { text, captured_at, timezone, source: "siri" }
   │
   ▼
                                   `npm run voice-server` (Express)
                                     • auth → dedupe → start voice_log
                                     • spawn headless Claude Agent
                                     • Claude calls oura_add_annotation
                                       N times via the MCP server
                                     • append summary line to
                                       `logs/voice.log`
   ▲
   │ 200 OK { ok: true, annotations_logged: 3, claude_summary: "…" }
 Shortcut shows a banner
```

## Prerequisites

1. **Mac mini** (or any always-on Mac/Linux machine) with:
   - Node.js 20+
   - `oura-ring-mcp` installed and synced (you've run `npm run init`)
   - Claude Code installed (`claude` CLI on PATH) and logged in. The
     voice agent uses your subscription credentials from `~/.claude/`.
   - [Tailscale](https://tailscale.com) installed and signed in.
2. **iPhone** with the Shortcuts app and Tailscale installed (same
   tailnet as the Mac mini).

## 1. Generate a shared secret

On the Mac mini:

```bash
openssl rand -hex 32
```

Copy the output. Add it to your `.env`:

```
VOICE_LOG_TOKEN=<paste-here>
```

Keep this token secret — anyone with the token + tailnet access can
write annotations to your DB.

## 2. Start the voice server

```bash
npm run build       # if you haven't already
npm run voice-server
```

You should see:

```
oura-ring-mcp voice server listening on http://0.0.0.0:8770
  log file:  /path/to/oura-ring-mcp/logs/voice.log
  MCP entry: /path/to/oura-ring-mcp/dist/index.js
  tail -f the log file in another tmux pane to watch activity.
```

In another tmux pane, run:

```bash
tail -f logs/voice.log
```

You'll watch each voice note arrive in real time.

## 3. Find your Mac mini's Tailscale IP

On the Mac mini:

```bash
tailscale ip -4
```

Note the address (e.g. `100.x.y.z`).

## 4. Build the iOS Shortcut

Open the **Shortcuts** app on your iPhone → tap **+** to create a new
Shortcut. Add the following actions in order:

| #   | Action                           | Configuration                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Dictate Text**                 | Language: English (or yours). Stop Listening: After Pause.                                                                                                                                                                                                                                                                                                                                                                |
| 2   | **Current Date**                 | (no config) — this becomes `captured_at`                                                                                                                                                                                                                                                                                                                                                                                  |
| 3   | **Get Current Time Zone**        | Return: Name — this becomes `timezone` (e.g. `Europe/Berlin`)                                                                                                                                                                                                                                                                                                                                                             |
| 4   | **Get Contents of URL**          | URL: `http://100.x.y.z:8770/v1/log` (your Tailscale IP) <br/> Method: **POST** <br/> Headers: <br/> `Authorization: Bearer <your-VOICE_LOG_TOKEN>` <br/> `Content-Type: application/json` <br/> Request Body: **JSON** with fields: <br/> `text` → Dictated Text (from step 1) <br/> `captured_at` → Current Date (from step 2), formatted as ISO 8601 <br/> `timezone` → Time Zone (from step 3) <br/> `source` → `siri` |
| 5   | **Get Dictionary Value**         | Get value for key `claude_summary` from previous step                                                                                                                                                                                                                                                                                                                                                                     |
| 6   | **Show Notification** (optional) | Title: `Oura voice log` <br/> Body: Dictionary Value from step 5                                                                                                                                                                                                                                                                                                                                                          |

Save the shortcut as something like **"Log to Oura"**.

> **Tip on the `captured_at` format**: in the **Get Contents of URL**
> action, when you reference the date, tap the variable → choose
> **Format Date** → set to **ISO 8601** (with milliseconds). This
> ensures the server's parser accepts it.

## 5. Wire up Siri

In the Shortcut's settings, set the **Siri phrase** to whatever you
want — e.g. _"Log to Oura"_ or _"Log my day"_. Now:

> 👤 _"Hey Siri, log my day."_
>
> 📱 _"Dictating now…"_
>
> 👤 _"I had two coffees this morning, cycled eleven kilometers, and
> felt tired in the afternoon."_
>
> 📱 _Banner: "Logged 3: tag_generic_coffee, tag_generic_workout, tag_generic_tired"_

In the Mac mini's tmux:

```
2026-05-19T10:32:18.412Z  voice_log=7  ok  3 annotations  "I had two coffees this morning, cycled eleven kilometers, and felt …"
```

## 6. Verify it landed

In your Claude Code session:

```
> List annotations from today, source=local.
```

You should see the three new rows, each with a `voice_log_id` pointing
to the same row in `voice_logs`. Open the SQLite directly if you want:

```bash
sqlite3 ~/.config/oura-ring-mcp/data.sqlite \
  "SELECT id, tag_type_code, start_time, comment FROM annotations
   WHERE voice_log_id = (SELECT MAX(id) FROM voice_logs);"
```

## Troubleshooting

| Symptom                                              | Likely cause                                                                        | Fix                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| iPhone shows "could not get response"                | Mac mini's voice server isn't running OR Tailscale isn't connected on the iPhone    | `npm run voice-server` on the mini; open Tailscale on iPhone                             |
| 401 in the iPhone's response                         | Bearer token mismatch                                                               | Verify `VOICE_LOG_TOKEN` in `.env` matches the Shortcut's `Authorization` header exactly |
| 400 — `captured_at is required`                      | Shortcut isn't formatting the date                                                  | In the URL action, tap the date variable → Format Date → ISO 8601                        |
| Banner says `Logged 0`                               | Voice note had nothing health-relevant, OR Claude couldn't parse it                 | Check `logs/voice.log` for the agent output. Try a more explicit dictation.              |
| Server hangs at startup                              | Claude Code not installed or logged out                                             | Run `claude --version` and `claude` on the mini to verify                                |
| Tools refused with "not allowed in voice extraction" | Claude tried to use a non-Oura tool (shouldn't happen with a correct system prompt) | Open an issue with the voice.log line attached                                           |

## Security notes

- **Token + Tailscale is the security boundary.** Even on Tailscale,
  always require the bearer token — defense-in-depth in case another
  device on your tailnet gets compromised.
- **Don't expose `/v1/log` to the public internet.** Don't port-forward
  the Mac mini. Don't run on a publicly-routable host without an
  additional auth layer (Cloudflare Access, etc.).
- **Rotate the token** periodically (`openssl rand -hex 32`; update
  `.env` and the Shortcut header).
- **The agent's tool surface is restricted** to `oura_add_annotation`
  - read-only `oura_get_*` tools at the Claude Agent SDK layer. Even
    if Claude wanted to run arbitrary code, the SDK would refuse.

## Limits in this version (v0.6)

- **Text in, no reply.** The Shortcut shows the `claude_summary`
  banner; the server doesn't speak back. Voice reply is queued for v0.7.
- **No audio upload.** Siri's built-in dictation transcribes on-device;
  we receive text. Server-side Whisper is a future option.
- **Single user, single tailnet.** No multi-tenant support.
