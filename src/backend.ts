import { connect as connectSocket, type Socket } from "node:net";
import { operationContext, cancelled, OPERATION_TIMEOUT_MS } from "./limits.js";
import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { AccountConfig } from "./config.js";
import { parseBoolean } from "./config.js";

// Bound raw MIME input (including attachments) independently of the returned body cap.
export const MAX_MESSAGE_BYTES = 1024 * 1024;

// Only locally generated, fixed messages may bypass protocol-error redaction.
export class MailOperationError extends Error {}

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
  /** Conversion failed; any returned body may be incomplete. */
  bodyUnavailable?: "conversion_failed";
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

export interface SmtpSubmission {
  messageId?: string;
  accepted: string[];
  rejected: string[];
  rejectionDetails: { recipient: string; responseCode?: number }[];
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
  smtpSend(acct: AccountConfig, envelope: { from: string; to: string[] }, raw: Buffer): Promise<SmtpSubmission>;
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

// Only locally generated validation errors may cross the protocol error boundary.
export class UidValidityError extends MailOperationError {}

// ImapFlow exposes UIDVALIDITY as bigint; use a decimal string on the JSON boundary.
function mailboxUidValidity(c: ImapFlow): string {
  const value = c.mailbox && c.mailbox.uidValidity;
  if (!value || value < 1n || value > 4294967295n) {
    throw new UidValidityError("Mailbox UIDVALIDITY unavailable");
  }
  return value.toString();
}

function requireUidValidity(c: ImapFlow, expected: string): void {
  if (mailboxUidValidity(c) !== expected) {
    throw new UidValidityError("Stale message reference: UIDVALIDITY changed; list or search messages again");
  }
}

/** Keep only the largest UIDs in a min-heap; SEARCH results need not be ordered. */
function selectNewestUids(uids: number[], limit: number): number[] {
  const heap: number[] = [];
  if (limit <= 0) return heap;
  for (const uid of uids) {
    if (heap.length < limit) {
      let i = heap.length;
      heap.push(uid);
      while (i > 0) {
        const parent = Math.floor((i - 1) / 2);
        if (heap[parent] <= uid) break;
        heap[i] = heap[parent];
        i = parent;
      }
      heap[i] = uid;
    } else if (uid > heap[0]) {
      let i = 0;
      while (2 * i + 1 < heap.length) {
        let child = 2 * i + 1;
        if (child + 1 < heap.length && heap[child + 1] < heap[child]) child++;
        if (heap[child] >= uid) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = uid;
    }
  }
  return heap;
}

export class ImapBackend implements MailBackend {
  private readonly allowPlaintextForTests: boolean;

  constructor(options: { allowPlaintextForTests?: boolean } = {}) {
    this.allowPlaintextForTests = options.allowPlaintextForTests === true;
    if (this.allowPlaintextForTests && process.env.NODE_ENV !== "test") {
      throw new Error("Plaintext mail connections are only allowed in tests");
    }
  }

  private async withClient<T>(acct: AccountConfig, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const signal = operationContext.getStore();
    if (signal?.aborted) throw cancelled();
    const c = new ImapFlow({
      host: acct.host,
      port: acct.port,
      secure: acct.tls,
      ...(!acct.tls ? { doSTARTTLS: !this.allowPlaintextForTests } : {}),
      auth: { user: acct.user, pass: acct.pass },
      logger: false,
      tls: { rejectUnauthorized: !parseBoolean(process.env.IMAP_TLS_INSECURE, false, "IMAP_TLS_INSECURE") },
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
    let onAbort = () => {};
    const cancellation = new Promise<never>((_resolve, reject) => {
      onAbort = () => { close(); reject(cancelled()); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    try {
      return await Promise.race([
        cancellation,
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
    } catch (error) {
      if (signal?.aborted) { close(); throw cancelled(); }
      if (error instanceof MailOperationError && !closed) {
        await Promise.race([cancellation, connectionError, c.logout().catch(close)]);
        if (closed) throw failure;
        throw error;
      }
      close();
      throw failure;
    } finally {
      signal?.removeEventListener("abort", onAbort);
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
        const uids = await c.search(toSearchObject(q), { uid: true });
        if (!uids) throw new MailOperationError("IMAP search failed");
        const pick = selectNewestUids(uids, limit);
        if (pick.length === 0) return [];
        const selected = new Set(pick);
        const out = new Map<number, MessageSummary>();
        for await (const m of c.fetch(pick, { uid: true, envelope: true, flags: true }, { uid: true })) {
          // FETCH can also yield unsolicited or flag-only updates.
          if (!selected.has(m.uid) || !m.envelope) continue;
          const f = m.envelope?.from?.[0];
          const date = m.envelope?.date ? new Date(m.envelope.date) : undefined;
          out.set(m.uid, {
            uid: m.uid,
            uidValidity,
            date: date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined,
            from: f ? (f.name ? `${f.name} <${f.address}>` : f.address) : undefined,
            subject: m.envelope?.subject,
            seen: m.flags?.has("\\Seen") ?? false,
          });
        }
        return [...out.values()].sort((a, b) => b.uid - a.uid);
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
        const m = await c.fetchOne(String(uid), { uid: true, size: true, flags: true }, { uid: true });
        if (!m) return null;
        if (typeof m.size !== "number" || !Number.isSafeInteger(m.size) || m.size < 0) {
          throw new MailOperationError("Message size unavailable");
        }
        if (m.size > MAX_MESSAGE_BYTES) throw new MailOperationError("Message exceeds the 1 MiB read limit");
        // One extra byte detects overflow instead of parsing a silently truncated message.
        const { content } = await c.download(String(uid), undefined, {
          uid: true, maxBytes: MAX_MESSAGE_BYTES + 1, chunkSize: 64 * 1024,
        });
        if (!content) return null;
        const signal = operationContext.getStore();
        const stopDownload = () => content.destroy(cancelled());
        signal?.addEventListener("abort", stopDownload, { once: true });
        if (signal?.aborted) stopDownload();
        const chunks: Buffer[] = [];
        let bytes = 0;
        try {
          for await (const chunk of content) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > MAX_MESSAGE_BYTES) throw new MailOperationError("Message exceeds the 1 MiB read limit");
            chunks.push(buffer);
          }
        } finally {
          signal?.removeEventListener("abort", stopDownload);
          content.destroy();
        }
        if (bytes !== m.size) throw new MailOperationError("Incomplete message download: size mismatch");
        // Only complete, byte-bounded input reaches the buffering MIME parser.
        const p = await simpleParser(Buffer.concat(chunks, bytes), {
          skipTextToHtml: true,
          skipImageLinks: true,
        });
        // MailParser exposes this at runtime, but its external types omit it.
        const conversionFailed = Boolean((p as typeof p & { textConversionError?: unknown }).textConversionError);
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
          ...(conversionFailed ? { bodyUnavailable: "conversion_failed" as const } : {}),
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
        const success = seen
          ? await c.messageFlagsAdd(uids, ["\\Seen"], { uid: true })
          : await c.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
        if (!success) throw new MailOperationError("IMAP flag update failed");
      } finally {
        lock.release();
      }
    });
  }


  async smtpSend(acct: AccountConfig, envelope: { from: string; to: string[] }, raw: Buffer) {
    if (!acct.smtp) throw new Error(`SMTP not configured for ${acct.name}`);
    const signal = operationContext.getStore();
    if (signal?.aborted) throw cancelled();
    let socket: Socket | undefined;
    const t = createTransport({
      connectionTimeout: OPERATION_TIMEOUT_MS,
      greetingTimeout: OPERATION_TIMEOUT_MS,
      socketTimeout: OPERATION_TIMEOUT_MS,
      ...(signal ? { getSocket: (_options: unknown, callback: (error: Error | null, options?: { connection: Socket }) => void) => {
        socket = connectSocket({ host: acct.smtp!.host, port: acct.smtp!.port, signal });
        const failed = (error: Error) => callback(error);
        socket.once("error", failed);
        socket.once("connect", () => {
          socket!.removeListener("error", failed);
          callback(null, { connection: socket! });
        });
      } } : {}),
      host: acct.smtp.host,
      port: acct.smtp.port,
      secure: acct.smtp.tls,
      requireTLS: !acct.smtp.tls && !this.allowPlaintextForTests,
      auth: { user: acct.user, pass: acct.pass },
      tls: { rejectUnauthorized: !parseBoolean(process.env.IMAP_TLS_INSECURE, false, "IMAP_TLS_INSECURE") },
    });
    try {
      const info = await t.sendMail({ envelope, raw });
      const accepted = info.accepted.map((a: string | { address: string }) => typeof a === "string" ? a : a.address);
      const rejected = info.rejected.map((a: string | { address: string }) => typeof a === "string" ? a : a.address);
      // Nodemailer supplies rejectedErrors at runtime, but its transport types omit it.
      const errors = (info as typeof info & {
        rejectedErrors?: { recipient?: string; responseCode?: number }[];
      }).rejectedErrors ?? [];
      return {
        messageId: info.messageId,
        accepted,
        rejected,
        rejectionDetails: rejected.map((recipient) => {
          const code = errors.find((e) => e.recipient === recipient)?.responseCode;
          // Never expose raw server responses, error messages, or arbitrary error fields.
          const responseCode = typeof code === "number" && Number.isInteger(code) && code >= 400 && code <= 599
            ? code : undefined;
          return { recipient, ...(responseCode !== undefined ? { responseCode } : {}) };
        }),
      };
    } finally {
      socket?.destroy();
      t.close();
    }
  }

  appendSent(acct: AccountConfig, raw: Buffer) {
    return this.withClient(acct, async (c) => {
      const folder = acct.sentFolder ?? (await c.list()).find((m) => m.specialUse === "\\Sent")?.path ?? "Sent";
      let result;
      try {
        result = await c.append(folder, raw, ["\\Seen"]);
      } catch (error) {
        // Only a confirmed missing mailbox makes creation and an APPEND retry safe.
        if (typeof error !== "object" || error === null ||
            !("responseStatus" in error) || error.responseStatus !== "NO" ||
            !("serverResponseCode" in error) || error.serverResponseCode !== "TRYCREATE") throw error;
        await c.mailboxCreate(folder);
        result = await c.append(folder, raw, ["\\Seen"]);
      }
      if (!result) throw new MailOperationError("IMAP APPEND failed");
      return { folder };
    });
  }
}
