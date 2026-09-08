import * as z from 'zod';
import { cursorQuerySchema } from './api/pagination.js';
import { pAmountInputSchema, pAmountSchema, serializePAmount } from './api/p-amount.js';
import { uuidParamSchema } from './api/path-param.js';
import { uuidSchema } from './api/uuid.js';
import {
  BP_MAX,
  INITIAL_PROB_BP_MAX,
  INT4_MAX,
  INITIAL_PROB_BP_MIN,
  LIQUIDITY_B_MAX,
  LIQUIDITY_B_MIN,
  MARKET_IMAGE_URL_MAX,
  MARKET_SLUG_PATTERN,
  MARKET_SLUG_STEM_MAX,
  MARKET_SOURCE_MAX,
  MARKET_TEXT_MAX,
  MARKET_TITLE_MAX,
  MARKET_VOID_REASON_MAX,
  MAX_P_AMOUNT,
  ORDER_QTY_MAX,
  PRICE_MAX,
  PRICE_MIN,
  SPARKLINE_MAX_POINTS,
  TICKS_MAX_POINTS,
  TRADE_MIN_SHARES,
} from './constants.js';
import {
  type MarketStatus,
  marketEventTypeSchema,
  marketStatusSchema,
  orderSideSchema,
  orderStatusSchema,
  orderTypeSchema,
  outcomeSchema,
  priceTickTriggerSchema,
} from './enums.js';
import { balanceSchema } from './wallet.js';

/**
 * Market, quote, trade, order, position and tick DTOs (PLAN 7.1–7.3; M3 design 1.5).
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
const sharesSchema = z.number().int().min(TRADE_MIN_SHARES).max(ORDER_QTY_MAX);
const countSchema = z.number().int().min(0);
/** better-auth `user.id` (text), also used for `expectedAccountId` like the wallet bodies. */
const accountIdSchema = z.string().min(1).max(255);

/** Request-side P amount bounded by MAX_P_AMOUNT (yields a bigint). */
const boundedPAmount = (min: bigint) =>
  pAmountInputSchema.refine(
    (value) => value >= min && value <= MAX_P_AMOUNT,
    `must be between ${min.toString()} and ${MAX_P_AMOUNT.toString()}`,
  );

