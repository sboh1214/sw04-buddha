import { PAID_COIN_SALES_ENABLED } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { type Me } from './api';
import {
  ONBOARDING_EXEMPT_PATHS,
  ONBOARDING_SCREENS,
  afterVerification,
  gatedPagePath,
  interestIds,
  isOnboardingExempt,
  needsOnboarding,
  onboardingNext,
  onboardingPath,
  onboardingScreen,
  startGrantNotice,
  takeOnboardingAnswer,
  withInterest,
  type Onboarding,
} from './onboarding';

/** A consent answer as `GET /me` lists it. */
const agreed = (item: 'terms' | 'privacy' | 'age' | 'marketing', value = true) => ({
  item,
  version: 'draft-2026-10-18',
  agreed: value,
  recordedAt: '2026-10-18T00:00:00.000Z',
});
const CONSENTS = [agreed('terms'), agreed('privacy'), agreed('age'), agreed('marketing', false)];

/** `GET /me`'s `onboarding` at each point of the owner's order (ADR-0069 decision 4 #58). */
const FRESH: Onboarding = {
  consent: false,
  verification: false,
  nickname: false,
  completed: false,
  interests: false,
  nextStep: 'consent',
  consents: [],
};
const CONSENTED: Onboarding = {
  ...FRESH,
  consent: true,
  nextStep: 'verification',
  consents: CONSENTS,
};
const VERIFIED: Onboarding = { ...CONSENTED, verification: true, nextStep: 'nickname' };
/** The three required steps done and the start Coin granted; the interests not answered yet. */
const COMPLETED: Onboarding = {
  ...VERIFIED,
  nickname: true,
  completed: true,
  nextStep: 'interests',
};
const DONE: Onboarding = { ...COMPLETED, interests: true, nextStep: null };
/** Done once, then a revision that changed members' rights asked for the consent again (#57-5). */
const RECONSENT: Onboarding = { ...DONE, consent: false, completed: false, nextStep: 'consent' };

describe('isOnboardingExempt', () => {
  it('lists exactly the routes ADR-0043 names, plus /api', () => {
    expect([...ONBOARDING_EXEMPT_PATHS].sort()).toEqual(
      [
        '/api',
        // The public charge guide, only while paid Coin is on sale (ADR-0049).
        ...(PAID_COIN_SALES_ENABLED ? ['/charge'] : []),
        '/login',
        '/onboarding',
        '/privacy',
        '/refund',
        '/reset-password',
        '/set-password',
        '/signup',
        '/terms',
      ].sort(),
    );
  });

  it('exempts each route and its subtree', () => {
    for (const path of [
      '/onboarding',
      '/login',
      '/signup',
      '/set-password',
      '/reset-password',
      '/terms',
      '/privacy',
      '/refund',
      '/terms/',
      '/reset-password/confirm',
      '/api/auth/callback/kakao',
      '/api/auth/sign-out',
      '/api/v1/me',
    ]) {
      expect(isOnboardingExempt(path), path).toBe(true);
    }
  });

  it('exempts /charge only while paid Coin is on sale: it is not found otherwise', () => {
    expect(isOnboardingExempt('/charge')).toBe(PAID_COIN_SALES_ENABLED);
    expect(needsOnboarding('/charge', FRESH)).toBe(!PAID_COIN_SALES_ENABLED);
  });

  it('does not exempt a look-alike prefix or any other screen, /admin included', () => {
    for (const path of [
      '/',
      '/my',
      '/my/wallet',
      '/my/settings',
      '/community',
      '/markets/btc-100k',
      '/admin/users',
      '/admin/payments',
      '/termsx',
      '/loginx',
      '/charges',
      '/apis',
      '/onboardingx',
    ]) {
      expect(isOnboardingExempt(path), path).toBe(false);
    }
  });
});

describe('needsOnboarding', () => {
  it('redirects a signed-in account with any step left from a gated page', () => {
    for (const onboarding of [FRESH, CONSENTED, VERIFIED, RECONSENT]) {
      expect(needsOnboarding('/', onboarding), String(onboarding.nextStep)).toBe(true);
      expect(needsOnboarding('/my/wallet', onboarding)).toBe(true);
      expect(needsOnboarding('/admin/markets', onboarding)).toBe(true);
    }
  });

  it('holds an onboarded account until it answers the interest categories (#57-7, #57-8)', () => {
    // The interests come after the start Coin and before the market; skipping is an answer.
    expect(COMPLETED.completed).toBe(true);
    expect(needsOnboarding('/', COMPLETED)).toBe(true);
    expect(needsOnboarding('/', DONE)).toBe(false);
  });

  it('never redirects from an exempt page — no loop through /onboarding', () => {
    expect(needsOnboarding('/onboarding', FRESH)).toBe(false);
    expect(needsOnboarding('/set-password', FRESH)).toBe(false);
    expect(needsOnboarding('/privacy', FRESH)).toBe(false);
    expect(needsOnboarding('/terms', RECONSENT)).toBe(false);
  });

  it('never redirects while the answer is unknown, or once nothing is left', () => {
    expect(needsOnboarding('/my/wallet', undefined)).toBe(false);
    expect(needsOnboarding('/my/wallet', DONE)).toBe(false);
    expect(needsOnboarding('/admin/users', DONE)).toBe(false);
  });

  it('leaves a held account the two screens with 로그아웃, and lets it go once signed out', () => {
    // MY holds the other 로그아웃 and is gated, so these two carry one (owner decision
    // 2026-10-13, #16).
    expect(needsOnboarding('/my', FRESH)).toBe(true);
    for (const path of ['/onboarding', '/set-password']) {
      expect(needsOnboarding(path, FRESH), path).toBe(false);
    }
    // `useSignOut` lands on home, where a signed-out tab asks no `GET /me`: the onboarding is
    // unknown.
    expect(needsOnboarding('/', undefined)).toBe(false);
  });
});

