import { Inject, Injectable } from '@nestjs/common';
import {
  decideMarketDispute,
  lockAdminRoles,
  readAdminDisputes,
  readMyDisputes,
  readMyMarketDispute,
  retractMarketDispute,
  schema,
  submitMarketDispute,
  type Db,
  type DisputeMarketRef,
  type MarketDisputeRow,
} from '@buddha/db';
import {
  MARKET_DISPUTE_DECISION_ACTION_TYPES,
  decodeKeyset,
  disputeDecisionRefusal,
  encodeKeyset,
  isPublicMarketStatus,
  type AdminDisputeListQuery,
  type AdminDisputeQueueItem,
  type AdminMarket,
  type CursorQuery,
  type DecideDisputeBody,
  type MarketDisputeDecision,
  type MarketDisputeDecisionActionPayload,
  type MyDispute,
  type MyMarketDispute,
  type SubmitDisputeBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketJobs } from '../jobs/market-jobs.service.js';
import { assertOnboarded } from '../onboarding/onboarded.guard.js';
import { type Page } from '../wallet/wallet.service.js';
import { MarketAdminService, publishedStatusOf } from './market-admin.service.js';
import { disputeNotAllowed, toAdminDisputeQueueItem, toMyDispute } from './market-dispute.js';
import { lockedMarketRow, type Tx } from './market-item-rules.js';
import { lockMarket } from './market-lock.js';
import { readMarketSources } from './market-sources.js';
import { isPublicMarket, marketTagNames, type MarketRow } from './market.service.js';

const { marketDisputes, marketJudgements, markets, profiles } = schema;

const notFound = (what: 'Market' | 'Dispute') =>
  new AppError('NOT_FOUND', { message: `${what} not found` });

const marketRefOf = (row: MarketRow): DisputeMarketRef => ({
  id: row.id,
  slug: row.slug,
  title: row.title,
  status: row.status,
});

/**
 * 판정 이의 (#175, ADR-0104; ADR-0093 decision 1 #173 items 1·2·5–8·13·15, the owner's answers of
 * 2026-11-02 and 2026-11-03; market-dispute.ts in @buddha/shared and @buddha/db, whose helpers
 * write every row and keep `markets.dispute_hold_count`):
 *
 * - 제출 (`submit`, a member who finished the onboarding): while the market is PROVISIONAL and its
 *   이의 기한 ahead, a member with a fill on it (either side) disputes the current judgement
 *   version with 근거 링크 and a reason — one per member and version, a retracted one included.
 *   An account or a writing restriction refuses nothing (#173 item 6, ADR-0069 #45-12); an admin
 *   may not dispute (#173 item 15). No admin action: the member's own row.
 * - 철회 (`retract`, signed in is enough): the submitter's own, while pending and the deadline
 *   ahead (#173 item 6).
 * - 기각·수용 (`decide`): one admin who did not register the dispute's judgement version — its
 *   approver may (#173 item 2) — with a reason the submitter reads (#173 item 7), written with its
 *   `admin_actions` row (`market_dispute_dismiss|accept`, payload the dispute, its version and the
 *   reason — never the submitter's body). An acceptance keeps holding the market: it is a
 *   correction, #176's (owner answer 2026-11-02).
 * - The reads: the member's own (`listMine`, `myMarketDispute` — the dispute screen's standing,
 *   asked as the submission would), and 이의 접수 (`adminList`). A market's disputes on the admin
 *   detail are `AdminMarket.disputes` (`readAdminMarketDisputes`).
 *
 * Every write is one transaction and reads the database clock after every lock. A submission takes
 * the account's locks first, in the order a closure and a role grant take them — the shared
 * admin-roles lock (a grant racing it waits, and one before it is seen), then the submitter's
 * profile FOR KEY SHARE (a closure racing it waits, and one before it is seen) — and then the
 * market lock (`lockMarket`) and the market row FOR UPDATE: a closure that has the profile and goes
 * on to a market row (its watch events' foreign key) never waits for a submission holding that row.
 * A retraction and a decision take MarketAdminService's order — the market lock, the market row FOR
 * UPDATE, the shared admin-roles lock (a decision) and the dispute row FOR UPDATE. So the
 * submission's `now < deadline` and the worker's confirmation at `deadline <= now`, which takes the
 * same market lock, never overlap (ADR-0103 9-2), and two writes of one dispute serialise (the
 * second finds it decided or retracted). After COMMIT each republishes the market's UNCHANGED
 * `market:status` (`publishStatus`): an open detail refetches its labels ('이의 검토 중', '판정 지연'). And
 * after a dismissal that leaves nothing holding past the deadline, `market.resolve` with no delay
 * (`MarketJobs.scheduleResolve`): the worker stays the only confirmer (ADR-0103 9-12; `resolved`
 * with `source: 'deadline'`, no actor) and confirms within seconds — '모두 기각되면 바로 확정한다' (#173 item
 * 7) — and its per-minute scan covers a lost job. A dismissal before the deadline registers
 * nothing: the approval's job at the deadline confirms it then.
 */