// ---- categories ---------------------------------------------------------------------
export const categorySchema = z
  .object({
    id: z.number().int(),
    slug: z.string(),
    nameKo: z.string(),
    sortOrder: z.number().int(),
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
  /** Display YES price 1..99 (PLAN 5.3). */
  lastPrice: priceSchema,
  /** YES probability in basis points 0..10000. */
  pYesBp: bpSchema,
  volumeP: pAmountSchema,
  tradeCount: countSchema,
  traderCount: countSchema,
  closeAt: z.iso.datetime(),
  openAt: z.iso.datetime().nullable(),
  resolvedResult: outcomeSchema.nullable(),
  createdAt: z.iso.datetime(),
};

/** List card. */
export const marketSummarySchema = z.object(marketSummaryFields).meta({ id: 'MarketSummary' });
export type MarketSummary = z.infer<typeof marketSummarySchema>;

/**
 * `GET /markets` card (PLAN 11.4). `MarketSummary` plus the sparkline: the public list is the
 * only reader, so the shared component stays as it is and `GET /admin/markets`, `Market` and
 * `AdminMarket` are not made to carry a chart they never draw.
 *
 * Oldest to newest, at most SPARKLINE_MAX_POINTS hourly samples ending at the response
 * instant, in the same basis points as `pYesBp`. Shorter when the market's first tick falls
 * inside the window — leading unknowns are trimmed, never zero-filled (0 bp is a real
 * probability) — and because the grid is fixed, the length says where the series starts:
 * bucket index = SPARKLINE_MAX_POINTS - length. Empty only for a market with no ticks at all.
 */
export const marketListItemSchema = z
  .object({
    ...marketSummaryFields,
    sparkline: z.array(bpSchema).max(SPARKLINE_MAX_POINTS),
  })
  .meta({ id: 'MarketListItem' });
export type MarketListItem = z.infer<typeof marketListItemSchema>;

/**
 * Public detail (PLAN 7.1): no LMSR state, liquidity, reserve or author — those are
 * `adminMarketSchema` only.
 */
export const marketSchema = z
  .object({
    ...marketSummaryFields,
    description: z.string().nullable(),
    rules: z.string(),
    resolutionSource: z.string().nullable(),
    resolvedAt: z.iso.datetime().nullable(),
    disputeUntil: z.iso.datetime().nullable(),
    settledAt: z.iso.datetime().nullable(),
    voidedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Market' });
export type Market = z.infer<typeof marketSchema>;

/** Statuses the public list may filter by: a draft is invisible outside the admin. */
export const PUBLIC_MARKET_STATUSES = [
  'open',
  'closed',
  'resolving',
  'settled',
  'voided',
] as const satisfies readonly Exclude<MarketStatus, 'draft'>[];
export type PublicMarketStatus = (typeof PUBLIC_MARKET_STATUSES)[number];
export const publicMarketStatusSchema = z.enum(PUBLIC_MARKET_STATUSES);

export const MARKET_SORTS = ['volume', 'closing', 'newest'] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];
export const marketSortSchema = z.enum(MARKET_SORTS);

/** `GET /markets` (no `.meta`: query DTO). */
export const marketListQuerySchema = cursorQuerySchema.extend({
  /** Category slug. */
  category: z.string().trim().min(1).max(50).optional(),
  status: publicMarketStatusSchema.default('open'),
  sort: marketSortSchema.default('volume'),
  /** Title search. */
  q: z.string().trim().min(1).max(100).optional(),
});
export type MarketListQuery = z.infer<typeof marketListQuerySchema>;

// ---- quotes -------------------------------------------------------------------------
export const QUOTE_MODES = ['shares', 'spend'] as const;
export type QuoteMode = (typeof QUOTE_MODES)[number];
export const quoteModeSchema = z.enum(QUOTE_MODES);

const INTEGER_STRING = /^(0|[1-9]\d*)$/;

/**
 * The digits of MAX_P_AMOUNT (10^15): no valid `value` is longer in either mode, and the
 * bound runs before the range refine turns the string into a BigInt — `POST /quotes` is
 * public, and parsing a body-sized run of digits costs real CPU on the request thread.
 */
export const QUOTE_VALUE_MAX_LENGTH = MAX_P_AMOUNT.toString().length;

/**
 * `POST /quotes` (PLAN 7.1). `value` is an integer string: contracts in mode 'shares'
 * (1..ORDER_QTY_MAX), P to spend in mode 'spend' (≥ 1). A spend quote only makes sense for
 * a buy — "sell for at most N P" has no answer — so spend + sell is refused naming `mode`.
 */
export const quoteBodySchema = z
  .object({
    marketId: uuidSchema,
    outcome: outcomeSchema,
    side: orderSideSchema,
    mode: quoteModeSchema,
    value: z
      .string()
      .max(QUOTE_VALUE_MAX_LENGTH, `must be at most ${String(QUOTE_VALUE_MAX_LENGTH)} digits`)
      .regex(INTEGER_STRING, 'must be a non-negative integer string'),
  })
  .refine((body) => !(body.mode === 'spend' && body.side === 'sell'), {
    message: 'spend quotes are only available for buys',
    path: ['mode'],
  })
  .refine(
    (body) => {
      // A failed field check is a non-aborting issue in zod 4, so this refine still runs on
      // the raw string: skip it then, or BigInt('1.5') would throw out of safeParse and an
      // over-long string would be parsed after all.
      if (body.value.length > QUOTE_VALUE_MAX_LENGTH || !INTEGER_STRING.test(body.value)) {
        return true;
      }
      return body.mode === 'spend'
        ? BigInt(body.value) >= 1n && BigInt(body.value) <= MAX_P_AMOUNT
        : Number(body.value) >= TRADE_MIN_SHARES && Number(body.value) <= ORDER_QTY_MAX;
    },
    { message: 'value is out of range for the mode', path: ['value'] },
  )
  .meta({ id: 'QuoteBody' });
export type QuoteBody = z.infer<typeof quoteBodySchema>;

/** The parsed body's numeric value: contracts for mode 'shares', P for mode 'spend'. */
export function quoteValue(body: QuoteBody): { shares: number } | { spendP: bigint } {
  return body.mode === 'shares' ? { shares: Number(body.value) } : { spendP: BigInt(body.value) };
}

/**
 * Prices are basis-point integers (`priceAvgBp`, not PLAN 7.1's float `priceAvg`; ADR-0027).
 * A spend below one contract answers shares 0, amountP '0', both prices = priceBeforeBp.
 */
export const quoteResultSchema = z
  .object({
    shares: countSchema,
    amountP: pAmountSchema,
    priceAvgBp: bpSchema,
    priceBeforeBp: bpSchema,
    priceAfterBp: bpSchema,
    /** shares · 100 for a buy; '0' for a sell. */
    maxPayoutP: pAmountSchema,
  })
  .meta({ id: 'QuoteResult' });
export type QuoteResult = z.infer<typeof quoteResultSchema>;

// ---- trades -------------------------------------------------------------------------
const tradeFields = {
  /** Lower-cased on the way in: the replay compares it with the stored order's (uuid.ts). */
  marketId: uuidSchema,
  outcome: outcomeSchema,
  side: orderSideSchema,
  shares: sharesSchema,
  /** Buy only: refuse when the recomputed cost is above this (PRICE_MOVED). */
  maxCostP: boundedPAmount(1n).optional(),
  /** Sell only: refuse when the recomputed proceeds are below this (PRICE_MOVED). */
  minProceedsP: boundedPAmount(0n).optional(),
};

/**
 * `POST /trades` (PLAN 5.4, 7.2). The slippage guard is mandatory (PLAN 5.3): a buy must
 * carry `maxCostP`, a sell must carry `minProceedsP`, and neither may carry the other's.
 * `expectedAccountId` is the account the screen shows, as on charge and coupon bodies.
 */
export const tradeBodySchema = z
  .object({ ...tradeFields, expectedAccountId: accountIdSchema })
  .refine((body) => body.side !== 'buy' || body.maxCostP !== undefined, {
    message: 'maxCostP is required for a buy',
    path: ['maxCostP'],
  })
  .refine((body) => body.side !== 'sell' || body.minProceedsP !== undefined, {
    message: 'minProceedsP is required for a sell',
    path: ['minProceedsP'],
  })
  .refine((body) => body.side !== 'buy' || body.minProceedsP === undefined, {
    message: 'minProceedsP is not allowed on a buy',
    path: ['minProceedsP'],
  })
  .refine((body) => body.side !== 'sell' || body.maxCostP === undefined, {
    message: 'maxCostP is not allowed on a sell',
    path: ['maxCostP'],
  })
  .meta({ id: 'TradeBody' });
export type TradeBody = z.infer<typeof tradeBodySchema>;

/**
 * What an `Idempotency-Key` is compared against on replay: the terms as wire strings, so a
 * stored order row and a fresh body compare with `===` field by field.
 */
export const tradeTermsSchema = z
  .object({
    marketId: uuidSchema,
    outcome: outcomeSchema,
    side: orderSideSchema,
    shares: sharesSchema,
    maxCostP: pAmountSchema.nullable(),
    minProceedsP: pAmountSchema.nullable(),
  })
  .meta({ id: 'TradeTerms' });
export type TradeTerms = z.infer<typeof tradeTermsSchema>;

export function tradeTerms(body: TradeBody): TradeTerms {
  return {
    marketId: body.marketId,
    outcome: body.outcome,
    side: body.side,
    shares: body.shares,
    maxCostP: body.maxCostP === undefined ? null : serializePAmount(body.maxCostP),
    minProceedsP: body.minProceedsP === undefined ? null : serializePAmount(body.minProceedsP),
  };
}

/** True when two sets of terms are the same trade (a same-key replay is allowed). */
export function sameTradeTerms(a: TradeTerms, b: TradeTerms): boolean {
  return (
    a.marketId === b.marketId &&
    a.outcome === b.outcome &&
    a.side === b.side &&
    a.shares === b.shares &&
    a.maxCostP === b.maxCostP &&
    a.minProceedsP === b.minProceedsP
  );
}

/** The caller's own order (`GET /me/orders`). */
export const orderSchema = z
  .object({
    id: z.uuid(),
    marketId: z.uuid(),
    marketSlug: z.string(),
    marketTitle: z.string(),
    outcome: outcomeSchema,
    side: orderSideSchema,
    type: orderTypeSchema,
    qty: countSchema,
    filledQty: countSchema,
    status: orderStatusSchema,
    /** From the fill; null while nothing filled. */
    amountP: pAmountSchema.nullable(),
    priceAvgBp: bpSchema.nullable(),
    maxCostP: pAmountSchema.nullable(),
    minProceedsP: pAmountSchema.nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Order' });
export type Order = z.infer<typeof orderSchema>;

/** Public and anonymous (PLAN 7.1): no user id. `id` is a bigserial as a decimal string. */
export const fillSchema = z
  .object({
    id: z.string(),
    outcome: outcomeSchema,
    side: orderSideSchema,
    qty: countSchema,
    amountP: pAmountSchema,
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
    marketLastPrice: priceSchema,
    resolvedResult: outcomeSchema.nullable(),
    outcome: outcomeSchema,
    qty: countSchema,
    costBasisP: pAmountSchema,
    realizedPnlP: pAmountSchema,
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

/** Market stats every trade answer and tick carries. */
export const marketStatsSchema = z
  .object({
    id: z.uuid(),
    lastPrice: priceSchema,
    pYesBp: bpSchema,
    volumeP: pAmountSchema,
    tradeCount: countSchema,
  })
  .meta({ id: 'MarketStats' });
export type MarketStats = z.infer<typeof marketStatsSchema>;

/**
 * `POST /trades` answer. On an `Idempotency-Key` replay the order/fill half is the first
 * answer; balance, position and market are current (same split as the charge replay).
 */
export const tradeResultSchema = z
  .object({
    order: orderSchema,
    fill: fillSchema,
    balance: balanceSchema,
    position: positionSchema,
    market: marketStatsSchema,
  })
  .meta({ id: 'TradeResult' });
export type TradeResult = z.infer<typeof tradeResultSchema>;

// ---- ticks --------------------------------------------------------------------------
/**
 * One point of a price series. At `resolution=raw` it is a stored tick and `ts` is the tick's
 * own instant. At a bucketed resolution it is a SAMPLE: `ts` is a boundary on the absolute
 * grid and `pYesBp`/`trigger` come from the last tick at or before it — the probability in
 * force then, exact because the series is a step function (the LMSR state holds between
 * trades). Render it with a step curve, never straight interpolation.
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

/** `GET /markets/:id/ticks` (no `.meta`: query DTO). `resolution` selects the sampled grid. */
export const ticksQuerySchema = z
  .object({
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    resolution: tickResolutionSchema.default('raw'),
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
     * The market's trade count as of `to`, read in the same statement as `to` itself: the only
     * field here that says what the answer CONTAINS rather than when it was written.
     *
     * `to` cannot say it. A trade stamps its tick with `clock_timestamp()` read INSIDE its
     * transaction, before its writes (trade.service.ts), so the instant is fixed several
     * statements before the row commits — and this route's own clock read takes no lock, so it
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
    /** Admin user id, or null for system transitions (worker close/finalize). */
    actorId: z.string().nullable(),
    payload: z.unknown().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'MarketEvent' });
export type MarketEvent = z.infer<typeof marketEventSchema>;

// ---- admin --------------------------------------------------------------------------
/** Detail for `/admin/markets/:id`: the public shape plus LMSR state and exposure. */
export const adminMarketSchema = marketSchema
  .extend({
    /** numeric(18,6) as a decimal string. */
    liquidityB: z.string(),
    /** numeric(24,10) as decimal strings. */
    qYes: z.string(),
    qNo: z.string(),
    initialProbBp: z.number().int().min(INITIAL_PROB_BP_MIN).max(INITIAL_PROB_BP_MAX),
    /** maxLossP(p0, b) (ADR-0027). */
    reserveP: pAmountSchema,
    createdBy: z.string(),
    updatedAt: z.iso.datetime(),
    /** Σ buy amounts − Σ sell amounts over the market's fills. */
    netCollectedP: pAmountSchema,
    /** Σ positions.qty per outcome where settled = false. */
    openInterest: z.object({ yes: countSchema, no: countSchema }),
    /** Newest first, at most 100. */
    events: z.array(marketEventSchema),
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

/** ≤ 6 decimals: numeric(18,6) would silently round anything finer. */
const atMostSixDecimals = (value: number) => Number(value.toFixed(6)) === value;

const marketFields = {
  title: z.string().trim().min(1).max(MARKET_TITLE_MAX),
  description: z.string().max(MARKET_TEXT_MAX).nullish(),
  /** May be blank while draft; `open` refuses a blank one with RULES_REQUIRED. */
  rules: z.string().max(MARKET_TEXT_MAX),
  resolutionSource: z.string().trim().max(MARKET_SOURCE_MAX).nullish(),
  /** int4 column: an unbounded id would reach Postgres as an out-of-range parameter (500). */
  categoryId: z.number().int().positive().max(INT4_MAX),
  imageUrl: z
    .url({ protocol: /^https?$/ })
    .max(MARKET_IMAGE_URL_MAX)
    .nullish(),
  closeAt: z.iso.datetime(),
  initialProbBp: z.number().int().min(INITIAL_PROB_BP_MIN).max(INITIAL_PROB_BP_MAX),
  liquidityB: z
    .number()
    .min(LIQUIDITY_B_MIN)
    .max(LIQUIDITY_B_MAX)
    .refine(atMostSixDecimals, 'at most 6 decimal places'),
  /** Omitted: the server derives one from the title (`slugify` + a random tag). */
  slug: marketSlugSchema.optional(),
};

/** `POST /admin/markets` → a draft. */
export const createMarketBodySchema = z.object(marketFields).meta({ id: 'CreateMarketBody' });
export type CreateMarketBody = z.infer<typeof createMarketBodySchema>;

/** `PATCH /admin/markets/:id`: which fields a status admits is the service's decision. */
export const updateMarketBodySchema = z
  .object(marketFields)
  .partial()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'at least one field is required',
  )
  .meta({ id: 'UpdateMarketBody' });
export type UpdateMarketBody = z.infer<typeof updateMarketBodySchema>;

/** `POST /admin/markets/:id/void`. (The resolve body arrives with M5.) */
export const voidMarketBodySchema = z
  .object({ reason: z.string().trim().min(1).max(MARKET_VOID_REASON_MAX) })
  .meta({ id: 'VoidMarketBody' });
export type VoidMarketBody = z.infer<typeof voidMarketBodySchema>;

/** `GET /admin/markets` (no `.meta`: query DTO). Any status, draft included; omitted = all. */
export const adminMarketListQuerySchema = cursorQuerySchema.extend({
  status: marketStatusSchema.optional(),
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
