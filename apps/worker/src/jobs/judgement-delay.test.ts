/**
 * 판정 지연 기록 (#142, ADR-0106; ADR-0093 decision 1 #173 item 11, the owner's answers of
 * 2026-11-03 (2) and (3)): the time passing creates nothing. A CLOSED market long past its
 * scheduled judgement and its long-delay deadline, both of its records' next review times passed,
 * is left as it was by every market job the worker runs — each per-minute scan and each per-market
 * job a stale delayed job or a script would run — and a PROVISIONAL market a waiting correction
 * holds past its 이의 기한 is still skipped as `held` with a passed record: no NO, no judgement, no
 * VOID, no event, no publish, and both records kept. The worker has no job of its own for a record
 * or a deadline (JOB_NAMES, pinned below and in @buddha/shared jobs.test.ts). Against the docker
 * `test` profile through the packages/db harness; the publish and the finalize registration are
 * recording stubs (nothing reaches Redis), so it skips with the database alone, as schema tests do.
 */
import { schema } from '@buddha/db';
import {
  connectTestDb,
  createCorrectionRequest,
  createJudgementDelay,
  createMarket,
  createProvisionalMarket,
  hasTestDb,
  type TestDb,
} from '@buddha/db/test';
import {
  JOB_NAMES,
  isJudgementDelayed,
  isLongDelayDeadlineReached,
  judgementDelayReviewPassed,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type EnqueueFinalize } from '../market-jobs.js';
