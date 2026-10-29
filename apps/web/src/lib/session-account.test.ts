import { describe, expect, it } from 'vitest';
import {
  accountForgottenInTab,
  accountNowOf,
  goesWithAccountTurn,
  sessionAccountHeard,
  sessionAccountTurned,
} from './session-account';

describe('the account the tab is for as something drawn for one account goes (ADR-0092 결정 10, 오너 결정 2026-10-26 21:00 답 1 «정순서에서도 A의 초안으로»)', () => {
  // SessionCacheGuard records each session answer before it resets the cache for it: a form, a
  // comment box or the comment section going in the reset's render — `['me']` empty — hears from
  // it the account the session turned to (the forward order).

  it('knows nobody before the session was heard, with `GET /me` empty', () => {
    // First in the file: the module as a page loads it.
    expect(accountNowOf(undefined)).toBeUndefined();
    expect(accountNowOf('account-a')).toBe('account-a');
    expect(goesWithAccountTurn('account-a', undefined)).toBe(false);
  });

  it('is `GET /me`’s account while the cache holds one — whatever the session says (the reverse order, ADR-0090 결정 4-2)', () => {
    sessionAccountHeard('account-a');
    expect(accountNowOf('account-b')).toBe('account-b');
    expect(goesWithAccountTurn('account-a', 'account-b')).toBe(true);
    sessionAccountHeard('account-b');
    expect(accountNowOf('account-a')).toBe('account-a');
    expect(goesWithAccountTurn('account-a', 'account-a')).toBe(false);
  });

  it('is the account the session names once SessionCacheGuard’s reset emptied the profile', () => {
    sessionAccountHeard('account-a');
    const settled = sessionAccountTurned('account-b');
    expect(accountNowOf(undefined)).toBe('account-b');
    expect(goesWithAccountTurn('account-a', undefined)).toBe(true);
    settled();
    // A turn whose reset is over: the profile empty again is not that turn — still the session's
    // account, and still another than A.
    expect(accountNowOf(undefined)).toBe('account-b');
    expect(goesWithAccountTurn('account-a', undefined)).toBe(true);
    sessionAccountHeard('account-a');
    expect(accountNowOf(undefined)).toBe('account-a');
  });

  it('is nobody once the session names nobody — a sign-out keeps nothing for anybody', () => {
    sessionAccountHeard('account-a');
    const settled = sessionAccountTurned(null);
    expect(accountNowOf(undefined)).toBeUndefined();
    expect(accountNowOf('account-a')).toBe('account-a');
    expect(goesWithAccountTurn('account-a', undefined)).toBe(false);
    settled();
  });
});

describe('the session catching up with the account `GET /me` turned to first (ADR-0092 8-36, 오너 결정 2026-10-26 21:00 답 1 «정순서에서도 A의 초안으로» — 어느 순서로 바뀌든)', () => {
  // A comes back to the tab the session turned to B: one `visibilitychange` reads both again, and
  // `GET /me` answers A first — the screen is drawn for A, and A's draft taken back out of the
  // tab — then the session says A, and SessionCacheGuard's reset takes that screen away again.
  // What goes then goes with the turn: kept as A's, and taken back when the screen is drawn for A
  // once more.

  it('goes with the turn while the reset for the writer is under way and the profile is empty', () => {
    sessionAccountTurned('account-b')();
    const settled = sessionAccountTurned('account-a');
    expect(accountNowOf(undefined)).toBe('account-a');
    expect(goesWithAccountTurn('account-a', undefined)).toBe(true);
    // The profile drawn again for A: no turn.
    expect(goesWithAccountTurn('account-a', 'account-a')).toBe(false);
    // Another account's is still another's.
    expect(goesWithAccountTurn('account-b', undefined)).toBe(true);
    settled();
    // The reset over, an empty profile with the session naming the writer is not a turn — the
    // tab's sign-out emptying the cache before the session says nobody.
    expect(goesWithAccountTurn('account-a', undefined)).toBe(false);
  });

  it('stays the turn a later reset is for: an earlier reset settling late changes nothing', () => {
    const first = sessionAccountTurned('account-b');
    const second = sessionAccountTurned('account-a');
    first();
    expect(goesWithAccountTurn('account-a', undefined)).toBe(true);
    second();
    expect(goesWithAccountTurn('account-a', undefined)).toBe(false);
  });

  it('is no turn once the tab forgot its account — its sign-out or 탈퇴 — nor an answer heard with no reset', () => {
    sessionAccountTurned('account-a');
    accountForgottenInTab();
    expect(accountNowOf(undefined)).toBeUndefined();
    expect(goesWithAccountTurn('account-a', undefined)).toBe(false);
    expect(goesWithAccountTurn('account-b', undefined)).toBe(false);
    // The profile still holding an account: as ever, `GET /me`'s account.
    expect(goesWithAccountTurn('account-a', 'account-b')).toBe(true);
    sessionAccountHeard('account-a');
    expect(goesWithAccountTurn('account-a', undefined)).toBe(false);
    expect(goesWithAccountTurn('account-b', undefined)).toBe(true);
  });
});
