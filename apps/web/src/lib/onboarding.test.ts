import { PAID_COIN_SALES_ENABLED } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_EXEMPT_PATHS,
  gatedPagePath,
  isOnboardingExempt,
  needsOnboarding,
  onboardingNext,
  onboardingPath,
} from './onboarding';

const CONTACT = { realName: '홍길동', phone: '01012345678' };

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
    expect(needsOnboarding('/charge', null)).toBe(!PAID_COIN_SALES_ENABLED);
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
  it('redirects a signed-in account without a contact from a gated page', () => {
    expect(needsOnboarding('/', null)).toBe(true);
    expect(needsOnboarding('/my/wallet', null)).toBe(true);
    expect(needsOnboarding('/admin/markets', null)).toBe(true);
  });

  it('never redirects from an exempt page — no loop through /onboarding', () => {
    expect(needsOnboarding('/onboarding', null)).toBe(false);
    expect(needsOnboarding('/set-password', null)).toBe(false);
    expect(needsOnboarding('/privacy', null)).toBe(false);
  });

  it('never redirects while the answer is unknown, or once the account has a contact', () => {
    expect(needsOnboarding('/my/wallet', undefined)).toBe(false);
    expect(needsOnboarding('/my/wallet', CONTACT)).toBe(false);
    expect(needsOnboarding('/admin/users', CONTACT)).toBe(false);
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
