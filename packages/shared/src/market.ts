import * as z from 'zod';
import { cursorQuerySchema } from './api/pagination.js';
import { coinAmountSchema, serializeCoinAmount } from './api/coin-amount.js';
import { uuidParamSchema } from './api/path-param.js';
import {
  BP_MAX,
  INT4_MAX,
  MARKET_IMAGE_URL_MAX,
  MARKET_SEARCH_TERM_MAX,
  MARKET_SLUG_PATTERN,
  MARKET_SLUG_STEM_MAX,
  PRICE_MAX,
  PRICE_MIN,
  TICKS_MAX_POINTS,
} from './constants.js';
import { expectedAccountIdSchema, namesAFieldBesideAccount } from './expected-account.js';
import { marketTitleSchema, ruleItemFields, timeItemFields } from './market-fields.js';
import { adminMarketDisputesSchema } from './market-dispute.js';
import { adminMarketJudgementStateSchema, judgementVersionSchema } from './market-judgement.js';
import { adminJudgementDelaySchema, marketJudgementDelaySchema } from './market-judgement-delay.js';
import { openItemSchema } from './market-open-items.js';
import { MATCH_STOPS, type BookOrder } from './matching.js';
import {
  bookDepth,
  type ContractDepth,
  type MarketTradingFacts,
  type OrderQuoteFigures,
  type SellableFigures,
} from './order-book.js';
import {
  MARKET_STATUS_REJECT_REASONS,
  marketTradingRejectReason,
  priceProtectionTicksSchema,
} from './orders.js';
import { adminMarketPauseStateSchema } from './market-pause.js';
import { adminMarketReviewSchema } from './market-review.js';
import { marketRuleItemsSchema } from './market-rules.js';
import {
  adminMarketSupplementSchema,
  adminRuleVersionSchema,
  marketRuleVersionSchema,
  ruleVersionNumberSchema,
} from './market-supplement.js';
import { marketTimesSchema } from './market-times.js';
import { marketTagsSchema } from './tags.js';
import {
  type MarketStatus,
  marketEventTypeSchema,
  marketResultSchema,
  marketStatusSchema,
  orderSideSchema,
  orderCancelReasonSchema,
  orderRejectReasonSchema,
  orderStatusSchema,
  outcomeSchema,
  priceTickTriggerSchema,
  settlementStepSchema,
  settlementStepStatusSchema,
  timeInForceSchema,
} from './enums.js';

/**
 * Market, order, position and tick DTOs (PLAN 7.1–7.3; M3 design 1.5).
 *
 * Composition rules (zod 4): field maps are declared once and every DTO is built from them;
 * an object-level `.refine` always comes last and `.meta({ id })` after it; a refined object
 * is never `.pick`ed/`.partial`ed/`.omit`ted. Query DTOs carry NO `.meta({ id })`: swagger 12
 * expands an id-less `@Query({ schema })` object into one parameter per field by itself,
 * whereas a component id makes it emit no parameters, so only such a DTO (`cursorQuerySchema`)
 * needs `@ApiQuery` in the controller — never both, since openapi-export.ts fails on a
 * duplicate (name, in) pair.
 */

// ---- small reusable pieces ----------------------------------------------------------
const priceSchema = z.number().int().min(PRICE_MIN).max(PRICE_MAX);
const bpSchema = z.number().int().min(0).max(BP_MAX);
const countSchema = z.number().int().min(0);

// ---- categories ---------------------------------------------------------------------
/**
 * One row of the two-level tree `GET /categories` returns flat: a top-level category carries
 * `parentId: null`, a sub-category carries its parent's `id`. Flat rather than nested so the
 * shape is one object whatever the level and a client that only wants the leaves (the admin's
 * category select, a card's label) does not have to walk anything; `groupCategories` on the web
 * side builds the tree once. `sortOrder` orders siblings; the parent's order places the group.
 */
export const categorySchema = z
  .object({
    id: z.number().int(),
    slug: z.string(),
    nameKo: z.string(),
    sortOrder: z.number().int(),
    /** `null` for a top-level category; a sub-category names its parent's `id`. */
    parentId: z.number().int().nullable(),
  })
  .meta({ id: 'Category' });
export type Category = z.infer<typeof categorySchema>;

