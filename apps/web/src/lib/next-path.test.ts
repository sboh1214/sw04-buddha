import { describe, expect, it } from 'vitest';
import { ADMIN_LOGIN_FALLBACK, adminLoginPath } from './next-path';

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
