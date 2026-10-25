import { AsyncLocalStorage } from "node:async_hooks";

export const OPERATION_TIMEOUT_MS = 30_000;
export const operationContext = new AsyncLocalStorage<AbortSignal>();
export class ResourceLimitError extends Error {}
export const cancelled = () => new ResourceLimitError("Operation cancelled or deadline exceeded");

// One instance per application: the configured bearer is the single principal.
export class RequestLimits {
  private active = 0;
  private accounts = new Map<string, number>();
  private queue: { account: string; start: () => void }[] = [];
  private requests: number[] = [];
  private sends: number[] = [];
  constructor(readonly options = { global: 8, perAccount: 2, queue: 16, requests: 120, sends: 10, windowMs: 60_000, timeoutMs: OPERATION_TIMEOUT_MS }) {}

  quota(send = false): void {
    const now = Date.now();
    const entries = (send ? this.sends : this.requests).filter((t) => t > now - this.options.windowMs);
    if (send) this.sends = entries; else this.requests = entries;
    if (entries.length >= (send ? this.options.sends : this.options.requests)) {
      throw new ResourceLimitError(send ? "Send quota exceeded" : "Request quota exceeded");
    }
    entries.push(now);
  }

  async run<T>(account: string, parent: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) abort();
    const timer = setTimeout(abort, this.options.timeoutMs);
    const signal = controller.signal;
    let acquired = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const entry = { account, start: () => {
          signal.removeEventListener("abort", onAbort);
          this.active++;
          this.accounts.set(account, (this.accounts.get(account) ?? 0) + 1);
          acquired = true;
          resolve();
        } };
        const onAbort = () => {
          this.queue = this.queue.filter((item) => item !== entry);
          reject(cancelled());
        };
        if (signal.aborted) return onAbort();
        if (this.available(account)) return entry.start();
        if (this.queue.length >= this.options.queue) return reject(new ResourceLimitError("Operation queue full"));
        signal.addEventListener("abort", onAbort, { once: true });
        this.queue.push(entry);
      });
      signal.throwIfAborted();
      // Retain the permit until work actually stops, even if a backend ignores cancellation.
      return await operationContext.run(signal, fn);
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
      if (acquired) {
        this.active--;
        const count = this.accounts.get(account)! - 1;
        if (count) this.accounts.set(account, count); else this.accounts.delete(account);
        for (const entry of [...this.queue]) {
          if (this.available(entry.account)) {
            this.queue.splice(this.queue.indexOf(entry), 1);
            entry.start();
          }
        }
      }
    }
  }
  private available(account: string) {
    return this.active < this.options.global && (this.accounts.get(account) ?? 0) < this.options.perAccount;
  }
}
