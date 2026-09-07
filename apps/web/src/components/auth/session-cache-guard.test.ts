import { describe, expect, it } from 'vitest';
import {
  cacheOwnerAccount,
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
    // one `tradeAnswerScope` falls back to the cached `Me` for.
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
