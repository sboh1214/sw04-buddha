import { describe, expect, it } from 'vitest';
import {
  ADMIN_LOGIN_FALLBACK,
  adminLoginPath,
  loginPathBackTo,
  loginPathBackToPage,
  safeNextPath,
} from './next-path';

const next = (url: string) => new URL(url, 'https://x.invalid').searchParams.get('next');

describe('adminLoginPath', () => {
  it('carries the admin page the visitor asked for', () => {
    expect(next(adminLoginPath('/admin/markets'))).toBe('/admin/markets');
    expect(next(adminLoginPath('/admin/markets/1f2e3d4c-0000-4000-8000-000000000000'))).toBe(
      '/admin/markets/1f2e3d4c-0000-4000-8000-000000000000',
    );
    expect(next(adminLoginPath('/admin/audit-failures'))).toBe('/admin/audit-failures');
  });

  it('drops the query string, so Next’s _rsc cache-buster never reaches the destination', () => {
    expect(next(adminLoginPath('/admin/payments?_rsc=8f2a1'))).toBe('/admin/payments');
    expect(next(adminLoginPath('/admin/markets?status=open'))).toBe('/admin/markets');
  });

  it('falls back to the user list when the header is missing or not an admin path', () => {
    for (const value of [null, undefined, '', '/', '/my/settings', '/my/wallet', 'admin/markets']) {
      expect(next(adminLoginPath(value)), JSON.stringify(value)).toBe(ADMIN_LOGIN_FALLBACK);
    }
  });

  it('refuses a spoofed header: the destination is always a path on this origin', () => {
    for (const value of [
      'https://evil.example/admin/markets',
      '//evil.example/admin/markets',
      '/\\evil.example',
      '/admin/markets\\..',
      '/\t/evil.com',
      '/\n/admin/markets',
    ]) {
      expect(next(adminLoginPath(value)), JSON.stringify(value)).toBe(ADMIN_LOGIN_FALLBACK);
    }
  });
});

describe('loginPathBackTo', () => {
  it('sends the visitor to the login page told to come back to the page they were on', () => {
    expect(loginPathBackTo('/markets/e2e-abc123')).toBe('/login?next=%2Fmarkets%2Fe2e-abc123');
    expect(next(loginPathBackTo('/markets/e2e-abc123'))).toBe('/markets/e2e-abc123');
    // A Korean slug, as the browser may hand it over (encoded) or as typed: either is one path,
    // and the login page's own `safeNextPath` takes it back unchanged.
    for (const path of ['/markets/%EA%B8%88%EB%A6%AC', '/markets/금리']) {
      expect(next(loginPathBackTo(path))).toBe(path);
      expect(safeNextPath(next(loginPathBackTo(path)))).toBe(path);
    }
  });

  it('drops a query string and refuses anything that is not a path on this origin', () => {
    expect(next(loginPathBackTo('/markets/x?tab=rules'))).toBe('/markets/x');
    for (const value of [null, undefined, '', 'https://evil.example/x', '//evil.example', '/\\x']) {
      expect(next(loginPathBackTo(value)), JSON.stringify(value)).toBe('/');
    }
  });
});

describe('loginPathBackToPage', () => {
  it('keeps the query string: the home’s 관심 시장 view is its query (ADR-0065)', () => {
    expect(loginPathBackToPage('/?watchlist=1')).toBe('/login?next=%2F%3Fwatchlist%3D1');
    expect(next(loginPathBackToPage('/?category=economy&sort=closing&watchlist=1'))).toBe(
      '/?category=economy&sort=closing&watchlist=1',
    );
    // The login page reads it back through the same gate, unchanged.
    expect(safeNextPath(next(loginPathBackToPage('/?watchlist=1')))).toBe('/?watchlist=1');
  });

  it('refuses anything that is not a path on this origin, as every destination', () => {
    for (const value of ['https://evil.example/?watchlist=1', '//evil.example', '/\\evil']) {
      expect(next(loginPathBackToPage(value)), value).toBe('/');
    }
  });
});
