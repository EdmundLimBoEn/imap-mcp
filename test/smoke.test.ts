// End-to-end against GreenMail (docker run -p 3143:3143 greenmail/standalone).
// Skipped unless GREENMAIL_HOST is set.
import { describe, it, expect } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapBackend } from "../src/backend.js";
import { loadConfig } from "../src/config.js";

const host = process.env.GREENMAIL_HOST;
describe.skipIf(!host)("smoke: GreenMail", () => {
  const cfg = loadConfig({
    MCP_BEARER_TOKEN: "smoke-token-0123456789",
    IMAP_ACCOUNTS: "test",
    IMAP_TEST_HOST: host ?? "localhost",
    IMAP_TEST_PORT: "3143",
    IMAP_TEST_TLS: "false",
    IMAP_TEST_USER: "smoke@localhost",
    IMAP_TEST_PASS: "smoke",
  });
  const acct = cfg.accounts.get("test")!;
  const b = new ImapBackend();

  it("lists, searches, reads and flags", async () => {
    // Seed INBOX via IMAP APPEND (test-only; the server itself never appends or sends).
    const seedClient = new ImapFlow({ host: host!, port: 3143, secure: false, auth: { user: "smoke@localhost", pass: "smoke" }, logger: false });
    await seedClient.connect();
    const raw = [
      "From: sender@localhost", "To: smoke@localhost", "Subject: Smoke hello", "MIME-Version: 1.0",
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
    const m = await b.read(acct, "INBOX", uid, 4);
    expect(m!.body).toBe("body");
    expect(m!.truncated).toBe(true);
    expect(m!.attachments.map((a) => a.filename)).toEqual(["note.txt"]);
    expect(m!.seen).toBe(false);
    await b.setSeen(acct, "INBOX", [uid], true);
    expect(await b.search(acct, "INBOX", { unreadOnly: true }, 10)).toEqual([]);
    expect((await b.listFolders(acct)).map((f) => f.path)).toContain("INBOX");
  });
});
