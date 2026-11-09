import { Inject, Injectable } from '@nestjs/common';
import { DAY_AGO, marketPriceAt, readPublicJudgementDelay, schema, type Db } from '@buddha/db';
import {
  ALL_MARKET_STATUSES,
  FILLS_RECENT_LIMIT,
  PUBLIC_MARKET_STATUSES,
  TICKS_MAX_POINTS,
  TICKS_SCAN_MAX,
  isDisputeOpen,
  isDisputeUnderReview,
  isJudgementDelayed,
  marketJudgementDelayOf,
  publicFill,
  serializeCoinAmount,
  tagKey,
  tickBucketSeconds,
  uuidParamSchema,
  type Category,
  type Fill,
  type JudgementDelayRecord,
  type Market,
  type MarketJudgingRecord,
  type MarketDisplayState,
  type MarketListQuery,
  type MarketRuleItems,
  type MarketRuleVersion,
  type MarketSummary,
  type MarketTimes,
  type PriceSeries,
  type PriceTick,
  type TickBucketSeconds,
  type TicksQuery,
} from '@buddha/shared';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { type Page } from '../wallet/wallet.service.js';
import { marketOrder } from './market-order.js';
import { readMarketSources, type MarketSources } from './market-sources.js';
import { readMarketJudgingRecord } from './market-judging-record.js';
import { readPublicRuleVersions } from './market-supplement.js';

export type MarketRow = typeof schema.markets.$inferSelect;
/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * One row of the bucketed tick query. `tsMs` is epoch millis as text, not a Date: drizzle's
 * node-postgres session installs its own timestamp parsers, so a raw `db.execute` never hands
 * back a Date (the same reason `clockTimestamp` reads the clock as millis, clock.ts).
 */
interface SampledRow {
  tsMs: string;
  pYesBp: number;
}

/**
 * Every point of the price history is a fill (#121, ADR-0116: the history is the `fills` rows,
 * ADR-0107 결정 1 #177 11항), so every point's trigger is a trade: the open's 50% and a judgement
 * are no point. `'resolve'` stays a reserved value nothing serves.
 */
const FILL_TRIGGER: PriceTick['trigger'] = 'trade';

/**
 * A fill's YES value as a point's basis points (`yes_price_coin × 100`, lossless: a YES value is
 * a whole Coin 1..99).
 */
const fillYesBp = sql<number>`${schema.fills.yesPriceCoin} * 100`;

/** The category half of every market read: the list card shows slug and name only. */
export interface CategoryRef {
  slug: string;
  nameKo: string;
}

/** Columns every market query selects: the row plus its category (inner join). */
export const marketWithCategory = {
  market: schema.markets,
  category: { slug: schema.categories.slug, nameKo: schema.categories.nameKo },
};

/**
 * What a market's status displays read of its row (`MarketDisplayState`, market-times.ts): the
 * status, the scheduled judgement, the current judgement's 이의 기한, the 판정 이의 holding it
 * (`dispute_hold_count`, the mirror the @buddha/db dispute helpers keep under the market lock;
 * #175, ADR-0104) and whether a 판정 정정 waits (`correction_pending`, the mirror the judgement
 * writes keep likewise; #176, ADR-0105) — every list's row carries them, so no list joins the
 * disputes or the approval requests.
 */
export function displayStateOf(
  row: Pick<
    MarketRow,
    'status' | 'scheduledJudgementAt' | 'disputeDeadline' | 'disputeHoldCount' | 'correctionPending'
  >,
): MarketDisplayState {
  return {
    status: row.status,
    scheduledJudgementAt: row.scheduledJudgementAt?.toISOString() ?? null,
    disputeDeadline: row.disputeDeadline?.toISOString() ?? null,
    disputeHoldCount: row.disputeHoldCount,
    correctionPending: row.correctionPending,
  };
}

/**
 * A market's card (PLAN 7.1). Its displays are read by `nowMs` — the API host's clock when the
 * answer is built, so no client clock decides them and the server-rendered page and the browser
 * read the same answer. Displays, not statuses: nothing is written at those instants, so unlike the
 * instants a write orders its rows by they need no database clock (clock.ts):
 * - `judgementDelayed` '판정 지연' (#22, ADR-0098; ADR-0093 decision 1 #173 items 11·12): a CLOSED
 *   market whose scheduled judgement has passed, or a PROVISIONAL one a 판정 이의 or a waiting 판정
 *   정정 still holds once its 이의 기한 has come (#175, ADR-0104, owner answer 2026-11-03; #176);
 * - `disputeUnderReview` '이의 검토 중' (#173 item 12): PROVISIONAL with a 판정 이의 holding it;
 * - `disputeOpen`: PROVISIONAL before its 이의 기한 — 판정 이의 are taken (#173 items 5·6);
 * - `judgementVersion` and `disputeDeadline`, the current judgement's, public since #175 (#173
 *   items 6·13: the deadline and the submission link are shown to anonymous visitors).
 */
