export interface AccountConfig {
  name: string;
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
  sentFolder?: string;
  smtp?: { host: string; port: number; tls: boolean };
}

export interface AppConfig {
  bearerToken: string;
  port: number;
  host: string;
  maxBodyChars: number;
  smtpEnabled: boolean;
  accounts: Map<string, AccountConfig>;
}

const bool = (v: string | undefined, d: boolean) =>
  v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase());

function boundedInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, max: number): number {
  const value = Number(env[key] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${key} must be an integer between 1 and ${max}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const bearerToken = env.MCP_BEARER_TOKEN ?? "";
  if (bearerToken.length < 16) {
    throw new Error("MCP_BEARER_TOKEN must be set (at least 16 characters); refusing to start");
  }
  const names = (env.IMAP_ACCOUNTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) throw new Error("IMAP_ACCOUNTS must list at least one account name");
  const accounts = new Map<string, AccountConfig>();
  for (const raw of names) {
    const name = raw.toLowerCase();
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Invalid account name: ${raw}`);
    const p = `IMAP_${name.toUpperCase()}_`;
    const need = (k: string) => {
      const v = env[p + k];
      if (!v) throw new Error(`Missing env var ${p + k}`);
      return v;
    };
    const tls = bool(env[p + "TLS"], true);
    const acct: AccountConfig = {
      name,
      host: need("HOST"),
      port: boundedInteger(env, p + "PORT", tls ? 993 : 143, 65535),
      user: need("USER"),
      pass: need("PASS"),
      tls,
      sentFolder: env[p + "SENT"] || undefined,
    };
    const smtpHost = env[p + "SMTP_HOST"];
    if (smtpHost) {
      const stls = bool(env[p + "SMTP_TLS"], true);
      acct.smtp = { host: smtpHost, port: boundedInteger(env, p + "SMTP_PORT", 465, 65535), tls: stls };
    }
    accounts.set(name, acct);
  }
  return {
    bearerToken,
    port: boundedInteger(env, "PORT", 8787, 65535),
    host: env.HOST || "0.0.0.0",
    maxBodyChars: boundedInteger(env, "MAX_BODY_CHARS", 20000, 1_000_000),
    smtpEnabled: bool(env.SMTP_ENABLED, false),
    accounts,
  };
}
