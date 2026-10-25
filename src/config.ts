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

export function parseBoolean(v: string | undefined, d: boolean, name: string): boolean {
  if (v === undefined || v === "") return d;
  if (["1", "true", "yes", "on"].includes(v.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(v.toLowerCase())) return false;
  throw new Error(`Invalid boolean setting: ${name}`);
}

function parseInteger(value: string | undefined, fallback: number, name: string, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`Invalid numeric setting: ${name} (expected an integer from 1 to ${max})`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  parseBoolean(env.IMAP_TLS_INSECURE, false, "IMAP_TLS_INSECURE");
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
    const tls = parseBoolean(env[p + "TLS"], true, p + "TLS");
    const acct: AccountConfig = {
      name,
      host: need("HOST"),
      port: parseInteger(env[p + "PORT"], tls ? 993 : 143, p + "PORT", 65535),
      user: need("USER"),
      pass: need("PASS"),
      tls,
      sentFolder: env[p + "SENT"] || undefined,
    };
    const smtpHost = env[p + "SMTP_HOST"];
    if (smtpHost) {
      const stls = parseBoolean(env[p + "SMTP_TLS"], true, p + "SMTP_TLS");
      acct.smtp = { host: smtpHost, port: parseInteger(env[p + "SMTP_PORT"], 465, p + "SMTP_PORT", 65535), tls: stls };
    }
    accounts.set(name, acct);
  }
  return {
    bearerToken,
    port: parseInteger(env.PORT, 8787, "PORT", 65535),
    host: env.HOST || "0.0.0.0",
    maxBodyChars: parseInteger(env.MAX_BODY_CHARS, 20000, "MAX_BODY_CHARS", 1_048_576),
    smtpEnabled: parseBoolean(env.SMTP_ENABLED, false, "SMTP_ENABLED"),
    accounts,
  };
}
