import type { Route } from 'next';

/**
 * 서비스 안내 (#136, ADR-0177): its address and the anchors of its eight sections, the one place
 * a link to the guide is made from — the footer, the judging record's head, the market price
 * notice under the detail's chart and the first-order guide on 확인. The page itself is under the
 * route group `app/(service-guide)`, the only sources that may say what the product does not
 * offer (#113); this file is outside it and says nothing of the sort.
 */

/** The guide's address. Exempt from the onboarding gate (owner answer 136-6, lib/onboarding.ts). */
export const SERVICE_GUIDE_PATH = '/guide';

/**
 * The eight sections, in the order the page draws them; each is the `id` its section carries, so
 * `/guide#<anchor>` opens it whatever the order — the legal view's `${testId}-${index}` ids would
 * move with it (ADR-0177).
 */
export const SERVICE_GUIDE_ANCHORS = [
  'contract',
  'collateral',
  'orders',
  'market-price',
  'liquidity',
  'judgement',
  'void-cancel',
  'coin',
] as const;

export type ServiceGuideAnchor = (typeof SERVICE_GUIDE_ANCHORS)[number];

/**
 * The guide's address, opened at `anchor`'s section when one is named. Both are template strings
 * of the constant, so typed routes check `/guide` itself without an `as Route` cast.
 */
export function serviceGuideHref(anchor?: ServiceGuideAnchor): Route {
  return anchor === undefined ? SERVICE_GUIDE_PATH : `${SERVICE_GUIDE_PATH}#${anchor}`;
}
