---
name: imap-mail
description: Use when the user asks to check, list, search, read, or mark read/unread email in their IMAP accounts via the imap-mcp server.
---
# IMAP mail

Tools: `list_accounts`, `list_folders`, `list_messages`, `search`, `read_message`, `mark_read`, `mark_unread`.

1. Call `list_accounts` first; never guess account names.
2. `list_messages` / `search` to find UIDs, then `read_message` (uses BODY.PEEK, does not mark read).
3. Report only what the tools return. Never invent messages.

**Not strictly read-only:** `mark_read` / `mark_unread` set or clear the IMAP `\Seen` flag on the server. Only call them when the user asks. Nothing can send, draft, move or delete mail.

## Configuration
IMAP credentials live only in the server's env (`IMAP_ACCOUNTS`, `IMAP_<NAME>_HOST`, `IMAP_<NAME>_USER`, `IMAP_<NAME>_PASS`, optional `_PORT`/`_TLS`, plus `MCP_BEARER_TOKEN`); see the repo README and `.env.example`. The plugin needs only `IMAP_MCP_URL` and `IMAP_MCP_TOKEN`. The server has no stdio mode, so to run it locally start it (Docker or `npm start`) and point `IMAP_MCP_URL` at `http://127.0.0.1:8787/mcp`.
