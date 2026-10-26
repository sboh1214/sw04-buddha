/**
 * ADR-0092: every state-changing admin route names the admin the screen shows
 * (`expectedAccountId`) and checks it against the cookie's account before anything is read
 * (`assertExpectedAccount`). A tab whose session switched to another admin before
 * SessionCacheGuard reset its cache still draws the first admin's screen; a write from it would
 * otherwise be recorded as the second admin — a market opened, a notice pinned, a setting
 * changed by an admin the user was not looking at. The single suites prove the refusal route by
 * route; this one proves COMPLETENESS, as admin-audit.test.ts does for the audit rows: an admin
 * write added tomorrow without the account fails here until it takes one, or is written down
 * below with the reason it does not.
 *
 * Static: it reads route metadata and the handlers' code, so it needs no Postgres and no Redis.
 */
import { describe, expect, it } from 'vitest';
import { bodyKeysOf, discoverRoutes, isAdminPath, queryKeysOf } from '../test/routes.js';

/**
 * The admin writes that do not name the account yet, and why. Q-PG-8 ① (docs/QUESTIONS.md) holds
 * the balance adjustment and the refund for the decision before real PG integration (A-M2-11). The
 * third route it named, the manual settlement (`POST /admin/payments/:id/settle`), is gone with its
 * code (ADR-0049 결정 1-1) — there is nothing else to hold back.
 */
const NOT_YET: Readonly<Record<string, string>> = {
  'POST /admin/users/:id/balance-adjust': 'Q-PG-8 ①',
  'POST /admin/payments/:id/refund': 'Q-PG-8 ①',
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const writes = discoverRoutes()
  .filter((route) => isAdminPath(route.path))
  .filter((route) => !SAFE_METHODS.has(route.method));

describe('the admin on screen (ADR-0092)', () => {
  it('finds the admin writes at all', () => {
    // A guard on the discovery: a walk that found nothing would pass everything below.
    expect(writes.length).toBeGreaterThanOrEqual(40);
    expect(writes.map((route) => route.key)).toContain('POST /admin/markets/:id/open');
  });

  it('names the account in the body — or, for a DELETE, the query — of every admin write but those held back', () => {
    const unnamed = writes
      .filter((route) => {
        const keys = route.method === 'DELETE' ? queryKeysOf(route) : bodyKeysOf(route);
        return !keys.includes('expectedAccountId');
      })
      .map((route) => route.key)
      .sort();
    expect(unnamed).toEqual(Object.keys(NOT_YET).sort());
  });

  it('checks it in the handler, against the cookie’s account', () => {
    // The handler's code as the test runner loaded it: a call of the import, which the module
    // transform may write as `(0, __vite_ssr_import_N__.assertExpectedAccount)(…)`.
    const calls = /\bassertExpectedAccount\)?\(/;
    const unchecked = writes
      .filter((route) => NOT_YET[route.key] === undefined)
      .filter((route) => !calls.test(String(route.handler)))
      .map((route) => route.key);
    expect(unchecked).toEqual([]);
  });
});
