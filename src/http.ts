import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "./config.js";
import type { MailBackend } from "./backend.js";
import { buildServer } from "./tools.js";

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

class BodyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readBody(req: IncomingMessage, max = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req.iterator({ destroyOnReturn: false })) {
    n += (c as Buffer).length;
    if (n > max) {
      req.resume();
      throw new BodyError(413, "body too large");
    }
    chunks.push(c as Buffer);
  }
  try {
    return n ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  } catch {
    throw new BodyError(400, "invalid JSON");
  }
}

export function createApp(cfg: AppConfig, backend: MailBackend): Server {
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
      const body = await readBody(req);
      const server = buildServer(cfg, backend);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) {
        json(res, e instanceof BodyError ? e.status : 500, {
          error: e instanceof BodyError ? e.message : "internal server error",
        });
      }
    }
  });
}
