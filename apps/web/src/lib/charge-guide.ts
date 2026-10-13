/**
 * Pure helpers for the public `/charge` page (ADR-0044), kept out of the page so they can be
 * tested without a DOM (vitest runs in node here).
 */

/** How many package pictures there are (`package-illustration.tsx`), smallest first. */
export const CHARGE_TIER_COUNT = 4;

export type ChargeTier = 0 | 1 | 2 | 3;

function compareBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The picture tier of each package, in the order given: its rank among the DISTINCT P amounts
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
