import { describe, it, expect, vi } from "vitest";
import { request } from "./http-harness.js";
import { RequestLimits, operationContext } from "../src/limits.js";
import { createApp, checkBearer } from "../src/http.js";
import { cfg, TOKEN } from "./helpers.js";

const backend: any = { listFolders: vi.fn(async () => []) };
const app = createApp(cfg(), backend);
const localFetch = (path: string, init?: RequestInit) => request(app, path, init).response;

const rpc = (auth?: string) =>
  localFetch("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  });

describe("http", () => {
  it("/health is public and leaks nothing", async () => {
    const r = await localFetch("/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
  it("rejects missing or wrong bearer", async () => {
    expect((await rpc()).status).toBe(401);
    expect((await rpc("Bearer wrong")).status).toBe(401);
    expect((await localFetch("/anything")).status).toBe(401);
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

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` };
const toolRequest = (name = "list_folders") => ({ method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: { account: "work" } } }) });

it("shares request quotas across stateless MCP servers and returns 429", async () => {
  const limits = new RequestLimits({ global: 2, perAccount: 1, queue: 1, requests: 1, sends: 1, windowMs: 60000, timeoutMs: 1000 });
  const app = createApp(cfg(), backend, limits);
  expect((await request(app, "/mcp", toolRequest()).response).status).toBe(200);
  const rejected = await request(app, "/mcp", toolRequest()).response;
  expect(rejected.status).toBe(429);
  expect(rejected.headers.get("retry-after")).toBe("60");
});

it("propagates HTTP disconnect to active backend work", async () => {
  let signal!: AbortSignal;
  const backend: any = { listFolders: vi.fn(() => new Promise((resolve) => {
    signal = operationContext.getStore()!;
    signal.addEventListener("abort", () => resolve([]), { once: true });
  })) };
  const app = createApp(cfg(), backend);
  const pending = request(app, "/mcp", toolRequest());
  await vi.waitFor(() => expect(backend.listFolders).toHaveBeenCalledOnce());
  pending.disconnect();
  expect(signal.aborted).toBe(true);
});

it("bounds requests before body parsing and expires stalled work", async () => {
  const limits = new RequestLimits({ global: 1, perAccount: 1, queue: 0, requests: 100, sends: 1, windowMs: 60000, timeoutMs: 25 });
  const backend: any = { listFolders: () => new Promise((resolve) => operationContext.getStore()!.addEventListener("abort", () => resolve([]))) };
  const app = createApp(cfg(), backend, limits);
  const first = request(app, "/mcp", toolRequest());
  expect((await request(app, "/mcp", toolRequest()).response).status).toBe(429);
  expect((await first.response).status).toBe(504);
});
