/**
 * PLAN M6 "보안: … 관리자 라우트 감사 로그 완전성 확인".
 *
 * The individual suites already prove that each admin write leaves the RIGHT `admin_actions`
 * row — `admin.controller.test.ts` for the balance adjustment, `charge-package.controller.test`
 * and `coupon.controller.test` for the catalogue, `admin-markets.controller.test` and
 * `admin-markets-resolve.controller.test` for the market transitions,
 * `related-markets.controller.test` for the links between markets,
 * `release-settings.controller.test` for the release settings,
 * `admin-accounts.controller.test` for the admin grants and revokes and
 * `notices.controller.test` for the notices' writes, pins and unpins. What none of them can
 * prove is COMPLETENESS: they assert about routes that exist, so an admin write added tomorrow
 * with no audit row would break nothing.
 *
 * This closes that. It discovers every admin route from the module graph — not from a list
 * maintained here — and requires each state-changing one to name the `ADMIN_ACTION_TYPES` value
 * it writes. A new admin mutation fails this test until someone writes down what it records,
 * and a `ADMIN_ACTION_TYPES` value that no route produces fails it too, so the enum cannot
 * drift into fiction either.
 *
 * Static, and deliberately: it reads route metadata, so it needs no Postgres, no Redis and no
 * file lock, and it runs in every environment.
 */
import { ADMIN_ACTION_TYPES, type AdminActionType } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { discoverRoutes, isAdminPath } from '../test/routes.js';

/**
 * What each state-changing admin route appends to `admin_actions`.
 *
 * A route may appear here only if the service behind it inserts that row IN THE SAME
 * TRANSACTION as the effect — an audit row that can commit without its effect, or the other way
 * round, is worse than none. Every entry below was checked against its `tx.insert(adminActions)`
 * call site.
 */
const AUDITED: Readonly<Record<string, AdminActionType>> = {
  'POST /admin/users/:id/balance-adjust': 'balance_adjust',
  'POST /admin/charge-packages': 'charge_package_create',
  'PATCH /admin/charge-packages/:id': 'charge_package_update',
  'DELETE /admin/charge-packages/:id': 'charge_package_delete',
  'POST /admin/coupons': 'coupon_create',
  'PATCH /admin/coupons/:id': 'coupon_update',
  'POST /admin/markets': 'market_create',
  'PATCH /admin/markets/:id': 'market_update',
  'POST /admin/markets/:id/open': 'market_open',
  'POST /admin/markets/:id/close': 'market_close',
  'POST /admin/markets/:id/resolve': 'market_resolve',
  'POST /admin/markets/:id/related': 'market_link',
  'DELETE /admin/markets/:id/related/:relatedMarketId': 'market_unlink',
  'POST /admin/payments/:id/refund': 'payment_refund',
  'PATCH /admin/release-settings/:key': 'release_setting_change',
  'POST /admin/admins': 'admin_grant',
  'POST /admin/admins/:userId/revoke': 'admin_revoke',
  'POST /admin/notices': 'notice_create',
  'PUT /admin/notices/:noticeId': 'notice_update',
  'POST /admin/notices/:noticeId/pin': 'notice_pin',
  'POST /admin/notices/:noticeId/unpin': 'notice_unpin',
};

const adminRoutes = discoverRoutes().filter((route) => isAdminPath(route.path));
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

describe('admin audit log completeness', () => {
  it('finds the admin surface at all', () => {
    // A guard on the discovery itself: if the walk broke, every assertion below would pass
    // vacuously and this test would go on reporting success while checking nothing.
    expect(adminRoutes.length).toBeGreaterThanOrEqual(15);
    expect(adminRoutes.map((route) => route.key)).toContain('POST /admin/markets/:id/resolve');
  });

  it('records an admin_actions row for every state-changing admin route', () => {
    const unaudited = adminRoutes
      .filter((route) => !SAFE_METHODS.has(route.method))
      .filter((route) => AUDITED[route.key] === undefined)
      .map((route) => route.key);
    expect(unaudited).toEqual([]);
  });

  it('leaves read-only admin routes unaudited, on purpose', () => {
    // PLAN 6.2/12 specify an ACTION log, not an access log. Logging reads would multiply the
    // writes of a list route by its page count and record nothing that changed; if the owner
    // ever wants admin reads recorded, that is a new ADMIN_ACTION_TYPES value and a decision
    // about write amplification, not an oversight to fix quietly.
    const audited = adminRoutes
      .filter((route) => SAFE_METHODS.has(route.method))
      .filter((route) => AUDITED[route.key] !== undefined);
    expect(audited).toEqual([]);
  });

  it('uses every ADMIN_ACTION_TYPES value exactly once', () => {
    const used = Object.values(AUDITED);
    // Every type is produced by some route: a value nothing writes is a value a reader of the
    // enum would look for in the audit log and never find.
    expect([...used].sort()).toEqual([...ADMIN_ACTION_TYPES].sort());
    expect(new Set(used).size).toBe(used.length);
  });

  it('audits nothing outside /admin', () => {
    const keys = new Set(adminRoutes.map((route) => route.key));
    expect(Object.keys(AUDITED).filter((key) => !keys.has(key))).toEqual([]);
  });
});
