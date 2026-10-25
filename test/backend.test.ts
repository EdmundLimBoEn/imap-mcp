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
