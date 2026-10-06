import { describe, expect, it } from 'vitest';
import {
  type SessionIdentity,
  cacheOwnerAccount,
  claimCacheOwnership,
  rememberCacheOwner,
  sessionIdentityChanged,
} from './session-cache-guard';

describe('sessionIdentityChanged', () => {
  it('never fires on the first answer a tab sees', () => {
    // Resetting there would discard the queries every page load had just started.
    expect(sessionIdentityChanged(undefined, 'user-a')).toBe(false);
    expect(sessionIdentityChanged(undefined, null)).toBe(false);
  });

  it('fires when the account changes in any direction', () => {
    // A sign-out seen from another tab, a sign-in seen on the next focus, and a switch the
    // tab only notices once both have happened.
    expect(sessionIdentityChanged('user-a', null)).toBe(true);
    expect(sessionIdentityChanged(null, 'user-b')).toBe(true);
    expect(sessionIdentityChanged('user-a', 'user-b')).toBe(true);
  });

  it('stays quiet while the same account keeps answering', () => {
    expect(sessionIdentityChanged('user-a', 'user-a')).toBe(false);
    expect(sessionIdentityChanged(null, null)).toBe(false);
  });
});

describe('the published cache owner', () => {
  it('answers undefined until better-auth has answered in this tab', () => {
    // Read before anything is published — the state a tree without the guard stays in, and the
    // one `tradeAnswerScope` (use-trade.ts) falls back to the cached `Me` in.
    expect(cacheOwnerAccount()).toBeUndefined();
  });

  it('carries the account and the sign-out that follows it', () => {
    // The reading an in-flight mutation needs after its own component has unmounted: react
    // stops updating a pending mutation's options then, and the query cache is emptied by the
    // reset, so neither can say who the tab belongs to (`tradeAnswerScope`, use-trade.ts).
    rememberCacheOwner('user-1');
    expect(cacheOwnerAccount()).toBe('user-1');
    rememberCacheOwner('user-2');
    expect(cacheOwnerAccount()).toBe('user-2');
    // `null` is signed out, which is not the same as "not answered yet".
    rememberCacheOwner(null);
    expect(cacheOwnerAccount()).toBeNull();
  });
});

describe('claimCacheOwnership', () => {
  it('publishes the owner before it empties the caches', () => {
    // The ORDER is the fix. `resetQueries` blanks `['me']` as it goes, so an owner read after it
    // could only come from a cache that no longer names anybody — the window an in-flight trade
    // answer used to be waved through in (`tradeAnswerScope`, use-trade.ts).
    rememberCacheOwner('user-1');
    // Recorded rather than asserted inside the callback, so the case also fails if the reset
    // never runs at all instead of silently asserting nothing.
    const ownerAtReset: (SessionIdentity | undefined)[] = [];
    claimCacheOwnership('user-1', 'user-2', () => {
      ownerAtReset.push(cacheOwnerAccount());
    });
    expect(ownerAtReset).toEqual(['user-2']);
  });

  it('publishes the first answer a tab sees, which resets nothing', () => {
    // A tab that never switches accounts still has to name its owner: published only on a
    // CHANGE, `cacheOwnerAccount()` stays undefined for that tab's whole life and the gate
    // falls back to the cached `Me` it cannot trust.
    rememberCacheOwner(null);
    let reset = false;
    claimCacheOwnership(undefined, 'user-1', () => {
      reset = true;
    });
    expect(cacheOwnerAccount()).toBe('user-1');
    expect(reset).toBe(false);
  });

  it('still resets on a real change, in both directions', () => {
    let resets = 0;
    const count = () => {
      resets += 1;
    };
    claimCacheOwnership('user-1', null, count);
    claimCacheOwnership(null, 'user-2', count);
    claimCacheOwnership('user-2', 'user-2', count);
    expect(resets).toBe(2);
  });
});
