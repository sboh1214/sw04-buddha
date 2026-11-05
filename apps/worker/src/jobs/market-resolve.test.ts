/**
 * market.resolve integration test (#152, ADR-0103) against the docker `test` profile, as
 * market-open.test.ts: the database through the packages/db harness, Redis through
 * TEST_REDIS_URL (the events a confirmation publishes are read back on a raw subscriber). What the
 * confirmation judges and writes is `resolveProvisionalMarket`'s, tested in packages/db
 * (market-judgement.test.ts); this covers the worker's transaction around it, the publish, the
 * finalize it registers (a recording stub here; market-jobs.test.ts the queue), and the scan's
 * selection and order — with #175's hold (ADR-0104): a market a 판정 이의 holds is skipped as `held`
 * and left out of the scan, and the job registered after the last dismissal confirms it — and
 * #176's (ADR-0105): a waiting correction holds it alike, the old deadline's job of a corrected
 * market is `not_due`, and the corrected version is confirmed at its new deadline. Skips when
 * either is unset, exactly like ledger-audit.test.ts.
 */
import { randomUUID } from 'node:crypto';
import {
  clockTimestamp,
  decideMarketDispute,
  lockAdminRoles,
  lockMarket,
  reopenAcceptedDisputes,
  retractMarketDispute,
  schema,
  setCorrectionPending,
} from '@buddha/db';
import {
  connectTestDb,
  createCorrectedMarket,
  createCorrectionRequest,
  createDispute,
  createMarket,
  createProvisionalMarket,
  createUser,
  hasTestDb,
  mintTestPairs,
  type TestDb,
} from '@buddha/db/test';
import { MARKET_STATUSES, marketChannel } from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type EnqueueFinalize } from '../market-jobs.js';
import { createPublisher, createPublisherRedis, type Publish } from '../realtime.js';
import { finalizeMarket } from './market-finalize.js';
import { resolveDueMarkets, resolveMarket } from './market-resolve.js';