describe('onboardingNext', () => {
  it('keeps a same-origin path with its query string', () => {
    expect(onboardingNext('/my/wallet')).toBe('/my/wallet');
    expect(onboardingNext('/my/wallet?package=abc&result=failed')).toBe(
      '/my/wallet?package=abc&result=failed',
    );
    expect(onboardingNext('/admin/payments')).toBe('/admin/payments');
  });

  it('falls back to home for anything that is not a path on this origin', () => {
    for (const value of [
      undefined,
      null,
      '',
      'wallet',
      'https://evil.example/my/wallet',
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.com',
      '/\r\n//evil.com',
      'javascript:alert(1)',
    ]) {
      expect(onboardingNext(value), JSON.stringify(value)).toBe('/');
    }
  });

  it('refuses a repeated parameter rather than picking one', () => {
    expect(onboardingNext(['/my/wallet', '/my/settings'])).toBe('/');
  });

  it('never returns to /onboarding itself, however it is spelled', () => {
    for (const value of [
      '/onboarding',
      '/onboarding?next=/my/wallet',
      '/onboarding/',
      '/my/../onboarding',
      '/%6Fnboarding',
    ]) {
      expect(onboardingNext(value), value).toBe('/');
    }
    expect(onboardingNext('/onboardingx')).toBe('/onboardingx');
  });
});

describe('onboardingPath', () => {
  it('carries the page being left as an encoded next', () => {
    expect(onboardingPath('/my/wallet')).toBe('/onboarding?next=%2Fmy%2Fwallet');
    expect(onboardingPath('/my/wallet?package=abc')).toBe(
      '/onboarding?next=%2Fmy%2Fwallet%3Fpackage%3Dabc',
    );
    const next = new URL(onboardingPath('/markets/a?x=1&y=2'), 'https://x.invalid').searchParams;
    expect(next.get('next')).toBe('/markets/a?x=1&y=2');
    expect(onboardingNext(next.get('next'))).toBe('/markets/a?x=1&y=2');
  });

  it('drops a next that would only say "home" or that is not safe', () => {
    expect(onboardingPath('/')).toBe('/onboarding');
    expect(onboardingPath('//evil.example')).toBe('/onboarding');
    expect(onboardingPath('/onboarding?next=%2Fmy%2Fwallet')).toBe('/onboarding');
  });
});

describe('gatedPagePath', () => {
  it('adds the query string of the page the router reports', () => {
    expect(gatedPagePath('/my/wallet', { pathname: '/my/wallet', search: '?package=abc' })).toBe(
      '/my/wallet?package=abc',
    );
    expect(gatedPagePath('/my/wallet', { pathname: '/my/wallet', search: '' })).toBe('/my/wallet');
  });

  it('never borrows the query string of a different page', () => {
    expect(gatedPagePath('/my/wallet', { pathname: '/my/settings', search: '?error=x' })).toBe(
      '/my/wallet',
    );
  });
});

describe('onboardingScreen', () => {
  it("follows the server's next step, in the owner's order (decision 4 #58)", () => {
    expect(ONBOARDING_SCREENS).toEqual([
      'consent',
      'verification',
      'nickname',
      'notice',
      'interests',
    ]);
    expect(onboardingScreen(FRESH, false)).toBe('consent');
    expect(onboardingScreen(CONSENTED, false)).toBe('verification');
    expect(onboardingScreen(VERIFIED, false)).toBe('nickname');
    expect(onboardingScreen(RECONSENT, false)).toBe('consent');
  });

  it('shows the notice after the start Coin, then the interests once it is read (#57-7, #57-10)', () => {
    expect(onboardingScreen(COMPLETED, false)).toBe('notice');
    expect(onboardingScreen(COMPLETED, true)).toBe('interests');
    // An account that left at the notice or at the interests reads it again on its way back:
    // nothing on the server says it was read.
  });

  it('is null with nothing left, whatever was read', () => {
    expect(onboardingScreen(DONE, false)).toBeNull();
    expect(onboardingScreen(DONE, true)).toBeNull();
  });
});

