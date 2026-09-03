import { formatP } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from './copy';
import { authErrorMessage, authNoticeFor, safeNextPath } from './lib/auth-client';

// PLAN Appendix A: gambling vocabulary must never appear in user-facing copy.
const FORBIDDEN_WORDS = ['베팅', '배당', '배당률', '승률', '판돈', '당첨'];

describe('copy', () => {
  it('has the wallet notice', () => {
    expect(copy.walletNotice).toContain('환전');
  });

  it('contains no forbidden gambling vocabulary', () => {
    for (const text of Object.values(copy)) {
      for (const word of FORBIDDEN_WORDS) {
        expect(text).not.toContain(word);
      }
    }
  });

  it('has no empty strings (every key renders something)', () => {
    for (const [key, text] of Object.entries(copy)) {
      expect(text.trim(), key).not.toBe('');
    }
  });

  it('formats P via @buddha/shared (workspace wiring)', () => {
    expect(formatP(12345n)).toBe('12,345P');
  });
});

describe('safeNextPath', () => {
  it('keeps same-origin paths', () => {
    expect(safeNextPath('/settings')).toBe('/settings');
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
    expect(safeNextPath('/settings\\..')).toBe('/');
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
