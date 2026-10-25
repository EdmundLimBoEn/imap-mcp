import { describe, it, expect, vi } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createApp, checkBearer } from "../src/http.js";
import { cfg, TOKEN } from "./helpers.js";

const backend: any = { listFolders: vi.fn(async () => []) };
const url = "http://localhost";
const app = createApp(cfg(), backend);

// Exercise real Node HTTP objects and the MCP transport without binding a port.
async function fetch(url: string, init: RequestInit = {}) {
  const chunks: Buffer[] = [];
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  const req = new IncomingMessage(socket as Socket);
  req.url = new URL(url).pathname;
  req.method = init.method ?? "GET";
  req.headers = { host: "localhost", ...Object.fromEntries(new Headers(init.headers)) };
  req.rawHeaders = Object.entries(req.headers).flatMap(([key, value]) => [key, String(value)]);
  const res = new ServerResponse(req);
  res.assignSocket(socket as Socket);
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = ((chunk: any, ...args: any[]) => {
    chunks.push(Buffer.from(chunk));
    return (write as any)(chunk, ...args);
  }) as typeof res.write;
  res.end = ((chunk: any, ...args: any[]) => {
    if (chunk) chunks.push(Buffer.from(chunk));
    return (end as any)(chunk, ...args);
  }) as typeof res.end;
  const finished = new Promise<void>((resolve, reject) => {
    res.once("finish", resolve);
    res.once("error", reject);
  });
  if (init.body) req.push(Buffer.from(init.body as string));
  req.complete = true;
  req.push(null);
  app.emit("request", req, res);
  await finished;
  socket.destroy();
  return { status: res.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString()) };
}

const rpc = (auth?: string) =>
  fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  });

describe("http", () => {
  const post = (body: string) => fetch(`${url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
  });
  it("returns 413 for bodies exceeding the byte limit", async () => {
    const r = await post(JSON.stringify("é".repeat(500_000)));
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: "payload_too_large" });
  });
  it("accepts a body exactly at the byte limit", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const r = await post(body.padEnd(1_000_000));
    expect(r.status).toBe(200);
    expect((await r.json()).result.tools).toBeInstanceOf(Array);
  });
  it("returns a sanitized 400 for malformed JSON", async () => {
    const r = await post('{"private": invalid}');
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_json" });
  });
  it("returns a sanitized 500 for unexpected transport failures", async () => {
    const spy = vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest")
      .mockRejectedValueOnce(new Error("synthetic private transport detail"));
    try {
      const r = await rpc(`Bearer ${TOKEN}`);
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: "internal_error" });
    } finally {
      spy.mockRestore();
    }
  });
  it.each([new Error("synthetic private backend detail"), "synthetic rejection", null])(
    "sanitizes backend failures in MCP responses (%#)", async (failure) => {
      backend.listFolders.mockRejectedValueOnce(failure);
      const r = await post(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "list_folders", arguments: { account: "work" } } }));
      expect(r.status).toBe(200);
      expect((await r.json()).result).toEqual({ isError: true, content: [{ type: "text", text: "backend_error" }] });
    },
  );
  it("/health is public and leaks nothing", async () => {
    const r = await fetch(`${url}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
  it("rejects missing or wrong bearer", async () => {
    expect((await rpc()).status).toBe(401);
    expect((await rpc("Bearer wrong")).status).toBe(401);
    expect((await fetch(`${url}/anything`)).status).toBe(401);
  });
  it("accepts the right bearer and speaks MCP", async () => {
    const r = await rpc(`Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.result.serverInfo.name).toBe("imap-mcp");
  });
  it("checkBearer edge cases", () => {
    expect(checkBearer(undefined, TOKEN)).toBe(false);
    expect(checkBearer(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(checkBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });
});
