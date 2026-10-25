import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImapBackend } from "../src/backend.js";
import { cfg } from "./helpers.js";

const imap = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  logout: vi.fn(async () => {}),
  release: vi.fn(),
  getMailboxLock: vi.fn(),
  search: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("imapflow", () => ({ ImapFlow: class { constructor() { return imap; } } }));

const backend = new ImapBackend();
const account = cfg().accounts.get("work")!;

beforeEach(() => {
  vi.clearAllMocks();
  imap.getMailboxLock.mockResolvedValue({ release: imap.release });
  // FETCH order is independent of the selected UID order.
  imap.fetch.mockImplementation(async function* (uids: number[]) {
    for (const uid of [...uids].sort((a, b) => a - b)) {
      yield { uid, envelope: { subject: `Message ${uid}` }, flags: new Set() };
    }
  });
});

describe("bounded UID selection", () => {
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
    expect(sortedLengths.every((length) => length <= limit)).toBe(true);
    expect(imap.search).toHaveBeenCalledExactlyOnceWith({
      from: "sender@example.test", subject: "report", body: "invoice",
      since: new Date("2026-01-01"), before: new Date("2026-02-01"), seen: false,
    }, { uid: true });
    expect(imap.getMailboxLock).toHaveBeenCalledWith("Archive", { readOnly: true });
  });
});
