import { loadConfig } from "../src/config.js";
export const TOKEN = "test-token-0123456789abcdef";
export const baseEnv = {
  MCP_BEARER_TOKEN: TOKEN,
  IMAP_ACCOUNTS: "work,personal",
  IMAP_WORK_HOST: "imap.example.com",
  IMAP_WORK_USER: "work@example.com",
  IMAP_WORK_PASS: "placeholder",
  IMAP_WORK_SMTP_HOST: "smtp.example.com",
  IMAP_PERSONAL_HOST: "imap.example.org",
  IMAP_PERSONAL_PORT: "143",
  IMAP_PERSONAL_TLS: "false",
  IMAP_PERSONAL_USER: "me@example.org",
  IMAP_PERSONAL_PASS: "placeholder",
};
export const cfg = (extra: Record<string, string> = {}) => loadConfig({ ...baseEnv, ...extra });
