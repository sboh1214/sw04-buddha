import { describe, expect, it } from 'vitest';
import { IdempotencyKeys } from './idempotency';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('IdempotencyKeys', () => {
  it('re-sends the same key while the server has not answered', () => {
    // The whole point: a request that died on the way back must be retried under its own key,
    // or the retry is a second purchase.
    const keys = new IdempotencyKeys();
    const first = keys.take('pack-1');
    expect(first).toMatch(UUID);
    expect(keys.take('pack-1')).toBe(first);
  });

  it('spends the key on any decision (2xx or 4xx) and keeps it on a 5xx', () => {
    const keys = new IdempotencyKeys();
    const first = keys.take('pack-1');
    keys.settle('pack-1', 200);
    const second = keys.take('pack-1');
    expect(second).not.toBe(first);

    keys.settle('pack-1', 409); // DUPLICATE_REQUEST is a decision too
    const third = keys.take('pack-1');
    expect(third).not.toBe(second);

    // A 500 may have acted before it failed: the retry must let the server answer for it.
    keys.settle('pack-1', 500);
    expect(keys.take('pack-1')).toBe(third);
  });

  it('keeps one key per intent, so a failed click on one card never blocks another', () => {
    const keys = new IdempotencyKeys();
    const a = keys.take('pack-a');
    const b = keys.take('pack-b');
    expect(a).not.toBe(b);
    keys.settle('pack-a', 200);
    expect(keys.take('pack-b')).toBe(b);
  });
});
