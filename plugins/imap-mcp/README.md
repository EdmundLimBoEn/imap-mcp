# imap-mcp plugin

Agent Plugin (`plugin.json`, `mcp.json`) and Cursor Plugin (`.cursor-plugin/plugin.json`) for a self-hosted imap-mcp v0.2.0 server over Streamable HTTP.

**Plugin variables:** `IMAP_MCP_URL` (e.g. `http://<host>:8787/mcp`) and `IMAP_MCP_TOKEN` (secret; the server's `MCP_BEARER_TOKEN`). Only `${VAR}` placeholders are committed.

**Not read-only:** `mark_read` / `mark_unread` change `\Seen`. When the server sets `SMTP_ENABLED=true`, `send_message` sends real email as the account owner, which can't be recalled. The bundled skill requires drafting first and explicit user confirmation of the exact recipients and body before sending. Sending is off by default, and the tool isn't registered unless it's enabled.

**Server-side env (not plugin variables):** `IMAP_ACCOUNTS`, `IMAP_<NAME>_HOST`, `IMAP_<NAME>_USER`, `IMAP_<NAME>_PASS`, `IMAP_<NAME>_PORT`, `IMAP_<NAME>_TLS`, `MCP_BEARER_TOKEN`, `SMTP_ENABLED`, `IMAP_<NAME>_SMTP_HOST`, `IMAP_<NAME>_SMTP_PORT`, `IMAP_<NAME>_SMTP_TLS`, `IMAP_<NAME>_SENT`. See the repo README.
