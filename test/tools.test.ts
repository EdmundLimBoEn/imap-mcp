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
  smtpSend: vi.fn(async () => ({ messageId: "<m1@example.com>" })),
  appendSent: vi.fn(async () => ({ folder: "Sent" })),
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

  it("gate off: no send_message tool", async () => {
    const names = (await ctx.client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["list_accounts", "list_folders", "list_messages", "mark_read", "mark_unread", "read_message", "search"]);
  });
  it("gate on: send_message registered", async () => {
    const { client } = await connect(cfg({ SMTP_ENABLED: "true" }));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("send_message");
  });
  it("send_message sends then appends the same raw message to Sent, with threading headers", async () => {
    const { client, b } = await connect(cfg({ SMTP_ENABLED: "true" }));
    const r = parse(await client.callTool({ name: "send_message", arguments: {
      account: "work", to: ["a@example.com"], cc: ["c@example.com"], subject: "Re: hi", body: "yo", in_reply_to: "<orig@example.com>" } }));
    expect(r).toMatchObject({ sent: true, messageId: "<m1@example.com>", sentCopy: { saved: true, folder: "Sent" } });
    const [, env, raw] = (b.smtpSend as any).mock.calls[0];
    expect(env).toEqual({ from: "work@example.com", to: ["a@example.com", "c@example.com"] });
    const text = raw.toString();
    expect(text).toMatch(/^In-Reply-To: <orig@example.com>$/m);
    expect(text).toMatch(/^References: <orig@example.com>$/m);
    expect((b.appendSent as any).mock.calls[0][1]).toBe(raw);
  });
  it("send_message rejects header injection and bad addresses", async () => {
    const { client, b } = await connect(cfg({ SMTP_ENABLED: "true" }));
    const base = { account: "work", to: ["a@example.com"], subject: "s", body: "b" };
    for (const bad of [
      { subject: "hi\r\nBcc: evil@example.com" },
      { in_reply_to: "<x>\nBcc: evil@example.com" },
      { to: ["a@example.com\r\nBcc: evil@example.com"] },
      { to: ["not-an-address"] },
      { cc: ["evil@example.com\n"] },
    ]) {
      const r: any = await client.callTool({ name: "send_message", arguments: { ...base, ...bad } });
      expect(r.isError).toBe(true);
    }
    expect(b.smtpSend).not.toHaveBeenCalled();
  });
  it("send_message errors when account has no SMTP host", async () => {
    const { client, b } = await connect(cfg({ SMTP_ENABLED: "true" }));
    const r: any = await client.callTool({ name: "send_message", arguments: { account: "personal", to: ["a@example.com"], subject: "s", body: "b" } });
    expect(r.isError).toBe(true);
    expect(b.smtpSend).not.toHaveBeenCalled();
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
  it.each(["since", "before"])("search rejects invalid %s dates before calling the backend", async (field) => {
    for (const value of ["2026-99-99junk", "2026-01-01junk", "2026-01-01\n", "2026-01-01T00:00:00Z",
      "2026-2-01", "2026-00-01", "2026-13-01", "2026-01-00", "2026-04-31", "2026-02-29", "1900-02-29", ""]) {
      const r = await ctx.client.callTool({ name: "search", arguments: {
        account: "work", from: "sender@example.com", [field]: value,
      } });
      expect(r.isError, value).toBe(true);
    }
    expect(ctx.b.search).not.toHaveBeenCalled();
  });
  it("search rejects inverted date ranges before calling the backend", async () => {
    const r = await ctx.client.callTool({ name: "search", arguments: {
      account: "work", since: "2026-03-01", before: "2026-02-28",
    } });
    expect(r.isError).toBe(true);
    expect(ctx.b.search).not.toHaveBeenCalled();
  });
  it.each([
    {}, { since: "2024-02-29" }, { before: "2000-02-29" },
    { since: "2024-02-29", before: "2024-03-01" },
    { since: "2026-01-01", before: "2026-01-01" },
  ])("search preserves valid date constraints %j", async (dates) => {
    const r = await ctx.client.callTool({ name: "search", arguments: { account: "work", ...dates } });
    expect(r.isError).not.toBe(true);
    expect(ctx.b.search).toHaveBeenCalledWith(expect.anything(), "INBOX", expect.objectContaining(dates), 50);
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
  it.each(["mark_read", "mark_unread"])("%s accepts the maximum 500 UIDs", async (name) => {
    const uids = Array.from({ length: 500 }, (_, i) => i + 1);
    const r = await ctx.client.callTool({ name, arguments: { account: "work", folder: "INBOX", uids } });
    expect(r.isError).not.toBe(true);
    expect(ctx.b.setSeen).toHaveBeenCalledWith(expect.anything(), "INBOX", uids, name === "mark_read");
  });
  it("enforces the input element budget including nested unknown fields", async () => {
    // Two top-level members, one nested member, and 1,021 array entries total 1,024.
    const argumentsAtLimit = { account: "work", extra: { values: Array(1021).fill(0) } };
    const accepted = await ctx.client.callTool({ name: "list_folders", arguments: argumentsAtLimit });
    expect(accepted.isError).not.toBe(true);
    expect(ctx.b.listFolders).toHaveBeenCalledTimes(1);
    vi.mocked(ctx.b.listFolders).mockClear();

    const rejected = await ctx.client.callTool({
      name: "list_folders",
      arguments: { account: "work", extra: { values: Array(1022).fill(0) } },
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toEqual([
      { type: "text", text: expect.stringContaining("arguments contain more than the maximum of 1024 elements") },
    ]);
    expect(ctx.b.listFolders).not.toHaveBeenCalled();
  });
  it("unknown account is an error", async () => {
    const r: any = await ctx.client.callTool({ name: "list_folders", arguments: { account: "nope" } });
    expect(r.isError).toBe(true);
  });
});
