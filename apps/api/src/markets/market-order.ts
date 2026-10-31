import { schema, type Db } from '@buddha/db';
import {
  ALL_MARKET_STATUSES,
  CURSOR_NULL,
  PRE_CLOSE_MARKET_STATUSES,
  RECOMMENDED_VOLUME_HOURS,
  decodeKeyset,
  decodeTupleCursor,
  encodeKeyset,
  encodeTupleCursor,
  isPreCloseMarketStatus,
  type MarketListStatus,
  type MarketSort,
} from '@buddha/shared';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { keysetPredicate, tupleKeysetPredicate } from '../common/keyset.js';

type MarketRow = typeof schema.markets.$inferSelect;

/** What builds the lateral: the pool or a transaction, whichever runs the list. */
type SelectSource = Pick<Db, 'select'>;

/**
 * The market orders (ADR-0061 decision 1, items 9–11; ADR-0065) in ONE place: `GET /markets`,
 * the 관심 시장 list's public orders (`GET /me/watchlist`) and the related markets of a detail
 * (#65: '홈의 추천 규칙', decision 1, item 19) all order by these, so a market sits in the same
 * place relative to another on every screen that lists both.
 *
 * - 추천 (`recommended`): the volume of the fills of the last 24 hours (`recentVolume`), largest
 *   first; ties by the actual open time, latest first; then the id. Every fill counts until #132
 *   excludes abnormal ones, and the volume is `fills.amount_coin` until #177/#121 define it.
 * - 신규 (`newest`): the actual open time, latest first, then the id.
 * - 마감 임박 (`closing`): the close time, soonest first, then the id; no window. On a list that
 *   can hold a closed market — anything but one status that has not closed yet: the search's 모든
 *   상태 and its ended statuses, MY's 관심 시장 — the markets not closed yet
 *   (`PRE_CLOSE_MARKET_STATUSES`: 개장 예정·거래 중·거래 일시 중단) come first, soonest first,
 *   and every other one after them, the most recently closed first (ADR-0066, owner decision
 *   2026-10-16: "진행 중 먼저, 끝난 것은 최근 순", generalised from `open` by #174). Ended is the
 *   STATUS, not the clock: a market an admin closed early keeps its future `close_at` and is ended,
 *   and an `open` or `paused` market whose close time has passed (before the close job reaches it,
 *   A-M3-31) is still not closed, first of all. A list of one such status only (the home and its
 *   관심 시장 view, `open`; the search's 개장 예정 or 거래 일시 중단) is ordered exactly as
 *   before, on the plain `(close_at, id)` that `markets_status_close_at_idx` serves; the two
 *   orders agree on every pair of markets not closed yet.
 *
 * The open time is `open_at DESC NULLS LAST`, written as `coalesce(open_at, '-infinity')`
 * (`openedAt`): on that key a market with no open time sorts after every one that has one, and
 * the cursor can still page across it — a row comparison with a NULL in it is NULL, which would
 * end the list at the first such market. So it is last in 신규, and in 추천, where the key only
 * breaks ties, last among the markets of its own 24-hour volume; 마감 임박 does not read it.
 * A market that has not opened has none: a SCHEDULED one is public (ADR-0093 decision 1 item 12),
 * so it is last in 신규 and among its volume's markets in 추천 until it opens. DRAFT and REVIEW
 * have none either, and no public list holds them.
 */

/**
 * The actual open time as an order key: `open_at DESC NULLS LAST` as a value. Spelled exactly as
 * `markets_status_open_at_id_idx` holds it (packages/db schema/markets.ts), which is what lets
 * 신규's keyset predicate and ORDER BY use that index.
 */
export const openedAt: SQL = sql`coalesce(${schema.markets.openAt}, '-infinity'::timestamptz)`;

/** The ISO form of a decoded open-time part, `-infinity` for `CURSOR_NULL`. */
function openedAtValue(part: string): string {
  return part === CURSOR_NULL ? '-infinity' : new Date(Number(part)).toISOString();
}

/** A row's open time as a cursor part. */
function openedAtPart(row: MarketRow): string {
  return row.openAt === null ? CURSOR_NULL : row.openAt.getTime().toString();
}

