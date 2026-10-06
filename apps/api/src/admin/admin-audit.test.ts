/**
 * PLAN M6 "보안: … 관리자 라우트 감사 로그 완전성 확인".
 *
 * The individual suites already prove that each admin write leaves the RIGHT `admin_actions`
 * row — `admin.controller.test.ts` for the balance adjustment, `charge-package.controller.test`
 * and `coupon.controller.test` for the catalogue, `admin-markets.controller.test` and
 * `admin-markets-resolve.controller.test` for the market transitions. What none of them can
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
import { RequestMethod } from '@nestjs/common';
// From `constants.js`, not the package root: the root re-exports these names as TYPES only, so
// importing them from there compiles and then reads `Reflect.getMetadata(undefined, …)` at
// runtime — which answers `undefined` for every handler and turns this whole file into a test
// that discovers nothing and passes. The "finds the admin surface at all" case exists because
// that is exactly what happened while writing it.
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ADMIN_ACTION_TYPES, type AdminActionType } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';

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
  'POST /admin/markets/:id/void': 'market_void',
  'POST /admin/payments/:id/refund': 'payment_refund',
  'POST /admin/payments/:id/settle': 'payment_settle',
};

interface DiscoveredRoute {
  method: string;
  path: string;
  key: string;
}

/** Walks a module and everything it imports, collecting controller classes once each. */
function controllersOf(module: unknown, seen = new Set<unknown>()): unknown[] {
  // A module is either a CLASS (a function) or a DynamicModule (an object); rejecting one of
  // the two returns an empty list from the root and makes every assertion below vacuous.
  // Written as two inline `typeof`s and not through a variable: the variable form is not a
  // type guard, so `module` stays `unknown` and `Reflect.getMetadata` will not take it.
  if (module === null || (typeof module !== 'object' && typeof module !== 'function')) return [];
  if (seen.has(module)) return [];
  seen.add(module);
  // A DynamicModule (ConfigModule.forRoot(), ThrottlerModule.forRootAsync()) carries its
  // metadata as plain properties; a class module carries it as Reflect metadata.
  const dynamic = module as { module?: unknown; imports?: unknown[]; controllers?: unknown[] };
  const imports =
    dynamic.imports ??
    (Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) as unknown[] | undefined) ??
    [];
  const controllers =
    dynamic.controllers ??
    (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, module) as unknown[] | undefined) ??
    [];
  const nested = dynamic.module === undefined ? [] : controllersOf(dynamic.module, seen);
  return [
    ...controllers,
    ...nested,
    ...imports.flatMap((imported) => controllersOf(imported, seen)),
  ];
}

const METHOD_NAMES: Readonly<Record<number, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

/** Every route of every controller reachable from AppModule, as `METHOD /path`. */
function discoverRoutes(): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  for (const controller of controllersOf(AppModule)) {
    if (typeof controller !== 'function') continue;
    const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
    const prototype = (controller as { prototype: object }).prototype;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const handler = (prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const suffix = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (suffix === undefined) continue;
      const method = METHOD_NAMES[Reflect.getMetadata(METHOD_METADATA, handler) as number] ?? '?';
      const path = `/${[base, suffix === '/' ? '' : suffix].filter(Boolean).join('/')}`;
      routes.push({ method, path, key: `${method} ${path}` });
    }
  }
  return routes;
}

const adminRoutes = discoverRoutes().filter((route) => route.path.startsWith('/admin'));
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

describe('admin audit log completeness', () => {
  it('finds the admin surface at all', () => {
    // A guard on the discovery itself: if the walk broke, every assertion below would pass
    // vacuously and this test would go on reporting success while checking nothing.
    expect(adminRoutes.length).toBeGreaterThanOrEqual(20);
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
