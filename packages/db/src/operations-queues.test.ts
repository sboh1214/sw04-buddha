import {
  OPERATIONS_STUCK_AFTER_MINUTES,
  isJudgementDelayed,
  longDelayDeadline,
  type AdminAwaitingJudgementMarket,
  type AdminOperationsFailure,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { payoutDelayedSql } from './ledger-held-markets.js';
import {
  readOperationsAwaitingJudgements,
  readOperationsClosingMarkets,
  readOperationsFailures,
  type OperationsReadOptions,
} from './operations-queues.js';
import {
  marketEvents,
  marketMakerRecallAttempts,
  markets,
  reconciliationHolds,
  reconciliationResults,
} from './schema/index.js';
import {
  createCorrectionRequest,
  createDispute,
  createJudgementDelay,
  createJudgementRequest,
  createMarket,
  createProvisionalMarket,
  createSettlementStep,
  type CreateMarketInput,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { clockTimestamp } from './tx-helpers.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const STUCK_MS = OPERATIONS_STUCK_AFTER_MINUTES * MINUTE_MS;

describe.skipIf(!hasTestDb())('운영 대기열 readers (#145, ADR-0163; integration)', () => {
  let t: TestDb;
  /** The instant every list of a case compares with (`asOf`), read from the database clock. */
  let now: Date;
  const at = (ms: number) => new Date(now.getTime() + ms);
  const asOf = (): OperationsReadOptions => ({ asOf: now });

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    now = await clockTimestamp(t.db);
  });

  /** Every page of a list, `limit` at a time, in order. */
  async function walk<T>(
    read: (
      cursor: string | undefined,
    ) => Promise<{ data: T[]; meta: { nextCursor: string | null } }>,
    start: string | null = null,
  ): Promise<T[]> {
    const rows: T[] = [];
    let cursor: string | undefined = start ?? undefined;
    for (let page = 0; page < 50; page += 1) {
      const { data, meta } = await read(cursor);
      rows.push(...data);
      if (meta.nextCursor === null) return rows;
      cursor = meta.nextCursor;
    }
    throw new Error('walk: too many pages');
  }

  /** A CLOSED market whose scheduled judgement is `judgement` (null: none, as before #22). */
  async function closedMarket(judgement: Date | null, input: CreateMarketInput = {}) {
    const close = judgement === null ? at(-2 * DAY_MS) : new Date(judgement.getTime() - DAY_MS);
    return createMarket(t.db, {
      status: 'closed',
      closeAt: close,
      eventDeadline: close,
      scheduledJudgementAt: judgement,
      ...input,
    });
  }

  // ---- 마감 예정 (145-1) ------------------------------------------------------------------
  describe('마감 예정', () => {
    it('lists OPEN and PAUSED markets closing within the window, overdue ones on top', async () => {
      const exactly24 = await createMarket(t.db, { closeAt: at(24 * HOUR_MS) });
      const past24 = await createMarket(t.db, { closeAt: at(24 * HOUR_MS + 1) });
      const overdue = await createMarket(t.db, { closeAt: at(-10 * MINUTE_MS) });
      const paused = await createMarket(t.db, { status: 'paused', closeAt: at(HOUR_MS) });
      await createMarket(t.db, { status: 'closed', closeAt: at(HOUR_MS) });
      await createMarket(t.db, { status: 'scheduled', closeAt: at(HOUR_MS) });
      const exactly72 = await createMarket(t.db, { closeAt: at(72 * HOUR_MS) });
      const exactly168 = await createMarket(t.db, { closeAt: at(168 * HOUR_MS) });
      await createMarket(t.db, { closeAt: at(168 * HOUR_MS + 1) });

      const ids = async (within: '24h' | '3d' | '7d') =>
        (await readOperationsClosingMarkets(t.db, { within }, asOf())).data.map((row) => row.id);
      expect(await ids('24h')).toEqual([overdue.id, paused.id, exactly24.id]);
      expect(await ids('3d')).toEqual([
        overdue.id,
        paused.id,
        exactly24.id,
        past24.id,
        exactly72.id,
      ]);
      expect(await ids('7d')).toEqual([
        overdue.id,
        paused.id,
        exactly24.id,
        past24.id,
        exactly72.id,
        exactly168.id,
      ]);
      // The default window is 24 hours (145-1).
      expect((await readOperationsClosingMarkets(t.db, {}, asOf())).data).toHaveLength(3);

      const [first, second] = (await readOperationsClosingMarkets(t.db, {}, asOf())).data;
      expect(first).toEqual({
        id: overdue.id,
        slug: overdue.slug,
        title: overdue.title,
        status: 'open',
        closeAt: overdue.closeAt.toISOString(),
        scheduledJudgementAt: overdue.scheduledJudgementAt!.toISOString(),
        overdue: true,
      });
      expect(second).toMatchObject({ status: 'paused', overdue: false });
    });

    it('pages across equal close times by id', async () => {
      const closeAt = at(2 * HOUR_MS);
      const made = await Promise.all([0, 1, 2].map(() => createMarket(t.db, { closeAt })));
      await createMarket(t.db, { closeAt: at(HOUR_MS) });
      const rows = await walk((cursor) =>
        readOperationsClosingMarkets(t.db, { cursor, limit: 1 }, asOf()),
      );
      expect(rows).toHaveLength(4);
      expect(rows.slice(1).map((row) => row.id)).toEqual(made.map((m) => m.id).sort());
      // A malformed cursor reads the first page.
      expect(
        (await readOperationsClosingMarkets(t.db, { cursor: 'nope', limit: 1 }, asOf())).data,
      ).toEqual([rows[0]]);
    });
  });

  // ---- 판정 대기·지연 (145-2) ---------------------------------------------------------------
  describe('판정 대기·지연', () => {
    const read = (filter: 'all' | 'delayed' = 'all') =>
      readOperationsAwaitingJudgements(t.db, { filter, limit: 100 }, asOf());
    const byId = (rows: AdminAwaitingJudgementMarket[], id: string) =>
      rows.find((row) => row.id === id);

    it('lists every CLOSED market and every PROVISIONAL one held past its deadline, with its stage', async () => {
      const unregistered = await closedMarket(at(-HOUR_MS));
      const awaiting = await closedMarket(at(-2 * HOUR_MS));
      const request = await createJudgementRequest(t.db, { marketId: awaiting.id });
      const notYet = await closedMarket(at(DAY_MS));
      const noJudgementTime = await closedMarket(null);

      const pastDeadline = () =>
        createProvisionalMarket(t.db, { publishedAt: at(-HOUR_MS), disputeWindowMinutes: 1 });
      const disputed = (await pastDeadline()).market;
      await createDispute(t.db, { marketId: disputed.id, submittedAt: at(-HOUR_MS) });
      const accepted = (await pastDeadline()).market;
      await createDispute(t.db, {
        marketId: accepted.id,
        status: 'accepted',
        submittedAt: at(-HOUR_MS),
      });
      const correcting = (await pastDeadline()).market;
      const correction = await createCorrectionRequest(t.db, {
        marketId: correcting.id,
        requestedAt: at(-30 * MINUTE_MS),
      });
      // Not listed: nothing holds it (the worker confirms it), or its deadline is ahead.
      await pastDeadline();
      const before = (await createProvisionalMarket(t.db, { publishedAt: at(-MINUTE_MS) })).market;
      await createDispute(t.db, { marketId: before.id, submittedAt: at(-MINUTE_MS) });
      await createMarket(t.db, { status: 'open' });

      const { data, meta } = await read();
      expect(meta.nextCursor).toBeNull();
      expect(new Set(data.map((row) => row.id))).toEqual(
        new Set([
          unregistered.id,
          awaiting.id,
          notYet.id,
          noJudgementTime.id,
          disputed.id,
          accepted.id,
          correcting.id,
        ]),
      );
      expect(byId(data, unregistered.id)).toMatchObject({
        status: 'closed',
        stage: 'unregistered',
        judgementRequestId: null,
        holdingDisputes: 0,
        correctionPending: false,
        delay: null,
        reviewOverdue: false,
        delayed: true,
        disputeDeadline: null,
      });
      expect(byId(data, awaiting.id)).toMatchObject({
        stage: 'awaiting_approval',
        judgementRequestId: request.id,
      });
      expect(byId(data, notYet.id)).toMatchObject({ stage: 'unregistered', delayed: false });
      expect(byId(data, noJudgementTime.id)).toMatchObject({
        scheduledJudgementAt: null,
        longDelayDeadline: null,
        longDelayReached: false,
        delayed: false,
      });
      expect(byId(data, disputed.id)).toMatchObject({
        status: 'provisional',
        stage: 'dispute_or_correction',
        holdingDisputes: 1,
        correctionPending: false,
        delayed: true,
      });
      expect(byId(data, accepted.id)).toMatchObject({ holdingDisputes: 1 });
      expect(byId(data, correcting.id)).toMatchObject({
        holdingDisputes: 0,
        correctionPending: true,
        judgementRequestId: correction.id,
      });

      // Scheduled judgement order, none last.
      const order = data.map((row) => row.scheduledJudgementAt);
      const known = order.filter((value): value is string => value !== null);
      expect(known).toEqual([...known].sort());
      expect(order.at(-1)).toBeNull();

      // '지연만' (145-2) keeps exactly the rows `isJudgementDelayed` reads delayed at the instant.
      for (const row of data) {
        expect(
          isJudgementDelayed(
            {
              status: row.status,
              scheduledJudgementAt: row.scheduledJudgementAt,
              disputeDeadline: row.disputeDeadline,
              disputeHoldCount: row.holdingDisputes,
              correctionPending: row.correctionPending,
            },
            now.getTime(),
          ),
          row.id,
        ).toBe(row.delayed);
      }
      const delayed = (await read('delayed')).data.map((row) => row.id);
      expect(delayed).toEqual(data.filter((row) => row.delayed).map((row) => row.id));
      expect(delayed).not.toContain(noJudgementTime.id);
      expect(delayed).not.toContain(notYet.id);
    });

    it('reads the scheduled judgement instant exactly: delayed from it on, to the millisecond', async () => {
      const judgement = at(-HOUR_MS);
      const market = await closedMarket(judgement);
      const delayedAt = async (instant: Date) =>
        (
          await readOperationsAwaitingJudgements(t.db, { filter: 'delayed' }, { asOf: instant })
        ).data.map((row) => row.id);
      expect(await delayedAt(judgement)).toEqual([market.id]);
      expect(await delayedAt(new Date(judgement.getTime() - 1))).toEqual([]);
    });

    it('labels a row with its current episode’s record only, and says when the review is late', async () => {
      const market = await closedMarket(at(-4 * DAY_MS));
      const late = await createJudgementDelay(t.db, {
        marketId: market.id,
        reason: '출처 발표가 늦어진다',
        recordedAt: at(-3 * DAY_MS),
      });
      let row = byId((await read()).data, market.id)!;
      expect(row.delay).toEqual({
        reason: '출처 발표가 늦어진다',
        nextReviewAt: late.delay.nextReviewAt.toISOString(),
        recordedAt: late.delay.recordedAt.toISOString(),
      });
      // Its next review (a day after the record) has passed: 갱신 대기.
      expect(row.reviewOverdue).toBe(true);
      const fresh = await createJudgementDelay(t.db, {
        marketId: market.id,
        reason: '다시 확인한다',
        recordedAt: at(-MINUTE_MS),
      });
      row = byId((await read()).data, market.id)!;
      expect(row.delay).toMatchObject({
        reason: '다시 확인한다',
        nextReviewAt: fresh.delay.nextReviewAt.toISOString(),
      });
      expect(row.reviewOverdue).toBe(false);

      // The judgement's approval ends the CLOSED episode: its records never label the
      // PROVISIONAL row (ADR-0106 결정 10-2).
      await createProvisionalMarket(t.db, {
        marketId: market.id,
        publishedAt: at(-2 * HOUR_MS),
        disputeWindowMinutes: 1,
      });
      await createDispute(t.db, { marketId: market.id, submittedAt: at(-2 * HOUR_MS + 1) });
      row = byId((await read()).data, market.id)!;
      expect(row).toMatchObject({ status: 'provisional', delay: null, reviewOverdue: false });
      await createJudgementDelay(t.db, { marketId: market.id, reason: '이의를 검토한다' });
      row = byId((await read()).data, market.id)!;
      expect(row.delay).toMatchObject({ reason: '이의를 검토한다' });
    });

    it('gives the long-delay deadline of the shared function, reached on CLOSED rows only (145-17)', async () => {
      // A scheduled judgement before a DST change in many zones: N × 24 hours of instants.
      const dst = await closedMarket(new Date('2026-03-01T12:00:00.000Z'), { longDelayDays: 14 });
      const recent = await closedMarket(at(-HOUR_MS), { longDelayDays: 1 });
      const none = await closedMarket(at(-HOUR_MS), { longDelayDays: null });
      const provisional = (
        await createProvisionalMarket(t.db, {
          market: {
            closeAt: new Date('2026-02-20T12:00:00.000Z'),
            eventDeadline: new Date('2026-02-20T12:00:00.000Z'),
            scheduledJudgementAt: new Date('2026-02-21T12:00:00.000Z'),
            longDelayDays: 1,
          },
          publishedAt: at(-HOUR_MS),
          disputeWindowMinutes: 1,
        })
      ).market;
      await createDispute(t.db, { marketId: provisional.id, submittedAt: at(-HOUR_MS) });
      const data = (await read()).data;
      for (const market of [dst, recent, none, provisional]) {
        const row = byId(data, market.id)!;
        const [stored] = await t.db.select().from(markets).where(eq(markets.id, market.id));
        expect(row.longDelayDeadline, market.id).toBe(
          longDelayDeadline(
            stored!.scheduledJudgementAt?.toISOString() ?? null,
            stored!.longDelayDays,
          ),
        );
      }
      expect(byId(data, dst.id)).toMatchObject({
        longDelayDeadline: '2026-03-15T12:00:00.000Z',
        longDelayReached: true,
      });
      expect(byId(data, recent.id)!.longDelayReached).toBe(false);
      expect(byId(data, none.id)).toMatchObject({
        longDelayDeadline: null,
        longDelayReached: false,
      });
      // Its deadline passed long ago, but a PROVISIONAL market already has a judgement.
      expect(byId(data, provisional.id)).toMatchObject({
        longDelayDeadline: '2026-02-22T12:00:00.000Z',
        longDelayReached: false,
      });
    });

    it('pages across the group with no scheduled judgement (CURSOR_NULL as infinity)', async () => {
      const first = await closedMarket(at(-2 * HOUR_MS));
      const second = await closedMarket(at(-HOUR_MS));
      const nulls = [await closedMarket(null), await closedMarket(null), await closedMarket(null)];
      const rows = await walk((cursor) =>
        readOperationsAwaitingJudgements(t.db, { cursor, limit: 2 }, asOf()),
      );
      expect(rows.map((row) => row.id)).toEqual([
        first.id,
        second.id,
        ...nulls.map((m) => m.id).sort(),
      ]);
      const single = await walk((cursor) =>
        readOperationsAwaitingJudgements(t.db, { cursor, limit: 1 }, asOf()),
      );
      expect(single).toEqual(rows);
    });
  });

  // ---- 정산 실패 · 처리 멈춤 · 봇 자금 회수 실패 (145-4, 145-8, 145-15) -------------------------
  describe('정산 실패', () => {
    const readAll = async () => (await readOperationsFailures(t.db, { limit: 100 }, asOf())).data;
    const kindsOf = (rows: AdminOperationsFailure[], id: string) =>
      rows.filter((row) => row.id === id).map((row) => row.kind);

    /** A planted market-reconciliation hold: the market's payout waits for a recovery. */
    async function holdLedger(marketId: string) {
      const [failure] = await t.db
        .insert(reconciliationResults)
        .values({
          scope: 'market',
          targetKey: `market:${marketId}`,
          marketId,
          accountId: null,
          userId: null,
          source: 'manual',
          actorId: null,
          passed: false,
          checkedAt: now,
          ledgerCursor: 0,
          findings: [{ code: 'account_balance', expected: '1', actual: '0' }],
          facts: {},
        })
        .returning();
      await t.db.insert(reconciliationHolds).values({
        scope: 'market',
        targetKey: `market:${marketId}`,
        marketId,
        userId: null,
        failureResultId: failure!.id,
        startedAt: now,
      });
    }

    const settling = (resolvedAgoMs: number, steps = false) =>
      createMarket(t.db, {
        status: 'settling',
        resolvedResult: 'YES',
        resolvedAt: at(-resolvedAgoMs),
        settlementSteps: steps,
      });

    it('lists the public 지급 지연 set as 정산 실패, with the step’s attempts and stored error', async () => {
      const failed = await settling(2 * HOUR_MS);
      await createSettlementStep(t.db, {
        marketId: failed.id,
        status: 'failed',
        attempts: 3,
        lastError: 'XX000 boom',
      });
      const reconcileFailed = await settling(3 * HOUR_MS);
      await createSettlementStep(t.db, {
        marketId: reconcileFailed.id,
        status: 'done',
        attempts: 2,
        completedAt: at(-3 * HOUR_MS),
        lastError: 'reconcile',
      });
      const held = await settling(HOUR_MS, true);
      await holdLedger(held.id);
      // SETTLED with a stale error: the past failure trail, not a failure (ADR-0118 결정 8).
      const settled = await createMarket(t.db, {
        status: 'settled',
        resolvedResult: 'YES',
        settlementSteps: false,
      });
      await createSettlementStep(t.db, {
        marketId: settled.id,
        status: 'done',
        attempts: 2,
        completedAt: at(-HOUR_MS),
        lastError: 'old',
      });
      // A payout that started minutes ago and has not failed: nothing yet.
      const fresh = await settling(MINUTE_MS, true);

      const rows = await readAll();
      expect(rows.map((row) => [row.kind, row.id])).toEqual([
        ['settlement_failed', reconcileFailed.id],
        ['settlement_failed', failed.id],
        ['settlement_failed', held.id],
      ]);
      expect(rows[1]).toEqual({
        id: failed.id,
        slug: failed.slug,
        title: failed.title,
        status: 'settling',
        since: at(-2 * HOUR_MS).toISOString(),
        kind: 'settlement_failed',
        retryable: true,
        settlement: {
          stepStatus: 'failed',
          settlementAttempts: 3,
          settlementLastError: 'XX000 boom',
          lastAttemptAt: expect.any(String) as string,
          ledgerHeld: false,
        },
      });
      expect(rows[0]).toMatchObject({
        settlement: { stepStatus: 'done', settlementAttempts: 2, settlementLastError: 'reconcile' },
      });
      // Held, not stuck: a ledger-held market is never in two kinds.
      expect(rows[2]).toMatchObject({
        settlement: { stepStatus: 'pending', settlementAttempts: 0, ledgerHeld: true },
      });
      expect(kindsOf(rows, settled.id)).toEqual([]);
      expect(kindsOf(rows, fresh.id)).toEqual([]);

      // The same fragment as the public record's `payoutDelayed` (ADR-0121).
      for (const market of [failed, reconcileFailed, held, fresh]) {
        const [read] = await t.db
          .select({ delayed: payoutDelayedSql(markets.id) })
          .from(markets)
          .where(eq(markets.id, market.id));
        expect(read!.delayed, market.id).toBe(kindsOf(rows, market.id).length > 0);
      }
    });

    it('lists each automatic transition 30 minutes late as 처리 멈춤, and not at 29 (145-4)', async () => {
      const late = STUCK_MS + MINUTE_MS;
      const early = STUCK_MS - MINUTE_MS;
      const close = await createMarket(t.db, { closeAt: at(-late) });
      const closeEarly = await createMarket(t.db, { closeAt: at(-early) });
      const pausedClose = await createMarket(t.db, { status: 'paused', closeAt: at(-late) });
      const confirm = (
        await createProvisionalMarket(t.db, {
          publishedAt: at(-late - MINUTE_MS),
          disputeWindowMinutes: 1,
        })
      ).market;
      const confirmEarly = (
        await createProvisionalMarket(t.db, {
          publishedAt: at(-early - MINUTE_MS),
          disputeWindowMinutes: 1,
        })
      ).market;
      // Held past its deadline: 판정 대기·지연's, never 처리 멈춤.
      const held = (
        await createProvisionalMarket(t.db, {
          publishedAt: at(-2 * HOUR_MS),
          disputeWindowMinutes: 1,
        })
      ).market;
      await createDispute(t.db, { marketId: held.id, submittedAt: at(-2 * HOUR_MS) });
      const start = await createMarket(t.db, {
        status: 'resolved',
        resolvedResult: 'NO',
        resolvedAt: at(-late),
      });
      const startEarly = await createMarket(t.db, {
        status: 'resolved',
        resolvedResult: 'NO',
        resolvedAt: at(-early),
      });
      const complete = await settling(late, true);
      const completeEarly = await settling(early, true);

      const rows = await readAll();
      const stuck = rows.filter((row) => row.kind === 'stuck');
      expect(new Set(stuck.map((row) => row.id))).toEqual(
        new Set([close.id, pausedClose.id, confirm.id, start.id, complete.id]),
      );
      for (const id of [closeEarly.id, confirmEarly.id, held.id, startEarly.id, completeEarly.id]) {
        expect(kindsOf(rows, id), id).toEqual([]);
      }
      const of = (id: string) => stuck.find((row) => row.id === id)!;
      expect(of(close.id)).toMatchObject({
        stage: 'close',
        status: 'open',
        since: close.closeAt.toISOString(),
        retryable: false,
      });
      expect(of(pausedClose.id)).toMatchObject({ stage: 'close', status: 'paused' });
      expect(of(confirm.id)).toMatchObject({
        stage: 'confirm',
        since: confirm.disputeDeadline!.toISOString(),
        retryable: false,
      });
      expect(of(start.id)).toMatchObject({ stage: 'start', retryable: false });
      // 145-14: the retry is for SETTLING markets only.
      expect(of(complete.id)).toMatchObject({ stage: 'complete', retryable: true });
    });

    it('starts a confirmation’s 30 minutes at the last hold’s clearing, not at the deadline', async () => {
      const make = async (clearedAgoMs: number) => {
        const { market } = await createProvisionalMarket(t.db, {
          publishedAt: at(-3 * HOUR_MS),
          disputeWindowMinutes: 60,
        });
        await createDispute(t.db, {
          marketId: market.id,
          status: 'dismissed',
          submittedAt: at(-3 * HOUR_MS + MINUTE_MS),
          decidedAt: at(-clearedAgoMs),
        });
        return market;
      };
      const recent = await make(STUCK_MS - MINUTE_MS);
      const older = await make(STUCK_MS + 10 * MINUTE_MS);
      const rows = await readAll();
      expect(kindsOf(rows, recent.id)).toEqual([]);
      expect(rows.find((row) => row.id === older.id)).toMatchObject({
        kind: 'stuck',
        stage: 'confirm',
        since: at(-(STUCK_MS + 10 * MINUTE_MS)).toISOString(),
      });
    });

    /** A SETTLED or CANCELLED market whose terminal event (`status_event_id`) is `endedAgoMs` old. */
    const ended = async (status: 'settled' | 'cancelled', endedAgoMs: number) => {
      const market = await createMarket(t.db, {
        status,
        resolvedResult: status === 'settled' ? 'YES' : null,
      });
      const [event] = await t.db
        .insert(marketEvents)
        .values({
          marketId: market.id,
          type: status,
          toStatus: status,
          createdAt: at(-endedAgoMs),
        })
        .returning({ id: marketEvents.id });
      await t.db.update(markets).set({ statusEventId: event!.id }).where(eq(markets.id, market.id));
      return market;
    };
    const failRecall = (marketId: string, failedAt: Date, attempts = 1) =>
      t.db
        .insert(marketMakerRecallAttempts)
        .values({
          marketId,
          attempts,
          state: 'failed',
          reason: 'books_inconsistent',
          lastAttemptAt: failedAt,
          lastFailureAt: failedAt,
          lastFailureReason: 'books_inconsistent',
        })
        .onConflictDoUpdate({
          target: marketMakerRecallAttempts.marketId,
          set: { attempts, lastAttemptAt: failedAt, lastFailureAt: failedAt },
        });

    it('lists a failed bot recall of a terminal market, never a waiting one (145-15)', async () => {
      const failed = await ended('settled', 2 * HOUR_MS);
      const waiting = await createMarket(t.db, { status: 'cancelled' });
      const done = await createMarket(t.db, { status: 'cancelled' });
      await t.db.insert(marketMakerRecallAttempts).values([
        {
          marketId: failed.id,
          attempts: 4,
          state: 'failed',
          reason: 'execution_failed',
          lastAttemptAt: at(-HOUR_MS),
          lastFailureAt: at(-HOUR_MS),
          lastFailureReason: 'execution_failed',
        },
        {
          marketId: waiting.id,
          attempts: 2,
          state: 'waiting',
          reason: 'ledger_hold',
          lastAttemptAt: at(-HOUR_MS),
        },
        { marketId: done.id, attempts: 1, state: 'completed', lastAttemptAt: at(-HOUR_MS) },
      ]);
      const rows = await readAll();
      expect(rows).toEqual([
        {
          id: failed.id,
          slug: failed.slug,
          title: failed.title,
          status: 'settled',
          // Since the market ended, not the last failure (that is `recall.lastFailureAt`).
          since: at(-2 * HOUR_MS).toISOString(),
          kind: 'recall_failed',
          retryable: false,
          recall: {
            recallAttempts: 4,
            recallReason: 'execution_failed',
            lastFailureAt: at(-HOUR_MS).toISOString(),
          },
        },
      ]);
    });

    it('orders by since, then kind, then id, and every page carries the cursor in each branch', async () => {
      const tie = at(-2 * HOUR_MS);
      const failed = await settling(2 * HOUR_MS);
      await createSettlementStep(t.db, { marketId: failed.id, status: 'failed', attempts: 1 });
      const closes = [
        await createMarket(t.db, { closeAt: tie }),
        await createMarket(t.db, { closeAt: tie }),
      ];
      const recall = await ended('cancelled', 2 * HOUR_MS);
      await failRecall(recall.id, at(-MINUTE_MS));
      const older = await createMarket(t.db, { closeAt: at(-3 * HOUR_MS) });
      const all = await readAll();
      expect(all.map((row) => row.id)).toEqual([
        older.id,
        failed.id,
        ...closes.map((m) => m.id).sort(),
        recall.id,
      ]);
      for (const limit of [1, 2, 3]) {
        const paged = await walk((cursor) =>
          readOperationsFailures(t.db, { cursor, limit }, asOf()),
        );
        expect(paged, String(limit)).toEqual(all);
      }
    });

    it('keeps a recall row in its place while the minute scan fails it again between pages', async () => {
      const a = await ended('cancelled', 3 * HOUR_MS);
      const b = await ended('settled', 2 * HOUR_MS);
      await failRecall(a.id, at(-HOUR_MS));
      await failRecall(b.id, at(-30 * MINUTE_MS));
      const first = await readOperationsFailures(t.db, { limit: 1 }, asOf());
      expect(first.data.map((row) => row.id)).toEqual([a.id]);
      // The next scan fails a's recall again: its last failure moves to after the page's cursor.
      await failRecall(a.id, at(MINUTE_MS), 2);
      const rest = await walk(
        (cursor) => readOperationsFailures(t.db, { cursor, limit: 1 }, asOf()),
        first.meta.nextCursor,
      );
      expect(rest.map((row) => row.id)).toEqual([b.id]);
      expect((await readAll()).map((row) => row.id)).toEqual([a.id, b.id]);
    });
  });
});
