import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "./config.js";
import type { MailBackend } from "./backend.js";
import { buildServer } from "./tools.js";

import { RequestLimits, ResourceLimitError } from "./limits.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time bearer check (hashing equalises lengths). */
export function checkBearer(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  const given = m ? m[1].trim() : "";
  const ok = timingSafeEqual(digest(given), digest(token));
  return ok && given.length > 0;
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage, max = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return n ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

export function createApp(cfg: AppConfig, backend: MailBackend, limits = new RequestLimits()): Server {
  let activeRequests = 0;
  return createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health" && req.method === "GET") return json(res, 200, { ok: true });
    if (!checkBearer(req.headers.authorization, cfg.bearerToken)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return json(res, 401, { error: "unauthorized" });
    }
    if (path !== "/mcp") return json(res, 404, { error: "not found" });
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed (stateless server)" });
    try {
      limits.quota();
      if (activeRequests >= limits.options.global + limits.options.queue) throw new ResourceLimitError("Too many requests");
    } catch {
      res.setHeader("Retry-After", String(Math.ceil(limits.options.windowMs / 1000)));
      return json(res, 429, { error: "Request limit exceeded" });
    }
    activeRequests++;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      if (!res.headersSent) json(res, 504, { error: "Request deadline exceeded" });
      else res.destroy();
    }, limits.options.timeoutMs);
    res.once("close", () => {
      controller.abort();
      if (!req.complete) req.destroy();
      clearTimeout(timer);
      activeRequests--;
    });
    try {
      const body = await readBody(req);
      if (controller.signal.aborted) return;
      const server = buildServer(cfg, backend, limits, controller.signal);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) json(res, 400, { error: (e as Error).message });
    }
  });
}
