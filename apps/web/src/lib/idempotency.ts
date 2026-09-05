/**
 * Client side of PLAN 5.4: one `Idempotency-Key` per intent, kept until the server has decided.
 *
 * `take(intent)` hands out the key for an intent — the one an unanswered attempt left behind,
 * or a fresh UUID. `settle(intent, status)` is called with the HTTP status the server answered
 * with. A 2xx or 4xx is a decision (the purchase happened, or was refused for a reason the user
 * has to act on), so the key is spent and the next click is a new purchase. A 5xx, like a
 * request that never came back at all, may have acted before it failed, so the key stays and
 * the retry lets the server answer for what it did.
 *
 * One 4xx is not a decision: the DUPLICATE_REQUEST that says the first request is still
 * running (`isChargeInProgress` in hooks/use-wallet). The caller skips `settle` for it, so the
 * next click collects that purchase rather than opening another. The class stays ignorant of
 * response bodies on purpose; it only counts statuses.
 */
export class IdempotencyKeys {
  private readonly keys = new Map<string, string>();

  take(intent: string): string {
    let key = this.keys.get(intent);
    if (key === undefined) {
      key = crypto.randomUUID();
      this.keys.set(intent, key);
    }
    return key;
  }

  settle(intent: string, status: number): void {
    if (status < 500) this.keys.delete(intent);
  }
}
