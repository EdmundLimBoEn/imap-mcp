import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImapBackend } from "../src/backend.js";
import { cfg } from "./helpers.js";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("imapflow", () => ({
  ImapFlow: class { constructor() { return createClient(); } },
}));

const account = cfg().accounts.get("work")!;
const raw = Buffer.from("Subject: Sent copy\r\n\r\nTest body");
const missingFolder = () => Object.assign(new Error("Mailbox missing"), {
  responseStatus: "NO", serverResponseCode: "TRYCREATE",
});
const mockClient = () => Object.assign(new EventEmitter(), {
  connect: vi.fn().mockResolvedValue(undefined),
  logout: vi.fn().mockResolvedValue(undefined),
  close: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  append: vi.fn().mockResolvedValue({ uid: 1 }),
  mailboxCreate: vi.fn().mockResolvedValue({ created: true }),
});

describe("Sent folder selection and recovery", () => {
  let client: ReturnType<typeof mockClient>;
  const backend = new ImapBackend();
  beforeEach(() => {
    client = mockClient();
    createClient.mockReset().mockReturnValue(client);
  });

  it("uses the configured folder even when LIST is denied", async () => {
    client.list.mockRejectedValue(new Error("LIST denied"));
    await expect(backend.appendSent({ ...account, sentFolder: "Custom/Sent" }, raw))
      .resolves.toEqual({ folder: "Custom/Sent" });
    expect(client.list).not.toHaveBeenCalled();
    expect(client.mailboxCreate).not.toHaveBeenCalled();
    expect(client.append).toHaveBeenCalledExactlyOnceWith("Custom/Sent", raw, ["\\Seen"]);
    expect(client.logout).toHaveBeenCalledOnce();
  });

  it.each([
    { folders: [{ path: "Sent Items", specialUse: "\\Sent" }], folder: "Sent Items" },
    { folders: [], folder: "Sent" },
  ])("discovers or falls back to $folder without speculative creation", async ({ folders, folder }) => {
    client.list.mockResolvedValue(folders);
    await expect(backend.appendSent(account, raw)).resolves.toEqual({ folder });
    expect(client.list).toHaveBeenCalledOnce();
    expect(client.append).toHaveBeenCalledExactlyOnceWith(folder, raw, ["\\Seen"]);
    expect(client.mailboxCreate).not.toHaveBeenCalled();
  });

  it.each(["Custom/Sent", undefined])("creates only after TRYCREATE and retries once (override=%s)", async (sentFolder) => {
    const folder = sentFolder ?? "Sent";
    client.append.mockRejectedValueOnce(missingFolder());
    await expect(backend.appendSent({ ...account, sentFolder }, raw)).resolves.toEqual({ folder });
    expect(client.mailboxCreate).toHaveBeenCalledExactlyOnceWith(folder);
    expect(client.append.mock.calls).toEqual([[folder, raw, ["\\Seen"]], [folder, raw, ["\\Seen"]]]);
    const [first, second] = client.append.mock.invocationCallOrder;
    expect(first).toBeLessThan(client.mailboxCreate.mock.invocationCallOrder[0]);
    expect(client.mailboxCreate.mock.invocationCallOrder[0]).toBeLessThan(second);
  });

  it.each([false, true])("rejects a false APPEND result without further retries (after creation=%s)", async (afterCreation) => {
    if (afterCreation) client.append.mockRejectedValueOnce(missingFolder());
    client.append.mockResolvedValueOnce(false);
    await expect(backend.appendSent({ ...account, sentFolder: "Custom/Sent" }, raw))
      .rejects.toThrow("IMAP APPEND failed");
    expect(client.list).not.toHaveBeenCalled();
    expect(client.append).toHaveBeenCalledTimes(afterCreation ? 2 : 1);
    expect(client.mailboxCreate).toHaveBeenCalledTimes(afterCreation ? 1 : 0);
    expect(client.logout).toHaveBeenCalledOnce();
  });

  it.each([
    new Error("NO [TRYCREATE] mailbox missing"),
    Object.assign(new Error("Denied"), { responseStatus: "NO", serverResponseCode: "NOPERM" }),
    Object.assign(new Error("Quota"), { responseStatus: "NO", serverResponseCode: "OVERQUOTA" }),
    Object.assign(new Error("Bad command"), { responseStatus: "BAD", serverResponseCode: "TRYCREATE" }),
    Object.assign(new Error("Connection lost"), { code: "ECONNRESET" }),
  ])("does not create or retry on unconfirmed missing-folder errors (%#)", async (error) => {
    client.append.mockRejectedValueOnce(error);
    await expect(backend.appendSent({ ...account, sentFolder: "Custom/Sent" }, raw))
      .rejects.toThrow("IMAP operation failed");
    expect(client.mailboxCreate).not.toHaveBeenCalled();
    expect(client.append).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("does not loop if the retry also reports a missing folder", async () => {
    client.append.mockRejectedValue(missingFolder());
    await expect(backend.appendSent(account, raw)).rejects.toThrow("IMAP operation failed");
    expect(client.append).toHaveBeenCalledTimes(2);
    expect(client.mailboxCreate).toHaveBeenCalledOnce();
  });

  it("does not retry APPEND when creation fails", async () => {
    client.append.mockRejectedValueOnce(missingFolder());
    client.mailboxCreate.mockRejectedValue(new Error("Creation denied"));
    await expect(backend.appendSent(account, raw)).rejects.toThrow("IMAP operation failed");
    expect(client.append).toHaveBeenCalledOnce();
    expect(client.mailboxCreate).toHaveBeenCalledOnce();
  });
});
