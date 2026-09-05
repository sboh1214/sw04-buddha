import { describe, expect, it } from 'vitest';
import { sessionIdentityChanged } from './session-cache-guard';

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
