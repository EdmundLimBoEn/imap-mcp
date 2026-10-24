import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
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
        const uids = (await c.search(toSearchObject(q), { uid: true })) || [];
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
        if (seen) await c.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
        else await c.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
      } finally {
        lock.release();
      }
    });
  }

}