// hasTestDb() loads the root .env first, so TEST_REDIS_URL is visible after it.
const hasTestInfra = hasTestDb() && Boolean(process.env.TEST_REDIS_URL);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `received` holds `count` messages (bounded), so a lost publish fails loudly. */
async function waitForMessages(received: unknown[], count: number, what: string): Promise<void> {
  const started = Date.now();
  while (received.length < count) {
    if (Date.now() - started > 5_000) {
      throw new Error(`${what}: ${String(received.length)} of ${String(count)} received`);
    }
    await sleep(20);
  }
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

describe.skipIf(!hasTestInfra)('market.resolve (integration)', () => {
  let t: TestDb;
  let redis: Redis;
  let publish: Publish;
  let enqueued: { marketId: string; resolvedAt: Date }[];
  let enqueueFinalize: EnqueueFinalize;

  beforeAll(async () => {
    t = await connectTestDb();
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    publish = createPublisher(redis, pino({ level: 'silent' }));
  });
  afterAll(async () => {
    await redis?.quit();
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    enqueued = [];
    enqueueFinalize = (marketId, resolvedAt) => {
      enqueued.push({ marketId, resolvedAt });
      return Promise.resolve();
    };
  });

  async function marketRow(id: string) {
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, id));
    return row!;
  }

  async function eventsOf(marketId: string) {
    return t.db
      .select()
      .from(schema.marketEvents)
      .where(eq(schema.marketEvents.marketId, marketId))
      .orderBy(asc(schema.marketEvents.id));
  }

  async function stepsOf(marketId: string) {
    return t.db
      .select()
      .from(schema.marketSettlementSteps)
      .where(eq(schema.marketSettlementSteps.marketId, marketId));
  }

  /** A subscriber on the market's channel; messages land in the returned array. */
  async function subscribeTo(marketId: string) {
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel: string, message: string) => received.push(message));
    await subscriber.subscribe(marketChannel(marketId));
    return { received, quit: () => subscriber.quit() };
  }

  /**
   * A PROVISIONAL market with its history (#152): its judgement approved `ago` ms before now under
   * a one-minute window — due by default, its deadline a minute past.
   */
  async function provisional(ago = 2 * MINUTE_MS, result: 'YES' | 'NO' | 'VOID' = 'YES') {
    return createProvisionalMarket(t.db, {
      result,
      publishedAt: new Date(Date.now() - ago),
      disputeWindowMinutes: 1,
    });
  }

  it('confirms a due provisional market: resolved status, worker event, the steps, a published status and its finalize', async () => {
    const { market, judgement } = await provisional(2 * MINUTE_MS, 'NO');
    const { received, quit } = await subscribeTo(market.id);
    try {
      const result = await resolveMarket(t.db, market.id, publish, enqueueFinalize);
      expect(result).toMatchObject({
        outcome: 'resolved',
        marketId: market.id,
        resolvedResult: 'NO',
      });
      if (result.outcome !== 'resolved') return;

      const events = await eventsOf(market.id);
      expect(events.map((event) => event.type)).toEqual(['provisional', 'resolved']);
      expect(events.at(-1)).toMatchObject({
        id: result.statusEventId,
        // The worker acted, not an admin (market_events.actor_id is null for the worker).
        actorId: null,
        fromStatus: 'provisional',
        toStatus: 'resolved',
        payload: { version: 1, result: 'NO', source: 'deadline' },
        createdAt: result.resolvedAt,
      });
      expect(result.resolvedAt.getTime()).toBeGreaterThanOrEqual(
        judgement.disputeDeadline.getTime(),
      );
      expect(await marketRow(market.id)).toEqual({
        ...market,
        status: 'resolved',
        statusEventId: result.statusEventId,
        updatedAt: result.resolvedAt,
        resolvedAt: result.resolvedAt,
      });
      expect(await stepsOf(market.id)).toEqual([
        expect.objectContaining({ step: 'coin', status: 'pending', attempts: 0 }),
      ]);

      await waitForMessages(received, 1, 'market:status');
      expect(JSON.parse(received[0]!)).toEqual({
        type: 'market:status',
        marketId: market.id,
        status: 'resolved',
        resolvedResult: 'NO',
        statusEventId: String(result.statusEventId),
        ts: result.resolvedAt.toISOString(),
      });
      // The payout is registered at once, under the confirmation's instant (marketFinalizeJobId).
      expect(enqueued).toEqual([{ marketId: market.id, resolvedAt: result.resolvedAt }]);
    } finally {
      await quit();
    }
  });

  it('skips a market whose deadline has not come (a delayed job early on its clock), publishing nothing', async () => {
    const { market } = await provisional(0);
    const { received, quit } = await subscribeTo(market.id);
    try {
      await expect(resolveMarket(t.db, market.id, publish, enqueueFinalize)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_due',
      });
      expect(await marketRow(market.id)).toEqual(market);
      expect((await eventsOf(market.id)).map((event) => event.type)).toEqual(['provisional']);
      expect(await stepsOf(market.id)).toEqual([]);
      await sleep(100);
      expect(received).toEqual([]);
      expect(enqueued).toEqual([]);
    } finally {
      await quit();
    }
  });

  // Every status but `provisional`: a CLOSED one not yet judged, and every status past it — a job
  // that fires after the scan confirmed the market.
  it.each(MARKET_STATUSES.filter((status) => status !== 'provisional'))(
    'skips a %s market even when a dispute deadline has passed',
    async (status) => {
      const market = await createMarket(t.db, {
        status,
        disputeDeadline: new Date(Date.now() - MINUTE_MS),
        settlementSteps: false,
      });
      await expect(resolveMarket(t.db, market.id, publish, enqueueFinalize)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_provisional',
      });
      expect(await marketRow(market.id)).toEqual(market);
      expect(await eventsOf(market.id)).toEqual([]);
      expect(enqueued).toEqual([]);
    },
  );

  it('rejects an unknown market id instead of skipping it (a broken producer must be visible)', async () => {
    await expect(resolveMarket(t.db, randomUUID(), publish, enqueueFinalize)).rejects.toThrow(
      /not found/,
    );
  });

  it('is idempotent: a second run (a duplicate job, or the scan after the delayed job) is a no-op', async () => {
    const { market } = await provisional();
    const first = await resolveMarket(t.db, market.id, publish, enqueueFinalize);
    expect(first.outcome).toBe('resolved');
    const resolved = await marketRow(market.id);
    const { received, quit } = await subscribeTo(market.id);
    try {
      await expect(resolveMarket(t.db, market.id, publish, enqueueFinalize)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_provisional',
      });
      expect(await marketRow(market.id)).toEqual(resolved);
      expect((await eventsOf(market.id)).filter((event) => event.type === 'resolved')).toHaveLength(
        1,
      );
      expect(await stepsOf(market.id)).toHaveLength(1);
      await sleep(100);
      expect(received).toEqual([]);
      expect(enqueued).toHaveLength(1);
    } finally {
      await quit();
    }
  });

  it('confirms once when two runs race on one market (the job and the scan, or two workers)', async () => {
    // The market lock serialises them: the second reads the row after the first commits.
    const { market } = await provisional();
    const outcomes = await Promise.all([
      resolveMarket(t.db, market.id, publish, enqueueFinalize),
      resolveMarket(t.db, market.id, publish, enqueueFinalize),
    ]);
    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(['resolved', 'skipped']);
    expect(outcomes.find((outcome) => outcome.outcome === 'skipped')).toEqual({
      outcome: 'skipped',
      marketId: market.id,
      reason: 'not_provisional',
    });
    expect((await marketRow(market.id)).status).toBe('resolved');
    expect((await eventsOf(market.id)).filter((event) => event.type === 'resolved')).toHaveLength(
      1,
    );
    expect(await stepsOf(market.id)).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
  });

  it('scan confirms every due provisional market, earliest deadline first, and leaves the rest alone', async () => {
    const later = (await provisional(2 * MINUTE_MS)).market;
    const earlier = (await provisional(3 * MINUTE_MS, 'VOID')).market;
    const future = (await provisional(0)).market;
    // Due by their deadline, in a status the confirmation does not take.
    const closed = await createMarket(t.db, {
      status: 'closed',
      disputeDeadline: new Date(Date.now() - DAY_MS),
    });
    const resolvedBefore = await createMarket(t.db, {
      status: 'resolved',
      resolvedResult: 'YES',
      judgementVersion: 1,
      disputeDeadline: new Date(Date.now() - DAY_MS),
    });
    const left = [future, closed, resolvedBefore];

    const subscribers = await Promise.all([later, earlier, future].map((m) => subscribeTo(m.id)));
    try {
      // `skipped: 0`: the market not yet due was not examined at all.
      await expect(resolveDueMarkets(t.db, publish, enqueueFinalize)).resolves.toEqual({
        resolved: 2,
        skipped: 0,
        failed: 0,
        failures: [],
      });
      expect(await marketRow(earlier.id)).toMatchObject({
        status: 'resolved',
        resolvedResult: 'VOID',
      });
      expect((await marketRow(later.id)).status).toBe('resolved');
      for (const market of left) expect(await marketRow(market.id)).toEqual(market);

      // Each confirmation is its own transaction, in deadline order: the earlier one's event has
      // the smaller id.
      const [earlierEvent] = (await eventsOf(earlier.id)).filter((e) => e.type === 'resolved');
      const [laterEvent] = (await eventsOf(later.id)).filter((e) => e.type === 'resolved');
      expect(earlierEvent!.id).toBeLessThan(laterEvent!.id);
      expect(enqueued.map((entry) => entry.marketId)).toEqual([earlier.id, later.id]);
      for (const market of [closed, resolvedBefore]) {
        expect(await eventsOf(market.id)).toEqual([]);
      }

      await waitForMessages(subscribers[0]!.received, 1, 'status of the later market');
      await waitForMessages(subscribers[1]!.received, 1, 'status of the earlier market');
      await sleep(100);
      expect(subscribers[2]!.received).toEqual([]);

      // Nothing is due any more: the next minute's scan finds nothing.
      await expect(resolveDueMarkets(t.db, publish, enqueueFinalize)).resolves.toEqual({
        resolved: 0,
        skipped: 0,
        failed: 0,
        failures: [],
      });
    } finally {
      await Promise.all(subscribers.map((s) => s.quit()));
    }
  });

  /** A 판정 이의 on `market`, submitted a millisecond after its publication (inside the window). */
  async function disputeOn(
    market: { id: string },
    publishedAt: Date,
    status: 'pending' | 'accepted' = 'pending',
  ) {
    return (
      await createDispute(t.db, {
        marketId: market.id,
        status,
        submittedAt: new Date(publishedAt.getTime() + 1),
      })
    ).dispute;
  }

  /** As the API dismisses one (#175): the market lock, its row, the admin lock, the dispute. */
  async function dismiss(disputeId: string, marketId: string) {
    const adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    return t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const [market] = await tx
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, marketId))
        .for('update');
      await lockAdminRoles(tx, 'shared');
      const [dispute] = await tx
        .select()
        .from(schema.marketDisputes)
        .where(eq(schema.marketDisputes.id, disputeId))
        .for('update');
      const now = await clockTimestamp(tx);
      return decideMarketDispute(tx, {
        market: market!,
        dispute: dispute!,
        adminId,
        decision: 'dismiss',
        reason: '바꿀 것이 없다.',
        now,
      });
    });
  }

  it.each(['pending', 'accepted'] as const)(
    'skips a due market a %s 판정 이의 holds as held, writing and publishing nothing (#175)',
    async (status) => {
      const { market: judged, judgement } = await provisional();
      await disputeOn(judged, judgement.publishedAt, status);
      const market = await marketRow(judged.id);
      expect(market.disputeHoldCount).toBe(1);
      const { received, quit } = await subscribeTo(market.id);
      try {
        await expect(resolveMarket(t.db, market.id, publish, enqueueFinalize)).resolves.toEqual({
          outcome: 'skipped',
          marketId: market.id,
          reason: 'held',
        });
        expect(await marketRow(market.id)).toEqual(market);
        expect((await eventsOf(market.id)).map((event) => event.type)).toEqual(['provisional']);
        expect(await stepsOf(market.id)).toEqual([]);
        await sleep(100);
        expect(received).toEqual([]);
        expect(enqueued).toEqual([]);
      } finally {
        await quit();
      }
    },
  );

  it('confirms by the job registered after the last holding dispute’s dismissal past the deadline, as at the deadline (#173 item 7)', async () => {
    const { market, judgement } = await provisional(2 * MINUTE_MS, 'NO');
    const first = await disputeOn(market, judgement.publishedAt);
    const second = await disputeOn(market, judgement.publishedAt);
    expect((await resolveMarket(t.db, market.id, publish, enqueueFinalize)).outcome).toBe(
      'skipped',
    );
    // One dismissed: the other still holds it.
    expect(await dismiss(first.id, market.id)).toMatchObject({ decided: true, held: true });
    await expect(resolveMarket(t.db, market.id, publish, enqueueFinalize)).resolves.toMatchObject({
      outcome: 'skipped',
      reason: 'held',
    });
    // The last one dismissed: the API registers `market.resolve` with no delay, and its run
    // confirms the market as the deadline's would — the worker, no actor, `source: 'deadline'`.
    expect(await dismiss(second.id, market.id)).toMatchObject({
      decided: true,
      held: false,
      market: { disputeHoldCount: 0 },
    });
    const { received, quit } = await subscribeTo(market.id);
    try {
      const result = await resolveMarket(t.db, market.id, publish, enqueueFinalize);
      expect(result).toMatchObject({ outcome: 'resolved', resolvedResult: 'NO' });
      if (result.outcome !== 'resolved') return;
      expect((await eventsOf(market.id)).at(-1)).toMatchObject({
        id: result.statusEventId,
        type: 'resolved',
        actorId: null,
        payload: { version: 1, result: 'NO', source: 'deadline' },
      });
      expect(await marketRow(market.id)).toMatchObject({
        status: 'resolved',
        disputeHoldCount: 0,
        resolvedAt: result.resolvedAt,
      });
      await waitForMessages(received, 1, 'market:status');
      expect(enqueued).toEqual([{ marketId: market.id, resolvedAt: result.resolvedAt }]);
    } finally {
      await quit();
    }
  });

  it('scan leaves a held market out — it takes no slot and is not examined — and confirms it once its hold cleared (#175)', async () => {
    const free = await provisional(3 * MINUTE_MS);
    const held = await provisional(4 * MINUTE_MS);
    const accepted = await provisional(5 * MINUTE_MS);
    const retracted = await provisional(6 * MINUTE_MS);
    const pending = await disputeOn(held.market, held.judgement.publishedAt);
    await disputeOn(accepted.market, accepted.judgement.publishedAt, 'accepted');
    // A dispute retracted inside the window holds nothing.
    const gone = await disputeOn(retracted.market, retracted.judgement.publishedAt);
    await t.db.transaction(async (tx) => {
      await lockMarket(tx, retracted.market.id);
      const [market] = await tx
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, retracted.market.id))
        .for('update');
      const result = await retractMarketDispute(tx, {
        dispute: gone,
        market: market!,
        now: new Date(retracted.judgement.publishedAt.getTime() + 2),
      });
      expect(result.retracted).toBe(true);
    });

    // `skipped: 0`: the held markets were not examined at all.
    await expect(resolveDueMarkets(t.db, publish, enqueueFinalize)).resolves.toEqual({
      resolved: 2,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect(enqueued.map((entry) => entry.marketId)).toEqual([retracted.market.id, free.market.id]);
    expect((await marketRow(held.market.id)).status).toBe('provisional');
    expect((await marketRow(accepted.market.id)).status).toBe('provisional');

    // The pending one dismissed and its job lost: the next minute's scan confirms the market; the
    // accepted one waits for a correction (#176's tests below).
    await dismiss(pending.id, held.market.id);
    await expect(resolveDueMarkets(t.db, publish, enqueueFinalize)).resolves.toEqual({
      resolved: 1,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect((await marketRow(held.market.id)).status).toBe('resolved');
    expect((await marketRow(accepted.market.id)).status).toBe('provisional');
  });

  /**
   * As the API rejects a correction (#176): the market lock, its row, the admin lock, the request
   * rejected, its accepted disputes reopened, the mirror cleared — after COMMIT the API registers
   * `market.resolve` with no delay when nothing holds past the deadline.
   */
  async function rejectCorrection(requestId: string, marketId: string, disputeIds: string[] = []) {
    const adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    return t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const [market] = await tx
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, marketId))
        .for('update');
      await lockAdminRoles(tx, 'shared');
      const now = await clockTimestamp(tx);
      await tx
        .update(schema.approvalRequests)
        .set({
          status: 'rejected',
          decidedBy: adminId,
          decidedAt: now,
          decisionReason: '정정할 근거가 부족하다.',
        })
        .where(eq(schema.approvalRequests.id, requestId));
      const { disputes } = await reopenAcceptedDisputes(tx, { market: market!, disputeIds, now });
      return {
        disputes,
        market: await setCorrectionPending(tx, { marketId, pending: false, now }),
      };
    });
  }

  it('skips a due market a waiting correction holds as held, leaves it out of the scan, and confirms the original version once it is rejected (#176)', async () => {
    const { market: judged } = await provisional(2 * MINUTE_MS, 'NO');
    const request = await createCorrectionRequest(t.db, { marketId: judged.id, result: 'YES' });
    const market = await marketRow(judged.id);
    expect(market).toMatchObject({ correctionPending: true, disputeHoldCount: 0 });
    const { received, quit } = await subscribeTo(market.id);
    try {
      await expect(resolveMarket(t.db, market.id, publish, enqueueFinalize)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'held',
      });
      await expect(resolveDueMarkets(t.db, publish, enqueueFinalize)).resolves.toEqual({
        resolved: 0,
        skipped: 0,
        failed: 0,
        failures: [],
      });
      expect(await marketRow(market.id)).toEqual(market);
      expect((await eventsOf(market.id)).map((event) => event.type)).toEqual(['provisional']);
      await sleep(100);
      expect(received).toEqual([]);
      expect(enqueued).toEqual([]);
    } finally {
      await quit();
    }
    // Rejected: the original version, its deadline and its disputes carry on (decision 3 '#176 정정
    // 대기'), and the job the API registers then confirms v1.
    await rejectCorrection(request.id, market.id);
    const result = await resolveMarket(t.db, market.id, publish, enqueueFinalize);
    expect(result).toMatchObject({ outcome: 'resolved', resolvedResult: 'NO' });
    expect((await eventsOf(market.id)).at(-1)).toMatchObject({
      type: 'resolved',
      payload: { version: 1, result: 'NO', source: 'deadline' },
    });
    expect(await marketRow(market.id)).toMatchObject({
      status: 'resolved',
      judgementVersion: 1,
      correctionPending: false,
    });
  });

  it('keeps a held market held when a rejected correction reopens its accepted dispute (owner answer 2026-11-02)', async () => {
    const { market, judgement } = await provisional(2 * MINUTE_MS);
    const accepted = await disputeOn(market, judgement.publishedAt, 'accepted');
    const request = await createCorrectionRequest(t.db, { marketId: market.id });
    const { disputes, market: after } = await rejectCorrection(request.id, market.id, [
      accepted.id,
    ]);
    expect(disputes.map((dispute) => dispute.status)).toEqual(['pending']);
    expect(after).toMatchObject({ disputeHoldCount: 1, correctionPending: false });
    await expect(resolveMarket(t.db, market.id, publish, enqueueFinalize)).resolves.toMatchObject({
      outcome: 'skipped',
      reason: 'held',
    });
    // Dismissed again by an admin who did not register the version: confirmed.
    expect(await dismiss(accepted.id, market.id)).toMatchObject({ decided: true, held: false });
    await expect(resolveMarket(t.db, market.id, publish, enqueueFinalize)).resolves.toMatchObject({
      outcome: 'resolved',
    });
  });

  it('after a correction, the old deadline’s job is not_due — the market’s own deadline is read — and nothing is confirmed or published (#176)', async () => {
    // v1's deadline a minute past; the correction approved now gives v2 a minute from now.
    const { market, judgement } = await provisional(2 * MINUTE_MS, 'YES');
    expect(judgement.disputeDeadline.getTime()).toBeLessThan(Date.now());
    const corrected = await createCorrectedMarket(t.db, { marketId: market.id });
    expect(corrected.market.disputeDeadline!.getTime()).toBeGreaterThan(Date.now());
    const { received, quit } = await subscribeTo(market.id);
    try {
      // The delayed job registered at v1's approval fires at v1's deadline, now past.
      await expect(resolveMarket(t.db, market.id, publish, enqueueFinalize)).resolves.toEqual({
        outcome: 'skipped',
        marketId: market.id,
        reason: 'not_due',
      });
      // Nor does the scan take it: its deadline is v2's.
      await expect(resolveDueMarkets(t.db, publish, enqueueFinalize)).resolves.toMatchObject({
        resolved: 0,
        skipped: 0,
      });
      expect(await marketRow(market.id)).toEqual(corrected.market);
      expect((await eventsOf(market.id)).map((event) => event.type)).toEqual([
        'provisional',
        'judgement_corrected',
      ]);
      expect(await stepsOf(market.id)).toEqual([]);
      await sleep(100);
      expect(received).toEqual([]);
      expect(enqueued).toEqual([]);
    } finally {
      await quit();
    }
  });

  it('confirms the corrected version at its new deadline, by the job or the scan (#176)', async () => {
    // v1 published five minutes ago, corrected three minutes ago with v1's one-minute window: v2's
    // deadline two minutes past.
    const job = await provisional(5 * MINUTE_MS, 'YES');
    const { judgement: v2 } = await createCorrectedMarket(t.db, {
      marketId: job.market.id,
      correctedAt: new Date(Date.now() - 3 * MINUTE_MS),
    });
    expect(v2).toMatchObject({ version: 2, result: 'NO', disputeWindowMinutes: 1 });
    const { received, quit } = await subscribeTo(job.market.id);
    try {
      const result = await resolveMarket(t.db, job.market.id, publish, enqueueFinalize);
      expect(result).toMatchObject({ outcome: 'resolved', resolvedResult: 'NO' });
      if (result.outcome !== 'resolved') return;
      expect(result.resolvedAt.getTime()).toBeGreaterThanOrEqual(v2.disputeDeadline.getTime());
      expect((await eventsOf(job.market.id)).at(-1)).toMatchObject({
        id: result.statusEventId,
        type: 'resolved',
        actorId: null,
        fromStatus: 'provisional',
        toStatus: 'resolved',
        payload: { version: 2, result: 'NO', source: 'deadline' },
      });
      expect(await marketRow(job.market.id)).toMatchObject({
        status: 'resolved',
        resolvedResult: 'NO',
        judgementVersion: 2,
        disputeDeadline: v2.disputeDeadline,
      });
      await waitForMessages(received, 1, 'market:status');
      expect(JSON.parse(received[0]!)).toMatchObject({ status: 'resolved', resolvedResult: 'NO' });
      expect(enqueued).toEqual([{ marketId: job.market.id, resolvedAt: result.resolvedAt }]);
    } finally {
      await quit();
    }
    // The scan alike, for a corrected market whose job was lost.
    const scanned = await provisional(5 * MINUTE_MS, 'NO');
    await createCorrectedMarket(t.db, {
      marketId: scanned.market.id,
      correctedAt: new Date(Date.now() - 3 * MINUTE_MS),
    });
    await expect(resolveDueMarkets(t.db, publish, enqueueFinalize)).resolves.toMatchObject({
      resolved: 1,
      skipped: 0,
    });
    expect(await marketRow(scanned.market.id)).toMatchObject({
      status: 'resolved',
      resolvedResult: 'YES',
      judgementVersion: 2,
    });
  });

  it('leaves the finalize what it needs: the steps it wrote take the market to settled', async () => {
    const { market } = await provisional(2 * MINUTE_MS, 'YES');
    // Two pairs by #118's pair mint (`mintTestPairs`): the collateral holds the 200 Coin paid.
    const { user: holder } = await createUser(t.db, { balanceCoin: 1_000n });
    const { user: other } = await createUser(t.db, { balanceCoin: 1_000n });
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: holder.id,
      noHolderId: other.id,
      qty: 2,
    });
    const result = await resolveMarket(t.db, market.id, publish, enqueueFinalize);
    expect(result.outcome).toBe('resolved');
    const finalized = await finalizeMarket(t.db, market.id, publish, pino({ level: 'silent' }));
    expect(finalized).toMatchObject({ outcome: 'settled', paidAccounts: 1, paidCoin: 200n });
    expect((await eventsOf(market.id)).map((event) => event.type)).toEqual([
      'provisional',
      'resolved',
      'settling',
      'finalized',
    ]);
    expect(await stepsOf(market.id)).toEqual([
      expect.objectContaining({ step: 'coin', status: 'done', attempts: 1 }),
    ]);
  });

  it('does not fail the confirmation when the publish fails (the transaction has committed)', async () => {
    const { market } = await provisional();
    // A publisher on a dead connection, built by the PRODUCTION factory as in
    // market-open.test.ts: the warn-and-swallow contract of realtime.ts keeps a finished
    // confirmation out of the failed set, and its finalize is still registered.
    const dead = createPublisherRedis('redis://127.0.0.1:1', pino({ level: 'silent' }));
    const logs: unknown[] = [];
    const logger = pino(
      { level: 'warn' },
      { write: (line: string) => logs.push(JSON.parse(line)) },
    );
    try {
      const result = await resolveMarket(
        t.db,
        market.id,
        createPublisher(dead, logger),
        enqueueFinalize,
      );
      expect(result.outcome).toBe('resolved');
      expect((await marketRow(market.id)).status).toBe('resolved');
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        msg: 'realtime publish failed',
        channel: marketChannel(market.id),
        eventType: 'market:status',
      });
      expect(enqueued).toHaveLength(1);
    } finally {
      dead.disconnect();
    }
  });
});
