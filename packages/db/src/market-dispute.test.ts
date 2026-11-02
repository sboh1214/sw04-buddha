import { randomUUID } from 'node:crypto';
import {
  HOLDING_DISPUTE_STATUSES,
  MARKET_DISPUTE_STATUSES,
  type MarketDisputeDecision,
  type MarketDisputeStatus,
} from '@buddha/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  confirmationHold,
  decideMarketDispute,
  hasMarketFill,
  readAdminDisputes,
  readMarketDisputes,
  readMyDisputes,
  readMyMarketDispute,
  retractMarketDispute,
  submitMarketDispute,
} from './market-dispute.js';
import { dueProvisionalMarkets, resolveProvisionalMarket } from './market-judgement.js';
import { marketDisputes, marketEvents, markets, orders, profiles } from './schema/index.js';
import {
  closeAccount,
  createDispute,
  createFill,
  createMarket,
  createModerationAction,
  createProvisionalMarket,
  createUser,
  resolveMarketNow,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { clockTimestamp, lockAdminRoles, lockMarket } from './tx-helpers.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const LINK = 'https://example.com/evidence';
const REASON = '발표 원문과 판정 결과가 다르다.';
const DECISION = '판정의 근거를 다시 확인했다.';

describe.skipIf(!hasTestDb())('market disputes (#175, docker test profile)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const rowOf = async (marketId: string) => {
    const [row] = await t.db.select().from(markets).where(eq(markets.id, marketId));
    return row!;
  };

  const disputeOf = async (id: string) => {
    const [row] = await t.db.select().from(marketDisputes).where(eq(marketDisputes.id, id));
    return row!;
  };

  const admin = async () => (await createUser(t.db, { role: 'admin' })).user.id;

  /** A member with a fill on the market (the taker's side, `createFill`). */
  async function trader(marketId: string) {
    const { user } = await createUser(t.db);
    await createFill(t.db, { marketId, userId: user.id, amountCoin: 50n });
    return user.id;
  }

  /**
   * The mirror equals the real count — the current version's pending and accepted disputes — and
   * that count is returned (ADR-0104 choice 2: a db test holds every writer to it).
   */
  async function mirrorOf(marketId: string): Promise<number> {
    const market = await rowOf(marketId);
    const [held] = await t.db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketDisputes)
      .where(
        and(
          eq(marketDisputes.marketId, marketId),
          eq(marketDisputes.judgementVersion, market.judgementVersion ?? 0),
          inArray(marketDisputes.status, [...HOLDING_DISPUTE_STATUSES]),
        ),
      );
    expect(market.disputeHoldCount).toBe(held!.count);
    return market.disputeHoldCount;
  }

  /**
   * As the API submits: the market lock, the row FOR UPDATE, the submitter's profile FOR KEY
   * SHARE, then `now` — the database clock after the locks, unless a boundary case gives it.
   */
  function submit(
    marketId: string,
    userId: string,
    input: { judgementVersion?: number; links?: string[]; reason?: string } = {},
    at?: Date,
  ) {
    return t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const [market] = await tx
        .select()
        .from(markets)
        .where(eq(markets.id, marketId))
        .for('update');
      await tx
        .select({ userId: profiles.userId })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .for('key share');
      const now = at ?? (await clockTimestamp(tx));
      return submitMarketDispute(tx, {
        market: market!,
        userId,
        judgementVersion: input.judgementVersion ?? market!.judgementVersion ?? 1,
        links: input.links ?? [LINK],
        reason: input.reason ?? REASON,
        now,
      });
    });
  }

  /** As the API retracts: the market lock, the market row, the dispute row, then `now`. */
  function retract(disputeId: string, at?: Date) {
    return t.db.transaction(async (tx) => {
      const [{ marketId } = { marketId: randomUUID() }] = await tx
        .select({ marketId: marketDisputes.marketId })
        .from(marketDisputes)
        .where(eq(marketDisputes.id, disputeId));
      await lockMarket(tx, marketId);
      const [market] = await tx
        .select()
        .from(markets)
        .where(eq(markets.id, marketId))
        .for('update');
      const [dispute] = await tx
        .select()
        .from(marketDisputes)
        .where(eq(marketDisputes.id, disputeId))
        .for('update');
      const now = at ?? (await clockTimestamp(tx));
      return retractMarketDispute(tx, { dispute: dispute!, market: market!, now });
    });
  }

  /** As the API decides: the market lock, its row, the shared admin lock, the dispute, `now`. */
  function decide(
    disputeId: string,
    adminId: string,
    decision: MarketDisputeDecision,
    { reason = DECISION, at }: { reason?: string; at?: Date } = {},
  ) {
    return t.db.transaction(async (tx) => {
      const [{ marketId } = { marketId: randomUUID() }] = await tx
        .select({ marketId: marketDisputes.marketId })
        .from(marketDisputes)
        .where(eq(marketDisputes.id, disputeId));
      await lockMarket(tx, marketId);
      const [market] = await tx
        .select()
        .from(markets)
        .where(eq(markets.id, marketId))
        .for('update');
      await lockAdminRoles(tx, 'shared');
      const [dispute] = await tx
        .select()
        .from(marketDisputes)
        .where(eq(marketDisputes.id, disputeId))
        .for('update');
      const now = at ?? (await clockTimestamp(tx));
      return {
        now,
        result: await decideMarketDispute(tx, {
          market: market!,
          dispute: dispute!,
          adminId,
          decision,
          reason,
          now,
        }),
      };
    });
  }

  /** As the worker confirms: the market lock, then the database clock (or the instant given). */
  function confirm(marketId: string, at?: Date) {
    return t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const now = at ?? (await clockTimestamp(tx));
      return resolveProvisionalMarket(tx, { marketId, now });
    });
  }

  describe('submitMarketDispute', () => {
    it('writes a pending dispute at the instant, as the body schema parses it, and one more on the mirror', async () => {
      const { market } = await createProvisionalMarket(t.db);
      const userId = await trader(market.id);
      const now = new Date(market.disputeDeadline!.getTime() - DAY_MS / 2);
      const result = await submit(
        market.id,
        userId,
        { links: [`  ${LINK}  `, 'http://example.com/b'], reason: `  ${REASON}  ` },
        now,
      );
      expect(result).toMatchObject({ created: true });
      if (!result.created) return;
      expect(result.dispute).toEqual({
        id: expect.any(String) as unknown,
        marketId: market.id,
        judgementVersion: 1,
        userId,
        links: [LINK, 'http://example.com/b'],
        reason: REASON,
        status: 'pending',
        submittedAt: now,
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        retractedAt: null,
        purgedAt: null,
      });
      expect(await disputeOf(result.dispute.id)).toEqual(result.dispute);
      expect(result.market).toEqual({ ...market, disputeHoldCount: 1, updatedAt: now });
      expect(await rowOf(market.id)).toEqual(result.market);
      expect(await mirrorOf(market.id)).toBe(1);
      // No event: a dispute changes no status.
      const events = await t.db
        .select({ type: marketEvents.type })
        .from(marketEvents)
        .where(eq(marketEvents.marketId, market.id));
      expect(events.map((event) => event.type)).toEqual(['provisional']);
    });

    it('takes a submission a millisecond before the deadline and refuses one at it (deadline_passed)', async () => {
      const { market } = await createProvisionalMarket(t.db);
      const deadline = market.disputeDeadline!;
      const late = await trader(market.id);
      expect(await submit(market.id, late, {}, deadline)).toEqual({
        created: false,
        reason: 'deadline_passed',
      });
      expect(await submit(market.id, late, {}, new Date(deadline.getTime() + DAY_MS))).toEqual({
        created: false,
        reason: 'deadline_passed',
      });
      expect(await mirrorOf(market.id)).toBe(0);
      const inTime = await submit(market.id, late, {}, new Date(deadline.getTime() - 1));
      expect(inTime).toMatchObject({ created: true, dispute: { status: 'pending' } });
      expect(await mirrorOf(market.id)).toBe(1);
    });

    it('refuses in its order: not_provisional, stale_version, deadline_passed, admin, no_fill, duplicate', async () => {
      const { market } = await createProvisionalMarket(t.db);
      const deadline = market.disputeDeadline!;
      const before = new Date(deadline.getTime() - 1);
      // An admin with a fill (from before the grant, #143), refused as an admin past the deadline
      // only as late, and with a stale version only as stale.
      const { user: adminUser } = await createUser(t.db, { role: 'admin' });
      await createFill(t.db, { marketId: market.id, userId: adminUser.id, amountCoin: 50n });
      expect(await submit(market.id, adminUser.id, { judgementVersion: 2 }, deadline)).toEqual({
        created: false,
        reason: 'stale_version',
      });
      expect(await submit(market.id, adminUser.id, {}, deadline)).toEqual({
        created: false,
        reason: 'deadline_passed',
      });
      expect(await submit(market.id, adminUser.id, {}, before)).toEqual({
        created: false,
        reason: 'admin',
      });
      // A member with no fill: no_fill, and nothing else asked after it.
      const { user: bystander } = await createUser(t.db);
      expect(await submit(market.id, bystander.id, {}, before)).toEqual({
        created: false,
        reason: 'no_fill',
      });
      // One per member per version.
      const member = await trader(market.id);
      expect((await submit(market.id, member, {}, before)).created).toBe(true);
      expect(await submit(market.id, member, { links: ['https://example.com/x'] }, before)).toEqual(
        { created: false, reason: 'duplicate' },
      );
      expect(await mirrorOf(market.id)).toBe(1);

      // Not PROVISIONAL: a CLOSED market not judged yet (no version), and one confirmed since.
      const closed = await createMarket(t.db, { status: 'closed' });
      const closedTrader = await trader(closed.id);
      expect(await submit(closed.id, closedTrader, { judgementVersion: 1 })).toEqual({
        created: false,
        reason: 'not_provisional',
      });
      const { market: judged } = await createProvisionalMarket(t.db, {
        publishedAt: new Date(Date.now() - DAY_MS - MINUTE_MS),
      });
      await resolveMarketNow(t.db, judged.id);
      expect(await submit(judged.id, await trader(judged.id))).toEqual({
        created: false,
        reason: 'not_provisional',
      });
      // Nothing was written by a refusal.
      expect(await t.db.select().from(marketDisputes)).toHaveLength(1);
    });

    it('counts either side of a fill, and a cancelled order’s filled part, never an unfilled order (#173 item 6)', async () => {
      const { market } = await createProvisionalMarket(t.db);
      const { user: maker } = await createUser(t.db);
      const { user: taker } = await createUser(t.db);
      await createFill(t.db, {
        marketId: market.id,
        userId: taker.id,
        makerId: maker.id,
        amountCoin: 50n,
      });
      expect(await hasMarketFill(t.db, maker.id, market.id)).toBe(true);
      expect(await hasMarketFill(t.db, taker.id, market.id)).toBe(true);
      expect((await submit(market.id, maker.id)).created).toBe(true);
      expect((await submit(market.id, taker.id)).created).toBe(true);
      expect(await mirrorOf(market.id)).toBe(2);
      // A fill on another market is not one on this.
      const other = await createMarket(t.db, { status: 'closed' });
      expect(await hasMarketFill(t.db, maker.id, other.id)).toBe(false);
      // A cancelled remainder keeps its filled part; an order that never filled is none.
      const { user: partial } = await createUser(t.db);
      const { user: resting } = await createUser(t.db);
      const order = (id: string, filledQty: number, status: 'cancelled' | 'open') => ({
        userId: id,
        marketId: market.id,
        outcome: 'YES' as const,
        side: 'buy' as const,
        type: 'limit' as const,
        limitPrice: 40,
        qty: 3,
        filledQty,
        status,
        idempotencyKey: randomUUID(),
      });
      await t.db
        .insert(orders)
        .values([order(partial.id, 1, 'cancelled'), order(resting.id, 0, 'open')]);
      expect(await hasMarketFill(t.db, partial.id, market.id)).toBe(true);
      expect(await hasMarketFill(t.db, resting.id, market.id)).toBe(false);
    });

    it('asks no restriction: an account or writing restriction leaves 판정 이의 open (#173 item 6, #45-12)', async () => {
      const { market } = await createProvisionalMarket(t.db);
      const userId = await trader(market.id);
      await createModerationAction(t.db, {
        userId,
        createdBy: await admin(),
        approvedBy: await admin(),
        type: 'account_restriction',
        endsAt: new Date(Date.now() + DAY_MS),
      });
      await createModerationAction(t.db, {
        userId,
        createdBy: await admin(),
        type: 'writing_restriction',
        endsAt: new Date(Date.now() + DAY_MS),
      });
      expect((await submit(market.id, userId)).created).toBe(true);
    });

    it('throws on a body its schema refuses (the API refuses it first): no link, a duplicate, a blank reason', async () => {
      const { market } = await createProvisionalMarket(t.db);
      const userId = await trader(market.id);
      for (const input of [
        { links: [] },
        { links: [LINK, ` ${LINK}`] },
        { links: ['ftp://example.com/a'] },
        { reason: '   ' },
        { reason: '가'.repeat(2_001) },
      ]) {
        await expect(submit(market.id, userId, input), JSON.stringify(input)).rejects.toThrow(
          /body schema/,
        );
      }
      expect(await mirrorOf(market.id)).toBe(0);
    });
  });

  describe('retractMarketDispute', () => {
    it('retracts a pending dispute a millisecond before the deadline, one fewer on the mirror; at it, deadline_passed', async () => {
      const { market } = await createProvisionalMarket(t.db);
      const deadline = market.disputeDeadline!;
      const { dispute: late } = await createDispute(t.db, { marketId: market.id });
      const { dispute } = await createDispute(t.db, { marketId: market.id });
      expect(await mirrorOf(market.id)).toBe(2);
      expect(await retract(late.id, deadline)).toEqual({
        retracted: false,
        reason: 'deadline_passed',
      });
      const at = new Date(deadline.getTime() - 1);
      const result = await retract(dispute.id, at);
      expect(result).toMatchObject({ retracted: true });
      if (!result.retracted) return;
      expect(result.dispute).toEqual({ ...dispute, status: 'retracted', retractedAt: at });
      expect(result.market.disputeHoldCount).toBe(1);
      expect(await mirrorOf(market.id)).toBe(1);
      // Still the one of its version: no second dispute after a retraction ('고칠 수는 없다').
      expect(await submit(market.id, dispute.userId, {}, at)).toEqual({
        created: false,
        reason: 'duplicate',
      });
    });

    it('refuses a retracted dispute (retracted) and a decided one (decided), status before the deadline', async () => {
      const { market } = await createProvisionalMarket(t.db);
      const deadline = market.disputeDeadline!;
      for (const [status, reason] of [
        ['retracted', 'retracted'],
        ['dismissed', 'decided'],
        ['accepted', 'decided'],
      ] as const) {
        const { dispute } = await createDispute(t.db, { marketId: market.id, status });
        expect(await retract(dispute.id, deadline), status).toEqual({ retracted: false, reason });
        expect(await disputeOf(dispute.id)).toEqual(dispute);
      }
      expect(await mirrorOf(market.id)).toBe(1);
    });
  });

  describe('decideMarketDispute', () => {
    it('dismisses with the admin, the instant and the reason, one fewer on the mirror; held until the last', async () => {
      const { market, judgement } = await createProvisionalMarket(t.db);
      const first = (await createDispute(t.db, { marketId: market.id })).dispute;
      const second = (await createDispute(t.db, { marketId: market.id })).dispute;
      // The judgement's approver may decide (#173 item 2: only the registrant is out).
      const { now, result } = await decide(first.id, judgement.approvedBy, 'dismiss', {
        reason: `  ${DECISION}  `,
      });
      expect(result).toMatchObject({ decided: true, held: true });
      if (!result.decided) return;
      expect(result.dispute).toEqual({
        ...first,
        status: 'dismissed',
        decidedBy: judgement.approvedBy,
        decidedAt: now,
        decisionReason: DECISION,
      });
      expect(result.market.disputeHoldCount).toBe(1);
      expect(await mirrorOf(market.id)).toBe(1);
      const last = await decide(second.id, await admin(), 'dismiss');
      expect(last.result).toMatchObject({
        decided: true,
        held: false,
        market: { disputeHoldCount: 0 },
      });
      expect(await mirrorOf(market.id)).toBe(0);
    });

    it('accepts: the dispute still holds (a correction, #176), the mirror unchanged', async () => {
      const { market } = await createProvisionalMarket(t.db);
      const { dispute } = await createDispute(t.db, { marketId: market.id });
      const decider = await admin();
      const { now, result } = await decide(dispute.id, decider, 'accept');
      expect(result).toMatchObject({
        decided: true,
        held: true,
        dispute: { status: 'accepted', decidedBy: decider, decidedAt: now },
        // The instant moves all the same: the republished `market:status` carries it as `ts`.
        market: { disputeHoldCount: 1, updatedAt: now },
      });
      expect(await mirrorOf(market.id)).toBe(1);
      expect(await confirmationHold(t.db, await rowOf(market.id))).toBe(true);
    });

    it('refuses a retracted (retracted) or decided (decided) dispute, and throws for the registrant and the submitter', async () => {
      const { market, judgement } = await createProvisionalMarket(t.db);
      const decider = await admin();
      for (const [status, reason] of [
        ['retracted', 'retracted'],
        ['dismissed', 'decided'],
        ['accepted', 'decided'],
      ] as const) {
        const { dispute } = await createDispute(t.db, { marketId: market.id, status });
        for (const decision of ['dismiss', 'accept'] as const) {
          expect((await decide(dispute.id, decider, decision)).result).toEqual({
            decided: false,
            reason,
          });
          // The status comes first: the registrant is told the same.
          expect((await decide(dispute.id, judgement.registeredBy, decision)).result).toEqual({
            decided: false,
            reason,
          });
        }
        expect(await disputeOf(dispute.id)).toEqual(dispute);
      }
      const { dispute } = await createDispute(t.db, { marketId: market.id });
      await expect(decide(dispute.id, judgement.registeredBy, 'dismiss')).rejects.toThrow(
        /other than its judgement’s registrant/,
      );
      await expect(decide(dispute.id, dispute.userId, 'accept')).rejects.toThrow(
        /other than its submitter/,
      );
      await expect(decide(dispute.id, decider, 'dismiss', { reason: ' ' })).rejects.toThrow(
        /reason/,
      );
      await expect(
        decide(dispute.id, decider, 'accept', { reason: '가'.repeat(501) }),
      ).rejects.toThrow(/reason/);
      expect(await disputeOf(dispute.id)).toEqual(dispute);
      expect(await mirrorOf(market.id)).toBe(2);
    });
  });

  describe('the hold and the confirmation', () => {
    it('holds while a dispute of the current version is pending or accepted, never for a dismissed or retracted one', async () => {
      const cases: [MarketDisputeStatus, boolean][] = MARKET_DISPUTE_STATUSES.map((status) => [
        status,
        (HOLDING_DISPUTE_STATUSES as readonly string[]).includes(status),
      ]);
      for (const [status, held] of cases) {
        const { market } = await createDispute(t.db, { status });
        expect(await confirmationHold(t.db, market), status).toBe(held);
        expect(await mirrorOf(market.id)).toBe(held ? 1 : 0);
      }
      // No judgement, no dispute: nothing holds.
      const { market } = await createProvisionalMarket(t.db);
      expect(await confirmationHold(t.db, market)).toBe(false);
      expect(await confirmationHold(t.db, await createMarket(t.db, { status: 'closed' }))).toBe(
        false,
      );
    });

    it('holds by the current version alone: a pending dispute of an earlier one holds nothing (#176)', async () => {
      const { market } = await createDispute(t.db);
      // As #176's correction will move it (the mirror is #176's to recount).
      await t.db
        .update(markets)
        .set({ judgementVersion: 2, disputeHoldCount: 0 })
        .where(eq(markets.id, market.id));
      expect(await confirmationHold(t.db, await rowOf(market.id))).toBe(false);
    });

    it('confirms nothing a dispute holds: not_due before the deadline, held at and after it, resolved once none holds', async () => {
      const { market } = await createProvisionalMarket(t.db);
      const deadline = market.disputeDeadline!;
      const { dispute } = await createDispute(t.db, { marketId: market.id });
      const accepted = (await createDispute(t.db, { marketId: market.id, status: 'accepted' }))
        .dispute;
      const held = await rowOf(market.id);
      expect(await confirm(market.id, new Date(deadline.getTime() - 1))).toEqual({
        resolved: false,
        reason: 'not_due',
      });
      expect(await confirm(market.id, deadline)).toEqual({ resolved: false, reason: 'held' });
      expect(await confirm(market.id, new Date(deadline.getTime() + DAY_MS))).toEqual({
        resolved: false,
        reason: 'held',
      });
      expect(await rowOf(market.id)).toEqual(held);
      // The pending one dismissed after the deadline: the accepted one still holds it (until #176
      // approves its correction — owner answer 2026-11-02).
      const after = new Date(deadline.getTime() + MINUTE_MS);
      await decide(dispute.id, await admin(), 'dismiss', { at: after });
      expect(accepted.status).toBe('accepted');
      expect(await confirm(market.id, after)).toEqual({ resolved: false, reason: 'held' });
      expect(await mirrorOf(market.id)).toBe(1);

      // Every dispute dismissed or retracted: confirmed at the deadline, the mirror 0.
      const { market: free } = await createProvisionalMarket(t.db);
      const freeDeadline = free.disputeDeadline!;
      const gone = (await createDispute(t.db, { marketId: free.id })).dispute;
      const dismissed = (await createDispute(t.db, { marketId: free.id })).dispute;
      await retract(gone.id, new Date(freeDeadline.getTime() - 1));
      expect(await confirm(free.id, freeDeadline)).toEqual({ resolved: false, reason: 'held' });
      await decide(dismissed.id, await admin(), 'dismiss', { at: freeDeadline });
      expect(await confirm(free.id, freeDeadline)).toMatchObject({
        resolved: true,
        market: { status: 'resolved', disputeHoldCount: 0, resolvedAt: freeDeadline },
      });
    });

    it('refuses a confirmation of a market whose mirror still counts a hold (markets_dispute_hold_status_check)', async () => {
      // A mirror that drifted high can only fail loudly: the CHECK holds 0 off PROVISIONAL.
      const { market } = await createProvisionalMarket(t.db);
      await t.db.update(markets).set({ disputeHoldCount: 1 }).where(eq(markets.id, market.id));
      await expect(confirm(market.id, market.disputeDeadline!)).rejects.toThrow();
      expect((await rowOf(market.id)).status).toBe('provisional');
    });

    it('lists the due markets the scan confirms, earliest deadline first, less the held ones', async () => {
      const past = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS);
      const earlier = (
        await createProvisionalMarket(t.db, { publishedAt: past(4), disputeWindowMinutes: 1 })
      ).market;
      const later = (
        await createProvisionalMarket(t.db, { publishedAt: past(2), disputeWindowMinutes: 1 })
      ).market;
      const heldMarket = (
        await createProvisionalMarket(t.db, { publishedAt: past(3), disputeWindowMinutes: 1 })
      ).market;
      const acceptedMarket = (
        await createProvisionalMarket(t.db, { publishedAt: past(3), disputeWindowMinutes: 1 })
      ).market;
      const dismissedMarket = (
        await createProvisionalMarket(t.db, { publishedAt: past(5), disputeWindowMinutes: 1 })
      ).market;
      await createProvisionalMarket(t.db);
      await createDispute(t.db, { marketId: heldMarket.id, submittedAt: past(3) });
      await createDispute(t.db, {
        marketId: acceptedMarket.id,
        status: 'accepted',
        submittedAt: past(3),
      });
      await createDispute(t.db, {
        marketId: dismissedMarket.id,
        status: 'dismissed',
        submittedAt: past(5),
      });
      expect((await dueProvisionalMarkets(t.db)).map((row) => row.id)).toEqual([
        dismissedMarket.id,
        earlier.id,
        later.id,
      ]);
      expect((await dueProvisionalMarkets(t.db, 2)).map((row) => row.id)).toEqual([
        dismissedMarket.id,
        earlier.id,
      ]);
    });
  });

  describe('readers', () => {
    it('reads a version’s disputes oldest first with both nicknames, empty without a judgement', async () => {
      const { market } = await createProvisionalMarket(t.db);
      const at = (ms: number) => new Date(market.disputeDeadline!.getTime() - DAY_MS + ms);
      const { user: decider } = await createUser(t.db, { role: 'admin', nickname: '검토자' });
      const { user: one } = await createUser(t.db, { nickname: '첫제출' });
      const { user: two } = await createUser(t.db, { nickname: '둘제출' });
      const second = (
        await createDispute(t.db, {
          marketId: market.id,
          userId: two.id,
          status: 'dismissed',
          decidedBy: decider.id,
          submittedAt: at(2),
        })
      ).dispute;
      const first = (
        await createDispute(t.db, { marketId: market.id, userId: one.id, submittedAt: at(1) })
      ).dispute;
      expect(await readMarketDisputes(t.db, market.id, 1)).toEqual([
        { ...first, submitterNickname: '첫제출', deciderNickname: null },
        { ...second, submitterNickname: '둘제출', deciderNickname: '검토자' },
      ]);
      expect(await readMarketDisputes(t.db, market.id, 2)).toEqual([]);
      expect(await readMarketDisputes(t.db, market.id, null)).toEqual([]);
      // A closed account keeps its id with no nickname; its pending dispute is still decided.
      await closeAccount(t.db, one.id);
      expect((await readMarketDisputes(t.db, market.id, 1))[0]).toMatchObject({
        userId: one.id,
        submitterNickname: null,
        status: 'pending',
      });
    });

    it('pages a member’s disputes newest first, each with its market and its version’s deadline', async () => {
      const { user } = await createUser(t.db);
      const made = [];
      for (let index = 0; index < 3; index += 1) {
        const { market, judgement } = await createProvisionalMarket(t.db);
        const { dispute } = await createDispute(t.db, {
          marketId: market.id,
          userId: user.id,
          submittedAt: new Date(judgement.publishedAt.getTime() + index + 1),
        });
        made.push({ dispute, market, deadline: judgement.disputeDeadline });
      }
      // Another member's is not theirs.
      await createDispute(t.db);
      const expected = made
        .map(({ dispute, market, deadline }) => ({
          ...dispute,
          market: { id: market.id, slug: market.slug, title: market.title, status: market.status },
          disputeDeadline: deadline,
        }))
        .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
      const first = await readMyDisputes(t.db, user.id, { limit: 2 });
      expect(first.items).toEqual(expected.slice(0, 2));
      expect(first.next).toEqual({ createdAt: expected[1]!.submittedAt, id: expected[1]!.id });
      const second = await readMyDisputes(t.db, user.id, { after: first.next!, limit: 2 });
      expect(second).toEqual({ items: expected.slice(2), next: null });
      expect(await readMyDisputes(t.db, user.id, { limit: 3 })).toEqual({
        items: expected,
        next: null,
      });
    });

    it('reads a member’s standing on a market as the submission would answer, with their dispute of the version', async () => {
      const { market } = await createProvisionalMarket(t.db);
      const deadline = market.disputeDeadline!;
      const before = new Date(deadline.getTime() - 1);
      const read = (userId: string, now = before, row = market) =>
        readMyMarketDispute(t.db, { market: row, userId, now });
      const member = await trader(market.id);
      expect(await read(member)).toEqual({
        eligibility: 'eligible',
        judgementVersion: 1,
        dispute: null,
      });
      expect(await read(member, deadline)).toMatchObject({ eligibility: 'deadline_passed' });
      const { user: bystander } = await createUser(t.db);
      expect(await read(bystander.id)).toMatchObject({ eligibility: 'no_fill', dispute: null });
      expect(await read(await admin())).toMatchObject({ eligibility: 'admin' });
      const { dispute } = await createDispute(t.db, {
        marketId: market.id,
        userId: member,
        fill: false,
      });
      const mine = await read(member);
      expect(mine).toEqual({
        eligibility: 'duplicate',
        judgementVersion: 1,
        dispute: {
          ...dispute,
          market: { id: market.id, slug: market.slug, title: market.title, status: 'provisional' },
          disputeDeadline: deadline,
        },
      });
      // Before a judgement: not_provisional and no version.
      const closed = await createMarket(t.db, { status: 'closed' });
      expect(await read(member, before, closed)).toEqual({
        eligibility: 'not_provisional',
        judgementVersion: null,
        dispute: null,
      });
    });

    it('pages 이의 접수: pending oldest first, decided by its latest decision or retraction', async () => {
      const { market } = await createProvisionalMarket(t.db);
      const base = market.disputeDeadline!.getTime() - DAY_MS;
      const at = (ms: number) => new Date(base + ms);
      const pending = [];
      for (const ms of [30, 10, 20]) {
        pending.push(
          (await createDispute(t.db, { marketId: market.id, submittedAt: at(ms) })).dispute,
        );
      }
      const dismissed = (
        await createDispute(t.db, {
          marketId: market.id,
          status: 'dismissed',
          submittedAt: at(1),
          decidedAt: at(500),
        })
      ).dispute;
      const retracted = (
        await createDispute(t.db, {
          marketId: market.id,
          status: 'retracted',
          submittedAt: at(2),
          retractedAt: at(700),
        })
      ).dispute;
      const accepted = (
        await createDispute(t.db, {
          marketId: market.id,
          status: 'accepted',
          submittedAt: at(3),
          decidedAt: at(600),
        })
      ).dispute;
      const ref = { id: market.id, slug: market.slug, title: market.title, status: market.status };
      const page1 = await readAdminDisputes(t.db, { status: 'pending', limit: 2 });
      const byTime = [...pending].sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
      expect(page1.items.map((item) => item.id)).toEqual(byTime.slice(0, 2).map((d) => d.id));
      expect(page1.items[0]).toMatchObject({ market: ref, deciderNickname: null });
      expect(page1.next).toEqual({ createdAt: byTime[1]!.submittedAt, id: byTime[1]!.id });
      const page2 = await readAdminDisputes(t.db, {
        status: 'pending',
        after: page1.next!,
        limit: 2,
      });
      expect(page2.items.map((item) => item.id)).toEqual([byTime[2]!.id]);
      expect(page2.next).toBeNull();

      const decided1 = await readAdminDisputes(t.db, { status: 'decided', limit: 2 });
      expect(decided1.items.map((item) => item.id)).toEqual([retracted.id, accepted.id]);
      expect(decided1.next).toEqual({ createdAt: at(600), id: accepted.id });
      const decided2 = await readAdminDisputes(t.db, {
        status: 'decided',
        after: decided1.next!,
        limit: 2,
      });
      expect(decided2).toMatchObject({ items: [{ id: dismissed.id, market: ref }], next: null });
    });
  });

  describe('factories', () => {
    it('createDispute writes the status’s columns and keeps the mirror; resolveMarketNow refuses a held market', async () => {
      const { market } = await createProvisionalMarket(t.db, {
        publishedAt: new Date(Date.now() - DAY_MS - MINUTE_MS),
      });
      const decider = await admin();
      const made = await createDispute(t.db, {
        marketId: market.id,
        status: 'dismissed',
        decidedBy: decider,
      });
      expect(made.dispute).toMatchObject({
        status: 'dismissed',
        decidedBy: decider,
        decidedAt: new Date(made.dispute.submittedAt.getTime() + 1),
        decisionReason: expect.any(String) as unknown,
        retractedAt: null,
      });
      expect(made.fill).toMatchObject({ marketId: market.id });
      expect(await hasMarketFill(t.db, made.dispute.userId, market.id)).toBe(true);
      expect(made.market.disputeHoldCount).toBe(0);
      const { dispute: pending, market: held } = await createDispute(t.db, {
        marketId: market.id,
        fill: false,
      });
      expect(held.disputeHoldCount).toBe(1);
      expect(await hasMarketFill(t.db, pending.userId, market.id)).toBe(false);
      await expect(resolveMarketNow(t.db, market.id)).rejects.toThrow(/held by a 판정 이의/);
      expect(await rowOf(market.id)).toEqual(held);
      await decide(pending.id, decider, 'dismiss');
      expect((await resolveMarketNow(t.db, market.id)).market.status).toBe('resolved');
      // Without a market: a fresh PROVISIONAL one.
      const fresh = await createDispute(t.db, { status: 'retracted' });
      expect(fresh.market).toMatchObject({ status: 'provisional', disputeHoldCount: 0 });
      expect(fresh.dispute.retractedAt).toEqual(new Date(fresh.dispute.submittedAt.getTime() + 1));
      const rows = await t.db
        .select()
        .from(marketDisputes)
        .orderBy(asc(marketDisputes.submittedAt));
      expect(rows).toHaveLength(3);
    });
  });
});
