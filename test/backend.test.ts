import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImapBackend } from "../src/backend.js";
import { cfg } from "./helpers.js";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("imapflow", () => ({
  ImapFlow: class { constructor() { return createClient(); } },
}));

const mockClient = () => Object.assign(new EventEmitter(), {
  connect: vi.fn(async () => {}),
  list: vi.fn(async () => [{ path: "INBOX" }]),
  logout: vi.fn(async () => {}),
  close: vi.fn(),
});
const account = cfg().accounts.get("work")!;
const rawError = () => new Error("synthetic private protocol response");

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
