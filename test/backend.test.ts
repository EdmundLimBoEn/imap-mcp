import { operationContext } from "../src/limits.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import { ImapBackend, MAX_MESSAGE_BYTES } from "../src/backend.js";
import { cfg } from "./helpers.js";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("imapflow", () => ({
  ImapFlow: class { constructor() { return createClient(); } },
}));

vi.mock("mailparser", async (original) => {
  const actual = await original<typeof import("mailparser")>();
  return { ...actual, simpleParser: vi.fn(actual.simpleParser) };
});

const mockClient = () => Object.assign(new EventEmitter(), {
  mailbox: { uidValidity: 123n },
  connect: vi.fn(async () => {}),
  list: vi.fn(async () => [{ path: "INBOX" }]),
  logout: vi.fn(async () => {}),
  close: vi.fn(),
});
const account = cfg().accounts.get("work")!;
const rawError = () => new Error("synthetic private protocol response");

const release = vi.fn();
const read = () => new ImapBackend().read(cfg().accounts.get("work")!, "INBOX", 7, "123", 20);
const raw = Buffer.from([
  "From: sender@example.com", "To: recipient@example.com", "Subject: bounded message",
  'Content-Type: multipart/mixed; boundary="boundary"', "", "--boundary",
  "Content-Type: text/plain; charset=utf-8", "", "A body longer than twenty characters.",
  "--boundary", "Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="a.bin"',
  "Content-Transfer-Encoding: base64", "", "aGVsbG8=", "--boundary--", "",
].join("\r\n"));

