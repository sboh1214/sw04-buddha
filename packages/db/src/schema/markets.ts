import { desc, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { categories } from './categories.js';
import { createdAt, timestampTz, updatedAt } from './columns.js';
import { marketResultEnum, marketStatusEnum, marketVisibilityEnum } from './enums.js';

/**
 * `column`'s whole minute in UTC: the unit the market times' order CHECKs compare (#22, ADR-0098),
 * as `minuteOf` of @buddha/shared counts it. `AT TIME ZONE 'UTC'` first, because a bare
 * `date_trunc` on a timestamptz truncates in the session's TimeZone.
 */
const utcMinute = (column: AnyPgColumn) => sql`date_trunc('minute', ${column} AT TIME ZONE 'UTC')`;

/**
 * Binary markets (PLAN 5.2, 6.2). A market holds no pricing-engine state: the direct AMM's
 * columns and `mechanism` were dropped with it (#125, migration 0017), and the CLOB's own shape
 * is #119's. `visibility`/`group_id` are group-readiness columns without a FK (PLAN 6.3).
 */
export const markets = pgTable(
  'markets',
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: varchar({ length: 80 }).notNull().unique(),
    title: varchar({ length: 120 }).notNull(),
    /**
     * The rule items (#23, ADR-0097; ADR-0093 decision 2 #172 items 7–10), RULE_ITEMS of
     * @buddha/shared, each required to open (the open-items check) and blank on a draft until
     * written. Migration 0050 dropped the single `rules` text and `resolution_source` they replace,
     * text and all (D4: no conversion). The texts hold at most MARKET_TEXT_MAX characters, the
     * API's limit; no CHECK holds it, as none held `rules`'. The sources are `market_sources`.
     *
     * 배경. Kept from before the items, under its name, and nullable for older rows: null and blank
     * are both not filled in.
     */
    description: text(),
    /** YES 조건. */
    yesCondition: text().notNull().default(''),
    /** NO 조건: what makes it NO, and that no event by `event_deadline` is NO. */
    noCondition: text().notNull().default(''),
    /**
     * 사건 기한 (#172 item 8): the instant the event must happen by. A result published after it
     * is a judgement delay, never a NO by itself (#173 item 11). At or before the scheduled
     * judgement, in whole minutes (owner answer 2026-10-31 A1, ADR-0098:
     * `markets_deadline_by_judgement_check` below). No order against the close time (ADR-0097
     * result 4 (a)).
     */
    eventDeadline: timestampTz(),
    /** 전환 조건: when the judgement moves to a 대체 출처. Blank while the market has none. */
    fallbackCondition: text().notNull().default(''),
    /**
     * 장기 지연 기한 in whole days, 1..365 (MARKET_LONG_DELAY_DAYS_MIN/MAX): N × 24 hours after
     * `scheduled_judgement_at` (#172 item 10), the instant `longDelayDeadline` of @buddha/shared
     * computes (#22).
     */
    longDelayDays: smallint(),
    /**
     * 지연·취소·무효 처리: what happens at the long-delay deadline, the VOID switch criteria and an
     * event cancelled or postponed (N03 §4). VOID's 50/50 payout is one rule for every market
     * (#173 item 9), stored nowhere per market.
     */
    delayHandling: text().notNull().default(''),
    categoryId: integer()
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    imageUrl: text(),
    status: marketStatusEnum().notNull().default('draft'),
    visibility: marketVisibilityEnum().notNull().default('public'),
    groupId: uuid(),
    // statistics
    /**
     * YES price 1..99 of the last fill (PLAN 5.3). NULL until the first fill — '체결 없음'
     * (N02 §5) — and the CHECK below passes a NULL, as every SQL CHECK does.
     */
    lastPrice: smallint(),
    volumeCoin: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    tradeCount: integer().notNull().default(0),
    traderCount: integer().notNull().default(0),
    // fees (schema only, PLAN 5.7)
    takerFeeBps: smallint().notNull().default(0),
    settlementFeeBps: smallint().notNull().default(0),
    // schedule / resolution
    /**
     * The ACTUAL open: the instant of the SCHEDULED → OPEN transition (`openScheduledMarket`, #21,
     * ADR-0100) — the worker's at the scheduled open, or the approval's or the reschedule's that
     * found that time already come. The 신규 order and its index below read it (ADR-0065). The
     * planned one is `scheduled_open_at`.
     */
    openAt: timestampTz(),
    /**
     * The market times (#22, ADR-0098; ADR-0093 decision 2 #172 items 11–14), TIME_ITEMS of
     * @buddha/shared. Each is null until written — a draft may stay partial, and every market from
     * before #22 has them null, as migration 0051 left it (D4, no conversion) — and the open-items
     * check names the required ones. Stored as entered, to the millisecond (columns.ts); every
     * order between them compares whole UTC minutes (#172 item 12), in the API and in the CHECKs
     * below, which the API's refusals precede.
     *
     * 예정 개장 시각: the market opens at it and no earlier (ADR-0093 decision 1 #173 item 1,
     * decision 3 '#21 앞당긴 개장'; #21, ADR-0100): a SCHEDULED market's delayed `market.open` job
     * fires at it and the per-minute open scan reads it, and an approval or a reschedule that finds
     * it already come opens the market at once. Before the close
     * (`markets_open_before_close_check`). The one item a SCHEDULED market changes without a new
     * review, with a reason (#78, ADR-0099; #172 item 6): nothing else of a market in REVIEW or
     * SCHEDULED is edited.
     */
    scheduledOpenAt: timestampTz(),
    /**
     * 거래 마감 시각: the worker closes the market at it. At or before the scheduled judgement
     * (`markets_close_by_judgement_check`); after the open it only moves later (#172 item 14, the
     * API's alone: it depends on the value before).
     */
    closeAt: timestampTz().notNull(),
    /**
     * 발표 예정 시각 (#172 item 13); null is '없음'. The close leads it by the release setting
     * `market.lead_close_gap` (선행 마감), which only the API and the open-items check hold.
     */
    scheduledAnnouncementAt: timestampTz(),
    /**
     * 예정 판정 시각: never edited once the market is open (#172 item 14). A CLOSED market past it
     * reads '판정 지연' (#173 item 11), and the long delay counts from it.
     */
    scheduledJudgementAt: timestampTz(),
    /**
     * 판정 기준 시간대 (#172 item 11): one IANA name, stored as given and checked on entry only
     * (`timeZoneSchema`), like `profiles.time_zone` — no CHECK can read `pg_timezone_names`. No
     * default: the admin form pre-fills Asia/Seoul for the operator to confirm, so a null is a
     * zone nobody confirmed.
     */
    judgementTimeZone: varchar({ length: 64 }),
    /**
     * The 선행 마감 gap in minutes this market's lead close was last checked against: the release
     * setting's reading its submission stored, or that an open market's first lead re-check (a
     * close or announcement edit) stored; later re-checks use it (docs/SETTINGS.md: a long-lived
     * piece of work keeps the value it started with). Null until one of those stores a reading —
     * before the submission, or after one with the setting undecided and no edit since (#22,
     * ADR-0098). A market opened before #21 holds what the interim open stored.
     *
     * The review (#78, ADR-0099; ADR-0098 결정 7-6 left it to #78): the submission stores the gap
     * it checked (null with the setting undecided and no announcement needing one), the approval
     * checks again with it (a SCHEDULED market's open-time change asks only the open before the
     * close, which no gap touches), and a 반려 or a 되돌리기 clears it, so a draft is checked
     * against the setting in force at its next submission. The open neither checks it again nor
     * writes it (#21, ADR-0100; ADR-0098 7-6). No CHECK ties it to a status.
     */
    leadCloseGapMinutes: integer(),
    /**
     * The judgement's result type (YES·NO·VOID, #174): null before a judgement publishes one and
     * on a CANCELLED market (ADR-0093 decision 1 item 10). Not the contract side `outcome`.
     */
    resolvedResult: marketResultEnum(),
    /** When the result was confirmed (→ `resolved`). */
    resolvedAt: timestampTz(),
    /** When the settlement steps all finished (→ `settled`). */
    settledAt: timestampTz(),
    /**
     * `market_events.id` of the transition that produced `status` (M5, A-M3-19): the ordering
     * key of `market:status` and of the market DTOs. Written by every transition in the same
     * transaction as its event row, under the market's advisory lock, so it is the market's
     * commit order. No FK — market_events is append-only and the id is never reused. Null
     * only for a row written outside the transition paths (a test factory; migration 0011
     * backfills every existing market from its newest transition event).
     */
    statusEventId: bigint({ mode: 'number' }),
    /**
     * The creator: the admin who made the draft, or adopted the proposal it came from (ADR-0089).
     * Never approves or rejects its review (#78, ADR-0093 decision 2 #172 item 5).
     */
    createdBy: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('markets_status_close_at_idx').on(t.status, t.closeAt),
    index('markets_category_id_status_idx').on(t.categoryId, t.status),
    /**
     * `GET /markets?sort=newest` (신규, ADR-0065): the actual open time, latest first, under a
     * status filter — `(coalesce(open_at, '-infinity') DESC, id DESC)`, which is `open_at DESC
     * NULLS LAST` written as a value a row-comparison cursor can page across (market-order.ts).
     * The expression is the index key, spelled exactly as the query spells it, so the keyset
     * predicate is an Index Cond like every other list's (A-M3-10, ADR-0039). Status-leading
     * because the home always filters on `open` (ADR-0061 decision 1, item 13).
     *
     * The volume order's `(status, volume_coin DESC, id DESC)` went with that order (ADR-0065,
     * migration 0024): nothing reads it until #132 brings the order back, and while it stood
     * every fill's `volume_coin` update had to write it (no HOT update on an indexed column).
     * 추천 orders by a 24-hour SUM no index can hold; its lateral reads
     * `fills_market_id_created_at_idx`.
     */
    index('markets_status_open_at_id_idx').on(
      t.status,
      sql`coalesce(${t.openAt}, '-infinity'::timestamptz) DESC`,
      desc(t.id),
    ),
    /**
     * `GET /admin/markets`, whose `status` filter is OPTIONAL, ordered `(created_at DESC,
     * id DESC)`.
     *
     * Its own index rather than a `(status, created_at DESC, id DESC)` one, and the plan is the
     * reason: a leading column that is not constrained cannot yield an index-ordered scan, so
     * with only the status-leading index the unfiltered admin list falls back to
     * `Seq Scan + top-N Sort` — measured at 1626 ms on 2M rows against 0.10 ms here. It served
     * the public `newest` too while that order was `created_at` (ADR-0039 decision 3); since
     * ADR-0065 `newest` is the open time and has its own index above.
     */
    index('markets_created_at_id_idx').on(desc(t.createdAt), desc(t.id)),
    check('markets_last_price_check', sql`${t.lastPrice} >= 1 AND ${t.lastPrice} <= 99`),
    check('markets_volume_coin_check', sql`${t.volumeCoin} >= 0`),
    check('markets_trade_count_check', sql`${t.tradeCount} >= 0`),
    check('markets_trader_count_check', sql`${t.traderCount} >= 0`),
    check('markets_long_delay_days_check', sql`${t.longDelayDays} BETWEEN 1 AND 365`),
    /**
     * The order of the market times (#22, ADR-0098): scheduled open < close ≤ scheduled judgement
     * (#172 item 12) and 사건 기한 ≤ scheduled judgement (owner answer 2026-10-31 A1). Each holds
     * only once both of its columns are set — a NULL passes, as in every SQL CHECK — so a draft may
     * stay partial. Whole minutes (`utcMinute`), as the owner set. Every writer is held: the API
     * refuses first, so a violation here is a bug, and the seed and the factories are held too. The
     * lead close is not: it depends on a release setting.
     */
    check(
      'markets_open_before_close_check',
      sql`${utcMinute(t.scheduledOpenAt)} < ${utcMinute(t.closeAt)}`,
    ),
    check(
      'markets_close_by_judgement_check',
      sql`${utcMinute(t.closeAt)} <= ${utcMinute(t.scheduledJudgementAt)}`,
    ),
    check(
      'markets_deadline_by_judgement_check',
      sql`${utcMinute(t.eventDeadline)} <= ${utcMinute(t.scheduledJudgementAt)}`,
    ),
    check('markets_lead_close_gap_minutes_check', sql`${t.leadCloseGapMinutes} >= 0`),
    check(
      'markets_fee_bps_check',
      sql`${t.takerFeeBps} BETWEEN 0 AND 10000 AND ${t.settlementFeeBps} BETWEEN 0 AND 10000`,
    ),
  ],
);
