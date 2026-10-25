import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ImapBackend } from "../src/backend.js";
import { buildServer } from "../src/tools.js";
import { cfg } from "./helpers.js";

const imap = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  list: vi.fn(async () => [{ path: "Sent", specialUse: "\\Sent" }]),
  append: vi.fn(),
  logout: vi.fn(async () => {}),
}));

vi.mock("imapflow", () => ({
  ImapFlow: class { constructor() { return imap; } },
}));

describe("Sent copy APPEND result", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it.each([
    { result: false, saved: false },
    { result: { uid: 42, uidValidity: 1n, path: "Sent" }, saved: true },
  ])("reports saved=$saved after APPEND", async ({ result, saved }) => {
    imap.append.mockResolvedValueOnce(result);
    const backend = new ImapBackend();
    const smtpSend = vi.spyOn(backend, "smtpSend").mockResolvedValue({ messageId: "<test@example.com>" });
    const server = buildServer(cfg({ SMTP_ENABLED: "true" }), backend);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    try {
      await server.connect(st);
      await client.connect(ct);
      const response = await client.callTool({ name: "send_message", arguments: {
        account: "work", to: ["a@example.com"], subject: "Test", body: "Message",
      } });
      expect(response.isError).not.toBe(true);
      const content = response.content as { type: string; text: string }[];
      expect(JSON.parse(content[0].text)).toEqual({
        sent: true,
        messageId: "<test@example.com>",
        sentCopy: saved
          ? { saved: true, folder: "Sent" }
          : { saved: false, error: "Failed to save Sent copy: IMAP APPEND returned false" },
      });
      expect(smtpSend).toHaveBeenCalledTimes(1);
      expect(imap.append).toHaveBeenCalledExactlyOnceWith("Sent", smtpSend.mock.calls[0][2], ["\\Seen"]);
      expect(imap.logout).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
      smtpSend.mockRestore();
    }
  });
});
