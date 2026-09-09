import { describe, expect, it } from 'vitest';
import { IdempotencyKeys, type KeyStorage } from './idempotency';

/** What sessionStorage looks like to the keys: a map that outlives any one form instance. */
function fakeStorage(): KeyStorage & { size(): number } {
  const items = new Map<string, string>();
  return {
    getItem: (name) => items.get(name) ?? null,
    setItem: (name, value) => void items.set(name, value),
    removeItem: (name) => void items.delete(name),
    size: () => items.size,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('IdempotencyKeys', () => {
  it('re-sends the same key while the server has not answered', () => {
    // The whole point: a request that died on the way back must be retried under its own key,
    // or the retry is a second purchase.
    const keys = new IdempotencyKeys('user-a');
    const first = keys.take('pack-1');
    expect(first).toMatch(UUID);
    expect(keys.take('pack-1')).toBe(first);
  });

  it('spends the key on any decision (2xx or 4xx) and keeps it on a 5xx', () => {
    const keys = new IdempotencyKeys('user-a');
    const first = keys.take('pack-1');
    keys.settle('pack-1', 200);
    const second = keys.take('pack-1');
    expect(second).not.toBe(first);

    // The different-terms DUPLICATE_REQUEST is a decision too; the in-progress one is the
    // caller's exception (useCharge never calls settle for it).
    keys.settle('pack-1', 409);
    const third = keys.take('pack-1');
    expect(third).not.toBe(second);

    // A 500 may have acted before it failed: the retry must let the server answer for it.
    keys.settle('pack-1', 500);
    expect(keys.take('pack-1')).toBe(third);
  });

  it('outlives the form: a remounted instance over the same storage re-sends the key', () => {
    // A request that died on the way back is exactly when a user reloads. Without the storage
    // the new form would mint a new UUID and the reload would turn into a second purchase.
    const storage = fakeStorage();
    const before = new IdempotencyKeys('user-a', storage).take('pack-1');
    const after = new IdempotencyKeys('user-a', storage);
    expect(after.take('pack-1')).toBe(before);
    after.settle('pack-1', 200);
    expect(storage.size()).toBe(0);
    expect(new IdempotencyKeys('user-a', storage).take('pack-1')).not.toBe(before);
  });

  it('replaces a stored value the server would refuse instead of sending it', () => {
    // sessionStorage is shared with anything else on the origin (and with dev tools).
    const storage = fakeStorage();
    storage.setItem('buddha:charge-key:user-a:pack-1', 'not a key!');
    const key = new IdempotencyKeys('user-a', storage).take('pack-1');
    expect(key).toMatch(UUID);
    expect(storage.getItem('buddha:charge-key:user-a:pack-1')).toBe(key);
  });

  it('degrades to memory when the storage throws, and still keeps the key for the mount', () => {
    let calls = 0;
    const broken: KeyStorage = {
      getItem: () => {
        calls += 1;
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const keys = new IdempotencyKeys('user-a', broken);
    const first = keys.take('pack-1');
    expect(first).toMatch(UUID);
    expect(keys.take('pack-1')).toBe(first);
    expect(calls).toBe(1); // replaced after the first throw, never consulted again
  });

  it('keeps the key for the mount when only writes fail', () => {
    // Private mode: reads answer, writes throw. Without a sticky fallback every take() would
    // read nothing and mint a fresh UUID — the double purchase all over again.
    const storage: KeyStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    const keys = new IdempotencyKeys('user-a', storage);
    const first = keys.take('pack-1');
    expect(keys.take('pack-1')).toBe(first);
    keys.settle('pack-1', 503);
    expect(keys.take('pack-1')).toBe(first);
  });

  it("keeps each account's keys apart in a shared tab", () => {
    // A's answer was lost; B signs in on the same tab and buys the same package. B must not
    // pick up — and then settle away — the key A still needs to collect its purchase, or A
    // comes back to a fresh key and buys again.
    const storage = fakeStorage();
    const a = new IdempotencyKeys('user-a', storage).take('pack-1');
    const b = new IdempotencyKeys('user-b', storage);
    expect(b.take('pack-1')).not.toBe(a);
    b.settle('pack-1', 200);
    expect(new IdempotencyKeys('user-a', storage).take('pack-1')).toBe(a);
  });

  it('keeps one key per intent, so a failed click on one card never blocks another', () => {
    const keys = new IdempotencyKeys('user-a');
    const a = keys.take('pack-a');
    const b = keys.take('pack-b');
    expect(a).not.toBe(b);
    keys.settle('pack-a', 200);
    expect(keys.take('pack-b')).toBe(b);
  });

  it('files a charge key under exactly the name it had before the namespace existed', () => {
    // The namespace argument is third, and defaults to the charge flow, for this line alone: a
    // renamed key would strand the answer the storage exists to recover, and the first click
    // after the deploy would mint a fresh key and buy the package a second time.
    const storage = fakeStorage();
    const key = new IdempotencyKeys('user-a', storage).take('pack-1');
    expect(storage.getItem('buddha:charge-key:user-a:pack-1')).toBe(key);
  });

  it('files a trade key under its own namespace', () => {
    const storage = fakeStorage();
    const key = new IdempotencyKeys('user-a', storage, 'trade-key').take('market-1');
    expect(storage.getItem('buddha:trade-key:user-a:market-1')).toBe(key);
  });

  it('keeps the two namespaces blind to each other', () => {
    // Nothing stops a package id and a market id from being the same string, and the flows
    // settle by different rules: a trade spends its key on every answered status, while a
    // charge keeps its key on the in-progress 409. Sharing a name would let one flow settle
    // away the key the other is still waiting to replay.
    const storage = fakeStorage();
    const charge = new IdempotencyKeys('user-a', storage);
    const trade = new IdempotencyKeys('user-a', storage, 'trade-key');
    const chargeKey = charge.take('same-id');
    expect(trade.take('same-id')).not.toBe(chargeKey);
    trade.settle('same-id', 200);
    expect(charge.take('same-id')).toBe(chargeKey);
  });

  it('applies the same keep-on-5xx, spend-on-decision rule inside a trade namespace', () => {
    const keys = new IdempotencyKeys('user-a', fakeStorage(), 'trade-key');
    const first = keys.take('market-1');
    // A 500 may have inserted the order before it failed: the retry must replay, not trade again.
    keys.settle('market-1', 500);
    expect(keys.take('market-1')).toBe(first);
    // The trade 409 is "same key, other terms" — answered, so the next press is a new trade.
    keys.settle('market-1', 409);
    expect(keys.take('market-1')).not.toBe(first);
  });
});