/**
 * Whether a row has not been closed yet (`PRE_CLOSE_MARKET_STATUSES`, #174). DRAFT and REVIEW
 * are in the set but on no public list, so on these lists it is SCHEDULED, OPEN and PAUSED.
 */
const notClosed: SQL = inArray(schema.markets.status, [...PRE_CLOSE_MARKET_STATUSES]);

/**
 * 마감 임박's group on a list that can hold ended markets: 0 for a market not closed yet
 * (`notClosed`), 1 for every other — ended by its status (ADR-0066, owner decision 2026-10-16;
 * #174). The cursor's group (`closingGroupPart`) says the same of the row.
 */
const closingGroup: SQL = sql`(CASE WHEN ${notClosed} THEN 0 ELSE 1 END)`;

/** The close time as epoch milliseconds, exact for a `timestamp(3)` column. */
const closeAtMs: SQL = sql`(extract(epoch FROM ${schema.markets.closeAt}) * 1000)::bigint`;

/**
 * 마감 임박's time key in the same list, signed by the group: the close time for a market not
 * closed yet and its negation for an ended one, so ONE ascending key is soonest first in the first
 * group and the most recently closed first in the second — which is what lets a single row
 * comparison (`tupleKeysetPredicate`, every key the one direction) page across the boundary
 * between them.
 */
const closingTime: SQL = sql`(CASE WHEN ${notClosed} THEN ${closeAtMs} ELSE -(${closeAtMs}) END)`;

/** A row's group as a cursor part. */
function closingGroupPart(row: MarketRow): '0' | '1' {
  return isPreCloseMarketStatus(row.status) ? '0' : '1';
}

/** The time key's value for a decoded cursor: the close time, negated in the ended group. */
function closingTimeValue(group: string, closeMs: string): string {
  return group === '0' ? closeMs : `-${closeMs}`;
}

/** The alias of the lateral below and of its one column. */
const RECENT_VOLUME = 'recent_volume';
const RECENT_VOLUME_COIN = 'coin';

/**
 * The lateral's column as the outer query reads it, QUALIFIED: `"recent_volume"."coin"`. A bare
 * `"coin"` (what drizzle renders for a subquery's aliased field inside `sql`) is resolved by
 * Postgres against the OUTPUT columns first in an ORDER BY, and the select list's
 * `"coin"::text` is named `coin` too — the page would then be ordered as text ('9000' after
 * '12000') while the cursor predicate compared bigints, and the pages skipped markets.
 */
export const recentVolumeCoin: SQL = sql`${sql.identifier(RECENT_VOLUME)}.${sql.identifier(RECENT_VOLUME_COIN)}`;

/**
 * The volume of each market's fills in the `RECOMMENDED_VOLUME_HOURS` hours that end at `asOf`,
 * `(asOf − 24h, asOf]`, as a LATERAL subquery the caller joins after `markets`
 * (`crossJoinLateral`) and reads as `recentVolumeCoin`: one row per market, a bigint, 0 for a
 * market with no fill in the window (an aggregate with no GROUP BY always answers one row). It
 * reads `fills_market_id_created_at_idx` as one range per market, so a list costs the fills of its
 * candidate markets' last day and nothing older.
 *
 * `asOf` is a timestamptz expression: the database clock truncated to the millisecond for a first
 * page, the instant a cursor carries for the pages after it (`marketOrder`). The upper bound is
 * what makes the second form hold still: a fill made after the first page was read is not
 * counted on the pages that follow it.
 */
export function recentVolume(db: SelectSource, asOf: SQL) {
  const { fills, markets } = schema;
  return db
    .select({
      coin: sql<string>`coalesce(sum(${fills.amountCoin}), 0)::bigint`.as(RECENT_VOLUME_COIN),
    })
    .from(fills)
    .where(
      and(
        eq(fills.marketId, markets.id),
        sql`${fills.createdAt} > ${asOf} - make_interval(hours => ${RECOMMENDED_VOLUME_HOURS})`,
        sql`${fills.createdAt} <= ${asOf}`,
      ),
    )
    .as(RECENT_VOLUME);
}
export type RecentVolume = ReturnType<typeof recentVolume>;

