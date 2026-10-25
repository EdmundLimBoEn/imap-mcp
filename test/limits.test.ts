import { describe, it, expect, vi } from "vitest";
import { RequestLimits, operationContext } from "../src/limits.js";

const options = { global: 2, perAccount: 1, queue: 1, requests: 2, sends: 1, windowMs: 1000, timeoutMs: 5000 };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("shared request limits", () => {
  it("bounds global and account concurrency, rejects queue overflow, and reuses released slots", async () => {
    const limits = new RequestLimits(options);
    const a = deferred(), b = deferred();
    const first = limits.run("a", undefined, () => a.promise);
    const queuedWork = vi.fn(async () => "queued");
    const queued = limits.run("a", undefined, queuedWork);
    const second = limits.run("b", undefined, () => b.promise);
    await expect(limits.run("c", undefined, async () => {})).rejects.toThrow("queue full");
    expect(queuedWork).not.toHaveBeenCalled();
    b.resolve();
    await second;
    expect(queuedWork).not.toHaveBeenCalled();
    a.resolve();
    await first;
    await expect(queued).resolves.toBe("queued");
    await expect(limits.run("c", undefined, async () => "recovered")).resolves.toBe("recovered");
  });

  it("removes cancelled queued work without invoking it", async () => {
    const limits = new RequestLimits(options);
    const a = deferred();
    const first = limits.run("a", undefined, () => a.promise);
    const controller = new AbortController();
    const work = vi.fn(async () => {});
    const queued = limits.run("a", controller.signal, work);
    controller.abort();
    await expect(queued).rejects.toThrow("cancelled");
    const replacement = limits.run("a", undefined, async () => "replacement");
    a.resolve();
    await first;
    await expect(replacement).resolves.toBe("replacement");
    expect(work).not.toHaveBeenCalled();
  });

  it("expires queued work and signals active work while retaining its slot until stopped", async () => {
    vi.useFakeTimers();
    try {
      const limits = new RequestLimits({ ...options, timeoutMs: 100 });
      const done = deferred();
      let signal!: AbortSignal;
      const active = limits.run("a", undefined, async () => { signal = operationContext.getStore()!; await done.promise; });
      const work = vi.fn(async () => {});
      const queued = expect(limits.run("a", undefined, work)).rejects.toThrow("deadline");
      await vi.advanceTimersByTimeAsync(100);
      await queued;
      expect(signal.aborted).toBe(true);
      expect(work).not.toHaveBeenCalled();
      const next = limits.run("a", undefined, work);
      await Promise.resolve();
      expect(work).not.toHaveBeenCalled();
      done.resolve();
      await active;
      await next;
      expect(work).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("enforces independent request/send quotas and restores them after the window", () => {
    vi.useFakeTimers();
    try {
      const limits = new RequestLimits(options);
      limits.quota(); limits.quota(); limits.quota(true);
      expect(() => limits.quota()).toThrow("Request quota");
      expect(() => limits.quota(true)).toThrow("Send quota");
      vi.advanceTimersByTime(1000);
      expect(() => limits.quota()).not.toThrow();
      expect(() => limits.quota(true)).not.toThrow();
    } finally { vi.useRealTimers(); }
  });
});
