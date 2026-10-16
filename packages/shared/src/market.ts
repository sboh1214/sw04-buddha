import * as z from 'zod';
import { cursorQuerySchema } from './api/pagination.js';
import { coinAmountSchema } from './api/coin-amount.js';
import { uuidParamSchema } from './api/path-param.js';
import {
  BP_MAX,
  INT4_MAX,
  MARKET_IMAGE_URL_MAX,
  MARKET_RESOLVE_EVIDENCE_URL_MAX,
  MARKET_RESOLVE_NOTE_MAX,
  MARKET_SLUG_PATTERN,
  MARKET_SLUG_STEM_MAX,
  MARKET_SOURCE_MAX,
  MARKET_TEXT_MAX,
  MARKET_TITLE_MAX,
  PRICE_MAX,
  PRICE_MIN,
  TICKS_MAX_POINTS,
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
  settlementStepSchema,
  settlementStepStatusSchema,
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
   * YES price 1..99 of the last fill (PLAN 5.3); null until the market's first fill, which a
   * client shows as '체결 없음' (N02 §5). #121 and #64 define the market's price fields.
   */
  lastPrice: priceSchema.nullable(),
  volumeCoin: coinAmountSchema,
  tradeCount: countSchema,
  /**
   * The 사용자 참여자 the card and the detail header show, 0 included (ADR-0061 decision 1, item
   * 4). Who counts is #177's to decide; leaving the operator's bot out is #121's and #115's.
   */
  traderCount: countSchema,
  closeAt: z.iso.datetime(),
  openAt: z.iso.datetime().nullable(),
  resolvedResult: outcomeSchema.nullable(),
  /**
   * `market_events.id` of the transition that produced the current status, as a decimal string
   * — the ordering key of `market:status` (A-M3-19, Q-M3-8 (3)). Drawn while the writer holds
   * the market row FOR UPDATE, so it is the market's commit order: a client compares a snapshot
   * against an event with `statusSupersedes` (realtime.ts) instead of ranking statuses, which
   * stopped being a total order once M5's `result_changed` repeated a status. Null only for a
   * row written outside the transition paths (a test factory); the rank order is the fallback.
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
 * `adminMarketSchema` only.
 */
export const marketSchema = z
  .object({
    ...marketSummaryFields,
    description: z.string().nullable(),
    rules: z.string(),
    resolutionSource: z.string().nullable(),
    resolvedAt: z.iso.datetime().nullable(),
    settledAt: z.iso.datetime().nullable(),
    voidedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Market' });
export type Market = z.infer<typeof marketSchema>;

/** Statuses the public list may filter by: a draft is invisible outside the admin. */
export const PUBLIC_MARKET_STATUSES = [
  'open',
  'closed',
  'resolved',
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
  /** A category slug on either level: a top-level slug lists every sub-category under it. */
  category: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .describe('A category slug on either level; a top-level slug lists every sub-category under it')
    .optional(),
  status: publicMarketStatusSchema.default('open'),
  sort: marketSortSchema.default('volume'),
  /** Title search. */
  q: z.string().trim().min(1).max(100).optional(),
});
export type MarketListQuery = z.infer<typeof marketListQuerySchema>;

// ---- orders, fills, positions ------------------------------------------------------
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
    amountCoin: coinAmountSchema.nullable(),
    priceAvgBp: bpSchema.nullable(),
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
    resolvedResult: outcomeSchema.nullable(),
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
    /** Admin user id, or null for system transitions (worker close/finalize). */
    actorId: z.string().nullable(),
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
     * The settlement steps of a judged market (ADR-0046), in SETTLEMENT_STEPS order: one row per
     * step from the judgement on, empty before it and for a voided market. A `resolved` market
     * whose step stays `failed` is what the admin's '정산 대기' badge points at.
     */
    settlementSteps: z.array(adminSettlementStepSchema),
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

/**
 * `POST /admin/markets/:id/resolve` (PLAN 5.5, 7.3; ADR-0046): judge a closed market. The
 * result is final at once — the market becomes `resolved` and settlement starts; there is no
 * way to change it (#26 decides re-judgement). The note and the evidence are kept on the
 * `market_events` payload and the admin action, not on the market row: they are the audit
 * trail of the judgement.
 */
export const resolveMarketBodySchema = z
  .object({
    result: outcomeSchema,
    note: z.string().trim().max(MARKET_RESOLVE_NOTE_MAX).nullish(),
    evidenceUrl: z
      .url({ protocol: /^https?$/ })
      .max(MARKET_RESOLVE_EVIDENCE_URL_MAX)
      .nullish(),
  })
  .meta({ id: 'ResolveMarketBody' });
export type ResolveMarketBody = z.infer<typeof resolveMarketBodySchema>;

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
