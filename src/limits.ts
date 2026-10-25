import { AsyncLocalStorage } from "node:async_hooks";

export const operationContext = new AsyncLocalStorage<AbortSignal>();
export const DEFAULT_LIMITS = {
  concurrent: 8, perAccount: 2, queued: 16, deadlineMs: 30_000,
  requests: 120, sends: 10, windowMs: 60_000, httpConcurrent: 24,
};

/** Reject the caller promptly, while observing the unfinished promise. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class OperationLimits {
  readonly options: typeof DEFAULT_LIMITS;
  private active = 0;
  private accounts = new Map<string, number>();
  private queue: { account: string; start: () => void }[] = [];
  private windowStart = Date.now();
  private requests = 0;
  private sends = 0;
  private httpActive = 0;

  constructor(options: Partial<typeof DEFAULT_LIMITS> = {}) {
    this.options = { ...DEFAULT_LIMITS, ...options };
  }

  // One configured bearer means one principal; never store raw tokens.
  quota(kind: "requests" | "sends") {
    if (Date.now() - this.windowStart >= this.options.windowMs) {
      this.windowStart = Date.now();
      this.requests = this.sends = 0;
    }
    if (this[kind] >= this.options[kind]) throw new Error(`${kind} quota exceeded`);
    this[kind]++;
  }

  admitRequest(): () => void {
    this.quota("requests");
    if (this.httpActive >= this.options.httpConcurrent) throw new Error("request capacity exceeded");
    this.httpActive++;
    let released = false;
    return () => { if (!released) { released = true; this.httpActive--; } };
  }

  private available(account: string) {
    return this.active < this.options.concurrent && (this.accounts.get(account) ?? 0) < this.options.perAccount;
  }

  private acquire(account: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const entry = { account, start: () => {
        signal.removeEventListener("abort", cancel);
        this.active++;
        this.accounts.set(account, (this.accounts.get(account) ?? 0) + 1);
        resolve(() => {
          this.active--;
          const remaining = this.accounts.get(account)! - 1;
          if (remaining) this.accounts.set(account, remaining);
          else this.accounts.delete(account);
          for (let i = 0; i < this.queue.length;) {
            if (this.available(this.queue[i].account)) this.queue.splice(i, 1)[0].start();
            else i++;
          }
        });
      } };
      const cancel = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason);
      };
      if (this.available(account)) entry.start();
      else if (this.queue.length >= this.options.queued) reject(new Error("operation queue full"));
      else {
        this.queue.push(entry);
        signal.addEventListener("abort", cancel, { once: true });
      }
    });
  }

  async run<T>(account: string, caller: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("operation cancelled"));
    caller?.addEventListener("abort", cancel, { once: true });
    if (caller?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new Error("operation deadline exceeded; mutation outcome may be unknown")), this.options.deadlineMs);
    const signal = controller.signal;
    try {
      const release = await this.acquire(account, signal);
      // Keep the slot until work actually settles, even if a backend ignores cancellation.
      const pending = operationContext.run(signal, async () => {
        signal.throwIfAborted();
        return work();
      }).finally(release);
      return await abortable(pending, signal);
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener("abort", cancel);
    }
  }
}
