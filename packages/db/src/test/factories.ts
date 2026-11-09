/**
 * Test data factories (PLAN 14). They write through the ORM as whatever role `db` is
 * connected with (buddha_app in integration tests), bypassing better-auth and the API so a
 * test can build its fixture state in a few lines. Never used outside tests.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { ledgerHeldMarketIds } from '../ledger-held-markets.js';
import { runMarketReconciliation } from '../reconciliation-audit.js';
import {
  ACCOUNT_CLOSURE_DECISION_REASON,
  AUTH_USER_NAME,
  CONSENT_ITEMS,
  DEFAULT_JUDGEMENT_TIME_ZONE,
  MARKET_CANCEL_APPROVAL_KIND,
  MARKET_JUDGEMENT_APPROVAL_KIND,
  MARKET_PAUSE_DECISION_APPROVAL_KIND,
  MARKET_REVIEW_APPROVAL_KIND,
  MARKET_REVIEW_CHECKLIST,
  MARKET_REVIEW_REQUEST_REASON,
  MARKET_SUPPLEMENT_APPROVAL_KIND,
  ORPHAN_MEDIA_RETRY_SLACK_MINUTES,
  PRICE_MAX,
  PRICE_MIN,
  currentConsentVersion,
  SETTLEMENT_STEPS,
  applySupplementChanges,
  ceilToMinute,
  closedAccountEmail,
  floorToMinute,
  isBeforeScheduledJudgement,
  isFallbackSourcePriority,
  isHoldingDisputeStatus,
  marketReviewExclusion,
  marketSupplementChangesSchema,
  orphanMediaRetryHours,
  normalizeTagName,
  pauseReasonNeedsPublishedAt,
  pauseReasonNeedsReview,
  readPostDocument,
  relatedMarketPair,
  tagKey,
  type ImageContentType,
  type JudgementSource,
  type MarketCancelRequestPayload,
  type MarketJudgementRequestPayload,
  type MarketPauseDecisionRequestPayload,
  type MarketPausePath,
  type MarketPauseReason,
  type MarketPauseReviewResult,
  type MarketDisputeStatus,
  type MarketResult,
  type MarketRulesSupplementedPayload,
  type MarketSource,
  type MarketStatus,
  type MarketSupplementChanges,
  type MarketSupplementRequestPayload,
  type ModerationActionType,
  type ModerationReason,
  type PostDocument,
  type Outcome,
  type ProposalRejectionReason,
  type ProposalStatus,
  type ReleaseSettingStatus,
  type ReportReason,
  type ReportStatus,
  type Role,
  type SettlementStep,
  type SettlementStepStatus,
  type LinkFlagReason,
  type WriteLimitAction,
} from '@buddha/shared';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { ensureMarketMakerAccount } from '../account-types.js';
import type { Db } from '../client.js';
import {
  cancelScheduledMarket,
  marketHasHumanFill,
  type CancelScheduledMarketResult,
} from '../market-cancel.js';
import { confirmationHold, type MarketDisputeRow } from '../market-dispute.js';
import { recordJudgementDelay, type MarketJudgementDelayRow } from '../market-judgement-delay.js';
import {
  approveMarketJudgement,
  correctMarketJudgement,
  resolveProvisionalMarket,
  setCorrectionPending,
  type MarketJudgementRow,
} from '../market-judgement.js';
import { openScheduledMarket } from '../market-open.js';
import {
  currentMarketPause,
  endMarketPause,
  pauseMarket,
  type MarketPauseRow,
} from '../market-pause.js';
import {
  allowRuleSupplement,
  insertRuleVersion,
  readRuleContent,
  type MarketRuleVersionRow,
} from '../market-rules-content.js';
import { transitionMarket } from '../market-transitions.js';
import { lockMarketOrders } from '../order-cancel.js';
import {
  account,
  adminActions,
  approvalRequests,
  balances,
  categories,
  commentLikes,
  consentRecords,
  linkFlags,
  linkUses,
  marketDisputes,
  marketEvents,
  marketLinks,
  marketPauses,
  marketProposals,
  marketRuleVersions,
  marketSearches,
  marketSettlementSteps,
  marketSources,
  marketTags,
  marketWatchEvents,
  marketWatches,
  markets,
  mediaDeletions,
  mediaObjects,
  moderationActions,
  nicknameHolds,
  noticeImages,
  notices,
  phoneVerifications,
  positions,
  postComments,
  postImages,
  postLikes,
  posts,
  profileInterestCategories,
  profileItemRemovals,
  profiles,
  releaseSettings,
  reports,
  session,
  startGrants,
  tags,
  themeMarkets,
  themeNotices,
  themes,
  user,
  verification,
  writeLimitEvents,
} from '../schema/index.js';
import { ledgerKeys, lockLedgerAccounts, recordLedgerEntry } from '../ledger.js';
import { storedReleaseSettingValue } from '../release-settings.js';
import { payStartGrant, recordStartGrant } from '../start-grants.js';
import { clockTimestamp, lockMarket } from '../tx-helpers.js';
import { createFillRecord, priceAndQtyOf, type FillRow } from './orders.js';

/**
 * The 가격 보호 폭 the test environment uses (#119, ADR-0107 결과 3: the release setting
 * `order.price_protection_ticks`'s test value): a non-draft market's default here and what
 * `createMarketInReview`'s submission fills.
 */
export const TEST_PRICE_PROTECTION_TICKS = 5;

/** Short unique tag for generated emails/slugs/nicknames. */
const tag = () => randomUUID().replaceAll('-', '').slice(0, 8);

export interface CreateUserInput {
  id?: string;
  email?: string;
  name?: string;
  nickname?: string;
  role?: Role;
  /**
   * Balance the user should end up with. Every account is created with 0 and no ledger entry by
   * the trigger (migration 0031: no sign-up grant, #70); asking for more pays it as the account's
   * start grant, the one way Coin comes to a new person's account (ADR-0107 결정 2 #73 3·7항): a
   * 본인확인 record (a random number), the grant recorded and paid with this amount — a real
   * START_GRANT. So such an account has its grant already (`createStartGrant` on it throws) and a
   * verified number. Omit to keep 0, as a new account, with neither.
   */
  balanceCoin?: bigint;
}

/**
 * Inserts a `user` row (better-auth table). The AFTER INSERT trigger (migrations 0002, 0060)
 * creates `profiles`, the user ledger account and its `balances` row in the same transaction,
 * exactly as a real sign-up does; the factory then applies the requested nickname/role/balance.
 */
export async function createUser(db: Db, input: CreateUserInput = {}) {
  const id = input.id ?? randomUUID();
  const t = tag();
  const balanceCoin = input.balanceCoin ?? 0n;
  return db.transaction(async (tx) => {
    const [userRow] = await tx
      .insert(user)
      .values({
        id,
        name: input.name ?? `tester ${t}`,
        email: input.email ?? `user-${t}@test.local`,
        emailVerified: true,
      })
      .returning();
    const [profile] = await tx
      .update(profiles)
      .set({ nickname: input.nickname ?? `user_${t}`, role: input.role ?? 'user' })
      .where(eq(profiles.userId, id))
      .returning();
    let [balance] = await tx.select().from(balances).where(eq(balances.userId, id));
    if (!userRow || !profile || !balance) {
      throw new Error('user trigger did not create profiles/balances (migration 0060 missing?)');
    }
    if (balanceCoin < 0n) throw new Error('createUser: a balance is never negative');
    if (balanceCoin > 0n) {
      await tx
        .insert(phoneVerifications)
        .values({ userId: id, phone: randomPhone(), realName: '홍길동' });
      const recorded = await recordStartGrant(tx, id, randomPhoneHash());
      if (recorded.outcome !== 'recorded') throw new Error(`start grant: ${recorded.outcome}`);
      const paid = await payStartGrant(tx, recorded.grantId, () => Promise.resolve(balanceCoin));
      if (paid.outcome !== 'granted') throw new Error(`start grant not paid: ${paid.outcome}`);
      balance = paid.balance;
    }
    return { user: userRow, profile, balance };
  });
}

/**
 * The 운영 마켓메이커 account (#115), made the seed's way (`ensureMarketMakerAccount`): one `user`
 * row of its type and a zero balance — no profile, no sign-in method, no grant, no ledger entry.
 * Its id; the same one however often a test asks (one per database, `user_market_maker_uidx`).
 */
export async function createMarketMakerAccount(db: Db): Promise<string> {
  return (await db.transaction((tx) => ensureMarketMakerAccount(tx))).id;
}

export interface CreateCategoryInput {
  slug?: string;
  nameKo?: string;
  sortOrder?: number;
  isActive?: boolean;
  /** A sub-category names its parent; omitted (or null) makes a top-level one. */
  parentId?: number | null;
}

export async function createCategory(db: Db, input: CreateCategoryInput = {}) {
  const t = tag();
  const [row] = await db
    .insert(categories)
    .values({
      slug: input.slug ?? `cat-${t}`,
      nameKo: input.nameKo ?? `카테고리 ${t}`,
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
      parentId: input.parentId ?? null,
    })
    .returning();
  return row!;
}

export interface CreateMarketInput {
  /** Creator user id. A fresh admin user is created when omitted. */
  createdBy?: string;
  /** Category id. A fresh category is created when omitted. */
  categoryId?: number;
  slug?: string;
  title?: string;
  /**
   * The rule items (#23, ADR-0097), RULE_ITEMS of @buddha/shared. By default every one is filled
   * in — texts naming the market, an event deadline a day after `closeAt`, a 1차 출처 at
   * https://example.com/source, no 대체 출처 ('없음') and a 14-day long delay — so a market made here
   * misses no rule item of the open-items check, and a draft is submitted for review through the
   * route once it has tags. A test of a missing item blanks it: '' for a text (or `null` for 배경),
   * `null` for the deadline, the primary source or the days, or a source with a blank name or
   * address. A switch condition is written by default only when fallbacks are given. Stored as
   * given: untrimmed, and checked by the database alone.
   */
  description?: string | null;
  yesCondition?: string;
  noCondition?: string;
  eventDeadline?: Date | null;
  /** `market_sources` priority 0; null writes no row. */
  primarySource?: MarketSource | null;
  /** `market_sources` priorities 1..n, in this order. Default none. */
  fallbackSources?: MarketSource[];
  fallbackCondition?: string;
  longDelayDays?: number | null;
  delayHandling?: string;
  /**
   * Every rule item blank, 배경 included, but those given above: a market made before #23 as
   * migration 0050 left it (which kept its 배경, if it had one). Default false.
   */
  blankRuleItems?: boolean;
  /**
   * Default `open`. A `review` or `scheduled` market made here has no review request and no event:
   * `createMarketInReview` and `createScheduledMarket` make one as the review's routes leave it,
   * and `createOpenedMarket` an `open` one with that history, its `opened` event (#21) and rule v1
   * (#80); a `paused` one has no pause row either, which `createPausedMarket` writes with that
   * history (#114). A market of any status made here has no rule version (`rule_version` null), as
   * one opened before #80 (D4): its rules are not held by migration 0053's guard, and it takes no
   * supplement.
   */
  status?: MarketStatus;
  /**
   * YES price of the last fill, 1..99. Default null: a market nobody traded has no price
   * (N02 §5). A test that needs a traded market sets it with the statistics below.
   */
  lastPrice?: number | null;
  /**
   * The last fill's time (`last_fill_at`, #121), set exactly when `lastPrice` is
   * (`markets_last_fill_at_check`). Default: the database clock when `lastPrice` is given, else
   * null.
   */
  lastFillAt?: Date | null;
  /**
   * Statistics overrides (list and read tests), as a row holds them, not as fills made them: only
   * the intake writes them from fills (#121, market-stats.ts). Default 0 like a market nobody
   * traded.
   */
  volumeCoin?: bigint;
  tradeCount?: number;
  traderCount?: number;
  /**
   * The actual open time. Default: now for every status that has opened, none for `draft`,
   * `review` and `scheduled` (the open path stamps it). A list-order test sets it, or sets `null`
   * for a public market with no open time, which 신규 puts after every opened market and 추천 after the
   * opened markets of its own 24-hour volume (the open time is 추천's tie-break; ADR-0065).
   */
  openAt?: Date | null;
  closeAt?: Date;
  /**
   * The market times beside `closeAt` (#22, ADR-0098), TIME_ITEMS of @buddha/shared. By default
   * every required one is filled in and in order with the close and 사건 기한 as they end up, so a
   * market made here misses no time item, passes every order CHECK of migration 0051 and is
   * submitted for review through the route at once with its tags:
   *
   * - the scheduled open one minute before the earlier of now and the close, floored to the minute
   *   — passed, so an approval opens the market at once and the worker's open job opens a
   *   `createScheduledMarket` one (#21), and before the close even when that is past;
   * - the scheduled judgement 24 hours after the later of the close and 사건 기한, raised to the
   *   minute first;
   * - the judgement zone DEFAULT_JUDGEMENT_TIME_ZONE;
   * - no announcement ('없음'), so the undecided `market.lead_close_gap` never blocks the submission.
   *
   * A test of a missing time gives `null`, or `blankTimes` for all of them; a given value is stored
   * as given, held by the CHECKs alone.
   */
  scheduledOpenAt?: Date | null;
  scheduledAnnouncementAt?: Date | null;
  scheduledJudgementAt?: Date | null;
  judgementTimeZone?: string | null;
  /**
   * Every time item null but those given above: a market made before #22 as migration 0051 left
   * it. Default false.
   */
  blankTimes?: boolean;
  /**
   * The 선행 마감 gap the market's lead close was last checked against (`lead_close_gap_minutes`).
   * Default null: never submitted for review, or submitted with the setting undecided.
   */
  leadCloseGapMinutes?: number | null;
  /**
   * The market's 가격 보호 폭 in ticks (`price_protection_ticks`, #119). Default: null for a draft
   * (created while the default is undecided, filled at the submission — `createMarketInReview`
   * fills TEST_PRICE_PROTECTION_TICKS), TEST_PRICE_PROTECTION_TICKS (5, the test value) for every
   * other status, so an order reaches an open market with no setup. A test of a market with none
   * passes null.
   */
  priceProtectionTicks?: number | null;
  /**
   * Resolution columns, stored as given and null by default: a test that needs a market
   * mid-settlement sets `status: 'settling'` with a result. The factory writes no market event,
   * so `statusEventId` stays null unless given — the rank fallback of `statusSupersedes` is what
   * such a row orders by. A `provisional` market has a result by default: YES (migration 0055's
   * `markets_provisional_check` wants one).
   */
  resolvedResult?: MarketResult | null;
  resolvedAt?: Date | null;
  settledAt?: Date | null;
  statusEventId?: number | null;
  /**
   * The current judgement's version and dispute deadline (#152, ADR-0103), stored as given. Null
   * by default — a market not judged yet, or judged by the interim route before #152 — but for a
   * `provisional` market, which has both (`markets_provisional_check`): version 1 and a deadline a
   * day from now. A market made here has no `market_judgements` row, whatever its status:
   * `createProvisionalMarket` writes one with its history, and `resolveMarketNow` confirms it.
   */
  judgementVersion?: number | null;
  disputeDeadline?: Date | null;
  /**
   * The 판정 이의 mirror (#175, ADR-0104: `markets.dispute_hold_count`), stored as given — a
   * PROVISIONAL market's label test ('이의 검토 중', '판정 지연') sets it with no dispute row, which a
   * market made here cannot take (no judgement: `createDispute` writes one on
   * `createProvisionalMarket`'s market and keeps the count). Default 0; any other status refuses
   * more (`markets_dispute_hold_status_check`).
   */
  disputeHoldCount?: number;
  /**
   * The 판정 정정 mirror (#176, ADR-0105: `markets.correction_pending`), stored as given — a
   * PROVISIONAL market's label test ('판정 지연' while a correction waits) sets it with no request,
   * as `disputeHoldCount`. Default false; any other status refuses true
   * (`markets_correction_pending_status_check`).
   */
  correctionPending?: boolean;
  /**
   * `market_settlement_steps` rows (ADR-0046) as the real paths leave them: for `resolved` and
   * `settling`, one `pending` row per SETTLEMENT_STEPS step (the transition to `resolved` writes
   * them); for `settled`, one `done` row each, completed at `settledAt` (or now). Default true;
   * `false` writes none — the state a test of the worker's missing-row fallback starts from.
   * Other statuses never get rows.
   */
  settlementSteps?: boolean;
  /**
   * Tag names (#17), linked in this order as `market_tags` positions 1..n; a name no tag has makes
   * the tag, one differing from an existing tag only in case links that tag (as the API does).
   * Default none — which the submission refuses (the open-items check): a draft a test submits
   * through the route gives some.
   */
  tags?: string[];
}

