import { randomUUID } from 'node:crypto';
import {
  MARKET_NO_FILL_CANCEL_REASON,
  MARKET_PAUSE_DECISION_APPROVAL_KIND,
  MARKET_STATUSES,
  type MarketPausePath,
  type MarketPauseReviewResult,
} from '@buddha/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  currentMarketPause,
  endMarketPause,
  endPauseAtClose,
  pauseMarket,
  readMarketPauses,
  type EndMarketPauseInput,
  type PauseMarketInput,
} from './market-pause.js';
import { ledgerHeldMarketIds } from './ledger-held-markets.js';
import { runMarketReconciliation } from './reconciliation-audit.js';
import { lockMarketOrders } from './order-cancel.js';
import { approvalRequests, marketEvents, marketPauses, markets, orders } from './schema/index.js';
import {
  closeMarketEarly,
  createApprovalRequest,
  createFill,
  createMarket,
  createMarketPause,
  createOpenedMarket,
  createPauseDecision,
  createPausedMarket,
  createUser,
  resumeMarket,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { balanceOf, fundMarketMakerFunds, ledgerAccountBalance } from './test/ledger.js';
import {
  checkOrderInvariants,
  closeTestMarket,
  openOrderIntake,
  passMarketClose,
  placeTestOrder,
} from './test/orders.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

const HOUR_MS = 60 * 60 * 1000;
const NOTE = '조기 결과가 공개되어 거래를 멈춘다.';

type Pausing = Omit<PauseMarketInput, 'market' | 'orders' | 'now'>;
type Ending = Omit<EndMarketPauseInput, 'market' | 'orders' | 'now'>;

describe.skipIf(!hasTestDb())('market pauses (#114, docker test profile)', () => {
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

  const eventsOf = (marketId: string) =>
    t.db
      .select()
      .from(marketEvents)
      .where(eq(marketEvents.marketId, marketId))
      .orderBy(asc(marketEvents.id));

  const rowOf = async (marketId: string) => {
    const [row] = await t.db.select().from(markets).where(eq(markets.id, marketId));
    return row!;
  };

  const pausesOf = (marketId: string) =>
    t.db.select().from(marketPauses).where(eq(marketPauses.marketId, marketId));

  const admin = async () => (await createUser(t.db, { role: 'admin' })).user.id;

  /**
   * As the API pauses: the market lock, the row FOR UPDATE after it, its orders locked
   * (`lockMarketOrders`), then `now` — the database clock after the locks, unless a boundary case
   * gives the instant itself.
   */
  function pause(marketId: string, input: Pausing, at?: Date) {
    return t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const [market] = await tx
        .select()
        .from(markets)
        .where(eq(markets.id, marketId))
        .for('update');
      const orders = await lockMarketOrders(tx, marketId);
      const now = at ?? (await clockTimestamp(tx));
      return { now, result: await pauseMarket(tx, { market: market!, orders, now, ...input }) };
    });
  }

  /** As the approval ends a pause: the same locks and clock, in one transaction. */
  function end(marketId: string, input: Ending, at?: Date) {
    return t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const [market] = await tx
        .select()
        .from(markets)
        .where(eq(markets.id, marketId))
        .for('update');
      const orders = await lockMarketOrders(tx, marketId);
      const now = at ?? (await clockTimestamp(tx));
      return { now, result: await endMarketPause(tx, { market: market!, orders, now, ...input }) };
    });
  }

  /** A next-path request of the market's lasting pause, approved by another admin. */
  async function approvedDecision(
    marketId: string,
    path: MarketPausePath,
    reviewResult: MarketPauseReviewResult | null,
    pauseId?: string,
  ) {
    const requestedBy = await admin();
    const approverId = await admin();
    const lasting = pauseId ?? (await currentMarketPause(t.db, marketId))!.id;
    const run = (await ledgerHeldMarketIds(t.db, [marketId])).has(marketId)
      ? await t.db.transaction((tx) =>
          runMarketReconciliation(tx, marketId, { source: 'recovery', actorId: requestedBy }),
        )
      : null;
    const recovery = run?.hold
      ? { holdId: run.hold.id, failureResultId: run.hold.failureResultId }
      : null;
    const request = await createApprovalRequest(t.db, {
      kind: MARKET_PAUSE_DECISION_APPROVAL_KIND,
      targetType: 'market',
      targetId: marketId,
      payload: {
        pauseId: lasting,
        path,
        reviewResult,
        recovery: recovery
          ? {
              ...recovery,
              failureResultId:
                recovery.failureResultId === null ? null : String(recovery.failureResultId),
            }
          : null,
      },
      requestedBy,
      decision: { status: 'approved', by: approverId },
    });
    const ending: Ending = {
      pause: { id: lasting },
      approverId,
      path,
      reviewResult,
      approvalId: request.id,
      recovery,
      requestedBy,
    };
    return { requestedBy, approverId, request, ending };
  }

  describe('pauseMarket', () => {
    it('keeps a pause note private without explicit publication confirmation and records its transition', async () => {
      const { market } = await createOpenedMarket(t.db);
      const before = await eventsOf(market.id);
      const actorId = await admin();
      const { now, result } = await pause(market.id, {
        actorId,
        reason: 'basis_change',
        note: NOTE,
        resultPublishedAt: null,
      });
      expect(result.paused).toBe(true);
      if (!result.paused) return;
      const events = await eventsOf(market.id);
      expect(events.slice(0, -1)).toEqual(before);
      expect(events.at(-1)).toEqual({
        id: result.eventId,
        marketId: market.id,
        type: 'paused',
        actorId,
        fromStatus: 'open',
        toStatus: 'paused',
        payload: { pauseId: result.pause.id, reason: 'basis_change', resultPublishedAt: null },
        createdAt: now,
      });
      // The row read back: the status, its event and instant — `open_at` and `close_at` stay.
      const row = await rowOf(market.id);
      expect(result.market).toEqual(row);
      expect(row).toEqual({
        ...market,
        status: 'paused',
        statusEventId: result.eventId,
        updatedAt: now,
      });
      expect(await pausesOf(market.id)).toEqual([result.pause]);
      expect(result.pause).toEqual({
        id: expect.any(String) as unknown,
        marketId: market.id,
        reason: 'basis_change',
        note: NOTE,
        resultPublishedAt: null,
        pausedAt: now,
        pausedBy: actorId,
        pauseEventId: result.eventId,
        reviewResult: null,
        endKind: null,
        endedAt: null,
        endedBy: null,
        endEventId: null,
        endApprovalId: null,
      });
      expect(await currentMarketPause(t.db, market.id)).toEqual(result.pause);
    });

    it('records explicit note publication provenance without copying the note into the event', async () => {
      const market = await createMarket(t.db);
      const actorId = await admin();
      const result = await createMarketPause(t.db, {
        marketId: market.id,
        by: actorId,
        reason: 'basis_change',
        note: NOTE,
        notePublic: true,
        resultPublishedAt: null,
      });
      expect((await eventsOf(market.id)).at(-1)?.payload).toEqual({
        pauseId: result.pause.id,
        reason: 'basis_change',
        resultPublishedAt: null,
        notePublic: true,
      });
      expect(result.pause.note).toBe(NOTE);
    });

    it('records the publication instant of an early result, up to the pause’s own instant', async () => {
      // ADR-0093 decision 3 '#114 조기 결과의 공개 시각': UTC, its own value, not after the pause.
      const market = await createMarket(t.db);
      const actorId = await admin();
      const at = await clockTimestamp(t.db);
      const published = { actorId, reason: 'early_result', note: NOTE } as const;
      expect(
        (
          await pause(
            market.id,
            { ...published, resultPublishedAt: new Date(at.getTime() + 1) },
            at,
          )
        ).result,
      ).toEqual({ paused: false, reason: 'published_after_pause' });
      expect(await eventsOf(market.id)).toEqual([]);
      expect(await pausesOf(market.id)).toEqual([]);
      const { result } = await pause(market.id, { ...published, resultPublishedAt: at }, at);
      expect(result).toMatchObject({
        paused: true,
        pause: { reason: 'early_result', resultPublishedAt: at, pausedAt: at },
      });
      expect((await eventsOf(market.id)).at(-1)?.payload).toEqual({
        pauseId: (await currentMarketPause(t.db, market.id))!.id,
        reason: 'early_result',
        resultPublishedAt: at.toISOString(),
      });
    });

    it.each(MARKET_STATUSES.filter((status) => status !== 'open'))(
      'skips a %s market as not_open, writing nothing',
      async (status) => {
        // A PAUSED one too: one pause at a time (the partial unique index holds it as well).
        const market = await createMarket(t.db, { status });
        const { result } = await pause(market.id, {
          actorId: await admin(),
          reason: 'ledger_failure',
          note: NOTE,
          resultPublishedAt: null,
        });
        expect(result).toEqual({ paused: false, reason: 'not_open' });
        expect(await rowOf(market.id)).toEqual(market);
        expect(await eventsOf(market.id)).toEqual([]);
        expect(await pausesOf(market.id)).toEqual([]);
      },
    );

    it('skips at its close to the millisecond as close_passed, and pauses a millisecond before', async () => {
      // A market stays OPEN past its close until the worker closes it: the clock refuses too.
      const closeAt = new Date((await clockTimestamp(t.db)).getTime() + HOUR_MS);
      const market = await createMarket(t.db, { closeAt });
      const input: Pausing = {
        actorId: await admin(),
        reason: 'early_result',
        note: NOTE,
        // After the pause too: the close is judged first.
        resultPublishedAt: new Date(closeAt.getTime() + 1),
      };
      expect((await pause(market.id, input, closeAt)).result).toEqual({
        paused: false,
        reason: 'close_passed',
      });
      expect(await eventsOf(market.id)).toEqual([]);
      const before = new Date(closeAt.getTime() - 1);
      expect(
        (await pause(market.id, { ...input, resultPublishedAt: before }, before)).result,
      ).toMatchObject({ paused: true, market: { status: 'paused', closeAt } });
    });

    it('throws on a publication instant the reason does not take, writing nothing', async () => {
      const market = await createMarket(t.db);
      const actorId = await admin();
      await expect(
        pause(market.id, { actorId, reason: 'early_result', note: NOTE, resultPublishedAt: null }),
      ).rejects.toThrow(
        "A pause for early_result is recorded with the result's publication instant",
      );
      await expect(
        pause(market.id, {
          actorId,
          reason: 'basis_change',
          note: NOTE,
          resultPublishedAt: new Date(),
        }),
      ).rejects.toThrow(
        "A pause for basis_change is recorded without the result's publication instant",
      );
      expect(await rowOf(market.id)).toEqual(market);
      expect(await eventsOf(market.id)).toEqual([]);
    });

    it('takes the whole transaction with a note the database refuses', async () => {
      const market = await createMarket(t.db);
      for (const note of [' ', 'x'.repeat(501)]) {
        await expect(
          pause(market.id, {
            actorId: await admin(),
            reason: 'ledger_failure',
            note,
            resultPublishedAt: null,
          }),
        ).rejects.toSatisfy(
          (error) =>
            (error as { cause?: { constraint?: string } }).cause?.constraint ===
            'market_pauses_note_check',
        );
      }
      expect(await rowOf(market.id)).toEqual(market);
      expect(await eventsOf(market.id)).toEqual([]);
    });
  });

  describe('endMarketPause', () => {
    it('resumes: the approver’s resumed event, the market OPEN with its first open, the pause ended', async () => {
      const { market: paused, pause: lasting } = await createPausedMarket(t.db);
      const { request, requestedBy, approverId, ending } = await approvedDecision(
        paused.id,
        'resume',
        'judgeable',
      );
      const before = await eventsOf(paused.id);
      const { now, result } = await end(paused.id, ending);
      expect(result.ended).toBe(true);
      if (!result.ended) return;
      const events = await eventsOf(paused.id);
      expect(events.slice(0, -1)).toEqual(before);
      expect(events.at(-1)).toEqual({
        id: result.eventId,
        marketId: paused.id,
        type: 'resumed',
        actorId: approverId,
        fromStatus: 'paused',
        toStatus: 'open',
        payload: {
          pauseId: lasting.id,
          approvalId: request.id,
          requestedBy,
          reviewResult: 'judgeable',
        },
        createdAt: now,
      });
      const row = await rowOf(paused.id);
      expect(result.market).toEqual(row);
      // `open_at` stays the first open's (the 신규 order reads it).
      expect(row).toEqual({
        ...paused,
        status: 'open',
        statusEventId: result.eventId,
        updatedAt: now,
      });
      expect(result.pause).toEqual({
        ...lasting,
        reviewResult: 'judgeable',
        endKind: 'resumed',
        endedAt: now,
        endedBy: approverId,
        endEventId: result.eventId,
        endApprovalId: request.id,
      });
      expect(await pausesOf(paused.id)).toEqual([result.pause]);
      expect(await currentMarketPause(t.db, paused.id)).toBeNull();
    });

    it('closes early: the closed event with source early_close, the close time kept, the pause ended', async () => {
      // 판정 불가 (#173 item 4): the early close only; the judgement applies the VOID rule (#152).
      const { market: paused, pause: lasting } = await createPausedMarket(t.db);
      // A fill a person's account is on, from before the pause: CLOSED, not CANCELLED (#20).
      await createFill(t.db, { marketId: paused.id, amountCoin: 50n, qty: 1 });
      const { request, requestedBy, approverId, ending } = await approvedDecision(
        paused.id,
        'early_close',
        'not_judgeable',
      );
      const { now, result } = await end(paused.id, ending);
      expect(result.ended).toBe(true);
      if (!result.ended) return;
      expect((await eventsOf(paused.id)).at(-1)).toEqual({
        id: result.eventId,
        marketId: paused.id,
        type: 'closed',
        actorId: approverId,
        fromStatus: 'paused',
        toStatus: 'closed',
        payload: {
          closedAt: now.toISOString(),
          source: 'early_close',
          pauseId: lasting.id,
          approvalId: request.id,
          requestedBy,
          reviewResult: 'not_judgeable',
        },
        createdAt: now,
      });
      // `close_at` is a rule-version item (#80): it stays the scheduled close.
      expect(await rowOf(paused.id)).toEqual({
        ...paused,
        status: 'closed',
        statusEventId: result.eventId,
        updatedAt: now,
      });
      expect(result.pause).toMatchObject({
        endKind: 'early_closed',
        reviewResult: 'not_judgeable',
        endedAt: now,
        endedBy: approverId,
        endEventId: result.eventId,
        endApprovalId: request.id,
      });
    });

    it('cancels early with no fill a person’s account is on, whatever the review result (#20)', async () => {
      // ADR-0107 결정 4 '#120·#20': PAUSED → CANCELLED, the result type empty, no judgement — the
      // system sentence as the reason, the approver the actor, the pause ended `early_closed`.
      for (const reviewResult of ['not_judgeable', 'judgeable'] as const) {
        const { market: paused, pause: lasting } = await createPausedMarket(t.db);
        const { request, requestedBy, approverId, ending } = await approvedDecision(
          paused.id,
          'early_close',
          reviewResult,
        );
        const { now, result } = await end(paused.id, ending);
        if (!result.ended) throw new Error('ended');
        expect((await eventsOf(paused.id)).at(-1)).toEqual({
          id: result.eventId,
          marketId: paused.id,
          type: 'cancelled',
          actorId: approverId,
          fromStatus: 'paused',
          toStatus: 'cancelled',
          payload: {
            cancelledAt: now.toISOString(),
            source: 'early_close',
            reason: MARKET_NO_FILL_CANCEL_REASON,
            pauseId: lasting.id,
            approvalId: request.id,
            requestedBy,
            reviewResult,
          },
          createdAt: now,
        });
        expect(await rowOf(paused.id)).toEqual({
          ...paused,
          status: 'cancelled',
          statusEventId: result.eventId,
          updatedAt: now,
        });
        expect(result.market).toMatchObject({ status: 'cancelled', resolvedResult: null });
        expect(result.pause).toMatchObject({
          endKind: 'early_closed',
          reviewResult,
          endedAt: now,
          endedBy: approverId,
          endEventId: result.eventId,
          endApprovalId: request.id,
        });
      }
    });

    it.each([
      ['early_result', 'resume'],
      ['ledger_failure', 'early_close'],
    ] as const)('ends a %s pause by %s with no review result', async (reason, path) => {
      const { market: paused } = await createPausedMarket(t.db, { reason });
      const { ending } = await approvedDecision(paused.id, path, null);
      const { result } = await end(paused.id, ending);
      expect(result).toMatchObject({
        ended: true,
        // No fill: the early close cancels (#20), the held market's too, after its recovery.
        market: { status: path === 'resume' ? 'open' : 'cancelled' },
        pause: {
          reason,
          reviewResult: null,
          endKind: path === 'resume' ? 'resumed' : 'early_closed',
        },
      });
      expect((await eventsOf(paused.id)).at(-1)?.payload).toMatchObject({ reviewResult: null });
    });

    it.each(MARKET_STATUSES.filter((status) => status !== 'paused'))(
      'skips a %s market as not_paused, writing nothing',
      async (status) => {
        const market = await createMarket(t.db, { status });
        const { ending } = await approvedDecision(market.id, 'resume', null, randomUUID());
        expect((await end(market.id, ending)).result).toEqual({
          ended: false,
          reason: 'not_paused',
        });
        expect(await rowOf(market.id)).toEqual(market);
        expect(await eventsOf(market.id)).toEqual([]);
      },
    );

    it('skips at its close to the millisecond as close_passed, before it looks at the pause', async () => {
      const closeAt = new Date((await clockTimestamp(t.db)).getTime() + HOUR_MS);
      const { market: paused, pause: lasting } = await createPausedMarket(t.db, { closeAt });
      // A request of another pause still answers close_passed: the close is judged first.
      const { ending: stale } = await approvedDecision(
        paused.id,
        'resume',
        'judgeable',
        randomUUID(),
      );
      expect((await end(paused.id, stale, closeAt)).result).toEqual({
        ended: false,
        reason: 'close_passed',
      });
      const { ending } = await approvedDecision(paused.id, 'early_close', 'judgeable');
      expect((await end(paused.id, ending, closeAt)).result).toEqual({
        ended: false,
        reason: 'close_passed',
      });
      expect(await rowOf(paused.id)).toEqual(paused);
      expect(await currentMarketPause(t.db, paused.id)).toEqual(lasting);
      const before = new Date(closeAt.getTime() - 1);
      // No fill a person's account is on: the early close cancels (#20).
      expect((await end(paused.id, ending, before)).result).toMatchObject({
        ended: true,
        market: { status: 'cancelled', closeAt },
        pause: { endedAt: before },
      });
    });

    it('skips a request of a pause that is not the lasting one as stale', async () => {
      // Two pauses in a row: the first resumed, then the market paused again.
      const { market } = await createOpenedMarket(t.db);
      const first = await createMarketPause(t.db, { marketId: market.id });
      await resumeMarket(t.db, market.id);
      const second = await createMarketPause(t.db, {
        marketId: market.id,
        reason: 'ledger_failure',
      });
      const { ending } = await approvedDecision(market.id, 'resume', 'judgeable', first.pause.id);
      expect((await end(market.id, ending)).result).toEqual({ ended: false, reason: 'stale' });
      // A PAUSED market written without a pause row has no lasting one either.
      const bare = await createMarket(t.db, { status: 'paused' });
      const { ending: none } = await approvedDecision(bare.id, 'resume', null, randomUUID());
      expect((await end(bare.id, none)).result).toEqual({ ended: false, reason: 'stale' });
      expect(await currentMarketPause(t.db, market.id)).toEqual(second.pause);
      expect((await rowOf(market.id)).status).toBe('paused');
    });

    it('throws on an approval by the requester or a review result the reason refuses', async () => {
      const { market: paused } = await createPausedMarket(t.db);
      const { ending } = await approvedDecision(paused.id, 'resume', 'judgeable');
      await expect(end(paused.id, { ...ending, approverId: ending.requestedBy })).rejects.toThrow(
        'A pause decision is approved by an admin other than its requester',
      );
      // The request refused these (pauseDecisionRefusal of @buddha/shared): a caller's bug here.
      for (const [change, message] of [
        [{ reviewResult: null }, "A basis_change pause's resume is refused: required"],
        [
          { reviewResult: 'not_judgeable' },
          "A basis_change pause's resume is refused: early close only",
        ],
      ] as const) {
        await expect(end(paused.id, { ...ending, ...change })).rejects.toThrow(message);
      }
      const { market: other } = await createPausedMarket(t.db, { reason: 'ledger_failure' });
      const { ending: given } = await approvedDecision(other.id, 'early_close', 'judgeable');
      await expect(end(other.id, given)).rejects.toThrow(
        "A ledger_failure pause's early_close is refused: only for basis_change",
      );
      expect(await rowOf(paused.id)).toEqual(paused);
      expect((await currentMarketPause(t.db, paused.id))?.endedAt).toBeNull();
    });
  });

  describe('endPauseAtClose', () => {
    it('ends the lasting pause at the close: closed_at_close, no approver, no request, no review', async () => {
      const { market: paused, pause: lasting } = await createPausedMarket(t.db);
      const now = await clockTimestamp(t.db);
      const [event] = await t.db
        .insert(marketEvents)
        .values({ marketId: paused.id, type: 'closed', fromStatus: 'paused', toStatus: 'closed' })
        .returning();
      const ended = await t.db.transaction((tx) =>
        endPauseAtClose(tx, { marketId: paused.id, now, eventId: event!.id }),
      );
      expect(ended).toEqual({
        ...lasting,
        endKind: 'closed_at_close',
        endedAt: now,
        endedBy: null,
        endEventId: event!.id,
        endApprovalId: null,
        reviewResult: null,
      });
      expect(await pausesOf(paused.id)).toEqual([ended]);
      // Nothing lasting any more: a second call is a no-op.
      expect(
        await t.db.transaction((tx) =>
          endPauseAtClose(tx, { marketId: paused.id, now, eventId: event!.id }),
        ),
      ).toBeNull();
      expect(await pausesOf(paused.id)).toEqual([ended]);
    });
  });

  describe('the resting orders (#178, ADR-0113)', () => {
    let opener: string;
    beforeEach(async () => {
      opener = await admin();
      await openOrderIntake(t.db, { adminId: opener });
    });

    const member = async () => (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    /** A resting GTC buy of `marketId`, placed through the intake (it holds its lock). */
    async function rest(ownerId: string, marketId: string, outcome: 'YES' | 'NO', price: number) {
      const done = await placeTestOrder(t.db, {
        ownerId,
        marketId,
        outcome,
        limitPriceCoin: price,
        qty: 2,
      });
      if (done.kind !== 'placed' || done.order.status !== 'open') throw new Error('not resting');
      return done.order;
    }
    const orderRow = async (id: string) =>
      (await t.db.select().from(orders).where(eq(orders.id, id)))[0]!;
    const lockedOf = async (userId: string) => (await balanceOf(t.db, userId))!.lockedCoin;

    it.each(['early_result', 'basis_change'] as const)(
      'cancels people’s and the 운영 마켓메이커’s orders at a %s pause, at its instant',
      async (reason) => {
        const market = await createMarket(t.db);
        const a = await member();
        const mm = await fundMarketMakerFunds(t.db, market.id, 1_000n);
        const rows = [await rest(a, market.id, 'YES', 40), await rest(mm, market.id, 'NO', 30)];
        const { now, result } = await pause(market.id, {
          actorId: await admin(),
          reason,
          note: NOTE,
          resultPublishedAt: reason === 'early_result' ? new Date(Date.now() - HOUR_MS) : null,
        });
        expect(result.paused).toBe(true);
        if (!result.paused) return;
        expect(result.cancelled.held).toEqual([]);
        expect(result.cancelled.cancelled).toEqual(
          rows.map((row) => ({
            ...row,
            status: 'cancelled',
            cancelReason: 'paused',
            endedAt: now,
            updatedAt: now,
          })),
        );
        expect(await lockedOf(a)).toBe(0n);
        expect(
          await ledgerAccountBalance(t.db, { kind: 'market_maker_funds', marketId: market.id }),
        ).toMatchObject({ lockedCoin: 0n });
        expect(await checkOrderInvariants(t.db)).toEqual([]);
      },
    );

    it('cancels nothing at a pause skipped as close_passed or published_after_pause: the judgments come first', async () => {
      // An OPEN market held by nothing, so a cancel before the skip would show (R25).
      const closeAt = new Date((await clockTimestamp(t.db)).getTime() + HOUR_MS);
      const market = await createMarket(t.db, { closeAt });
      const a = await member();
      const mm = await fundMarketMakerFunds(t.db, market.id, 1_000n);
      const rows = [await rest(a, market.id, 'YES', 40), await rest(mm, market.id, 'NO', 30)];
      const funds = { kind: 'market_maker_funds', marketId: market.id } as const;
      const mmBefore = await ledgerAccountBalance(t.db, funds);
      const actorId = await admin();
      expect(
        (
          await pause(
            market.id,
            { actorId, reason: 'basis_change', note: NOTE, resultPublishedAt: null },
            closeAt,
          )
        ).result,
      ).toEqual({ paused: false, reason: 'close_passed' });
      const at = await clockTimestamp(t.db);
      expect(
        (
          await pause(
            market.id,
            {
              actorId,
              reason: 'early_result',
              note: NOTE,
              resultPublishedAt: new Date(at.getTime() + 1),
            },
            at,
          )
        ).result,
      ).toEqual({ paused: false, reason: 'published_after_pause' });
      for (const row of rows) expect(await orderRow(row.id)).toEqual(row);
      expect(await lockedOf(a)).toBe(80n);
      expect(await ledgerAccountBalance(t.db, funds)).toEqual(mmBefore);
      expect(mmBefore).toMatchObject({ lockedCoin: 60n });
      expect(await eventsOf(market.id)).toEqual([]);
      expect(await pausesOf(market.id)).toEqual([]);
    });

    it('keeps the orders and their locks at a ledger_failure pause, and at a skipped one (not_open)', async () => {
      const market = await createMarket(t.db);
      const a = await member();
      const row = await rest(a, market.id, 'YES', 40);
      const { result } = await pause(market.id, {
        actorId: await admin(),
        reason: 'ledger_failure',
        note: NOTE,
        resultPublishedAt: null,
      });
      expect(result).toMatchObject({
        paused: true,
        cancelled: { cancelled: [], held: [], touched: { positions: [] } },
      });
      // A second pause of the PAUSED market is skipped: nothing written.
      expect(
        (
          await pause(market.id, {
            actorId: await admin(),
            reason: 'basis_change',
            note: NOTE,
            resultPublishedAt: null,
          })
        ).result,
      ).toEqual({ paused: false, reason: 'not_open' });
      expect(await orderRow(row.id)).toEqual(row);
      expect(await lockedOf(a)).toBe(80n);
    });

    it.each(['resume', 'early_close'] as const)(
      'ends a ledger_failure pause’s orders at its %s approval, before the status changes',
      async (path) => {
        const market = await createMarket(t.db);
        const a = await member();
        const row = await rest(a, market.id, 'YES', 40);
        await createMarketPause(t.db, { marketId: market.id, reason: 'ledger_failure' });
        expect(await orderRow(row.id)).toEqual(row);
        const { ending } = await approvedDecision(market.id, path, null);
        const { now, result } = await end(market.id, ending);
        expect(result.ended).toBe(true);
        if (!result.ended) return;
        expect(result.cancelled.cancelled).toEqual([
          { ...row, status: 'cancelled', cancelReason: 'paused', endedAt: now, updatedAt: now },
        ]);
        // The held market's 조기 마감 is its recovery: 취소 완료(일시 중단) first, no 만료 (#120),
        // then CANCELLED with no fill (#20) — held no longer, as after a resume.
        expect(result.expired).toEqual({ expired: [], held: [], touched: { positions: [] } });
        expect(result.market.status).toBe(path === 'resume' ? 'open' : 'cancelled');
        expect(await ledgerHeldMarketIds(t.db, [market.id])).toEqual(new Set());
        expect((await eventsOf(market.id)).at(-1)).toMatchObject({
          id: result.eventId,
          createdAt: now,
        });
        expect(await lockedOf(a)).toBe(0n);
        expect(await checkOrderInvariants(t.db)).toEqual([]);
      },
    );

    it('cancels nothing at a stale or close_passed decision, nor at the close', async () => {
      const closeAt = new Date((await clockTimestamp(t.db)).getTime() + HOUR_MS);
      const market = await createMarket(t.db, { closeAt });
      const a = await member();
      const row = await rest(a, market.id, 'YES', 40);
      await createMarketPause(t.db, { marketId: market.id, reason: 'ledger_failure' });
      const { ending: stale } = await approvedDecision(market.id, 'resume', null, randomUUID());
      expect((await end(market.id, stale)).result).toEqual({ ended: false, reason: 'stale' });
      const { ending } = await approvedDecision(market.id, 'resume', null);
      expect((await end(market.id, ending, closeAt)).result).toEqual({
        ended: false,
        reason: 'close_passed',
      });
      expect(await orderRow(row.id)).toEqual(row);
      // The close at `close_at` (#120): the pause ends `closed_at_close`, the order stays locked
      // (#93's recovery expires it).
      await passMarketClose(t.db, market.id);
      expect(await closeTestMarket(t.db, market.id)).toMatchObject({
        closed: true,
        pause: { endKind: 'closed_at_close' },
        expired: { expired: [], held: [row] },
      });
      expect(await orderRow(row.id)).toEqual(row);
      expect(await lockedOf(a)).toBe(80n);
    });

    it('expires what a non-held market’s 조기 마감 finds after the status changes (#120)', async () => {
      // A live order in a PAUSED market not held, which only a row from before #178 leaves: the
      // pause (basis_change) on an empty market, then an order rested while the status is raw OPEN.
      const market = await createMarket(t.db);
      await createMarketPause(t.db, { marketId: market.id, reason: 'basis_change' });
      const setStatus = (status: 'open' | 'paused') =>
        t.db.update(markets).set({ status }).where(eq(markets.id, market.id));
      await setStatus('open');
      const a = await member();
      const row = await rest(a, market.id, 'NO', 30);
      await setStatus('paused');
      const { ending } = await approvedDecision(market.id, 'early_close', 'not_judgeable');
      const { now, result } = await end(market.id, ending);
      if (!result.ended) throw new Error('ended');
      // The close's own processing: no 취소 완료(일시 중단), 만료 at the decision's instant.
      expect(result.cancelled).toEqual({ cancelled: [], held: [], touched: { positions: [] } });
      expect(result.expired.expired).toEqual([
        { ...row, status: 'expired', endedAt: now, updatedAt: now },
      ]);
      // The order never filled: CANCELLED (#20), with the same 만료.
      expect(result.market.status).toBe('cancelled');
      expect(await lockedOf(a)).toBe(0n);
      expect(await checkOrderInvariants(t.db)).toEqual([]);
    });

    it('cancels a resumed market’s leftover 일시 중단 before the status changes, as before', async () => {
      const market = await createMarket(t.db);
      await createMarketPause(t.db, { marketId: market.id, reason: 'basis_change' });
      await t.db.update(markets).set({ status: 'open' }).where(eq(markets.id, market.id));
      const a = await member();
      const row = await rest(a, market.id, 'NO', 30);
      await t.db.update(markets).set({ status: 'paused' }).where(eq(markets.id, market.id));
      const { ending } = await approvedDecision(market.id, 'resume', 'judgeable');
      const { now, result } = await end(market.id, ending);
      if (!result.ended) throw new Error('ended');
      expect(result.cancelled.cancelled).toEqual([
        { ...row, status: 'cancelled', cancelReason: 'paused', endedAt: now, updatedAt: now },
      ]);
      expect(result.expired.expired).toEqual([]);
      expect(await lockedOf(a)).toBe(0n);
    });

    it('takes the orders lockMarketOrders locked of that market, and nothing else', async () => {
      const market = await createMarket(t.db);
      const other = await createMarket(t.db);
      await expect(
        t.db.transaction(async (tx) => {
          await lockMarket(tx, market.id);
          const [row] = await tx.select().from(markets).where(eq(markets.id, market.id));
          const orders = await lockMarketOrders(tx, other.id);
          return pauseMarket(tx, {
            market: row!,
            orders,
            now: await clockTimestamp(tx),
            actorId: await admin(),
            reason: 'basis_change',
            note: NOTE,
            resultPublishedAt: null,
          });
        }),
      ).rejects.toThrow('A pause takes the orders lockMarketOrders locked of market');
    });
  });

  describe('two pauses in a row', () => {
    it('reads every pause newest first, the lasting one first, and ends only that one', async () => {
      const { market } = await createOpenedMarket(t.db);
      expect(await readMarketPauses(t.db, market.id)).toEqual([]);
      expect(await currentMarketPause(t.db, market.id)).toBeNull();
      const first = await createMarketPause(t.db, { marketId: market.id });
      const resumed = await resumeMarket(t.db, market.id);
      expect(resumed.market.status).toBe('open');
      const second = await createMarketPause(t.db, {
        marketId: market.id,
        reason: 'early_result',
      });
      const history = await readMarketPauses(t.db, market.id);
      expect(history.map((row) => [row.id, row.endKind])).toEqual([
        [second.pause.id, null],
        [first.pause.id, 'resumed'],
      ]);
      expect(await currentMarketPause(t.db, market.id)).toEqual(second.pause);
      // Another market's pauses are not this one's.
      await createPausedMarket(t.db);
      expect(await readMarketPauses(t.db, market.id)).toHaveLength(2);

      const closed = await closeMarketEarly(t.db, market.id);
      expect(closed.pause).toMatchObject({ id: second.pause.id, endKind: 'early_closed' });
      expect((await readMarketPauses(t.db, market.id)).map((row) => row.endKind)).toEqual([
        'early_closed',
        'resumed',
      ]);
      expect((await eventsOf(market.id)).map((event) => event.type)).toEqual([
        'submitted',
        'approved',
        'opened',
        'paused',
        'resumed',
        'paused',
        'closed',
      ]);
    });
  });

  describe('the factories', () => {
    it('createPausedMarket walks the history: submitted, approved, opened, paused', async () => {
      const by = await admin();
      const {
        market,
        pause: lasting,
        eventId,
        request,
      } = await createPausedMarket(t.db, {
        reason: 'early_result',
        by,
      });
      const events = await eventsOf(market.id);
      expect(events.map((event) => [event.type, event.fromStatus, event.toStatus])).toEqual([
        ['submitted', 'draft', 'review'],
        ['approved', 'review', 'scheduled'],
        ['opened', 'scheduled', 'open'],
        ['paused', 'open', 'paused'],
      ]);
      expect(events.at(-1)).toMatchObject({ id: eventId, actorId: by });
      expect(market).toMatchObject({ status: 'paused', statusEventId: eventId, ruleVersion: 1 });
      // The publication instant a minute before the pause, unless given.
      expect(lasting.pausedAt.getTime() - lasting.resultPublishedAt!.getTime()).toBe(60_000);
      expect(request).toMatchObject({ status: 'approved', targetId: market.id });
      await expect(createMarketPause(t.db, { marketId: market.id })).rejects.toThrow(
        'createMarketPause: the market did not pause (not_open)',
      );
    });

    it('createPauseDecision opens a request of the lasting pause, the review by its reason', async () => {
      const { market: paused, pause: lasting } = await createPausedMarket(t.db);
      const by = await admin();
      const request = await createPauseDecision(t.db, {
        marketId: paused.id,
        path: 'early_close',
        by,
      });
      expect(request).toMatchObject({
        kind: MARKET_PAUSE_DECISION_APPROVAL_KIND,
        targetType: 'market',
        targetId: paused.id,
        payload: { pauseId: lasting.id, path: 'early_close', reviewResult: 'judgeable' },
        requestedBy: by,
        status: 'pending',
      });
      const { market: other } = await createPausedMarket(t.db, { reason: 'ledger_failure' });
      const rejecter = await admin();
      expect(
        await createPauseDecision(t.db, {
          marketId: other.id,
          path: 'resume',
          rejected: { by: rejecter },
        }),
      ).toMatchObject({
        payload: { path: 'resume', reviewResult: null },
        status: 'rejected',
        decidedBy: rejecter,
      });
      // Nothing of the market changes.
      expect(await rowOf(paused.id)).toEqual(paused);
    });

    it('closeMarketEarly pauses a bare OPEN market and closes it by another admin’s approval', async () => {
      // The replacement of the one-admin close for a test that needs CLOSED (ADR-0102).
      const market = await createMarket(t.db);
      const requestedBy = await admin();
      const approvedBy = await admin();
      const closed = await closeMarketEarly(t.db, market.id, { requestedBy, approvedBy });
      expect(closed.market).toMatchObject({
        status: 'closed',
        statusEventId: closed.eventId,
        closeAt: market.closeAt,
      });
      expect(closed.pause).toMatchObject({
        reason: 'basis_change',
        pausedBy: requestedBy,
        reviewResult: 'judgeable',
        endKind: 'early_closed',
        endedBy: approvedBy,
        endApprovalId: closed.request.id,
      });
      expect(closed.request).toMatchObject({
        kind: MARKET_PAUSE_DECISION_APPROVAL_KIND,
        status: 'approved',
        requestedBy,
        decidedBy: approvedBy,
      });
      expect(closed.request.decidedAt!.getTime()).toBeGreaterThan(
        closed.request.requestedAt.getTime(),
      );
      const [, event] = await eventsOf(market.id);
      expect(event).toMatchObject({
        id: closed.eventId,
        type: 'closed',
        actorId: approvedBy,
        payload: { source: 'early_close', requestedBy, reviewResult: 'judgeable' },
        createdAt: closed.pause.endedAt,
      });
      await expect(
        closeMarketEarly(t.db, market.id, { requestedBy: approvedBy, approvedBy }),
      ).rejects.toThrow('approvePauseDecision: the requester never approves the next path');
      await expect(closeMarketEarly(t.db, market.id)).rejects.toThrow(
        'approvePauseDecision: market',
      );
      expect(
        await t.db.select().from(approvalRequests).where(eq(approvalRequests.targetId, market.id)),
      ).toHaveLength(1);
    });

    it('closeMarketEarly records a person’s fill first unless told not to, then it cancels (#20)', async () => {
      const traded = await createMarket(t.db);
      const before = await closeMarketEarly(t.db, traded.id);
      expect(before.market.status).toBe('closed');
      // One records-only fill, and only when the market had none.
      const again = await createMarket(t.db);
      await createFill(t.db, { marketId: again.id, amountCoin: 30n, qty: 1 });
      expect((await closeMarketEarly(t.db, again.id)).market.status).toBe('closed');
      const fillsOf = async (marketId: string) =>
        (
          await t.db.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM fills WHERE market_id = ${marketId}`,
          )
        ).rows[0]!.n;
      expect([await fillsOf(traded.id), await fillsOf(again.id)]).toEqual([1, 1]);
      const empty = await createMarket(t.db);
      const cancelled = await closeMarketEarly(t.db, empty.id, { humanFill: false });
      expect(cancelled.market).toMatchObject({
        status: 'cancelled',
        statusEventId: cancelled.eventId,
        resolvedResult: null,
      });
      expect(cancelled.pause.endKind).toBe('early_closed');
      expect((await eventsOf(empty.id)).at(-1)).toMatchObject({
        type: 'cancelled',
        payload: { source: 'early_close', reason: MARKET_NO_FILL_CANCEL_REASON },
      });
      expect(await fillsOf(empty.id)).toBe(0);
    });
  });
});
