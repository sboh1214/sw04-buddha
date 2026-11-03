import { formatCoin } from '@buddha/shared';
import { describe, expect, it, vi } from 'vitest';
import { copy } from './copy';
import {
  AUTH_ERROR,
  authErrorMessage,
  authNoticeFor,
  fetchOrNetworkError,
  safeNextPath,
  verifyLinkErrorCode,
} from './lib/auth-client';

describe('copy', () => {
  it('has the wallet notice: no cash exchange or withdrawal, and nothing about charging', () => {
    // N01 §2 in the plan's own words ('제공하지 않는다'); paid Coin is closed (ADR-0049).
    expect(copy.walletNotice).toContain('환전');
    expect(copy.walletNotice).toContain('출금');
    expect(copy.walletNotice).toContain('제공하지 않습니다');
    for (const word of ['충전', '결제', '쿠폰', '구매']) {
      expect(copy.walletNotice).not.toContain(word);
    }
  });

  it('promises no refund for a cancelled market or a 무효 result (N03 §6: not a cost refund)', () => {
    // #125 took the admin void and its cost refund away; since #174 a cancelled market ends with
    // no result, and a 무효 result is paid 50/50 by #126 — neither is a refund of what was spent.
    for (const text of [copy.marketCancelledNotice, copy.marketSettledPayoutVoid]) {
      expect(text).not.toContain('환불');
    }
  });

  it('never says 100 Coin for a 무효 result, which has no winning side (ADR-0093 decision 1)', () => {
    expect(copy.marketSettledPayout).toContain('100 Coin');
    expect(copy.marketSettledPayoutVoid).not.toContain('100');
    expect(copy.marketSettledPayoutVoid).not.toContain('정답');
  });

  it('labels every status as ADR-0093 decision 1 item 12 words it, and VOID as 무효', () => {
    // The user labels word for word; 초안 and 검수 중 are the admin's alone.
    expect([
      copy.marketStatusScheduled,
      copy.marketStatusOpen,
      copy.marketStatusPaused,
      copy.marketStatusClosed,
      copy.marketStatusProvisional,
      copy.marketStatusResolved,
      copy.marketStatusSettling,
      copy.marketStatusSettled,
      copy.marketStatusCancelled,
    ]).toEqual([
      '개장 예정',
      '거래 중',
      '거래 일시 중단',
      '거래 마감',
      '잠정 결과',
      '결과 확정',
      '지급 중',
      '지급 완료',
      '취소',
    ]);
    expect([copy.marketStatusDraft, copy.marketStatusReview]).toEqual(['초안', '검수 중']);
    expect(copy.marketResultVoid).toBe('무효');
  });

  it('has no empty strings (every key renders something)', () => {
    for (const [key, text] of Object.entries(copy)) {
      expect(text.trim(), key).not.toBe('');
    }
  });

  it('formats Coin via @buddha/shared (workspace wiring)', () => {
    expect(formatCoin(12345n)).toBe('12,345 Coin');
  });
});

describe('safeNextPath', () => {
  it('keeps same-origin paths', () => {
    expect(safeNextPath('/my/settings')).toBe('/my/settings');
    expect(safeNextPath('/markets/abc?x=1')).toBe('/markets/abc?x=1');
  });

  it('rejects absolute and protocol-relative targets', () => {
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
    expect(safeNextPath(undefined, '/x')).toBe('/x');
  });

  it('rejects control characters the URL parser would strip (tab/newline open redirect)', () => {
    // `?next=/%09/evil.com` decodes to '/\t/evil.com', which new URL() resolves to evil.com.
    expect(safeNextPath('/\t/evil.com')).toBe('/');
    expect(safeNextPath('/\n/evil.com')).toBe('/');
    expect(safeNextPath('/\r\n//evil.com')).toBe('/');
    expect(safeNextPath('/my/settings\\..')).toBe('/');
  });

  it('rejects a repeated ?next= (Next hands the page an array, not a string)', () => {
    // `/login?next=/a&next=/b` used to reach next.startsWith() and answer 500.
    expect(safeNextPath(['/a', '/b'])).toBe('/');
    expect(safeNextPath(['/a'], '/x')).toBe('/x');
    expect(safeNextPath([], '/x')).toBe('/x');
  });
});