import { type Publish } from '../realtime.js';
import { closeDueMarkets, closeMarket } from './market-close.js';
import { finalizeDueMarkets, finalizeMarket } from './market-finalize.js';
import { openDueMarkets, openMarket } from './market-open.js';
import { resolveDueMarkets, resolveMarket } from './market-resolve.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe.skipIf(!hasTestDb())('the time passing creates nothing (#142, integration)', () => {
  let t: TestDb;
  let published: unknown[];
  let enqueued: string[];
  const publish: Publish = (channel, event) => {
    published.push({ channel, event });
    return Promise.resolve();
  };
  const enqueueFinalize: EnqueueFinalize = (marketId) => {
    enqueued.push(marketId);
    return Promise.resolve();
  };
  const logger = pino({ level: 'silent' });

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    published = [];
    enqueued = [];
  });

  /**
   * Everything a job could write about the market: its row, its events, its judgements, the
   * approval requests and admin records about it, its settlement steps and its delay records.
   */
  async function stateOf(marketId: string) {
    const { markets, marketEvents, marketJudgements, approvalRequests, adminActions } = schema;
    const { marketSettlementSteps, marketJudgementDelays } = schema;
    const [market] = await t.db.select().from(markets).where(eq(markets.id, marketId));
    return {
      market: market!,
      events: await t.db
        .select()
        .from(marketEvents)
        .where(eq(marketEvents.marketId, marketId))
        .orderBy(asc(marketEvents.id)),
      judgements: await t.db
        .select()
        .from(marketJudgements)
        .where(eq(marketJudgements.marketId, marketId)),
      requests: await t.db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.targetId, marketId)),
      actions: await t.db.select().from(adminActions).where(eq(adminActions.targetId, marketId)),
      steps: await t.db
        .select()
        .from(marketSettlementSteps)
        .where(eq(marketSettlementSteps.marketId, marketId)),
      delays: await t.db
        .select()
        .from(marketJudgementDelays)
        .where(eq(marketJudgementDelays.marketId, marketId))
        .orderBy(asc(marketJudgementDelays.eventId)),
    };
  }

  /** Every per-minute market scan, as the scheduler runs them (jobs/index.ts). */
  async function runEveryScan() {
    return {
      open: await openDueMarkets(t.db, publish),
      close: await closeDueMarkets(t.db, publish),
      resolve: await resolveDueMarkets(t.db, publish, enqueueFinalize),
      finalize: await finalizeDueMarkets(t.db, publish, logger),
    };
  }

  it('leaves a CLOSED market past its scheduled judgement and long-delay deadline as it was', async () => {
    const now = Date.now();
    const at = (ms: number) => new Date(now + ms);
    const market = await createMarket(t.db, {
      status: 'closed',
      closeAt: at(-11 * DAY_MS),
      eventDeadline: at(-11 * DAY_MS),
      scheduledJudgementAt: at(-10 * DAY_MS),
      longDelayDays: 1,
    });
    // Two records, backdated, each next review time long passed with no newer record since.
    const first = await createJudgementDelay(t.db, {
      marketId: market.id,
      recordedAt: at(-9 * DAY_MS),
    });
    const second = await createJudgementDelay(t.db, {
      marketId: market.id,
      reason: '출처가 발표 일정을 다시 미뤘다.',
      recordedAt: at(-5 * DAY_MS),
      nextReviewAt: at(-4 * DAY_MS),
    });
    // Where it stands: '판정 지연', past the long-delay deadline, both reviews passed.
    const display = {
      status: market.status,
      scheduledJudgementAt: market.scheduledJudgementAt!.toISOString(),
      disputeDeadline: null,
      disputeHoldCount: 0,
      correctionPending: false,
    };
    expect(isJudgementDelayed(display, now)).toBe(true);
    expect(
      isLongDelayDeadlineReached({ ...display, longDelayDays: market.longDelayDays }, now),
    ).toBe(true);
    for (const { delay } of [first, second]) {
      expect(judgementDelayReviewPassed(delay.nextReviewAt, now)).toBe(true);
    }
    const before = await stateOf(market.id);
    expect(before.delays.map((delay) => delay.id)).toEqual([first.delay.id, second.delay.id]);

    expect(await runEveryScan()).toEqual({
      open: { opened: 0, skipped: 0, failed: 0, failures: [] },
      close: { closed: 0, cancelled: 0, skipped: 0, failed: 0, failures: [] },
      resolve: { resolved: 0, skipped: 0, failed: 0, failures: [] },
      finalize: { settled: 0, skipped: 0, failed: 0, failures: [] },
    });
    // Each per-market job too, as a stale delayed job or a script would run it on this market.
    const marketId = market.id;
    expect(await openMarket(t.db, marketId, publish)).toEqual({
      outcome: 'skipped',
      marketId,
      reason: 'not_scheduled',
    });
    expect(await closeMarket(t.db, marketId, publish)).toEqual({
      outcome: 'skipped',
      marketId,
      reason: 'not_open_or_paused',
    });
    expect(await resolveMarket(t.db, marketId, publish, enqueueFinalize)).toEqual({
      outcome: 'skipped',
      marketId,
      reason: 'not_provisional',
    });
    expect(await finalizeMarket(t.db, marketId, publish, logger)).toEqual({
      outcome: 'skipped',
      marketId,
      reason: 'not_settling',
    });

    // Nothing moved: no status, no result, no judgement or request, no event, the records kept.
    const after = await stateOf(market.id);
    expect(after).toEqual(before);
    expect(after.market).toMatchObject({
      status: 'closed',
      resolvedResult: null,
      judgementVersion: null,
      disputeDeadline: null,
      statusEventId: null,
    });
    expect(after.judgements).toEqual([]);
    expect(after.requests).toEqual([]);
    expect(after.steps).toEqual([]);
    expect(after.events.map((event) => event.type)).toEqual([
      'judgement_delay_recorded',
      'judgement_delay_recorded',
    ]);
    expect(published).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it('still skips a PROVISIONAL market a waiting correction holds as held, its record passed', async () => {
    const now = Date.now();
    const at = (ms: number) => new Date(now + ms);
    // Published three days ago under a one-minute window: its 이의 기한 long passed.
    const { market } = await createProvisionalMarket(t.db, {
      publishedAt: at(-3 * DAY_MS),
      disputeWindowMinutes: 1,
    });
    await createCorrectionRequest(t.db, { marketId: market.id, requestedAt: at(-2 * DAY_MS) });
    const { delay } = await createJudgementDelay(t.db, {
      marketId: market.id,
      recordedAt: at(-2 * DAY_MS + HOUR_MS),
    });
    expect(delay).toMatchObject({ marketStatus: 'provisional', judgementVersion: 1 });
    expect(judgementDelayReviewPassed(delay.nextReviewAt, now)).toBe(true);
    const before = await stateOf(market.id);
    expect(before.market.correctionPending).toBe(true);

    // The scan leaves it out (the hold is in its query), and the market's own job finds it held.
    expect(await runEveryScan()).toEqual({
      open: { opened: 0, skipped: 0, failed: 0, failures: [] },
      close: { closed: 0, cancelled: 0, skipped: 0, failed: 0, failures: [] },
      resolve: { resolved: 0, skipped: 0, failed: 0, failures: [] },
      finalize: { settled: 0, skipped: 0, failed: 0, failures: [] },
    });
    expect(await resolveMarket(t.db, market.id, publish, enqueueFinalize)).toEqual({
      outcome: 'skipped',
      marketId: market.id,
      reason: 'held',
    });
    expect(await finalizeMarket(t.db, market.id, publish, logger)).toEqual({
      outcome: 'skipped',
      marketId: market.id,
      reason: 'not_settling',
    });
    const after = await stateOf(market.id);
    expect(after).toEqual(before);
    expect(after.market).toMatchObject({ status: 'provisional', resolvedAt: null });
    expect(after.delays).toEqual([delay]);
    expect(published).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it('has no job for a record, its next review time or the long-delay deadline', () => {
    // The worker's jobs are the market's edges and the housekeeping; none reads a delay record.
    // The whole list, not a match on the names, as a job could act on a record or a deadline
    // under any name: a new one fails here until it is reviewed against AC 6 and, if it touches
    // a market, added to `runEveryScan` or to the per-market job checks above.
    expect(Object.values(JOB_NAMES)).toEqual([
      'market_maker.refresh',
      'market_maker.scan',
      'market.open',
      'market.close',
      'market.resolve',
      'market.finalize',
      'ledger.audit',
      'market.audit',
      'market.trader_count',
      'start_grant.pay',
      'media.orphan_cleanup',
      'community.records_purge',
      'retention.purge',
    ]);
  });
});
