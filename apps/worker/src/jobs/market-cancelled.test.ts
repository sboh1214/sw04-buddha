/**
 * A CANCELLED market is left alone by every market job (#20, ADR-0117; ADR-0107 결정 5 '#20
 * CANCELLED 시장의 결과 유형': result type empty, no judgement, 판정 이의 or payout). One market per
 * path into CANCELLED — the close of a market nobody traded on, an approved early close of one, and
 * an operator's cancel of a SCHEDULED market whose scheduled open has passed — then each per-minute
 * scan and each per-market job a stale delayed job or a script would run: the open finds it not
 * SCHEDULED (a cancelled market never opens), the close not OPEN or PAUSED (no closed → cancelled
 * or cancelled → closed edge), the confirmation not PROVISIONAL and the settlement not judged. No
 * event, no publish, no finalize registered. Against the docker `test` profile through the
 * packages/db harness; the publish and the finalize registration are recording stubs, as in
 * judgement-delay.test.ts.
 */
import { schema } from '@buddha/db';
import {
  cancelScheduledMarketNow,
  closeMarketEarly,
  connectTestDb,
  createMarket,
  createScheduledMarket,
  hasTestDb,
  type TestDb,
} from '@buddha/db/test';
import { asc, eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type EnqueueFinalize } from '../market-jobs.js';
import { type Publish } from '../realtime.js';
import { closeDueMarkets, closeMarket } from './market-close.js';
import { finalizeDueMarkets, finalizeMarket } from './market-finalize.js';
import { openDueMarkets, openMarket } from './market-open.js';
import { resolveDueMarkets, resolveMarket } from './market-resolve.js';

const MINUTE_MS = 60_000;

describe.skipIf(!hasTestDb())('a CANCELLED market and the market jobs (#20, integration)', () => {
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

  /** What a job could write about the market: its row, its events and its settlement steps. */
  async function stateOf(marketId: string) {
    const { markets, marketEvents, marketSettlementSteps } = schema;
    const [market] = await t.db.select().from(markets).where(eq(markets.id, marketId));
    return {
      market: market!,
      events: await t.db
        .select()
        .from(marketEvents)
        .where(eq(marketEvents.marketId, marketId))
        .orderBy(asc(marketEvents.id)),
      steps: await t.db
        .select()
        .from(marketSettlementSteps)
        .where(eq(marketSettlementSteps.marketId, marketId)),
    };
  }

  it('skips a market cancelled by each path in every scan and every per-market job', async () => {
    // The close of a market nobody traded on (the worker's own job).
    const closed = await createMarket(t.db, { closeAt: new Date(Date.now() - MINUTE_MS) });
    expect(await closeMarket(t.db, closed.id, publish)).toMatchObject({ outcome: 'cancelled' });
    // An approved early close with no fill (the approver's).
    const early = await createMarket(t.db);
    expect((await closeMarketEarly(t.db, early.id, { humanFill: false })).market.status).toBe(
      'cancelled',
    );
    // An operator's cancel of a SCHEDULED market whose scheduled open has come (createMarket's
    // a minute ago): the open job and the scan must never open it.
    const { market: scheduled } = await createScheduledMarket(t.db);
    expect(scheduled.scheduledOpenAt!.getTime()).toBeLessThan(Date.now());
    expect((await cancelScheduledMarketNow(t.db, scheduled.id)).market.status).toBe('cancelled');

    const ids = [closed.id, early.id, scheduled.id];
    const before = await Promise.all(ids.map(stateOf));
    for (const { market, events } of before) {
      expect(market).toMatchObject({ status: 'cancelled', resolvedResult: null });
      expect(events.at(-1)).toMatchObject({ type: 'cancelled', toStatus: 'cancelled' });
    }
    published = [];

    expect({
      open: await openDueMarkets(t.db, publish),
      close: await closeDueMarkets(t.db, publish),
      resolve: await resolveDueMarkets(t.db, publish, enqueueFinalize),
      finalize: await finalizeDueMarkets(t.db, publish, logger),
    }).toEqual({
      open: { opened: 0, skipped: 0, failed: 0, failures: [] },
      close: { closed: 0, cancelled: 0, skipped: 0, failed: 0, failures: [] },
      resolve: { resolved: 0, skipped: 0, failed: 0, failures: [] },
      finalize: { settled: 0, skipped: 0, failed: 0, failures: [] },
    });
    for (const marketId of ids) {
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
    }

    // Nothing moved: the status, the empty result, the events, no settlement step.
    expect(await Promise.all(ids.map(stateOf))).toEqual(before);
    for (const { steps } of before) expect(steps).toEqual([]);
    expect(published).toEqual([]);
    expect(enqueued).toEqual([]);
  });
});
