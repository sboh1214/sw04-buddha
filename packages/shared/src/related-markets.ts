import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { uuidSchema } from './api/uuid.js';
import { type PublicMarketStatus, marketSummarySchema } from './market.js';

/**
 * 관련 시장 (#65, ADR-0068): markets an admin links to one another, shown on each other's detail.
 * Owner decisions (ADR-0061 decision 1, item 19; decision 3, the #65 rows): a link is two-way —
 * linking A to B shows B on A's detail and A on B's — with no cap on how many; a detail shows its
 * related markets in the open, closed, resolved and settled statuses, never a voided one or a
 * draft, in the home's 추천 order, as the home's market cards; with none to show the section stays
 * and says so. Only an admin links or unlinks (N03 §1), in any status of either market, and each
 * link or unlink records who and when alone — no reason, no second admin, no version, no alert.
 * A link touches nothing else: neither market's rules, trading, judgement nor settlement. It is
 * made now, apart from the Event unit #172 may bring.
 */

/**
 * The statuses a detail's 관련 시장 lists (ADR-0061 decision 1, item 19): open, closed, resolved
 * and settled — on screen their labels, 진행 중·거래 마감·판정 완료·정산 완료. Not `voided`, and
 * never `draft`, which no public route serves. #173·#174 revisit
 * this when the statuses change (ADR-0061 result 3).
 */
export const RELATED_MARKET_STATUSES = [
  'open',
  'closed',
  'resolved',
  'settled',
] as const satisfies readonly PublicMarketStatus[];
export type RelatedMarketStatus = (typeof RELATED_MARKET_STATUSES)[number];

/**
 * One link as `market_links` keeps it: the unordered pair, once, as its smaller and its larger id
 * (a CHECK holds `low < high`, migration 0027). Both ids are canonical lower-case uuids — the form
 * every request-supplied id is put in (`uuidSchema`) — and for those the string order here is the
 * byte order Postgres compares `uuid` values in, so this function and the CHECK agree on which is
 * which. `undefined` for a market paired with itself, which is not a link.
 */
export function relatedMarketPair(
  marketId: string,
  relatedMarketId: string,
): { lowMarketId: string; highMarketId: string } | undefined {
  const a = marketId.toLowerCase();
  const b = relatedMarketId.toLowerCase();
  if (a === b) return undefined;
  return a < b ? { lowMarketId: a, highMarketId: b } : { lowMarketId: b, highMarketId: a };
}

/**
 * `POST /admin/markets/:id/related`: the market to link with the one in the path, lower-cased on
 * the way in like every request-supplied uuid. The same market is refused (400 naming `marketId`)
 * and an unknown one is NOT_FOUND naming it; a link that exists already changes nothing.
 */
export const linkRelatedMarketBodySchema = z
  .object({ marketId: uuidSchema })
  .meta({ id: 'LinkRelatedMarketBody' });
export type LinkRelatedMarketBody = z.infer<typeof linkRelatedMarketBodySchema>;

/**
 * One row of the admin's 관련 시장 (`GET /admin/markets/:id/related` and the answer of a link or an
 * unlink): the linked market as the list row every screen draws (`MarketSummary`, with its status
 * — the admin sees every status, drafts and voided ones included) and who linked it when. What is
 * recorded is the actor and the time (ADR-0061 decision 1, item 19), so that is all there is.
 */
export const adminRelatedMarketSchema = marketSummarySchema
  .extend({
    /**
     * The admin who made the link, as every admin record names an account (`AdminAccountActor`):
     * the nickname the screen shows (owner decision 2026-10-17, ADR-0068) and the better-auth
     * `user.id` that stays the same when the nickname changes. The nickname is the account's
     * current one, read with the list — the link stores the id alone.
     */
    linkedBy: adminAccountActorSchema,
    linkedAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminRelatedMarket' });
export type AdminRelatedMarket = z.infer<typeof adminRelatedMarketSchema>;