// ---- public market shapes -----------------------------------------------------------
const marketSummaryFields = {
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  category: z.object({ slug: z.string(), nameKo: z.string() }),
  imageUrl: z.string().nullable(),
  status: marketStatusSchema,
  /**
   * Whether the market reads '판정 지연' in place of its status label (ADR-0093 decision 1 #173
   * items 11–12, #22, ADR-0098, ADR-0104; `isJudgementDelayed`): CLOSED with its scheduled
   * judgement passed — in place of '거래 마감' — or PROVISIONAL with a 판정 이의 or a waiting 판정
   * 정정 still holding it once its 이의 기한 has come (#175, owner answer 2026-11-03; #176,
   * ADR-0105) — in place of '잠정 결과' and '이의 검토 중'. On the server's clock at the read, so
   * the card needs no time of its own. A display, not a status: nothing changes at that time, and
   * no list filters by it (ADR-0095 8-6). The detail adds the operator's reason and next review
   * time (`Market.judgementDelay`, #142).
   */
  judgementDelayed: z.boolean(),
  /**
   * Whether the market reads '이의 검토 중' in place of '잠정 결과' (#173 item 12, #175, ADR-0104;
   * `isDisputeUnderReview`): PROVISIONAL with a 판정 이의 of its current version pending or accepted
   * (`markets.dispute_hold_count`). `judgementDelayed`'s '판정 지연' comes first once the deadline
   * has passed. Never how many, nor whose (#24 publishes the count, #173 item 13).
   */
  disputeUnderReview: z.boolean(),
  /**
   * YES price 1..99 of the last fill (PLAN 5.3); null until the market's first fill, which a
   * client shows as '체결 없음' (N02 §5). #121 and #64 define the market's price fields.
   */
  lastPrice: priceSchema.nullable(),
  volumeCoin: coinAmountSchema,
  tradeCount: countSchema,
  /**
   * The 사용자 참여자 the card and the detail header show, 0 included (ADR-0061 decision 1, item
   * 4). Who counts is #177's to decide (13항: 사람 계정, admins included); #121 counts them with the
   * account-type rule (`isHumanAccountType`, `is_human_account` in SQL, #115), which leaves the
   * 운영 마켓메이커 out.
   */
  traderCount: countSchema,
  closeAt: z.iso.datetime(),
  openAt: z.iso.datetime().nullable(),
  /**
   * The judgement's result type (YES·NO·VOID, #174): null before a judgement publishes one and
   * on a CANCELLED market (ADR-0093 decision 1 item 10). Set when another admin approves the
   * judgement (CLOSED → PROVISIONAL, #152) — the provisional result is the judged one too
   * (ADR-0095 8-2) — and kept through its confirmation.
   */
  resolvedResult: marketResultSchema.nullable(),
  /**
   * The current judgement's version (#152, ADR-0103; `markets.judgement_version`): 1 from the
   * first approved judgement, one more per approved correction (#176, ADR-0105) — the one the
   * settlement follows (#126) and the one a 판정 이의 names (#175: refused as `stale_version`
   * otherwise). Public since #175 (#173 item 13 makes the versions public). Null until a judgement
   * is approved, and on a market the interim one-admin judgement resolved before #152 (D4: none
   * was recorded for those).
   */
  judgementVersion: judgementVersionSchema.nullable(),
  /**
   * 이의 기한 of the current judgement (#152; ADR-0093 decision 1 #173 items 5·6): fixed when the
   * approval published the provisional result — its instant plus the release setting
   * `market.dispute_window` read then — and never moved by a later change of the value; kept after
   * the confirmation. A correction's approval opens a new one of the same length from its instant
   * (#176, ADR-0105; #173 item 5). 판정 이의 are taken before it (`disputeOpen`), and the worker
   * confirms the result once it has passed with nothing holding (#175, #176). Public, to anonymous
   * visitors too (#173 item 6, ADR-0104). Null until a judgement is approved.
   */
  disputeDeadline: z.iso.datetime().nullable(),
  /**
   * Whether 판정 이의 are taken now (#175, ADR-0104; `isDisputeOpen`): PROVISIONAL and before
   * `disputeDeadline`, on the server's clock at the read. The detail shows the submission link
   * while it holds, and so do the discussion and the write screen (ADR-0093 decision 3 '#175
   * 토론의 이의 안내'); a screen's timer at the deadline takes them away, as nothing is published
   * then.
   */
  disputeOpen: z.boolean(),
  /**
   * `market_events.id` of the transition that produced the current status — or of the
   * `judgement_corrected` event of a correction approved since, which keeps the status (#176,
   * ADR-0105) — as a decimal string: the ordering key of `market:status` (A-M3-19, Q-M3-8 (3)).
   * Drawn while the writer holds the market row FOR UPDATE, so it is the market's commit order: a
   * client compares a snapshot against an event with `statusSupersedes` (realtime.ts) instead of
   * ranking statuses, which are no total order — PAUSED → OPEN goes back, and a correction in
   * PROVISIONAL republishes the same status with a new result. Null only for a row written
   * outside the transition paths (a test factory); the rank order is the fallback.
   */
  statusEventId: z.string().nullable(),
  createdAt: z.iso.datetime(),
};

/**
 * List card: the row of `GET /markets` and of `GET /admin/markets`. No list-only DTO sits
 * beside it any more — the card sparkline that made one (`MarketListItem`, ADR-0030) is gone
 * (ADR-0062). `volumeCoin` stays although the card no longer shows it: the detail header and
 * the admin screens do.
 */
export const marketSummarySchema = z.object(marketSummaryFields).meta({ id: 'MarketSummary' });
export type MarketSummary = z.infer<typeof marketSummarySchema>;

/**
 * Public detail (PLAN 7.1): no author, exposure or settlement steps — those are
 * `adminMarketSchema` only. The rule items (`marketRuleItemsSchema`, #23) and the market's times
 * and judgement time zone (`marketTimesSchema`, #22: the close is the summary's) are public in
 * every public status, signed in or not (N02 §2, N03 §4); cards carry none of them.
 */
export const marketSchema = z
  .object({
    ...marketSummaryFields,
    ...marketRuleItemsSchema.shape,
    ...marketTimesSchema.shape,
    /**
     * The market's tags (#17), in the order the operator entered them, each as its tag's stored
     * spelling — the one it was first made with. The detail shows them, each a link to its
     * exact-match search; cards do not (ADR-0093 decision 2 #172 item 2). 1..5 once the
     * open-items check has passed (the review submission requires them, #78); a draft may have
     * none, and so may a market opened before #17 deployed or a seed market an older seed
     * inserted without them.
     */
    tags: z.array(z.string()),
    /**
     * When the result was confirmed (→ RESOLVED): the worker's, once the dispute deadline passed
     * with no 판정 이의 holding it (#152, #175) — not the provisional result's publication. Null
     * before it.
     */
    resolvedAt: z.iso.datetime().nullable(),
    settledAt: z.iso.datetime().nullable(),
    /**
     * The current rule version (#80, ADR-0101; ADR-0093 decision 2 #172 items 6·7): 1 from the
     * open, one more per approved supplement, and the version the judgement follows. Null before
     * the open and on a market opened before #80 (D4: no versions were made for those).
     */
    ruleVersion: ruleVersionNumberSchema.nullable(),
    /**
     * Every rule version, the newest (the current one) first (decision 3 '#80 보충의 형태'): each
     * with its full text, the items it changed, the reason and the time, and nobody's name. Read in
     * the same snapshot as the rest of the detail; empty while `ruleVersion` is null.
     */
    ruleVersions: z.array(marketRuleVersionSchema),
    /**
     * 판정 지연 기록 (#142, ADR-0106; ADR-0093 decision 1 #173 items 11·13, decision 3 '#142 지연
     * 사유'): while the market reads '판정 지연' (`judgementDelayed`), its current record — the
     * newest an operator made on its current status and judgement version — as its reason, its
     * next review time and whether that has passed ('갱신 대기', owner answer 2026-11-03 (2)), on
     * the server's clock at the read (`marketJudgementDelayOf`). Null while the market does not
     * read '판정 지연', and while it has no such record: past its scheduled judgement it reads so
     * with none. Nobody's name, no record time and no earlier record (#24); cards carry none.
     */
    judgementDelay: marketJudgementDelaySchema.nullable(),
  })
  .meta({ id: 'Market' });
