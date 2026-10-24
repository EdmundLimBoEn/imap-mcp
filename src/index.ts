import { loadConfig, type AppConfig } from "./config.js";
import { ImapBackend } from "./backend.js";
import { createApp } from "./http.js";

let cfg: AppConfig;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(`[imap-mcp] ${(e as Error).message}`);
  process.exit(1);
}
const c = cfg;
createApp(c, new ImapBackend()).listen(c.port, c.host, () => {
  console.log(
    `[imap-mcp] listening on ${c.host}:${c.port} with ${c.accounts.size} account(s); smtp send ${c.smtpEnabled ? "ENABLED" : "disabled"}`,
  );
});