/**
 * What an order selects beside the row, as `order`, for its cursor: NULL for an order that needs
 * nothing. A type alias, not an interface: drizzle's selection takes an object with an implicit
 * index signature, which an interface does not have.
 */
export type MarketOrderFields = {
  /** 추천: the row's 24-hour volume, a decimal string. */
  recentVolume: SQL<string | null>;
  /** 추천: the window end the page was counted at, epoch milliseconds as text. */
  asOfMs: SQL<string | null>;
};

/** A row as an ordered list query selects it: the market, and what `MarketOrderFields` read. */
export interface MarketOrderRow {
  market: MarketRow;
  order: { recentVolume: string | null; asOfMs: string | null };
}

/**
 * One order, ready to be put on a query: the lateral to join (추천 only), what to select as
 * `order`, the predicate of the page after `cursor`, the ORDER BY, and the cursor of a page's last
 * row. A cursor that does not decode for this order — absent, malformed, another order's shape —
 * leaves `after` undefined: the first page, as on every list (`decodeKeyset`).
 */
export interface MarketOrder<Row extends MarketOrderRow = MarketOrderRow> {
  lateral: RecentVolume | undefined;
  fields: MarketOrderFields;
  after: SQL | undefined;
  orderBy: SQL[];
  cursorOf(row: Row): string;
}

/** Selected by an order that reads nothing beside the row. */
export const NO_ORDER_FIELDS: MarketOrderFields = {
  recentVolume: sql<null>`NULL`,
  asOfMs: sql<null>`NULL`,
};

/**
 * The order for `sort`, paging after `cursor`.
 *
 * 추천's cursor is `<asOf>_<volume>_<openAt>_<id>` (`encodeTupleCursor`). The 24-hour volume moves
 * with the clock — a fill ages out of the window, a new one comes in — so a list paged minutes
 * apart over a moving window could repeat a market on page two that page one already showed, or
 * skip one. The first page therefore fixes the window: its end is the database clock at that
 * read, truncated to the millisecond, and every page after it counts the same `(asOf − 24h,
 * asOf]` from the cursor. On a dataset that does not change, the pages are then exactly the order
 * of that instant. What can still move a market between pages is a fill made inside that window
 * that had not committed when the first page was read — a trade in flight at that instant. A
 * fresh first page (a reload, TanStack's refetch, which re-reads page one and follows its new
 * cursors) counts a fresh window.
 *
 * 신규's cursor is `<openAt>_<id>` with `CURSOR_NULL` for no open time. 마감 임박's is the
 * `<millis>_<uuid>` keyset every list uses on a list of one status not closed yet, and
 * `<group>_<closeAt>_<id>` on one that can hold ended markets (`group` 0 or 1, the close time
 * unsigned: the predicate negates it for the ended group). Each is a part short or too many for
 * the other, so a cursor carried from the home to the search serves the first page.
 *
 * `status` is the status the list is filtered on — one public status, `all`, or `undefined` for
 * every public status (`GET /me/watchlist` without one). Only 마감 임박 reads it, and only to
 * know whether an ended market can be on the list: one status not closed yet (SCHEDULED, OPEN,
 * PAUSED) cannot hold one. Required, like `decodeKeyset`'s `idShape`, so every caller says what
 * its filter is.
 */
