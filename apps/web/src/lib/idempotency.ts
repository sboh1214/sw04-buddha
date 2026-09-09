import { idempotencyKeySchema } from '@buddha/shared';

/** The three calls the keys need from a storage; `window.sessionStorage` has them. */
export interface KeyStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

/** Fallback for the server, the test runner and a browser whose storage throws. */
class MemoryStorage implements KeyStorage {
  private readonly items = new Map<string, string>();
  getItem(name: string): string | null {
    return this.items.get(name) ?? null;
  }
  setItem(name: string, value: string): void {
    this.items.set(name, value);
  }
  removeItem(name: string): void {
    this.items.delete(name);
  }
}

/** The tab's sessionStorage, or null where there is none (SSR) or touching it throws. */
export function browserSessionStorage(): KeyStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

const PREFIX = 'buddha:';

/**
 * Which flow a key belongs to. `charge-key` files a package purchase under the package id;
 * `trade-key` files a trade under the market id (PLAN 5.4, decision-trade-panel §5.1).
 */
export type KeyNamespace = 'charge-key' | 'trade-key';

/**
 * Client side of PLAN 5.4: one `Idempotency-Key` per intent, kept until the server has decided.
 *
 * `take(intent)` hands out the key for an intent — the one an unanswered attempt left behind,
 * or a fresh UUID. `settle(intent, status)` is called with the HTTP status the server answered
 * with. A 2xx or 4xx is a decision (the purchase or the trade happened, or was refused for a
 * reason the user has to act on), so the key is spent and the next click is a new one. A 5xx,
 * like a request that never came back at all, may have acted before it failed, so the key stays
 * and the retry lets the server answer for what it did.
 *
 * One 4xx is not a decision: the DUPLICATE_REQUEST that says the first request is still
 * running (`isChargeInProgress` in hooks/use-wallet). The caller skips `settle` for it, so the
 * next click collects that purchase rather than opening another. A trade has no such answer —
 * its 409 always means "same key, other terms" — so `useTrade` settles on every answered
 * status. The class stays ignorant of response bodies on purpose; it only counts statuses.
 *
 * Keys live in `sessionStorage`, not in the component: a request that died on the way back is
 * exactly the moment a user reloads the page, and a key that dies with the form would make the
 * next click a second purchase. sessionStorage survives reload and in-tab navigation and ends
 * with the tab — so a key stuck on a reservation that never finished pins its card for this
 * tab, not forever. Namespaced by account: the server already scopes keys by account, so
 * nothing leaks between accounts either way, but a shared tab must not let account B's purchase
 * of the same package pick up — and then settle away — the key account A is still waiting to
 * replay; that lost answer is exactly what the storage exists to recover. A duplicated tab
 * inherits the storage, so a key in flight there replays the same purchase instead of buying
 * again; that is the server's replay path, not a second charge.
 *
 * And by flow, for the same reason one level up: a charge intent is a package id while a trade
 * intent is a market id, and the two settle by different rules, so neither may read or spend a
 * key the other is still waiting on. `charge-key` is the default and the namespace is the third
 * parameter so that existing call sites compile and — the part that matters — every key already
 * sitting in a tab's sessionStorage keeps its exact name and stays replayable across the deploy.
 */
export class IdempotencyKeys {
  private storage: KeyStorage;
  private readonly prefix: string;

  /** `account` is the signed-in user's id: one account's keys are invisible to another. */
  constructor(
    account: string,
    storage: KeyStorage | null = browserSessionStorage(),
    namespace: KeyNamespace = 'charge-key',
  ) {
    this.prefix = `${PREFIX}${namespace}:${account}:`;
    this.storage = storage ?? new MemoryStorage();
  }

  take(intent: string): string {
    const name = this.prefix + intent;
    const kept = this.guard(() => this.storage.getItem(name));
    // Storage is shared with whatever else runs on this origin: a value that is not a key the
    // server would accept is replaced rather than sent (and refused, and only then replaced).
    if (kept && idempotencyKeySchema.safeParse(kept).success) return kept;
    const key = crypto.randomUUID();
    this.guard(() => this.storage.setItem(name, key));
    return key;
  }

  settle(intent: string, status: number): void {
    if (status < 500) this.guard(() => this.storage.removeItem(this.prefix + intent));
  }

  /**
   * A storage that throws (private mode, quota) degrades to this tab's memory — a key that
   * lasts for the mounted form beats no key at all. The op reads `this.storage` when it runs,
   * so the retry sees the replacement.
   */
  private guard<T>(op: () => T): T | null {
    try {
      return op();
    } catch {
      this.storage = new MemoryStorage();
      try {
        return op();
      } catch {
        return null;
      }
    }
  }
}
