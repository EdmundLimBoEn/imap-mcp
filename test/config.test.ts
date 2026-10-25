import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { baseEnv, cfg } from "./helpers.js";

describe("loadConfig", () => {
  const portKeys = ["PORT", "IMAP_WORK_PORT", "IMAP_WORK_SMTP_PORT"];
  const invalidNumbers = ["NaN", "Infinity", "-Infinity", "abc", " ", "0", "-1", "1.5", "1e309"];

  it.each(portKeys)("rejects invalid %s values", (key) => {
    for (const value of [...invalidNumbers, "65536"]) {
      expect(() => cfg({ [key]: value })).toThrow(`${key} must be an integer between 1 and 65535`);
    }
  });

  it.each(["1", "65535"])("accepts port boundary %s", (value) => {
    const c = cfg(Object.fromEntries(portKeys.map((key) => [key, value])));
    expect(c.port).toBe(Number(value));
    expect(c.accounts.get("work")!.port).toBe(Number(value));
    expect(c.accounts.get("work")!.smtp!.port).toBe(Number(value));
  });

  it.each([...invalidNumbers, "1000001"])("rejects invalid MAX_BODY_CHARS %s", (value) => {
    expect(() => cfg({ MAX_BODY_CHARS: value })).toThrow("MAX_BODY_CHARS must be an integer between 1 and 1000000");
  });

  it.each(["1", "50", "1000000"])("accepts MAX_BODY_CHARS %s", (value) => {
    expect(cfg({ MAX_BODY_CHARS: value }).maxBodyChars).toBe(Number(value));
  });

  it.each([undefined, ""])("preserves numeric defaults for %s settings", (value) => {
    const c = loadConfig({ ...baseEnv, PORT: value, IMAP_WORK_PORT: value,
      IMAP_WORK_SMTP_PORT: value, IMAP_PERSONAL_PORT: value, MAX_BODY_CHARS: value });
    expect(c.port).toBe(8787);
    expect(c.maxBodyChars).toBe(20000);
    expect(c.accounts.get("work")!.port).toBe(993);
    expect(c.accounts.get("personal")!.port).toBe(143);
    expect(c.accounts.get("work")!.smtp!.port).toBe(465);
  });

  it("refuses to start without a bearer token", () => {
    expect(() => loadConfig({ ...baseEnv, MCP_BEARER_TOKEN: "" })).toThrow(/MCP_BEARER_TOKEN/);
    expect(() => loadConfig({ ...baseEnv, MCP_BEARER_TOKEN: "short" })).toThrow(/MCP_BEARER_TOKEN/);
  });
  it("parses multiple accounts with defaults", () => {
    const c = cfg();
    expect([...c.accounts.keys()]).toEqual(["work", "personal"]);
    expect(c.accounts.get("work")).toMatchObject({ port: 993, tls: true });
    expect(c.accounts.get("personal")).toMatchObject({ port: 143, tls: false });
  });
  it("SMTP is gated off by default and parsed per account", () => {
    const c = cfg();
    expect(c.smtpEnabled).toBe(false);
    expect(c.accounts.get("work")!.smtp).toEqual({ host: "smtp.example.com", port: 465, tls: true });
    expect(c.accounts.get("personal")!.smtp).toBeUndefined();
    expect(cfg({ SMTP_ENABLED: "true", IMAP_WORK_SENT: "Sent Items" }).accounts.get("work")!.sentFolder).toBe("Sent Items");
  });
  it("requires per-account vars", () => {
    const env: Record<string, string> = { ...baseEnv };
    delete env.IMAP_WORK_PASS;
    expect(() => loadConfig(env)).toThrow(/IMAP_WORK_PASS/);
  });
});
