import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImapBackend } from "../src/backend.js";
import { cfg } from "./helpers.js";

const smtp = vi.hoisted(() => ({ sendMail: vi.fn(), close: vi.fn() }));
vi.mock("nodemailer", () => ({ createTransport: () => smtp }));

describe("SMTP recipient outcomes", () => {
  beforeEach(() => vi.resetAllMocks());
  const account = cfg().accounts.get("work")!;
  const envelope = { from: account.user, to: ["ok@example.com", "bad@example.com"] };
  const raw = Buffer.from("test message");

  it("preserves partial outcomes and only exposes safe rejection details", async () => {
    smtp.sendMail.mockResolvedValue({
      messageId: "<partial@example.com>", accepted: ["ok@example.com"],
      rejected: [{ name: "Bad", address: "bad@example.com" }],
      rejectedErrors: [{
        recipient: "bad@example.com", responseCode: 450,
        message: "untrusted message", response: "untrusted response\r\nextra line",
        command: "RCPT TO", stack: "private stack", arbitrary: "private metadata",
      }],
    });
    expect(await new ImapBackend().smtpSend(account, envelope, raw)).toEqual({
      messageId: "<partial@example.com>", accepted: ["ok@example.com"], rejected: ["bad@example.com"],
      rejectionDetails: [{ recipient: "bad@example.com", responseCode: 450 }],
    });
    expect(smtp.sendMail).toHaveBeenCalledWith({ envelope, raw });
    expect(smtp.close).toHaveBeenCalledOnce();
  });

  it.each([undefined, 550, 200, 450.5, "450 untrusted"])("handles absent or invalid rejection codes: %s", async (responseCode) => {
    smtp.sendMail.mockResolvedValue({
      messageId: "<partial@example.com>", accepted: ["ok@example.com"], rejected: ["bad@example.com"],
      ...(responseCode === undefined ? {} : { rejectedErrors: [{ recipient: "bad@example.com", responseCode }] }),
    });
    const result = await new ImapBackend().smtpSend(account, envelope, raw);
    expect(result.rejectionDetails).toEqual([
      { recipient: "bad@example.com", ...(responseCode === 550 ? { responseCode: 550 } : {}) },
    ]);
  });

  it("preserves full acceptance without rejection details", async () => {
    smtp.sendMail.mockResolvedValue({ messageId: "<ok@example.com>", accepted: envelope.to, rejected: [] });
    expect(await new ImapBackend().smtpSend(account, envelope, raw)).toEqual({
      messageId: "<ok@example.com>", accepted: envelope.to, rejected: [], rejectionDetails: [],
    });
  });

  it("propagates submission failure and closes the transport", async () => {
    smtp.sendMail.mockRejectedValue(new Error("submission failed"));
    await expect(new ImapBackend().smtpSend(account, envelope, raw)).rejects.toThrow("submission failed");
    expect(smtp.close).toHaveBeenCalledOnce();
  });
});
