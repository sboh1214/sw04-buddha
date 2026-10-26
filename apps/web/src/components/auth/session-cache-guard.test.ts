import { readFileSync } from 'node:fs';
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

describe('SessionCacheGuard and what its reset takes away (ADR-0092 결정 10, 8-36, 오너 결정 2026-10-26 21:00 답 1)', () => {
  it('records the account each answer names, and a turn before it resets the cache for it — until the reset’s reads settle', () => {
    // No component renders under node: the effect's order is pinned in the source. A form, a
    // comment box or the comment section going in the render the reset causes — `['me']` empty —
    // hears from `sessionAccountTurned` whom the session now names and that the reset for it is
    // under way (lib/session-account.ts): it keeps what it holds for the account it was drawn for
    // when that is another, or that account itself, `['me']` having turned to it first. An answer
    // that changes nothing — the first, or the same account — resets nothing and records no turn.
    const source = readFileSync(new URL('./session-cache-guard.tsx', import.meta.url), 'utf8');
    expect(source).toContain(
      "import { sessionAccountHeard, sessionAccountTurned } from '@/lib/session-account';",
    );
    expect(source).toMatch(
      /if \(identity === undefined\) return;\s+const previous = seen\.current;\s+seen\.current = identity;\s+if \(!sessionIdentityChanged\(previous, identity\)\) \{\s+sessionAccountHeard\(identity\);\s+return;\s+\}\s+(?:\/\/[^\n]*\n\s+)*const settled = sessionAccountTurned\(identity\);\s+void queryClient\.resetQueries\(\)\.then\(settled, settled\);/,
    );
    expect(source.match(/resetQueries\(/g)).toHaveLength(1);
  });
});
