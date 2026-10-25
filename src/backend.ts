import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { AccountConfig } from "./config.js";

export interface MessageSummary {
  uid: number;
  uidValidity: string;
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
  read(acct: AccountConfig, folder: string, uid: number, uidValidity: string, maxChars: number): Promise<FullMessage | null>;
  setSeen(acct: AccountConfig, folder: string, uids: number[], uidValidity: string, seen: boolean): Promise<void>;
  /** SMTP submit of a pre-built RFC 822 message. */
  smtpSend(acct: AccountConfig, envelope: { from: string; to: string[] }, raw: Buffer): Promise<{ messageId?: string }>;
  /** IMAP APPEND a copy to the Sent folder. */
  appendSent(acct: AccountConfig, raw: Buffer): Promise<{ folder: string }>;
}

export function toSearchObject(q: SearchQuery): SearchObject {
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

// ImapFlow exposes UIDVALIDITY as bigint; use a decimal string on the JSON boundary.
function mailboxUidValidity(c: ImapFlow): string {
  const value = c.mailbox && c.mailbox.uidValidity;
  if (!value || value < 1n || value > 4294967295n) {
    throw new Error("Mailbox UIDVALIDITY unavailable");
  }
  return value.toString();
}

function requireUidValidity(c: ImapFlow, expected: string): void {
  if (mailboxUidValidity(c) !== expected) {
    throw new Error("Stale message reference: UIDVALIDITY changed; list or search messages again");
  }
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
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.logout().catch(() => c.close());
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
        const uidValidity = mailboxUidValidity(c);
        const uids = (await c.search(toSearchObject(q), { uid: true })) || [];
        const pick = uids.sort((a, b) => b - a).slice(0, limit);
        if (pick.length === 0) return [];
        const out: MessageSummary[] = [];
        for await (const m of c.fetch(pick, { uid: true, envelope: true, flags: true }, { uid: true })) {
          const f = m.envelope?.from?.[0];
          out.push({
            uid: m.uid,
            uidValidity,
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

  read(acct: AccountConfig, folder: string, uid: number, uidValidity: string, maxChars: number) {
    return this.withClient(acct, async (c) => {
      const lock = await c.getMailboxLock(folder, { readOnly: true });
      try {
        requireUidValidity(c, uidValidity);
        // BODY.PEEK: reading does not set \Seen.
        const m = await c.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
        if (!m || !m.source) return null;
        const p = await simpleParser(m.source);
        const text = p.text ?? "";
        const addr = (a: any) => (a ? (Array.isArray(a) ? a.map((x) => x.text).join(", ") : a.text) : undefined);
        return {
          uid,
          uidValidity,
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

  setSeen(acct: AccountConfig, folder: string, uids: number[], uidValidity: string, seen: boolean) {
    return this.withClient(acct, async (c) => {
      const lock = await c.getMailboxLock(folder);
      try {
        requireUidValidity(c, uidValidity);
        if (seen) await c.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
        else await c.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
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
