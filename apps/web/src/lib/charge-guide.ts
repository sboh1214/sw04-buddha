import { uuidSchema } from '@buddha/shared';
import type { UrlObject } from 'url';

/**
 * Pure helpers for the public `/charge` page (ADR-0044) and the wallet link it leads to, kept
 * out of the pages so they can be tested without a DOM (vitest runs in node here).
 */

/** How many package pictures there are (`package-illustration.tsx`), smallest first. */
export const CHARGE_TIER_COUNT = 4;

export type ChargeTier = 0 | 1 | 2 | 3;

function compareBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The picture tier of each package, in the order given: its rank among the DISTINCT Coin amounts
 * on sale, spread over the four tiers so the smallest package always gets the single coin and
 * the largest always the three stacks, whatever the admin put in the catalogue (ADR-0026 lets
 * them define any number of packages at any amounts). Relative rather than fixed thresholds on
 * purpose: a threshold picked today would give every package the same picture the day the
 * catalogue moves, and the picture's only job is "bigger package, bigger pile".
 *
 * Two packages with the same amount share a tier. One distinct amount is tier 0.
 */
export function chargeTiers(amounts: readonly bigint[]): ChargeTier[] {
  const distinct = [...new Set(amounts)].sort(compareBigint);
  const last = distinct.length - 1;
  return amounts.map((amount) => {
    if (last <= 0) return 0;
    const rank = distinct.indexOf(amount);
    return Math.round((rank * (CHARGE_TIER_COUNT - 1)) / last) as ChargeTier;
  });
}

// ---- the wallet link ------------------------------------------------------------------

/**
 * Where a package's 충전하기 leads: the wallet with that package preselected (`?package=<id>`,
 * read back by walletPackageId). An anonymous visitor is sent on to the login page by the
 * wallet itself. A `UrlObject` rather than a template string, so typed routes check `/wallet`
 * without an `as Route` cast.
 */
export function walletPackageHref(packageId: string): UrlObject {
  return { pathname: '/wallet', query: { package: packageId } };
}

/**
 * The package `/wallet?package=` names: a uuid, lower-cased as the API answers it. Anything
 * else is ignored — junk, or a repeated parameter (an array), which no link of ours builds and
 * which is not read by position.
 */
export function walletPackageId(value: string | string[] | undefined): string | undefined {
  const parsed = uuidSchema.safeParse(typeof value === 'string' ? value : undefined);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Where an anonymous `/wallet` visit goes: the login page, told to come back to the same
 * package, so the one chosen on `/charge` is still the chosen one after signing in. Only the
 * parsed id travels, so nothing a crafted link adds rides into `next`; the login page re-checks
 * it with `safeNextPath`.
 */
export function walletLoginPath(packageId: string | undefined): string {
  return packageId === undefined
    ? '/login?next=/wallet'
    : `/login?next=${encodeURIComponent(`/wallet?package=${packageId}`)}`;
}