describe('authErrorMessage', () => {
  it('maps known better-auth codes to Korean copy', () => {
    expect(authErrorMessage({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' })).toBe(
      copy.emailAlreadyUsed,
    );
    expect(authErrorMessage({ code: 'PROVIDER_NOT_FOUND' })).toBe(copy.socialUnavailable);
    expect(authErrorMessage({ code: 'FAILED_TO_UNLINK_LAST_ACCOUNT' })).toBe(copy.unlinkRefused);
  });

  it('never surfaces the English message: unknown codes use the fallback', () => {
    expect(authErrorMessage({ code: 'INVALID_EMAIL', message: 'English text' })).toBe(
      copy.errEmailInvalid,
    );
    expect(authErrorMessage({ code: 'SOMETHING_NEW', message: 'English text' })).toBe(
      copy.errUnknown,
    );
    expect(authErrorMessage({ code: 'SOMETHING_NEW' }, copy.signupFailed)).toBe(copy.signupFailed);
    expect(authErrorMessage({ status: 0, message: 'Failed to fetch' })).toBe(copy.errNetwork);
    expect(authErrorMessage(null)).toBe(copy.errUnknown);
  });
});

describe('authNoticeFor', () => {
  it('reports only the verify-email codes as a broken link', () => {
    expect(authNoticeFor('TOKEN_EXPIRED', copy.socialUnavailable)).toBe(copy.verifyLinkInvalid);
    expect(authNoticeFor('INVALID_TOKEN', copy.linkFailed)).toBe(copy.verifyLinkInvalid);
    expect(authNoticeFor('USER_NOT_FOUND', copy.linkFailed)).toBe(copy.verifyLinkInvalid);
    expect(authNoticeFor('INVALID_USER', copy.linkFailed)).toBe(copy.verifyLinkInvalid);
  });

  it('keeps OAuth failures on the social copy even when the code contains "user"', () => {
    // better-auth's OAuth callback emits these; a substring match on "user" would call them
    // an expired verification link.
    expect(authNoticeFor('unable_to_get_user_info', copy.socialUnavailable)).toBe(
      copy.socialUnavailable,
    );
    expect(authNoticeFor('unable_to_create_user', copy.linkFailed)).toBe(copy.linkFailed);
    expect(
      authNoticeFor(['link', 'account_already_linked_to_different_user'], copy.linkFailed),
    ).toBe(copy.linkAlreadyUsed);
    expect(authNoticeFor(['social', 'TOKEN_EXPIRED'], copy.socialUnavailable)).toBe(
      copy.verifyLinkInvalid,
    );
    expect(authNoticeFor(undefined, copy.linkFailed)).toBeUndefined();
  });
});

describe('fetchOrNetworkError', () => {
  // Without this wrapper better-fetch rejects on a transport failure, and every call site
  // (`const { error } = await ...` inside `void onSubmit(e)`) swallows it silently.
  it('turns a transport rejection into a response the UI can localize', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    try {
      const response = await fetchOrNetworkError('/api/auth/sign-in/email');
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ code: AUTH_ERROR.NETWORK });
      expect(authErrorMessage({ code: AUTH_ERROR.NETWORK, status: 503 })).toBe(copy.errNetwork);
    } finally {
      spy.mockRestore();
    }
  });

  it('re-throws an abort, which is a cancellation and not a network failure', async () => {
    const abort = new DOMException('This operation was aborted', 'AbortError');
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(abort);
    try {
      await expect(fetchOrNetworkError('/api/auth/get-session')).rejects.toBe(abort);
    } finally {
      spy.mockRestore();
    }
  });

  it('passes a real response through with its status and body intact', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"code":"INVALID_EMAIL_OR_PASSWORD"}', { status: 401 }));
    try {
      const response = await fetchOrNetworkError('/api/auth/sign-in/email');
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ code: 'INVALID_EMAIL_OR_PASSWORD' });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('verifyLinkErrorCode', () => {
  // /set-password renders its own notice and forwards the code to /login, so it must pick
  // the code that actually matched rather than whatever came first.
  it('returns the verify-link code better-auth redirects with', () => {
    expect(verifyLinkErrorCode('TOKEN_EXPIRED')).toBe('token_expired');
    expect(verifyLinkErrorCode('INVALID_TOKEN')).toBe('invalid_token');
    expect(verifyLinkErrorCode('USER_NOT_FOUND')).toBe('user_not_found');
    expect(verifyLinkErrorCode(['social', 'TOKEN_EXPIRED'])).toBe('token_expired');
  });

  it('stays undefined for everything that is not a broken link', () => {
    // Unlike authNoticeFor there is no fallback: an unknown code must not paint an alert on
    // a page that still works.
    expect(verifyLinkErrorCode(undefined)).toBeUndefined();
    expect(verifyLinkErrorCode('')).toBeUndefined();
    expect(verifyLinkErrorCode('unable_to_get_user_info')).toBeUndefined();
    expect(verifyLinkErrorCode('social')).toBeUndefined();
  });
});
