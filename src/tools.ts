import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { buildRaw, type MailBackend } from "./backend.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
const noCrlf = (s: string) => !/[\r\n]/.test(s);
const header = z.string().refine(noCrlf, "CR/LF not allowed in headers");
const address = z.string().email().refine(noCrlf, "CR/LF not allowed in addresses");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "YYYY-MM-DD");

export function buildServer(cfg: AppConfig, backend: MailBackend): McpServer {
  // Allow the largest valid input (500 UIDs plus fields), while bounding validation work.
  const server = new McpServer({ name: "imap-mcp", version: "0.2.0" }, { maxToolInputElements: 1024 });
  const acctSchema = z.string().describe("Account name from list_accounts");
  const get = (name: string) => {
    const a = cfg.accounts.get(name.toLowerCase());
    if (!a) throw new Error(`Unknown account: ${name}`);
    return a;
  };
  const wrap =
    <A,>(fn: (args: A) => Promise<unknown>) =>
    async (args: A) => {
      try {
        return ok(await fn(args));
      } catch (e) {
        return fail(`Error: ${(e as Error).message}`);
      }
    };

  server.registerTool(
    "list_accounts",
    { description: "List configured mailbox accounts (names and addresses only).", inputSchema: {} },
    wrap(async () => [...cfg.accounts.values()].map((a) => ({ name: a.name, address: a.user }))),
  );

  server.registerTool(
    "list_folders",
    { description: "List IMAP folders for an account.", inputSchema: { account: acctSchema } },
    wrap(async ({ account }: { account: string }) => backend.listFolders(get(account))),
  );

  server.registerTool(
    "list_messages",
    {
      description: "List the newest messages in a folder.",
      inputSchema: {
        account: acctSchema,
        folder: z.string().default("INBOX"),
        limit: z.number().int().min(1).max(200).default(20),
        unread_only: z.boolean().default(false),
      },
    },
    wrap(async (a: { account: string; folder: string; limit: number; unread_only: boolean }) =>
      backend.search(get(a.account), a.folder, { unreadOnly: a.unread_only }, a.limit),
    ),
  );

  server.registerTool(
    "search",
    {
      description: "Search a folder by from, subject, body text and date range (since inclusive, before exclusive).",
      inputSchema: {
        account: acctSchema,
        folder: z.string().default("INBOX"),
        from: z.string().optional(),
        subject: z.string().optional(),
        text: z.string().optional(),
        since: date.optional(),
        before: date.optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    wrap(async (a: any) =>
      backend.search(
        get(a.account),
        a.folder,
        { from: a.from, subject: a.subject, text: a.text, since: a.since, before: a.before },
        a.limit,
      ),
    ),
  );

  server.registerTool(
    "read_message",
    {
      description: "Read one message: headers, plain-text body (size-capped) and attachment names. Does not mark it read.",
      inputSchema: { account: acctSchema, folder: z.string().default("INBOX"), uid: z.number().int().positive() },
    },
    wrap(async (a: { account: string; folder: string; uid: number }) => {
      const m = await backend.read(get(a.account), a.folder, a.uid, cfg.maxBodyChars);
      if (!m) throw new Error(`Message ${a.uid} not found in ${a.folder}`);
      return m;
    }),
  );

  for (const [name, seen] of [["mark_read", true], ["mark_unread", false]] as const) {
    server.registerTool(
      name,
      {
        description: `Mark messages as ${seen ? "read" : "unread"}.`,
        inputSchema: {
          account: acctSchema,
          folder: z.string().default("INBOX"),
          uids: z.array(z.number().int().positive()).min(1).max(500),
        },
      },
      wrap(async (a: { account: string; folder: string; uids: number[] }) => {
        await backend.setSeen(get(a.account), a.folder, a.uids, seen);
        return { updated: a.uids.length, seen };
      }),
    );
  }

  // Sending only exists when SMTP_ENABLED=true.
  if (cfg.smtpEnabled) {
    server.registerTool(
      "send_message",
      {
        description: "Send a plain-text email over SMTP and save a copy to the Sent folder.",
        inputSchema: {
          account: acctSchema,
          to: z.array(address).min(1).max(50),
          cc: z.array(address).max(50).optional(),
          subject: header,
          body: z.string(),
          in_reply_to: header.optional().describe("Message-ID being replied to; sets In-Reply-To and References"),
        },
      },
      wrap(async (a: { account: string; to: string[]; cc?: string[]; subject: string; body: string; in_reply_to?: string }) => {
        const acct = get(a.account);
        if (!acct.smtp) throw new Error(`SMTP not configured for ${acct.name} (set IMAP_${acct.name.toUpperCase()}_SMTP_HOST)`);
        const raw = await buildRaw({ from: acct.user, to: a.to, cc: a.cc, subject: a.subject, body: a.body, inReplyTo: a.in_reply_to });
        const sent = await backend.smtpSend(acct, { from: acct.user, to: [...a.to, ...(a.cc ?? [])] }, raw);
        let sentCopy: { saved: boolean; folder?: string; error?: string };
        try {
          sentCopy = { saved: true, ...(await backend.appendSent(acct, raw)) };
        } catch (e) {
          sentCopy = { saved: false, error: (e as Error).message };
        }
        return { sent: true, messageId: sent.messageId, sentCopy };
      }),
    );
  }
  return server;
}
