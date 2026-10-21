import { PAID_COIN_SALES_ENABLED } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { type Me } from './api';
import {
  ONBOARDING_EXEMPT_PAGES,
  ONBOARDING_EXEMPT_PATHS,
  ONBOARDING_SCREENS,
  afterVerification,
  gatedPagePath,
  hasOnboardingStepLeft,
  hasOnlyReconsentLeft,
  interestIds,
  isOnboardingExempt,
  isOnboardingExemptPage,
  isReconsent,
  isRoutePage,
  isStepBack,
  leavingSkipsInterests,
  needsOnboarding,
  onboardingEntryPath,
  onboardingNext,
  onboardingPath,
  onboardingReturnReason,
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
/**
 * The three required steps done and the start Coin granted; the interests not answered — on the
 * notice or the interests screen right now, or left there (skipped, 오너 결정 2026-10-19 (2차) 5).
 */
const COMPLETED: Onboarding = {
  ...VERIFIED,
  nickname: true,
  completed: true,
  nextStep: null,
};
const DONE: Onboarding = { ...COMPLETED, interests: true };
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

/** A post page's address (#46): `/community/posts/<uuid>`. */
const POST_ID = '0b6f6c1e-3f7a-4c51-9d0e-6a1f2b3c4d5e';
const POST_PAGE = `/community/posts/${POST_ID}`;

describe('the pages exempt for a login-only action (오너 결정 2026-10-20)', () => {
  it('lists exactly the post page and MY 설정 (#41), each entry with its reason', () => {
    expect(ONBOARDING_EXEMPT_PAGES.map((page) => page.route)).toEqual([
      '/community/posts/[postId]',
      '/my/settings',
    ]);
    for (const page of ONBOARDING_EXEMPT_PAGES) expect(page.reason.trim()).not.toBe('');
  });

  it('matches a route segment for segment, a dynamic one to any value but an empty one', () => {
    expect(isRoutePage(POST_PAGE, '/community/posts/[postId]')).toBe(true);
    expect(isRoutePage('/community/posts/not-a-uuid', '/community/posts/[postId]')).toBe(true);
    expect(isRoutePage('/my/proposals', '/my/proposals')).toBe(true);
    for (const path of [
      '/community/posts/',
      '/community/posts',
      `${POST_PAGE}/edit`,
      `${POST_PAGE}/`,
      `/community/postsx/${POST_ID}`,
      `/x/community/posts/${POST_ID}`,
      '/community',
    ]) {
      expect(isRoutePage(path, '/community/posts/[postId]'), path).toBe(false);
    }
  });

  it('is the post page — its own and anybody else’s — and nothing under it or beside it', () => {
    expect(isOnboardingExemptPage(POST_PAGE)).toBe(true);
    // Not exempt for every account, as the auth and legal screens are.
    expect(isOnboardingExempt(POST_PAGE)).toBe(false);
    for (const path of [
      `${POST_PAGE}/edit`,
      '/community',
      '/community/write',
      '/community/posts',
      `/markets/btc-100k`,
    ]) {
      expect(isOnboardingExemptPage(path), path).toBe(false);
    }
  });

  it('tells a re-consent alone from an onboarding not finished (3차 답 1)', () => {
    expect(hasOnlyReconsentLeft(RECONSENT)).toBe(true);
    for (const onboarding of [FRESH, CONSENTED, VERIFIED, COMPLETED, DONE, undefined]) {
      expect(hasOnlyReconsentLeft(onboarding), String(onboarding?.nextStep)).toBe(false);
    }
    // Agreed once, left before the 본인확인, then a revision: the consent again, but the
    // onboarding was never finished.
    const agreedThenLeft: Onboarding = { ...CONSENTED, consent: false, nextStep: 'consent' };
    expect(isReconsent(agreedThenLeft)).toBe(true);
    expect(hasOnlyReconsentLeft(agreedThenLeft)).toBe(false);
    // Verified too, the nickname not yet confirmed: the same.
    const verifiedThenLeft: Onboarding = { ...VERIFIED, consent: false, nextStep: 'consent' };
    expect(hasOnlyReconsentLeft(verifiedThenLeft)).toBe(false);
  });

  it('lets an account that finished once and faces a re-consent alone stay on a post page', () => {
    expect(needsOnboarding(POST_PAGE, RECONSENT)).toBe(false);
  });

  it('sends an account that has not finished its onboarding on from a post page, the page as next (3차 답 1)', () => {
    const agreedThenLeft: Onboarding = { ...CONSENTED, consent: false, nextStep: 'consent' };
    for (const onboarding of [FRESH, CONSENTED, VERIFIED, agreedThenLeft]) {
      expect(needsOnboarding(POST_PAGE, onboarding), String(onboarding.nextStep)).toBe(true);
    }
    // Every auth screen goes back to `next` (the nav's 로그인·가입하기 carry the post page): the gate
    // there takes a new account to its first step, which comes back to the post page once done
    // (#57-9).
    const path = onboardingPath(gatedPagePath(POST_PAGE, { pathname: POST_PAGE, search: '' }));
    expect(path).toBe(`/onboarding?next=${encodeURIComponent(POST_PAGE)}`);
    expect(onboardingNext(new URL(path, 'https://x.invalid').searchParams.get('next'))).toBe(
      POST_PAGE,
    );
  });

  it('still sends a re-consent on from the write and edit screens and the community list', () => {
    for (const onboarding of [FRESH, RECONSENT]) {
      for (const path of [`${POST_PAGE}/edit`, '/community/write', '/community']) {
        expect(needsOnboarding(path, onboarding), path).toBe(true);
      }
    }
  });

  it('never redirects from a post page while the onboarding is not known, or with nothing left', () => {
    expect(needsOnboarding(POST_PAGE, undefined)).toBe(false);
    expect(needsOnboarding(POST_PAGE, COMPLETED)).toBe(false);
    expect(needsOnboarding(POST_PAGE, DONE)).toBe(false);
  });
});

describe('MY 설정 for an account facing a re-consent (#41, 오너 결정 2026-10-21 답 2)', () => {
  it('is MY 설정 alone — not MY, its other tabs or anything under MY 설정', () => {
    expect(isOnboardingExemptPage('/my/settings')).toBe(true);
    // Not exempt for every account, as the auth and legal screens are.
    expect(isOnboardingExempt('/my/settings')).toBe(false);
    for (const path of ['/my', '/my/wallet', '/my/posts', '/my/settings/x', '/my/settingsx']) {
      expect(isOnboardingExemptPage(path), path).toBe(false);
    }
  });

  it('lets an account that finished once and faces a re-consent alone stay there, to clear its 소개 and categories', () => {
    expect(needsOnboarding('/my/settings', RECONSENT)).toBe(false);
    // MY's other screens still send it on.
    for (const path of ['/my', '/my/wallet', '/my/posts']) {
      expect(needsOnboarding(path, RECONSENT), path).toBe(true);
    }
  });

  it('sends an account that has not finished its onboarding on from it, MY 설정 as next', () => {
    const agreedThenLeft: Onboarding = { ...CONSENTED, consent: false, nextStep: 'consent' };
    for (const onboarding of [FRESH, CONSENTED, VERIFIED, agreedThenLeft]) {
      expect(needsOnboarding('/my/settings', onboarding), String(onboarding.nextStep)).toBe(true);
    }
    expect(onboardingPath('/my/settings')).toBe('/onboarding?next=%2Fmy%2Fsettings');
  });

  it('takes a re-consent’s new value to the step, which comes back to MY 설정', () => {
    const path = onboardingEntryPath('/my/settings', RECONSENT);
    expect(path).toBe('/onboarding?next=%2Fmy%2Fsettings');
    expect(onboardingNext(new URL(path, 'https://x.invalid').searchParams.get('next'))).toBe(
      '/my/settings',
    );
    expect(onboardingEntryPath('/my/settings', DONE)).toBe('/my/settings');
  });
});

describe('the write and edit entries on an exempt page', () => {
  const edit = `${POST_PAGE}/edit`;

  it('tells a step left from nothing left and from not known', () => {
    for (const onboarding of [FRESH, CONSENTED, VERIFIED, RECONSENT]) {
      expect(hasOnboardingStepLeft(onboarding)).toBe(true);
    }
    expect(hasOnboardingStepLeft(COMPLETED)).toBe(false);
    expect(hasOnboardingStepLeft(DONE)).toBe(false);
    expect(hasOnboardingStepLeft(undefined)).toBe(false);
  });

  it('go to the remaining step, which comes back to the form once done', () => {
    const path = onboardingEntryPath(edit, RECONSENT);
    expect(path).toBe(`/onboarding?next=${encodeURIComponent(edit)}`);
    const next = new URL(path, 'https://x.invalid').searchParams.get('next');
    expect(onboardingNext(next)).toBe(edit);
    // The query of the form's page rides along (a new post's market).
    expect(onboardingEntryPath('/community/write?market=abc', FRESH)).toBe(
      '/onboarding?next=%2Fcommunity%2Fwrite%3Fmarket%3Dabc',
    );
  });

  it('go to the form itself with nothing left, or while the onboarding is not known', () => {
    expect(onboardingEntryPath(edit, DONE)).toBe(edit);
    expect(onboardingEntryPath(edit, COMPLETED)).toBe(edit);
    // The form's own page is gated: it decides once `GET /me` has answered.
    expect(onboardingEntryPath(edit, undefined)).toBe(edit);
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

  it('never sends an onboarded account back for the interest categories (2차 5)', () => {
    // Shown once, after the notice; an account that left before answering them skipped them.
    expect(COMPLETED.completed).toBe(true);
    expect(needsOnboarding('/', COMPLETED)).toBe(false);
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
  const visit = { reachedNickname: false, noticeRead: false };
  const afterNickname = { reachedNickname: true, noticeRead: false };

  it("follows the server's next step, in the owner's order (decision 4 #58)", () => {
    expect(ONBOARDING_SCREENS).toEqual([
      'consent',
      'verification',
      'nickname',
      'notice',
      'interests',
    ]);
    expect(onboardingScreen(FRESH, visit)).toBe('consent');
    expect(onboardingScreen(CONSENTED, visit)).toBe('verification');
    expect(onboardingScreen(VERIFIED, visit)).toBe('nickname');
    expect(onboardingScreen(RECONSENT, visit)).toBe('consent');
    // The server's step comes first whatever the visit holds.
    expect(onboardingScreen(RECONSENT, { reachedNickname: true, noticeRead: true })).toBe(
      'consent',
    );
  });

  it('shows the notice after the nickname step of this visit, then the interests (#57-7, #57-10)', () => {
    expect(onboardingScreen(COMPLETED, afterNickname)).toBe('notice');
    expect(onboardingScreen(COMPLETED, { reachedNickname: true, noticeRead: true })).toBe(
      'interests',
    );
    // Answered or skipped: nothing left.
    expect(onboardingScreen(DONE, { reachedNickname: true, noticeRead: true })).toBeNull();
  });

  it('shows neither to an account that arrives with the three done: they were skipped (2차 5)', () => {
    // It left at the notice or the interests, or it is back after a re-consent.
    expect(onboardingScreen(COMPLETED, visit)).toBeNull();
    expect(onboardingScreen(COMPLETED, { reachedNickname: false, noticeRead: true })).toBeNull();
    expect(onboardingScreen(DONE, visit)).toBeNull();
  });
});

describe('leavingSkipsInterests (owner decision 2026-10-21 (2nd) answer 2)', () => {
  it('skips the interests step when the notice or the interests screen is left unanswered', () => {
    expect(leavingSkipsInterests('notice', false)).toBe(true);
    expect(leavingSkipsInterests('interests', false)).toBe(true);
  });

  it('does not while the step’s own answer is on its way, nor before or after the step', () => {
    // The pick or the 건너뛰기 sent answers the step itself.
    expect(leavingSkipsInterests('notice', true)).toBe(false);
    expect(leavingSkipsInterests('interests', true)).toBe(false);
    // The three steps: the step not reached. Null: nothing left — the step answered.
    for (const screen of ['consent', 'verification', 'nickname', null] as const) {
      expect(leavingSkipsInterests(screen, false)).toBe(false);
    }
  });
});

describe('why the account is on an earlier step (오너 결정 2026-10-19 (2차) 6)', () => {
  it('tells a step back from a step forward', () => {
    expect(isStepBack('nickname', 'consent')).toBe(true);
    expect(isStepBack('interests', 'consent')).toBe(true);
    expect(isStepBack('notice', 'verification')).toBe(true);
    expect(isStepBack('consent', 'verification')).toBe(false);
    expect(isStepBack('nickname', 'nickname')).toBe(false);
    expect(isStepBack(null, 'consent')).toBe(false);
    expect(isStepBack('nickname', null)).toBe(false);
  });

  it('says a re-consent on its consent step, however the account got there', () => {
    expect(isReconsent(RECONSENT)).toBe(true);
    expect(isReconsent(FRESH)).toBe(false);
    expect(isReconsent(DONE)).toBe(false);
    expect(onboardingReturnReason(RECONSENT, 'consent', false)).toBe('reconsent');
    expect(onboardingReturnReason(RECONSENT, 'consent', true)).toBe('reconsent');
    // An account that declined the marketing only agreed to nothing required: not a re-consent.
    expect(isReconsent({ ...FRESH, consents: [agreed('marketing', false)] })).toBe(false);
  });

  it('says to finish the earlier step when the server sent the account back to it', () => {
    expect(onboardingReturnReason(CONSENTED, 'verification', true)).toBe('earlier_step');
    expect(onboardingReturnReason(FRESH, 'consent', true)).toBe('earlier_step');
  });

  it('says nothing where the account was going anyway', () => {
    expect(onboardingReturnReason(FRESH, 'consent', false)).toBeNull();
    expect(onboardingReturnReason(VERIFIED, 'nickname', false)).toBeNull();
    expect(onboardingReturnReason(COMPLETED, null, true)).toBeNull();
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
      publicId: 'k7m2p9qx4z',
      nickname: 'user_ab12',
      role: 'user',
      createdAt: '2026-10-18T00:00:00.000Z',
      timeZone: 'America/New_York',
      nicknameChangeAvailableAt: null,
      interestCategoryIds: [],
      bio: null,
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
