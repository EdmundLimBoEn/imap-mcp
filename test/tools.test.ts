import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/tools.js";
import type { MailBackend } from "../src/backend.js";
import { cfg } from "./helpers.js";

const mock = (): MailBackend => ({
  listFolders: vi.fn(async () => [{ path: "INBOX" }, { path: "Drafts", specialUse: "\\Drafts" }]),
  search: vi.fn(async () => [{ uid: 7, subject: "hi", seen: false }]),
  read: vi.fn(async (_a, _f, uid, max) => ({
    uid, subject: "hi", seen: false, body: "x".repeat(max), truncated: true,
    attachments: [{ filename: "a.pdf", contentType: "application/pdf", size: 10 }],
  })),
  setSeen: vi.fn(async () => {}),
  appendDraft: vi.fn(async () => ({ folder: "Drafts", uid: 3 })),
});

async function connect(c = cfg(), b = mock()) {
  const server = buildServer(c, b);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(ct);
  return { client, b };
}
const parse = (r: any) => JSON.parse(r.content[0].text);

describe("tools", () => {
  let ctx: Awaited<ReturnType<typeof connect>>;
  beforeEach(async () => { ctx = await connect(cfg({ MAX_BODY_CHARS: "50" })); });

  it("exposes the read-only toolset by default (no send)", async () => {
    const names = (await ctx.client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["create_draft", "list_accounts", "list_folders", "list_messages", "mark_read", "mark_unread", "read_message", "search"]);
  });
  it("adds send_message only when ENABLE_SMTP_SEND=true", async () => {
    const { client } = await connect(cfg({ ENABLE_SMTP_SEND: "true" }));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("send_message");
  });
  it("list_accounts never leaks hosts or passwords", async () => {
    const r = await ctx.client.callTool({ name: "list_accounts", arguments: {} });
    const text = (r as any).content[0].text;
    expect(parse(r)).toEqual([{ name: "work", address: "work@example.com" }, { name: "personal", address: "me@example.org" }]);
    expect(text).not.toMatch(/placeholder|imap\.example/);
  });
  it("list_messages passes folder/limit/unread", async () => {
    await ctx.client.callTool({ name: "list_messages", arguments: { account: "work", limit: 5, unread_only: true } });
    expect(ctx.b.search).toHaveBeenCalledWith(expect.objectContaining({ name: "work" }), "INBOX", { unreadOnly: true }, 5);
  });
  it("search maps fields", async () => {
    await ctx.client.callTool({ name: "search", arguments: { account: "personal", from: "a@b.c", since: "2026-01-01", before: "2026-02-01", text: "invoice" } });
    expect(ctx.b.search).toHaveBeenCalledWith(expect.anything(), "INBOX",
      { from: "a@b.c", subject: undefined, text: "invoice", since: "2026-01-01", before: "2026-02-01" }, 50);
  });
  it("read_message caps body using MAX_BODY_CHARS", async () => {
    const m = parse(await ctx.client.callTool({ name: "read_message", arguments: { account: "work", uid: 7 } }));
    expect(m.body.length).toBe(50);
    expect(m.attachments[0].filename).toBe("a.pdf");
  });
  it("mark_read / mark_unread", async () => {
    await ctx.client.callTool({ name: "mark_read", arguments: { account: "work", uids: [1, 2] } });
    await ctx.client.callTool({ name: "mark_unread", arguments: { account: "work", uids: [3] } });
    expect(ctx.b.setSeen).toHaveBeenNthCalledWith(1, expect.anything(), "INBOX", [1, 2], true);
    expect(ctx.b.setSeen).toHaveBeenNthCalledWith(2, expect.anything(), "INBOX", [3], false);
  });
  it("create_draft appends, never sends", async () => {
    const r = parse(await ctx.client.callTool({ name: "create_draft", arguments: { account: "work", to: ["x@example.com"], subject: "s", text: "t" } }));
    expect(r).toMatchObject({ saved: true, sent: false, folder: "Drafts" });
    expect(ctx.b.appendDraft).toHaveBeenCalledOnce();
  });
  it("unknown account is an error", async () => {
    const r: any = await ctx.client.callTool({ name: "list_folders", arguments: { account: "nope" } });
    expect(r.isError).toBe(true);
  });
});
