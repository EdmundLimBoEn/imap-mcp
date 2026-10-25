import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { AccountConfig } from "./config.js";

export interface MessageSummary {
  uid: number;
  date?: string;
  from?: string;
  subject?: string;
  seen: boolean;
}
export interface FullMessage extends MessageSummary {
  to?: string;
  cc?: string;
  messageId?: string;
  body: string;
  truncated: boolean;
  attachments: { filename: string; contentType: string; size: number }[];
}
export interface OutgoingMessage {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
}

export function buildRaw(m: OutgoingMessage): Promise<Buffer> {
  return new MailComposer({
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    text: m.body,
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo, references: m.inReplyTo } : {}),
  })
    .compile()
    .build();
}

export interface SearchQuery {
  from?: string;
  subject?: string;
  text?: string;
  since?: string;
  before?: string;
  unreadOnly?: boolean;
}

/** Read-only mail layer (plus \\Seen flag changes), mocked in unit tests. */
export interface MailBackend {
  listFolders(acct: AccountConfig): Promise<{ path: string; specialUse?: string }[]>;
  search(acct: AccountConfig, folder: string, q: SearchQuery, limit: number): Promise<MessageSummary[]>;
  read(acct: AccountConfig, folder: string, uid: number, maxChars: number): Promise<FullMessage | null>;
  setSeen(acct: AccountConfig, folder: string, uids: number[], seen: boolean): Promise<void>;
  /** SMTP submit of a pre-built RFC 822 message. */
  smtpSend(acct: AccountConfig, envelope: { from: string; to: string[] }, raw: Buffer): Promise<{ messageId?: string }>;
  /** IMAP APPEND a copy to the Sent folder. */
  appendSent(acct: AccountConfig, raw: Buffer): Promise<{ folder: string }>;
}

export function isValidSearchDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateSearchDates(q: SearchQuery): void {
  for (const value of [q.since, q.before]) {
    if (value !== undefined && !isValidSearchDate(value)) {
      throw new Error("Search dates must be calendar-valid YYYY-MM-DD values");
    }
  }
  if (q.since !== undefined && q.before !== undefined && q.since > q.before) {
    throw new Error("since must be on or before before");
  }
}

export function toSearchObject(q: SearchQuery): SearchObject {
  validateSearchDates(q);
  const s: SearchObject = {};
  if (q.from) s.from = q.from;
  if (q.subject) s.subject = q.subject;
  if (q.text) s.body = q.text;
  if (q.since) s.since = new Date(q.since);
  if (q.before) s.before = new Date(q.before);
  if (q.unreadOnly) s.seen = false;
  if (Object.keys(s).length === 0) s.all = true;
  return s;
}

export class ImapBackend implements MailBackend {
  private async withClient<T>(acct: AccountConfig, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const c = new ImapFlow({
      host: acct.host,
      port: acct.port,
      secure: acct.tls,
      auth: { user: acct.user, pass: acct.pass },
      logger: false,
      tls: { rejectUnauthorized: process.env.IMAP_TLS_INSECURE !== "true" },
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try { c.close(); } catch { /* Cleanup must not expose protocol errors. */ }
    };
    const failure = new Error("IMAP operation failed");
    const connectionError = new Promise<never>((_resolve, reject) => {
      // Keep the listener for late socket errors, including those during close.
      c.on("error", () => {
        reject(failure);
        close();
      });
    });
    try {
      return await Promise.race([
        connectionError,
        (async () => {
          await c.connect();
          if (closed) throw failure;
          const result = await fn(c);
          if (closed) throw failure;
          await c.logout().catch(close);
          return result;
        })(),
      ]);
    } catch {
      close();
      throw failure;
    }
  }

  listFolders(acct: AccountConfig) {
    return this.withClient(acct, async (c) =>
      (await c.list()).map((m) => ({ path: m.path, specialUse: m.specialUse || undefined })),
    );
  }

  search(acct: AccountConfig, folder: string, q: SearchQuery, limit: number) {
    return this.withClient(acct, async (c) => {
      const lock = await c.getMailboxLock(folder, { readOnly: true });
      try {
        const uids = await c.search(toSearchObject(q), { uid: true });
        if (!uids) throw new Error("IMAP search failed");
        const pick = uids.sort((a, b) => b - a).slice(0, limit);
        if (pick.length === 0) return [];
        const out: MessageSummary[] = [];
        for await (const m of c.fetch(pick, { uid: true, envelope: true, flags: true }, { uid: true })) {
          const f = m.envelope?.from?.[0];
          out.push({
            uid: m.uid,
            date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : undefined,
            from: f ? (f.name ? `${f.name} <${f.address}>` : f.address) : undefined,
            subject: m.envelope?.subject,
            seen: m.flags?.has("\\Seen") ?? false,
          });
        }
        return out.sort((a, b) => b.uid - a.uid);
      } finally {
        lock.release();
      }
    });
  }

  read(acct: AccountConfig, folder: string, uid: number, maxChars: number) {
    return this.withClient(acct, async (c) => {
      const lock = await c.getMailboxLock(folder, { readOnly: true });
      try {
        // BODY.PEEK: reading does not set \Seen.
        const m = await c.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
        if (!m || !m.source) return null;
        const p = await simpleParser(m.source);
        const text = p.text ?? "";
        const addr = (a: any) => (a ? (Array.isArray(a) ? a.map((x) => x.text).join(", ") : a.text) : undefined);
        return {
          uid,
          date: p.date?.toISOString(),
          from: addr(p.from),
          to: addr(p.to),
          cc: addr(p.cc),
          subject: p.subject,
          messageId: p.messageId,
          seen: m.flags?.has("\\Seen") ?? false,
          body: text.slice(0, maxChars),
          truncated: text.length > maxChars,
          attachments: p.attachments.map((a) => ({
            filename: a.filename ?? "(unnamed)",
            contentType: a.contentType,
            size: a.size,
          })),
        };
      } finally {
        lock.release();
      }
    });
  }

  setSeen(acct: AccountConfig, folder: string, uids: number[], seen: boolean) {
    return this.withClient(acct, async (c) => {
      const lock = await c.getMailboxLock(folder);
      try {
        const success = seen
          ? await c.messageFlagsAdd(uids, ["\\Seen"], { uid: true })
          : await c.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
        if (!success) throw new Error("IMAP flag update failed");
      } finally {
        lock.release();
      }
    });
  }


  async smtpSend(acct: AccountConfig, envelope: { from: string; to: string[] }, raw: Buffer) {
    if (!acct.smtp) throw new Error(`SMTP not configured for ${acct.name}`);
    const t = createTransport({
      host: acct.smtp.host,
      port: acct.smtp.port,
      secure: acct.smtp.tls,
      auth: { user: acct.user, pass: acct.pass },
      tls: { rejectUnauthorized: process.env.IMAP_TLS_INSECURE !== "true" },
    });
    try {
      const info = await t.sendMail({ envelope, raw });
      return { messageId: info.messageId };
    } finally {
      t.close();
    }
  }

  appendSent(acct: AccountConfig, raw: Buffer) {
    return this.withClient(acct, async (c) => {
      const list = await c.list();
      const folder = acct.sentFolder ?? list.find((m) => m.specialUse === "\\Sent")?.path ?? "Sent";
      if (!list.some((m) => m.path === folder)) await c.mailboxCreate(folder);
      await c.append(folder, raw, ["\\Seen"]);
      return { folder };
    });
  }
}