/** The rule items `createMarket` writes (#23): complete, blank or as given. */
function ruleItemsOf(input: CreateMarketInput, t: string, closeAt: Date) {
  const blank = input.blankRuleItems === true;
  const pick = <T>(given: T | undefined, filled: T, empty: T): T =>
    given !== undefined ? given : blank ? empty : filled;
  const fallbackSources = input.fallbackSources ?? [];
  return {
    description: pick<string | null>(input.description, `테스트 시장 ${t}의 배경.`, null),
    yesCondition: pick(input.yesCondition, `사건 기한까지 테스트 사건 ${t}이 일어나면 YES.`, ''),
    noCondition: pick(input.noCondition, '사건 기한까지 YES 조건이 충족되지 않으면 NO.', ''),
    eventDeadline: pick<Date | null>(
      input.eventDeadline,
      new Date(closeAt.getTime() + 24 * 60 * 60 * 1000),
      null,
    ),
    // The URL a market's source had before #23, so the link review exempts what it did.
    primarySource: pick<MarketSource | null>(
      input.primarySource,
      { name: `테스트 출처 ${t}`, url: 'https://example.com/source' },
      null,
    ),
    fallbackSources,
    fallbackCondition: pick(
      input.fallbackCondition,
      fallbackSources.length > 0 ? '1차 출처에 발표가 없으면 대체 출처를 순서대로 확인한다.' : '',
      '',
    ),
    longDelayDays: pick<number | null>(input.longDelayDays, 14, null),
    delayHandling: pick(
      input.delayHandling,
      '장기 지연 기한까지 발표가 없으면 무효로 판정한다. 늦게 발표된 것만으로 NO로 판정하지 않는다.',
      '',
    ),
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * The market times `createMarket` writes (#22, ADR-0098): complete and in order with the close and
 * 사건 기한 as they end up, blank or as given.
 */
function timesOf(input: CreateMarketInput, now: Date, closeAt: Date, eventDeadline: Date | null) {
  const pick = <T>(given: T | null | undefined, filled: T): T | null =>
    given !== undefined ? given : input.blankTimes === true ? null : filled;
  const opens = floorToMinute(Math.min(now.getTime(), closeAt.getTime())) - MINUTE_MS;
  const closeOrDeadline = Math.max(closeAt.getTime(), eventDeadline?.getTime() ?? -Infinity);
  return {
    scheduledOpenAt: pick(input.scheduledOpenAt, new Date(opens)),
    scheduledAnnouncementAt: input.scheduledAnnouncementAt ?? null,
    scheduledJudgementAt: pick(
      input.scheduledJudgementAt,
      new Date(ceilToMinute(closeOrDeadline) + DAY_MS),
    ),
    judgementTimeZone: pick(input.judgementTimeZone, DEFAULT_JUDGEMENT_TIME_ZONE),
  };
}

/**
 * Inserts a market as the admin create path leaves it, in the given status: no price until a
 * fill (`lastPrice` null) and statistics at 0 unless given, its rule items complete unless
 * blanked (`CreateMarketInput.blankRuleItems`, or an item given blank), the sources as
 * `market_sources` rows, and its times complete and in order unless blanked (`blankTimes`, or a
 * time given null). Writes no tick and no event.
 */
export async function createMarket(db: Db, input: CreateMarketInput = {}) {
  const lastPrice = input.lastPrice ?? null;
  const inRange = (price: number) =>
    Number.isInteger(price) && price >= PRICE_MIN && price <= PRICE_MAX;
  if (lastPrice !== null && !inRange(lastPrice)) {
    throw new RangeError(`lastPrice must be an integer 1..99 or null, got ${String(lastPrice)}`);
  }
  const t = tag();
  const createdBy = input.createdBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const categoryId = input.categoryId ?? (await createCategory(db)).id;
  const status = input.status ?? 'open';
  const now = new Date();
  const closeAt = input.closeAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const items = ruleItemsOf(input, t, closeAt);
  const times = timesOf(input, now, closeAt, items.eventDeadline);

  const [row] = await db
    .insert(markets)
    .values({
      slug: input.slug ?? `market-${t}`,
      title: input.title ?? `테스트 시장 ${t}`,
      description: items.description,
      yesCondition: items.yesCondition,
      noCondition: items.noCondition,
      eventDeadline: items.eventDeadline,
      fallbackCondition: items.fallbackCondition,
      longDelayDays: items.longDelayDays,
      delayHandling: items.delayHandling,
      categoryId,
      status,
      lastPrice,
      lastFillAt:
        input.lastFillAt !== undefined
          ? input.lastFillAt
          : lastPrice === null
            ? null
            : sql`date_trunc('milliseconds', clock_timestamp())`,
      volumeCoin: input.volumeCoin ?? 0n,
      tradeCount: input.tradeCount ?? 0,
      traderCount: input.traderCount ?? 0,
      openAt:
        input.openAt !== undefined
          ? input.openAt
          : status === 'draft' || status === 'review' || status === 'scheduled'
            ? null
            : now,
      scheduledOpenAt: times.scheduledOpenAt,
      closeAt,
      scheduledAnnouncementAt: times.scheduledAnnouncementAt,
      scheduledJudgementAt: times.scheduledJudgementAt,
      judgementTimeZone: times.judgementTimeZone,
      leadCloseGapMinutes: input.leadCloseGapMinutes ?? null,
      priceProtectionTicks:
        input.priceProtectionTicks !== undefined
          ? input.priceProtectionTicks
          : status === 'draft'
            ? null
            : TEST_PRICE_PROTECTION_TICKS,
      resolvedResult:
        input.resolvedResult !== undefined
          ? input.resolvedResult
          : status === 'provisional'
            ? 'YES'
            : null,
      resolvedAt: input.resolvedAt ?? null,
      settledAt: input.settledAt ?? null,
      statusEventId: input.statusEventId ?? null,
      judgementVersion:
        input.judgementVersion !== undefined
          ? input.judgementVersion
          : status === 'provisional'
            ? 1
            : null,
      disputeDeadline:
        input.disputeDeadline !== undefined
          ? input.disputeDeadline
          : status === 'provisional'
            ? new Date(now.getTime() + DAY_MS)
            : null,
      disputeHoldCount: input.disputeHoldCount ?? 0,
      correctionPending: input.correctionPending ?? false,
      createdBy,
    })
    .returning();
  const market = row!;
  const sources = [
    ...(items.primarySource === null ? [] : [{ ...items.primarySource, priority: 0 }]),
    ...items.fallbackSources.map((source, index) => ({ ...source, priority: index + 1 })),
  ];
  if (sources.length > 0) {
    await db
      .insert(marketSources)
      .values(sources.map((source) => ({ marketId: market.id, ...source })));
  }
  if (input.tags && input.tags.length > 0) {
    // `tags` takes no UPDATE (migration 0049): insert what is new, then read every id by its key
    // (`name_key` is `lower(name)`, the API's `tagKey` on a normalised name).
    await db
      .insert(tags)
      .values(input.tags.map((name) => ({ name: normalizeTagName(name) })))
      .onConflictDoNothing({ target: tags.nameKey });
    const keys = input.tags.map((name) => tagKey(name));
    const stored = await db
      .select({ id: tags.id, nameKey: tags.nameKey })
      .from(tags)
      .where(inArray(tags.nameKey, keys));
    const idByKey = new Map(stored.map((found) => [found.nameKey, found.id]));
    await db.insert(marketTags).values(
      keys.map((key, index) => ({
        marketId: market.id,
        tagId: idByKey.get(key)!,
        position: index + 1,
      })),
    );
  }
  if (
    input.settlementSteps !== false &&
    (status === 'resolved' || status === 'settling' || status === 'settled')
  ) {
    for (const step of SETTLEMENT_STEPS) {
      await createSettlementStep(db, {
        marketId: market.id,
        step,
        ...(status === 'settled'
          ? { status: 'done', attempts: 1, completedAt: input.settledAt ?? now }
          : {}),
      });
    }
  }
  return market;
}

export interface CreateSettlementStepInput {
  marketId: string;
  /** Default 'coin'. */
  step?: SettlementStep;
  /** Default 'pending'. `done` needs `completedAt` (a CHECK ties the two). */
  status?: SettlementStepStatus;
  /** Default 0. */
  attempts?: number;
  completedAt?: Date | null;
  lastError?: string | null;
}

/**
 * Inserts one `market_settlement_steps` row and nothing else (ADR-0046): a test that needs a
 * step in a given state — failed with an error, done — writes it here. The primary key
 * (market_id, step) applies, so a second row for one pair throws.
 */
export async function createSettlementStep(db: Db, input: CreateSettlementStepInput) {
  const [row] = await db
    .insert(marketSettlementSteps)
    .values({
      marketId: input.marketId,
      step: input.step ?? 'coin',
      status: input.status ?? 'pending',
      attempts: input.attempts ?? 0,
      completedAt: input.completedAt ?? null,
      lastError: input.lastError ?? null,
    })
    .returning();
  return row!;
}

export interface CreatePositionInput {
  userId: string;
  marketId: string;
  outcome: Outcome;
  qty: number;
  /** Default 0. */
  costBasisCoin?: bigint;
  /** Default 0. */
  realizedPnlCoin?: bigint;
  /** Default false. */
  settled?: boolean;
  /** Contracts live sell orders hold (#118), 0..qty. Default 0. */
  lockedQty?: number;
}

/**
 * Inserts a `positions` row and nothing else: no ledger entry, no balance change, no market
 * statistics. That makes it right for tests of reads and settlement inputs (a holder exists),
 * and wrong for anything that audits the books (PLAN 5.6) — a test that needs a position the
 * ledger can explain writes the ledger entry and balance change that bought it as well.
 */
export async function createPosition(db: Db, input: CreatePositionInput) {
  const [row] = await db
    .insert(positions)
    .values({
      userId: input.userId,
      marketId: input.marketId,
      outcome: input.outcome,
      qty: input.qty,
      costBasisCoin: input.costBasisCoin ?? 0n,
      realizedPnlCoin: input.realizedPnlCoin ?? 0n,
      settled: input.settled ?? false,
      lockedQty: input.lockedQty ?? 0,
    })
    .returning();
  return row!;
}

export interface CreateFillInput {
  marketId: string;
  /** Total Coin of the fill: what the 24-hour volume of 추천 sums (ADR-0065). */
  amountCoin: bigint;
  /** Default: the database clock. A volume-window test sets it. */
  createdAt?: Date;
  /** The incoming order's owner. A fresh user is created when omitted. */
  userId?: string;
  /** The resting order's owner. A fresh user is created when omitted. */
  makerId?: string;
  /** Default 'YES'. */
  outcome?: Outcome;
  /** Default 'buy'. */
  side?: 'buy' | 'sell';
  /**
   * Default: the quantity `priceAndQtyOf` finds for the amount (the highest price that divides
   * it). Given, the amount over it must be a contract price.
   */
  qty?: number;
}

/**
 * One execution as the intake records it (#119, `createFillRecord`): an IOC order of `userId`
 * filled against a resting GTC order of `makerId` — a buy minting a pair with a buy of the other
 * outcome, a sell trading with a buy of its outcome — and the `fills` row between them, its
 * amount `amountCoin` (price × qty). No balance, position, ledger entry or market statistic moves —
 * only the intake writes the statistics (#121): a test that needs both pairs this with
 * `createMarket`'s statistics. The two orders
 * share the fill's instant, and both owners have a fill on the market (`hasMarketFill`).
 */
export async function createFill(db: Db, input: CreateFillInput) {
  const taker = input.userId ?? (await createUser(db)).user.id;
  const maker = input.makerId ?? (await createUser(db)).user.id;
  let size = priceAndQtyOf(input.amountCoin);
  if (input.qty !== undefined) {
    const price = Number(input.amountCoin) / input.qty;
    if (!Number.isInteger(price) || price < PRICE_MIN || price > PRICE_MAX) {
      throw new RangeError(
        `createFill: ${input.amountCoin.toString()} Coin is no price × ${input.qty}`,
      );
    }
    size = { priceCoin: price, qty: input.qty };
  }
  const { fill } = await createFillRecord(db, {
    marketId: input.marketId,
    incomingOwnerId: taker,
    restingOwnerId: maker,
    outcome: input.outcome ?? 'YES',
    side: input.side ?? 'buy',
    ...size,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  });
  return fill;
}

export interface CreateWatchInput {
  userId: string;
  marketId: string;
  /**
   * When the watch began. Default: the database clock. A list-order test sets it, since watches
   * written in one test can share a millisecond.
   */
  watchedAt?: Date;
}

/**
 * A current watch (#89, ADR-0064) as the API's watch leaves it: the `market_watches` row and its
 * one `watch` event at the same instant, in one transaction. The primary key applies, so a second
 * watch of one pair throws — the API's own repeat writes nothing instead.
 */
export async function createWatch(db: Db, input: CreateWatchInput) {
  return db.transaction(async (tx) => {
    const [watch] = await tx
      .insert(marketWatches)
      .values({
        userId: input.userId,
        marketId: input.marketId,
        ...(input.watchedAt === undefined ? {} : { watchedAt: input.watchedAt }),
      })
      .returning();
    const [event] = await tx
      .insert(marketWatchEvents)
      .values({
        userId: input.userId,
        marketId: input.marketId,
        action: 'watch',
        createdAt: watch!.watchedAt,
      })
      .returning();
    return { watch: watch!, event: event! };
  });
}

export interface CreateSearchInput {
  userId: string;
  query: string;
  /**
   * When it was searched. Default: the database clock. A list-order test sets it, since searches
   * written in one test can share a millisecond.
   */
  searchedAt?: Date;
  /**
   * The row's id. Default: the database's random uuid. A test of a tie within one millisecond
   * sets it, since the larger id wins the tie (migration 0026) and random ones would leave which
   * is written first to chance.
   */
  id?: string;
}

/**
 * A recorded search (#15, ADR-0066) as `POST /me/search-history` leaves it: one `market_searches`
 * row, and its term in `market_search_terms` — which the database's insert trigger writes, for
 * this insert as for the API's (migration 0026), so the factory adds nothing of its own. The term
 * is stored as given; the API trims it first.
 */
export async function createSearch(db: Db, input: CreateSearchInput) {
  const [row] = await db
    .insert(marketSearches)
    .values({
      userId: input.userId,
      query: input.query,
      ...(input.searchedAt === undefined ? {} : { searchedAt: input.searchedAt }),
      ...(input.id === undefined ? {} : { id: input.id }),
    })
    .returning();
  return row!;
}

export interface CreateMarketLinkInput {
  /** Either end: the pair is stored once, smaller id first, whichever order is given. */
  marketId: string;
  relatedMarketId: string;
  /** The linking admin. A fresh admin is created when omitted. */
  createdBy?: string;
  /** Default: the database clock. An order test sets it, since links can share a millisecond. */
  createdAt?: Date;
}

/**
 * A link between two markets (#65, ADR-0068) as `POST /admin/markets/:id/related` leaves the
 * `market_links` row — and only the row: no `admin_actions` row, which the API writes beside it.
 * The pair is ordered here as the API orders it (`relatedMarketPair`), so a market can be linked
 * from either side; the same market twice throws, as the CHECK would.
 */
export async function createMarketLink(db: Db, input: CreateMarketLinkInput) {
  const pair = relatedMarketPair(input.marketId, input.relatedMarketId);
  if (pair === undefined) throw new RangeError('a market cannot be linked to itself');
  const createdBy = input.createdBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const [row] = await db
    .insert(marketLinks)
    .values({
      ...pair,
      createdBy,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning();
  return row!;
}

export interface CreatePhoneVerificationInput {
  userId: string;
  /** Digits only. Default: a random 010 number, so two verified accounts never share one. */
  phone?: string;
  /** Default: 홍길동. */
  realName?: string;
  /** Default: the database clock. */
  verifiedAt?: Date;
}

/** A random mobile number, digits only: 010 and eight digits. */
export function randomPhone(): string {
  return `010${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
}

/**
 * A completed 본인확인 (#183, ADR-0070) as a matched confirmation leaves it: the
 * `phone_verifications` row, and nothing of the code that was sent for it. For a test whose
 * subject needs a verified account rather than the verification itself; the number is UNIQUE, so
 * the same number twice throws, as a second account confirming it would be refused.
 */
export async function createPhoneVerification(db: Db, input: CreatePhoneVerificationInput) {
  const [row] = await db
    .insert(phoneVerifications)
    .values({
      userId: input.userId,
      phone: input.phone ?? randomPhone(),
      realName: input.realName ?? '홍길동',
      ...(input.verifiedAt === undefined ? {} : { verifiedAt: input.verifiedAt }),
    })
    .returning();
  return row!;
}

export interface CreateStartGrantInput {
  userId: string;
  /**
   * The keyed hash of the number (64 lower-case hex), recorded as the grant's own number. Default:
   * a random one, so two grants never share a number; a test about "the same number" passes the
   * API's hash of it, or one hash twice.
   */
  phoneHash?: string;
  /**
   * Pays it with this amount (the START_GRANT entry and the balance, through `payStartGrant`, as
   * the API and the worker pay). Omit for a grant still pending, as one recorded while the
   * release setting `grant.start_coin` was undecided.
   */
  amountCoin?: bigint;
}

/** A random keyed-hash-shaped value: 64 lower-case hex characters. */
export function randomPhoneHash(): string {
  return randomBytes(32).toString('hex');
}

/**
 * A start grant (#70, ADR-0071) as the grant leaves it: the `start_grants` row and its number's
 * `start_grant_numbers` row (`source` 'grant'), recorded by `recordStartGrant`, pending, or paid
 * when `amountCoin` is given. A grant is recorded only for an account with a 본인확인 record, and
 * `payStartGrant` pays no other, so an account without one gets one (a random number, which the
 * random `phoneHash` need not match); a test of a withdrawn account deletes it afterwards. Does
 * not hash the number; a test whose subject is the grant itself goes through the API's
 * StartGrantService. Throws when the account has a grant already or the hash is held by another.
 */
export async function createStartGrant(db: Db, input: CreateStartGrantInput) {
  return db.transaction(async (tx) => {
    await tx
      .insert(phoneVerifications)
      .values({ userId: input.userId, phone: randomPhone(), realName: '홍길동' })
      .onConflictDoNothing({ target: phoneVerifications.userId });
    const recorded = await recordStartGrant(tx, input.userId, input.phoneHash ?? randomPhoneHash());
    if (recorded.outcome !== 'recorded') {
      throw new Error(`start grant not recorded: ${recorded.outcome}`);
    }
    const amountCoin = input.amountCoin;
    const paid = await payStartGrant(tx, recorded.grantId, () =>
      Promise.resolve(amountCoin ?? null),
    );
    if (amountCoin === undefined ? paid.outcome !== 'pending' : paid.outcome !== 'granted') {
      throw new Error(`start grant not left as asked: ${paid.outcome}`);
    }
    return paid.grant;
  });
}

export interface CreateConsentsInput {
  userId: string;
  /** The optional marketing item's answer. Default: not agreed. */
  marketing?: boolean;
  /** Versions to record instead of the current ones, by item (a record from before a revision). */
  versions?: Partial<Record<(typeof CONSENT_ITEMS)[number], string>>;
  clientIp?: string | null;
  userAgent?: string | null;
}

/**
 * The consent step as `POST /me/consents` records it (#58): one row per item, the required ones
 * agreed, at the current versions unless `versions` says otherwise. For a test whose subject needs
 * an account past its consent step rather than the step itself.
 */
export async function createConsents(db: Db, input: CreateConsentsInput) {
  return db
    .insert(consentRecords)
    .values(
      CONSENT_ITEMS.map((item) => ({
        userId: input.userId,
        item,
        version: input.versions?.[item] ?? currentConsentVersion(item),
        agreed: item === 'marketing' ? (input.marketing ?? false) : true,
        clientIp: input.clientIp ?? null,
        userAgent: input.userAgent ?? null,
      })),
    )
    .returning();
}

export interface CompleteOnboardingInput {
  userId: string;
  /** The 본인확인's number, digits only, when the account has no record yet. Default: random. */
  phone?: string;
  /** Also answer the interest categories step (with none). Default: false. */
  interests?: boolean;
}

/**
 * An account past the onboarding's three steps (#58) as the API leaves it, without the start
 * Coin: its consent records, a 본인확인 record (kept if it has one), and its nickname confirmed as
 * it is. For a test whose subject needs an onboarded account — an action #57-8 keeps from the rest
 * — rather than the onboarding itself; the start grant is `createStartGrant`'s.
 */
export async function completeOnboarding(db: Db, input: CompleteOnboardingInput) {
  await createConsents(db, { userId: input.userId });
  await db
    .insert(phoneVerifications)
    .values({ userId: input.userId, phone: input.phone ?? randomPhone(), realName: '홍길동' })
    .onConflictDoNothing({ target: phoneVerifications.userId });
  const [profile] = await db
    .update(profiles)
    .set({
      nicknameConfirmedAt: sql`now()`,
      ...(input.interests ? { interestsAnsweredAt: sql`now()` } : {}),
    })
    .where(eq(profiles.userId, input.userId))
    .returning();
  if (!profile) throw new Error(`no profile for ${input.userId}`);
  return profile;
}

export interface SetReleaseSettingInput {
  /** The admin the change is recorded under (release_settings.updated_by, admin_actions). */
  adminId: string;
  key: string;
  status: ReleaseSettingStatus;
  /** Null exactly while `undecided`. */
  value: unknown;
  /** Default: 시험. */
  reason?: string;
}

/**
 * A release setting changed as the admin screen changes it (#170, migration 0020): the row and its
 * `release_setting_change` record in one transaction, at an instant after the key's last change.
 * For a suite that needs an item's value where the API's ReleaseSettingsService is not at hand
 * (the worker); it checks neither the registry nor the item's schema.
 */
export async function setReleaseSetting(db: Db, input: SetReleaseSettingInput) {
  const { adminId, key, status, value } = input;
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        status: releaseSettings.status,
        value: storedReleaseSettingValue,
        updatedAt: releaseSettings.updatedAt,
      })
      .from(releaseSettings)
      .where(eq(releaseSettings.key, key));
    const at = new Date(Math.max(Date.now(), (current?.updatedAt.getTime() ?? 0) + 1));
    await tx.insert(adminActions).values({
      adminId,
      type: 'release_setting_change',
      targetType: 'release_setting',
      targetId: key,
      payload: {
        key,
        before: { status: current?.status ?? 'undecided', value: current?.value ?? null },
        after: { status, value },
        reason: input.reason ?? '시험',
      },
      createdAt: at,
    });
    const written = { status, value, updatedAt: at, updatedBy: adminId };
    await tx
      .insert(releaseSettings)
      .values({ key, ...written })
      .onConflictDoUpdate({ target: releaseSettings.key, set: written });
  });
}

export interface CreateMediaInput {
  ownerId: string;
  /** Default: image/webp. */
  contentType?: ImageContentType;
  /** Default: the database clock. The orphan cleanup's tests set an older one. */
  createdAt?: Date;
}

const EXTENSION_OF: Readonly<Record<ImageContentType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * An upload's row as `POST /media/images` leaves it (#46): a post image of `ownerId`, attached to
 * nothing. Only the row — the object is the test's store's to hold or not (@buddha/storage's
 * MemoryObjectStorage); its key is the API's shape, `post-images/<id>.<ext>`.
 */
export async function createMedia(db: Db, input: CreateMediaInput) {
  const id = randomUUID();
  const contentType = input.contentType ?? 'image/webp';
  const [row] = await db
    .insert(mediaObjects)
    .values({
      id,
      ownerId: input.ownerId,
      kind: 'post_image',
      storageKey: `post-images/${id}.${EXTENSION_OF[contentType]}`,
      contentType,
      byteSize: 1_024,
      width: 64,
      height: 48,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning();
  return row!;
}

export interface CreateProfileImageInput {
  userId: string;
  /** Default: image/webp. One of a profile image's three types (#37-6). */
  contentType?: Exclude<ImageContentType, 'image/gif'>;
}

/**
 * A profile image as `PUT /me/profile-image` leaves it (#141): an upload of `userId`'s of the
 * profile image's kind, 512px square (a large upload's), attached from the start, and the
 * profile's image — replacing the profile's earlier one, whose row stays as an operator's removal
 * leaves it (#50). Only the rows — the object is the test's store's to hold or not; its key is the
 * API's shape, `profile-images/<id>.<ext>`.
 */
export async function createProfileImage(db: Db, input: CreateProfileImageInput) {
  const id = randomUUID();
  const contentType = input.contentType ?? 'image/webp';
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(mediaObjects)
      .values({
        id,
        ownerId: input.userId,
        kind: 'profile_image',
        storageKey: `profile-images/${id}.${EXTENSION_OF[contentType]}`,
        contentType,
        byteSize: 2_048,
        width: 512,
        height: 512,
        attachedAt: sql`now()`,
      })
      .returning();
    await tx.update(profiles).set({ imageId: id }).where(eq(profiles.userId, input.userId));
    return row!;
  });
}

export interface CreatePostInput {
  marketId: string;
  authorId: string;
  /** Default: none. */
  title?: string | null;
  /**
   * The body as text: one paragraph per line. Default: '근거 <tag>'. Ignored with `document`.
   */
  text?: string;
  /** The whole body, as `sanitizePostDocument` would have stored it. */
  document?: PostDocument;
  /**
   * Uploads (`createMedia`) the body shows after its paragraphs, in order: attached to the post
   * as the API attaches them. Ignored with `document`, whose own images are attached instead.
   */
  imageIds?: string[];
  /** Default: the database clock. A list's order test sets it. */
  createdAt?: Date;
  editedAt?: Date;
  deletedAt?: Date;
  hiddenAt?: Date;
}

/**
 * A post (#46) as `POST /posts` leaves it — the row with its body's text and images derived as the
 * API derives them (`readPostDocument`), and each image attached (`post_images`, the upload's
 * `attached_at`) — or, with the times, as an edit, a deletion or an operator's hiding left it.
 * No revision rows: an edit's history is the API's to write.
 */
export async function createPost(db: Db, input: CreatePostInput) {
  const document: PostDocument = input.document ?? {
    type: 'doc',
    content: [
      ...(input.text ?? `근거 ${tag()}`)
        .split('\n')
        .map((line) =>
          line === ''
            ? { type: 'paragraph' as const }
            : { type: 'paragraph' as const, content: [{ type: 'text' as const, text: line }] },
        ),
      ...(input.imageIds ?? []).map((mediaId) => ({ type: 'image' as const, attrs: { mediaId } })),
    ],
  };
  const read = readPostDocument(document);
  return db.transaction(async (tx) => {
    const [post] = await tx
      .insert(posts)
      .values({
        marketId: input.marketId,
        authorId: input.authorId,
        title: input.title ?? null,
        body: document,
        bodyText: read.text,
        imageIds: read.imageIds,
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
        ...(input.editedAt === undefined ? {} : { editedAt: input.editedAt }),
        ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
        ...(input.hiddenAt === undefined ? {} : { hiddenAt: input.hiddenAt }),
      })
      .returning();
    if (read.imageIds.length > 0) {
      await tx
        .insert(postImages)
        .values(read.imageIds.map((mediaId) => ({ postId: post!.id, mediaId })));
      await tx
        .update(mediaObjects)
        .set({ attachedAt: sql`now()` })
        .where(inArray(mediaObjects.id, read.imageIds));
    }
    return post!;
  });
}

export interface CreateCommentInput {
  postId: string;
  authorId: string;
  /** The 댓글 a 대댓글 hangs under. Default: none — a 댓글. */
  parentId?: string | null;
  /**
   * That 댓글's `created_at`, which a 대댓글 carries. Default: read from the row `parentId` names (a
   * parent that is not there gives NULL, refused by `post_comments_parent_created_at_check`); a
   * test of the parent's foreign key sets it.
   */
  parentCreatedAt?: Date;
  /** Default: '댓글 <tag>'. Stored as given: the API's normalisation is the API's. */
  body?: string;
  /** Default: the database clock. An order test sets it. */
  createdAt?: Date;
  editedAt?: Date;
  deletedAt?: Date;
  hiddenAt?: Date;
}

/**
 * A comment (#48) as `POST /posts/:postId/comments` leaves it, or, with the times, as an edit, a
 * deletion or an operator's hiding left it. No revision rows: an edit's history is the API's to
 * write. The database holds the layers (a 대댓글's parent is a 댓글 of the same post) whoever
 * writes, this factory included.
 */
export async function createComment(db: Db, input: CreateCommentInput) {
  const [comment] = await db
    .insert(postComments)
    .values({
      postId: input.postId,
      authorId: input.authorId,
      parentId: input.parentId ?? null,
      parentCreatedAt:
        input.parentCreatedAt ??
        (input.parentId === undefined || input.parentId === null
          ? null
          : sql`(SELECT ${postComments.createdAt} FROM ${postComments} WHERE ${postComments.id} = ${input.parentId})`),
      body: input.body ?? `댓글 ${tag()}`,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      ...(input.editedAt === undefined ? {} : { editedAt: input.editedAt }),
      ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
      ...(input.hiddenAt === undefined ? {} : { hiddenAt: input.hiddenAt }),
    })
    .returning();
  return comment!;
}

export interface CreateLikeInput {
  /** The account that likes. */
  userId: string;
  /**
   * The keyed hash of its number (64 lower-case hex). Default: a random one, so two likes never
   * share a number; a test about "the same number" passes one hash twice, or the API's hash of
   * the account's verified number.
   */
  phoneHash?: string;
  /** Default: the database clock. */
  createdAt?: Date;
}

/**
 * A like on a post (#49) as `PUT /posts/:postId/like` leaves it: the `post_likes` row. Checks
 * nothing the API checks (the onboarding, the post's state); the database holds once per number
 * and once per account, so a second like of either throws.
 */
export async function createPostLike(db: Db, input: CreateLikeInput & { postId: string }) {
  const [like] = await db
    .insert(postLikes)
    .values({
      postId: input.postId,
      userId: input.userId,
      phoneHash: input.phoneHash ?? randomPhoneHash(),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning();
  return like!;
}

/** A like on a 댓글 or a 대댓글 (#49), as `createPostLike` makes a post's. */
export async function createCommentLike(db: Db, input: CreateLikeInput & { commentId: string }) {
  const [like] = await db
    .insert(commentLikes)
    .values({
      commentId: input.commentId,
      userId: input.userId,
      phoneHash: input.phoneHash ?? randomPhoneHash(),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning();
  return like!;
}

export interface CreateNoticeInput {
  /** Default: '공지 <tag>'. */
  title?: string;
  /**
   * The body as text: one paragraph per line. Default: '공지 내용 <tag>'. Ignored with `document`.
   */
  text?: string;
  /** The whole body, as `sanitizePostDocument` would have stored it. */
  document?: PostDocument;
  /**
   * Uploads (`createMedia`) the body shows after its paragraphs, in order: attached to the notice
   * as the API attaches them. Ignored with `document`, whose own images are attached instead.
   */
  imageIds?: string[];
  /** Default: the database clock. A list's order test sets it. */
  createdAt?: Date;
  editedAt?: Date;
  /**
   * Pinned in this slot (1..NOTICE_PIN_LIMIT, the database holds the range and one notice per
   * slot), since `pinnedAt` (default: the database clock). Default: not pinned.
   */
  pinSlot?: number;
  pinnedAt?: Date;
}

/**
 * A notice (#138) as `POST /admin/notices` leaves it — the row with its body's text and images
 * derived as the API derives them, each image attached (`notice_images`, the upload's
 * `attached_at`) — or, with `pinSlot`, as a pin left it. No revision or audit rows: those are the
 * API's to write.
 */
export async function createNotice(db: Db, input: CreateNoticeInput = {}) {
  const document: PostDocument = input.document ?? {
    type: 'doc',
    content: [
      ...(input.text ?? `공지 내용 ${tag()}`)
        .split('\n')
        .map((line) =>
          line === ''
            ? { type: 'paragraph' as const }
            : { type: 'paragraph' as const, content: [{ type: 'text' as const, text: line }] },
        ),
      ...(input.imageIds ?? []).map((mediaId) => ({ type: 'image' as const, attrs: { mediaId } })),
    ],
  };
  const read = readPostDocument(document);
  return db.transaction(async (tx) => {
    const [notice] = await tx
      .insert(notices)
      .values({
        title: input.title ?? `공지 ${tag()}`,
        body: document,
        bodyText: read.text,
        imageIds: read.imageIds,
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
        ...(input.editedAt === undefined ? {} : { editedAt: input.editedAt }),
        ...(input.pinSlot === undefined
          ? {}
          : { pinSlot: input.pinSlot, pinnedAt: input.pinnedAt ?? sql`now()` }),
      })
      .returning();
    if (read.imageIds.length > 0) {
      await tx
        .insert(noticeImages)
        .values(read.imageIds.map((mediaId) => ({ noticeId: notice!.id, mediaId })));
      await tx
        .update(mediaObjects)
        .set({ attachedAt: sql`now()` })
        .where(inArray(mediaObjects.id, read.imageIds));
    }
    return notice!;
  });
}

export interface CreateModerationActionInput {
  /** The member acted on. */
  userId: string;
  /** The operator. */
  createdBy: string;
  /** Default: `hide` with a post, `warning` without one. */
  type?: ModerationActionType;
  /** A hiding's post, or a warning's. */
  postId?: string;
  /** A hiding's comment, or a warning's. */
  commentId?: string;
  /** Default: `spam`. An `account_restriction` takes one of ACCOUNT_RESTRICTION_REASONS. */
  reason?: ModerationReason;
  /**
   * The explanation the member reads. Default: none (a `other` needs one), and for an
   * `account_restriction`, which always has one, '계정 제한 설명'.
   */
  note?: string | null;
  /** Default: the database clock. */
  createdAt?: Date;
  /**
   * A `writing_restriction`'s or an `account_restriction`'s end (#185, #139): null or left out for
   * 무기한. Nothing else has one.
   */
  endsAt?: Date | null;
  /**
   * An `account_restriction`'s approval (#139): the other admin who approves the request `createdBy`
   * asks for — a request of the kind `account_restriction` for the member, made and approved here
   * (migration 0042 refuses the row without one). Required for that type, refused for the others.
   */
  approvedBy?: string;
  /**
   * A cancellation: when, by whom and why — and for an `account_restriction`, the other admin who
   * approves the request to cancel it (`approvedBy`).
   */
  cancelled?: { at: Date; by: string; reason: string; approvedBy?: string };
  /**
   * What a profile action took away (#37-10): kept in `profile_item_removals` for the
   * `nickname_reset`, `bio_clear` and `image_remove` types. Default: a nickname, a 소개 or no image
   * — an `image_remove` needs its image id.
   */
  removed?: { nickname?: string; bio?: string; imageId?: string };
}

/**
 * A moderation action (#50) as an operator's route leaves the record: the `moderation_actions` row,
 * and for a profile action what it took away. Writes nothing else — not `hidden_at`, nor the
 * profile — so a test sets the item's state itself (`createPost({ hiddenAt })`).
 */
export async function createModerationAction(db: Db, input: CreateModerationActionInput) {
  const type = input.type ?? (input.postId || input.commentId ? 'hide' : 'warning');
  const account = type === 'account_restriction';
  if (account !== (input.approvedBy !== undefined)) {
    throw new Error(
      'createModerationAction: approvedBy is an account_restriction’s, and its alone',
    );
  }
  return db.transaction(async (tx) => {
    const id = randomUUID();
    const approvalId = account
      ? (
          await createApprovalRequest(tx as unknown as Db, {
            kind: 'account_restriction',
            targetType: 'user',
            targetId: input.userId,
            requestedBy: input.createdBy,
            ...(input.createdAt === undefined ? {} : { requestedAt: input.createdAt }),
            decision: { status: 'approved', by: input.approvedBy! },
          })
        ).id
      : null;
    const cancelled = input.cancelled;
    if (account && cancelled !== undefined && cancelled.approvedBy === undefined) {
      throw new Error('createModerationAction: an account restriction is cancelled by an approval');
    }
    const cancelApprovalId =
      account && cancelled !== undefined
        ? (
            await createApprovalRequest(tx as unknown as Db, {
              kind: 'account_restriction_cancel',
              targetType: 'moderation_action',
              targetId: id,
              // As AccountRestrictionService writes a change's request: the member it is about,
              // which migration 0044's retention_delete_approval_requests reads.
              payload: { userId: input.userId, actionId: id },
              requestedBy: cancelled.by,
              requestedAt: cancelled.at,
              decision: { status: 'approved', by: cancelled.approvedBy! },
            })
          ).id
        : null;
    const [action] = await tx
      .insert(moderationActions)
      .values({
        id,
        type,
        userId: input.userId,
        postId: input.postId ?? null,
        commentId: input.commentId ?? null,
        reason: input.reason ?? 'spam',
        note: input.note ?? (account ? '계정 제한 설명' : null),
        createdBy: input.createdBy,
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
        endsAt: input.endsAt ?? null,
        approvalId,
        ...(cancelled === undefined
          ? {}
          : {
              cancelledAt: cancelled.at,
              cancelledBy: cancelled.by,
              cancelReason: cancelled.reason,
              cancelApprovalId,
            }),
      })
      .returning();
    const removed = input.removed;
    if (type === 'nickname_reset' || type === 'bio_clear' || type === 'image_remove') {
      await tx.insert(profileItemRemovals).values({
        actionId: action!.id,
        nickname: type === 'nickname_reset' ? (removed?.nickname ?? `old_${tag()}`) : null,
        bio: type === 'bio_clear' ? (removed?.bio ?? `소개 ${tag()}`) : null,
        imageId: type === 'image_remove' ? (removed?.imageId ?? null) : null,
      });
    }
    return action!;
  });
}

export interface CreateApprovalRequestInput {
  /** The two-person rule's kind (approvals.ts), a consumer's: `account_restriction` and the rest. */
  kind: string;
  targetType?: string | null;
  targetId?: string | null;
  payload?: Record<string, unknown> | null;
  /** The admin who asks. */
  requestedBy: string;
  /** Default: '요청 사유'. */
  reason?: string;
  /** Default: the database clock. */
  requestedAt?: Date;
  /**
   * The decision, by an admin other than the requester (migration 0021 refuses the rest), a
   * millisecond after the request unless `at` is given. Left out: pending.
   */
  decision?: { status: 'approved' | 'rejected'; by: string; reason?: string; at?: Date };
  /**
   * Retracted by its requester instead (#139, migration 0042), a millisecond after the request
   * unless `at` is given. Not with `decision`.
   */
  retracted?: { at?: Date };
}

/**
 * A two-person rule request (#171), pending, decided or retracted — inserted pending and closed by
 * the one UPDATE migration 0021 allows, as ApprovalService does. The deciding account must hold
 * the admin role (the trigger reads it).
 */
export async function createApprovalRequest(db: Db, input: CreateApprovalRequestInput) {
  const requestedAt =
    input.requestedAt ??
    (await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`)).rows[0]!.now;
  const at = new Date(requestedAt);
  const [request] = await db
    .insert(approvalRequests)
    .values({
      kind: input.kind,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      payload: input.payload ?? null,
      requestedBy: input.requestedBy,
      requestReason: input.reason ?? '요청 사유',
      requestedAt: at,
    })
    .returning();
  if (input.retracted !== undefined) {
    if (input.decision !== undefined) {
      throw new Error('createApprovalRequest: a request is decided or retracted, not both');
    }
    const [retracted] = await db
      .update(approvalRequests)
      .set({
        status: 'retracted',
        retractedAt: input.retracted.at ?? new Date(at.getTime() + 1),
      })
      .where(eq(approvalRequests.id, request!.id))
      .returning();
    return retracted!;
  }
  if (input.decision === undefined) return request!;
  const [decided] = await db
    .update(approvalRequests)
    .set({
      status: input.decision.status,
      decidedBy: input.decision.by,
      decisionReason: input.decision.reason ?? '결정 사유',
      decidedAt: input.decision.at ?? new Date(at.getTime() + 1),
    })
    .where(eq(approvalRequests.id, request!.id))
    .returning();
  return decided!;
}

/** The market fields `createMarketInReview` and `createScheduledMarket` take from createMarket. */
type ReviewedMarketFields = Omit<
  CreateMarketInput,
  | 'status'
  | 'openAt'
  | 'resolvedResult'
  | 'resolvedAt'
  | 'settledAt'
  | 'statusEventId'
  | 'judgementVersion'
  | 'disputeDeadline'
  | 'settlementSteps'
>;

export interface CreateMarketInReviewInput extends ReviewedMarketFields {
  /**
   * Tag names, as createMarket takes them. Default `['검수']`: a market under review passed the
   * open-items check, which wants 1..5.
   */
  tags?: string[];
  /**
   * The admin who submitted it: the `market_review` request's requester and the `submitted`
   * event's actor. Default: the creator (`createdBy`, a fresh admin when that is omitted too).
   */
  submittedBy?: string;
  /** The submission's instant, the request's and the event's. Default: the database clock. */
  submittedAt?: Date;
  /**
   * Admins who edited the draft before it was submitted, in this order: one `market_update` record
   * each on the market, a millisecond apart and the last a millisecond before the submission — the
   * editors the approval and the 반려 exclude (#78, ADR-0093 decision 2 #172 item 5). An admin may
   * be named twice. The record's before and after are empty (the API writes snapshots there, which
   * nothing reads back). Default none.
   */
  editedBy?: string[];
  /**
   * A submission from before #119 (migration 0062): the market reaches REVIEW with no 가격 보호 폭,
   * which the approval refuses (ADR-0112 결정 5). Default false: the draft's own width, else
   * TEST_PRICE_PROTECTION_TICKS, as the submission fills it in.
   */
  withoutPriceProtection?: boolean;
}

/** A market under review, scheduled or opened from it, with its `market_review` request (#78). */
export interface ReviewedMarket {
  market: typeof markets.$inferSelect;
  request: typeof approvalRequests.$inferSelect;
}

/**
 * A market submitted for review (#78, ADR-0099) as `POST /admin/markets/:id/submit` leaves it: a
 * complete draft (createMarket, with tags), its editors' `market_update` records, a pending
 * `market_review` request about it by the submitter (target `market`, payload `{title}`,
 * MARKET_REVIEW_REQUEST_REASON), and the `submitted` transition — the `market_events` row (payload
 * `{approvalId, leadCloseGapMinutes}`) and the market in `review` with its `status_event_id` —
 * made by `transitionMarket`, at one instant, in one transaction. The submission stores the gap it
 * checked: `leadCloseGapMinutes` as given (default null), and the 가격 보호 폭 (the draft's own, else
 * TEST_PRICE_PROTECTION_TICKS, #119). Writes no `market_submit` record, as no
 * factory writes the admin records of a route (but the editors', which are the point here).
 */
export async function createMarketInReview(
  db: Db,
  input: CreateMarketInReviewInput = {},
): Promise<ReviewedMarket> {
  const { submittedBy, submittedAt, editedBy, withoutPriceProtection, ...fields } = input;
  const createdBy = fields.createdBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const draft = await createMarket(db, {
    ...fields,
    createdBy,
    tags: fields.tags ?? ['검수'],
    status: 'draft',
  });
  return db.transaction(async (tx) => {
    const at =
      submittedAt ??
      new Date(
        (await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`)).rows[0]!.now,
      );
    const editors = editedBy ?? [];
    if (editors.length > 0) {
      await tx.insert(adminActions).values(
        editors.map((adminId, index) => ({
          adminId,
          type: 'market_update',
          targetType: 'market',
          targetId: draft.id,
          payload: { before: {}, after: {} },
          createdAt: new Date(at.getTime() - (editors.length - index)),
        })),
      );
    }
    const requester = submittedBy ?? createdBy;
    const request = await createApprovalRequest(tx as unknown as Db, {
      kind: MARKET_REVIEW_APPROVAL_KIND,
      targetType: 'market',
      targetId: draft.id,
      payload: { title: draft.title },
      requestedBy: requester,
      reason: MARKET_REVIEW_REQUEST_REASON,
      requestedAt: at,
    });
    const leadCloseGapMinutes = draft.leadCloseGapMinutes;
    // The submission fills a draft with no width of its own with the default (#119).
    const priceProtectionTicks =
      withoutPriceProtection === true
        ? null
        : (draft.priceProtectionTicks ?? TEST_PRICE_PROTECTION_TICKS);
    await transitionMarket(tx, {
      marketId: draft.id,
      from: 'draft',
      to: 'review',
      type: 'submitted',
      actorId: requester,
      payload: { approvalId: request.id, leadCloseGapMinutes },
      at,
      set: { leadCloseGapMinutes, priceProtectionTicks },
    });
    const [market] = await tx.select().from(markets).where(eq(markets.id, draft.id));
    return { market: market!, request };
  });
}

export interface CreateScheduledMarketInput extends CreateMarketInReviewInput {
  /**
   * The approving admin: the request's decider and the `approved` event's actor. Neither the
   * creator, an editor nor the submitter (MARKET_REVIEW_EXCLUSIONS): the factory throws, as the
   * route refuses. Default: a fresh admin.
   */
  approvedBy?: string;
  /** The approval's instant. Default: a millisecond after the submission. */
  approvedAt?: Date;
  /** The approval's reason (the request's decision reason). Default '검수 승인'. */
  approvalReason?: string;
}

/**
 * A market approved for opening (#78, ADR-0099) as `POST /admin/markets/:id/approve` leaves it:
 * `createMarketInReview`'s market, its request approved by another admin with a reason, and the
 * `approved` transition — the `market_events` row (payload `{approvalId, checklist, reason}`, every
 * MARKET_REVIEW_CHECKLIST item) and the market in `scheduled` — in one transaction. Writes no
 * `market_approve` record.
 *
 * The scheduled open is createMarket's (a minute before now) unless given: due, as a SCHEDULED
 * market is once its time comes and before the worker's `market.open` job runs, which opens it
 * (`createOpenedMarket`). The route itself opens a market approved past its scheduled open in the
 * same transaction (#21, ADR-0100), so a test of a market as the approval left it gives a later
 * scheduled open.
 */
export async function createScheduledMarket(
  db: Db,
  input: CreateScheduledMarketInput = {},
): Promise<ReviewedMarket> {
  const { approvedBy, approvedAt, approvalReason, ...reviewInput } = input;
  const approver = approvedBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const createdBy = reviewInput.createdBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const exclusion = marketReviewExclusion(approver, {
    createdBy,
    editorIds: reviewInput.editedBy ?? [],
    requestedBy: reviewInput.submittedBy ?? createdBy,
  });
  if (exclusion !== null) {
    throw new Error(`createScheduledMarket: the ${exclusion} never approves the review`);
  }
  const { market: review, request } = await createMarketInReview(db, {
    ...reviewInput,
    createdBy,
  });
  return db.transaction(async (tx) => {
    const at = approvedAt ?? new Date(request.requestedAt.getTime() + 1);
    const reason = approvalReason ?? '검수 승인';
    const [approved] = await tx
      .update(approvalRequests)
      .set({ status: 'approved', decidedBy: approver, decisionReason: reason, decidedAt: at })
      .where(eq(approvalRequests.id, request.id))
      .returning();
    await transitionMarket(tx, {
      marketId: review.id,
      from: 'review',
      to: 'scheduled',
      type: 'approved',
      actorId: approver,
      payload: { approvalId: request.id, checklist: [...MARKET_REVIEW_CHECKLIST], reason },
      at,
    });
    const [market] = await tx.select().from(markets).where(eq(markets.id, review.id));
    return { market: market!, request: approved! };
  });
}

/**
 * A market opened at its scheduled open (#21, ADR-0100) as the worker's `market.open` job leaves
 * it: `createScheduledMarket`'s market, then `openScheduledMarket` in one transaction under the
 * market lock, with the row read FOR UPDATE and the database clock after it, as the worker (actor
 * null, `source: 'job'`) — the `opened` event, the market `open` with `open_at` and `updated_at`
 * at that instant, `status_event_id` that event's and `rule_version` 1, and rule v1 (#80, ADR-0101:
 * the content as the review locked it, made by no one at that instant). From then on its rules
 * change only by a supplement (`createRuleSupplement`). The returned `market` is the row read back
 * after the open, `request` the approved review. The scheduled open is
 * createScheduledMarket's (a minute before now) unless given: one still ahead, or a close that has
 * come, opens nothing and the factory throws with the skip reason. A test that needs an open
 * market and none of its history uses `createMarket`.
 */
export async function createOpenedMarket(
  db: Db,
  input: CreateScheduledMarketInput = {},
): Promise<ReviewedMarket> {
  const { market: scheduled, request } = await createScheduledMarket(db, input);
  return db.transaction(async (tx) => {
    await lockMarket(tx, scheduled.id);
    const [current] = await tx
      .select()
      .from(markets)
      .where(eq(markets.id, scheduled.id))
      .for('update');
    const now = await clockTimestamp(tx);
    const result = await openScheduledMarket(tx, {
      market: current!,
      now,
      actorId: null,
      source: 'job',
    });
    if (!result.opened) {
      throw new Error(`createOpenedMarket: the market did not open (${result.reason})`);
    }
    return { market: result.row, request };
  });
}

/** A rule version (#80): a row of `market_rule_versions`. */
export type RuleVersionRow = MarketRuleVersionRow;

/** The 보충 문구 a supplement factory writes unless given: a new 배경 (#80). */
const supplementedDescription = () => `보충한 배경 ${tag()}: 오탈자를 고치고 문장을 다듬었다.`;

/** The reason a supplement factory writes unless given (the request's reason). */
const SUPPLEMENT_REASON = '오탈자 수정';

/** The 정산 영향 검토 a supplement factory writes unless given. */
const SETTLEMENT_IMPACT = '판정 기준과 결과의 뜻이 바뀌지 않아 정산에 영향이 없다.';

export interface CreateSupplementRequestInput {
  /** The market: one with a rule version (`createOpenedMarket`'s, or one supplemented since). */
  marketId: string;
  /**
   * 보충 문구 (#172 item 15): the new value of each item to change, in the request body's shapes
   * (`marketSupplementChangesSchema` of @buddha/shared, parsed here — texts trimmed, an unknown or
   * fixed item refused). Default: a new 배경. Not checked against the market (the route's item
   * rules): a test gives what the route would take, or tests the route's refusal of it.
   */
  changes?: MarketSupplementChanges;
  /** The version the text was written against. Default: the market's current one. */
  baseVersion?: number;
  /** The requesting admin. Default: a fresh admin. */
  requestedBy?: string;
  /** The supplement's reason — the request's reason. Default '오탈자 수정'. */
  reason?: string;
  /** 정산 영향 검토. Default: a sentence saying the meaning does not change. */
  settlementImpact?: string;
  /** The request's instant. Default: the database clock. */
  requestedAt?: Date;
  /**
   * A 반려 by another admin instead (`createApprovalRequest`'s decision), a millisecond after the
   * request unless `at` is given. No record of its reason from the list: that is the route's
   * `admin_actions` row, which no factory writes. Left out with `retracted`: pending.
   */
  rejected?: { by: string; reason?: string; at?: Date };
  /** The requester's 철회 instead, a millisecond after the request unless `at` is given. */
  retracted?: { at?: Date };
}

/**
 * A supplement request (#80, ADR-0101) as `POST /admin/markets/:id/supplements` leaves it: a
 * `market_supplement` approval request about the market (target `market`, payload
 * `{baseVersion, changes, settlementImpact}` — MarketSupplementRequestPayload — and the
 * supplement's reason as the request's), pending, or rejected or retracted as asked. Changes
 * nothing of the market and writes no event, as the route; nor its `market_supplement_request`
 * record, as no factory writes a route's. Throws for a market with no rule version when no
 * `baseVersion` is given. `createRuleSupplement` makes an approved one, with its version.
 */
export async function createSupplementRequest(db: Db, input: CreateSupplementRequestInput) {
  const changes = marketSupplementChangesSchema.parse(
    input.changes ?? { description: supplementedDescription() },
  );
  let baseVersion = input.baseVersion;
  if (baseVersion === undefined) {
    const [market] = await db
      .select({ ruleVersion: markets.ruleVersion })
      .from(markets)
      .where(eq(markets.id, input.marketId));
    if (!market) throw new Error(`createSupplementRequest: market ${input.marketId} not found`);
    if (market.ruleVersion === null) {
      throw new Error('createSupplementRequest: the market has no rule version');
    }
    baseVersion = market.ruleVersion;
  }
  const requestedBy = input.requestedBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const payload: MarketSupplementRequestPayload = {
    baseVersion,
    changes,
    settlementImpact: input.settlementImpact ?? SETTLEMENT_IMPACT,
  };
  return createApprovalRequest(db, {
    kind: MARKET_SUPPLEMENT_APPROVAL_KIND,
    targetType: 'market',
    targetId: input.marketId,
    payload,
    requestedBy,
    reason: input.reason ?? SUPPLEMENT_REASON,
    ...(input.requestedAt === undefined ? {} : { requestedAt: input.requestedAt }),
    ...(input.rejected === undefined
      ? {}
      : { decision: { status: 'rejected', ...input.rejected } }),
    ...(input.retracted === undefined ? {} : { retracted: input.retracted }),
  });
}

export interface CreateRuleSupplementInput extends Omit<
  CreateSupplementRequestInput,
  'baseVersion' | 'rejected' | 'retracted'
> {
  /**
   * The approving admin, never the requester: the factory throws, as the route refuses. Default: a
   * fresh admin.
   */
  approvedBy?: string;
  /** The approval's reason (the request's decision reason). Default '보충 승인'. */
  approvalReason?: string;
  /** The approval's instant, the version's. Default: a millisecond after the request. */
  approvedAt?: Date;
}

/** A supplement `createRuleSupplement` approved: the market after it, the request, the version. */
export interface RuleSupplement {
  /** The market read back after the approval. */
  market: typeof markets.$inferSelect;
  /** The `market_supplement` request, approved. */
  request: typeof approvalRequests.$inferSelect;
  /** The version the approval made. */
  version: RuleVersionRow;
}

/**
 * A supplement approved (#80, ADR-0101; ADR-0093 decision 2 #172 item 15) as `POST
 * /admin/markets/:id/supplements/:requestId/approve` leaves it, against the market's current
 * version, in one transaction under the market lock with the row FOR UPDATE: the request
 * (`createSupplementRequest`'s) approved by another admin with a reason; the market's new text —
 * the changed columns and, when the sources change, its `market_sources` rows, written with the
 * guard opened for it (`allowRuleSupplement`) — with `rule_version` one more and `updated_at` the
 * approval's instant; the version (`insertRuleVersion`: the full text read back, the changed items,
 * the reason, the review, the request, the requester, the approver as its maker, at that instant);
 * and the one `rules_supplemented` event (actor the approver, no status, payload `{version,
 * approvalId, items, reason, requestedBy}`). No `market_supplement_approve` record, and nothing
 * published or rescheduled (the close job is the API's).
 *
 * The request's instant is the database clock, and never at or before the market's last write, so
 * a version follows the one before. The route's checks are not made — the status, the close, the
 * item rules, the lead close: a test gives changes the route would take. Throws, writing nothing,
 * for a market with no rule version, an approval by the requester, and changes that change nothing
 * (`insertRuleVersion`).
 */
export async function createRuleSupplement(
  db: Db,
  input: CreateRuleSupplementInput,
): Promise<RuleSupplement> {
  const { marketId } = input;
  const changes = marketSupplementChangesSchema.parse(
    input.changes ?? { description: supplementedDescription() },
  );
  const requestedBy = input.requestedBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const approvedBy = input.approvedBy ?? (await createUser(db, { role: 'admin' })).user.id;
  if (approvedBy === requestedBy) {
    throw new Error('createRuleSupplement: the requester never approves the supplement');
  }
  const reason = input.reason ?? SUPPLEMENT_REASON;
  const settlementImpact = input.settlementImpact ?? SETTLEMENT_IMPACT;
  return db.transaction(async (tx) => {
    await lockMarket(tx, marketId);
    const [current] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update');
    if (!current) throw new Error(`createRuleSupplement: market ${marketId} not found`);
    if (current.ruleVersion === null) {
      throw new Error('createRuleSupplement: the market has no rule version');
    }
    const baseVersion = current.ruleVersion;
    const requestedAt =
      input.requestedAt ??
      new Date(Math.max((await clockTimestamp(tx)).getTime(), current.updatedAt.getTime() + 1));
    const at = input.approvedAt ?? new Date(requestedAt.getTime() + 1);
    const request = await createSupplementRequest(tx as unknown as Db, {
      marketId,
      changes,
      baseVersion,
      requestedBy,
      reason,
      settlementImpact,
      requestedAt,
    });
    const [approved] = await tx
      .update(approvalRequests)
      .set({
        status: 'approved',
        decidedBy: approvedBy,
        decisionReason: input.approvalReason ?? '보충 승인',
        decidedAt: at,
      })
      .where(eq(approvalRequests.id, request.id))
      .returning();

    const after = applySupplementChanges(await readRuleContent(tx, marketId), changes);
    const instant = (iso: string | null) => (iso === null ? null : new Date(iso));
    const version = baseVersion + 1;
    await allowRuleSupplement(tx, marketId);
    await tx
      .update(markets)
      .set({
        title: after.title,
        description: after.description,
        yesCondition: after.yesCondition,
        noCondition: after.noCondition,
        eventDeadline: instant(after.eventDeadline),
        fallbackCondition: after.fallbackCondition,
        longDelayDays: after.longDelayDays,
        delayHandling: after.delayHandling,
        closeAt: new Date(after.closeAt),
        scheduledAnnouncementAt: instant(after.scheduledAnnouncementAt),
        judgementTimeZone: after.judgementTimeZone,
        ruleVersion: version,
        updatedAt: at,
      })
      .where(eq(markets.id, marketId));
    if (changes.primarySource !== undefined || changes.fallbackSources !== undefined) {
      // The whole set, as the API's `replaceMarketSources` writes it: no gap but a missing primary.
      await tx.delete(marketSources).where(eq(marketSources.marketId, marketId));
      const sources = [
        ...(after.primarySource === null ? [] : [{ ...after.primarySource, priority: 0 }]),
        ...after.fallbackSources.map((source, index) => ({ ...source, priority: index + 1 })),
      ];
      if (sources.length > 0) {
        await tx.insert(marketSources).values(sources.map((source) => ({ marketId, ...source })));
      }
    }
    const row = await insertRuleVersion(tx, {
      marketId,
      version,
      createdAt: at,
      createdBy: approvedBy,
      supplement: { approvalId: request.id, requestedBy, reason, settlementImpact },
    });
    const payload: MarketRulesSupplementedPayload = {
      version,
      approvalId: request.id,
      items: row.changedItems as MarketRulesSupplementedPayload['items'],
      reason,
      requestedBy,
    };
    await tx.insert(marketEvents).values({
      marketId,
      type: 'rules_supplemented',
      actorId: approvedBy,
      payload: { ...payload },
      createdAt: at,
    });
    const [market] = await tx.select().from(markets).where(eq(markets.id, marketId));
    return { market: market!, request: approved!, version: row };
  });
}

export interface CreateSupplementedMarketInput extends CreateScheduledMarketInput {
  /**
   * The supplements approved one after another, each making the next version (v2, v3…), as
   * `createRuleSupplement` takes them. Default: one, a new 배경.
   */
  supplements?: Omit<CreateRuleSupplementInput, 'marketId'>[];
}

/** An opened market with approved supplements (#80): the review as `ReviewedMarket`, and more. */
export interface SupplementedMarket extends ReviewedMarket {
  /** Each supplement's approved request and the version it made, in order. */
  supplements: { request: typeof approvalRequests.$inferSelect; version: RuleVersionRow }[];
  /** Every version of the market, v1 first. */
  versions: RuleVersionRow[];
}

/**
 * An opened market whose rules were supplemented (#80, ADR-0101), for the tests of the version
 * history and of a later supplement: `createOpenedMarket`'s market (v1 at the open), then each of
 * `supplements` approved in turn by `createRuleSupplement` (v2, v3…). `market` is the row after
 * the last; `request` is the review's, as `createOpenedMarket` returns it.
 */
export async function createSupplementedMarket(
  db: Db,
  input: CreateSupplementedMarketInput = {},
): Promise<SupplementedMarket> {
  const { supplements = [{}], ...openedInput } = input;
  const opened = await createOpenedMarket(db, openedInput);
  let market = opened.market;
  const made: SupplementedMarket['supplements'] = [];
  for (const supplement of supplements) {
    const result = await createRuleSupplement(db, { ...supplement, marketId: market.id });
    market = result.market;
    made.push({ request: result.request, version: result.version });
  }
  const versions = await db
    .select()
    .from(marketRuleVersions)
    .where(eq(marketRuleVersions.marketId, market.id))
    .orderBy(marketRuleVersions.version);
  return { market, request: opened.request, supplements: made, versions };
}

/** The note a pause factory writes unless given (what happened, the pausing admin's). */
const PAUSE_NOTE = '사건 일정이 바뀌어 거래를 멈추고 판정 기준을 검토한다.';

/** The reason a next-path request factory writes unless given (the request's reason). */
const PAUSE_DECISION_REASON = '검토를 마쳤다.';

/** The approval's reason a next-path factory writes unless given (the decision reason). */
const PAUSE_DECISION_APPROVAL_REASON = '요청한 경로가 맞다.';

/**
 * The review result a next-path factory gives a pause of `reason` unless told: `judgeable` for
 * `basis_change` (the request needs one, Q1), none for the other reasons.
 */
const defaultReviewResult = (reason: MarketPauseReason): MarketPauseReviewResult | null =>
  pauseReasonNeedsReview(reason) ? 'judgeable' : null;

export interface CreateMarketPauseInput {
  /** An OPEN market: `createOpenedMarket`'s, or `createMarket`'s (no rule version). */
  marketId: string;
  /** Default `basis_change` (실질 기준 변경, where an early close usually starts — Q2). */
  reason?: MarketPauseReason;
  /** What happened. Default: a sentence. Stored as given (the database holds 1–500, trimmed). */
  note?: string;
  /**
   * The result's publication instant: for `early_result` alone, a minute before the pause unless
   * given; null (or left out) for the other reasons — given for one, the factory throws, as
   * `pauseMarket` does.
   */
  resultPublishedAt?: Date | null;
  /** The pausing admin. Default: a fresh admin. */
  by?: string;
}

/** A pause a factory made: the market after it, the lasting pause and its `paused` event. */
export interface MarketPauseMade {
  market: typeof markets.$inferSelect;
  pause: MarketPauseRow;
  /** The `paused` event's id, the market's `status_event_id`. */
  eventId: number;
}

/**
 * A pause (#114, ADR-0102) as `POST /admin/markets/:id/pause` leaves it, of a market already OPEN:
 * `pauseMarket` in one transaction under the market lock, with the row read FOR UPDATE and the
 * database clock after it — the `paused` event (actor `by`, payload `{pauseId, reason,
 * resultPublishedAt}`), the market `paused` and its lasting `market_pauses` row, and its resting
 * orders cancelled 일시 중단 as the route does (but for `ledger_failure`, #178: the orders locked after
 * the row, before the clock). No `market_pause` record, as no factory writes a route's. The route's
 * checks are `pauseMarket`'s: a market not OPEN, a close that has come or a publication instant
 * after the pause pauses nothing, and the factory throws with the skip reason.
 */
export async function createMarketPause(
  db: Db,
  input: CreateMarketPauseInput,
): Promise<MarketPauseMade> {
  const reason = input.reason ?? 'basis_change';
  const by = input.by ?? (await createUser(db, { role: 'admin' })).user.id;
  return db.transaction(async (tx) => {
    await lockMarket(tx, input.marketId);
    const [current] = await tx
      .select()
      .from(markets)
      .where(eq(markets.id, input.marketId))
      .for('update');
    if (!current) throw new Error(`createMarketPause: market ${input.marketId} not found`);
    const orders = await lockMarketOrders(tx, input.marketId);
    const now = await clockTimestamp(tx);
    const resultPublishedAt =
      input.resultPublishedAt !== undefined
        ? input.resultPublishedAt
        : pauseReasonNeedsPublishedAt(reason)
          ? new Date(now.getTime() - MINUTE_MS)
          : null;
    const result = await pauseMarket(tx, {
      market: current,
      orders,
      now,
      actorId: by,
      reason,
      note: input.note ?? PAUSE_NOTE,
      resultPublishedAt,
    });
    if (!result.paused) {
      throw new Error(`createMarketPause: the market did not pause (${result.reason})`);
    }
    return { market: result.market, pause: result.pause, eventId: result.eventId };
  });
}

export interface CreatePausedMarketInput
  extends CreateScheduledMarketInput, Omit<CreateMarketPauseInput, 'marketId'> {}

/** A paused market with its history: the review as `ReviewedMarket`, and the pause. */
export interface PausedMarket extends ReviewedMarket {
  pause: MarketPauseRow;
  /** The `paused` event's id, the market's `status_event_id`. */
  eventId: number;
}

/**
 * A PAUSED market (#114, ADR-0102) with its whole history: `createOpenedMarket`'s market (v1 at the
 * open), then `createMarketPause` — the `paused` event and the lasting pause, by `by` (a fresh
 * admin by default) for `reason` (`basis_change` by default). `market` is the row after the pause;
 * `request` the review's, as `createOpenedMarket` returns it. A test that needs a paused market and
 * none of its history uses `createMarket({ status: 'paused' })`, which has no pause row.
 */
export async function createPausedMarket(
  db: Db,
  input: CreatePausedMarketInput = {},
): Promise<PausedMarket> {
  const { reason, note, resultPublishedAt, by, ...openedInput } = input;
  const opened = await createOpenedMarket(db, openedInput);
  const paused = await createMarketPause(db, {
    marketId: opened.market.id,
    ...(reason === undefined ? {} : { reason }),
    ...(note === undefined ? {} : { note }),
    ...(resultPublishedAt === undefined ? {} : { resultPublishedAt }),
    ...(by === undefined ? {} : { by }),
  });
  return { ...paused, request: opened.request };
}

export interface CreatePauseDecisionInput {
  /** A market with a pause: its lasting one is the request's unless `pauseId` names another. */
  marketId: string;
  /** 재개 or 조기 마감. Not checked against the review result (the route's rule). */
  path: MarketPausePath;
  /**
   * The review result. Default: `judgeable` for a `basis_change` pause, null for the others. Stored
   * as given: a test of the route's refusal gives what it would refuse.
   */
  reviewResult?: MarketPauseReviewResult | null;
  /** The pause it decides. Default: the market's lasting one (the factory throws when none). */
  pauseId?: string;
  /** The requesting admin. Default: a fresh admin. */
  by?: string;
  /** The request's reason. Default: a sentence. */
  reason?: string;
  /** The request's instant. Default: the database clock. */
  requestedAt?: Date;
  /**
   * A 반려 by another admin instead (`createApprovalRequest`'s decision), a millisecond after the
   * request unless `at` is given. Left out with `retracted`: pending.
   */
  rejected?: { by: string; reason?: string; at?: Date };
  /** The requester's 철회 instead, a millisecond after the request unless `at` is given. */
  retracted?: { at?: Date };
}

/**
 * A next-path request (#114, ADR-0102) as `POST /admin/markets/:id/pause-decisions` leaves it: a
 * `market_pause_decision` approval request about the market (target `market`, payload `{pauseId,
 * path, reviewResult}` — MarketPauseDecisionRequestPayload — and the request's reason), pending,
 * or rejected or retracted as asked. Changes nothing of the market and writes no event, as the
 * route; nor its `market_pause_decision_request` record. The route's checks are not made (the
 * status, the close, the pause named being the lasting one, one waiting per market, the reason's
 * rules): a test gives what the route would take, or tests the route's refusal of it — an ended
 * pause's request (`pauseId`) is the approval's 'stale'. `closeMarketEarly` and `resumeMarket`
 * make an approved one, with the pause's end.
 */
export async function createPauseDecision(db: Db, input: CreatePauseDecisionInput) {
  const [pause] = await db
    .select()
    .from(marketPauses)
    .where(
      input.pauseId === undefined
        ? and(eq(marketPauses.marketId, input.marketId), isNull(marketPauses.endedAt))
        : eq(marketPauses.id, input.pauseId),
    );
  if (!pause) {
    throw new Error(`createPauseDecision: market ${input.marketId} has no such pause`);
  }
  const by = input.by ?? (await createUser(db, { role: 'admin' })).user.id;
  const payload: MarketPauseDecisionRequestPayload = {
    pauseId: pause.id,
    path: input.path,
    reviewResult:
      input.reviewResult === undefined ? defaultReviewResult(pause.reason) : input.reviewResult,
  };
  if ((await ledgerHeldMarketIds(db, [input.marketId])).has(input.marketId)) {
    const run = await db.transaction((tx) =>
      runMarketReconciliation(tx, input.marketId, { source: 'recovery', actorId: by }),
    );
    payload.recovery = run.hold
      ? {
          holdId: run.hold.id,
          failureResultId:
            run.hold.failureResultId === null ? null : String(run.hold.failureResultId),
        }
      : null;
  }
  return createApprovalRequest(db, {
    kind: MARKET_PAUSE_DECISION_APPROVAL_KIND,
    targetType: 'market',
    targetId: input.marketId,
    payload: { ...payload },
    requestedBy: by,
    reason: input.reason ?? PAUSE_DECISION_REASON,
    ...(input.requestedAt === undefined ? {} : { requestedAt: input.requestedAt }),
    ...(input.rejected === undefined
      ? {}
      : { decision: { status: 'rejected', ...input.rejected } }),
    ...(input.retracted === undefined ? {} : { retracted: input.retracted }),
  });
}

export interface DecidePauseInput {
  /** The admin who asks for the path. Default: a fresh admin. */
  requestedBy?: string;
  /** The approving admin, never the requester (the factory throws). Default: a fresh admin. */
  approvedBy?: string;
  /** Default: `judgeable` for a `basis_change` pause, null for the others. */
  reviewResult?: MarketPauseReviewResult | null;
  /** The request's reason. Default: a sentence. */
  reason?: string;
  /** The approval's reason (the request's decision reason). Default: a sentence. */
  approvalReason?: string;
  /**
   * The pause first, for a market still OPEN (`createMarketPause`'s fields; the pausing admin is
   * `requestedBy` unless `by` is given). Ignored for a PAUSED market, whose lasting pause is used.
   */
  pause?: Omit<CreateMarketPauseInput, 'marketId'>;
}

export interface CloseMarketEarlyInput extends DecidePauseInput {
  /**
   * Whether the market has a fill a person's account is on before the early close, so it ends
   * CLOSED (#20): when it has none yet, one records-only fill of two fresh members (`createFill`,
   * 1 YES at 50 — both orders filled, no live order, no asset and no statistic) is made first.
   * False leaves the market as it is, so one with no such fill ends CANCELLED. Default true.
   */
  humanFill?: boolean;
}

/** A next path a factory approved: the market after it, the ended pause, the request, the event. */
export interface PauseDecided {
  /**
   * The market read back after the approval: `open`, `closed`, or `cancelled` for an early close
   * of a market with no fill a person's account is on (#20).
   */
  market: typeof markets.$inferSelect;
  /** The pause, ended (`resumed` or `early_closed`). */
  pause: MarketPauseRow;
  /** The `market_pause_decision` request, approved. */
  request: typeof approvalRequests.$inferSelect;
  /** The `resumed`, `closed` or `cancelled` event's id, the market's `status_event_id`. */
  eventId: number;
}

/**
 * A next path approved (#114, ADR-0102) as `POST /admin/markets/:id/pause-decisions/:requestId
 * /approve` leaves it: the market paused first if it is OPEN (`createMarketPause`, its own
 * transaction), then in one transaction under the market lock with the row FOR UPDATE a
 * `market_pause_decision` request about its lasting pause, approved by another admin with a
 * reason, a millisecond and two after the later of the database clock and the market's last
 * write, and `endMarketPause` at the approval's instant. For 재개, and for the 조기 마감 of a market
 * held for a ledger failure, the market's live orders are cancelled 일시 중단 first (a
 * `ledger_failure` pause's recovery, #178), then the event, the market `open` or `closed` and the
 * pause's end. For the 조기 마감 of a market not held: the event, the market `closed`, the pause's
 * end, then every live order ends 만료 at that instant (`expireLockedOrders`, #120). A pause this
 * factory made has already cancelled them (but a `ledger_failure` one), so the 만료 meets only
 * live orders a test built by hand on the PAUSED market. No admin records and no job change (the
 * API's). `endMarketPause`'s checks are made: a market neither OPEN nor PAUSED, a close that has
 * come, or a review result the pause's reason refuses throws.
 */
async function approvePauseDecision(
  db: Db,
  marketId: string,
  path: MarketPausePath,
  input: DecidePauseInput,
): Promise<PauseDecided> {
  const requestedBy = input.requestedBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const approvedBy = input.approvedBy ?? (await createUser(db, { role: 'admin' })).user.id;
  if (approvedBy === requestedBy) {
    throw new Error('approvePauseDecision: the requester never approves the next path');
  }
  const [market] = await db
    .select({ status: markets.status })
    .from(markets)
    .where(eq(markets.id, marketId));
  if (!market) throw new Error(`approvePauseDecision: market ${marketId} not found`);
  if (market.status === 'open') {
    await createMarketPause(db, { by: requestedBy, ...input.pause, marketId });
  }
  return db.transaction(async (tx) => {
    await lockMarket(tx, marketId);
    const [current] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update');
    const pause = await currentMarketPause(tx, marketId);
    if (!current || !pause) {
      throw new Error(`approvePauseDecision: market ${marketId} has no lasting pause`);
    }
    const orders = await lockMarketOrders(tx, marketId);
    const base = Math.max((await clockTimestamp(tx)).getTime(), current.updatedAt.getTime());
    const reviewResult =
      input.reviewResult === undefined ? defaultReviewResult(pause.reason) : input.reviewResult;
    const at = new Date(base + 2);
    const request = await createPauseDecision(tx as unknown as Db, {
      marketId,
      path,
      reviewResult,
      pauseId: pause.id,
      by: requestedBy,
      reason: input.reason ?? PAUSE_DECISION_REASON,
      requestedAt: new Date(base + 1),
    });
    const [approved] = await tx
      .update(approvalRequests)
      .set({
        status: 'approved',
        decidedBy: approvedBy,
        decisionReason: input.approvalReason ?? PAUSE_DECISION_APPROVAL_REASON,
        decidedAt: at,
      })
      .where(eq(approvalRequests.id, request.id))
      .returning();
    const result = await endMarketPause(tx, {
      market: current,
      orders,
      pause,
      now: at,
      approverId: approvedBy,
      path,
      reviewResult,
      approvalId: request.id,
      requestedBy,
      recovery: request.payload?.recovery
        ? {
            holdId: (request.payload.recovery as { holdId: string }).holdId,
            failureResultId:
              (request.payload.recovery as { failureResultId: string | null }).failureResultId ===
              null
                ? null
                : Number((request.payload.recovery as { failureResultId: string }).failureResultId),
          }
        : null,
    });
    if (!result.ended) {
      throw new Error(`approvePauseDecision: the pause did not end (${result.reason})`);
    }
    return {
      market: result.market,
      pause: result.pause,
      request: approved!,
      eventId: result.eventId,
    };
  });
}

/**
 * 조기 마감 (#114, ADR-0102; ADR-0093 decision 1 #173 items 2·4) as the routes leave it — a pause if
 * the market is OPEN, then a next-path request `early_close` approved by another admin — through
 * `approvePauseDecision` above: the market `closed` by the approver's `closed` event (payload
 * `{closedAt, source: 'early_close', pauseId, approvalId, requestedBy, reviewResult}`), `close_at`
 * as it was, the pause `early_closed`. The way a test reaches CLOSED now that the one-admin close
 * is gone: a `basis_change` pause reviewed `judgeable` unless told (Q2). Works on `createMarket`'s
 * bare OPEN market as on `createOpenedMarket`'s.
 *
 * Since #20 an early close of a market with no fill a person's account is on cancels it, so the
 * factory first records one such fill when the market has none (`humanFill`, default true; a
 * market that traded already gets nothing more). `{ humanFill: false }` leaves the market as it
 * is: with no such fill it ends `cancelled` by the approver's `cancelled` event (payload
 * `{cancelledAt, source: 'early_close', reason, pauseId, approvalId, requestedBy, reviewResult}`),
 * the pause `early_closed` all the same.
 */
export async function closeMarketEarly(
  db: Db,
  marketId: string,
  input: CloseMarketEarlyInput = {},
): Promise<PauseDecided> {
  const { humanFill = true, ...decide } = input;
  if (humanFill && !(await marketHasHumanFill(db, marketId))) {
    await createFill(db, { marketId, amountCoin: 50n, qty: 1 });
  }
  return approvePauseDecision(db, marketId, 'early_close', decide);
}

/**
 * 재개 (#114, ADR-0102; ADR-0093 decision 1 #173 item 2) as the routes leave it — a pause if the
 * market is OPEN, then a next-path request `resume` approved by another admin — through
 * `approvePauseDecision` above: the market `open` again by the approver's `resumed` event (payload
 * `{pauseId, approvalId, requestedBy, reviewResult}`), `open_at` as the first open left it, the
 * pause `resumed`. A `basis_change` pause is reviewed `judgeable` unless told.
 */
export async function resumeMarket(
  db: Db,
  marketId: string,
  input: DecidePauseInput = {},
): Promise<PauseDecided> {
  return approvePauseDecision(db, marketId, 'resume', input);
}

/** The reason a market cancel factory writes unless given (the request's, the public one). */
const MARKET_CANCEL_REASON = '사건이 개장 전에 끝나 결과가 이미 정해졌다.';

/** The approval's reason a market cancel factory writes unless given. */
const MARKET_CANCEL_APPROVAL_REASON = '개장 전 결과 확정을 확인함';

export interface CreateMarketCancelRequestInput {
  /** A SCHEDULED market: its current `status_event_id` is the request's pin unless given. */
  marketId: string;
  /** The requesting admin. Default: a fresh admin. */
  by?: string;
  /** The request's reason. Default: a sentence. */
  reason?: string;
  /** The pinned status event. Default: the market's `status_event_id` now. */
  statusEventId?: number;
  /** The request's instant. Default: the database clock. */
  requestedAt?: Date;
  /** A 반려 by another admin instead, a millisecond after the request unless `at` is given. */
  rejected?: { by: string; reason?: string; at?: Date };
  /** The requester's 철회 instead, a millisecond after the request unless `at` is given. */
  retracted?: { at?: Date };
}

/**
 * A SCHEDULED market's cancel request (#20, ADR-0117) as `POST /admin/markets/:id/cancel-requests`
 * leaves it: a `market_cancel` approval request about the market (target `market`, payload
 * `{statusEventId}` — MarketCancelRequestPayload — and the request's reason), pending, or
 * rejected or retracted as asked. Changes nothing of the market and writes no event, as the route;
 * nor its `market_cancel_request` record. The route's checks are not made (the status, one waiting
 * per market, a decider): a test gives what the route would take, or tests its refusal.
 */
export async function createMarketCancelRequest(db: Db, input: CreateMarketCancelRequestInput) {
  const [market] = await db
    .select({ statusEventId: markets.statusEventId })
    .from(markets)
    .where(eq(markets.id, input.marketId));
  if (!market) throw new Error(`createMarketCancelRequest: market ${input.marketId} not found`);
  const statusEventId = input.statusEventId ?? market.statusEventId;
  if (statusEventId === null) {
    throw new Error(`createMarketCancelRequest: market ${input.marketId} has no status event`);
  }
  const by = input.by ?? (await createUser(db, { role: 'admin' })).user.id;
  const payload: MarketCancelRequestPayload = { statusEventId };
  return createApprovalRequest(db, {
    kind: MARKET_CANCEL_APPROVAL_KIND,
    targetType: 'market',
    targetId: input.marketId,
    payload: { ...payload },
    requestedBy: by,
    reason: input.reason ?? MARKET_CANCEL_REASON,
    ...(input.requestedAt === undefined ? {} : { requestedAt: input.requestedAt }),
    ...(input.rejected === undefined
      ? {}
      : { decision: { status: 'rejected', ...input.rejected } }),
    ...(input.retracted === undefined ? {} : { retracted: input.retracted }),
  });
}

export interface CancelScheduledMarketNowInput {
  /** The requesting admin. Default: a fresh admin. */
  requestedBy?: string;
  /** The approving admin, never the requester (the factory throws). Default: a fresh admin. */
  approvedBy?: string;
  /** The request's reason. Default: a sentence. */
  reason?: string;
  /** The approval's reason. Default: a sentence. */
  approvalReason?: string;
}

/** A SCHEDULED market a factory cancelled: `cancelScheduledMarket`'s result and the request. */
export type ScheduledMarketCancelled = Extract<CancelScheduledMarketResult, { cancelled: true }> & {
  /** The `market_cancel` request, approved. */
  request: typeof approvalRequests.$inferSelect;
};

/**
 * 시장 취소 of a SCHEDULED market (#20, ADR-0117; ADR-0107 결정 5 '#20 운영자의 취소 경로') as
 * `POST /admin/markets/:id/cancel-requests/:requestId/approve` leaves it, in one transaction under
 * the market lock with the row FOR UPDATE: a `market_cancel` request pinning the market's status
 * event, approved by another admin with a reason a millisecond and two after the later of the
 * database clock and the market's last write, its orders locked (`lockMarketOrders`), then
 * `cancelScheduledMarket` at the approval's instant — the approver's `cancelled` event (payload
 * `{cancelledAt, source: 'operator', reason, approvalId, requestedBy}`), the market `cancelled`
 * with its result type null, every live order 만료. No admin records and no job change (the API's).
 * A market not SCHEDULED throws with the skip reason.
 */
export async function cancelScheduledMarketNow(
  db: Db,
  marketId: string,
  input: CancelScheduledMarketNowInput = {},
): Promise<ScheduledMarketCancelled> {
  const requestedBy = input.requestedBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const approvedBy = input.approvedBy ?? (await createUser(db, { role: 'admin' })).user.id;
  if (approvedBy === requestedBy) {
    throw new Error('cancelScheduledMarketNow: the requester never approves the cancel');
  }
  return db.transaction(async (tx) => {
    await lockMarket(tx, marketId);
    const [current] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update');
    if (!current) throw new Error(`cancelScheduledMarketNow: market ${marketId} not found`);
    const orders = await lockMarketOrders(tx, marketId);
    const base = Math.max((await clockTimestamp(tx)).getTime(), current.updatedAt.getTime());
    const at = new Date(base + 2);
    const reason = input.reason ?? MARKET_CANCEL_REASON;
    const request = await createMarketCancelRequest(tx as unknown as Db, {
      marketId,
      by: requestedBy,
      reason,
      requestedAt: new Date(base + 1),
    });
    const [approved] = await tx
      .update(approvalRequests)
      .set({
        status: 'approved',
        decidedBy: approvedBy,
        decisionReason: input.approvalReason ?? MARKET_CANCEL_APPROVAL_REASON,
        decidedAt: at,
      })
      .where(eq(approvalRequests.id, request.id))
      .returning();
    const result = await cancelScheduledMarket(tx, {
      market: current,
      orders,
      now: at,
      approverId: approvedBy,
      approvalId: request.id,
      requestedBy,
      reason,
      statusEventId: (request.payload as MarketCancelRequestPayload).statusEventId,
    });
    if (!result.cancelled) {
      throw new Error(`cancelScheduledMarketNow: the market was not cancelled (${result.reason})`);
    }
    return { ...result, request: approved! };
  });
}

/** The description a judgement factory writes unless given (확인한 내용의 설명, the request's reason). */
const JUDGEMENT_DESCRIPTION = '1차 출처의 발표에서 결과를 확인했다.';

/** The reason a judgement factory gives a fallback source unless given. */
const JUDGEMENT_FALLBACK_REASON = '1차 출처가 발표하지 않아 대체 출처로 확인했다.';

/** The reason a judgement factory gives a VOID unless given. */
const JUDGEMENT_VOID_REASON = '판정 불가: 규칙의 출처로 결과를 확인할 수 없다.';

/** The evidence link a judgement factory writes unless given. */
const JUDGEMENT_EVIDENCE_LINK = 'https://example.com/evidence';

/** The approval's reason a judgement factory writes unless given (the decision reason). */
const JUDGEMENT_APPROVAL_REASON = '증거와 출처가 규칙에 맞다.';

/** The 정정 사유 a correction factory writes unless given (#176). */
const JUDGEMENT_CORRECTION_REASON = '1차 출처가 발표를 정정해 결과를 바로잡는다.';

/**
 * The dispute window a judgement factory publishes with unless given: the design proposal the
 * owner approved, 1,440 minutes (ADR-0093 decision 1 #173 item 5).
 */
const JUDGEMENT_DISPUTE_WINDOW_MINUTES = 1_440;

export interface CreateJudgementRequestInput {
  /** The market judged: a CLOSED one, unless a test of the route's refusal wants another. */
  marketId: string;
  /** Default YES. */
  result?: MarketResult;
  /**
   * The source by its priority (0 the 1차 출처, 1..3 the 대체 출처), its name and address copied
   * from the market's `market_sources` row as the route does unless given — the factory throws
   * when the market has no row at that priority and neither is given (the route's `source`
   * 'unknown'). Null for none. Default: the primary for a YES or NO, none for a VOID.
   */
  source?: { priority: number; name?: string; url?: string } | null;
  /** Default: a sentence for a fallback source (priority 1 or more), null for any other. */
  fallbackReason?: string | null;
  /** Default: a sentence for a VOID, null for a YES or NO. */
  voidReason?: string | null;
  /** Default: one link (https://example.com/evidence), collected a minute before the request. */
  evidence?: { links?: string[]; collectedAt?: Date };
  /** 확인한 내용의 설명: the request's reason. Default: a sentence. */
  description?: string;
  /** The rule version the judgement follows. Default: the market's `rule_version` now. */
  ruleVersion?: number | null;
  /**
   * A 판정 정정's part of the payload (#176, ADR-0105): the version it corrects, the 정정 사유
   * (default a sentence) and the accepted disputes it answers (default none), stored as given —
   * `createCorrectionRequest` fills them as the route does. Default null: a first judgement.
   */
  correction?: { baseVersion: number; reason?: string; disputeIds?: string[] } | null;
  /** The registering admin. Default: a fresh admin. */
  by?: string;
  /** The registration's instant. Default: the database clock. */
  requestedAt?: Date;
  /**
   * A 반려 by another admin instead (`createApprovalRequest`'s decision), a millisecond after the
   * request unless `at` is given. Left out with `retracted`: pending.
   */
  rejected?: { by: string; reason?: string; at?: Date };
  /** The registrant's 철회 instead, a millisecond after the request unless `at` is given. */
  retracted?: { at?: Date };
}

/**
 * A judgement's registration (#152, ADR-0103) as `POST /admin/markets/:id/judgements` leaves it:
 * a `market_judgement` approval request about the market (target `market`, payload `{result,
 * source, fallbackReason, voidReason, evidence, ruleVersion, correction}` —
 * MarketJudgementRequestPayload, the source's name and address copied from the rules, `correction`
 * null unless given (#176) — and the description as its reason), pending, or rejected or retracted
 * as asked. Changes nothing of the market and writes no event, as a first judgement's route; nor
 * its `market_judgement_request` record — a correction's mirror is `createCorrectionRequest`'s.
 * The route's checks are not made (the status, one waiting per market, the setting, the result and
 * source rules, the evidence's instant, a correction's base version and change): a test gives what
 * the route would take, or tests the approval's refusal of it. Stored as given otherwise.
 * `createProvisionalMarket` approves one.
 */
export async function createJudgementRequest(db: Db, input: CreateJudgementRequestInput) {
  const [market] = await db
    .select({ id: markets.id, ruleVersion: markets.ruleVersion })
    .from(markets)
    .where(eq(markets.id, input.marketId));
  if (!market) throw new Error(`createJudgementRequest: market ${input.marketId} not found`);
  const result = input.result ?? 'YES';
  const picked =
    input.source !== undefined ? input.source : result === 'VOID' ? null : { priority: 0 };
  let source: JudgementSource | null = null;
  if (picked !== null) {
    const [row] = await db
      .select()
      .from(marketSources)
      .where(
        and(eq(marketSources.marketId, market.id), eq(marketSources.priority, picked.priority)),
      );
    const name = picked.name ?? row?.name;
    const url = picked.url ?? row?.url;
    if (name === undefined || url === undefined) {
      throw new Error(
        `createJudgementRequest: market ${market.id} has no source at ${String(picked.priority)}`,
      );
    }
    source = { priority: picked.priority, name, url };
  }
  const requestedAt = input.requestedAt ?? (await clockTimestamp(db));
  const payload: MarketJudgementRequestPayload = {
    result,
    source,
    fallbackReason:
      input.fallbackReason !== undefined
        ? input.fallbackReason
        : source !== null && isFallbackSourcePriority(source.priority)
          ? JUDGEMENT_FALLBACK_REASON
          : null,
    voidReason:
      input.voidReason !== undefined
        ? input.voidReason
        : result === 'VOID'
          ? JUDGEMENT_VOID_REASON
          : null,
    evidence: {
      links: input.evidence?.links ?? [JUDGEMENT_EVIDENCE_LINK],
      collectedAt: (
        input.evidence?.collectedAt ?? new Date(requestedAt.getTime() - MINUTE_MS)
      ).toISOString(),
    },
    ruleVersion: input.ruleVersion !== undefined ? input.ruleVersion : market.ruleVersion,
    correction:
      input.correction == null
        ? null
        : {
            baseVersion: input.correction.baseVersion,
            reason: input.correction.reason ?? JUDGEMENT_CORRECTION_REASON,
            disputeIds: input.correction.disputeIds ?? [],
          },
  };
  const by = input.by ?? (await createUser(db, { role: 'admin' })).user.id;
  return createApprovalRequest(db, {
    kind: MARKET_JUDGEMENT_APPROVAL_KIND,
    targetType: 'market',
    targetId: market.id,
    payload: { ...payload },
    requestedBy: by,
    reason: input.description ?? JUDGEMENT_DESCRIPTION,
    requestedAt,
    ...(input.rejected === undefined
      ? {}
      : { decision: { status: 'rejected', ...input.rejected } }),
    ...(input.retracted === undefined ? {} : { retracted: input.retracted }),
  });
}

export interface CreateProvisionalMarketInput extends Omit<
  CreateJudgementRequestInput,
  'marketId' | 'by' | 'requestedAt' | 'rejected' | 'retracted'
> {
  /**
   * A CLOSED market to judge — `closeMarketEarly`'s, or one the worker closed. Default: a market
   * `createMarket` writes CLOSED with `market`'s fields, its close an hour before the publication
   * (no event: the provisional one is its first).
   */
  marketId?: string;
  /** createMarket's fields of the default CLOSED market. Ignored with `marketId`. */
  market?: Omit<
    CreateMarketInput,
    | 'status'
    | 'resolvedResult'
    | 'resolvedAt'
    | 'settledAt'
    | 'statusEventId'
    | 'judgementVersion'
    | 'disputeDeadline'
    | 'settlementSteps'
  >;
  /** The registering admin: the request's requester. Default: a fresh admin. */
  registeredBy?: string;
  /** The approving admin, never the registrant (the factory throws). Default: a fresh admin. */
  approvedBy?: string;
  /** The approval's reason (the request's decision reason). Default: a sentence. */
  approvalReason?: string;
  /**
   * The approval's instant — the publication, the `provisional` event's and `published_at`. The
   * registration is a millisecond before it. Default: the database clock. One more than the window
   * ago gives a market whose deadline has passed, as the worker's confirmation finds it.
   */
  publishedAt?: Date;
  /** The window the approval reads (`market.dispute_window`), in minutes. Default 1,440. */
  disputeWindowMinutes?: number;
  /** Default: true before the market's scheduled judgement (as the route needs), false after. */
  eventDeadlineConfirmed?: boolean;
}

/** A judgement a factory published: the market, the judgement, the request and the event. */
export interface ProvisionalMarket {
  /** The market read back after the approval: `provisional`, its result, version and deadline. */
  market: typeof markets.$inferSelect;
  /** Its `market_judgements` row, version 1 for a first judgement. */
  judgement: MarketJudgementRow;
  /** The `market_judgement` request, approved. */
  request: typeof approvalRequests.$inferSelect;
  /** The `provisional` event's id, the market's `status_event_id`. */
  eventId: number;
}

/**
 * A PROVISIONAL market (#152, ADR-0103) as the routes leave it: a CLOSED market (`marketId`, or
 * a fresh one), its judgement registered by one admin (`createJudgementRequest`, a millisecond
 * before the approval), then in one transaction under the market lock with the row FOR UPDATE that
 * request approved by another admin with a reason, and `approveMarketJudgement` at the approval's
 * instant — the `provisional` event, the market `provisional` with its result, version and dispute
 * deadline (the instant plus the window), and the `market_judgements` row. No admin records and
 * no job (the API's). `approveMarketJudgement`'s checks are made: a market not CLOSED, a rule
 * version moved since the registration, or an early approval left unconfirmed throws.
 */
export async function createProvisionalMarket(
  db: Db,
  input: CreateProvisionalMarketInput = {},
): Promise<ProvisionalMarket> {
  const {
    marketId,
    market: fields,
    registeredBy,
    approvedBy,
    approvalReason,
    publishedAt,
    disputeWindowMinutes,
    eventDeadlineConfirmed,
    ...registration
  } = input;
  const registrant = registeredBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const approver = approvedBy ?? (await createUser(db, { role: 'admin' })).user.id;
  if (approver === registrant) {
    throw new Error('createProvisionalMarket: the registrant never approves the judgement');
  }
  const at = publishedAt ?? (await clockTimestamp(db));
  const id =
    marketId ??
    (
      await createMarket(db, {
        closeAt: new Date(at.getTime() - HOUR_MS),
        ...fields,
        status: 'closed',
      })
    ).id;
  const request = await createJudgementRequest(db, {
    ...registration,
    marketId: id,
    by: registrant,
    requestedAt: new Date(at.getTime() - 1),
  });
  return db.transaction(async (tx) => {
    await lockMarket(tx, id);
    const [current] = await tx.select().from(markets).where(eq(markets.id, id)).for('update');
    if (!current) throw new Error(`createProvisionalMarket: market ${id} not found`);
    const [approved] = await tx
      .update(approvalRequests)
      .set({
        status: 'approved',
        decidedBy: approver,
        decisionReason: approvalReason ?? JUDGEMENT_APPROVAL_REASON,
        decidedAt: at,
      })
      .where(eq(approvalRequests.id, request.id))
      .returning();
    const result = await approveMarketJudgement(tx, {
      market: current,
      request: approved!,
      now: at,
      approverId: approver,
      eventDeadlineConfirmed:
        eventDeadlineConfirmed ??
        isBeforeScheduledJudgement(current.scheduledJudgementAt, at.getTime()),
      disputeWindowMinutes: disputeWindowMinutes ?? JUDGEMENT_DISPUTE_WINDOW_MINUTES,
    });
    if (!result.published) {
      throw new Error(
        `createProvisionalMarket: the judgement was not published (${result.reason})`,
      );
    }
    return {
      market: result.market,
      judgement: result.judgement,
      request: approved!,
      eventId: result.eventId,
    };
  });
}

export interface CreateCorrectionRequestInput extends Omit<
  CreateJudgementRequestInput,
  'correction' | 'rejected' | 'retracted'
> {
  /**
   * A PROVISIONAL market with its judgement — `createProvisionalMarket`'s, or
   * `createCorrectedMarket`'s for a second correction.
   */
  marketId: string;
  /** The version corrected. Default: the market's current `judgement_version`. */
  baseVersion?: number;
  /** 정정 사유. Default: a sentence. */
  reason?: string;
  /**
   * The accepted disputes it answers. Default: every `accepted` dispute of the base version, the
   * oldest submission first, as the route lists them.
   */
  disputeIds?: string[];
}

/**
 * A 판정 정정's registration (#176, ADR-0105) as `POST /admin/markets/:id/judgements` with its
 * `correction` leaves it: a pending `market_judgement` request about the market whose payload's
 * `correction` is `{baseVersion, reason, disputeIds}` — the base version the market's current one
 * and the disputes its accepted ones unless given (`createJudgementRequest` writes the rest, its
 * defaults included: a YES on the primary source unless told) — and then, in one transaction under
 * the market lock, `markets.correction_pending` true at the registration's instant
 * (`setCorrectionPending`), so the market reads '판정 지연' past its deadline. No admin record.
 * The route's checks are not made (the status, one waiting per market, the base version, the
 * change): a market that is not PROVISIONAL fails on the mirror
 * (`markets_correction_pending_status_check`) after the request is written — a test of an
 * approval's refusal there writes one with `createJudgementRequest`'s `correction` instead.
 */
export async function createCorrectionRequest(db: Db, input: CreateCorrectionRequestInput) {
  const { baseVersion, reason, disputeIds, ...registration } = input;
  const [market] = await db
    .select({ judgementVersion: markets.judgementVersion })
    .from(markets)
    .where(eq(markets.id, input.marketId));
  const base = baseVersion ?? market?.judgementVersion;
  if (base == null) {
    throw new Error(`createCorrectionRequest: market ${input.marketId} has no judgement`);
  }
  const answered =
    disputeIds ??
    (
      await db
        .select({ id: marketDisputes.id })
        .from(marketDisputes)
        .where(
          and(
            eq(marketDisputes.marketId, input.marketId),
            eq(marketDisputes.judgementVersion, base),
            eq(marketDisputes.status, 'accepted'),
          ),
        )
        .orderBy(marketDisputes.submittedAt, marketDisputes.id)
    ).map((row) => row.id);
  const request = await createJudgementRequest(db, {
    ...registration,
    correction: { baseVersion: base, disputeIds: answered, ...(reason ? { reason } : {}) },
  });
  await db.transaction(async (tx) => {
    await lockMarket(tx, input.marketId);
    await setCorrectionPending(tx, {
      marketId: input.marketId,
      pending: true,
      now: request.requestedAt,
    });
  });
  return request;
}

export interface CreateCorrectedMarketInput extends Omit<
  CreateCorrectionRequestInput,
  'marketId' | 'baseVersion' | 'by' | 'requestedAt'
> {
  /**
   * A PROVISIONAL market to correct, its current version the base — `createProvisionalMarket`'s,
   * or this factory's for a second correction. Default: a fresh `createProvisionalMarket` one made
   * with `provisional`.
   */
  marketId?: string;
  /** createProvisionalMarket's input for the default market. Ignored with `marketId`. */
  provisional?: CreateProvisionalMarketInput;
  /**
   * The new version's result. Default: the base version's other one — YES for a NO and NO for a
   * YES — and VOID for a VOID (its grounds then differ by the evidence's instant).
   */
  result?: MarketResult;
  /** The correction's registrant. Default: a fresh admin. */
  registeredBy?: string;
  /** The approving admin, never the registrant (the factory throws). Default: a fresh admin. */
  approvedBy?: string;
  /** The approval's reason. Default: a sentence. */
  approvalReason?: string;
  /**
   * The approval's instant — the new version's publication, its event's and its deadline's start.
   * The registration is a millisecond before it. Default: the database clock.
   */
  correctedAt?: Date;
  /** Default: true before the market's scheduled judgement (as the route needs), false after. */
  eventDeadlineConfirmed?: boolean;
}

/** A correction a factory approved: the market, both versions, the request, the event. */
export interface CorrectedMarket {
  /** The market the correction left: PROVISIONAL, the new result, version and deadline. */
  market: typeof markets.$inferSelect;
  /** The new version's `market_judgements` row, the market's current one. */
  judgement: MarketJudgementRow;
  /** The version it replaced, as it was published. */
  previous: MarketJudgementRow;
  /** The correction's `market_judgement` request, approved. */
  request: typeof approvalRequests.$inferSelect;
  /** The `judgement_corrected` event's id, the market's `status_event_id`. */
  eventId: number;
  /** The base version's pending disputes closed as 정정으로 종결. */
  closedDisputes: MarketDisputeRow[];
}

/**
 * A corrected PROVISIONAL market (#176, ADR-0105) as the routes leave it: a PROVISIONAL market
 * (`marketId`, or a fresh `createProvisionalMarket` one), a correction of its current version
 * registered by one admin (`createCorrectionRequest`, a millisecond before the approval, its
 * accepted disputes answered), then in one transaction under the market lock with the row FOR
 * UPDATE that request approved by another admin with a reason, and `correctMarketJudgement` at the
 * approval's instant — the base version's pending disputes closed, the `judgement_corrected`
 * event, the next `market_judgements` row (the base version's window, the deadline from the
 * approval), and the market at the new version with its mirrors reset. No admin records and no job
 * (the API's). `correctMarketJudgement`'s checks are made: a market not PROVISIONAL throws.
 */
export async function createCorrectedMarket(
  db: Db,
  input: CreateCorrectedMarketInput = {},
): Promise<CorrectedMarket> {
  const {
    marketId,
    provisional,
    registeredBy,
    approvedBy,
    approvalReason,
    correctedAt,
    eventDeadlineConfirmed,
    ...registration
  } = input;
  const registrant = registeredBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const approver = approvedBy ?? (await createUser(db, { role: 'admin' })).user.id;
  if (approver === registrant) {
    throw new Error('createCorrectedMarket: the registrant never approves the correction');
  }
  const id = marketId ?? (await createProvisionalMarket(db, provisional)).market.id;
  const at = correctedAt ?? (await clockTimestamp(db));
  const [base] = await db
    .select({ resolvedResult: markets.resolvedResult })
    .from(markets)
    .where(eq(markets.id, id));
  const flipped: Record<MarketResult, MarketResult> = { YES: 'NO', NO: 'YES', VOID: 'VOID' };
  const request = await createCorrectionRequest(db, {
    ...registration,
    result: registration.result ?? flipped[base?.resolvedResult ?? 'NO'],
    marketId: id,
    by: registrant,
    requestedAt: new Date(at.getTime() - 1),
  });
  return db.transaction(async (tx) => {
    await lockMarket(tx, id);
    const [current] = await tx.select().from(markets).where(eq(markets.id, id)).for('update');
    if (!current) throw new Error(`createCorrectedMarket: market ${id} not found`);
    const [approved] = await tx
      .update(approvalRequests)
      .set({
        status: 'approved',
        decidedBy: approver,
        decisionReason: approvalReason ?? JUDGEMENT_APPROVAL_REASON,
        decidedAt: at,
      })
      .where(eq(approvalRequests.id, request.id))
      .returning();
    const result = await correctMarketJudgement(tx, {
      market: current,
      request: approved!,
      now: at,
      approverId: approver,
      eventDeadlineConfirmed:
        eventDeadlineConfirmed ??
        isBeforeScheduledJudgement(current.scheduledJudgementAt, at.getTime()),
    });
    if (!result.corrected) {
      throw new Error(`createCorrectedMarket: the correction was not made (${result.reason})`);
    }
    return {
      market: result.market,
      judgement: result.judgement,
      previous: result.previous,
      request: approved!,
      eventId: result.eventId,
      closedDisputes: result.closedDisputes,
    };
  });
}

/**
 * The worker's confirmation (#152, ADR-0103) of a PROVISIONAL market, now: in one transaction
 * under the market lock, `resolveProvisionalMarket` at the database clock (or `at`) — the
 * `resolved` event (no actor, payload `{version, result, source: 'deadline'}`), the market
 * `resolved` with `resolved_at`, and the pending settlement steps — for an API or worker test that
 * needs a RESOLVED market with its history (`createProvisionalMarket`'s, or a `provisional` one of
 * `createMarket`). A deadline still ahead is first brought to that instant on the market
 * (`markets.dispute_deadline`); the judgement row keeps the one its approval fixed — it takes no
 * UPDATE — so a test that wants the two to agree publishes early enough that the deadline has
 * passed (`createProvisionalMarket`'s `publishedAt`), and then nothing moves. No job, no publish
 * (the worker's): `market.finalize` is the test's to run. A market not PROVISIONAL throws, and so
 * does one that is held (`confirmationHold`): a 판정 이의 pending or accepted (#175), or a waiting
 * correction (#176) — before anything moves: a test decides or retracts them first
 * (`decideMarketDispute`, `createDispute`'s `status`, the request's 반려).
 */
export async function resolveMarketNow(
  db: Db,
  marketId: string,
  input: { at?: Date } = {},
): Promise<{ market: typeof markets.$inferSelect; eventId: number }> {
  return db.transaction(async (tx) => {
    await lockMarket(tx, marketId);
    const now = input.at ?? (await clockTimestamp(tx));
    const [current] = await tx.select().from(markets).where(eq(markets.id, marketId));
    if (current && (await confirmationHold(tx, current))) {
      throw new Error(
        `resolveMarketNow: market ${marketId} is held by a 판정 이의 pending or accepted, or by ` +
          'a correction waiting (decide or retract them first)',
      );
    }
    await tx
      .update(markets)
      .set({ disputeDeadline: now })
      .where(
        and(
          eq(markets.id, marketId),
          eq(markets.status, 'provisional'),
          gt(markets.disputeDeadline, now),
        ),
      );
    const result = await resolveProvisionalMarket(tx, { marketId, now });
    if (!result.resolved) {
      throw new Error(`resolveMarketNow: market ${marketId} was not confirmed (${result.reason})`);
    }
    return { market: result.market, eventId: result.eventId };
  });
}

/** createDispute's defaults: one evidence link and a reason, as a member writes them. */
const DISPUTE_LINK = 'https://example.com/dispute-evidence';
const DISPUTE_REASON = '발표 원문과 판정 결과가 다르다.';
const DISPUTE_DECISION_REASON = '판정의 근거를 다시 확인했다.';

export interface CreateDisputeInput {
  /**
   * A PROVISIONAL market with its judgement — `createProvisionalMarket`'s (the dispute's foreign
   * key names the `market_judgements` row, which `createMarket` never writes). Default: a fresh
   * one made with `market`.
   */
  marketId?: string;
  /** createProvisionalMarket's input for the default market. Ignored with `marketId`. */
  market?: CreateProvisionalMarketInput;
  /** The version disputed. Default: the market's current `judgement_version`. */
  judgementVersion?: number;
  /** The submitter. Default: a fresh member. */
  userId?: string;
  /**
   * The submitter's fill on the market (`createFill`, as the taker against a fresh account's
   * resting order), as eligibility asks (`hasMarketFill`). Default true; false writes none — a
   * submitter who already has one, or a test of the refusal.
   */
  fill?: boolean;
  /** 근거 링크. Default: one (https://example.com/dispute-evidence). */
  links?: string[];
  /** Default: a sentence. */
  reason?: string;
  /** Default `pending`. */
  status?: MarketDisputeStatus;
  /** The submission's instant. Default: the database clock. */
  submittedAt?: Date;
  /**
   * For `dismissed` and `accepted`: the deciding admin (default a fresh one), when (a millisecond
   * after the submission unless given) and why (default a sentence).
   */
  decidedBy?: string;
  decidedAt?: Date;
  decisionReason?: string;
  /** For `retracted`: when. Default a millisecond after the submission. */
  retractedAt?: Date;
  /**
   * For `closed_by_correction` (#176): when the correction's approval closed it. Default a
   * millisecond after the submission. The version is left as it is: a test of one closed by a real
   * correction uses `createCorrectedMarket`.
   */
  closedAt?: Date;
}

/** A dispute a factory wrote: the row, its market read back, and the submitter's fill. */
export interface DisputeMade {
  dispute: MarketDisputeRow;
  /** The market read back after the write, its `dispute_hold_count` kept. */
  market: typeof markets.$inferSelect;
  /** The fill written for the submitter; null with `fill: false`. */
  fill: FillRow | null;
}

/**
 * A 판정 이의 (#175, ADR-0104) as the routes leave it, in any status: on a PROVISIONAL market's
 * judgement (`marketId`, or a fresh `createProvisionalMarket` one), by a member with a fill on it
 * (`createFill` unless `fill: false`), and in one transaction under the market lock the
 * `market_disputes` row — pending, or dismissed or accepted by an admin with a reason, or
 * retracted, or closed by a correction (#176), as asked — and `markets.dispute_hold_count` one
 * more for a pending or accepted dispute of the market's current version, as the dispute writers
 * keep it. The routes' checks are not made (the status, the deadline, the role, the one per
 * version; the decider's not being the registrant): a test gives what a route would take — a
 * dispute submitted before a deadline that has since passed included — or tests the helpers'
 * refusals with `submitMarketDispute`. The database's are (the CHECKs, the keys, the foreign key
 * to the judgement).
 */
export async function createDispute(db: Db, input: CreateDisputeInput = {}): Promise<DisputeMade> {
  const marketId = input.marketId ?? (await createProvisionalMarket(db, input.market)).market.id;
  const userId = input.userId ?? (await createUser(db)).user.id;
  const fill =
    input.fill === false ? null : await createFill(db, { marketId, userId, amountCoin: 50n });
  const status = input.status ?? 'pending';
  const decided = status === 'dismissed' || status === 'accepted';
  const decidedBy = decided
    ? (input.decidedBy ?? (await createUser(db, { role: 'admin' })).user.id)
    : null;
  return db.transaction(async (tx) => {
    await lockMarket(tx, marketId);
    const [market] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update');
    if (!market) throw new Error(`createDispute: market ${marketId} not found`);
    const version = input.judgementVersion ?? market.judgementVersion;
    if (version === null) throw new Error(`createDispute: market ${marketId} has no judgement`);
    const submittedAt = input.submittedAt ?? (await clockTimestamp(tx));
    const later = new Date(submittedAt.getTime() + 1);
    const [dispute] = await tx
      .insert(marketDisputes)
      .values({
        marketId,
        judgementVersion: version,
        userId,
        links: input.links ?? [DISPUTE_LINK],
        reason: input.reason ?? DISPUTE_REASON,
        status,
        submittedAt,
        decidedBy,
        decidedAt: decided ? (input.decidedAt ?? later) : null,
        decisionReason: decided ? (input.decisionReason ?? DISPUTE_DECISION_REASON) : null,
        retractedAt: status === 'retracted' ? (input.retractedAt ?? later) : null,
        closedAt: status === 'closed_by_correction' ? (input.closedAt ?? later) : null,
      })
      .returning();
    const holds = isHoldingDisputeStatus(status) && version === market.judgementVersion;
    const [row] = holds
      ? await tx
          .update(markets)
          .set({ disputeHoldCount: sql`${markets.disputeHoldCount} + 1`, updatedAt: submittedAt })
          .where(eq(markets.id, marketId))
          .returning()
      : [market];
    return { dispute: dispute!, market: row!, fill };
  });
}

/** The 지연 사유 a delay record factory writes unless given (one public sentence, #142). */
const JUDGEMENT_DELAY_REASON = '1차 출처의 발표가 늦어져 판정을 미룬다.';

export interface CreateJudgementDelayInput {
  /**
   * A market that reads '판정 지연' at `recordedAt`: a CLOSED one past its scheduled judgement
   * (`createMarket`'s with `status: 'closed'` and a past `scheduledJudgementAt`), or a PROVISIONAL
   * one past its 이의 기한 that a 판정 이의 or a waiting correction holds (`createDispute`'s,
   * `createCorrectionRequest`'s on `createProvisionalMarket`'s market) — `recordJudgementDelay`
   * throws for any other, as the route refuses it.
   */
  marketId: string;
  /** 지연 사유. Default: a sentence. Stored as given (the database holds 1–500, trimmed). */
  reason?: string;
  /** 다음 검토 시각. Default: a day after the record. */
  nextReviewAt?: Date;
  /** The recording admin. Default: a fresh admin. */
  by?: string;
  /**
   * The record's instant — its `recorded_at`, its event's `created_at`, and the clock the market
   * and the next review time are judged on. Default: the database clock. An earlier one backdates
   * the record (the bound CHECK is relative to it): a record whose next review time has passed.
   */
  recordedAt?: Date;
}

/** A delay record a factory made: the row and its `judgement_delay_recorded` event. */
export interface JudgementDelayMade {
  delay: MarketJudgementDelayRow;
  /** The event's id; the market's `status_event_id` does not move. */
  eventId: number;
}

/**
 * A 판정 지연 기록 (#142, ADR-0106) as `POST /admin/markets/:id/judgement-delays` leaves it, at
 * `recordedAt` or now: `recordJudgementDelay` in one transaction under the market lock, with the
 * row read FOR UPDATE — the `judgement_delay_recorded` event (actor `by`, payload `{delayId,
 * reason, nextReviewAt, marketStatus, judgementVersion}`) and its `market_judgement_delays` row
 * on the market's status and version; nothing of the market changes. No `market_delay_record`
 * record, as no factory writes a route's. The route's checks are the writer's: a market that does
 * not read '판정 지연' at the instant, or a next review time not after it or more than
 * JUDGEMENT_DELAY_REVIEW_MAX_DAYS × 24 hours later, throws.
 */
export async function createJudgementDelay(
  db: Db,
  input: CreateJudgementDelayInput,
): Promise<JudgementDelayMade> {
  const by = input.by ?? (await createUser(db, { role: 'admin' })).user.id;
  return db.transaction(async (tx) => {
    await lockMarket(tx, input.marketId);
    const [current] = await tx
      .select()
      .from(markets)
      .where(eq(markets.id, input.marketId))
      .for('update');
    if (!current) throw new Error(`createJudgementDelay: market ${input.marketId} not found`);
    const now = input.recordedAt ?? (await clockTimestamp(tx));
    return recordJudgementDelay(tx, {
      market: current,
      reason: input.reason ?? JUDGEMENT_DELAY_REASON,
      nextReviewAt: input.nextReviewAt ?? new Date(now.getTime() + DAY_MS),
      recordedBy: by,
      now,
    });
  });
}

export interface CreateReportInput {
  reporterId: string;
  /** The member reported: the item's author, the profile's member. */
  reportedUserId: string;
  /** A post's report. */
  postId?: string;
  /** A comment's report. Neither: a profile's. */
  commentId?: string;
  /** Default: a random hash, so two reports never share a number. */
  reporterPhoneHash?: string;
  /** Default: `spam`. */
  reason?: ReportReason;
  /** Default: none (an `other` needs one). */
  description?: string | null;
  /** Default: the database clock. */
  createdAt?: Date;
  /** Default: `pending`. A processed one needs `resolvedBy`, and `actionId` or `dismissalReason`. */
  status?: ReportStatus;
  resolvedAt?: Date;
  resolvedBy?: string;
  actionId?: string;
  dismissalReason?: string;
}

/**
 * A report (#50) as `POST …/reports` leaves it, or, with the processing, as an operator left it.
 * Checks nothing the API checks (the onboarding, the target's state, the daily limit); the
 * database holds the shape, one pending report per account and target, and nobody reporting
 * themselves.
 */
export async function createReport(db: Db, input: CreateReportInput) {
  const targetType = input.postId ? 'post' : input.commentId ? 'comment' : 'profile';
  const status = input.status ?? 'pending';
  const [report] = await db
    .insert(reports)
    .values({
      targetType,
      postId: input.postId ?? null,
      commentId: input.commentId ?? null,
      reportedUserId: input.reportedUserId,
      reporterId: input.reporterId,
      reporterPhoneHash: input.reporterPhoneHash ?? randomPhoneHash(),
      reason: input.reason ?? 'spam',
      description: input.description ?? null,
      status,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      ...(status === 'pending'
        ? {}
        : {
            resolvedAt: input.resolvedAt ?? new Date(),
            resolvedBy: input.resolvedBy ?? null,
            actionId: input.actionId ?? null,
            dismissalReason: input.dismissalReason ?? null,
          }),
    })
    .returning();
  return report!;
}

export interface CreateWriteLimitEventInput {
  /** The writer's number as its keyed hash (64 lower-case hex). Default: a random one. */
  phoneHash?: string;
  action: WriteLimitAction;
  /** Default: the database clock. A window test sets an earlier time. */
  createdAt?: Date;
}

/**
 * A write the limits count (#187, ADR-0083), as the API's WriteLimitsService leaves it: the
 * `write_limit_events` row only — no post, comment or image behind it, which the limits never read.
 * For a test that needs a number's earlier writes, at the times it names.
 */
export async function createWriteLimitEvent(db: Db, input: CreateWriteLimitEventInput) {
  const [row] = await db
    .insert(writeLimitEvents)
    .values({
      phoneHash: input.phoneHash ?? randomPhoneHash(),
      action: input.action,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning();
  return row!;
}

export interface CreateLinkUseInput {
  /** The link in `normaliseLink`'s form; stored as given. */
  url: string;
  phoneHash?: string;
  /** Exactly one of the two: the post or the comment that took the link. */
  postId?: string;
  commentId?: string;
  /** Default: now. */
  usedAt?: Date;
}

/** A link a post or a comment took (#187), as the API's LinkReviewService records it. */
export async function createLinkUse(db: Db, input: CreateLinkUseInput) {
  const [row] = await db
    .insert(linkUses)
    .values({
      url: input.url,
      phoneHash: input.phoneHash ?? randomPhoneHash(),
      postId: input.postId ?? null,
      commentId: input.commentId ?? null,
      usedAt: input.usedAt ?? new Date(),
    })
    .returning();
  return row!;
}

export interface CreateLinkFlagInput {
  url: string;
  reason: LinkFlagReason;
  postId?: string;
  commentId?: string;
  /** Default: the database clock. */
  flaggedAt?: Date;
  /** The operator's mark that covered it (an admin_actions row); default none. */
  reviewActionId?: string;
}

/** An entry of the repeated-link review list (#187), as the API's LinkReviewService writes one. */
export async function createLinkFlag(db: Db, input: CreateLinkFlagInput) {
  const [row] = await db
    .insert(linkFlags)
    .values({
      url: input.url,
      reason: input.reason,
      postId: input.postId ?? null,
      commentId: input.commentId ?? null,
      reviewActionId: input.reviewActionId ?? null,
      ...(input.flaggedAt === undefined ? {} : { flaggedAt: input.flaggedAt }),
    })
    .returning();
  return row!;
}

/**
 * A member's closure of the account (#140) as the API's AccountClosureService leaves it, in one
 * transaction — for a test whose subject needs a closed account rather than the closure itself
 * (a read, an audit): a waiting start grant cancelled (its numbers freed by migration 0031's
 * trigger), the Coin left forfeited by a CLOSURE_FORFEIT entry, the nickname held unlinked and the
 * holds naming the account unlinked, the profile closed without its public items, the interest
 * categories, the profile image's row with its object's key queued for removal (`media_deletions`;
 * the object is the test's store's), the time zone, the 본인확인 record, the watchlist (each
 * watch's unwatch event written), the search history, the sessions, sign-in methods and reset
 * tokens gone, the address replaced and the name and photo emptied, and the account restriction
 * requests about the member still waiting rejected by no admin, '탈퇴'. Returns the closure's
 * instant. Throws where migration 0043 would refuse the commit (Coin reserved, say).
 */
export async function closeAccount(db: Db, userId: string): Promise<Date> {
  return db.transaction(async (tx) => {
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .for('update');
    if (!profile?.nickname) throw new Error(`closeAccount: ${userId} is not an open account`);
    const closedAt = (await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`))
      .rows[0]!.now;
    const at = new Date(closedAt);
    await tx
      .update(startGrants)
      .set({ cancelledAt: at })
      .where(
        and(
          eq(startGrants.userId, userId),
          sql`${startGrants.grantedAt} IS NULL AND ${startGrants.cancelledAt} IS NULL`,
        ),
      );
    const [held] = await lockLedgerAccounts(tx, [{ kind: 'user', userId }]);
    const balance = held!.balance;
    if (balance.availableCoin > 0n) {
      await recordLedgerEntry(tx, {
        type: 'CLOSURE_FORFEIT',
        amountCoin: balance.availableCoin,
        from: { kind: 'user', userId },
        to: null,
        refType: 'account_closure',
        refId: userId,
        idempotencyKey: ledgerKeys.closure(userId),
        at,
      });
    }
    await tx.update(nicknameHolds).set({ userId: null }).where(eq(nicknameHolds.userId, userId));
    await tx
      .insert(nicknameHolds)
      .values({ nickname: profile.nickname, userId: null, releasedAt: at });
    await tx
      .update(profiles)
      .set({ closedAt: at, nickname: null, bio: null, imageId: null, timeZone: null })
      .where(eq(profiles.userId, userId));
    await tx.delete(profileInterestCategories).where(eq(profileInterestCategories.userId, userId));
    if (profile.imageId !== null) {
      const [image] = await tx
        .delete(mediaObjects)
        .where(eq(mediaObjects.id, profile.imageId))
        .returning({ storageKey: mediaObjects.storageKey });
      // Its object's key queued with the row's deletion (#46's queue), as the API's closure does.
      if (image) {
        await tx
          .insert(mediaDeletions)
          .values({
            storageKey: image.storageKey,
            nextAttemptAt: sql`now() + make_interval(hours => ${orphanMediaRetryHours(1)}, mins => ${-ORPHAN_MEDIA_RETRY_SLACK_MINUTES})`,
          })
          .onConflictDoNothing({ target: mediaDeletions.storageKey });
      }
    }
    await tx.delete(phoneVerifications).where(eq(phoneVerifications.userId, userId));
    const unwatched = await tx
      .delete(marketWatches)
      .where(eq(marketWatches.userId, userId))
      .returning({ marketId: marketWatches.marketId });
    if (unwatched.length > 0) {
      await tx
        .insert(marketWatchEvents)
        .values(
          unwatched.map(({ marketId }) => ({ userId, marketId, action: 'unwatch', createdAt: at })),
        );
    }
    await tx.delete(marketSearches).where(eq(marketSearches.userId, userId));
    await tx.delete(session).where(eq(session.userId, userId));
    await tx.delete(account).where(eq(account.userId, userId));
    await tx.delete(verification).where(eq(verification.value, userId));
    await tx
      .update(user)
      .set({
        email: closedAccountEmail(userId),
        emailVerified: false,
        name: AUTH_USER_NAME,
        image: null,
      })
      .where(eq(user.id, userId));
    const actions = tx
      .select({ id: sql<string>`${moderationActions.id}::text` })
      .from(moderationActions)
      .where(eq(moderationActions.userId, userId));
    await tx
      .update(approvalRequests)
      .set({
        status: 'rejected',
        decisionReason: ACCOUNT_CLOSURE_DECISION_REASON,
        decidedAt: sql`greatest(${at}::timestamptz, ${approvalRequests.requestedAt} + interval '1 millisecond')`,
      })
      .where(
        and(
          eq(approvalRequests.status, 'pending'),
          sql`((${approvalRequests.kind} = 'account_restriction' AND ${approvalRequests.targetType} = 'user' AND ${approvalRequests.targetId} = ${userId})
            OR (${approvalRequests.kind} IN ('account_restriction_shorten', 'account_restriction_lift', 'account_restriction_cancel')
                AND ${approvalRequests.targetType} = 'moderation_action'
                AND ${approvalRequests.targetId} IN (${actions})))`,
        ),
      );
    return at;
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Korea keeps no daylight saving: a Korean date is the UTC date nine hours on. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** The Korean date `days` from today, `YYYY-MM-DD`, as a theme's period stores it. */
export function koreanDateFromToday(days: number): string {
  return new Date(Date.now() + KST_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10);
}

export interface CreateThemeInput {
  /** The admin who made it. A fresh admin is created when omitted. */
  createdBy?: string;
  /** Default: `theme-<tag>`, unique. */
  slug?: string;
  name?: string;
  intro?: string;
  /** A Korean date, `YYYY-MM-DD`. Default: yesterday — 진행 중 with the default end. */
  startDate?: string;
  /** Default: a week from today (KST). */
  endDate?: string;
  /** When it was made public; default null, an unpublished theme as `POST /admin/themes` leaves it. */
  publishedAt?: Date | null;
  /** Default: `publishedAt` — a published theme has been published once at least. */
  firstPublishedAt?: Date | null;
  createdAt?: Date;
}

/**
 * A theme (#81) as `POST /admin/themes` leaves the `themes` row — and only the row: no
 * `admin_actions` row, which the API writes beside it. Unpublished unless `publishedAt` is given.
 */
export async function createTheme(db: Db, input: CreateThemeInput = {}) {
  const t = tag();
  const createdBy = input.createdBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const publishedAt = input.publishedAt ?? null;
  const [row] = await db
    .insert(themes)
    .values({
      slug: input.slug ?? `theme-${t}`,
      name: input.name ?? `테스트 테마 ${t}`,
      intro: input.intro ?? '테스트용 테마 소개.',
      startDate: input.startDate ?? koreanDateFromToday(-1),
      endDate: input.endDate ?? koreanDateFromToday(7),
      publishedAt,
      firstPublishedAt: input.firstPublishedAt === undefined ? publishedAt : input.firstPublishedAt,
      createdBy,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning();
  return row!;
}

export interface CreateThemeMarketInput {
  themeId: string;
  marketId: string;
  /** The admin who put it in. A fresh admin is created when omitted. */
  createdBy?: string;
  /** Default: the database clock. */
  createdAt?: Date;
}

/** A market put in a theme (#81): the `theme_markets` row alone, no `admin_actions` row. */
export async function createThemeMarket(db: Db, input: CreateThemeMarketInput) {
  const createdBy = input.createdBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const [row] = await db
    .insert(themeMarkets)
    .values({
      themeId: input.themeId,
      marketId: input.marketId,
      createdBy,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning();
  return row!;
}

export interface CreateThemeNoticeInput {
  themeId: string;
  createdBy?: string;
  title?: string;
  body?: string;
  createdAt?: Date;
  editedAt?: Date | null;
  hiddenAt?: Date | null;
}

/** A theme notice (#81): the `theme_notices` row alone, shown unless `hiddenAt` is given. */
export async function createThemeNotice(db: Db, input: CreateThemeNoticeInput) {
  const t = tag();
  const createdBy = input.createdBy ?? (await createUser(db, { role: 'admin' })).user.id;
  const [row] = await db
    .insert(themeNotices)
    .values({
      themeId: input.themeId,
      title: input.title ?? `테스트 공지 ${t}`,
      body: input.body ?? '테스트용 공지 내용.',
      createdBy,
      editedAt: input.editedAt ?? null,
      hiddenAt: input.hiddenAt ?? null,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning();
  return row!;
}

export interface CreateProposalInput {
  /** The proposer. */
  userId: string;
  /**
   * The keyed hash of the proposer's number (64 lower-case hex). Default: a random one; a test of
   * the limits passes the API's hash of the account's verified number (PhoneHasher).
   */
  phoneHash?: string;
  question?: string;
  /** `YYYY-MM-DD`. Default: 30 days from now (UTC date). */
  deadline?: string;
  yesCondition?: string;
  expectedSources?: string;
  background?: string | null;
  categoryId?: number | null;
  /** Default: the database clock. A limit or order test sets it. */
  createdAt?: Date;
  /** Where to move it, as the API's steps would (default `submitted`). */
  status?: ProposalStatus;
  /** The operator of the review and the decision. A fresh admin is created when one is needed. */
  adminId?: string;
  /**
   * When each move happened (default: the time of the step's UPDATE). A test that tells the
   * moves' times apart sets them; only the ones the moves to `status` write are used.
   */
  reviewStartedAt?: Date;
  decidedAt?: Date;
  retractedAt?: Date;
  /** A 반려 straight from 접수 (no review start) instead of after a review. Default: false. */
  rejectUnreviewed?: boolean;
  rejectionReason?: ProposalRejectionReason;
  rejectionExplanation?: string;
  /** Required with `rejectionReason: 'duplicate'`. */
  duplicateMarketId?: string;
  adoptionMemo?: string | null;
  /** The market a 채택 led to. */
  marketId?: string | null;
  internalMemo?: string | null;
}

/**
 * A market proposal (#77) as the API's steps leave it: inserted 접수, then moved along the owner's
 * steps to `status` — 검토 for 채택 (and for 반려 unless `rejectUnreviewed`), then the decision, or
 * 철회 — one UPDATE per step, which the table's trigger holds to those steps (migration 0046). Only
 * the row: no `admin_actions` rows, which the API writes beside each move.
 */
export async function createProposal(db: Db, input: CreateProposalInput) {
  const status = input.status ?? 'submitted';
  const deadline =
    input.deadline ?? new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const [inserted] = await db
    .insert(marketProposals)
    .values({
      userId: input.userId,
      phoneHash: input.phoneHash ?? randomPhoneHash(),
      question: input.question ?? `제안 ${tag()}`,
      deadline,
      yesCondition: input.yesCondition ?? '공식 발표에서 그렇다고 하면 YES',
      expectedSources: input.expectedSources ?? '공식 발표',
      background: input.background ?? null,
      categoryId: input.categoryId ?? null,
      internalMemo: input.internalMemo ?? null,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    .returning();
  let row = inserted!;
  if (status === 'submitted') return row;
  const move = async (values: Partial<typeof marketProposals.$inferInsert>) => {
    const [moved] = await db
      .update(marketProposals)
      .set(values)
      .where(eq(marketProposals.id, row.id))
      .returning();
    row = moved!;
  };
  if (status === 'retracted') {
    await move({ status, retractedAt: input.retractedAt ?? new Date() });
    return row;
  }
  const adminId = input.adminId ?? (await createUser(db, { role: 'admin' })).user.id;
  if (status !== 'rejected' || !input.rejectUnreviewed) {
    await move({
      status: 'reviewing',
      reviewStartedAt: input.reviewStartedAt ?? new Date(),
      reviewStartedBy: adminId,
    });
  }
  if (status === 'adopted') {
    await move({
      status,
      decidedAt: input.decidedAt ?? new Date(),
      decidedBy: adminId,
      adoptionMemo: input.adoptionMemo ?? null,
      marketId: input.marketId ?? null,
    });
  } else if (status === 'rejected') {
    const reason = input.rejectionReason ?? 'other';
    await move({
      status,
      decidedAt: input.decidedAt ?? new Date(),
      decidedBy: adminId,
      rejectionReason: reason,
      rejectionExplanation: input.rejectionExplanation ?? '사유 설명',
      duplicateMarketId: reason === 'duplicate' ? (input.duplicateMarketId ?? null) : null,
    });
  }
  return row;
}
