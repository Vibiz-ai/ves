// A tiny async FIFO with close semantics: `next()` resolves with the next item, or `null` once the queue is closed
// and drained (the agent process exited, the HTTP stream ended for good, or the harness closed the session).
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((v: T | null) => void)[] = [];
  closed = false;
  closeReason = '';
  push(v: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w(v); else this.items.push(v);
  }
  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true; this.closeReason = reason;
    for (const w of this.waiters.splice(0)) w(null);
  }
  /** Next item; `null` when closed and empty, or after `timeoutMs` (then `timedOut()` is true for that call). */
  next(timeoutMs?: number): Promise<T | null> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((res) => {
      let t: ReturnType<typeof setTimeout> | undefined;
      const w = (v: T | null) => { if (t) clearTimeout(t); res(v); };
      this.waiters.push(w);
      if (timeoutMs !== undefined && timeoutMs > 0) {
        t = setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); res(TIMEOUT as unknown as T); }, timeoutMs);
        t.unref?.();
      }
    });
  }
  get size(): number { return this.items.length; }
}
/** Sentinel returned by `next(timeout)` when the timeout passed. Compare with `isTimeout`. */
export const TIMEOUT = Symbol('ves.queue.timeout');
export const isTimeout = (v: unknown): boolean => v === (TIMEOUT as unknown);
