import { desc, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
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
    // statistics (#121, ADR-0116; ADR-0107 결정 1 #177 11–14항, 결정 4 #121 rows). Written only by
    // @buddha/db market-stats.ts, which the intake (`placeOrder`) calls once per intake that
    // filled, in its transaction under the market's lock (market-stats-writes.test.ts). Each can
    // be recounted from `fills`, which never change (`MARKET_STATS_CHECK_SQL`).
    /**
     * 시장가격: the YES value 1..99 (`fills.yes_price_coin`) of the last fill by (`created_at`,
     * `id`) (#177 11항, ADR-0107 결정 4 '대표 시장가격'). NULL until the first fill — '체결 없음'
     * (N02 §5); the open's 50% is never written here. The CHECK below passes a NULL, as every
     * SQL CHECK does.
     */
    lastPrice: smallint(),
    /**
     * The last fill's server time, the 시장가격's 갱신시각 (ADR-0107 결정 4 #121 '대표 시장가격'):
     * its `fills.created_at`, the intake's instant. NULL exactly when `last_price` is (the CHECK
     * below). Not indexed, so the statistics' UPDATE stays a HOT update (ADR-0065).
     */
    lastFillAt: timestampTz(),
    /**
     * 누적 거래량 since the open (#177 12항): Σ `fills.amount_coin` — each match once, at the
     * incoming contract's price × qty, a pair mint once.
     */
    volumeCoin: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** The count of the market's fills (a pair mint is one): the `market:tick` ordering key. */
    tradeCount: integer().notNull().default(0),
    /**
     * 사용자 참여자 (#177 13항): the distinct person accounts (the account-type rule, #115) with a
     * fill in the market on either side — the `hasMarketFill` basis (#173 6항). Never decreases:
     * a full sell or a closure keeps the fills.
     */
    traderCount: integer().notNull().default(0),
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
     * 거래 마감 시각: the worker closes the market at it, an OPEN or a PAUSED one (#114: on
     * schedule, never later, ADR-0093 decision 1 #173 items 1·3). At or before the scheduled
     * judgement (`markets_close_by_judgement_check`); after the open it only moves later, by a
     * supplement (#172 item 14, #80: the API's rule, since it depends on the value before; the
     * database holds only that a versioned market's changes with a supplement, `rule_version`
     * below), and not while PAUSED. An earlier end is a pause and an approved 조기 마감 (#114,
     * ADR-0102), which leaves it as it was: the actual close is the `closed` event's `closedAt`.
     */
    closeAt: timestampTz().notNull(),
    /**
     * 발표 예정 시각 (#172 item 13); null is '없음'. The close leads it by the release setting
     * `market.lead_close_gap` (선행 마감), which only the API and the open-items check hold.
     */
    scheduledAnnouncementAt: timestampTz(),
    /**
     * 예정 판정 시각: never edited once the market is open (#172 item 14: no supplement moves it).
     * A CLOSED market past it reads '판정 지연' (#173 item 11), and the long delay counts from it.
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
     * close or announcement supplement's approval since #80, an edit before) stored; later
     * re-checks use it, and no rule version holds it (docs/SETTINGS.md: a long-lived piece of work
     * keeps the value it started with). Null until one of those stores a reading — before the
     * submission, or after one with the setting undecided and no edit since (#22, ADR-0098). A
     * market opened before #21 holds what the interim open stored.
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
     * 가격 보호 폭 in ticks (#119, ADR-0112; ADR-0107 결정 1 #177 2항, ADR-0093 #172 6항): how far
     * from the best opposite quote an immediate order's limit may reach (`protectedLimit`). Copied
     * from the release setting `order.price_protection_ticks` when the market is created (null
     * while it is undecided), filled by the review submission when still null — the open-items
     * check refuses the submission while both are null (`priceProtection`) — and fixed from then on
     * (`markets_price_protection_fixed`, migration 0062), but for the after-open change of an OPEN
     * or PAUSED market with a reason (`price_protection_changed`). A 반려 or a 되돌리기 keeps it: it
     * is a market term, not a reading. A non-draft market with none — one submitted before #119 —
     * takes GTC orders and refuses IOC ones (ORDER_INTAKE_CLOSED) until the after-open change
     * gives it one. 1..98, or null.
     */
    priceProtectionTicks: smallint(),
    /**
     * The current rule version (#80, ADR-0101; ADR-0093 decision 2 #172 items 6·7): the market's
     * newest `market_rule_versions.version` — 1 from the open, which records v1 in its own
     * transaction (`openScheduledMarket`), then one more per approved supplement. Null before the
     * open and for a market opened before #80 (D4, no backfill), which takes no supplement. No
     * foreign key (the version row references the market): the open and the supplement approval
     * write both in one transaction each. The judgement follows it (#172 item 7).
     *
     * While it is set, the version items — the title, the rule items and the times, the columns
     * RULE_VERSION_ITEMS of @buddha/shared names — the market's `market_sources` and this column
     * change only in a transaction that names the market in `buddha.rule_supplement`
     * (`allowRuleSupplement`), which the supplement approval alone does (migration 0053's
     * triggers: '보충 외 경로로 규칙 버전에 든 항목을 고치는 일을 막는다'). A write of the same value is
     * no change.
     */
    ruleVersion: integer(),
    /**
     * The judgement's result type (YES·NO·VOID, #174): the current judgement's, written by the
     * approval that publishes it (CLOSED → PROVISIONAL, #152 — ADR-0095 8-2: a provisional result
     * is a judged result too, and 8-7 hides a provisional VOID from related markets by it) and by
     * a correction's approval in PROVISIONAL (#176), and kept through RESOLVED and the settlement.
     * Null before a judgement publishes one and on a CANCELLED market (ADR-0093 decision 1 item
     * 10). Not the contract side `outcome`.
     */
    resolvedResult: marketResultEnum(),
    /**
     * The current judgement (#152, ADR-0103): its `market_judgements.version` — 1 from the
     * approval that published the first one, then one more per approved correction (#176,
     * `correctMarketJudgement`, which moves it, the result and the deadline together). Null until a
     * judgement is approved, and for a market judged by ADR-0046's interim route before #152 (D4,
     * no backfill: no judgement row). No foreign key (the judgement row references the market):
     * the approval writes both in one transaction. The settlement of a RESOLVED market is that
     * version's (the `resolved` event names it too; #126 keys its payouts by it).
     */
    judgementVersion: integer(),
    /**
     * 이의 기한 of the current judgement (#152, ADR-0103; ADR-0093 decision 1 #173 item 5): its
     * `market_judgements.dispute_deadline`, mirrored here for the worker's scan (`market.resolve`,
     * the index below) and kept after the confirmation — a correction's approval moves it to its
     * new deadline (#176). Null until a judgement is approved. Not named `dispute_until`: that M5
     * column was dropped with its dispute flow (migration 0016).
     */
    disputeDeadline: timestampTz(),
    /**
     * 판정 이의 holding the confirmation (#175, ADR-0104; ADR-0093 decision 1 #173 items 11·12):
     * how many of the current judgement version's `market_disputes` are `pending` or `accepted`
     * (HOLDING_DISPUTE_STATUSES of @buddha/shared), mirrored here so every market read labels the
     * market '이의 검토 중' or '판정 지연' from the row alone, with no join. Written under the market
     * lock by the @buddha/db dispute writers only — one more for a submission, one fewer for a
     * retraction or a dismissal, none for an acceptance (it still holds) or for an accepted one a
     * rejected or retracted correction sent back to pending (both statuses hold) — set to 0 by a
     * correction's approval, whose new version has no dispute yet (#176), and 0 on every market
     * but a PROVISIONAL one (the CHECK). For the labels alone: the confirmation and the worker's
     * scan read the disputes themselves (`confirmationHold`), so a mirror that drifted could only
     * mislabel a market, never confirm a held one.
     */
    disputeHoldCount: integer().notNull().default(0),
    /**
     * 판정 정정 waiting (#176, ADR-0105; ADR-0093 decision 3 '#176 정정 대기'): whether a correction
     * of the current version is registered and not yet decided, mirrored here so a market read
     * labels it '판정 지연' past its deadline from the row alone (`isJudgementDelayed`). Written
     * under the market lock — true by a correction's registration, false by its approval
     * (`correctMarketJudgement`), its 반려 and its 철회 (`setCorrectionPending`) — and false on
     * every market but a PROVISIONAL one (the CHECK). For the labels alone, as the dispute count:
     * the hold itself is the waiting `market_judgement` request (`confirmationHold`).
     */
    correctionPending: boolean().notNull().default(false),
    /**
     * When the result was confirmed (→ `resolved`): since #152 the worker's confirmation once the
     * dispute deadline passed with no 판정 이의 holding it — after the last dismissal, for a held
     * market (#175) — (`resolveProvisionalMarket`), never the provisional publication — theme
     * results read it as 확정 시각 (ADR-0095 결과 5). Before #152, the interim judgement's.
     */
    resolvedAt: timestampTz(),
    /** When the settlement steps all finished (→ `settled`). */
    settledAt: timestampTz(),
    /**
     * `market_events.id` of the transition that produced `status` (M5, A-M3-19) — or, since #176,
     * of the `judgement_corrected` event that replaced its PROVISIONAL result with no status change
     * (`correctMarketJudgement`, ADR-0105), so the correction republishes under a newer key: the
     * ordering key of `market:status` and of the market DTOs. Written by every transition, and the
     * correction, in the same transaction as its event row, under the market's advisory lock, so
     * it is the market's commit order. No FK — market_events is append-only and the id is never
     * reused. Null only for a row written outside the transition paths (a test factory; migration
     * 0011 backfills every existing market from its newest transition event).
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
     * `fills_market_id_created_at_id_idx`.
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
    /**
     * The worker's confirmation scan (`market.resolve`, #152; `dueProvisionalMarkets`): the
     * PROVISIONAL markets whose dispute deadline has passed, the earliest first — less those a
     * dispute holds (#175), each looked up in `market_disputes_holding_idx`, or a correction waits
     * for (#176), read by an index of `approval_requests`. Partial: a market keeps its deadline
     * after the confirmation, and the PROVISIONAL set is the few awaiting one.
     */
    index('markets_provisional_dispute_deadline_idx')
      .on(t.disputeDeadline, t.id)
      .where(sql`${t.status} = 'provisional'`),
    check('markets_last_price_check', sql`${t.lastPrice} >= 1 AND ${t.lastPrice} <= 99`),
    // The 시장가격 and its 갱신시각 come from one fill and are set together (#121).
    check('markets_last_fill_at_check', sql`(${t.lastPrice} IS NULL) = (${t.lastFillAt} IS NULL)`),
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
    check('markets_price_protection_ticks_check', sql`${t.priceProtectionTicks} BETWEEN 1 AND 98`),
    check('markets_rule_version_check', sql`${t.ruleVersion} >= 1`),
    check('markets_judgement_version_check', sql`${t.judgementVersion} >= 1`),
    /**
     * A PROVISIONAL market has a published judgement (#152): its version, its deadline and its
     * result — the approval writes all three with the status. No CHECK ties them to the other
     * statuses: a market judged by the interim route before #152 has neither version nor deadline.
     */
    check(
      'markets_provisional_check',
      sql`${t.status} <> 'provisional' OR (${t.judgementVersion} IS NOT NULL AND ${t.disputeDeadline} IS NOT NULL AND ${t.resolvedResult} IS NOT NULL)`,
    ),
    /**
     * The dispute mirror (#175): never below 0, and 0 on a market that is not PROVISIONAL — a
     * confirmation of a market a dispute still holds fails here too, after `confirmationHold`.
     */
    check('markets_dispute_hold_count_check', sql`${t.disputeHoldCount} >= 0`),
    check(
      'markets_dispute_hold_status_check',
      sql`${t.disputeHoldCount} = 0 OR ${t.status} = 'provisional'`,
    ),
    /**
     * The correction mirror (#176): true on a PROVISIONAL market alone — a confirmation of a market
     * whose mirror still says a correction waits fails here too, after `confirmationHold`.
     */
    check(
      'markets_correction_pending_status_check',
      sql`NOT ${t.correctionPending} OR ${t.status} = 'provisional'`,
    ),
  ],
);