export function toMarketSummary(
  row: MarketRow,
  category: CategoryRef,
  nowMs: number = Date.now(),
): MarketSummary {
  const display = displayStateOf(row);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category,
    imageUrl: row.imageUrl,
    status: row.status,
    judgementDelayed: isJudgementDelayed(display, nowMs),
    disputeUnderReview: isDisputeUnderReview(display),
    lastPrice: row.lastPrice,
    lastFillAt: row.lastFillAt?.toISOString() ?? null,
    volumeCoin: serializeCoinAmount(row.volumeCoin),
    tradeCount: row.tradeCount,
    traderCount: row.traderCount,
    closeAt: row.closeAt.toISOString(),
    openAt: row.openAt?.toISOString() ?? null,
    resolvedResult: row.resolvedResult,
    judgementVersion: row.judgementVersion,
    disputeDeadline: display.disputeDeadline,
    disputeOpen: isDisputeOpen(display, nowMs),
    // bigint column read in number mode; on the wire it is a decimal string like every other
    // serial key an event is ordered by (`supersedes`, realtime.ts).
    statusEventId: row.statusEventId === null ? null : String(row.statusEventId),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A market's rule items (#23, ADR-0097) in RULE_ITEMS order, from its row and its `market_sources`
 * (`readMarketSources`): the DTO's, the open-items check's and the `rules_edited` record's one
 * reading of them. The event deadline is an ISO instant, as every instant on the wire.
 */
export function ruleItemsOf(row: MarketRow, sources: MarketSources): MarketRuleItems {
  return {
    description: row.description,
    yesCondition: row.yesCondition,
    noCondition: row.noCondition,
    eventDeadline: row.eventDeadline?.toISOString() ?? null,
    primarySource: sources.primarySource,
    fallbackSources: sources.fallbackSources,
    fallbackCondition: row.fallbackCondition,
    longDelayDays: row.longDelayDays,
    delayHandling: row.delayHandling,
  };
}

/**
 * A market's times beside its close (#22, ADR-0098; `marketTimesSchema`): each instant as ISO and
 * the judgement time zone as its IANA name, null for one not filled in — the announcement's null is
 * '없음'. The DTO's, the open-items check's, the snapshot's and the time rules' one reading of them.
 */
export function timesOf(row: MarketRow): MarketTimes {
  return {
    scheduledOpenAt: row.scheduledOpenAt?.toISOString() ?? null,
    scheduledAnnouncementAt: row.scheduledAnnouncementAt?.toISOString() ?? null,
    scheduledJudgementAt: row.scheduledJudgementAt?.toISOString() ?? null,
    judgementTimeZone: row.judgementTimeZone,
  };
}

/**
 * Public detail (PLAN 7.1): no author, exposure or settlement steps. `tags` are the market's
 * (`marketTagNames`) and `sources` its sources (`readMarketSources`) — the detail's alone, never a
 * card's (#17, #23): the rule items and the times (`timesOf`, #22) are public in every public
 * status, signed in or not (N02 §2, N03 §4). So are its current rule version and `ruleVersions`,
 * the history (#80, ADR-0101; `readPublicRuleVersions`, which names nobody), read by the caller in
 * the same snapshot as the row, and while the market reads '판정 지연' its current 판정 지연 기록
 * (#142, ADR-0106; `judgementDelay`, `marketJudgementDelayOf`): `judgementDelays` are the market's
 * records the newest first, read likewise — the public detail's one current record
 * (`readPublicJudgementDelay`, which names nobody and carries no record time), the admin detail's
 * every record (`readJudgementDelays`). Every display is read at ONE `nowMs`, the card's flags
 * (`toMarketSummary`) and the record's '갱신 대기' alike, so `judgementDelayed` and
 * `judgementDelay` never disagree. `lastPrice24hAgo` is the 시장가격 a day before the answer
 * (`marketPriceAt` at `DAY_AGO`, #121, ADR-0116), read by the caller in the same snapshot as the
 * row: the change badge's baseline, null when no fill came by then, whatever the status.
 */
export function toMarket(
  row: MarketRow,
  category: CategoryRef,
  tags: string[],
  sources: MarketSources,
  ruleVersions: MarketRuleVersion[],
  judgementDelays: readonly JudgementDelayRecord[],
  lastPrice24hAgo: number | null,
  judgingRecord: MarketJudgingRecord,
  nowMs: number = Date.now(),
): Market {
  return {
    ...toMarketSummary(row, category, nowMs),
    ...ruleItemsOf(row, sources),
    ...timesOf(row),
    tags,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    settledAt: row.settledAt?.toISOString() ?? null,
    ruleVersion: row.ruleVersion,
    ruleVersions,
    judgementDelay: marketJudgementDelayOf(
      judgementDelays,
      { ...displayStateOf(row), judgementVersion: row.judgementVersion },
      nowMs,
    ),
    lastPrice24hAgo,
    judgingRecord,
  };
}

/**
 * A market's tag names (#17, ADR-0093 decision 2 #172 item 2) in the order the operator entered
 * them (`market_tags.position`), each its tag's stored spelling — the one it was first made with.
 * Through `executor`, so a write answers with what it wrote.
 */
export async function marketTagNames(executor: Db | Tx, marketId: string): Promise<string[]> {
  const rows = await executor
    .select({ name: schema.tags.name })
    .from(schema.marketTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.marketTags.tagId))
    .where(eq(schema.marketTags.marketId, marketId))
    .orderBy(asc(schema.marketTags.position));
  return rows.map((row) => row.name);
}