@Injectable()
export class MarketDisputeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly markets: MarketAdminService,
    private readonly jobs: MarketJobs,
  ) {}

  /**
   * 판정 이의 제출 (`POST /markets/:id/disputes`): the class doc's submission, the body's own rules
   * first (`submitDisputeBodySchema`: 1..5 distinct http(s) links, a reason of 1..2,000). NOT_FOUND
   * for a market that is not public; then DISPUTE_NOT_ALLOWED `not_provisional`, `stale_version`,
   * `deadline_passed`, `admin`, `no_fill` or `duplicate`, in that order (`submitMarketDispute`),
   * on the database clock read after the locks. The onboarding is held to the write's snapshot
   * (`assertOnboarded`; OnboardedGuard asked it before the body). Answers the dispute, pending.
   */
  async submit(
    userId: string,
    marketId: string,
    body: WithoutExpectedAccount<SubmitDisputeBody>,
  ): Promise<MyDispute> {
    const { row, market, deadline, now } = await this.db.transaction(async (tx) => {
      // The account's locks first, as a closure and a role grant take them (the class doc): the
      // admin roles, so a grant (exclusive) racing this waits for it or is seen by the `admin`
      // refusal; then the profile, so a closure (FOR UPDATE) racing this waits for it, or this
      // reads what it left. Then the market's.
      await lockAdminRoles(tx, 'shared');
      await tx
        .select({ one: sql`1` })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .for('key share');
      await lockMarket(tx, marketId);
      const current = await lockedMarketRow(tx, marketId);
      if (!isPublicMarketStatus(current.status)) throw notFound('Market');
      await assertOnboarded(tx, userId);
      const now = await clockTimestamp(tx);
      const result = await submitMarketDispute(tx, {
        market: current,
        userId,
        judgementVersion: body.judgementVersion,
        links: body.links,
        reason: body.reason,
        now,
      });
      if (!result.created) throw disputeNotAllowed(result.reason);
      return { row: result.dispute, market: result.market, deadline: current.disputeDeadline, now };
    });
    await this.markets.publishStatus(publishedStatusOf(market));
    return this.mine(row, market, deadline, now);
  }

  /**
   * 철회 (`POST /me/disputes/:disputeId/retract`): the submitter's own dispute — anybody else's is
   * NOT_FOUND — refused DISPUTE_NOT_ALLOWED `retracted`, `decided` (dismissed or accepted) or
   * `deadline_passed` (`retractMarketDispute`, status first). Answers the dispute, retracted.
   */
  async retract(userId: string, disputeId: string): Promise<MyDispute> {
    // Its market first, unlocked, for the market lock: a dispute never moves to another market.
    const [owned] = await this.db
      .select({ marketId: marketDisputes.marketId })
      .from(marketDisputes)
      .where(and(eq(marketDisputes.id, disputeId), eq(marketDisputes.userId, userId)))
      .limit(1);
    if (!owned) throw notFound('Dispute');
    const { row, market, deadline, now } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, owned.marketId);
      const current = await lockedMarketRow(tx, owned.marketId);
      const dispute = await lockedDispute(tx, owned.marketId, disputeId);
      const now = await clockTimestamp(tx);
      const result = await retractMarketDispute(tx, { dispute, market: current, now });
      if (!result.retracted) throw disputeNotAllowed(result.reason);
      return {
        row: result.dispute,
        market: result.market,
        deadline: await versionDeadline(tx, result.dispute),
        now,
      };
    });
    await this.markets.publishStatus(publishedStatusOf(market));
    return this.mine(row, market, deadline, now);
  }

  /**
   * 기각 (`dismiss`) or 수용 (`accept`) of the market's dispute `disputeId` by `adminId` (`POST
   * /admin/markets/:id/disputes/:disputeId/dismiss|accept`): NOT_FOUND for a dispute of no such
   * market; DISPUTE_NOT_ALLOWED `retracted` or `decided` for one no longer pending, then
   * `registrant` for the admin who registered its judgement version and `own` for its submitter
   * (`disputeDecisionRefusal`); FORBIDDEN for an admin whose role was revoked while it waited.
   * Writes the decision (`decideMarketDispute`: a dismissal takes one off the hold count) and its
   * `admin_actions` row at the database clock after the locks, and answers the admin detail. After
   * COMMIT `market:status` (unchanged) and — a dismissal that left nothing holding, its deadline
   * passed — `market.resolve` with no delay.
   */
  async decide(
    adminId: string,
    marketId: string,
    disputeId: string,
    decision: MarketDisputeDecision,
    body: WithoutExpectedAccount<DecideDisputeBody>,
  ): Promise<AdminMarket> {
    const { market, due } = await this.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const current = await lockedMarketRow(tx, marketId);
      // The class's lock order: the admin roles after the market's rows, then the dispute's. The
      // role is read again under that lock: a revocation that committed after AdminGuard passed
      // this request is seen, and one after this lock waits for the decision (ApprovalService's).
      await lockAdminRoles(tx, 'shared');
      const [decider] = await tx
        .select({ role: profiles.role })
        .from(profiles)
        .where(eq(profiles.userId, adminId))
        .limit(1);
      if (decider?.role !== 'admin') throw new AppError('FORBIDDEN', { message: 'Admin only' });
      const dispute = await lockedDispute(tx, marketId, disputeId);
      const now = await clockTimestamp(tx);
      const [judgement] = await tx
        .select({ registeredBy: marketJudgements.registeredBy })
        .from(marketJudgements)
        .where(
          and(
            eq(marketJudgements.marketId, marketId),
            eq(marketJudgements.version, dispute.judgementVersion),
          ),
        );
      if (!judgement) {
        throw new AppError('INTERNAL', { message: `Dispute ${disputeId} has no judgement` });
      }
      const refusal = disputeDecisionRefusal(
        dispute,
        adminId,
        judgement.registeredBy,
        dispute.userId,
      );
      if (refusal !== null) throw disputeNotAllowed(refusal);
      const result = await decideMarketDispute(tx, {
        market: current,
        dispute,
        adminId,
        decision,
        reason: body.reason,
        now,
      });
      // Asked above under the same locks.
      if (!result.decided) throw disputeNotAllowed(result.reason);
      await tx.insert(schema.adminActions).values({
        adminId,
        type: MARKET_DISPUTE_DECISION_ACTION_TYPES[decision],
        targetType: 'market',
        targetId: marketId,
        payload: {
          disputeId,
          judgementVersion: result.dispute.judgementVersion,
          reason: result.dispute.decisionReason ?? body.reason,
        } satisfies MarketDisputeDecisionActionPayload,
        createdAt: now,
      });
      const deadline = result.market.disputeDeadline;
      return {
        market: await this.markets.toAdminMarket(
          tx,
          result.market,
          await marketTagNames(tx, marketId),
          await readMarketSources(tx, marketId),
        ),
        // The last holding dispute dismissed past the deadline: nothing keeps the confirmation
        // (#173 item 7 '모두 기각되면 바로 확정'); before the deadline its own job confirms it.
        due:
          decision === 'dismiss' &&
          !result.held &&
          deadline !== null &&
          deadline.getTime() <= now.getTime()
            ? { deadline, now }
            : null,
      };
    });
    // Outside the transaction, as every market write publishes: the refetch a subscriber makes
    // must find the committed row, and the worker's run must find the dismissal.
    await Promise.all([
      this.markets.publishStatus(market),
      due === null ? undefined : this.jobs.scheduleResolve(market.id, due.deadline, due.now),
    ]);
    return market;
  }

  /**
   * MY 판정 이의 (`GET /me/disputes`): the caller's disputes, the newest submission first,
   * keyset-paginated, each `retractable` on the database clock of the read.
   */
  async listMine(userId: string, query: CursorQuery): Promise<Page<MyDispute>> {
    const now = await clockTimestamp(this.db);
    const page = await readMyDisputes(this.db, userId, {
      after: decodeKeyset(query.cursor, 'uuid'),
      limit: query.limit,
    });
    return {
      items: page.items.map((row) => toMyDispute(row, now.getTime())),
      nextCursor: page.next === null ? null : encodeKeyset(page.next),
    };
  }

  /**
   * The dispute screen (`GET /me/disputes/markets/:marketId`): NOT_FOUND for a market that is not
   * public; the caller's standing on its current judgement version as a submission now would be
   * answered (`readMyMarketDispute`, the same checks in the same order, on the database clock) and
   * the caller's dispute of that version, whatever its status. One read-only snapshot, so the
   * standing and the dispute describe one moment.
   */
  myMarketDispute(userId: string, marketId: string): Promise<MyMarketDispute> {
    return this.db.transaction(
      async (tx) => {
        const [market] = await tx
          .select()
          .from(markets)
          .where(and(eq(markets.id, marketId), isPublicMarket()))
          .limit(1);
        if (!market) throw notFound('Market');
        const now = await clockTimestamp(tx);
        const read = await readMyMarketDispute(tx, { market, userId, now });
        return {
          eligibility: read.eligibility,
          judgementVersion: read.judgementVersion,
          dispute: read.dispute === null ? null : toMyDispute(read.dispute, now.getTime()),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  /**
   * 이의 접수 (`GET /admin/market-disputes`): 검토 대기 (`pending`, the oldest submission first) or
   * 처리됨 (`decided`, the latest decision or retraction first), keyset-paginated.
   */
  async adminList(query: AdminDisputeListQuery): Promise<Page<AdminDisputeQueueItem>> {
    const page = await readAdminDisputes(this.db, {
      status: query.status,
      after: decodeKeyset(query.cursor, 'uuid'),
      limit: query.limit,
    });
    return {
      items: page.items.map(toAdminDisputeQueueItem),
      nextCursor: page.next === null ? null : encodeKeyset(page.next),
    };
  }

  /** A write's answer: the dispute as the member reads it, at the write's instant. */
  private mine(
    row: MarketDisputeRow,
    market: MarketRow,
    deadline: Date | null,
    now: Date,
  ): MyDispute {
    // markets_provisional_check and the judgement's NOT NULL: a disputed version has its deadline.
    if (deadline === null) {
      throw new AppError('INTERNAL', { message: `Dispute ${row.id} has no deadline` });
    }
    return toMyDispute(
      { ...row, market: marketRefOf(market), disputeDeadline: deadline },
      now.getTime(),
    );
  }
}

/** The market's dispute `disputeId` FOR UPDATE, after the market's rows; NOT_FOUND otherwise. */
async function lockedDispute(
  tx: Tx,
  marketId: string,
  disputeId: string,
): Promise<MarketDisputeRow> {
  const [row] = await tx
    .select()
    .from(marketDisputes)
    .where(and(eq(marketDisputes.id, disputeId), eq(marketDisputes.marketId, marketId)))
    .limit(1)
    .for('update');
  if (!row) throw notFound('Dispute');
  return row;
}

/** The 이의 기한 of a dispute's own judgement version (`market_judgements.dispute_deadline`). */
async function versionDeadline(
  tx: Tx,
  dispute: Pick<MarketDisputeRow, 'marketId' | 'judgementVersion'>,
): Promise<Date | null> {
  const [judgement] = await tx
    .select({ disputeDeadline: marketJudgements.disputeDeadline })
    .from(marketJudgements)
    .where(
      and(
        eq(marketJudgements.marketId, dispute.marketId),
        eq(marketJudgements.version, dispute.judgementVersion),
      ),
    );
  return judgement?.disputeDeadline ?? null;
}
