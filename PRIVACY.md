# Privacy Policy — oura-ring-mcp

This is a personal, open-source [Model Context Protocol](https://modelcontextprotocol.io)
server that runs **locally on your own machine**.

## What data is collected

None by us. The software:

- Reads your Oura Ring data through the official Oura API v2.
- Stores OAuth access and refresh tokens locally at
  `~/.config/oura-ring-mcp/tokens.json` (file permissions `0600`).
- Stores annotations you add (illness, alcohol, travel, etc.) in a local
  SQLite database at `~/.config/oura-ring-mcp/data.sqlite` (file
  permissions `0600`).
- From v0.4 onward, when you run `npm run sync` (or call the `oura_sync`
  MCP tool), mirrors your daily Oura data (sleep, readiness, activity, spo2,
  sleep periods, workouts, sessions, enhanced tags) into the same local
  SQLite database. This data lives only on your machine.
- Returns API responses, annotations, and locally-mirrored data to whichever
  MCP client you connected (e.g. Claude Code).

## What data is transmitted

- Requests to `api.ouraring.com` over HTTPS, authenticated with your token.
- No data is sent to any other server, analytics provider, or third party.
- Annotations and locally-mirrored Oura data are **never** transmitted
  anywhere by this software.

## What data is retained

- Tokens are kept on your machine until you delete them or revoke the
  application from <https://cloud.ouraring.com/oauth/applications>.
- Annotations and locally-mirrored Oura data are kept in the local SQLite
  database until you delete them through the MCP tools or remove the
  database file.

## Your control

- Revoke access at any time from your Oura account settings.
- Delete `~/.config/oura-ring-mcp/tokens.json` to remove all credentials.
- Delete `~/.config/oura-ring-mcp/data.sqlite` to remove all annotations
  and mirrored Oura data.

## Contact

This is a personal hobby project. Report issues at
<https://github.com/FelixWag/oura-ring-mcp/issues>.
