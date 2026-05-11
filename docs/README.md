# docs

Static assets for `oura-ring-mcp`.

## `demo.gif`

The README's hero GIF. Not yet captured — instructions below.

### Capturing tools

- **macOS**: [Kap](https://getkap.co) (`brew install --cask kap`) — free,
  cleanest GIF export.
- **Cross-platform**: [Peek](https://github.com/phw/peek) (Linux),
  [ScreenToGif](https://www.screentogif.com) (Windows).

### Demo script (60–80 seconds, basic → impressive)

The progression matters: hook with a familiar query, then show something
that no other Oura tool can do. **Don't ad-lib** — the GIF needs to feel
crisp.

Set up: open Claude Code at ~1200×800. Make sure only `oura` is in `/mcp`
(temporarily disable other MCP servers). Hide your terminal off-screen.
Wait for each response to fully render before typing the next prompt.

```
1. (BASIC — proves connection)
   Show me my last 7 days of summaries.

2. (BASIC — proves derived metrics)
   Compare this week's sleep to last week.

3. (MEDIUM — proves write + structured storage)
   I had 4 beers Thursday from 6pm to midnight. Log it.

4. (IMPRESSIVE — the killer feature; causal reasoning over local data)
   Did my readiness drop after the alcohol day? Walk me through the recovery curve.

5. (MOST IMPRESSIVE — multi-month analysis with annotation context)
   Across all my alcohol annotations, what's the average drop in next-day readiness?
```

Why this order: **(1) and (2) earn trust** — viewer sees the integration
working. **(3) shows you can talk to the system in natural English** —
this is the moment most people lean in. **(4) is the wow** — causal
reasoning over real biometric data. **(5) closes** with something that
would be 20 minutes of manual SQL or Excel work.

### Export settings

- **Format**: GIF (autoplays in markdown; MP4 doesn't).
- **Length**: 30–60s. If your raw recording is 80s, speed up 2× in Kap.
- **Frame rate**: 15 fps (smaller file, still smooth for text).
- **Resolution**: 1200×800 or smaller. GitHub renders at most 800px wide
  in README; bigger just bloats file size.
- **File size**: under **5 MB**. GitHub embeds inline up to ~10 MB but
  anything over 5 is slow to load on mobile.

### Save it

```bash
mv ~/Downloads/your-recording.gif docs/demo.gif
git add docs/demo.gif
git commit -m "docs: add demo gif"
git push
```

The README already references `docs/demo.gif` — no further edits needed.

### Alternative: static screenshot

If GIF capture is too much friction, a single high-quality screenshot
of prompt #4 above (alcohol → readiness drop) is ~80% as good. Save as
`docs/demo.png` and change the README's `![demo](docs/demo.gif)` line.

### Bonus: a longer MP4 deep-dive

GIFs work for the hero but lose detail. Consider also recording a
**3–5 minute MP4 walkthrough** showing real prompts + responses in
full quality, upload it to YouTube/Vimeo, and link from the README
("▶ Watch a longer walkthrough"). MP4 converts curious viewers who
want more before installing.
