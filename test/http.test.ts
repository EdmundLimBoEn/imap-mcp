import { describe, it, expect, vi } from "vitest";
import { request } from "./http-harness.js";
import { OperationLimits, operationContext } from "../src/limits.js";
import { createApp, checkBearer } from "../src/http.js";
import { cfg, TOKEN } from "./helpers.js";

const backend: any = { listFolders: vi.fn(async () => []) };
const app = createApp(cfg(), backend);
const fetch = (path: string, init?: Parameters<typeof request>[2]) => request(app, path, init).response;
const url = "";

const rpc = (auth?: string) =>
  fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  });

describe("http", () => {
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

it("enforces request quotas across independent HTTP requests", async () => {
  const app = createApp(cfg(), backend, new OperationLimits({ requests: 1 }));
  const init = { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "{}" };
  await request(app, "/mcp", init).response;
  const response = await request(app, "/mcp", init).response;
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ error: "requests quota exceeded" });
});

it("disconnect cancels unfinished backend reads", async () => {
  let signal: AbortSignal | undefined;
  const backend: any = { listFolders: vi.fn(() => new Promise((_resolve, reject) => {
    signal = operationContext.getStore()!;
    signal.addEventListener("abort", () => reject(signal!.reason), { once: true });
  })) };
  const app = createApp(cfg(), backend);
  const call = request(app, "/mcp", {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_folders", arguments: { account: "work" } } }),
  });
  await vi.waitFor(() => expect(backend.listFolders).toHaveBeenCalled());
  call.disconnect();
  expect(signal!.aborted).toBe(true);
});

it("bounds HTTP requests in flight and releases capacity after disconnect", async () => {
  const limits = new OperationLimits({ httpConcurrent: 1 });
  const backend: any = { listFolders: vi.fn(() => new Promise((_resolve, reject) => {
    const signal = operationContext.getStore()!;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })) };
  const app = createApp(cfg(), backend, limits);
  const init = {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_folders", arguments: { account: "work" } } }),
  };
  const first = request(app, "/mcp", init);
  await vi.waitFor(() => expect(backend.listFolders).toHaveBeenCalledTimes(1));
  expect((await request(app, "/mcp", init).response).status).toBe(429);
  first.disconnect();
  const next = request(app, "/mcp", init);
  await vi.waitFor(() => expect(backend.listFolders).toHaveBeenCalledTimes(2));
  next.disconnect();
});
