// End-to-end against GreenMail (docker run -p 3025:3025 -p 3143:3143 greenmail/standalone).
// Skipped unless GREENMAIL_HOST is set.
import { describe, it, expect } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapBackend } from "../src/backend.js";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/tools.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const host = process.env.GREENMAIL_HOST;
describe.skipIf(!host)("smoke: GreenMail", () => {
  const cfg = loadConfig({
    MCP_BEARER_TOKEN: "smoke-token-0123456789",
    IMAP_ACCOUNTS: "test",
    IMAP_TEST_HOST: host ?? "localhost",
    IMAP_TEST_PORT: "3143",
    IMAP_TEST_TLS: "false",
    IMAP_TEST_USER: "smoke@example.test",
    IMAP_TEST_PASS: "smoke",
    IMAP_TEST_SMTP_HOST: host ?? "localhost",
    IMAP_TEST_SMTP_PORT: "3025",
    IMAP_TEST_SMTP_TLS: "false",
    SMTP_ENABLED: "true",
  });
  const acct = cfg.accounts.get("test")!;
  const b = new ImapBackend();

  it("lists, searches, reads and flags", async () => {
    // Seed INBOX via IMAP APPEND (test-only; the server itself never appends or sends).
    const seedClient = new ImapFlow({ host: host!, port: 3143, secure: false, auth: { user: "smoke@example.test", pass: "smoke" }, logger: false });
    await seedClient.connect();
    const raw = [
      "From: sender@example.test", "To: smoke@example.test", "Subject: Smoke hello", "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"', "", "--b1", "Content-Type: text/plain", "", "body text here",
      "--b1", 'Content-Type: text/plain; name="note.txt"', 'Content-Disposition: attachment; filename="note.txt"', "", "hi", "--b1--", "",
    ].join("\r\n");
    await seedClient.append("INBOX", raw, []);
    await seedClient.logout();
    let list = [] as Awaited<ReturnType<typeof b.search>>;
    for (let i = 0; i < 20 && list.length === 0; i++) {
      list = await b.search(acct, "INBOX", { unreadOnly: true }, 10).catch(() => []);
      if (!list.length) await new Promise((r) => setTimeout(r, 500));
    }
    expect(list[0].subject).toBe("Smoke hello");
    const uid = list[0].uid;
    expect((await b.search(acct, "INBOX", { subject: "Smoke" }, 10)).length).toBe(1);
    const m = await b.read(acct, "INBOX", uid, list[0].uidValidity, 4);
    expect(m!.body).toBe("body");
    expect(m!.truncated).toBe(true);
    expect(m!.attachments.map((a) => a.filename)).toEqual(["note.txt"]);
    expect(m!.seen).toBe(false);
    await b.setSeen(acct, "INBOX", [uid], list[0].uidValidity, true);
    expect(await b.search(acct, "INBOX", { unreadOnly: true }, 10)).toEqual([]);
    expect((await b.listFolders(acct)).map((f) => f.path)).toContain("INBOX");
  });

  it("send_message delivers over SMTP and saves a Sent copy", async () => {
    const server = buildServer(cfg, b);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "smoke", version: "1" });
    await client.connect(ct);
    const r: any = await client.callTool({ name: "send_message", arguments: {
      account: "test", to: ["smoke@example.test"], subject: "Smoke sent", body: "via smtp", in_reply_to: "<orig@example.test>" } });
    expect(r.isError, r.content?.[0]?.text).toBeFalsy();
    const out = JSON.parse(r.content[0].text);
    expect(out).toMatchObject({ sent: true, sentCopy: { saved: true, folder: "Sent" } });
    let got = [] as Awaited<ReturnType<typeof b.search>>;
    for (let i = 0; i < 20 && got.length === 0; i++) {
      got = await b.search(acct, "INBOX", { subject: "Smoke sent" }, 10);
      if (!got.length) await new Promise((res) => setTimeout(res, 500));
    }
    expect(got.length).toBe(1);
    const sent = await b.search(acct, "Sent", { subject: "Smoke sent" }, 10);
    expect(sent.length).toBe(1);
    const m = await b.read(acct, "Sent", sent[0].uid, sent[0].uidValidity, 1000);
    expect(m!.body.trim()).toBe("via smtp");
  });
});