/**
 * The predicate of every public read of a market (ADR-0093 decision 1 item 12, #174): a status
 * users see (`PUBLIC_MARKET_STATUSES`), so DRAFT and REVIEW — the admin's alone — are on no list
 * and answer NOT_FOUND, the same as an id that does not exist. The detail, the list, the
 * discussion, the watchlist, the themes, the related markets and the proposals all filter by it.
 */
export function isPublicMarket(): SQL {
  return inArray(schema.markets.status, [...PUBLIC_MARKET_STATUSES]);
}

/**
 * `%`, `_` and `\` in a search term are literal characters, not LIKE wildcards. The public list's
 * search and the admin list's (`MarketAdminService.list`) take the term the same way.
 */
export function likePattern(q: string): string {
  return `%${q.replaceAll(/[%_\\]/g, (m) => `\\${m}`)}%`;
}

/**
 * The public search (`GET /markets?q=`; ADR-0061 decision 1 item 14, ADR-0066, #17): a title
 * holding the term (`likePattern`, case-insensitive) or a tag named exactly the term — `tagKey`,
 * so case and the spaces around and inside it aside, as two tag names are one tag. Not a partial
 * tag match: the detail's tag links search for the tag's whole name. The tag half is a correlated
 * EXISTS on `market_tags_tag_id_market_id_idx` behind the unique `name_key`; the title half stays
 * a plain `ILIKE` with no index of its own (ADR-0066). The admin list's `q` is the title alone.
 */
export function matchesSearch(db: Db, q: string): SQL | undefined {
  const { markets, marketTags, tags } = schema;
  return or(
    ilike(markets.title, likePattern(q)),
    exists(
      db
        .select({ one: sql`1` })
        .from(marketTags)
        .innerJoin(tags, eq(tags.id, marketTags.tagId))
        .where(and(eq(marketTags.marketId, markets.id), eq(tags.nameKey, tagKey(q)))),
    ),
  );
}

/**
 * `?category=<slug>` on either level of the two-level tree: a top-level slug lists every
 * market filed under any of its sub-categories (and under itself, should an admin file one
 * there), a leaf slug lists its own. A predicate on `markets.category_id` rather than a second
 * join on the aliased parent row, so the card query keeps the exact shape the M3 keyset tests
 * pin and `markets_category_id_status_idx` still applies; the inner selects touch a table of
 * ~30 rows. An unknown slug resolves to an empty set, which is the empty page it always was.
 *
 * A function rather than a method because `GET /me/watchlist` filters by the same resolution
 * (ADR-0064): the 관심 시장 toggle of the home (#63) combines with a category, and the two lists
 * must agree on what a category holds.
 */
export function inCategory(db: Db, slug: string) {
  const { markets, categories } = schema;
  const named = db.select({ id: categories.id }).from(categories).where(eq(categories.slug, slug));
  return inArray(
    markets.categoryId,
    db
      .select({ id: categories.id })
      .from(categories)
      .where(or(eq(categories.slug, slug), inArray(categories.parentId, named))),
  );
}

/**
 * Public market reads (PLAN 5.2, 7.1; M3). A DRAFT or REVIEW market is invisible on every public
 * route (`isPublicMarket`) — the list never returns one and the detail, fills and ticks routes
 * answer NOT_FOUND for one, the same as for an id that does not exist: only admins know it
 * exists. A SCHEDULED market is public before it opens (ADR-0093 decision 1 item 12).
 */
