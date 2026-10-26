import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { buildRaw, isValidSearchDate, validateSearchDates, UidValidityError, type MailBackend } from "./backend.js";

import { RequestLimits, ResourceLimitError, operationContext } from "./limits.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
const noCrlf = (s: string) => !/[\r\n]/.test(s);
const header = z.string().refine(noCrlf, "CR/LF not allowed in headers");
const address = z.string().email().refine(noCrlf, "CR/LF not allowed in addresses");
const uidValidity = z.string().regex(/^[1-9][0-9]{0,9}$/)
  .refine((value) => Number(value) <= 4294967295, "UIDVALIDITY must be a nonzero 32-bit value")
  .describe("Mailbox UIDVALIDITY string returned by list_messages or search; required to reject stale UIDs");
const date = z.string().refine(isValidSearchDate, "Calendar-valid YYYY-MM-DD required");

export function buildServer(cfg: AppConfig, backend: MailBackend, limits = new RequestLimits(), requestSignal?: AbortSignal): McpServer {
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
    async (args: A, extra: { signal: AbortSignal }) => {
      try {
        const account = (args as { account?: string }).account?.toLowerCase() ?? "";
        const signal = requestSignal ? AbortSignal.any([requestSignal, extra.signal]) : extra.signal;
        return ok(await limits.run(account, signal, () => fn(args)));
      } catch (e) {
        // Preserve fixed command-refusal messages without exposing protocol details.
        // Stale-reference and quota refusals carry fixed backend-authored text the caller must act on.
        if (e instanceof UidValidityError || e instanceof ResourceLimitError || (e instanceof Error && (e.message === "IMAP search failed" || e.message === "IMAP flag update failed"))) {
          return fail(`Error: ${e.message}`);
        }
        return fail("backend_error");
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
    wrap(async (a: any) => {
      validateSearchDates(a);
      return backend.search(
        get(a.account),
        a.folder,
        { from: a.from, subject: a.subject, text: a.text, since: a.since, before: a.before },
        a.limit,
      );
    }),
  );

  server.registerTool(
    "read_message",
    {
      description: "Read one message: headers, plain-text body (size-capped) and attachment names. Does not mark it read.",
      inputSchema: { account: acctSchema, folder: z.string().default("INBOX"), uid: z.number().int().positive(), uidValidity },
    },
    wrap(async (a: { account: string; folder: string; uid: number; uidValidity: string }) => {
      const m = await backend.read(get(a.account), a.folder, a.uid, a.uidValidity, cfg.maxBodyChars);
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
          uidValidity,
          uids: z.array(z.number().int().positive()).min(1).max(500),
        },
      },
      wrap(async (a: { account: string; folder: string; uids: number[]; uidValidity: string }) => {
        await backend.setSeen(get(a.account), a.folder, a.uids, a.uidValidity, seen);
        // IMAP acknowledges the command but does not verify a changed-message count.
        return { requested: a.uids.length, seen };
      }),
    );
  }

  // Sending only exists when SMTP_ENABLED=true.
  if (cfg.smtpEnabled) {
    server.registerTool(
      "send_message",
      {
        description: "Submit a plain-text email over SMTP and save a copy to Sent. Check status and recipient outcomes; retry only retryable recipients after temporary failures, never accepted recipients.",
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
        limits.quota(true);
        const acct = get(a.account);
        if (!acct.smtp) throw new Error(`SMTP not configured for ${acct.name} (set IMAP_${acct.name.toUpperCase()}_SMTP_HOST)`);
        const raw = await buildRaw({ from: acct.user, to: a.to, cc: a.cc, subject: a.subject, body: a.body, inReplyTo: a.in_reply_to });
        operationContext.getStore()?.throwIfAborted();
        const sent = await backend.smtpSend(acct, { from: acct.user, to: [...a.to, ...(a.cc ?? [])] }, raw);
        const status = sent.accepted.length === 0 ? "rejected"
          : sent.rejected.length > 0 ? "partial_submission" : "submitted";
        const retryable = sent.rejectionDetails
          .filter((d) => d.responseCode !== undefined && d.responseCode >= 400 && d.responseCode < 500)
          .map((d) => d.recipient);
        let sentCopy: { saved: boolean; folder?: string; error?: string } = { saved: false };
        if (sent.accepted.length > 0) {
          try {
            operationContext.getStore()?.throwIfAborted();
            sentCopy = { saved: true, ...(await backend.appendSent(acct, raw)) };
          } catch (e) {
            sentCopy = { saved: false, error: (e as Error).message };
          }
        }
        return { ...sent, sent: status === "submitted", status, retryable, sentCopy };
      }),
    );
  }
  return server;
}
