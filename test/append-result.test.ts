import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ImapBackend } from "../src/backend.js";
import { buildServer } from "../src/tools.js";
import { cfg } from "./helpers.js";

const imap = vi.hoisted(() => ({
  on: vi.fn(), connect: vi.fn(), logout: vi.fn(), close: vi.fn(),
  list: vi.fn(), append: vi.fn(),
}));
vi.mock("imapflow", () => ({
  ImapFlow: class { constructor() { return imap; } },
}));

describe("sent-copy APPEND outcomes through MCP", () => {
  let client: Client;
  let server: ReturnType<typeof buildServer>;
  let smtpSend: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetAllMocks();
    imap.connect.mockResolvedValue(undefined);
    imap.logout.mockResolvedValue(undefined);
    imap.list.mockResolvedValue([{ path: "Sent", specialUse: "\\Sent" }]);
    const backend = new ImapBackend();
    smtpSend = vi.spyOn(backend, "smtpSend").mockResolvedValue({
      messageId: "<submitted@example.test>", accepted: ["to@example.test"],
      rejected: [], rejectionDetails: [],
    });
    server = buildServer(cfg({ SMTP_ENABLED: "true" }), backend);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: "test", version: "1" });
    await client.connect(ct);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  async function send() {
    const result = await client.callTool({ name: "send_message", arguments: {
      account: "work", to: ["to@example.test"], subject: "test", body: "body",
    } });
    expect(result.isError).not.toBe(true);
    const output = JSON.parse((result.content as { text: string }[])[0].text);
    expect(output).toMatchObject({
      sent: true, status: "submitted", messageId: "<submitted@example.test>",
      accepted: ["to@example.test"], rejected: [], retryable: [],
    });
    expect(smtpSend).toHaveBeenCalledOnce();
    expect(imap.append).toHaveBeenCalledExactlyOnceWith("Sent", smtpSend.mock.calls[0][2], ["\\Seen"]);
    return output.sentCopy;
  }

  it("reports a false APPEND result as a failed copy after successful submission", async () => {
    imap.append.mockResolvedValue(false);
    expect(await send()).toEqual({ saved: false, error: "IMAP APPEND failed" });
    expect(imap.logout).toHaveBeenCalledOnce();
  });

  it.each([{}, { uid: 7, uidValidity: 123n }])("accepts successful APPEND with optional UID metadata (case %#)", async (result) => {
    imap.append.mockResolvedValue(result);
    expect(await send()).toEqual({ saved: true, folder: "Sent" });
    expect(imap.logout).toHaveBeenCalledOnce();
  });

  it("sanitizes a thrown APPEND error without losing SMTP success", async () => {
    imap.append.mockRejectedValue(new Error("synthetic private protocol response"));
    expect(await send()).toEqual({ saved: false, error: "IMAP operation failed" });
    expect(imap.close).toHaveBeenCalledOnce();
  });
});
