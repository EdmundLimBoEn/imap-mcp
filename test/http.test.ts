import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createApp, checkBearer } from "../src/http.js";
import { cfg, TOKEN } from "./helpers.js";

const backend: any = { listFolders: vi.fn(async () => []) };
let url: string;
const app = createApp(cfg(), backend);
beforeAll(async () => {
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => app.close());

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
