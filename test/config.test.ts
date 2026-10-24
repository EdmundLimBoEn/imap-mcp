import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { baseEnv, cfg } from "./helpers.js";

describe("loadConfig", () => {
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
  it("ignores ENABLE_SMTP_SEND entirely", () => {
    expect(Object.keys(cfg({ ENABLE_SMTP_SEND: "true" }))).not.toContain("enableSmtpSend");
  });
  it("requires per-account vars", () => {
    const env: Record<string, string> = { ...baseEnv };
    delete env.IMAP_WORK_PASS;
    expect(() => loadConfig(env)).toThrow(/IMAP_WORK_PASS/);
  });
});