export type Market = z.infer<typeof marketSchema>;

/**
 * The statuses a user sees (ADR-0093 decision 1 item 12): every one but DRAFT and REVIEW, which
 * are the admin's alone. A SCHEDULED market's detail is public before it opens. The public list
 * filters by these, and every public route answers NOT_FOUND for a market in any other status.
 */
export const PUBLIC_MARKET_STATUSES = [
  'scheduled',
  'open',
  'paused',
  'closed',
  'provisional',
  'resolved',
  'settling',
  'settled',
  'cancelled',
] as const satisfies readonly Exclude<MarketStatus, 'draft' | 'review'>[];
export type PublicMarketStatus = (typeof PUBLIC_MARKET_STATUSES)[number];
export const publicMarketStatusSchema = z.enum(PUBLIC_MARKET_STATUSES);

/** Whether a user may see a market in `status` (`PUBLIC_MARKET_STATUSES`). */
export function isPublicMarketStatus(status: MarketStatus): status is PublicMarketStatus {
  return (PUBLIC_MARKET_STATUSES as readonly MarketStatus[]).includes(status);
}

/**
 * `GET /markets?status=all`: every public status at once — the search screen's '모든 상태', which
 * it starts on (ADR-0061 decision 1, item 13; ADR-0066). A value of its own rather than an omitted
 * `status`, because omitted is `open` (the home's list, and every caller written before search):
 * the default stays what it was and "all" has to be asked for by name.
 */
export const ALL_MARKET_STATUSES = 'all';
export const MARKET_LIST_STATUSES = [...PUBLIC_MARKET_STATUSES, ALL_MARKET_STATUSES] as const;
export type MarketListStatus = (typeof MARKET_LIST_STATUSES)[number];
export const marketListStatusSchema = z.enum(MARKET_LIST_STATUSES);

/**
 * The public list's orders (ADR-0061 decision 1, items 9–11; ADR-0065), in the order the home's
 * select lists them:
 *
 * - `recommended` (추천, the default): the volume of the last `RECOMMENDED_VOLUME_HOURS` hours,
 *   largest first, ties by the actual open time, latest first. Counted by a rule, never picked by
 *   an operator; every fill counts until #132 excludes abnormal ones.
 * - `newest` (신규): the actual open time (`open_at`), latest first.
 * - `closing` (마감 임박): the close time, soonest first, with no window. On a list that can hold
 *   ended markets (`status=all` or an ended status; MY's 관심 시장), the markets not closed yet
 *   (`PRE_CLOSE_MARKET_STATUSES`: 개장 예정·거래 중·거래 일시 중단, #174) come first, soonest
 *   first, and every other one after them, the most recently closed first — ended by its status,
 *   not by the clock (ADR-0066, owner decision 2026-10-16).
 *
 * Every order ends on the market id. A market with no open time sorts as the earliest open time
 * there is, so where it lands depends on the order: in `newest` after every market that has one;
 * in `recommended`, where the open time only breaks ties, after the opened markets of its own
 * 24-hour volume and nowhere else (a traded one stays ahead of an untraded one); `closing` does
 * not read the open time. The volume order is gone until #132 brings it back with its exclusions,
 * so no query names it.
 */
export const MARKET_SORTS = ['recommended', 'newest', 'closing'] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];
export const marketSortSchema = z.enum(MARKET_SORTS);
export const DEFAULT_MARKET_SORT = 'recommended' satisfies MarketSort;

/**
 * The window of 추천 (ADR-0061 decision 1, item 9): the fills of the last 24 hours, counted up to
 * the instant the first page was read (ADR-0065).
 */
export const RECOMMENDED_VOLUME_HOURS = 24;

/**
 * A category slug on either level, as a list filter: a top-level slug lists every sub-category
 * under it. `GET /markets` and `GET /me/watchlist` (ADR-0064) take the same one.
 */
export const marketCategoryFilterSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .describe('A category slug on either level; a top-level slug lists every sub-category under it');

/**
 * A search term (ADR-0061 decision 1, item 14; ADR-0066): trimmed, 1..MARKET_SEARCH_TERM_MAX
 * characters. A market's title holding it (case-insensitive, `%`·`_`·`\` literal) is a match, and
 * so is a market with a tag of that name (an exact match, `tagKey`, #17) — the detail's tag links
 * search for the tag's name.
 * `GET /markets?q=` and the recorded search (`POST /me/search-history`) take the same one, so a
 * term the screen can search is a term it can record. A NUL is refused by the API's global pipe
 * (Postgres text cannot store one).
 */
export const marketSearchTermSchema = z.string().trim().min(1).max(MARKET_SEARCH_TERM_MAX);

/**
 * `GET /markets` (no `.meta`: query DTO). `status` defaults to `open` — the home's list (ADR-0061
 * decision 1, item 13) — and `all` is every public status, which the search screen asks for until
 * a status is picked (ADR-0066).
 */
export const marketListQuerySchema = cursorQuerySchema.extend({
  /** A category slug on either level: a top-level slug lists every sub-category under it. */
  category: marketCategoryFilterSchema.optional(),
  status: marketListStatusSchema.default('open'),
  sort: marketSortSchema.default(DEFAULT_MARKET_SORT),
  /**
   * The search screen's (ADR-0066): a title holding it, case-insensitive, or a tag of exactly that
   * name, case and spaces aside (#17).
   */
  q: marketSearchTermSchema.optional(),
});
export type MarketListQuery = z.infer<typeof marketListQuerySchema>;

// ---- orders, fills, positions ------------------------------------------------------
/**
 * The caller's own order (#119, ADR-0112; `GET /me/orders`, `GET /me/orders/:id`, the request-id
 * lookup, the order route's answer, and the answer of `POST /me/orders/:id/cancel`, #178: the
 * order in its final state). Owner only (N04 §7): no other account reads it. Its terms
 * as sent — `requestId` the `Idempotency-Key`, the confirmed `limitPriceCoin` — and as the server
 * took them: `protectedLimitPriceCoin`, the limit it matched, locked and rests at (an immediate
 * order's narrowed by the market's 가격 보호 폭, #177 2항; a GTC order's its own). `qty` for a
 * quantity order, `budgetCoin` for a budget one. What filled: `filledQty` contracts for
 * `filledAmountCoin` Coin (the average is the one over the other); `cancelledQty` what a 취소 완료
 * or 만료 quantity order left unfilled (0 otherwise; a budget order's rest is `unspentCoin`).
 * The state and its reason (#177 7·8항). Never the reference quote, the width, the counterparties
 * or any account's type (ADR-0107 결정 5 '#179·#119').
 *
 * `marketSlug` and `marketTitle` are null together while the market is not public
 * (`isPublicMarketStatus`): a SCHEDULED market's rejected order (개장 전) stays when #78's 되돌리기
 * sends the market back to a draft, and the draft being fixed — its title and slug among it — is
 * the admin's alone until it is public again (ADR-0099, owner answer 2026-11-01; as
 * `postMarketSchema`). `marketId` stays, so the row still groups by its market.
 */
