import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ImapBackend } from "../src/backend.js";
import { buildServer } from "../src/tools.js";
import { cfg } from "./helpers.js";

const imap = vi.hoisted(() => ({
  on: vi.fn(),
  close: vi.fn(),
  mailbox: { uidValidity: 123n },
  connect: vi.fn(),
  logout: vi.fn(),
  release: vi.fn(),
  getMailboxLock: vi.fn(),
  search: vi.fn(),
  fetch: vi.fn(),
  messageFlagsAdd: vi.fn(),
  messageFlagsRemove: vi.fn(),
}));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor() { return imap; }
  },
}));

describe("IMAP command outcomes through MCP", () => {
  let client: Client;
  let server: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    vi.resetAllMocks();
    imap.mailbox.uidValidity = 123n;
    imap.connect.mockResolvedValue(undefined);
    imap.logout.mockResolvedValue(undefined);
    imap.getMailboxLock.mockResolvedValue({ release: imap.release });
    server = buildServer(cfg(), new ImapBackend());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: "test", version: "1" });
    await client.connect(ct);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it.each(["search", "list_messages"])("%s reports a refused search as an MCP error", async (name) => {
    imap.search.mockResolvedValue(false);
    const result = await client.callTool({ name, arguments: { account: "work" } });
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Error: IMAP search failed" }],
    });
    expect(imap.fetch).not.toHaveBeenCalled();
    expect(imap.release).toHaveBeenCalledOnce();
    expect(imap.close).not.toHaveBeenCalled();
    expect(imap.logout).toHaveBeenCalledOnce();
  });

  it.each(["search", "list_messages"])("%s preserves a successful empty search", async (name) => {
    imap.search.mockResolvedValue([]);
    const result = await client.callTool({ name, arguments: { account: "work" } });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "[]" }]);
    expect(imap.fetch).not.toHaveBeenCalled();
  });

  it.each(["search", "list_messages"])("%s retains messages with invalid or missing envelope dates", async (name) => {
    const dates = [new Date("2026-01-02T03:04:05Z"), "malformed date", "2026-01-03T04:05:06+02:00", new Date(NaN), undefined];
    imap.search.mockResolvedValue([1, 2, 3, 4, 5]);
    imap.fetch.mockImplementation(async function* () {
      for (const [index, date] of dates.entries()) {
        yield {
          uid: index + 1,
          envelope: { date, subject: `Message ${index + 1}`, from: [{ address: "sender@example.com" }] },
          flags: new Set(["\\Seen"]),
        };
      }
    });
    const result = await client.callTool({ name, arguments: { account: "work" } });
    expect(result.isError).not.toBe(true);
    const expectedDates = ["2026-01-02T03:04:05.000Z", undefined, "2026-01-03T02:05:06.000Z", undefined, undefined];
    expect(result.content).toEqual([{
      type: "text",
      text: JSON.stringify([5, 4, 3, 2, 1].map((uid) => ({
        uid, uidValidity: "123", date: expectedDates[uid - 1],
        from: "sender@example.com", subject: `Message ${uid}`, seen: true,
      })), null, 2),
    }]);
    expect(imap.release).toHaveBeenCalledOnce();
    expect(imap.logout).toHaveBeenCalledOnce();
    expect(imap.close).not.toHaveBeenCalled();
  });

  it.each(["search", "list_messages"])("%s filters and deduplicates FETCH updates with invalid dates", async (name) => {
    imap.search.mockResolvedValue([1, 2, 3]);
    imap.fetch.mockImplementation(async function* () {
      yield { uid: 1, envelope: { subject: "Outside the page" } };
      yield { uid: 99, envelope: { date: "malformed date" } };
      yield { uid: 2, flags: new Set() };
      yield { uid: 3, envelope: { date: new Date(NaN), subject: "Invalid date" } };
      yield { uid: 2, envelope: {} };
      yield { uid: 3, envelope: { date: new Date(NaN), subject: "Invalid date" } };
      yield { uid: 3, flags: new Set(["\\Seen"]) };
    });
    const result = await client.callTool({ name, arguments: { account: "work", limit: 2 } });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: JSON.stringify([
        { uid: 3, uidValidity: "123", subject: "Invalid date", seen: false },
        { uid: 2, uidValidity: "123", seen: false },
      ], null, 2),
    }]);
    expect(imap.release).toHaveBeenCalledOnce();
    expect(imap.logout).toHaveBeenCalledOnce();
  });

  it.each(["mark_read", "mark_unread"])("%s rejects stale references before updating flags", async (name) => {
    imap.mailbox.uidValidity = 124n;
    const result = await client.callTool({ name, arguments: {
      account: "work", uidValidity: "123", uids: [7],
    } });
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("Stale message reference") }],
    });
    expect(imap.messageFlagsAdd).not.toHaveBeenCalled();
    expect(imap.messageFlagsRemove).not.toHaveBeenCalled();
    expect(imap.release).toHaveBeenCalledOnce();
    expect(imap.logout).toHaveBeenCalledOnce();
    expect(imap.close).not.toHaveBeenCalled();
  });

  it.each([
    ["mark_read", "messageFlagsAdd", true],
    ["mark_unread", "messageFlagsRemove", false],
  ] as const)("%s rejects refusals and reports only requested counts on success", async (name, method, seen) => {
    const args = { account: "work", uidValidity: "123", uids: [1, 1, 999] };
    imap[method].mockResolvedValue(false);
    const refused = await client.callTool({ name, arguments: args });
    expect(refused).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Error: IMAP flag update failed" }],
    });
    expect(imap.release).toHaveBeenCalledOnce();
    expect(imap.close).not.toHaveBeenCalled();
    expect(imap.logout).toHaveBeenCalledOnce();

    // STORE can succeed for duplicate, nonexistent, or already-set UIDs;
    // a true result does not establish how many messages changed.
    imap[method].mockResolvedValue(true);
    const accepted = await client.callTool({ name, arguments: args });
    expect(accepted.isError).not.toBe(true);
    expect(accepted.content).toEqual([{
      type: "text", text: JSON.stringify({ requested: 3, seen }, null, 2),
    }]);
    expect(imap[method]).toHaveBeenLastCalledWith(args.uids, ["\\Seen"], { uid: true });
    expect(imap.release).toHaveBeenCalledTimes(2);
    expect(imap.close).not.toHaveBeenCalled();
    expect(imap.logout).toHaveBeenCalledTimes(2);
  });
});
