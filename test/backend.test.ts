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
  connect: vi.fn(async () => {}),
  list: vi.fn(async () => [{ path: "INBOX" }]),
  logout: vi.fn(async () => {}),
  close: vi.fn(),
});
const account = cfg().accounts.get("work")!;
const rawError = () => new Error("synthetic private protocol response");

const release = vi.fn();
const read = () => new ImapBackend().read(cfg().accounts.get("work")!, "INBOX", 7, 20);
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
      uid: 7, subject: "bounded message", seen: true,
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