@Injectable()
export class MarketService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Keyset-paginated per order (`marketOrder`, market-order.ts — the one place the market orders
   * live, ADR-0065): 추천 joins its 24-hour volume laterally and pages on (window end, volume,
   * open time, id), 신규 on (open time, id), 마감 임박 on (close time, id) — or, when the list can
   * hold a closed market, on (not closed yet first, signed close time, id). A cursor that does not
   * decode for the order serves the first page rather than a 500 (see decodeKeyset).
   *
   * `status=all` is every public status (the search screen's '모든 상태', ADR-0066; CANCELLED
   * included, ADR-0093 decision 3): DRAFT and REVIEW are still never listed. The search
   * (`matchesSearch`) is a title partial match — a plain `ILIKE` over the candidate rows, with no
   * index of its own (ADR-0066 says why): the sort reads every candidate anyway — or a tag exact
   * match (#17).
   */
  async list(query: MarketListQuery): Promise<Page<MarketSummary>> {
    const { markets, categories } = schema;
    const { limit } = query;
    const order = marketOrder(this.db, query.sort, query.cursor, query.status);
    const filters = [
      query.status === ALL_MARKET_STATUSES ? isPublicMarket() : eq(markets.status, query.status),
      query.category ? inCategory(this.db, query.category) : undefined,
      query.q ? matchesSearch(this.db, query.q) : undefined,
    ];

    let select = this.db
      .select({ ...marketWithCategory, order: order.fields })
      .from(markets)
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .$dynamic();
    if (order.lateral) select = select.crossJoinLateral(order.lateral);
    const rows = await select
      .where(and(...filters, order.after))
      .orderBy(...order.orderBy)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => toMarketSummary(row.market, row.category)),
      nextCursor: hasMore && last ? order.cursorOf(last) : null,
    };
  }

  /**
   * `GET /markets/:idOrSlug`: a uuid-shaped parameter is an id, anything else a slug (which
   * `marketSlugSchema` keeps from ever looking like a uuid). The slug is NFC-normalised like
   * the stored one, so a decomposed Korean URL still finds the market. The tags and the sources
   * are a statement each (#17, #23), and so are the rule versions (#80), the current 판정 지연
   * 기록 (#142) and the 시장가격 a day ago (#121): the detail alone carries them.
   */
  async getPublic(idOrSlug: string): Promise<Market> {
    const { markets, categories } = schema;
    // The id branch goes through the schema's value, not just its verdict: lower-cased like
    // every request-supplied uuid (api/uuid.ts), so the row is read by its canonical id. The
    // slug arrives NFC from the route schema already and is normalised again below, so the
    // invariant holds for a caller that bypasses the pipe (an M4 subscription, say).
    const parsedId = uuidParamSchema.safeParse(idOrSlug);
    // One read-only REPEATABLE READ snapshot (Codex review of #78): a SCHEDULED market can go back
    // to a draft (#78's 되돌리기), so the public check and the tags and sources read after it must
    // describe one version — else a revert and a draft edit committing between them would answer
    // 200 with the draft's new tags and sources. The rule versions too (#80): a supplement
    // approved between the reads would otherwise pair the old text with the new history. And the
    // delay record (#142): the current one as of the row, never a newer record beside an older
    // status, reason or '판정 지연' reading. And the price a day ago (#121): never a fill newer
    // than the row's `last_price` beside it.
    return this.db.transaction(
      async (tx) => {
        const [row] = await tx
          .select(marketWithCategory)
          .from(markets)
          .innerJoin(categories, eq(categories.id, markets.categoryId))
          .where(
            and(
              parsedId.success
                ? eq(markets.id, parsedId.data)
                : eq(markets.slug, idOrSlug.normalize('NFC')),
              isPublicMarket(),
            ),
          )
          .limit(1);
        if (!row) throw new AppError('NOT_FOUND', { message: 'Market not found' });
        const tags = await marketTagNames(tx, row.market.id);
        const sources = await readMarketSources(tx, row.market.id);
        const ruleVersions = await readPublicRuleVersions(tx, row.market.id);
        const delay = await readPublicJudgementDelay(tx, row.market);
        const lastPrice24hAgo = await marketPriceAt(tx, row.market.id, DAY_AGO);
        return toMarket(
          row.market,
          row.category,
          tags,
          sources,
          ruleVersions,
          delay === null ? [] : [delay],
          lastPrice24hAgo,
          await readMarketJudgingRecord(tx, row.market),
        );
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  /**
   * The market row for a public sub-resource (fills, ticks, related markets, themes): NOT_FOUND
   * for an unknown id and for a DRAFT or REVIEW market alike — with the database clock read in
   * the same statement, so a window the caller left open ends on the clock fills are stamped with
   * and not the API host's, at no extra round trip (clock.ts, A-M3-16). Epoch millis as text, like
   * `clockTimestamp`: no driver-side date parser is involved.
   */
  async requirePublicAt(marketId: string): Promise<{ market: MarketRow; now: Date }> {
    const [row] = await this.db
      .select({
        market: schema.markets,
        nowMs: sql<string>`(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text`,
      })
      .from(schema.markets)
      .where(and(eq(schema.markets.id, marketId), isPublicMarket()))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Market not found' });
    const ms = Number(row.nowMs);
    if (!Number.isSafeInteger(ms)) {
      throw new AppError('INTERNAL', { message: 'clock_timestamp() returned no value' });
    }
    return { market: row.market, now: new Date(ms) };
  }

  async requirePublic(marketId: string): Promise<MarketRow> {
    return (await this.requirePublicAt(marketId)).market;
  }

  /**
   * 최근 체결: the newest FILLS_RECENT_LIMIT fills, anonymous (PLAN 7.1; ADR-0107 결정 6 '남은
   * 것'의 #60 3·6·17·20항): `publicFill`, the one shape `market:trade` carries too — the contract, its
   * price, the YES value, qty, amount and time; no owner, order, taker direction or account type. A
   * backward walk of `fills_market_id_created_at_id_idx` (#121).
   */
  async listFills(marketId: string): Promise<Fill[]> {
    await this.requirePublic(marketId);
    const rows = await this.db
      .select()
      .from(schema.fills)
      .where(eq(schema.fills.marketId, marketId))
      .orderBy(desc(schema.fills.createdAt), desc(schema.fills.id))
      .limit(FILLS_RECENT_LIMIT);
    return rows.map(publicFill);
  }

  /**
   * Price history for the chart (PLAN 7.1, 11.4). At most TICKS_MAX_POINTS points, ascending.
   *
   * The points are the market's fills (#121, ADR-0116): each one's YES value at its server time,
   * read off `fills_market_id_created_at_id_idx` — the key shape `price_ticks` had (0010), which
   * nothing reads or writes any more.
   *
   * `raw` is the fills of the range, downsampled by the newest-anchored stride
   * (A-M3-25) over the newest TICKS_SCAN_MAX rows (A-M3-20); it now reports `truncated`,
   * which a client previously could not tell (Q-M3-8 (1)).
   *
   * `1m`/`1h` are a sampled grid instead: for each of at most TICKS_MAX_POINTS boundaries the
   * query reads the last fill at or before it (one index descent each), so the cost is bounded
   * by the ANSWER, not by the market's fill count, and the row cap does not apply. That also
   * settles the two things bucketing usually needs extra machinery for: a bucket with no trade
   * repeats the value in force (dropped again below as a duplicate), and the boundary at
   * `from` looks back past `from`, so the chart's left edge is filled whenever a fill precedes
   * it (before the market's first fill there is no point — the open writes none, ADR-0116).
   *
   * The stride is coarsened until the window fits (`tickBucketSeconds`) rather than striped,
   * so points stay evenly spaced; `bucketSeconds` reports what was served. A bucketed answer
   * is never `truncated`: its grid spans the whole window it echoes (ADR-0029).
   */
  async listTicks(marketId: string, query: TicksQuery): Promise<PriceSeries> {
    // The row and the DB clock in one statement, as every public sub-resource reads them: the
    // window's open end is `now` as the database sees it and its start defaults to the
    // market's own opening, so no probe query is needed.
    const { market, now } = await this.requirePublicAt(marketId);
    // Close the window first, then clamp its start DOWN to it. `ticksQuerySchema` only orders
    // the two bounds when both are given, so a defaulted one can still invert the window — a
    // `to` older than the market's opening (a client paging backwards through history), or a
    // `from` from a clock running fast against an omitted `to`. Restoring the invariant by
    // moving `to` UP instead would answer a window NEWER than the one asked for: the grid
    // would pin a boundary at the opening and serve a point after the caller's `to`, while
    // `raw` — which filters on the untouched `query.to` — answered nothing for the same
    // request. Clamping down keeps both resolutions describing the same window.
    const to = new Date(query.to ? Date.parse(query.to) : now.getTime());
    // A RELATIVE range is opened from `to` — the DATABASE's own instant — so the window a client
    // asked for is the window it gets whatever its clock says. `from` names an absolute instant
    // and is kept for a caller that really means one; a client deriving it from `Date.now()` was
    // measuring one end of the window on its machine and the other on this one, and the span came
    // out wrong by the skew (A-M4-35). The two are mutually exclusive at the schema.
    const requestedFrom = query.from
      ? new Date(query.from)
      : query.windowSeconds !== undefined
        ? new Date(to.getTime() - query.windowSeconds * 1_000)
        : (market.openAt ?? market.createdAt);
    const from = new Date(Math.min(requestedFrom.getTime(), to.getTime()));
    // The window the CALLER named is a FILTER; a defaulted one is only a description. Those are
    // different jobs and the raw path has to be handed the first, not left to re-derive it: it
    // filtered on `query.from` alone, so a RELATIVE window — which names its start just as
    // definitely, only by duration — bounded nothing. `?windowSeconds=3600` echoed one hour and
    // served the newest TICKS_SCAN_MAX ticks of the market's whole history, points hours older
    // than the `from` beside them. Reachable on the DEFAULT resolution: `resolution` defaults to
    // `raw` (market.ts), which is the one value `tickBucketSeconds` answers 0 for.
    //
    // `market.openAt` deliberately stays OUT of the filter. No point can predate a market's
    // opening — points are fills, and a market not yet open takes no orders — so flooring
    // there would only make the answer depend on a bound it cannot need, and the suite pins that
    // reading outright ("`from` older than the bound is a filter, not a floor").
    const filterFrom =
      query.from !== undefined
        ? new Date(query.from)
        : query.windowSeconds !== undefined
          ? from
          : undefined;
    const bucketSeconds = tickBucketSeconds(query.resolution, to.getTime() - from.getTime());
    if (bucketSeconds === 0) {
      return this.rawSeries(marketId, query.resolution, filterFrom, from, to, market.tradeCount);
    }
    // Even the coarsest stride cannot cover a window this wide (about ten years). Trim the old
    // end rather than overrun the documented cap; the narrowed `from` in the response is what
    // says so. `truncated` stays false and keeps the raw path's verified meaning — "points
    // older than the served ones exist INSIDE the served window but were left out" — which no
    // bucketed answer can hit: the boundary at `start` looks back past `start`, so the oldest
    // point returned is the window's own left edge, or the first boundary after the first fill
    // when the window opens before it — nothing inside the window is dropped either way. Reporting
    // the trim here instead would assert dropped history without ever probing for it.
    const maxSpanMs = bucketSeconds * 1_000 * (TICKS_MAX_POINTS - 2);
    const start = new Date(Math.max(from.getTime(), to.getTime() - maxSpanMs));
    return {
      resolution: query.resolution,
      bucketSeconds,
      from: start.toISOString(),
      to: to.toISOString(),
      truncated: false,
      // From `requirePublicAt` above — the same statement that produced the LIVE `to`, and
      // deliberately BEFORE the sampling statement below. An earlier snapshot can only LAG the
      // points, and lagging is the harmless direction; a counter read after them could claim a
      // trade they predate (packages/shared market.ts states which way that fails). When the
      // CALLER pinned `to`, this is still the counter at answer time — the schema says so, and
      // says why the row cannot answer otherwise.
      tradeCount: market.tradeCount,
      points: await this.sampleTicks(marketId, start, to, bucketSeconds),
    };
  }

  /**
   * The probability in force at every boundary of the absolute `bucketSeconds` grid over
   * [from, to]. Exact, not an approximation: the series is a step function (the price holds
   * between fills), so the last fill at or before a boundary IS the value there.
   */
  private async sampleTicks(
    marketId: string,
    from: Date,
    to: Date,
    bucketSeconds: TickBucketSeconds,
  ): Promise<PriceTick[]> {
    // The stride is a BOUND PARAMETER, not interpolated SQL: make_interval takes seconds, so
    // no interval text ever reaches the parser and no whitelist table is needed.
    const stride = sql`make_interval(secs => ${bucketSeconds}::double precision)`;
    const start = sql`${from.toISOString()}::timestamptz`;
    const end = sql`${to.toISOString()}::timestamptz`;
    // Every clause is load-bearing:
    // - `union`, not `union all`: a `from`/`to` that already sits on the grid collapses into
    //   the generated boundary, so the count stays <= TICKS_MAX_POINTS and `lag` has a total
    //   order.
    // - the origin is spelled with its offset: a bare `timestamptz '1970-01-01'` is read in
    //   the session TimeZone GUC, which createDb never sets, and the grid would then shift for
    //   every stride the server's offset does not divide.
    // - `date_bin(stride, from, epoch) + stride` is the first grid point strictly after
    //   `from` in both the on-grid and the mid-bucket case, so the explicit `from` boundary is
    //   never shadowed and every returned `ts` lies inside [from, to].
    // - `cross join lateral`, not `left join`: boundaries before the market's first fill
    //   produce no row and vanish, so a market with no fill answers with no points at all.
    // - `order by f.created_at desc, f.id desc limit 1` is the exact prefix of
    //   fills_market_id_created_at_id_idx, i.e. one backward index descent per boundary.
    // - `previous_bp is distinct from p_yes_bp or rn = cnt` keeps the first row (`lag` is
    //   NULL, hence distinct), every change and the last row: lossless for a step curve, and
    //   a flat 24 h window costs two points instead of 288.
    // `db.execute` hands back the driver result, read as `clockTimestamp` reads it (clock.ts) —
    // and the boundary comes back as epoch millis for the same reason it does there: drizzle's
    // node-postgres session replaces the driver's timestamptz parser, so a raw `execute` yields
    // the wire string rather than a Date and `new Date(<pg text>)` would be at the mercy of the
    // host's non-ISO date parsing.
    const result: unknown = await this.db.execute(sql`
      with boundaries as (
        select ${start} as b
        union
        select g from generate_series(
          date_bin(${stride}, ${start}, timestamptz '1970-01-01 00:00:00+00') + ${stride},
          ${end},
          ${stride}
        ) as g
        union
        select ${end}
      ),
      sampled as (
        select boundaries.b as ts, fill.p_yes_bp
        from boundaries
        cross join lateral (
          select f.yes_price_coin * 100 as p_yes_bp
          from fills f
          where f.market_id = ${marketId}::uuid and f.created_at <= boundaries.b
          order by f.created_at desc, f.id desc
          limit 1
        ) as fill
      ),
      shaped as (
        select ts, p_yes_bp,
               lag(p_yes_bp) over (order by ts) as previous_bp,
               row_number() over (order by ts) as rn,
               count(*) over () as cnt
        from sampled
      )
      select (extract(epoch FROM ts) * 1000)::bigint::text as "tsMs",
             p_yes_bp as "pYesBp"
      from shaped
      where previous_bp is distinct from p_yes_bp or rn = cnt
      order by ts
    `);
    const rows = (result as { rows?: SampledRow[] }).rows ?? [];
    return rows.map((row) => ({
      ts: new Date(Number(row.tsMs)).toISOString(),
      pYesBp: row.pYesBp,
      trigger: FILL_TRIGGER,
    }));
  }

  /**
   * `resolution=raw`: the fills of the range, downsampled IN SQL to at most
   * TICKS_MAX_POINTS rows (PLAN 7.1). The window ranks the fills by (created_at, id), and the
   * outer query keeps a grid anchored at the NEWEST fill — it and every
   * `ceil(count / TICKS_MAX_POINTS)`-th row walking back from it, at most
   * TICKS_MAX_POINTS - 1 of them — plus the oldest row, ascending.
   *
   * Anchoring the grid at the newest end is what makes the cap exact. Anchored at the oldest
   * row instead, the grid holds up to TICKS_MAX_POINTS rows and the newest fill — the live
   * right edge of a chart, which the route promises to keep — falls off the stride, so the
   * answer carried one row too many for 190 of the possible counts (from 1,000 points up).
   * The unevenly spaced gap is now the first one, at the left edge, where nothing is live.
   * Node never holds the full series (a busy market has a point per fill), and neither does
   * the window: only the newest TICKS_SCAN_MAX fills of the range are ranked — a backward
   * index scan with a LIMIT on (market_id, created_at, id), so an anonymous request costs the
   * same on a market with a million fills as on one with ten thousand.
   *
   * The WHERE floors on the window the CALLER named — `filterFrom`, which is `query.from` or the
   * instant `windowSeconds` counts back from — and never on a defaulted one, so a defaulted
   * `from` describes what the answer covers while a requested one bounds it. `listTicks` decides
   * which is which; taking `filterFrom` as a parameter rather than re-reading `query` is what
   * stops this WHERE and the `truncated` probe below drifting apart from it again.
   */
  private async rawSeries(
    marketId: string,
    resolution: TicksQuery['resolution'],
    filterFrom: Date | undefined,
    from: Date,
    to: Date,
    tradeCount: number,
  ): Promise<PriceSeries> {
    const { fills } = schema;
    const recent = this.db
      .select({ id: fills.id, ts: fills.createdAt, pYesBp: fillYesBp.as('p_yes_bp') })
      .from(fills)
      .where(
        and(
          eq(fills.marketId, marketId),
          filterFrom ? gte(fills.createdAt, filterFrom) : undefined,
          // The window's own end, not `query.to`. `listTicks` closes the window on the database
          // clock when the caller sends no `to`, and this statement runs afterwards under its
          // own snapshot — so filtering on the REQUEST let a trade committing in between answer
          // with `ts` past the `to` this response echoes, and past the `tradeCount` read with
          // it. The bucketed path never had the gap: its grid is built from the same `to`.
          lte(fills.createdAt, to),
        ),
      )
      .orderBy(desc(fills.createdAt), desc(fills.id))
      .limit(TICKS_SCAN_MAX)
      .as('recent');
    const ranked = this.db
      .select({
        id: recent.id,
        ts: recent.ts,
        pYesBp: recent.pYesBp,
        rn: sql<number>`row_number() over (order by ${recent.ts}, ${recent.id})`.as('rn'),
        cnt: sql<number>`count(*) over ()`.as('cnt'),
      })
      .from(recent)
      .as('ranked');
    // `cnt` is cast, not the literal: a `${n}.0` would reach Postgres as `$1.0`.
    const stride = sql`greatest(1, ceil(${ranked.cnt}::numeric / ${TICKS_MAX_POINTS}))::bigint`;
    const rows = await this.db
      .select({ id: ranked.id, ts: ranked.ts, pYesBp: ranked.pYesBp, cnt: ranked.cnt })
      .from(ranked)
      .where(
        or(
          // The oldest row, and the grid running back from the newest: offset 0 (the newest
          // fill itself) up to (TICKS_MAX_POINTS - 2) strides, so at most TICKS_MAX_POINTS - 1
          // rows, and the oldest adds at most one more.
          eq(ranked.rn, 1),
          sql`(${ranked.cnt} - ${ranked.rn}) % ${stride} = 0
              and ${ranked.cnt} - ${ranked.rn} <= ${stride} * ${TICKS_MAX_POINTS - 2}`,
        ),
      )
      .orderBy(asc(ranked.ts), asc(ranked.id));
    const first = rows[0];
    // `cnt >= TICKS_SCAN_MAX` is the cheap pre-filter, not the answer: exactly at the cap the
    // range may hold nothing older. Confirm with one index descent, and only then — the extra
    // statement never runs on a market below the bound.
    const truncated =
      first !== undefined &&
      Number(first.cnt) >= TICKS_SCAN_MAX &&
      (await this.hasOlderFill(marketId, first.ts, first.id, filterFrom));
    return {
      resolution,
      bucketSeconds: 0,
      from: from.toISOString(),
      to: to.toISOString(),
      truncated,
      // Handed down from `listTicks`, which read it beside `to` — see the bucketed return.
      tradeCount,
      points: rows.map((row) => ({
        ts: row.ts.toISOString(),
        pYesBp: row.pYesBp,
        trigger: FILL_TRIGGER,
      })),
    };
  }

  /**
   * Does a fill inside the requested range predate the first served point? One index probe on
   * (market_id, created_at, id) via a row comparison, which is why the served point's id is
   * carried: fills share their intake's instant, and `created_at <` alone would call such a pair
   * truncation.
   */
  private async hasOlderFill(
    marketId: string,
    ts: Date,
    id: number,
    filterFrom: Date | undefined,
  ): Promise<boolean> {
    const { fills } = schema;
    const [row] = await this.db
      .select({ one: sql<number>`1` })
      .from(fills)
      .where(
        and(
          eq(fills.marketId, marketId),
          sql`(${fills.createdAt}, ${fills.id}) < (${ts.toISOString()}::timestamptz, ${id}::bigint)`,
          filterFrom ? gte(fills.createdAt, filterFrom) : undefined,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * Active categories, both levels, flat: parents in display order, then their leaves in
   * theirs — `parent_id` NULLS FIRST puts every top-level row ahead of every leaf, and the leaf
   * order within a parent is `sort_order`. A client groups leaves under parents by `parentId`
   * (web `groupCategories`); a leaf whose parent an admin retired is left out here rather than
   * handed over as an orphan the tree could not place.
   */
  async listCategories(): Promise<Category[]> {
    const { categories } = schema;
    const activeParents = this.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.isActive, true), sql`${categories.parentId} is null`));
    const rows = await this.db
      .select({
        id: categories.id,
        slug: categories.slug,
        nameKo: categories.nameKo,
        sortOrder: categories.sortOrder,
        parentId: categories.parentId,
      })
      .from(categories)
      .where(
        and(
          eq(categories.isActive, true),
          or(sql`${categories.parentId} is null`, inArray(categories.parentId, activeParents)),
        ),
      )
      .orderBy(
        sql`${categories.parentId} nulls first`,
        asc(categories.sortOrder),
        asc(categories.id),
      );
    return rows;
  }
}
