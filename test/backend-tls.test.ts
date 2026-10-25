import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { ImapBackend } from "../src/backend.js";
import { cfg } from "./helpers.js";

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn(class {
    on = vi.fn();
    close = vi.fn();
    connect = vi.fn().mockResolvedValue(undefined);
    list = vi.fn().mockResolvedValue([]);
    logout = vi.fn().mockResolvedValue(undefined);
  }),
}));
vi.mock("nodemailer", () => ({
  createTransport: vi.fn(() => ({
    sendMail: vi.fn().mockResolvedValue({
      messageId: "test", accepted: ["recipient@example.test"], rejected: [],
    }),
    close: vi.fn(),
  })),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

async function connectBoth(tls: boolean, backend = new ImapBackend()) {
  const acct = cfg({ IMAP_WORK_TLS: String(tls), IMAP_WORK_SMTP_TLS: String(tls) }).accounts.get("work")!;
  await backend.listFolders(acct);
  await backend.smtpSend(acct, { from: acct.user, to: ["recipient@example.test"] }, Buffer.from("test mail"));
}

describe("mail transport TLS policy", () => {
  it("requires STARTTLS on both non-implicit transports", async () => {
    await connectBoth(false);
    expect(ImapFlow).toHaveBeenCalledWith(expect.objectContaining({ secure: false, doSTARTTLS: true }));
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true }));
  });

  it("preserves implicit TLS without conflicting IMAP STARTTLS options", async () => {
    await connectBoth(true);
    expect(ImapFlow).toHaveBeenCalledWith(expect.objectContaining({ secure: true }));
    expect(vi.mocked(ImapFlow).mock.calls[0][0]).not.toHaveProperty("doSTARTTLS");
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true }));
  });

  it("allows plaintext only with explicit test opt-in", async () => {
    vi.stubEnv("NODE_ENV", "test");
    await connectBoth(false, new ImapBackend({ allowPlaintextForTests: true }));
    expect(ImapFlow).toHaveBeenCalledWith(expect.objectContaining({ secure: false, doSTARTTLS: false }));
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: false }));
  });

  it.each(["production", "development", undefined])("rejects plaintext opt-in with NODE_ENV=%s", (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    expect(() => new ImapBackend({ allowPlaintextForTests: true })).toThrow(/only allowed in tests/);
  });

  it("certificate verification opt-out does not allow a plaintext downgrade", async () => {
    vi.stubEnv("IMAP_TLS_INSECURE", "true");
    await connectBoth(false);
    expect(ImapFlow).toHaveBeenCalledWith(expect.objectContaining({ doSTARTTLS: true, tls: { rejectUnauthorized: false } }));
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true, tls: { rejectUnauthorized: false } }));
  });
});
