import { randomUUID } from 'node:crypto';
import {
  MARKET_JUDGEMENT_APPROVAL_KIND,
  MARKET_PAUSE_DECISION_APPROVAL_KIND,
  MARKET_STATUSES,
  type MarketJudgementRequestPayload,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  approveMarketJudgement,
  currentMarketJudgement,
  readMarketJudgements,
  resolveProvisionalMarket,
  type ApproveMarketJudgementInput,
} from './market-judgement.js';
import {
  approvalRequests,
  marketEvents,
  marketJudgements,
  marketSettlementSteps,
  markets,
} from './schema/index.js';
import {
  closeMarketEarly,
  createApprovalRequest,
  createJudgementRequest,
  createMarket,
  createOpenedMarket,
  createProvisionalMarket,
  createUser,
  resolveMarketNow,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DAY_WINDOW = 1_440;

type Approving = Omit<ApproveMarketJudgementInput, 'market' | 'now' | 'request'>;

describe.skipIf(!hasTestDb())('market judgements (#152, docker test profile)', () => {
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

  const judgementsOf = (marketId: string) =>
    t.db.select().from(marketJudgements).where(eq(marketJudgements.marketId, marketId));

  const stepsOf = (marketId: string) =>
    t.db.select().from(marketSettlementSteps).where(eq(marketSettlementSteps.marketId, marketId));

  const admin = async () => (await createUser(t.db, { role: 'admin' })).user.id;

  /** The request row as the approval reads it, by id. */
  const requestOf = async (id: string) => {
    const [row] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
    return row!;
  };

  /**
   * As the API approves: the market lock, the row FOR UPDATE after it, then `now` — the database
   * clock after the lock, unless a boundary case gives the instant itself.
   */
  function approve(marketId: string, requestId: string, input: Approving, at?: Date) {
    return t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const [market] = await tx
        .select()
        .from(markets)
        .where(eq(markets.id, marketId))
        .for('update');
      const [request] = await tx
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, requestId));
      const now = at ?? (await clockTimestamp(tx));
      return {
        now,
        result: await approveMarketJudgement(tx, {
          market: market!,
          request: request!,
          now,
          ...input,
        }),
      };
    });
  }

  /** As the worker confirms: the market lock, then the database clock (or the instant given). */
  function confirm(marketId: string, at?: Date) {
    return t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const now = at ?? (await clockTimestamp(tx));
      return { now, result: await resolveProvisionalMarket(tx, { marketId, now }) };
    });
  }

  /** A CLOSED market with its history: opened at its scheduled open (rule v1), closed early. */
  async function closedWithHistory(input: Parameters<typeof closeMarketEarly>[2] = {}) {
    const { market } = await createOpenedMarket(t.db, {
      fallbackSources: [{ name: '대체 출처', url: 'https://example.com/fallback' }],
    });
    return (await closeMarketEarly(t.db, market.id, input)).market;
  }

  describe('approveMarketJudgement', () => {
    it('publishes a CLOSED market’s judgement: the provisional event, the row and judgement v1', async () => {
      const market = await closedWithHistory();
      expect(market).toMatchObject({ status: 'closed', ruleVersion: 1, judgementVersion: null });
      const registrant = await admin();
      const approverId = await admin();
      const collectedAt = new Date(Date.now() - HOUR_MS);
      const request = await createJudgementRequest(t.db, {
        marketId: market.id,
        result: 'NO',
        by: registrant,
        evidence: {
          links: ['https://example.com/a', 'https://example.com/b'],
          collectedAt,
        },
        description: '1차 출처의 발표를 확인했다.',
      });
      const before = await eventsOf(market.id);
      const { now, result } = await approve(market.id, request.id, {
        approverId,
        eventDeadlineConfirmed: true,
        disputeWindowMinutes: DAY_WINDOW,
      });
      expect(result.published).toBe(true);
      if (!result.published) return;
      const disputeDeadline = new Date(now.getTime() + DAY_WINDOW * MINUTE_MS);

      const events = await eventsOf(market.id);
      expect(events.slice(0, -1)).toEqual(before);
      expect(events.at(-1)).toEqual({
        id: result.eventId,
        marketId: market.id,
        type: 'provisional',
        actorId: approverId,
        fromStatus: 'closed',
        toStatus: 'provisional',
        payload: {
          version: 1,
          result: 'NO',
          approvalId: request.id,
          requestedBy: registrant,
          disputeDeadline: disputeDeadline.toISOString(),
        },
        createdAt: now,
      });
      // The row: the status, its event and instant, the result, the version and the deadline —
      // `resolved_at` stays null, the confirmation's (ADR-0095 결과 5).
      const row = await rowOf(market.id);
      expect(result.market).toEqual(row);
      expect(row).toEqual({
        ...market,
        status: 'provisional',
        statusEventId: result.eventId,
        updatedAt: now,
        resolvedResult: 'NO',
        judgementVersion: 1,
        disputeDeadline,
        resolvedAt: null,
      });
      // The judgement: the registration as the request froze it, the source copied from the rules.
      const [source] = await t.db.query.marketSources.findMany({
        where: (sources, { and: both, eq: is }) =>
          both(is(sources.marketId, market.id), is(sources.priority, 0)),
      });
      expect(await judgementsOf(market.id)).toEqual([result.judgement]);
      expect(result.judgement).toEqual({
        marketId: market.id,
        version: 1,
        result: 'NO',
        sourcePriority: 0,
        sourceName: source!.name,
        sourceUrl: source!.url,
        fallbackReason: null,
        voidReason: null,
        evidenceLinks: ['https://example.com/a', 'https://example.com/b'],
        evidenceDescription: '1차 출처의 발표를 확인했다.',
        collectedAt,
        ruleVersion: 1,
        eventDeadlineConfirmed: true,
        disputeWindowMinutes: DAY_WINDOW,
        publishedAt: now,
        disputeDeadline,
        approvalId: request.id,
        registeredBy: registrant,
        approvedBy: approverId,
        provisionalEventId: result.eventId,
        createdAt: now,
      });
      expect(await currentMarketJudgement(t.db, market.id)).toEqual(result.judgement);
      // Nothing to settle yet: a provisional result has no step.
      expect(await stepsOf(market.id)).toEqual([]);
    });

    it('fixes the deadline at the publication plus the window, to the millisecond (#173 item 5)', async () => {
      const market = await createMarket(t.db, { status: 'closed' });
      const request = await createJudgementRequest(t.db, { marketId: market.id });
      const at = new Date((await clockTimestamp(t.db)).getTime() + 123);
      const { result } = await approve(
        market.id,
        request.id,
        { approverId: await admin(), eventDeadlineConfirmed: true, disputeWindowMinutes: 1 },
        at,
      );
      expect(result).toMatchObject({
        published: true,
        market: { disputeDeadline: new Date(at.getTime() + MINUTE_MS) },
        judgement: {
          publishedAt: at,
          disputeWindowMinutes: 1,
          disputeDeadline: new Date(at.getTime() + MINUTE_MS),
          // A market from before #80 has no rule version, and its judgement follows none.
          ruleVersion: null,
        },
      });
    });

    it('publishes a VOID with no source on a market closed early as 판정 불가 (ADR-0102)', async () => {
      const market = await closedWithHistory({ reviewResult: 'not_judgeable' });
      const request = await createJudgementRequest(t.db, { marketId: market.id, result: 'VOID' });
      expect(request.payload).toMatchObject({
        result: 'VOID',
        source: null,
        voidReason: expect.any(String) as unknown,
      });
      const { result } = await approve(market.id, request.id, {
        approverId: await admin(),
        eventDeadlineConfirmed: true,
        disputeWindowMinutes: DAY_WINDOW,
      });
      expect(result).toMatchObject({
        published: true,
        // VOID too goes through PROVISIONAL (#173 item 9), its result on the market.
        market: { status: 'provisional', resolvedResult: 'VOID' },
        judgement: {
          result: 'VOID',
          sourcePriority: null,
          sourceName: null,
          sourceUrl: null,
          fallbackReason: null,
          voidReason: (request.payload as MarketJudgementRequestPayload).voidReason,
        },
      });
    });

    it('keeps a fallback source with its reason, copied from the rules', async () => {
      const market = await closedWithHistory();
      const request = await createJudgementRequest(t.db, {
        marketId: market.id,
        source: { priority: 1 },
        fallbackReason: '1차 출처가 발표를 미뤘다.',
      });
      const { result } = await approve(market.id, request.id, {
        approverId: await admin(),
        eventDeadlineConfirmed: true,
        disputeWindowMinutes: DAY_WINDOW,
      });
      expect(result).toMatchObject({
        published: true,
        judgement: {
          sourcePriority: 1,
          sourceName: '대체 출처',
          sourceUrl: 'https://example.com/fallback',
          fallbackReason: '1차 출처가 발표를 미뤘다.',
        },
      });
    });

    it.each(MARKET_STATUSES.filter((status) => status !== 'closed'))(
      'skips a %s market as not_closed, writing nothing',
      async (status) => {
        // A PROVISIONAL one too: another approval published its judgement first.
        const market = await createMarket(t.db, { status });
        const request = await createJudgementRequest(t.db, { marketId: market.id });
        const { result } = await approve(market.id, request.id, {
          approverId: await admin(),
          eventDeadlineConfirmed: true,
          disputeWindowMinutes: DAY_WINDOW,
        });
        expect(result).toEqual({ published: false, reason: 'not_closed' });
        expect(await rowOf(market.id)).toEqual(market);
        expect(await eventsOf(market.id)).toEqual([]);
        expect(await judgementsOf(market.id)).toEqual([]);
      },
    );

    it('needs the event deadline confirmed before the scheduled judgement, and keeps it only then', async () => {
      // Decision 3 '등록 시점': the API refuses an unconfirmed early approval first, so here it is a
      // caller's bug. At the scheduled judgement or after, nothing is needed.
      const scheduledJudgementAt = new Date(
        Math.ceil((Date.now() + HOUR_MS) / MINUTE_MS) * MINUTE_MS,
      );
      const market = await createMarket(t.db, {
        status: 'closed',
        closeAt: new Date(Date.now() - HOUR_MS),
        eventDeadline: new Date(Date.now() - HOUR_MS),
        scheduledJudgementAt,
      });
      const request = await createJudgementRequest(t.db, { marketId: market.id });
      const unconfirmed = { approverId: await admin(), eventDeadlineConfirmed: false };
      const early = new Date(scheduledJudgementAt.getTime() - 1);
      await expect(
        approve(market.id, request.id, { ...unconfirmed, disputeWindowMinutes: 1 }, early),
      ).rejects.toThrow(
        'A judgement approved before its scheduled time confirms the event deadline',
      );
      expect(await rowOf(market.id)).toEqual(market);
      expect(await eventsOf(market.id)).toEqual([]);
      const { result } = await approve(
        market.id,
        request.id,
        { ...unconfirmed, disputeWindowMinutes: 1 },
        scheduledJudgementAt,
      );
      expect(result).toMatchObject({
        published: true,
        judgement: { eventDeadlineConfirmed: false },
      });
      // A market with no scheduled judgement (opened before #22) needs nothing either, and a
      // confirmation sent where none is asked is not recorded as one.
      const before22 = await createMarket(t.db, { status: 'closed', blankTimes: true });
      const other = await createJudgementRequest(t.db, { marketId: before22.id });
      expect(
        (
          await approve(before22.id, other.id, {
            ...unconfirmed,
            eventDeadlineConfirmed: true,
            disputeWindowMinutes: 1,
          })
        ).result,
      ).toMatchObject({ published: true, judgement: { eventDeadlineConfirmed: false } });
      const late = await createMarket(t.db, {
        status: 'closed',
        closeAt: new Date(Date.now() - 2 * HOUR_MS),
        eventDeadline: new Date(Date.now() - 2 * HOUR_MS),
        scheduledJudgementAt: new Date(Math.floor((Date.now() - HOUR_MS) / MINUTE_MS) * MINUTE_MS),
      });
      const lateRequest = await createJudgementRequest(t.db, { marketId: late.id });
      expect(
        (
          await approve(late.id, lateRequest.id, {
            ...unconfirmed,
            eventDeadlineConfirmed: true,
            disputeWindowMinutes: 1,
          })
        ).result,
      ).toMatchObject({ published: true, judgement: { eventDeadlineConfirmed: false } });
    });

    it('throws on a caller’s bug before anything is judged or written', async () => {
      const market = await createMarket(t.db, { status: 'closed' });
      const registrant = await admin();
      const approverId = await admin();
      const request = await createJudgementRequest(t.db, { marketId: market.id, by: registrant });
      const approving: Approving = {
        approverId,
        eventDeadlineConfirmed: true,
        disputeWindowMinutes: DAY_WINDOW,
      };
      const other = await createMarket(t.db, { status: 'closed' });
      const othersRequest = await createJudgementRequest(t.db, { marketId: other.id });
      const pauseRequest = await createApprovalRequest(t.db, {
        kind: MARKET_PAUSE_DECISION_APPROVAL_KIND,
        targetType: 'market',
        targetId: market.id,
        payload: (await requestOf(request.id)).payload,
        requestedBy: registrant,
      });
      const malformed = await createApprovalRequest(t.db, {
        kind: MARKET_JUDGEMENT_APPROVAL_KIND,
        targetType: 'market',
        targetId: market.id,
        payload: { result: 'MAYBE' },
        requestedBy: registrant,
      });
      // The rule version moved since the registration (nothing moves it after the close).
      const stale = await createJudgementRequest(t.db, { marketId: market.id, ruleVersion: 3 });
      const cases: [string, Approving, string | RegExp][] = [
        [othersRequest.id, approving, `is no judgement of market ${market.id}`],
        [pauseRequest.id, approving, `is no judgement of market ${market.id}`],
        [
          request.id,
          { ...approving, approverId: registrant },
          'A judgement is approved by an admin other than its registrant',
        ],
        [malformed.id, approving, /invalid/i],
        [request.id, { ...approving, disputeWindowMinutes: 0 }, 'out of range'],
        [request.id, { ...approving, disputeWindowMinutes: 10_081 }, 'out of range'],
        [stale.id, approving, 'its judgement followed 3'],
      ];
      for (const [requestId, input, message] of cases) {
        await expect(approve(market.id, requestId, input), requestId).rejects.toThrow(message);
      }
      expect(await rowOf(market.id)).toEqual(market);
      expect(await eventsOf(market.id)).toEqual([]);
      expect(await judgementsOf(market.id)).toEqual([]);
    });
  });

  describe('resolveProvisionalMarket', () => {
    it('confirms a PROVISIONAL market past its deadline: the resolved event, resolved_at and the steps', async () => {
      const { market, judgement } = await createProvisionalMarket(t.db, {
        result: 'NO',
        publishedAt: new Date(Date.now() - DAY_MS - MINUTE_MS),
      });
      const before = await eventsOf(market.id);
      const { now, result } = await confirm(market.id);
      expect(result).toMatchObject({ resolved: true, version: 1, result: 'NO' });
      if (!result.resolved) return;
      const events = await eventsOf(market.id);
      expect(events.slice(0, -1)).toEqual(before);
      expect(events.at(-1)).toEqual({
        id: result.eventId,
        marketId: market.id,
        type: 'resolved',
        // The worker: no admin acted (ADR-0093 decision 1 #173 item 1).
        actorId: null,
        fromStatus: 'provisional',
        toStatus: 'resolved',
        payload: { version: 1, result: 'NO', source: 'deadline' },
        createdAt: now,
      });
      const row = await rowOf(market.id);
      expect(result.market).toEqual(row);
      expect(row).toEqual({
        ...market,
        status: 'resolved',
        statusEventId: result.eventId,
        updatedAt: now,
        resolvedAt: now,
      });
      // The judgement is kept as it was, and the version that became RESOLVED stays named.
      expect(await judgementsOf(market.id)).toEqual([judgement]);
      expect(row.judgementVersion).toBe(1);
      // One pending step per SETTLEMENT_STEPS: the step table never lags the status.
      expect(await stepsOf(market.id)).toEqual([
        {
          marketId: market.id,
          step: 'coin',
          status: 'pending',
          attempts: 0,
          completedAt: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        },
      ]);
    });

    it('confirms at its deadline to the millisecond, and is not_due a millisecond before', async () => {
      const { market } = await createProvisionalMarket(t.db, { result: 'VOID' });
      const deadline = market.disputeDeadline!;
      expect((await confirm(market.id, new Date(deadline.getTime() - 1))).result).toEqual({
        resolved: false,
        reason: 'not_due',
      });
      expect(await rowOf(market.id)).toEqual(market);
      expect(await stepsOf(market.id)).toEqual([]);
      // A VOID is confirmed too (#173 item 9); its payout is #126's.
      expect((await confirm(market.id, deadline)).result).toMatchObject({
        resolved: true,
        result: 'VOID',
        market: { status: 'resolved', resolvedResult: 'VOID', resolvedAt: deadline },
      });
      expect(await stepsOf(market.id)).toHaveLength(1);
    });

    it.each(MARKET_STATUSES.filter((status) => status !== 'provisional'))(
      'skips a %s market as not_provisional, writing nothing',
      async (status) => {
        const market = await createMarket(t.db, {
          status,
          disputeDeadline: new Date(Date.now() - DAY_MS),
          settlementSteps: false,
        });
        expect((await confirm(market.id)).result).toEqual({
          resolved: false,
          reason: 'not_provisional',
        });
        expect(await rowOf(market.id)).toEqual(market);
        expect(await eventsOf(market.id)).toEqual([]);
        expect(await stepsOf(market.id)).toEqual([]);
      },
    );

    it('is idempotent: a second run finds it RESOLVED, and an unknown id is not_found', async () => {
      const { market } = await createProvisionalMarket(t.db, {
        publishedAt: new Date(Date.now() - DAY_MS - MINUTE_MS),
      });
      expect((await confirm(market.id)).result.resolved).toBe(true);
      const resolved = await rowOf(market.id);
      expect((await confirm(market.id)).result).toEqual({
        resolved: false,
        reason: 'not_provisional',
      });
      expect(await rowOf(market.id)).toEqual(resolved);
      expect((await eventsOf(market.id)).filter((e) => e.type === 'resolved')).toHaveLength(1);
      expect(await stepsOf(market.id)).toHaveLength(1);
      expect((await confirm(randomUUID())).result).toEqual({
        resolved: false,
        reason: 'not_found',
      });
    });

    it('writes RESOLVED and its step rows in one transaction: a failed step insert leaves nothing', async () => {
      // ADR-0046 D5: whatever writes RESOLVED writes its steps with it, so a status never lags them.
      const { market } = await createProvisionalMarket(t.db, {
        publishedAt: new Date(Date.now() - DAY_MS - MINUTE_MS),
      });
      const before = await eventsOf(market.id);
      const stray = {
        marketId: market.id,
        step: 'coin' as const,
        status: 'pending' as const,
        attempts: 0,
        completedAt: null,
        lastError: null,
        createdAt: new Date(Date.now() - DAY_MS),
        updatedAt: new Date(Date.now() - DAY_MS),
      };
      await t.db.insert(marketSettlementSteps).values(stray);
      await expect(confirm(market.id)).rejects.toThrow();
      expect(await rowOf(market.id)).toEqual(market);
      expect(await eventsOf(market.id)).toEqual(before);
      expect(await stepsOf(market.id)).toEqual([stray]);
    });
  });

  describe('readers', () => {
    it('reads a market’s judgements newest first, and its current one by judgement_version', async () => {
      const { market, judgement, request } = await createProvisionalMarket(t.db);
      expect(await readMarketJudgements(t.db, market.id)).toEqual([judgement]);
      // A second version as #176's correction will write one (its own request and event), the
      // market pointing at it.
      const approverId = judgement.approvedBy;
      const correction = await createApprovalRequest(t.db, {
        kind: MARKET_JUDGEMENT_APPROVAL_KIND,
        targetType: 'market',
        targetId: market.id,
        payload: request.payload,
        requestedBy: judgement.registeredBy,
        decision: { status: 'approved', by: approverId },
      });
      const [event] = await t.db
        .insert(marketEvents)
        .values({ marketId: market.id, type: 'provisional', actorId: approverId })
        .returning();
      const [v2] = await t.db
        .insert(marketJudgements)
        .values({
          ...judgement,
          version: 2,
          result: 'NO',
          approvalId: correction.id,
          provisionalEventId: event!.id,
        })
        .returning();
      expect(await readMarketJudgements(t.db, market.id)).toEqual([v2, judgement]);
      expect(await currentMarketJudgement(t.db, market.id)).toEqual(judgement);
      await t.db.update(markets).set({ judgementVersion: 2 }).where(eq(markets.id, market.id));
      expect(await currentMarketJudgement(t.db, market.id)).toEqual(v2);
      // None for a market not judged yet, or judged by the interim route before #152 (D4).
      for (const status of ['closed', 'resolved'] as const) {
        const none = await createMarket(t.db, { status, resolvedResult: null });
        expect(await readMarketJudgements(t.db, none.id)).toEqual([]);
        expect(await currentMarketJudgement(t.db, none.id)).toBeNull();
      }
    });
  });

  describe('factories', () => {
    it('createJudgementRequest leaves a registration as the route does: pending, the source copied', async () => {
      const market = await createMarket(t.db, {
        status: 'closed',
        fallbackSources: [{ name: '대체', url: 'https://example.com/fallback' }],
      });
      const by = await admin();
      const requestedAt = await clockTimestamp(t.db);
      const request = await createJudgementRequest(t.db, {
        marketId: market.id,
        by,
        requestedAt,
      });
      const [primary] = await t.db.query.marketSources.findMany({
        where: (sources, { and: both, eq: is }) =>
          both(is(sources.marketId, market.id), is(sources.priority, 0)),
      });
      expect(request).toMatchObject({
        kind: MARKET_JUDGEMENT_APPROVAL_KIND,
        targetType: 'market',
        targetId: market.id,
        requestedBy: by,
        requestedAt,
        status: 'pending',
        requestReason: expect.any(String) as unknown,
        payload: {
          result: 'YES',
          source: { priority: 0, name: primary!.name, url: primary!.url },
          fallbackReason: null,
          voidReason: null,
          evidence: {
            links: ['https://example.com/evidence'],
            collectedAt: new Date(requestedAt.getTime() - MINUTE_MS).toISOString(),
          },
          ruleVersion: null,
        },
      });
      // A fallback takes a reason by default; a name given is stored as given.
      expect(
        (
          await createJudgementRequest(t.db, {
            marketId: market.id,
            source: { priority: 1, name: '바꾼 이름' },
          })
        ).payload,
      ).toMatchObject({
        source: { priority: 1, name: '바꾼 이름', url: 'https://example.com/fallback' },
        fallbackReason: expect.any(String) as unknown,
      });
      // No source at that priority: the route's 'unknown'.
      await expect(
        createJudgementRequest(t.db, { marketId: market.id, source: { priority: 2 } }),
      ).rejects.toThrow('has no source at 2');
      // Rejected or retracted as asked.
      const reviewer = await admin();
      expect(
        await createJudgementRequest(t.db, {
          marketId: market.id,
          rejected: { by: reviewer, reason: '증거가 부족하다.' },
        }),
      ).toMatchObject({ status: 'rejected', decidedBy: reviewer });
      expect(
        await createJudgementRequest(t.db, { marketId: market.id, retracted: {} }),
      ).toMatchObject({ status: 'retracted' });
      // The market is untouched.
      expect(await rowOf(market.id)).toEqual(market);
    });

    it('createProvisionalMarket judges a fresh CLOSED market or a given one; resolveMarketNow confirms it', async () => {
      const made = await createProvisionalMarket(t.db);
      expect(made.market).toMatchObject({
        status: 'provisional',
        resolvedResult: 'YES',
        judgementVersion: 1,
        statusEventId: made.eventId,
        disputeDeadline: made.judgement.disputeDeadline,
      });
      expect(made.request).toMatchObject({
        status: 'approved',
        decidedBy: made.judgement.approvedBy,
        decidedAt: made.judgement.publishedAt,
        requestedBy: made.judgement.registeredBy,
      });
      expect(made.judgement).toMatchObject({
        version: 1,
        disputeWindowMinutes: DAY_WINDOW,
        // Before its scheduled judgement (createMarket's: two days after the close).
        eventDeadlineConfirmed: true,
      });
      expect(made.market.closeAt.getTime()).toBe(made.judgement.publishedAt.getTime() - HOUR_MS);
      expect((await eventsOf(made.market.id)).map((event) => event.type)).toEqual(['provisional']);

      // A given CLOSED market keeps its history; the same admin both ways throws.
      const closed = await closedWithHistory();
      const someone = await admin();
      await expect(
        createProvisionalMarket(t.db, {
          marketId: closed.id,
          registeredBy: someone,
          approvedBy: someone,
        }),
      ).rejects.toThrow('the registrant never approves the judgement');
      const given = await createProvisionalMarket(t.db, { marketId: closed.id, result: 'NO' });
      expect(given.judgement).toMatchObject({ ruleVersion: 1, result: 'NO' });
      expect((await eventsOf(closed.id)).map((event) => event.type)).toEqual([
        'submitted',
        'approved',
        'opened',
        'paused',
        'closed',
        'provisional',
      ]);
      // Not CLOSED any more: the approval is refused, and the factory throws.
      await expect(createProvisionalMarket(t.db, { marketId: closed.id })).rejects.toThrow(
        'was not published (not_closed)',
      );

      // resolveMarketNow: a deadline still ahead is brought to now on the market, the judgement
      // keeping its own.
      const { market, eventId } = await resolveMarketNow(t.db, made.market.id);
      expect(market).toMatchObject({
        status: 'resolved',
        statusEventId: eventId,
        disputeDeadline: market.resolvedAt,
      });
      expect(await judgementsOf(made.market.id)).toEqual([made.judgement]);
      expect(await stepsOf(made.market.id)).toHaveLength(1);
      // A deadline already passed moves nothing.
      const past = await createProvisionalMarket(t.db, {
        publishedAt: new Date(Date.now() - 2 * MINUTE_MS),
        disputeWindowMinutes: 1,
      });
      const at = await clockTimestamp(t.db);
      expect((await resolveMarketNow(t.db, past.market.id, { at })).market).toMatchObject({
        status: 'resolved',
        resolvedAt: at,
        disputeDeadline: past.judgement.disputeDeadline,
      });
      // Not PROVISIONAL: it throws.
      await expect(resolveMarketNow(t.db, past.market.id)).rejects.toThrow(
        'was not confirmed (not_provisional)',
      );
    });
  });
});
