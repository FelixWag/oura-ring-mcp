# Privacy Policy — oura-ring-mcp

This is a personal, open-source [Model Context Protocol](https://modelcontextprotocol.io)
server that runs **locally on your own machine**.

## What data is collected

None by us. The software:

- Reads your Oura Ring data through the official Oura API v2.
- Stores OAuth access and refresh tokens locally at
  `~/.config/oura-ring-mcp/tokens.json` (file permissions `0600`).
- Returns API responses to whichever MCP client you connected (e.g. Claude Code).

## What data is transmitted

- Requests to `api.ouraring.com` over HTTPS, authenticated with your token.
- No data is sent to any other server, analytics provider, or third party.

## What data is retained

- Tokens are kept on your machine until you delete them or revoke the
  application from <https://cloud.ouraring.com/oauth/applications>.

## Your control

- Revoke access at any time from your Oura account settings.
- Delete `~/.config/oura-ring-mcp/tokens.json` to remove all credentials.

## Contact

This is a personal hobby project. Report issues at
<https://github.com/<your-username>/oura-ring-mcp/issues>.