describe('afterVerification', () => {
  it('marks the 본인확인 done and resumes at the nickname, as the server would answer', () => {
    expect(afterVerification(CONSENTED)).toEqual(VERIFIED);
  });

  it('works out completed and the next step with the shared rule, not a copy of it', () => {
    // A consent that stopped standing while the code was confirmed (a revision): still the consent.
    const consentGone: Onboarding = { ...CONSENTED, consent: false };
    expect(afterVerification(consentGone)).toMatchObject({
      verification: true,
      completed: false,
      nextStep: 'consent',
    });
  });

  it('leaves a verified account as it is (the real-name card writes through the same path)', () => {
    expect(afterVerification(DONE)).toBe(DONE);
    expect(afterVerification(COMPLETED)).toBe(COMPLETED);
  });
});

describe('takeOnboardingAnswer', () => {
  const held: Me = {
    id: 'user-1',
    email: 'a@example.com',
    emailVerified: true,
    profile: {
      nickname: 'user_ab12',
      role: 'user',
      createdAt: '2026-10-18T00:00:00.000Z',
      timeZone: 'America/New_York',
      nicknameChangeAvailableAt: null,
      interestCategoryIds: [],
    },
    balance: { availableCoin: '0', lockedCoin: '0' },
    linkedAccounts: [],
    verification: {
      realName: '홍길동',
      phone: '01012345678',
      verifiedAt: '2026-10-18T00:00:00.000Z',
    },
    startGrant: null,
    onboarding: VERIFIED,
  };
  /** A snapshot read after the write, with what a concurrent write changed meanwhile. */
  const answer: Me = {
    ...held,
    profile: {
      ...held.profile,
      nickname: '새닉네임',
      timeZone: 'Asia/Seoul',
      nicknameChangeAvailableAt: null,
      interestCategoryIds: [1, 3],
    },
    balance: { availableCoin: '10000', lockedCoin: '0' },
    startGrant: { status: 'granted', amountCoin: '10000', grantedAt: '2026-10-18T00:00:01.000Z' },
    onboarding: COMPLETED,
  };

  it('the consent step takes the onboarding only', () => {
    expect(takeOnboardingAnswer(held, answer, 'consent')).toEqual({
      ...held,
      onboarding: COMPLETED,
    });
  });

  it('the nickname step takes the onboarding, the nickname and the start Coin — not the balance', () => {
    const taken = takeOnboardingAnswer(held, answer, 'nickname');
    expect(taken.onboarding).toBe(COMPLETED);
    expect(taken.startGrant).toEqual(answer.startGrant);
    expect(taken.profile.nickname).toBe('새닉네임');
    // What other writes own stays: the zone, the categories, the balance (asked again instead).
    expect(taken.profile.timeZone).toBe('America/New_York');
    expect(taken.profile.interestCategoryIds).toEqual([]);
    expect(taken.balance).toEqual(held.balance);
  });

  it('the interests step takes the onboarding and the categories', () => {
    const taken = takeOnboardingAnswer(held, answer, 'interests');
    expect(taken.onboarding).toBe(COMPLETED);
    expect(taken.profile.interestCategoryIds).toEqual([1, 3]);
    expect(taken.profile.nickname).toBe('user_ab12');
    expect(taken.startGrant).toBeNull();
  });
});

describe('startGrantNotice', () => {
  it('says the amount once paid, the pending sentence while it waits, the used number, nothing without word', () => {
    expect(
      startGrantNotice({
        status: 'granted',
        amountCoin: '10000',
        grantedAt: '2026-10-18T00:00:00.000Z',
      }),
    ).toEqual({ kind: 'granted', amountCoin: 10000n });
    expect(startGrantNotice({ status: 'pending', amountCoin: null, grantedAt: null })).toEqual({
      kind: 'pending',
    });
    // The verified number's start Coin went to an earlier account (#57-1, 오너 결정 2026-10-19).
    expect(startGrantNotice({ status: 'number_used', amountCoin: null, grantedAt: null })).toEqual({
      kind: 'number_used',
    });
    // No word from the server (never after a completed nickname step): no amount line at all.
    expect(startGrantNotice(null)).toEqual({ kind: 'none' });
  });
});

describe('the interest categories', () => {
  const categories = [{ id: 5 }, { id: 1 }, { id: 12 }, { id: 3 }];

  it('picks top-level and sub-categories alike, any number (#57-7)', () => {
    let picked: ReadonlySet<number> = new Set();
    picked = withInterest(picked, 5, true);
    picked = withInterest(picked, 12, true);
    picked = withInterest(picked, 1, true);
    picked = withInterest(picked, 12, false);
    expect([...picked].sort((a, b) => a - b)).toEqual([1, 5]);
  });

  it('sends what is picked among the categories on screen, in id order', () => {
    expect(interestIds(new Set([12, 3, 99]), categories)).toEqual([3, 12]);
    // None: the skip.
    expect(interestIds(new Set(), categories)).toEqual([]);
  });
});
