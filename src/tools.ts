import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { MailBackend } from "./backend.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "YYYY-MM-DD");

export function buildServer(cfg: AppConfig, backend: MailBackend): McpServer {
  const server = new McpServer({ name: "imap-mcp", version: "0.1.0" });
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

  const draftShape = {
    account: acctSchema,
    to: z.array(z.string().email()).min(1),
    cc: z.array(z.string().email()).optional(),
    subject: z.string(),
    text: z.string(),
    in_reply_to: z.string().optional().describe("Message-ID being replied to"),
  };

  server.registerTool(
    "create_draft",
    {
      description: "Save a plain-text draft to the account's Drafts folder via IMAP APPEND. Never sends.",
      inputSchema: draftShape,
    },
    wrap(async (a: any) => {
      const acct = get(a.account);
      const r = await backend.appendDraft(acct, acct.user, {
        to: a.to, cc: a.cc, subject: a.subject, text: a.text, inReplyTo: a.in_reply_to,
      });
      return { saved: true, sent: false, ...r };
    }),
  );

  // Real sending only exists when explicitly enabled.
  if (cfg.enableSmtpSend) {
    server.registerTool(
      "send_message",
      { description: "Send an email over SMTP (enabled by ENABLE_SMTP_SEND=true).", inputSchema: draftShape },
      wrap(async (a: any) => {
        const acct = get(a.account);
        if (!acct.smtp) throw new Error(`SMTP not configured for ${acct.name}`);
        const { createTransport } = await import("nodemailer");
        const t = createTransport({
          host: acct.smtp.host, port: acct.smtp.port, secure: acct.smtp.tls,
          auth: { user: acct.smtp.user, pass: acct.smtp.pass },
        });
        const info = await t.sendMail({
          from: acct.user, to: a.to, cc: a.cc, subject: a.subject, text: a.text,
          inReplyTo: a.in_reply_to, references: a.in_reply_to,
        });
        return { sent: true, messageId: info.messageId };
      }),
    );
  }
  return server;
}
