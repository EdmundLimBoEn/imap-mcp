// End-to-end against GreenMail (docker run -p 3143:3143 -p 3025:3025 greenmail/standalone).
// Skipped unless GREENMAIL_HOST is set.
import { describe, it, expect } from "vitest";
import { createTransport } from "nodemailer";
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

  it("lists, searches, reads, flags and drafts", async () => {
    await createTransport({ host, port: 3025, secure: false, ignoreTLS: true }).sendMail({
      from: "sender@localhost", to: "smoke@localhost", subject: "Smoke hello", text: "body text here",
      attachments: [{ filename: "note.txt", content: "hi" }],
    });
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
    const d = await b.appendDraft(acct, acct.user, { to: ["x@localhost"], subject: "Draft!", text: "t" });
    expect(d.folder).toBe("Drafts");
    expect((await b.search(acct, "Drafts", {}, 10))[0].subject).toBe("Draft!");
    expect((await b.listFolders(acct)).map((f) => f.path)).toContain("Drafts");
  });
});
