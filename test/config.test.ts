import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { baseEnv, cfg } from "./helpers.js";

describe("loadConfig", () => {
  it.each(["IMAP_WORK_TLS", "IMAP_WORK_SMTP_TLS", "SMTP_ENABLED", "IMAP_TLS_INSECURE"])(
    "rejects unknown boolean values for %s without echoing the value",
    (name) => {
      for (const value of ["tru", "flase", "2", " true "]) {
        expect(() => cfg({ [name]: value })).toThrow(`Invalid boolean setting: ${name}`);
      }
    },
  );
  it.each([
    ["true", true], ["1", true], ["YES", true], ["On", true],
    ["false", false], ["0", false], ["NO", false], ["Off", false],
  ])("parses boolean spelling %s", (value, expected) => {
    const c = cfg({ IMAP_WORK_TLS: String(value), IMAP_WORK_SMTP_TLS: String(value), SMTP_ENABLED: String(value) });
    expect(c.accounts.get("work")!.tls).toBe(expected);
    expect(c.accounts.get("work")!.smtp!.tls).toBe(expected);
    expect(c.smtpEnabled).toBe(expected);
  });
  it("uses defaults for empty boolean values", () => {
    const c = cfg({ IMAP_WORK_TLS: "", IMAP_WORK_SMTP_TLS: "", SMTP_ENABLED: "" });
    expect(c.accounts.get("work")!.tls).toBe(true);
    expect(c.accounts.get("work")!.smtp!.tls).toBe(true);
    expect(c.smtpEnabled).toBe(false);
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
