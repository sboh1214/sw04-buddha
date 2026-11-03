import {
  JUDGEMENT_DELAY_REVIEW_MAX_MS,
  MARKET_JUDGEMENT_DELAY_REFUSALS,
  MARKET_STATUSES,
  marketJudgementDelayOf,
  withCurrentJudgementDelay,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setCorrectionPending } from './market-judgement.js';
import {
  readJudgementDelays,
  readPublicJudgementDelay,
  recordJudgementDelay,
  type RecordJudgementDelayInput,
} from './market-judgement-delay.js';
import {
  approvalRequests,
  marketEvents,
  marketJudgementDelays,
  markets,
  profiles,
} from './schema/index.js';
import {
  closeAccount,
  createCorrectedMarket,
  createCorrectionRequest,
  createDispute,
  createJudgementDelay,
  createJudgementRequest,
  createMarket,
  createProvisionalMarket,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const REASON = '1차 출처의 발표가 미뤄져 판정을 기다린다.';
const { status: STATUS, nextReviewAt: NEXT_REVIEW } = MARKET_JUDGEMENT_DELAY_REFUSALS;

type Recording = Omit<RecordJudgementDelayInput, 'market' | 'now'>;

describe.skipIf(!hasTestDb())('judgement delay records (#142, docker test profile)', () => {
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

  const delaysOf = (marketId: string) =>
    t.db
      .select()
      .from(marketJudgementDelays)
      .where(eq(marketJudgementDelays.marketId, marketId))
      .orderBy(asc(marketJudgementDelays.eventId));

  const admin = async () => (await createUser(t.db, { role: 'admin' })).user.id;

  /**
   * As the API records: the market lock, the row FOR UPDATE after it, then `now` — the database
   * clock after the lock, unless a boundary case gives the instant itself.
   */
  function record(marketId: string, input: Partial<Recording> & { recordedBy: string }, at?: Date) {
    return t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const [market] = await tx
        .select()
        .from(markets)
        .where(eq(markets.id, marketId))
        .for('update');
      const now = at ?? (await clockTimestamp(tx));
      const result = await recordJudgementDelay(tx, {
        market: market!,
        now,
        reason: REASON,
        nextReviewAt: new Date(now.getTime() + DAY_MS),
        ...input,
      });
      return { now, result };
    });
  }

  /** A CLOSED market whose scheduled judgement passed `ago` ms before now: it reads '판정 지연'. */
  async function delayedClosed(ago = HOUR_MS) {
    const now = Date.now();
    return createMarket(t.db, {
      status: 'closed',
      closeAt: new Date(now - ago - DAY_MS),
      eventDeadline: new Date(now - ago - DAY_MS),
      scheduledJudgementAt: new Date(now - ago),
    });
  }

  /** A PROVISIONAL market whose one-minute 이의 기한 passed an hour ago, held by nothing. */
  async function pastDeadline() {
    return createProvisionalMarket(t.db, {
      publishedAt: new Date(Date.now() - HOUR_MS),
      disputeWindowMinutes: 1,
    });
  }

  describe('recordJudgementDelay', () => {
    it('records on a CLOSED market past its scheduled judgement: the event first, then the row, the market untouched', async () => {
      const market = await delayedClosed();
      const recordedBy = await admin();
      const nextReviewAt = new Date(Date.now() + 2 * DAY_MS);
      const { now, result } = await record(market.id, { recordedBy, nextReviewAt });
      // A direct insert: no status change, the admin the actor, the record in the payload.
      expect(await eventsOf(market.id)).toEqual([
        {
          id: result.eventId,
          marketId: market.id,
          type: 'judgement_delay_recorded',
          actorId: recordedBy,
          fromStatus: null,
          toStatus: null,
          payload: {
            delayId: result.delay.id,
            reason: REASON,
            nextReviewAt: nextReviewAt.toISOString(),
            marketStatus: 'closed',
            judgementVersion: null,
          },
          createdAt: now,
        },
      ]);
      expect(result.delay).toEqual({
        id: expect.any(String) as unknown,
        marketId: market.id,
        reason: REASON,
        nextReviewAt,
        marketStatus: 'closed',
        judgementVersion: null,
        recordedBy,
        recordedAt: now,
        eventId: result.eventId,
      });
      expect(await delaysOf(market.id)).toEqual([result.delay]);
      // Nothing of the market changes: status, result, times, status_event_id, updated_at.
      expect(await rowOf(market.id)).toEqual(market);
    });

    it('records on a PROVISIONAL market a correction or a dispute holds past its deadline, on its version', async () => {
      // #173 item 7: no review deadline for a dispute — when it is late, the record says so.
      const corrected = (await pastDeadline()).market;
      await createCorrectionRequest(t.db, { marketId: corrected.id });
      const byCorrection = await record(corrected.id, { recordedBy: await admin() });
      expect(byCorrection.result.delay).toMatchObject({
        marketStatus: 'provisional',
        judgementVersion: 1,
      });
      const disputed = (await pastDeadline()).market;
      await createDispute(t.db, { marketId: disputed.id });
      const byDispute = await record(disputed.id, { recordedBy: await admin() });
      expect((await eventsOf(disputed.id)).at(-1)?.payload).toMatchObject({
        marketStatus: 'provisional',
        judgementVersion: 1,
      });
      // The hold's mirrors and the version are as the record found them.
      expect(await rowOf(disputed.id)).toMatchObject({
        status: 'provisional',
        judgementVersion: 1,
        disputeHoldCount: 1,
      });
      expect(byDispute.result.delay.recordedAt).toEqual(byDispute.now);
    });

    it('takes a second record as a new row and a new event, the first kept as it was', async () => {
      // Owner answer 2026-11-03 (4): a change is a new record, nothing withdrawn.
      const market = await delayedClosed();
      const first = await record(market.id, { recordedBy: await admin() });
      const second = await record(market.id, { recordedBy: await admin(), reason: '다시 미룬다.' });
      expect(second.result.eventId).toBeGreaterThan(first.result.eventId);
      expect(await delaysOf(market.id)).toEqual([first.result.delay, second.result.delay]);
      expect((await eventsOf(market.id)).map((event) => event.type)).toEqual([
        'judgement_delay_recorded',
        'judgement_delay_recorded',
      ]);
      expect(await rowOf(market.id)).toEqual(market);
    });

    it('takes the scheduled judgement to the millisecond, and a waiting registration refuses nothing', async () => {
      const at = await clockTimestamp(t.db);
      const market = await createMarket(t.db, {
        status: 'closed',
        closeAt: new Date(at.getTime() - DAY_MS),
        eventDeadline: new Date(at.getTime() - DAY_MS),
        scheduledJudgementAt: at,
      });
      const registrant = await admin();
      await createJudgementRequest(t.db, { marketId: market.id, by: registrant });
      await expect(
        record(market.id, { recordedBy: registrant }, new Date(at.getTime() - 1)),
      ).rejects.toThrow(STATUS.notDelayed);
      // Any admin, the registrant of the waiting judgement included (#173 item 2).
      const { result } = await record(market.id, { recordedBy: registrant }, at);
      expect(result.delay).toMatchObject({ recordedAt: at, recordedBy: registrant });
    });

    it('throws on a market that does not read 판정 지연, writing nothing', async () => {
      const later = Date.now() + DAY_MS;
      const ahead = await createMarket(t.db, {
        status: 'closed',
        closeAt: new Date(later - HOUR_MS),
        eventDeadline: new Date(later - HOUR_MS),
        scheduledJudgementAt: new Date(later),
      });
      // Opened before #22: no scheduled judgement, so never delayed.
      const unscheduled = await createMarket(t.db, {
        status: 'closed',
        closeAt: new Date(Date.now() - DAY_MS),
        scheduledJudgementAt: null,
      });
      // PROVISIONAL past its deadline held by nothing (the worker confirms it), and one held but
      // before its deadline ('이의 검토 중').
      const unheld = (await pastDeadline()).market;
      const early = (
        await createProvisionalMarket(t.db, { publishedAt: new Date(), disputeWindowMinutes: 60 })
      ).market;
      await createDispute(t.db, { marketId: early.id });
      const refused = [ahead, unscheduled, unheld, early].map((market) => market.id);
      const recordedBy = await admin();
      for (const id of refused) {
        await expect(record(id, { recordedBy }), id).rejects.toThrow(STATUS.notDelayed);
      }
      for (const status of MARKET_STATUSES.filter((s) => s !== 'closed' && s !== 'provisional')) {
        const market = await createMarket(t.db, { status, scheduledJudgementAt: null });
        await expect(record(market.id, { recordedBy }), status).rejects.toThrow(
          STATUS.notAwaitingJudgement,
        );
        refused.push(market.id);
      }
      for (const id of refused) {
        expect(await delaysOf(id)).toEqual([]);
        expect((await eventsOf(id)).map((event) => event.type)).not.toContain(
          'judgement_delay_recorded',
        );
      }
    });

    it('bounds the next review time: after now, and at most 7 × 24 hours later to the millisecond', async () => {
      // Owner answer 2026-11-03 (1); the CHECK holds the same bound (schema.test.ts).
      const market = await delayedClosed();
      const recordedBy = await admin();
      const at = await clockTimestamp(t.db);
      const by = (ms: number) => new Date(at.getTime() + ms);
      for (const [ms, refusal] of [
        [0, NEXT_REVIEW.notAfterNow],
        [-1, NEXT_REVIEW.notAfterNow],
        [JUDGEMENT_DELAY_REVIEW_MAX_MS + 1, NEXT_REVIEW.tooFarAhead],
      ] as const) {
        await expect(
          record(market.id, { recordedBy, nextReviewAt: by(ms) }, at),
          String(ms),
        ).rejects.toThrow(refusal);
      }
      expect(await delaysOf(market.id)).toEqual([]);
      const soonest = await record(market.id, { recordedBy, nextReviewAt: by(1) }, at);
      expect(soonest.result.delay.nextReviewAt).toEqual(by(1));
      const furthest = await record(
        market.id,
        { recordedBy, nextReviewAt: by(JUDGEMENT_DELAY_REVIEW_MAX_MS) },
        at,
      );
      expect(furthest.result.delay.nextReviewAt).toEqual(by(7 * DAY_MS));
    });
  });

  describe('createJudgementDelay', () => {
    it('backdates a record with its event, its next review time a day later by default', async () => {
      const market = await delayedClosed(10 * DAY_MS);
      const recordedAt = new Date(Date.now() - 9 * DAY_MS);
      const { delay, eventId } = await createJudgementDelay(t.db, {
        marketId: market.id,
        recordedAt,
      });
      expect(delay).toMatchObject({
        recordedAt,
        nextReviewAt: new Date(recordedAt.getTime() + DAY_MS),
        marketStatus: 'closed',
        eventId,
      });
      expect(await eventsOf(market.id)).toEqual([
        expect.objectContaining({ id: eventId, createdAt: recordedAt }) as unknown,
      ]);
      // Before the scheduled judgement it throws, as the route refuses.
      await expect(
        createJudgementDelay(t.db, {
          marketId: market.id,
          recordedAt: new Date(Date.now() - 11 * DAY_MS),
        }),
      ).rejects.toThrow(STATUS.notDelayed);
    });
  });

  describe('the readers', () => {
    it('reads every record newest first with its recorder, and the current one of each episode for the public', async () => {
      const now = Date.now();
      const at = (ms: number) => new Date(now + ms);
      // CLOSED, its scheduled judgement four days ago: two records, then the judgement.
      const market = await createMarket(t.db, {
        status: 'closed',
        closeAt: at(-5 * DAY_MS),
        eventDeadline: at(-5 * DAY_MS),
        scheduledJudgementAt: at(-4 * DAY_MS),
      });
      const recorder = await createUser(t.db, { role: 'admin' });
      const closed1 = await createJudgementDelay(t.db, {
        marketId: market.id,
        by: recorder.user.id,
        reason: '첫 사유',
        recordedAt: at(-3 * DAY_MS),
      });
      const closed2 = await createJudgementDelay(t.db, {
        marketId: market.id,
        reason: '둘째 사유',
        recordedAt: at(-2 * DAY_MS),
      });
      const current = async () => readPublicJudgementDelay(t.db, await rowOf(market.id));
      expect(await current()).toEqual({
        reason: '둘째 사유',
        nextReviewAt: closed2.delay.nextReviewAt,
        marketStatus: 'closed',
        judgementVersion: null,
      });
      // The judgement's approval ends the episode: the CLOSED records are history.
      await createProvisionalMarket(t.db, {
        marketId: market.id,
        publishedAt: at(-DAY_MS),
        disputeWindowMinutes: 1,
      });
      expect(await current()).toBeNull();
      // v1 held by a correction past its deadline, recorded; the correction rejected keeps it.
      const correction = await createCorrectionRequest(t.db, {
        marketId: market.id,
        requestedAt: at(-12 * HOUR_MS),
      });
      const v1 = await createJudgementDelay(t.db, {
        marketId: market.id,
        reason: '정정을 검토한다',
        recordedAt: at(-11 * HOUR_MS),
      });
      expect(await current()).toMatchObject({ reason: '정정을 검토한다', judgementVersion: 1 });
      await t.db
        .update(approvalRequests)
        .set({
          status: 'rejected',
          decidedBy: await admin(),
          decisionReason: '정정하지 않는다.',
          decidedAt: at(-10 * HOUR_MS),
        })
        .where(eq(approvalRequests.id, correction.id));
      await t.db.transaction(async (tx) => {
        await lockMarket(tx, market.id);
        await setCorrectionPending(tx, {
          marketId: market.id,
          pending: false,
          now: at(-10 * HOUR_MS),
        });
      });
      expect(await current()).toMatchObject({ reason: '정정을 검토한다', judgementVersion: 1 });
      // A correction's approval (v2) ends that episode too.
      await createCorrectedMarket(t.db, { marketId: market.id, correctedAt: at(-2 * HOUR_MS) });
      expect(await current()).toBeNull();
      await createCorrectionRequest(t.db, {
        marketId: market.id,
        requestedAt: at(-HOUR_MS),
      });
      const v2 = await createJudgementDelay(t.db, {
        marketId: market.id,
        reason: '다시 정정을 검토한다',
      });
      expect(await current()).toEqual({
        reason: '다시 정정을 검토한다',
        nextReviewAt: v2.delay.nextReviewAt,
        marketStatus: 'provisional',
        judgementVersion: 2,
      });

      // The admin history: every episode's, newest first by event id, each with its recorder.
      const history = await readJudgementDelays(t.db, market.id);
      expect(history.map((row) => row.id)).toEqual(
        [v2, v1, closed2, closed1].map((made) => made.delay.id),
      );
      expect(history.at(-1)).toEqual({
        ...closed1.delay,
        recordedByNickname: recorder.profile.nickname,
      });
      const row = await rowOf(market.id);
      expect(withCurrentJudgementDelay(history, row).map((entry) => entry.current)).toEqual([
        true,
        false,
        false,
        false,
      ]);
      // The public answer from the current one: held past the deadline, so it reads 판정 지연.
      const read = await readPublicJudgementDelay(t.db, row);
      expect(
        marketJudgementDelayOf(
          read === null ? [] : [read],
          {
            status: row.status,
            scheduledJudgementAt: row.scheduledJudgementAt?.toISOString() ?? null,
            disputeDeadline: row.disputeDeadline?.toISOString() ?? null,
            disputeHoldCount: row.disputeHoldCount,
            correctionPending: row.correctionPending,
            judgementVersion: row.judgementVersion,
          },
          now,
        ),
      ).toEqual({
        reason: '다시 정정을 검토한다',
        nextReviewAt: v2.delay.nextReviewAt.toISOString(),
        nextReviewPassed: false,
      });
    });

    it('names a closed account’s record with no nickname, and reads nothing for another status', async () => {
      const market = await delayedClosed();
      const former = await admin();
      await createJudgementDelay(t.db, { marketId: market.id, by: former });
      // A former admin's (ADR-0086): the role revoked, then the account closed.
      await t.db.update(profiles).set({ role: 'user' }).where(eq(profiles.userId, former));
      await closeAccount(t.db, former);
      expect(await readJudgementDelays(t.db, market.id)).toEqual([
        expect.objectContaining({ recordedBy: former, recordedByNickname: null }) as unknown,
      ]);
      expect(await readJudgementDelays(t.db, (await createMarket(t.db)).id)).toEqual([]);
      // A market neither CLOSED nor PROVISIONAL has no current record, whatever it holds.
      for (const status of ['open', 'resolved', 'settled'] as const) {
        expect(
          await readPublicJudgementDelay(t.db, { ...(await rowOf(market.id)), status }),
        ).toBeNull();
      }
    });
  });
});
