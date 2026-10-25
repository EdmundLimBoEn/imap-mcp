import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImapBackend } from "../src/backend.js";
import { cfg } from "./helpers.js";

const state = vi.hoisted(() => ({ client: null as any, validity: 123n as bigint | undefined }));
vi.mock("imapflow", () => ({
  ImapFlow: class {
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
    constructor() { state.client = this; }
  },
}));

const backend = new ImapBackend();
const account = cfg().accounts.get("work")!;
const operations = {
  read: (value: string) => backend.read(account, "INBOX", 7, value, 100),
  markRead: (value: string) => backend.setSeen(account, "INBOX", [7], value, true),
  markUnread: (value: string) => backend.setSeen(account, "INBOX", [7], value, false),
};

describe("mailbox UIDVALIDITY", () => {
  beforeEach(() => { state.validity = 123n; });

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
