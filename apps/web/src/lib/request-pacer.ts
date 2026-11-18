/** The signal's reason as an Error (a `DOMException` already is one), for a rejection. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('Aborted');
}

/**
 * A queue in front of a kind of request (#67, ADR-0142 결정 2-15): at most `maxInFlight` of them
 * on their way at once, and at most `perWindow` started in any `windowMs` (a sliding window), in
 * the order asked. MY's holdings read one `GET /me/markets/:id/sellable` per held market, and a
 * cold `/my/positions` of 50 markets asked them all at once beside its 50 market rows — past the
 * address's 100 a minute (`RATE_LIMIT_BUCKETS.default`), and a 429 is not retried. Every path that
 * reads them — the first read, a focus past `staleTime`, a reconnect, `user:position`, the book
 * window — runs through the query's `queryFn`, so pacing it there bounds them all.
 *
 * A task waiting its turn is dropped, never sent, when its `signal` aborts (a query cancelled or
 * restarted, a screen left), so a cancelled read costs no request. No imports: a root module.
 */
export class RequestPacer {
  private readonly maxInFlight: number;
  private readonly perWindow: number;
  private readonly windowMs: number;
  private inFlight = 0;
  /** When each request of the current window started, oldest first. */
  private readonly starts: number[] = [];
  private readonly queue: { start: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(limits: { maxInFlight: number; perWindow: number; windowMs: number }) {
    this.maxInFlight = Math.max(1, limits.maxInFlight);
    this.perWindow = Math.max(1, limits.perWindow);
    this.windowMs = limits.windowMs;
  }

  /** Requests waiting their turn (not yet started). */
  get waiting(): number {
    return this.queue.length;
  }

  /** Requests started and not yet answered. */
  get running(): number {
    return this.inFlight;
  }

  /** Runs `task` in its turn; rejects with the signal's reason, unsent, if aborted before it. */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abortError(signal));
        return;
      }
      const onAbort = () => {
        const at = this.queue.indexOf(entry);
        if (at >= 0) this.queue.splice(at, 1);
        if (signal !== undefined) reject(abortError(signal));
      };
      const entry = {
        start: () => {
          signal?.removeEventListener('abort', onAbort);
          this.inFlight += 1;
          this.starts.push(Date.now());
          // Started now, synchronously; a task that throws rejects like one that fails.
          const answer = new Promise<T>((settle) => {
            settle(task());
          });
          void answer.then(resolve, reject).finally(() => {
            this.inFlight -= 1;
            this.pump();
          });
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
      this.pump();
    });
  }

  /** Starts what the two limits let through now, and sets a timer for when the window frees. */
  private pump(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.queue.length > 0 && this.inFlight < this.maxInFlight) {
      const now = Date.now();
      while (this.starts.length > 0 && now - (this.starts[0] ?? now) >= this.windowMs) {
        this.starts.shift();
      }
      const oldest = this.starts[0];
      if (this.starts.length >= this.perWindow && oldest !== undefined) {
        this.timer = setTimeout(
          () => {
            this.timer = undefined;
            this.pump();
          },
          this.windowMs - (now - oldest),
        );
        return;
      }
      this.queue.shift()?.start();
    }
  }
}
