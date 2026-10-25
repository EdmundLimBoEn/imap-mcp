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
    uid: 7, source: Buffer.from("Subject: hello\r\n\r\nbody"), flags: new Set(),
  }));
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