export const orderSchema = z
  .object({
    id: z.uuid(),
    requestId: z.string(),
    marketId: z.uuid(),
    marketSlug: z.string().nullable(),
    marketTitle: z.string().nullable(),
    outcome: outcomeSchema,
    side: orderSideSchema,
    timeInForce: timeInForceSchema,
    limitPriceCoin: priceSchema,
    protectedLimitPriceCoin: priceSchema,
    qty: countSchema.nullable(),
    budgetCoin: coinAmountSchema.nullable(),
    filledQty: countSchema,
    filledAmountCoin: coinAmountSchema,
    cancelledQty: countSchema,
    /** A budget order's budget minus what it spent, given back; null for a quantity order. */
    unspentCoin: coinAmountSchema.nullable(),
    status: orderStatusSchema,
    /** Set exactly when `status` is `rejected` (거절). */
    rejectReason: orderRejectReasonSchema.nullable(),
    /** Set exactly when `status` is `cancelled` (취소 완료). */
    cancelReason: orderCancelReasonSchema.nullable(),
    createdAt: z.iso.datetime(),
    /** When it left the live states (대기·부분 체결); null while it rests. */
    endedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Order' });
export type Order = z.infer<typeof orderSchema>;

/**
 * `POST /markets/:id/orders`'s answer: the order — taken, or rejected with its reason (a rejected
 * order is an order row, not an error) — and whether the request id had already named it
 * (`replayed`: the order as it stands now, nothing written).
 */
export const placeOrderResultSchema = z
  .object({ order: orderSchema, replayed: z.boolean() })
  .meta({ id: 'PlaceOrderResult' });
export type PlaceOrderResult = z.infer<typeof placeOrderResultSchema>;

/**
 * One of the caller's own fills (#119, `GET /me/fills`), as its own order's side holds it: its
 * order, the market, its order's outcome and side, the quantity, its price per contract
 * (`ownFillPrice`: the YES price, or the payout minus it for NO), the Coin (price × qty) and the
 * recorded YES price (#177 15항), the fee (0, #73 15항). Owner only. The counterparty stays
 * anonymous — no other order, account or account type (ADR-0107 결정 5 '#179·#119') — and so does
 * whether it was a pair mint or a trade (#177 4항).
 */
export const myFillSchema = z
  .object({
    id: z.string(),
    orderId: z.uuid(),
    marketId: z.uuid(),
    marketSlug: z.string(),
    marketTitle: z.string(),
    outcome: outcomeSchema,
    side: orderSideSchema,
    qty: countSchema,
    priceCoin: priceSchema,
    amountCoin: coinAmountSchema,
    yesPriceCoin: priceSchema,
    feeCoin: coinAmountSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'MyFill' });
export type MyFill = z.infer<typeof myFillSchema>;

/** `GET /me/orders`'s filter: the live ones (대기·부분 체결) or the ended ones; omitted = all. */
export const MY_ORDER_STATES = ['live', 'ended'] as const;
export type MyOrderState = (typeof MY_ORDER_STATES)[number];

/**
 * `GET /me/orders` (no `.meta`: query DTO): newest first by arrival, rejected orders included;
 * one market's, and the live or the ended ones.
 */
export const myOrdersQuerySchema = cursorQuerySchema.extend({
  marketId: uuidParamSchema.optional(),
  state: z.enum(MY_ORDER_STATES).optional(),
});
export type MyOrdersQuery = z.infer<typeof myOrdersQuerySchema>;

/** `GET /me/fills` (no `.meta`: query DTO): newest first, one market's when named. */
export const myFillsQuerySchema = cursorQuerySchema.extend({
  marketId: uuidParamSchema.optional(),
});
export type MyFillsQuery = z.infer<typeof myFillsQuerySchema>;

/** Public and anonymous (PLAN 7.1): no user id. `id` is a bigserial as a decimal string. */
export const fillSchema = z
  .object({
    id: z.string(),
    outcome: outcomeSchema,
    side: orderSideSchema,
    qty: countSchema,
    amountCoin: coinAmountSchema,
    priceAvgBp: bpSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Fill' });
export type Fill = z.infer<typeof fillSchema>;

export const positionSchema = z
  .object({
    marketId: z.uuid(),
    marketSlug: z.string(),
    marketTitle: z.string(),
    marketStatus: marketStatusSchema,
    /** The market's `lastPrice`: null until its first fill. */
    marketLastPrice: priceSchema.nullable(),
    /** The market's result type (YES·NO·VOID); null before a judgement and when cancelled. */
    resolvedResult: marketResultSchema.nullable(),
    outcome: outcomeSchema,
    qty: countSchema,
    costBasisCoin: coinAmountSchema,
    realizedPnlCoin: coinAmountSchema,
    settled: z.boolean(),
    /** The row's write count (1 on first buy); `user:position` events carry the same key. */
    version: z.number().int().min(1),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Position' });
export type Position = z.infer<typeof positionSchema>;

/** open = not yet settled (qty may be 0: the row still carries realised PnL); settled = settled. */
export const POSITION_STATUSES = ['open', 'settled'] as const;
export type PositionStatus = (typeof POSITION_STATUSES)[number];
export const positionStatusSchema = z.enum(POSITION_STATUSES);

/** `GET /me/positions` (no `.meta`: query DTO). Omitted status = every row. */
export const positionsQuerySchema = z.object({ status: positionStatusSchema.optional() });
export type PositionsQuery = z.infer<typeof positionsQuerySchema>;

// ---- the public book, quotes and the sellable figures (#179) -------------------------
/** One price level: its price in the contract and the quantity resting there, summed. */
export const orderBookLevelSchema = z
  .object({ priceCoin: priceSchema, qty: z.number().int().min(1) })
  .meta({ id: 'OrderBookLevel' });
export type OrderBookLevel = z.infer<typeof orderBookLevelSchema>;

/**
 * One contract's book (#177 4항, N02 §2·§5): `asks` what a buyer meets — the direct sells and the
 * converted buys of the other outcome merged into one quantity per price, cheapest first — and
 * `bids` what a seller meets, the direct buys only, highest first. Every level (at most 99 per
 * side; the screen's depth is #122's). `bestAskCoin`/`bestBidCoin` null is '호가 없음'.
 */
export const orderBookContractSchema = z
  .object({
    outcome: outcomeSchema,
    asks: z.array(orderBookLevelSchema).max(PRICE_MAX),
    bids: z.array(orderBookLevelSchema).max(PRICE_MAX),
    bestAskCoin: priceSchema.nullable(),
    bestBidCoin: priceSchema.nullable(),
  })
  .meta({ id: 'OrderBookContract' });
export type OrderBookContract = z.infer<typeof orderBookContractSchema>;

/**
 * `GET /markets/:id/book` (#179, public: the same for every caller): both contracts, YES then NO,
 * price and summed quantity only — no order, account, account type, bot split or order count
 * (ADR-0107 결정 5 '#179·#119'). A market that takes no order now (`marketTradingRejectReason`:
 * 개장 전, 일시 중단, 마감) shows empty sides with the reason: its resting orders, a ledger hold's locked
 * ones among them, cannot trade (ADR-0114).
 */
export const orderBookSchema = z
  .object({
    marketId: z.uuid(),
    marketRejectReason: z.enum(MARKET_STATUS_REJECT_REASONS).nullable(),
    contracts: z.array(orderBookContractSchema).length(2),
  })
  .meta({ id: 'OrderBook' });
export type OrderBook = z.infer<typeof orderBookSchema>;

/**
 * The public book of a market from its trading facts and its live book (#179): every level when
 * it takes orders now, empty sides with the reason otherwise (ADR-0114 결정 2) — by the intake's
 * own check (`marketTradingRejectReason`), so an OPEN market past its `close_at` (#120) shows an
 * empty book as the quote and the order are refused. RangeError for a DRAFT or REVIEW market (the
 * caller answers NOT_FOUND) or a malformed book.
 */
export function orderBookOf(
  marketId: string,
  market: MarketTradingFacts,
  book: readonly BookOrder[],
): OrderBook {
  const reason = marketTradingRejectReason(market);
  const depth: ContractDepth[] = bookDepth(reason === null ? book : []);
  return {
    marketId,
    marketRejectReason: reason,
    contracts: depth.map((contract) => ({
      outcome: contract.outcome,
      asks: contract.asks.map((level) => ({ priceCoin: level.priceCoin, qty: level.qty })),
      bids: contract.bids.map((level) => ({ priceCoin: level.priceCoin, qty: level.qty })),
      bestAskCoin: contract.bestAskCoin,
      bestBidCoin: contract.bestBidCoin,
    })),
  };
}

/**
 * A quote (#179; `POST /markets/:id/quote`, public, and each holding's `Sellable.quote`): the
 * intake's walk on the book as it stands, in the `Order`'s names where it has the field —
 * `protectedLimitPriceCoin` the 최대 매수 단가 or 최소 매도 단가 (#177 2항: send it as the order's
 * limit), `filledQty` contracts filling at once for `filledAmountCoin` (paid by a buy, received
 * by a sell; the average is the one over the other, #177 12항, with none at 0 — its rounding and
 * place are #60·#66's), what is left (`remainingQty`, the matcher's qty − filledQty: a GTC's
 * resting part, an IOC's cancelled rest, all of a refused one — not `Order.cancelledQty`, which
 * stays 0 while a GTC rests and for a rejection; or a budget's `unspentCoin`), a buy's
 * `maxSpendCoin` (the intake's whole lock: limit × qty, or the budget), the fee (always 0, #73
 * 15항), why the walk stopped (null when the market's status refused the order) and the state the
 * order would end its intake in with its reason (IOC: the rest cancelled; GTC: it rests at its
 * limit). Never a fill row, a resting order, the reference or the width (ADR-0111 결과 '#179').
 * No payout: VOID and each result's are `CONTRACT_TERMS` (#66).
 */
export const orderQuoteSchema = z
  .object({
    protectedLimitPriceCoin: priceSchema,
    filledQty: countSchema,
    filledAmountCoin: coinAmountSchema,
    remainingQty: countSchema.nullable(),
    unspentCoin: coinAmountSchema.nullable(),
    maxSpendCoin: coinAmountSchema.nullable(),
    feeCoin: z.literal('0'),
    stop: z.enum(MATCH_STOPS).nullable(),
    status: orderStatusSchema,
    rejectReason: orderRejectReasonSchema.nullable(),
    cancelReason: orderCancelReasonSchema.nullable(),
  })
  .meta({ id: 'OrderQuote' });
export type OrderQuote = z.infer<typeof orderQuoteSchema>;

/** A quote's figures on the wire (`OrderQuote`): Coin as strings and the fee 0. */
export function orderQuoteOf(figures: OrderQuoteFigures): OrderQuote {
  const coin = (value: bigint | null) => (value === null ? null : serializeCoinAmount(value));
  return {
    protectedLimitPriceCoin: figures.protectedLimitPriceCoin,
    filledQty: figures.filledQty,
    filledAmountCoin: serializeCoinAmount(figures.filledAmountCoin),
    remainingQty: figures.remainingQty,
    unspentCoin: coin(figures.unspentCoin),
    maxSpendCoin: coin(figures.maxSpendCoin),
    feeCoin: '0',
    stop: figures.stop,
    status: figures.status,
    rejectReason: figures.rejectReason,
    cancelReason: figures.cancelReason,
  };
}

/**
 * One contract of the caller's holding with its 매도 가능액 (#177 15항): what is held, the part in
 * resting sells (shown apart), the rest, and that rest quoted as an immediate sell with 가격 보호
 * (`quote`: null when nothing is unlocked or the market has no width; 'only part possible' is
 * `quote.filledQty < unlockedQty`).
 */
export const sellableContractSchema = z
  .object({
    outcome: outcomeSchema,
    qty: countSchema,
    restingSellQty: countSchema,
    unlockedQty: countSchema,
    quote: orderQuoteSchema.nullable(),
  })
  .meta({ id: 'SellableContract' });
export type SellableContract = z.infer<typeof sellableContractSchema>;

/**
 * `GET /me/markets/:id/sellable` (#179, owner only): both contracts, YES then NO, zeros when
 * nothing is held, so every caller's answer has one shape. The screen is #67's.
 */
export const sellableSchema = z
  .object({ marketId: z.uuid(), contracts: z.array(sellableContractSchema).length(2) })
  .meta({ id: 'Sellable' });
export type Sellable = z.infer<typeof sellableSchema>;

/** One holding's sellable figures on the wire (`SellableContract`). */
export function sellableContractOf(figures: SellableFigures): SellableContract {
  return {
    outcome: figures.outcome,
    qty: figures.qty,
    restingSellQty: figures.restingSellQty,
    unlockedQty: figures.unlockedQty,
    quote: figures.quote === null ? null : orderQuoteOf(figures.quote),
  };
}

// ---- ticks --------------------------------------------------------------------------
/**
 * One point of a price series. At `resolution=raw` it is a stored tick and `ts` is the tick's
 * own instant. At a bucketed resolution it is a SAMPLE: `ts` is a boundary on the absolute
 * grid and `pYesBp`/`trigger` come from the last tick at or before it — the probability in
 * force then, exact because the series is a step function (the price holds between fills).
 * Render it with a step curve, never straight interpolation.
 */
export const priceTickSchema = z
  .object({
    ts: z.iso.datetime(),
    pYesBp: bpSchema,
    trigger: priceTickTriggerSchema,
  })
  .meta({ id: 'PriceTick' });
export type PriceTick = z.infer<typeof priceTickSchema>;

export const TICK_RESOLUTIONS = ['raw', '1m', '1h'] as const;
export type TickResolution = (typeof TICK_RESOLUTIONS)[number];
export const tickResolutionSchema = z.enum(TICK_RESOLUTIONS);

/** Ten years, the widest window `tickBucketSeconds` has a stride for. */
export const TICKS_WINDOW_SECONDS_MAX = 315_360_000;

/**
 * `GET /markets/:id/ticks` (no `.meta`: query DTO). `resolution` selects the sampled grid.
 *
 * `windowSeconds` is how a RELATIVE range is asked for — "the last day" — and it exists because
 * `from` cannot express one honestly. A client computing `from` from its own clock is naming an
 * INSTANT for a window whose other end the server closes on the database clock, so the two come
 * from different machines and the served span is wrong by the visitor's skew. The same principle
 * A-M4-23 settled for the close gate: ask the browser for a DURATION, which its clock measures
 * correctly, never for an instant to be compared against a server's.
 *
 * Mutually exclusive with `from`, so one request can never name its window twice.
 */
export const ticksQuerySchema = z
  .object({
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    windowSeconds: z.coerce.number().int().positive().max(TICKS_WINDOW_SECONDS_MAX).optional(),
    resolution: tickResolutionSchema.default('raw'),
  })
  .refine((query) => query.from === undefined || query.windowSeconds === undefined, {
    message: 'from and windowSeconds are mutually exclusive',
    path: ['windowSeconds'],
  })
  .refine(
    // Compare instants, not strings: '…00Z' and '…00.000Z' are the same moment.
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      Date.parse(query.from) <= Date.parse(query.to),
    { message: 'from must not be after to', path: ['from'] },
  );
export type TicksQuery = z.infer<typeof ticksQuerySchema>;

/**
 * `GET /markets/:id/ticks` (PLAN 7.1, M4). An object, not a bare array, so the series says
 * what the server actually served: the stride it picked (`bucketSeconds` — a requested
 * resolution is coarsened rather than striped, so points are evenly spaced), the window it
 * covered (`from`/`to`, filled in by the server when a bound is omitted) and whether older
 * points inside that window were left out (`truncated`, Q-M3-8 (1)).
 *
 * Not `meta`: in this API `meta` is cursor pagination and nothing else (api/pagination.ts),
 * and a second meta shape would have to be threaded through ResponseEnvelopeInterceptor,
 * ApiPage and ApiData for one boolean — and could not carry `bucketSeconds`/`from`/`to`.
 */
export const priceSeriesSchema = z
  .object({
    /** The resolution the caller asked for, echoed. */
    resolution: tickResolutionSchema,
    /** The stride actually served, in seconds; 0 for `raw`. */
    bucketSeconds: z.number().int().min(0),
    /** The window the answer describes; equals the request when both bounds were given. */
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    /** Points older than the served ones exist inside the window but were left out. */
    truncated: z.boolean(),
    /**
     * The market's trade count when this answer was read — the only field here that says what
     * the answer CONTAINS rather than when it was written.
     *
     * A watermark for a LIVE window only, which is the window a client merging `market:tick`
     * events has. Ask for an explicit `to` and this is still the counter at answer time, not
     * the count as of that cutoff: the market row keeps no history, and deriving one from the
     * ticks would make the field mean something the row cannot confirm. A pinned window is
     * history, so nothing merges live events into it — but a client that treated this as an
     * as-of watermark there would over-report and drop events it should have taken.
     *
     * `to` cannot say it. A fill's tick is stamped with `clock_timestamp()` read INSIDE its
     * transaction, before its writes, so the instant is fixed several statements before the
     * row commits — and this route's own clock read takes no lock, so it
     * can pass that instant while the sampling snapshot still cannot see the row. The answer
     * then truthfully names a `to` LATER than a tick it truthfully omits, and no window can
     * tell the two apart. A client merging live `market:tick` events, which carry this same
     * counter, compares this instead.
     *
     * Read BEFORE the points, never after: an earlier snapshot can only lag them, which at
     * worst makes a client keep a point the answer already has — the same trade at the same
     * price. A count read AFTER the points could claim a trade the points predate, and the
     * client would then drop the live tick it is holding, which is the failure this field
     * exists to prevent.
     */
    tradeCount: z.number().int().min(0),
    /**
     * Ascending by `ts`; at most TICKS_MAX_POINTS (documented as maxItems only — nothing
     * validates a response at runtime; ApiData is an OpenAPI decorator).
     */
    points: z.array(priceTickSchema).max(TICKS_MAX_POINTS),
  })
  .meta({ id: 'PriceSeries' });
export type PriceSeries = z.infer<typeof priceSeriesSchema>;

// ---- events -------------------------------------------------------------------------
export const marketEventSchema = z
  .object({
    /** bigserial as a decimal string. */
    id: z.string(),
    type: marketEventTypeSchema,
    /** Admin user id, or null for system transitions (worker close/settling/finalize). */
    actorId: z.string().nullable(),
    /**
     * The status change the event made (#174): both set on a transition, only `toStatus` on
     * `created`, both null on an event that changes no status (`rules_edited`,
     * `open_rescheduled`, `rules_supplemented`, `judgement_corrected`,
     * `judgement_delay_recorded`, `price_protection_changed`).
     */
    fromStatus: marketStatusSchema.nullable(),
    toStatus: marketStatusSchema.nullable(),
    payload: z.unknown().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'MarketEvent' });
export type MarketEvent = z.infer<typeof marketEventSchema>;

// ---- admin --------------------------------------------------------------------------
/** One row of `market_settlement_steps` (ADR-0046), admin-only. */
export const adminSettlementStepSchema = z
  .object({
    step: settlementStepSchema,
    status: settlementStepStatusSchema,
    /** Attempts that ran to a commit or a rollback; 0 while the step has never run. */
    attempts: countSchema,
    completedAt: z.iso.datetime().nullable(),
    /** Message of the last failed attempt (≤ SETTLEMENT_STEP_ERROR_MAX); kept after a success. */
    lastError: z.string().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminSettlementStep' });
export type AdminSettlementStep = z.infer<typeof adminSettlementStepSchema>;

/** Detail for `/admin/markets/:id`: the public shape plus author, exposure and settlement. */
export const adminMarketSchema = marketSchema
  .extend({
    createdBy: z.string(),
    updatedAt: z.iso.datetime(),
    /** Σ buy amounts − Σ sell amounts over the market's fills. */
    netCollectedCoin: coinAmountSchema,
    /** Σ positions.qty per outcome where settled = false. */
    openInterest: z.object({ yes: countSchema, no: countSchema }),
    /**
     * The settlement steps of a market (ADR-0046), in SETTLEMENT_STEPS order: one row per step
     * from the result's confirmation (`resolved`) on, empty before it and on a CANCELLED market.
     * A `settling` market whose step stays `failed` is what the admin's '정산 대기' badge points
     * at (ADR-0093 decision 1 item 14).
     */
    settlementSteps: z.array(adminSettlementStepSchema),
    /** Newest first, at most 100. */
    events: z.array(marketEventSchema),
    /**
     * What the open-items check finds missing (`missingOpenItems`, #17, #23, #22), in OPEN_ITEMS
     * order — on a draft, what the review submission (#78) refuses it for; in REVIEW, what the
     * approval refuses it for; empty once it may go on. The open (#21) does not check it again: the
     * approval was the last gate. Every status reports it, so a market whose category was hidden
     * after its approval shows that too, and so does one opened before #23 or #22 with its rule
     * items or times blank.
     */
    missingOpenItems: z.array(openItemSchema),
    /**
     * The 선행 마감 gap in minutes the check above holds the market to (#22, ADR-0098; #78,
     * ADR-0099): the one its lead close was last checked against (`markets.lead_close_gap_minutes`,
     * which the review submission stores, a 반려 or a 되돌리기 clears, or an open market's first
     * lead check; the open (#21) keeps it as it is) once there is one, else the release setting
     * `market.lead_close_gap`'s current reading; null while that is undecided and the market has
     * none. The admin screen recomputes which time rule is broken from it (`timeRuleViolations`).
     */
    leadCloseGapMinutes: z.number().int().min(0).nullable(),
    /**
     * The 가격 보호 폭 in ticks (#119, ADR-0112; ADR-0107 결정 1 #177 2항): the market's own
     * (`markets.price_protection_ticks` — copied from the release setting
     * `order.price_protection_ticks` at creation, filled at the review submission if it had none,
     * fixed from the review on but for the after-open change) once there is one, else for a draft
     * the setting's current reading; null while that is undecided and the market has none.
     */
    priceProtectionTicks: priceProtectionTicksSchema.nullable(),
    /**
     * 개설 검수 (#78, ADR-0099), in every status: the pending request, the creator and the editors
     * the exclusions name, the same-condition markets and the 검수 기록.
     */
    review: adminMarketReviewSchema,
    /**
     * The rule versions as the public detail lists them (newest first), each with who asked for it,
     * who made it, its approval request and its 정산 영향 검토 (#80, ADR-0101): the admin's form of
     * `Market.ruleVersions`, in its place.
     */
    ruleVersions: z.array(adminRuleVersionSchema),
    /**
     * 규칙 보충 (#80, ADR-0101), in every status: the waiting request and every request with how it
     * ended — one still waiting at the close is shown for its 반려 or 철회.
     */
    supplement: adminMarketSupplementSchema,
    /**
     * 거래 일시 중단 (#114, ADR-0102), in every status: every pause with how it ended, the
     * next-path request waiting and every request with how it ended — one still waiting at the
     * close is shown for its 반려 or 철회. The public `Market` carries none of it (#24 shows the
     * reason and the times, #173 item 13).
     */
    pause: adminMarketPauseStateSchema,
    /**
     * 판정 (#152, ADR-0103), in every status: the current judgement, the versions a 판정 정정
     * replaced (#176, ADR-0105), the registration waiting for another admin's approval — a first
     * judgement or a correction — and every registration with how it ended — one still waiting
     * once the market left the status it needs is shown for its 반려 or 철회 — and whether the
     * dispute window is undecided. The public `Market` carries none of it but the version and its
     * deadline (`judgementVersion`, `disputeDeadline`; #24 shows the record without the names,
     * #173 item 13).
     */
    judgement: adminMarketJudgementStateSchema,
    /**
     * 판정 이의 (#175, ADR-0104), in every status: the current judgement version's disputes, the
     * oldest first, with who submitted and who decided them, and how many hold the confirmation
     * (an earlier version's, a correction replaced, are in 이의 접수's 처리됨 list, #176).
     * The public `Market` carries none of it but `disputeUnderReview` (#24 publishes the count,
     * the statuses and the reasons without the names; the submitter and the body stay private,
     * #173 item 13).
     */
    disputes: adminMarketDisputesSchema,
    /**
     * 판정 지연 기록 (#142, ADR-0106), in every status: every record of the market, the newest
     * first, with the status and judgement version it was made on, who made it and when, and
     * which one is current — none is edited or withdrawn (owner answer 2026-11-03 (4)). The
     * public `Market` carries the current one's reason and next review time alone
     * (`judgementDelay`, inherited here; #173 item 13).
     */
    judgementDelays: z.array(adminJudgementDelaySchema),
  })
  .meta({ id: 'AdminMarket' });
export type AdminMarket = z.infer<typeof adminMarketSchema>;

/**
 * A slug is NFC-normalised before matching, then must fit MARKET_SLUG_PATTERN and must not be
 * something `uuidParamSchema` accepts — `GET /markets/:idOrSlug` tries the id first, so a
 * uuid-shaped slug could never be reached.
 */
export const marketSlugSchema = z
  .string()
  .normalize('NFC')
  .regex(MARKET_SLUG_PATTERN, 'only a-z, 0-9, Korean syllables and -, 3..80 characters')
  .refine((slug) => !uuidParamSchema.safeParse(slug).success, 'slug must not look like a uuid');

/**
 * The fields of a create and an edit: the version items as market-fields.ts declares them (the
 * title, the rule items and the times, #80), then the category, the tags, the image and the slug.
 *
 * The rule items (market-rules.ts, #23) are each optional and may be blank, null or empty: a draft
 * saves half-done and the open-items check names what is missing. A create without one starts it
 * blank (null for a nullable one); an edit without one keeps the stored value; null clears a
 * nullable one. A switch condition while the result has no fallback is refused ('no fallback
 * source'), the service's, on the stored values merged with the body.
 *
 * The time items (market-times.ts, #22, ADR-0098) are the same but the close, which a create
 * requires: each instant from STORABLE_INSTANT_MIN on, stored as entered. The service refuses a
 * write whose result breaks an order rule (`timeRuleViolations`, whole minutes) naming both ends;
 * the lead close (선행 마감) is the open-items check's, never refused on a draft.
 *
 * After the open the version items change by a supplement alone (#80, ADR-0101; ADR-0093 decision
 * 2 #172 item 14): an edit of an OPEN or PAUSED (#114) market that changes one is refused, one
 * detail per item (SUPPLEMENT_ONLY_WHILE_OPEN), while its category, tags and image stay editable.
 * A supplement holds the open market's rules (market-supplement.ts): RULES_REQUIRED for an item it
 * newly leaves missing, the close later only and never past the scheduled judgement, with the lead
 * close checked again, and the scheduled open and judgement fixed. Trading ends earlier than the
 * close only by a pause and an approved 조기 마감 (#114, market-pause.ts).
 */
const marketFields = {
  title: marketTitleSchema,
  ...ruleItemFields,
  /**
   * int4 column: an unbounded id would reach Postgres as an out-of-range parameter (500). One a new
   * market may be filed under (`categoryUnselectableReason`), refused naming the field otherwise.
   */
  categoryId: z.number().int().positive().max(INT4_MAX),
  /**
   * The whole set, in order (`marketTagsSchema`): a create without it makes a draft with none, an
   * edit without it keeps the stored ones, an edit with it replaces them. A name no tag has yet
   * makes the tag.
   */
  tags: marketTagsSchema.optional(),
  imageUrl: z
    .url({ protocol: /^https?$/ })
    .max(MARKET_IMAGE_URL_MAX)
    .nullish(),
  ...timeItemFields,
  /** Omitted: the server derives one from the title (`slugify` + a random tag). */
  slug: marketSlugSchema.optional(),
};

/**
 * `POST /admin/markets` → a draft, as the admin on screen (`expectedAccountId`, ADR-0092 — every
 * admin write below names it too). The service is handed the fields alone: the account is checked
 * and dropped first, so the `created` event that keeps the body never holds it.
 */
export const createMarketBodySchema = z
  .object({ ...marketFields, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'CreateMarketBody' });
export type CreateMarketBody = z.infer<typeof createMarketBodySchema>;

/**
 * `PATCH /admin/markets/:id`: which fields a status admits is the service's decision — a draft's
 * every field, an OPEN or PAUSED market's category, tags and image (its version items by a
 * supplement alone, `requestMarketSupplementBodySchema`, #80; PAUSED since #114, ADR-0102, #172
 * item 14); a market in REVIEW or SCHEDULED is locked (#78, #172 item 6: sent back to a draft to
 * edit, its scheduled open moved by `rescheduleMarketOpenBodySchema`). At least one field beside
 * the account.
 */
export const updateMarketBodySchema = z
  .object(marketFields)
  .partial()
  .extend({ expectedAccountId: expectedAccountIdSchema })
  .refine(namesAFieldBesideAccount, 'at least one field is required')
  .meta({ id: 'UpdateMarketBody' });
export type UpdateMarketBody = z.infer<typeof updateMarketBodySchema>;

/**
 * `GET /admin/markets` (no `.meta`: query DTO). Any status, DRAFT and REVIEW included; omitted =
 * all. `q` is a title search (a case-insensitive partial match, `%`·`_`·`\` literal; not the public
 * list's tag match), which the admin's 관련 시장 picker finds the market to link with (#65,
 * ADR-0068).
 */
export const adminMarketListQuerySchema = cursorQuerySchema.extend({
  status: marketStatusSchema.optional(),
  q: marketSearchTermSchema.optional(),
});
export type AdminMarketListQuery = z.infer<typeof adminMarketListQuerySchema>;

/**
 * Turns a Korean/ASCII title into a slug stem of at most MARKET_SLUG_STEM_MAX characters of
 * `[a-z0-9가-힣-]`: NFC, lower-case, runs of anything else become one '-', no leading or
 * trailing '-'. Empty when nothing survives (a title of emoji, say); the server then falls
 * back to `market-<tag>`. Hangul syllables are single UTF-16 units, so the cut is safe.
 */
export function slugify(title: string): string {
  const stem = title
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MARKET_SLUG_STEM_MAX);
  return stem.replace(/-+$/, '');
}
