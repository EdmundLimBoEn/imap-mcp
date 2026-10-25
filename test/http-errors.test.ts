import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http.js";
import type { MailBackend } from "../src/backend.js";
import { cfg, TOKEN } from "./helpers.js";

// Exercise the real request handler and body stream without opening a socket.
async function request(body: string | Readable) {
  const req = Object.assign(typeof body === "string" ? Readable.from([Buffer.from(body)]) : body, {
    url: "/mcp", method: "POST", headers: { authorization: `Bearer ${TOKEN}` },
  });
  let status: number | undefined;
  let response: unknown;
  let destroyedAtResponse: boolean | undefined;
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writeHead(code: number) { status = code; return this; },
    end(data: string) { response = JSON.parse(data); destroyedAtResponse = req.destroyed; },
  });
  const app = createApp(cfg(), {} as MailBackend);
  const handler = app.listeners("request")[0];
  await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  res.emit("close");
  return { status, response, req, destroyedAtResponse };
}

afterEach(() => vi.restoreAllMocks());

describe("HTTP error classification and redaction", () => {
  it("returns a sanitized 400 for malformed JSON", async () => {
    const result = await request('{"private-message": invalid}');
    expect(result.status).toBe(400);
    expect(result.response).toEqual({ error: "invalid JSON" });
  });

  it("returns 413 for oversized UTF-8 input before cleaning up the request on response close", async () => {
    const result = await request(JSON.stringify("é".repeat(500_000)));
    expect(result.status).toBe(413);
    expect(result.response).toEqual({ error: "body too large" });
    expect(result.destroyedAtResponse).toBe(false);
    expect(result.req.destroyed).toBe(true);
  });

  it("counts bytes across chunks", async () => {
    const result = await request(Readable.from([Buffer.alloc(600_000, " "), Buffer.alloc(400_001, " ")]));
    expect(result.status).toBe(413);
    expect(result.response).toEqual({ error: "body too large" });
  });

  it.each([Error, SyntaxError])("redacts unexpected %s failures and returns 500", async (ErrorType) => {
    const connect = vi.spyOn(McpServer.prototype, "connect").mockRejectedValueOnce(new ErrorType("synthetic private backend details"));
    // Exactly the byte limit is accepted and reaches server setup.
    const result = await request("{}" + " ".repeat(999_998));
    expect(connect).toHaveBeenCalledOnce();
    expect(result.status).toBe(500);
    expect(result.response).toEqual({ error: "internal server error" });
  });

  it("redacts body stream failures as internal errors", async () => {
    const stream = Readable.from((async function* () {
      yield Buffer.from("{");
      throw new Error("synthetic private stream details");
    })());
    const result = await request(stream);
    expect(result.status).toBe(500);
    expect(result.response).toEqual({ error: "internal server error" });
  });
});
