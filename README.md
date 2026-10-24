# imap-mcp

A small [MCP](https://modelcontextprotocol.io) server that bridges one or more IMAP mailboxes over **Streamable HTTP**, so AI agents can read, search and triage mail and save drafts.

**Safe by default:** no tool can send mail. `create_draft` only does an IMAP `APPEND` to the Drafts folder. A `send_message` tool exists only when `ENABLE_SMTP_SEND=true`.

## Tools

| Tool | What it does |
|---|---|
| `list_accounts` | Configured account names and addresses (no hosts or passwords) |
| `list_folders` | IMAP folders for an account |
| `list_messages` | Newest messages in a folder (`folder`, `limit`, `unread_only`) |
| `search` | `from`, `subject`, `text`, `since`, `before` (YYYY-MM-DD) |
| `read_message` | Headers, plain-text body (capped at `MAX_BODY_CHARS`), attachment names. Does not mark the message read |
| `mark_read` / `mark_unread` | Set or clear `\Seen` on UIDs |
| `create_draft` | Save a plain-text draft to Drafts via IMAP APPEND. Never sends |
| `send_message` | **Only when `ENABLE_SMTP_SEND=true`**: sends over SMTP |

## Configuration (env vars only)

| Var | Required | Default | Notes |
|---|---|---|---|
| `MCP_BEARER_TOKEN` | yes | | ≥16 chars. The server refuses to start without it |
| `IMAP_ACCOUNTS` | yes | | Comma-separated names, e.g. `work,personal` |
| `IMAP_<NAME>_HOST` | yes | | e.g. `imap.example.com` |
| `IMAP_<NAME>_USER` | yes | | e.g. `user@example.com` |
| `IMAP_<NAME>_PASS` | yes | | Use an app password |
| `IMAP_<NAME>_PORT` | no | 993 (TLS) / 143 | |
| `IMAP_<NAME>_TLS` | no | `true` | Implicit TLS |
| `IMAP_<NAME>_DRAFTS` | no | `Drafts` | Used if the server has no `\Drafts` special-use folder |
| `PORT` | no | `8787` | |
| `HOST` | no | `0.0.0.0` | Listen address inside the container |
| `MAX_BODY_CHARS` | no | `20000` | Body cap for `read_message` |
| `ENABLE_SMTP_SEND` | no | `false` | Registers `send_message` when `true` |
| `SMTP_<NAME>_HOST` / `_PORT` / `_TLS` / `_USER` / `_PASS` | no | 465, TLS, IMAP creds | Only read when sending is enabled |
| `BIND_IP` | compose only | | Host IP to publish on (e.g. your Tailscale IP) |
| `IMAP_TLS_INSECURE` | no | `false` | Skip TLS cert verification (testing only) |

`<NAME>` is the account name upper-cased. See [`.env.example`](.env.example).

## Run

```bash
cp .env.example .env   # fill in real values; .env is git-ignored
docker run -d --name imap-mcp --restart unless-stopped \
  --env-file .env -p "$BIND_IP:8787:8787" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/edmundlimboen/imap-mcp:latest
```

Or `docker compose up -d` (binds to `${BIND_IP}:8787`). Or locally: `npm ci && npm run build && npm start`.

Check: `curl http://$BIND_IP:8787/health` → `{"ok":true}`.

## Add as an MCP connector

- **URL:** `http://<BIND_IP>:8787/mcp`
- **Transport:** Streamable HTTP
- **Header:** `Authorization: Bearer <MCP_BEARER_TOKEN>`

Example client config:

```json
{
  "mcpServers": {
    "imap": {
      "url": "http://<BIND_IP>:8787/mcp",
      "headers": { "Authorization": "Bearer <MCP_BEARER_TOKEN>" }
    }
  }
}
```

## Security

- Every request except `GET /health` needs the bearer token; compared in constant time (SHA-256 + `timingSafeEqual`).
- `/health` returns only `{"ok":true}`.
- The server is stateless: each POST to `/mcp` opens a fresh IMAP connection per tool call.
- Expose it only on a private network (e.g. Tailscale). It has no TLS of its own.
- Container runs as the non-root `node` user.

## Development

```bash
npm ci
npm test                       # unit tests (mocked IMAP layer)
docker run -d -p 3025:3025 -p 3143:3143 \
  -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" \
  greenmail/standalone:2.1.2
GREENMAIL_HOST=localhost npm test   # adds the end-to-end smoke test
```

CI runs both and publishes `ghcr.io/edmundlimboen/imap-mcp:latest` on pushes to `main`.