describe("bounded message reads", () => {
  let client: ReturnType<typeof mockClient> & { getMailboxLock: ReturnType<typeof vi.fn>; fetchOne: ReturnType<typeof vi.fn>; download: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    client = Object.assign(mockClient(), {
      getMailboxLock: vi.fn(), fetchOne: vi.fn(), download: vi.fn(),
    });
    createClient.mockReset().mockReturnValue(client);
    vi.clearAllMocks();
    client.connect.mockResolvedValue(undefined);
    client.logout.mockResolvedValue(undefined);
    client.getMailboxLock.mockResolvedValue({ release });
    client.fetchOne.mockResolvedValue({ uid: 7, size: raw.length, flags: new Set(["\\Seen"]), source: raw });
    client.download.mockResolvedValue({ content: Readable.from([raw]) });
  });

  it("checks size before a bounded UID download and preserves parsed results", async () => {
    expect(await read()).toMatchObject({
      uid: 7, uidValidity: "123", subject: "bounded message", seen: true,
      body: "A body longer than t", truncated: true,
      attachments: [{ filename: "a.bin", contentType: "application/octet-stream", size: 5 }],
    });
    expect(client.fetchOne).toHaveBeenCalledWith("7", { uid: true, size: true, flags: true }, { uid: true });
    expect(client.download).toHaveBeenCalledWith("7", undefined, {
      uid: true, maxBytes: MAX_MESSAGE_BYTES + 1, chunkSize: 64 * 1024,
    });
    expect(client.fetchOne.mock.invocationCallOrder[0]).toBeLessThan(client.download.mock.invocationCallOrder[0]);
    expect(release).toHaveBeenCalledOnce();
    expect(client.logout).toHaveBeenCalledOnce();
  });

  it.each([MAX_MESSAGE_BYTES + 1, 2_000_000])("rejects advertised size %s without downloading or parsing", async (size) => {
    client.fetchOne.mockResolvedValue({ uid: 7, size, source: raw });
    await expect(read()).rejects.toThrow("1 MiB read limit");
    expect(client.download).not.toHaveBeenCalled();
    expect(simpleParser).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(client.logout).toHaveBeenCalledOnce();
  });

  it.each([undefined, -1, NaN, Infinity, 1.5])("rejects unusable advertised size %s", async (size) => {
    client.fetchOne.mockResolvedValue({ uid: 7, size, source: raw });
    await expect(read()).rejects.toThrow("Message size unavailable");
    expect(client.download).not.toHaveBeenCalled();
    expect(simpleParser).not.toHaveBeenCalled();
  });

  it("rejects an underreported message on overflow and destroys the stream before parsing", async () => {
    const content = Readable.from([Buffer.alloc(MAX_MESSAGE_BYTES), Buffer.from("x")]);
    client.download.mockResolvedValue({ content });
    await expect(read()).rejects.toThrow("1 MiB read limit");
    expect(content.destroyed).toBe(true);
    expect(simpleParser).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(client.logout).toHaveBeenCalledOnce();
  });

  it("counts bytes, not UTF-8 characters", async () => {
    client.download.mockResolvedValue({ content: Readable.from(["é".repeat(MAX_MESSAGE_BYTES / 2 + 1)]) });
    await expect(read()).rejects.toThrow("1 MiB read limit");
    expect(simpleParser).not.toHaveBeenCalled();
  });

  it("accepts a message exactly at the byte limit", async () => {
    const header = Buffer.from("Content-Type: text/plain\r\n\r\n");
    const source = Buffer.concat([header, Buffer.alloc(MAX_MESSAGE_BYTES - header.length, "a")]);
    client.fetchOne.mockResolvedValue({ uid: 7, size: source.length, source });
    client.download.mockResolvedValue({ content: Readable.from([source]) });
    expect(await read()).toMatchObject({ body: "a".repeat(20), truncated: true, attachments: [] });
    expect(vi.mocked(simpleParser).mock.calls[0][0]).toEqual(source);
  });

  it("destroys a stalled download on caller cancellation without parsing it", async () => {
    const content = new Readable({ read() {} });
    client.download.mockResolvedValue({ content });
    const controller = new AbortController();
    const result = operationContext.run(controller.signal, read);
    const rejected = expect(result).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(client.download).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(content.destroyed).toBe(true);
    expect(client.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(simpleParser).not.toHaveBeenCalled();
  });

  it("does not parse a partial message when the download fails", async () => {
    const content = Readable.from((async function* () {
      yield raw;
      throw new Error("Download interrupted");
    })());
    client.download.mockResolvedValue({ content });
    await expect(read()).rejects.toThrow("IMAP operation failed");
    expect(simpleParser).not.toHaveBeenCalled();
    expect(content.destroyed).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(client.logout).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("sanitizes protocol errors even when their text matches a local error", async () => {
    client.fetchOne.mockRejectedValue(new Error("Message exceeds the 1 MiB read limit"));
    await expect(read()).rejects.toThrow("IMAP operation failed");
    expect(client.close).toHaveBeenCalledOnce();
    expect(simpleParser).not.toHaveBeenCalled();
  });

  it("handles socket errors during logout after a size rejection", async () => {
    client.fetchOne.mockResolvedValue({ uid: 7, size: MAX_MESSAGE_BYTES + 1 });
    client.logout.mockImplementationOnce(() => new Promise<never>(() => {}));
    const rejected = expect(read()).rejects.toThrow("IMAP operation failed");
    await vi.waitFor(() => expect(client.logout).toHaveBeenCalledOnce());
    client.emit("error", rawError());
    await rejected;
    expect(client.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(simpleParser).not.toHaveBeenCalled();
  });

  it("returns null when the message is missing", async () => {
    client.fetchOne.mockResolvedValue(false);
    expect(await read()).toBeNull();
    expect(client.download).not.toHaveBeenCalled();
    expect(simpleParser).not.toHaveBeenCalled();
  });
});

describe("IMAP connection lifecycle", () => {
  let client: ReturnType<typeof mockClient>;
  const backend = new ImapBackend();
  beforeEach(() => {
    client = mockClient();
    createClient.mockReset().mockReturnValue(client);
  });

  it.each(["connect", "list", "logout"] as const)("cancellation closes a stalled %s and permits another operation", async (phase) => {
    client[phase].mockImplementationOnce(() => new Promise<never>(() => {}));
    const controller = new AbortController();
    const result = operationContext.run(controller.signal, () => backend.listFolders(account));
    const rejected = expect(result).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(client[phase]).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(client.close).toHaveBeenCalledOnce();
    createClient.mockReturnValueOnce(mockClient());
    await expect(backend.listFolders(account)).resolves.toEqual([{ path: "INBOX" }]);
  });

  it("returns results and logs out on success", async () => {
    await expect(backend.listFolders(account)).resolves.toEqual([{ path: "INBOX" }]);
    expect(client.logout).toHaveBeenCalledOnce();
    expect(client.close).not.toHaveBeenCalled();
  });

  it.each(["connect", "list"] as const)("closes and sanitizes a rejected %s", async (phase) => {
    client[phase].mockRejectedValueOnce(rawError());
    await expect(backend.listFolders(account)).rejects.toEqual(new Error("IMAP operation failed"));
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.logout).not.toHaveBeenCalled();
    if (phase === "connect") expect(client.list).not.toHaveBeenCalled();
  });

  it.each(["connect", "list", "logout"] as const)("handles an asynchronous error during %s even if it never settles", async (phase) => {
    client[phase].mockImplementationOnce(() => new Promise<never>(() => {}));
    const result = backend.listFolders(account);
    const rejected = expect(result).rejects.toEqual(new Error("IMAP operation failed"));
    await vi.waitFor(() => expect(client[phase]).toHaveBeenCalledOnce());
    // Emitted outside the operation's promise chain, as with a socket error.
    expect(() => client.emit("error", rawError())).not.toThrow();
    await rejected;
    expect(client.close).toHaveBeenCalledOnce();
    expect(() => client.emit("error", rawError())).not.toThrow();
    expect(client.close).toHaveBeenCalledOnce();
    if (phase === "connect") expect(client.list).not.toHaveBeenCalled();

    createClient.mockReturnValueOnce(mockClient());
    await expect(backend.listFolders(account)).resolves.toEqual([{ path: "INBOX" }]);
  });

  it("attaches the listener before connect and does not use a failed connection", async () => {
    client.connect.mockImplementationOnce(async () => {
      expect(client.listenerCount("error")).toBeGreaterThan(0);
      client.emit("error", rawError());
    });
    await expect(backend.listFolders(account)).rejects.toEqual(new Error("IMAP operation failed"));
    expect(client.list).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("falls back to closing if graceful logout rejects", async () => {
    client.logout.mockRejectedValueOnce(rawError());
    await expect(backend.listFolders(account)).resolves.toEqual([{ path: "INBOX" }]);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("handles errors emitted during cleanup without leaking cleanup failures", async () => {
    client.connect.mockRejectedValueOnce(rawError());
    client.close.mockImplementationOnce(() => {
      client.emit("error", rawError());
      throw rawError();
    });
    await expect(backend.listFolders(account)).rejects.toEqual(new Error("IMAP operation failed"));
    expect(client.close).toHaveBeenCalledOnce();
  });
});

const smtp = vi.hoisted(() => ({ sendMail: vi.fn(), close: vi.fn() }));
vi.mock("nodemailer", () => ({ createTransport: () => smtp }));

describe("SMTP recipient outcomes", () => {
  beforeEach(() => vi.resetAllMocks());
  const account = cfg().accounts.get("work")!;
  const envelope = { from: account.user, to: ["ok@example.com", "bad@example.com"] };
  const raw = Buffer.from("test message");

  it("preserves partial outcomes and only exposes safe rejection details", async () => {
    smtp.sendMail.mockResolvedValue({
      messageId: "<partial@example.com>", accepted: ["ok@example.com"],
      rejected: [{ name: "Bad", address: "bad@example.com" }],
      rejectedErrors: [{
        recipient: "bad@example.com", responseCode: 450,
        message: "untrusted message", response: "untrusted response\r\nextra line",
        command: "RCPT TO", stack: "private stack", arbitrary: "private metadata",
      }],
    });
    expect(await new ImapBackend().smtpSend(account, envelope, raw)).toEqual({
      messageId: "<partial@example.com>", accepted: ["ok@example.com"], rejected: ["bad@example.com"],
      rejectionDetails: [{ recipient: "bad@example.com", responseCode: 450 }],
    });
    expect(smtp.sendMail).toHaveBeenCalledWith({ envelope, raw });
    expect(smtp.close).toHaveBeenCalledOnce();
  });

  it.each([undefined, 550, 200, 450.5, "450 untrusted"])("handles absent or invalid rejection codes: %s", async (responseCode) => {
    smtp.sendMail.mockResolvedValue({
      messageId: "<partial@example.com>", accepted: ["ok@example.com"], rejected: ["bad@example.com"],
      ...(responseCode === undefined ? {} : { rejectedErrors: [{ recipient: "bad@example.com", responseCode }] }),
    });
    const result = await new ImapBackend().smtpSend(account, envelope, raw);
    expect(result.rejectionDetails).toEqual([
      { recipient: "bad@example.com", ...(responseCode === 550 ? { responseCode: 550 } : {}) },
    ]);
  });

  it("preserves full acceptance without rejection details", async () => {
    smtp.sendMail.mockResolvedValue({ messageId: "<ok@example.com>", accepted: envelope.to, rejected: [] });
    expect(await new ImapBackend().smtpSend(account, envelope, raw)).toEqual({
      messageId: "<ok@example.com>", accepted: envelope.to, rejected: [], rejectionDetails: [],
    });
  });

  it("propagates submission failure and closes the transport", async () => {
    smtp.sendMail.mockRejectedValue(new Error("submission failed"));
    await expect(new ImapBackend().smtpSend(account, envelope, raw)).rejects.toThrow("submission failed");
    expect(smtp.close).toHaveBeenCalledOnce();
  });
});

const state = vi.hoisted(() => ({ client: null as any, validity: 123n as bigint | undefined }));
class UidClient extends EventEmitter {
  mailbox: any = false;
  connect = vi.fn(async () => {});
  logout = vi.fn(async () => {});
  release = vi.fn();
  getMailboxLock = vi.fn(async () => {
    // Mailbox state is only available once the lock has been acquired.
    this.mailbox = { uidValidity: state.validity };
    return { release: this.release };
  });
  search = vi.fn(async () => [7]);
  fetch = vi.fn(async function* () {
    yield { uid: 7, envelope: { subject: "hello" }, flags: new Set() };
  });
  fetchOne = vi.fn(async () => ({
    uid: 7, size: Buffer.byteLength("Subject: hello\r\n\r\nbody"), flags: new Set(),
  }));
  download = vi.fn(async () => ({ content: Readable.from([Buffer.from("Subject: hello\r\n\r\nbody")]) }));
  messageFlagsAdd = vi.fn(async () => true);
  messageFlagsRemove = vi.fn(async () => true);
  close = vi.fn();
  constructor() { super(); state.client = this; }
}

const backend = new ImapBackend();
const operations = {
  read: (value: string) => backend.read(account, "INBOX", 7, value, 100),
  markRead: (value: string) => backend.setSeen(account, "INBOX", [7], value, true),
  markUnread: (value: string) => backend.setSeen(account, "INBOX", [7], value, false),
};

describe("mailbox UIDVALIDITY", () => {
  beforeEach(() => {
    state.validity = 123n;
    createClient.mockReset().mockImplementation(() => new UidClient());
  });

  it("returns JSON-safe UIDVALIDITY from the locked mailbox in search and read results", async () => {
    state.validity = 4294967295n;
    const results = await backend.search(account, "INBOX", {}, 10);
    expect(JSON.parse(JSON.stringify(results))).toEqual([
      { uid: 7, uidValidity: "4294967295", subject: "hello", seen: false },
    ]);
    const message = await backend.read(account, "INBOX", 7, results[0].uidValidity, 100);
    expect(message).toMatchObject({ uid: 7, uidValidity: "4294967295", body: "body" });
    expect(state.client.fetchOne).toHaveBeenCalledWith("7", expect.anything(), { uid: true });
  });

  it.each(Object.entries(operations))("%s rejects a reused UID after the mailbox is recreated", async (_name, run) => {
    const [reference] = await backend.search(account, "INBOX", {}, 10);
    state.validity = 124n;
    await expect(run(reference.uidValidity)).rejects.toThrow("Stale message reference");
    expect(state.client.getMailboxLock).toHaveBeenCalledOnce();
    expect(state.client.fetchOne).not.toHaveBeenCalled();
    expect(state.client.download).not.toHaveBeenCalled();
    expect(state.client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(state.client.messageFlagsRemove).not.toHaveBeenCalled();
    expect(state.client.release).toHaveBeenCalledOnce();
    expect(state.client.logout).toHaveBeenCalledOnce();
  });

  it.each([true, false])("updates flags when UIDVALIDITY matches (seen=%s)", async (seen) => {
    await backend.setSeen(account, "INBOX", [7], "123", seen);
    const method = seen ? state.client.messageFlagsAdd : state.client.messageFlagsRemove;
    expect(method).toHaveBeenCalledWith([7], ["\\Seen"], { uid: true });
    expect(state.client.release).toHaveBeenCalledOnce();
  });

  it("sanitizes protocol errors even when they imitate a validation error", async () => {
    const client = new UidClient();
    client.fetchOne.mockRejectedValueOnce(new Error("Stale message reference: synthetic private response"));
    createClient.mockReturnValueOnce(client);
    await expect(operations.read("123")).rejects.toEqual(new Error("IMAP operation failed"));
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.logout).not.toHaveBeenCalled();
  });

  it("handles a socket error during validation failure logout even if logout never settles", async () => {
    const client = new UidClient();
    client.logout.mockImplementationOnce(() => new Promise<never>(() => {}));
    createClient.mockReturnValueOnce(client);
    const rejected = expect(operations.read("124")).rejects.toEqual(new Error("IMAP operation failed"));
    await vi.waitFor(() => expect(client.logout).toHaveBeenCalledOnce());
    expect(() => client.emit("error", rawError())).not.toThrow();
    await rejected;
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.fetchOne).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
    expect(() => client.emit("error", rawError())).not.toThrow();
  });

  it("sanitizes a rejected logout after validation fails", async () => {
    const client = new UidClient();
    client.logout.mockRejectedValueOnce(rawError());
    createClient.mockReturnValueOnce(client);
    await expect(operations.read("124")).rejects.toEqual(new Error("IMAP operation failed"));
    expect(client.logout).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.download).not.toHaveBeenCalled();
  });

  it("fails closed when the server provides no UIDVALIDITY", async () => {
    state.validity = undefined;
    await expect(backend.search(account, "INBOX", {}, 10)).rejects.toThrow("UIDVALIDITY unavailable");
    expect(state.client.fetch).not.toHaveBeenCalled();
    for (const run of Object.values(operations)) {
      await expect(run("123")).rejects.toThrow("UIDVALIDITY unavailable");
      expect(state.client.fetchOne).not.toHaveBeenCalled();
      expect(state.client.messageFlagsAdd).not.toHaveBeenCalled();
      expect(state.client.messageFlagsRemove).not.toHaveBeenCalled();
      expect(state.client.release).toHaveBeenCalledOnce();
    }
  });
});

describe("bounded UID selection", () => {
  const backend = new ImapBackend();
  let imap: ReturnType<typeof mockClient> & {
    release: ReturnType<typeof vi.fn>;
    getMailboxLock: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
    fetch: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    imap = Object.assign(mockClient(), {
      release: vi.fn(), getMailboxLock: vi.fn(), search: vi.fn(), fetch: vi.fn(),
    });
    createClient.mockReset().mockReturnValue(imap);
    imap.getMailboxLock.mockResolvedValue({ release: imap.release });
    // FETCH order is independent of the selected UID order.
    imap.fetch.mockImplementation(async function* (uids: number[]) {
      for (const uid of [...uids].sort((a, b) => a - b)) {
        yield { uid, envelope: { subject: `Message ${uid}` }, flags: new Set() };
      }
    });
  });

  it.each([
    { uids: [], limit: 3 },
    { uids: [19], limit: 3 },
    { uids: [101, 3, 900, 42, 7], limit: 1 },
    { uids: [101, 3, 900, 42, 7], limit: 3 },
    { uids: [101, 3, 900, 42, 7], limit: 5 },
    { uids: [101, 3, 900, 42, 7], limit: 10 },
    { uids: Array.from({ length: 500 }, (_, i) => i * 7 + 1), limit: 20 },
    { uids: Array.from({ length: 500 }, (_, i) => (500 - i) * 7), limit: 20 },
    { uids: Array.from({ length: 501 }, (_, i) => ((i * 127) % 501) * 11 + 1), limit: 17 },
  ])("returns the highest UIDs for case %#", async ({ uids, limit }) => {
    const expected = [...uids].sort((a, b) => b - a).slice(0, limit);
    imap.search.mockResolvedValue(uids);
    const result = await backend.search(account, "INBOX", {}, limit);
    expect(result.map((m) => m.uid)).toEqual(expected);
    expect(result.map((m) => m.uidValidity)).toEqual(expected.map(() => "123"));
    expect(imap.search).toHaveBeenCalledWith({ all: true }, { uid: true });
    if (expected.length) {
      expect(imap.fetch).toHaveBeenCalledWith(expect.arrayContaining(expected),
        { uid: true, envelope: true, flags: true }, { uid: true });
      expect(imap.fetch.mock.calls[0][0]).toHaveLength(expected.length);
    } else {
      expect(imap.fetch).not.toHaveBeenCalled();
    }
    expect(imap.release).toHaveBeenCalledOnce();
  });

  it("sorts at most a page for a large filtered result while preserving every filter", async () => {
    const limit = 5;
    const uids = Array.from({ length: 10000 }, (_, i) => ((i * 7919) % 10000) * 3 + 1);
    const expected = [...uids].sort((a, b) => b - a).slice(0, limit);
    imap.search.mockResolvedValue(uids);
    const sortedLengths: number[] = [];
    const originalSort = Array.prototype.sort;
    const sort = vi.spyOn(Array.prototype, "sort").mockImplementation(function (compare) {
      sortedLengths.push(this.length);
      return originalSort.call(this, compare);
    });
    let result;
    try {
      result = await backend.search(account, "Archive", {
        from: "sender@example.test", subject: "report", text: "invoice",
        since: "2026-01-01", before: "2026-02-01", unreadOnly: true,
      }, limit);
    } finally {
      sort.mockRestore();
    }
    expect(result.map((m) => m.uid)).toEqual(expected);
    expect(result.map((m) => m.uidValidity)).toEqual(expected.map(() => "123"));
    expect(sortedLengths.every((length) => length <= limit)).toBe(true);
    expect(imap.search).toHaveBeenCalledExactlyOnceWith({
      from: "sender@example.test", subject: "report", body: "invoice",
      since: new Date("2026-01-01"), before: new Date("2026-02-01"), seen: false,
    }, { uid: true });
    expect(imap.getMailboxLock).toHaveBeenCalledWith("Archive", { readOnly: true });
  });
});