export function marketOrder(
  db: SelectSource,
  sort: MarketSort,
  cursor: string | undefined,
  status: MarketListStatus | undefined,
): MarketOrder {
  const { markets } = schema;
  switch (sort) {
    case 'recommended': {
      const keyset = decodeTupleCursor(cursor, ['millis', 'int', 'nullableMillis'], 'uuid');
      const asOf = keyset
        ? sql`${new Date(Number(keyset.values[0])).toISOString()}::timestamptz`
        : sql`date_trunc('milliseconds', now())`;
      const lateral = recentVolume(db, asOf);
      return {
        lateral,
        fields: {
          recentVolume: sql<string>`${recentVolumeCoin}::text`,
          asOfMs: sql<string>`(extract(epoch FROM ${asOf}) * 1000)::bigint::text`,
        },
        after: keyset
          ? tupleKeysetPredicate([
              { key: recentVolumeCoin, value: keyset.values[1]!, cast: 'bigint' },
              { key: openedAt, value: openedAtValue(keyset.values[2]!), cast: 'timestamptz' },
              { key: markets.id, value: keyset.id, cast: 'uuid' },
            ])
          : undefined,
        orderBy: [desc(recentVolumeCoin), desc(openedAt), desc(markets.id)],
        cursorOf: ({ market, order }) =>
          encodeTupleCursor(
            [order.asOfMs ?? '0', order.recentVolume ?? '0', openedAtPart(market)],
            market.id,
          ),
      };
    }
    case 'newest': {
      const keyset = decodeTupleCursor(cursor, ['nullableMillis'], 'uuid');
      return {
        lateral: undefined,
        fields: NO_ORDER_FIELDS,
        after: keyset
          ? tupleKeysetPredicate([
              { key: openedAt, value: openedAtValue(keyset.values[0]!), cast: 'timestamptz' },
              { key: markets.id, value: keyset.id, cast: 'uuid' },
            ])
          : undefined,
        orderBy: [desc(openedAt), desc(markets.id)],
        cursorOf: ({ market }) => encodeTupleCursor([openedAtPart(market)], market.id),
      };
    }
    case 'closing':
      return status !== undefined &&
        status !== ALL_MARKET_STATUSES &&
        isPreCloseMarketStatus(status)
        ? closingOrder(cursor)
        : closingEndedLastOrder(cursor);
  }
}

/**
 * 마감 임박 over the markets of one status not closed yet: soonest first, the `<millis>_<uuid>`
 * keyset with `close_at` as the timestamp half and the comparison flipped — `after` rather than
 * `before`, because this is an ascending page. Unchanged by ADR-0066: the home and its 관심 시장
 * view list open markets only; the search's 개장 예정 and 거래 일시 중단 take it too (#174).
 */
function closingOrder(cursor: string | undefined): MarketOrder {
  const { markets } = schema;
  const keyset = decodeKeyset(cursor, 'uuid');
  return {
    lateral: undefined,
    fields: NO_ORDER_FIELDS,
    after: keyset
      ? keysetPredicate(markets.closeAt, markets.id, keyset, 'uuid', 'after')
      : undefined,
    orderBy: [asc(markets.closeAt), asc(markets.id)],
    cursorOf: ({ market }) => encodeKeyset({ createdAt: market.closeAt, id: market.id }),
  };
}

/**
 * 마감 임박 over a list that can hold ended markets (ADR-0066, owner decision 2026-10-16): the
 * group not closed yet first, soonest first, then the ended one, the most recently closed first;
 * the id breaks a tie in either. One ascending row comparison over (group, signed close time, id)
 * pages the whole of it, across the boundary too: a cursor in the first group is followed by the
 * rest of that group and then every ended market, a cursor in the second by the rest of the
 * second. No index holds these expressions — the search reads every candidate anyway (ADR-0066
 * decision 6, '제목 검색의 색인') — so the predicate is a filter and the page a sort.
 */
function closingEndedLastOrder(cursor: string | undefined): MarketOrder {
  const { markets } = schema;
  const keyset = decodeTupleCursor(cursor, ['group', 'millis'], 'uuid');
  return {
    lateral: undefined,
    fields: NO_ORDER_FIELDS,
    after: keyset
      ? tupleKeysetPredicate(
          [
            { key: closingGroup, value: keyset.values[0]!, cast: 'bigint' },
            {
              key: closingTime,
              value: closingTimeValue(keyset.values[0]!, keyset.values[1]!),
              cast: 'bigint',
            },
            { key: markets.id, value: keyset.id, cast: 'uuid' },
          ],
          'after',
        )
      : undefined,
    orderBy: [asc(closingGroup), asc(closingTime), asc(markets.id)],
    cursorOf: ({ market }) =>
      encodeTupleCursor([closingGroupPart(market), market.closeAt.getTime().toString()], market.id),
  };
}
