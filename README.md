# imap-mcp

A small [MCP](https://modelcontextprotocol.io) server that bridges one or more IMAP mailboxes over **Streamable HTTP**, so AI agents can read, search and triage mail, and optionally send it.

**Read-only by default:** no tool can move or delete mail; `mark_read` / `mark_unread` only touch the `\Seen` flag. Sending is off unless you set `SMTP_ENABLED=true`; when it is off, the `send_message` tool is not registered at all.

## Tools

| Tool | What it does |
|---|---|
| `list_accounts` | Configured account names and addresses (no hosts or passwords) |
| `list_folders` | IMAP folders for an account |
| `list_messages` | Newest messages in a folder (`folder`, `limit`, `unread_only`) |
| `search` | `from`, `subject`, `text`, `since`, `before` (YYYY-MM-DD) |
| `read_message` | Headers, plain-text body (capped at `MAX_BODY_CHARS`), attachment names. Does not mark the message read |
| `mark_read` / `mark_unread` | Set or clear `\Seen` on UIDs |
| `send_message` | **Only when `SMTP_ENABLED=true`.** `account, to[], cc[]?, subject, body, in_reply_to?`. Plain text. `in_reply_to` sets both `In-Reply-To` and `References`. Addresses are validated and CR/LF in any header is rejected. After sending, a copy is APPENDed to the Sent folder (`\Sent` special-use, else `Sent`, or `IMAP_<NAME>_SENT`) |

Message results include `uidValidity` as a decimal string. Pass it with the same account, folder and UID(s) to `read_message`, `mark_read`, and `mark_unread`. If the mailbox UIDVALIDITY changes, these operations reject the stale reference; list or search again before retrying.

## Configuration (env vars only)

| Var | Required | Default | Notes |
|---|---|---|---|
| `MCP_BEARER_TOKEN` | yes | | ≥16 chars. The server refuses to start without it |
| `IMAP_ACCOUNTS` | yes | | Comma-separated names, e.g. `work,personal` |
| `IMAP_<NAME>_HOST` | yes | | e.g. `imap.example.com` |
| `IMAP_<NAME>_USER` | yes | | e.g. `user@example.com` |
| `IMAP_<NAME>_PASS` | yes | | Use an app password |
| `IMAP_<NAME>_PORT` | no | 993 (TLS) / 143 | |
| `IMAP_<NAME>_TLS` | no | `true` | Implicit TLS; `false` requires STARTTLS |
| `IMAP_<NAME>_SMTP_HOST` | for sending | | e.g. `smtp.example.com`. Reuses `IMAP_<NAME>_USER` / `_PASS` |
| `IMAP_<NAME>_SMTP_PORT` | no | `465` | |
| `IMAP_<NAME>_SMTP_TLS` | no | `true` | Implicit TLS; `false` requires STARTTLS (set the SMTP port accordingly) |
| `IMAP_<NAME>_SENT` | no | auto | Sent folder override |
| `SMTP_ENABLED` | no | `false` | Global gate; `send_message` exists only when `true` |
| `PORT` | no | `8787` | |
| `HOST` | no | `0.0.0.0` | Listen address inside the container |
| `MAX_BODY_CHARS` | no | `20000` | Body cap for `read_message` |
| `BIND_IP` | compose only | | Host IP to publish on (e.g. your Tailscale IP) |
| `IMAP_TLS_INSECURE` | no | `false` | Skip TLS cert verification (testing only) |

`<NAME>` is the account name upper-cased. See [`.env.example`](.env.example).

`read_message` rejects messages larger than 1 MiB of raw MIME data, including attachments,
before parsing. It checks the reported size before downloading and enforces the byte cap
during download, independently of `MAX_BODY_CHARS`.

Boolean settings accept `true/false`, `1/0`, `yes/no`, and `on/off` (case-insensitive). Unset or empty values use the default; other values are rejected.

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

The GreenMail smoke tests explicitly use `new ImapBackend({ allowPlaintextForTests: true })` for their plaintext server. This option is rejected unless `NODE_ENV=test`; normal connections always require TLS.

```bash
npm ci
npm test                       # unit tests (mocked IMAP layer)
docker run -d -p 3025:3025 -p 3143:3143 \
  -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=smoke:smoke@example.test -Dgreenmail.users.login=email" \
  greenmail/standalone:2.1.2
GREENMAIL_HOST=localhost npm test   # adds the end-to-end smoke test
```

CI runs both and publishes `ghcr.io/edmundlimboen/imap-mcp:latest` (and `:<sha>`) on pushes to `main`, and `:X.Y.Z` for `vX.Y.Z` tags.

Mail work is bounded per server process: at most 8 operations globally, 2 per
account, and 16 queued operations. Queue wait counts toward a 30-second operation
deadline. The shared bearer principal has fixed-window quotas of 120 HTTP MCP
requests and 10 send attempts per minute, shared across accounts and connections.
At most 24 HTTP MCP requests may be in flight (including body upload), each with
a 30-second deadline. HTTP admission failures return 429 with `Retry-After`;
operation queue/deadline and send-quota failures return MCP tool errors.
Disconnecting cancels unfinished reads and removes queued reads. Mutations keep
their operation deadline so disconnecting does not silently interrupt a send;
a timed-out mutation may have completed remotely and should not be blindly retried.
Limits are process-local; multiple replicas each have their own budget.
