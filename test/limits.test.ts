import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationLimits, operationContext } from "../src/limits.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());

describe("operation limits", () => {
  it("bounds global and per-account concurrency and rejects queue overflow", async () => {
    const limits = new OperationLimits({ concurrent: 2, perAccount: 1, queued: 1 });
    const gate = deferred();
    const a = limits.run("a", undefined, () => gate.promise);
    const next = vi.fn(async () => {});
    const queued = limits.run("a", undefined, next);
    const b = limits.run("b", undefined, () => gate.promise);
    await expect(limits.run("c", undefined, next)).rejects.toThrow("queue full");
    expect(next).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([a, b, queued]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("removes disconnected queued reads without starting them", async () => {
    const limits = new OperationLimits({ concurrent: 1, queued: 1 });
    const gate = deferred();
    const active = limits.run("a", undefined, () => gate.promise);
    const caller = new AbortController();
    const work = vi.fn(async () => {});
    const queued = limits.run("a", caller.signal, work);
    caller.abort();
    await expect(queued).rejects.toThrow("cancelled");
    const replacement = limits.run("b", undefined, work);
    gate.resolve();
    await Promise.all([active, replacement]);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("deadlines include queue time and retain slots for uncooperative work", async () => {
    vi.useFakeTimers();
    const limits = new OperationLimits({ concurrent: 1, queued: 1, deadlineMs: 100 });
    const gate = deferred();
    let signal!: AbortSignal;
    const active = limits.run("a", undefined, () => { signal = operationContext.getStore()!; return gate.promise; });
    const never = vi.fn(async () => {});
    const queued = limits.run("b", undefined, never);
    const assertions = Promise.all([
      expect(active).rejects.toThrow("deadline"), expect(queued).rejects.toThrow("deadline"),
    ]);
    await vi.advanceTimersByTimeAsync(100);
    await assertions;
    expect(signal.aborted).toBe(true);
    expect(never).not.toHaveBeenCalled();
    const waiting = limits.run("c", undefined, never);
    await Promise.resolve();
    expect(never).not.toHaveBeenCalled();
    gate.resolve();
    await waiting;
  });

  it("shares request and send quotas across calls and resets the window", () => {
    vi.useFakeTimers();
    const limits = new OperationLimits({ requests: 2, sends: 1, httpConcurrent: 1, windowMs: 100 });
    const release = limits.admitRequest();
    expect(() => limits.admitRequest()).toThrow("capacity");
    release();
    expect(() => limits.admitRequest()).toThrow("quota");
    limits.quota("sends");
    expect(() => limits.quota("sends")).toThrow("quota");
    vi.advanceTimersByTime(100);
    limits.admitRequest()();
    limits.quota("sends");
  });
});
