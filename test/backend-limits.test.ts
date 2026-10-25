import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { OperationLimits } from "../src/limits.js";
import { cfg } from "./helpers.js";

const state = vi.hoisted(() => ({ clients: [] as any[], socket: undefined as any }));
vi.mock("node:net", () => ({ connect: () => {
  const socket = new EventEmitter() as any;
  socket.destroy = vi.fn();
  state.socket = socket;
  queueMicrotask(() => socket.emit("connect"));
  return socket;
} }));
vi.mock("nodemailer", () => ({ createTransport: (options: any) => ({
  sendMail: () => new Promise(() => options.getSocket({}, () => {})),
  close: vi.fn(),
}) }));
vi.mock("imapflow", () => ({ ImapFlow: class extends EventEmitter {
  reject?: (e: Error) => void;
  connect = vi.fn(async () => {});
  list = vi.fn(() => new Promise((_resolve, reject) => { this.reject = reject; }));
  logout = vi.fn(async () => {});
  close = vi.fn(() => this.reject?.(new Error("closed")));
  constructor() { super(); state.clients.push(this); }
} }));
import { ImapBackend } from "../src/backend.js";

it("closes an active IMAP read on caller cancellation and frees its slot", async () => {
  const limits = new OperationLimits({ concurrent: 1 });
  const caller = new AbortController();
  const backend = new ImapBackend();
  const pending = limits.run("work", caller.signal, () => backend.listFolders(cfg().accounts.get("work")!));
  await vi.waitFor(() => expect(state.clients.at(-1)?.list).toHaveBeenCalled());
  const client = state.clients.at(-1);
  caller.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(client.close).toHaveBeenCalled();
  await expect(limits.run("work", undefined, async () => "next")).resolves.toBe("next");
});

it("deadline destroys an active SMTP socket even when the peer never greets", async () => {
  const account = { ...cfg().accounts.get("work")!, smtp: {
    host: "mail.example.com", port: 587, tls: false,
  } };
  const limits = new OperationLimits({ deadlineMs: 100 });
  const pending = limits.run("work", undefined, () => new ImapBackend().smtpSend(account,
    { from: "a@example.com", to: ["b@example.com"] }, Buffer.from("test")));
  await expect(pending).rejects.toThrow("deadline");
  expect(state.socket.destroy).toHaveBeenCalled();
});
