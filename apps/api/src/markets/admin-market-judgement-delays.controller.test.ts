/**
 * 판정 지연 기록 (#142, ADR-0106; ADR-0093 decision 1 #173 items 2·7·11·13, decision 3 '#142 지연
 * 사유', the owner's answers of 2026-11-03 (1)–(4)) through the admin route against the docker
 * `test` profile: a record by one admin on a CLOSED market past its scheduled judgement — the
 * `judgement_delay_recorded` event, the record, `market_delay_record`, the unchanged status
 * republished under its unchanged key, nothing of the market changed, the public detail's current
 * reason and next review time naming nobody — and on a PROVISIONAL one a dispute or a waiting
 * correction holds past its deadline, on its judgement version; refused for its body and, in
 * order, an unknown market, a status not awaiting a judgement, a market not delayed, a next review
 * time not after now and one more than 7 days ahead; judged on the database clock read after the
 * market lock, to the millisecond (the scheduled judgement and the deadline reached, a time a
 * millisecond after now, exactly 7 × 24 hours ahead); two records kept — the newest current, the
 * earlier history — with the market still CLOSED and unjudged, and a passed next review time
 * shown as passed with nothing else following; the current record moving with the episode (a
 * judgement's approval, a rejected correction, a correction's approval, the confirmation); any
 * admin, the registrant of a waiting judgement included; and the admin on screen. The time passing
 * creating nothing in the worker is apps/worker's (judgement-delay.test.ts). Skips when TEST_* are
 * unset.
 */
import { clockTimestamp, schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createCorrectedMarket,
  createCorrectionRequest,
  createDispute,
  createJudgementDelay,
  createJudgementRequest,
  createMarket,
  createProvisionalMarket,
  resolveMarketNow,
  setReleaseSetting,
} from '@buddha/db/test';
import {
  DISPUTE_WINDOW_SETTING,
  JUDGEMENT_DELAY_REVIEW_MAX_MS,
  MARKET_JUDGEMENT_DELAY_REFUSALS,
  marketChannel,
  type AdminMarket,
  type Market,
} from '@buddha/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import type * as Clock from '../infra/db/clock.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep, waitForLockWaiter, waitForMessages } from '../test/wait.js';

/**
 * The database clock the API's writes read (`clockTimestamp`, clock.ts), pinned at an instant for
 * the requests of one test (`pinnedAt`) and the real one otherwise: what a refusal to the
 * millisecond is judged on, which neither the host's clock nor the request's time can stand in for
 * — the pinned instant is a day behind both.
 */
const clock = vi.hoisted(() => ({ pinned: null as Date | null }));
vi.mock('../infra/db/clock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Clock>();
  return {
    ...actual,
    clockTimestamp: (executor: Parameters<typeof actual.clockTimestamp>[0]) =>
      clock.pinned === null ? actual.clockTimestamp(executor) : Promise.resolve(clock.pinned),
  };
});

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A well-formed market id that names no market. */
const NO_MARKET = '3d9a1c7e-5b2f-4e8a-9c0d-1e2f3a4b5c6d';

type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: { path: (string | number)[]; message: string }[];
  };
};
type Res = { statusCode: number; json: <U>() => U; body: string };

/** An ISO instant, `ms` from the epoch. */
const iso = (ms: number) => new Date(ms).toISOString();

const REASON = '1차 출처인 통계청의 발표가 미뤄져 판정을 미룬다.';
const SECOND_REASON = '통계청이 발표일을 다시 알려 그날 다시 검토한다.';

describe.skipIf(!hasTestInfra)('admin market judgement delays (integration)', () => {
  let t: TestApp;
  /** Records the delays unless a test says otherwise. */
  let recorder: TestUser;
  let other: TestUser;
  let third: TestUser;
  let category: { id: number; slug: string };

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });

  /** An admin who finished the onboarding (ADR-0072), past the guard's role cache. */
  async function makeAdmin(): Promise<TestUser> {
    const user = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, user.id));
    await completeOnboarding(t.db, { userId: user.id });
    await t.app.get(AdminGuard).invalidate(user.id);
    return user;
  }

  beforeEach(async () => {
    clock.pinned = null;
    await t.reset();
    recorder = await makeAdmin();
    other = await makeAdmin();
    third = await makeAdmin();
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
  });

  // Every write names the admin on screen (ADR-0092): `who`'s own account unless the payload
  // names another.
  const post = (url: string, who: TestUser, payload: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: {
        expectedAccountId: who.id,
        ...(/\/judgements(?:$|\/[^/]+\/approve$)|\/disputes\/[^/]+\/(?:accept|dismiss)$/.test(url)
          ? { noConflictConfirmed: true }
          : {}),
        ...payload,
      },
    });
  const get = (url: string, who: TestUser = recorder) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: who.cookie } });

  const marketUrl = (id: string) => `/api/v1/admin/markets/${id}`;
  /** 판정 지연 기록: REASON and a next review time a day ahead unless the payload says otherwise. */
  const record = (id: string, who: TestUser = recorder, payload: Record<string, unknown> = {}) =>
    post(`${marketUrl(id)}/judgement-delays`, who, {
      reason: REASON,
      nextReviewAt: iso(Date.now() + DAY_MS),
      ...payload,
    });
  const publicDetail = (id: string) =>
    t.app.inject({ method: 'GET', url: `/api/v1/markets/${id}` });

  /**
   * A market the worker closed at its close three days ago: its scheduled judgement (the
   * factory's, a day after the event deadline a day after the close) passed a day ago, so it reads
   * '판정 지연' with no record (#173 item 11).
   */
  function closed(input: Parameters<typeof createMarket>[1] = {}) {
    return createMarket(t.db, {
      createdBy: other.id,
      categoryId: category.id,
      status: 'closed',
      openAt: new Date(Date.now() - 10 * DAY_MS),
      closeAt: new Date(Date.now() - 3 * DAY_MS),
      ...input,
    });
  }
  /**
   * `closed()`'s market judged v1 by `other` and approved by `third` (the routes' history) at
   * `publishedAt` with a 60-minute window — two hours ago unless told, so its deadline has passed
   * and nothing holds it yet.
   */
  async function provisional(publishedAt?: Date) {
    const at = publishedAt ?? new Date((await clockTimestamp(t.db)).getTime() - 2 * HOUR_MS);
    return createProvisionalMarket(t.db, {
      marketId: (await closed()).id,
      registeredBy: other.id,
      approvedBy: third.id,
      publishedAt: at,
      disputeWindowMinutes: 60,
    });
  }
  /**
   * A pending 판정 이의 on the market's current version: submitted half an hour before its
   * deadline, or now when that is still ahead.
   */
  async function held(market: { id: string; disputeDeadline: Date | null }) {
    const before = market.disputeDeadline!.getTime() - 30 * MINUTE_MS;
    return createDispute(t.db, {
      marketId: market.id,
      submittedAt: new Date(Math.min(before, (await clockTimestamp(t.db)).getTime())),
    });
  }

  const data = <T>(res: Res) => res.json<{ data: T }>().data;
  const detail = (res: Res) => data<AdminMarket>(res);
  const errorOf = (res: Res) => res.json<ErrorBody>().error;

  /** An account as the admin screens name it: its id and its nickname. */
  const actorOf = async (user: TestUser) => {
    const [profile] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, user.id));
    return { id: user.id, nickname: profile!.nickname };
  };

  /** A refusal VALIDATION_ERROR naming `path` with `message`. */
  function expectRefused(res: Res, path: string, message: string) {
    expect({ status: res.statusCode, details: errorOf(res).details }).toEqual({
      status: 400,
      details: [{ path: [path], message }],
    });
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  }

  async function marketRow(id: string) {
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, id));
    return row!;
  }
  async function eventsFor(marketId: string) {
    return t.db
      .select()
      .from(schema.marketEvents)
      .where(eq(schema.marketEvents.marketId, marketId))
      .orderBy(asc(schema.marketEvents.id));
  }
  /** The market's records, the newest first (by `event_id`, the commit order). */
  async function delaysOf(marketId: string) {
    return t.db
      .select()
      .from(schema.marketJudgementDelays)
      .where(eq(schema.marketJudgementDelays.marketId, marketId))
      .orderBy(desc(schema.marketJudgementDelays.eventId));
  }
  /** The market's `market_delay_record` rows, oldest first. */
  async function delayActionsFor(marketId: string) {
    return t.db
      .select()
      .from(schema.adminActions)
      .where(
        and(
          eq(schema.adminActions.targetId, marketId),
          eq(schema.adminActions.type, 'market_delay_record'),
        ),
      )
      .orderBy(asc(schema.adminActions.createdAt), asc(schema.adminActions.id));
  }
  async function requestsFor(marketId: string) {
    return t.db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.targetId, marketId));
  }
  async function judgementsFor(marketId: string) {
    return t.db
      .select()
      .from(schema.marketJudgements)
      .where(eq(schema.marketJudgements.marketId, marketId));
  }

  /** Subscribes to the market's channel for the length of `body`. */
  async function listening(marketId: string, body: (received: string[]) => Promise<void>) {
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel, message) => received.push(message));
    await subscriber.subscribe(marketChannel(marketId));
    try {
      await body(received);
    } finally {
      await subscriber.quit();
    }
  }

  // --- the record -------------------------------------------------------------------------------
  it('records a delayed closed market’s reason and next review time at once: the event, the record, the admin action, the status republished unchanged, nothing of the market moved, the public detail naming nobody', async () => {
    const market = await closed();
    const before = await marketRow(market.id);
    // Odd milliseconds, so no other instant of an answer holds it.
    const next = Date.now() + DAY_MS + 123;
    await listening(market.id, async (received) => {
      const res = await record(market.id, recorder, {
        reason: `  ${REASON}  `,
        nextReviewAt: iso(next),
      });
      expect(res.statusCode, res.body).toBe(200);
      const answer = detail(res);
      const [row] = await delaysOf(market.id);
      const events = await eventsFor(market.id);
      expect(events.map((event) => event.type)).toEqual(['judgement_delay_recorded']);
      const event = events[0]!;
      const fields = {
        delayId: row!.id,
        reason: REASON,
        nextReviewAt: iso(next),
        marketStatus: 'closed',
        judgementVersion: null,
      };
      expect(event).toMatchObject({
        actorId: recorder.id,
        fromStatus: null,
        toStatus: null,
        payload: fields,
      });
      expect(row).toEqual({
        id: row!.id,
        marketId: market.id,
        reason: REASON,
        nextReviewAt: new Date(next),
        marketStatus: 'closed',
        judgementVersion: null,
        recordedBy: recorder.id,
        recordedAt: event.createdAt,
        eventId: event.id,
      });
      // Nothing of the market moved: no status, no result, no times, no key, no `updated_at`.
      expect(await marketRow(market.id)).toEqual(before);
      expect(await requestsFor(market.id)).toEqual([]);
      expect(await judgementsFor(market.id)).toEqual([]);
      const actions = await delayActionsFor(market.id);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        adminId: recorder.id,
        targetType: 'market',
        createdAt: event.createdAt,
        payload: fields,
      });
      expect(answer).toMatchObject({
        status: 'closed',
        resolvedResult: null,
        judgementVersion: null,
        statusEventId: null,
        updatedAt: before.updatedAt.toISOString(),
        judgementDelayed: true,
        judgementDelay: { reason: REASON, nextReviewAt: iso(next), nextReviewPassed: false },
        judgementDelays: [
          {
            id: row!.id,
            reason: REASON,
            nextReviewAt: iso(next),
            marketStatus: 'closed',
            judgementVersion: null,
            recordedAt: event.createdAt.toISOString(),
            recordedBy: await actorOf(recorder),
            current: true,
          },
        ],
      });
      expect(answer.judgement.current).toBeNull();
      expect(answer.events[0]).toMatchObject({
        type: 'judgement_delay_recorded',
        actorId: recorder.id,
        fromStatus: null,
        toStatus: null,
      });
      // Published once after COMMIT: the unchanged status under the unchanged key (none here: the
      // factory's closed market has no transition event), so an open detail refetches.
      await waitForMessages(received, 1, 'market:status of the record');
      await sleep(100);
      expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
        {
          type: 'market:status',
          marketId: market.id,
          status: 'closed',
          resolvedResult: null,
          statusEventId: null,
          ts: before.updatedAt.toISOString(),
        },
      ]);
    });

    // The public detail: the current record's reason, its time and whether it passed — nothing
    // of who recorded it, when, or its id (#173 item 13, decision 3); still CLOSED, no result.
    const pub = await publicDetail(market.slug);
    expect(pub.statusCode).toBe(200);
    const shown = data<Market>(pub);
    expect(shown).toMatchObject({ status: 'closed', resolvedResult: null, judgementDelayed: true });
    expect(shown.judgementDelay).toEqual({
      reason: REASON,
      nextReviewAt: iso(next),
      nextReviewPassed: false,
    });
    expect(shown).not.toHaveProperty('judgementDelays');
    const [row] = await delaysOf(market.id);
    for (const hidden of [recorder.id, row!.id, row!.recordedAt.toISOString()]) {
      expect(pub.body).not.toContain(hidden);
    }
    // A card carries the label alone, never the record (ADR-0095 8-6).
    const cards = await t.app.inject({ method: 'GET', url: '/api/v1/markets?status=closed' });
    const card = cards.json<{ data: Record<string, unknown>[] }>().data.find((item) => {
      return item.id === market.id;
    });
    expect(card).toMatchObject({ judgementDelayed: true });
    expect(card).not.toHaveProperty('judgementDelay');
  });

  it('records on a provisional market a dispute or a waiting correction holds past its deadline, on its judgement version, republishing the provisional key', async () => {
    const { market: disputed, eventId } = await provisional();
    expect(disputed.disputeDeadline!.getTime()).toBeLessThan(Date.now());
    await held(disputed);
    const before = await marketRow(disputed.id);
    await listening(disputed.id, async (received) => {
      const res = await record(disputed.id);
      expect(res.statusCode, res.body).toBe(200);
      const [row] = await delaysOf(disputed.id);
      expect(row).toMatchObject({ marketStatus: 'provisional', judgementVersion: 1 });
      expect((await eventsFor(disputed.id)).at(-1)).toMatchObject({
        type: 'judgement_delay_recorded',
        fromStatus: null,
        toStatus: null,
        payload: { delayId: row!.id, marketStatus: 'provisional', judgementVersion: 1 },
      });
      expect(await marketRow(disputed.id)).toEqual(before);
      expect(detail(res)).toMatchObject({
        status: 'provisional',
        resolvedResult: 'YES',
        judgementVersion: 1,
        statusEventId: String(eventId),
        disputeUnderReview: true,
        judgementDelayed: true,
        judgementDelay: { reason: REASON, nextReviewPassed: false },
        judgementDelays: [{ id: row!.id, marketStatus: 'provisional', judgementVersion: 1 }],
      });
      await waitForMessages(received, 1, 'market:status of the record');
      await sleep(100);
      expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
        {
          type: 'market:status',
          marketId: disputed.id,
          status: 'provisional',
          resolvedResult: 'YES',
          statusEventId: String(eventId),
          ts: before.updatedAt.toISOString(),
        },
      ]);
    });
    expect(data<Market>(await publicDetail(disputed.id)).judgementDelay).toMatchObject({
      reason: REASON,
      nextReviewPassed: false,
    });

    // A waiting correction holds one too (#176): registered by `third`, who may record as well.
    const { market: correcting } = await provisional();
    await createCorrectionRequest(t.db, { marketId: correcting.id, by: third.id });
    const res = await record(correcting.id, third);
    expect(res.statusCode, res.body).toBe(200);
    expect(await delaysOf(correcting.id)).toEqual([
      expect.objectContaining({
        marketStatus: 'provisional',
        judgementVersion: 1,
        recordedBy: third.id,
      }),
    ]);
    expect(detail(res)).toMatchObject({ disputeUnderReview: false, judgementDelayed: true });
  });

  it('takes a record from any admin, the registrant of a waiting judgement included: the registration refuses nothing and stays waiting', async () => {
    const market = await closed();
    const registration = await createJudgementRequest(t.db, {
      marketId: market.id,
      by: recorder.id,
    });
    const res = await record(market.id, recorder);
    expect(res.statusCode, res.body).toBe(200);
    expect(detail(res).judgement.pending).toMatchObject({ requestId: registration.id });
    expect((await requestsFor(market.id)).map((row) => row.status)).toEqual(['pending']);
    expect((await delaysOf(market.id)).map((row) => row.recordedBy)).toEqual([recorder.id]);
  });

  // --- refusals ---------------------------------------------------------------------------------
  it('refuses a record for its body, then in order: an unknown market, a status not awaiting a judgement, a market not delayed, a next review time not after now, more than 7 days ahead — writing nothing', async () => {
    const market = await closed();
    // The body's own: the reason (1–500, trimmed), the next review time (an ISO instant in UTC
    // with its seconds) — a day ahead, which the service would take, without its seconds or with
    // an offset, so the refusal is the body's and none of the service's.
    const ahead = Date.now() + DAY_MS;
    const cases: [Record<string, unknown>, string][] = [
      [{ reason: '   ' }, 'reason'],
      [{ reason: 'x'.repeat(501) }, 'reason'],
      [{ reason: undefined }, 'reason'],
      [{ nextReviewAt: undefined }, 'nextReviewAt'],
      [{ nextReviewAt: '다음 주' }, 'nextReviewAt'],
      [{ nextReviewAt: iso(ahead).replace(/:\d{2}\.\d{3}Z$/, 'Z') }, 'nextReviewAt'],
      [{ nextReviewAt: iso(ahead + 9 * HOUR_MS).replace(/\.\d{3}Z$/, '+09:00') }, 'nextReviewAt'],
    ];
    const serviceRefusals: string[] = Object.values(MARKET_JUDGEMENT_DELAY_REFUSALS.nextReviewAt);
    for (const [payload, path] of cases) {
      const res = await record(market.id, recorder, payload);
      expect({ payload, status: res.statusCode }).toEqual({ payload, status: 400 });
      const details = errorOf(res).details ?? [];
      expect(details.map((issue) => issue.path)).toEqual([[path]]);
      expect(details.filter((issue) => serviceRefusals.includes(issue.message))).toEqual([]);
    }
    expect((await record(NO_MARKET)).statusCode).toBe(404);
    // Not awaiting a judgement: every status but CLOSED and PROVISIONAL — before the time too.
    const past = { nextReviewAt: iso(Date.now() - MINUTE_MS) };
    for (const status of [
      'draft',
      'review',
      'scheduled',
      'open',
      'paused',
      'resolved',
      'settling',
      'settled',
      'cancelled',
    ] as const) {
      const done = status === 'resolved' || status === 'settling' || status === 'settled';
      const otherStatus = await createMarket(t.db, {
        createdBy: other.id,
        categoryId: category.id,
        status,
        closeAt: new Date(Date.now() - 3 * DAY_MS),
        ...(done ? { resolvedResult: 'YES' as const, resolvedAt: new Date() } : {}),
      });
      expectRefused(
        await record(otherStatus.id, recorder, past),
        'status',
        'not awaiting a judgement',
      );
      expect(await delaysOf(otherStatus.id)).toEqual([]);
    }
    // Not delayed — before the time too: a CLOSED market before its scheduled judgement or with
    // none (opened before #22), a PROVISIONAL one before its deadline though a dispute holds it,
    // or past it with nothing holding.
    const early = await closed({ closeAt: new Date(Date.now() - HOUR_MS) });
    expect(early.scheduledJudgementAt!.getTime()).toBeGreaterThan(Date.now());
    const unscheduled = await closed({ scheduledJudgementAt: null });
    const { market: open } = await provisional(new Date(Date.now() - 1_000));
    await held(open);
    const { market: quiet } = await provisional();
    const notDelayed = [early, unscheduled, open, quiet];
    for (const notYet of notDelayed) {
      expectRefused(await record(notYet.id, recorder, past), 'status', 'not delayed');
    }
    // The next review time: not after now, then more than 7 × 24 hours ahead.
    expectRefused(await record(market.id, recorder, past), 'nextReviewAt', 'not after now');
    expectRefused(
      await record(market.id, recorder, {
        nextReviewAt: iso(Date.now() + JUDGEMENT_DELAY_REVIEW_MAX_MS + MINUTE_MS),
      }),
      'nextReviewAt',
      'more than 7 days ahead',
    );
    // Nothing was written by any refusal.
    for (const id of [market.id, ...notDelayed.map((row) => row.id)]) {
      expect(await delaysOf(id)).toEqual([]);
      expect(await delayActionsFor(id)).toEqual([]);
    }
    expect(await eventsFor(market.id)).toEqual([]);
  });

  // --- the clock --------------------------------------------------------------------------------
  it('judges the market and the next review time on the database clock read after the market lock, as it finds the market then', async () => {
    const start = (await clockTimestamp(t.db)).getTime();
    // Its scheduled judgement a second and a half ahead: not delayed yet.
    const soon = await createMarket(t.db, {
      createdBy: other.id,
      categoryId: category.id,
      status: 'closed',
      closeAt: new Date(start - HOUR_MS),
      eventDeadline: new Date(start - 30 * MINUTE_MS),
      scheduledJudgementAt: new Date(start + 1_500),
    });
    const late = await closed();
    // More than 7 × 24 hours after now — by two seconds.
    const farAhead = iso(start + JUDGEMENT_DELAY_REVIEW_MAX_MS + 2_000);
    const tomorrow = iso(start + DAY_MS);
    expectRefused(
      await record(soon.id, recorder, { nextReviewAt: tomorrow }),
      'status',
      'not delayed',
    );
    expectRefused(
      await record(late.id, recorder, { nextReviewAt: farAhead }),
      'nextReviewAt',
      'more than 7 days ahead',
    );
    // The same two queued behind the market locks for three seconds: the clock they read after
    // the locks has passed the scheduled judgement, and the time is within 7 × 24 hours of it.
    const holder = await t.db.$client.connect();
    let pending: Promise<Res>[] = [];
    let released = false;
    let releasedAt: number | undefined;
    try {
      for (const id of [soon.id, late.id]) {
        await holder.query('SELECT pg_advisory_lock(hashtext($1))', [id]);
      }
      pending = [
        record(soon.id, recorder, { nextReviewAt: tomorrow }),
        record(late.id, recorder, { nextReviewAt: farAhead }),
      ];
      await waitForLockWaiter(holder, 'the two records on their market locks', 2);
      await sleep(Math.max(0, start + 3_000 - (await clockTimestamp(t.db)).getTime()));
      releasedAt = (await clockTimestamp(t.db)).getTime();
      await holder.query('SELECT pg_advisory_unlock_all()');
      released = true;
      for (const res of await Promise.all(pending)) expect(res.statusCode, res.body).toBe(200);
    } finally {
      if (!released) await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
      await Promise.allSettled(pending);
    }
    for (const id of [soon.id, late.id]) {
      const [row] = await delaysOf(id);
      expect(row!.recordedAt.getTime()).toBeGreaterThanOrEqual(releasedAt);
    }
    const [far] = await delaysOf(late.id);
    expect(far!.nextReviewAt.getTime() - far!.recordedAt.getTime()).toBeLessThanOrEqual(
      JUDGEMENT_DELAY_REVIEW_MAX_MS,
    );

    // And a record queued behind a judgement's approval is judged on the PROVISIONAL market the
    // approval left — before its deadline, nothing holding it: not delayed.
    await setReleaseSetting(t.db, {
      adminId: other.id,
      key: DISPUTE_WINDOW_SETTING.key,
      status: 'test',
      value: 60,
    });
    const judged = await closed();
    const registration = await createJudgementRequest(t.db, { marketId: judged.id, by: other.id });
    const locker = await t.db.$client.connect();
    let queued: Promise<Res>[] = [];
    let unlocked = false;
    try {
      await locker.query('SELECT pg_advisory_lock(hashtext($1))', [judged.id]);
      const approval = post(
        `${marketUrl(judged.id)}/judgements/${registration.id}/approve`,
        third,
        {
          reason: '증거와 출처가 규칙에 맞다.',
          eventDeadlineConfirmed: false,
        },
      );
      await waitForLockWaiter(locker, 'the approval on the market lock');
      const delay = record(judged.id);
      await waitForLockWaiter(locker, 'the record on the market lock', 2);
      queued = [approval, delay];
      await locker.query('SELECT pg_advisory_unlock_all()');
      unlocked = true;
      const [approved, refused] = await Promise.all(queued);
      expect(approved!.statusCode, approved!.body).toBe(200);
      expectRefused(refused!, 'status', 'not delayed');
    } finally {
      if (!unlocked) await locker.query('SELECT pg_advisory_unlock_all()');
      locker.release();
      await Promise.allSettled(queued);
    }
    expect(await delaysOf(judged.id)).toEqual([]);
  });

  it('takes the bounds to the millisecond on the database clock: from the scheduled judgement or the deadline on, a next review time from a millisecond after now to exactly 7 × 24 hours ahead', async () => {
    // A day behind the host's clock and the request's time alike.
    const now = (await clockTimestamp(t.db)).getTime() - DAY_MS;
    const at = (ms: number) => new Date(now + ms);
    const closedAt = (scheduledJudgement: number) =>
      createMarket(t.db, {
        createdBy: other.id,
        categoryId: category.id,
        status: 'closed',
        closeAt: at(-3 * DAY_MS),
        eventDeadline: at(-2 * DAY_MS),
        scheduledJudgementAt: at(scheduledJudgement),
      });
    const provisionalAt = (deadline: number, hold: 'dispute' | 'correction') =>
      createMarket(t.db, {
        createdBy: other.id,
        categoryId: category.id,
        status: 'provisional',
        closeAt: at(-3 * DAY_MS),
        disputeDeadline: at(deadline),
        ...(hold === 'dispute' ? { disputeHoldCount: 1 } : { correctionPending: true }),
      });
    const reached = await closedAt(0);
    const notYet = await closedAt(1);
    const disputedAt = await provisionalAt(0, 'dispute');
    const disputedBefore = await provisionalAt(1, 'dispute');
    const correctedAt = await provisionalAt(0, 'correction');
    const correctedBefore = await provisionalAt(1, 'correction');
    /** `body`'s requests with the API's database clock pinned at `now`. */
    const pinnedAt = async <T>(body: () => Promise<T>): Promise<T> => {
      clock.pinned = new Date(now);
      try {
        return await body();
      } finally {
        clock.pinned = null;
      }
    };
    const at7Days = iso(now + JUDGEMENT_DELAY_REVIEW_MAX_MS);
    const results = await pinnedAt(async () => ({
      notYet: await record(notYet.id, recorder, { nextReviewAt: at7Days }),
      disputedBefore: await record(disputedBefore.id, recorder, { nextReviewAt: at7Days }),
      correctedBefore: await record(correctedBefore.id, recorder, { nextReviewAt: at7Days }),
      atNow: await record(reached.id, recorder, { nextReviewAt: iso(now) }),
      beyond: await record(reached.id, recorder, {
        nextReviewAt: iso(now + 1 + JUDGEMENT_DELAY_REVIEW_MAX_MS),
      }),
      justAfter: await record(reached.id, recorder, { nextReviewAt: iso(now + 1) }),
      exactly: await record(reached.id, other, { nextReviewAt: at7Days }),
      disputed: await record(disputedAt.id, recorder, { nextReviewAt: at7Days }),
      corrected: await record(correctedAt.id, recorder, { nextReviewAt: at7Days }),
    }));
    for (const refused of [results.notYet, results.disputedBefore, results.correctedBefore]) {
      expectRefused(refused, 'status', 'not delayed');
    }
    expectRefused(results.atNow, 'nextReviewAt', 'not after now');
    expectRefused(results.beyond, 'nextReviewAt', 'more than 7 days ahead');
    for (const taken of [results.justAfter, results.exactly, results.disputed, results.corrected]) {
      expect(taken.statusCode, taken.body).toBe(200);
    }
    // Each recorded at that clock: the row, its event and its admin action.
    const rows = await delaysOf(reached.id);
    expect(rows.map((row) => [row.nextReviewAt.toISOString(), row.recordedBy])).toEqual([
      [at7Days, other.id],
      [iso(now + 1), recorder.id],
    ]);
    for (const row of rows) expect(row.recordedAt).toEqual(new Date(now));
    expect((await eventsFor(reached.id)).map((event) => event.createdAt)).toEqual([
      new Date(now),
      new Date(now),
    ]);
    expect((await delayActionsFor(reached.id)).map((action) => action.createdAt)).toEqual([
      new Date(now),
      new Date(now),
    ]);
    expect(
      (await delaysOf(disputedAt.id)).map((row) => [row.marketStatus, row.judgementVersion]),
    ).toEqual([['provisional', 1]]);
    // The answer reads the displays on the host's clock: the newest is current, its time ahead.
    expect(detail(results.exactly)).toMatchObject({
      judgementDelay: { nextReviewAt: at7Days, nextReviewPassed: false },
      judgementDelays: [{ current: true }, { current: false }],
    });
  });

  // --- the history ------------------------------------------------------------------------------
  it('keeps every record: a second is a new record, current, the first its history, the newest first — the market still CLOSED and unjudged; a passed next review time reads passed and nothing follows', async () => {
    const market = await closed();
    const before = await marketRow(market.id);
    const first = Date.now() + DAY_MS;
    const second = Date.now() + 2 * DAY_MS;
    await listening(market.id, async (received) => {
      expect((await record(market.id, recorder, { nextReviewAt: iso(first) })).statusCode).toBe(
        200,
      );
      const res = await record(market.id, other, {
        reason: SECOND_REASON,
        nextReviewAt: iso(second),
      });
      expect(res.statusCode, res.body).toBe(200);
      const rows = await delaysOf(market.id);
      expect(rows.map((row) => [row.reason, row.recordedBy])).toEqual([
        [SECOND_REASON, other.id],
        [REASON, recorder.id],
      ]);
      expect(detail(res).judgementDelays).toEqual([
        {
          id: rows[0]!.id,
          reason: SECOND_REASON,
          nextReviewAt: iso(second),
          marketStatus: 'closed',
          judgementVersion: null,
          recordedAt: rows[0]!.recordedAt.toISOString(),
          recordedBy: await actorOf(other),
          current: true,
        },
        {
          id: rows[1]!.id,
          reason: REASON,
          nextReviewAt: iso(first),
          marketStatus: 'closed',
          judgementVersion: null,
          recordedAt: rows[1]!.recordedAt.toISOString(),
          recordedBy: await actorOf(recorder),
          current: false,
        },
      ]);
      expect(detail(res).judgementDelay).toEqual({
        reason: SECOND_REASON,
        nextReviewAt: iso(second),
        nextReviewPassed: false,
      });
      const events = await eventsFor(market.id);
      expect(events.map((event) => [event.type, event.actorId])).toEqual([
        ['judgement_delay_recorded', recorder.id],
        ['judgement_delay_recorded', other.id],
      ]);
      expect(events.map((event) => event.id)).toEqual([rows[1]!.eventId, rows[0]!.eventId]);
      expect((await delayActionsFor(market.id)).map((action) => action.adminId)).toEqual([
        recorder.id,
        other.id,
      ]);
      // Two records, and the market is as it was: CLOSED, no result, no judgement, no request.
      expect(await marketRow(market.id)).toEqual(before);
      expect(detail(res).judgement.current).toBeNull();
      expect(await judgementsFor(market.id)).toEqual([]);
      expect(await requestsFor(market.id)).toEqual([]);
      await waitForMessages(received, 2, 'market:status of the two records');
      await sleep(100);
      expect(new Set(received).size).toBe(1);
    });
    expect(data<Market>(await publicDetail(market.id)).judgementDelay).toEqual({
      reason: SECOND_REASON,
      nextReviewAt: iso(second),
      nextReviewPassed: false,
    });

    // A record whose next review time has passed with no new one: the public keeps its reason and
    // reads the time as passed ('갱신 대기'), the admin detail likewise — and nothing else follows.
    // Closed five days ago: its scheduled judgement passed three days ago, before the record.
    const lapsed = await closed({ closeAt: new Date(Date.now() - 5 * DAY_MS) });
    const recordedAt = new Date((await clockTimestamp(t.db)).getTime() - 2 * DAY_MS);
    const passedAt = new Date(recordedAt.getTime() + DAY_MS);
    await createJudgementDelay(t.db, {
      marketId: lapsed.id,
      by: recorder.id,
      recordedAt,
      nextReviewAt: passedAt,
    });
    const lapsedBefore = await marketRow(lapsed.id);
    const passed = data<Market>(await publicDetail(lapsed.id));
    expect(passed).toMatchObject({
      status: 'closed',
      resolvedResult: null,
      judgementDelayed: true,
    });
    expect(passed.judgementDelay).toMatchObject({
      nextReviewAt: passedAt.toISOString(),
      nextReviewPassed: true,
    });
    const admin = detail(await get(marketUrl(lapsed.id)));
    expect(admin.judgementDelay).toMatchObject({ nextReviewPassed: true });
    expect(admin.judgementDelays).toEqual([expect.objectContaining({ current: true })]);
    expect(await marketRow(lapsed.id)).toEqual(lapsedBefore);
    // A new record is the update: current, its time ahead.
    const renewed = await record(lapsed.id, other, { reason: SECOND_REASON });
    expect(detail(renewed).judgementDelay).toMatchObject({
      reason: SECOND_REASON,
      nextReviewPassed: false,
    });
  });

  it('moves the current record with the episode: a judgement’s approval leaves the closed market’s records history, a rejected correction keeps the version’s current, a correction’s approval and the confirmation leave it history', async () => {
    const market = await closed();
    const clockNow = (await clockTimestamp(t.db)).getTime();
    // Recorded while CLOSED, three hours ago; then the judgement approved two hours ago with a
    // 60-minute window: its deadline has passed and nothing holds it.
    await createJudgementDelay(t.db, {
      marketId: market.id,
      by: recorder.id,
      recordedAt: new Date(clockNow - 3 * HOUR_MS),
    });
    const { market: judged } = await createProvisionalMarket(t.db, {
      marketId: market.id,
      registeredBy: other.id,
      approvedBy: third.id,
      publishedAt: new Date(clockNow - 2 * HOUR_MS),
      disputeWindowMinutes: 60,
    });
    const shownPublic = async () => data<Market>(await publicDetail(market.id));
    const shownAdmin = async () => detail(await get(marketUrl(market.id)));
    const currents = async () => (await shownAdmin()).judgementDelays.map((row) => row.current);
    expect(await shownPublic()).toMatchObject({ judgementDelayed: false, judgementDelay: null });
    expect(await currents()).toEqual([false]);
    // A dispute holds it past its deadline: '판정 지연' with no current record — the CLOSED one is
    // the earlier episode's, never this one's reason.
    await held(judged);
    expect(await shownPublic()).toMatchObject({ judgementDelayed: true, judgementDelay: null });
    expect(await currents()).toEqual([false]);
    const res = await record(market.id, recorder, { reason: SECOND_REASON });
    expect(res.statusCode, res.body).toBe(200);
    expect(detail(res).judgementDelays.map((row) => [row.marketStatus, row.current])).toEqual([
      ['provisional', true],
      ['closed', false],
    ]);
    expect((await shownPublic()).judgementDelay).toMatchObject({ reason: SECOND_REASON });

    // A correction registered and rejected (#176): v1 and its deadline continue, and so does its
    // record.
    const correction = await createCorrectionRequest(t.db, { marketId: market.id, by: third.id });
    const rejected = await post(
      `${marketUrl(market.id)}/judgements/${correction.id}/reject`,
      recorder,
      { reason: '정정할 근거가 없다.' },
    );
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await currents()).toEqual([true, false]);
    expect((await shownPublic()).judgementDelay).toMatchObject({ reason: SECOND_REASON });

    // A correction approved: v2 with a new deadline ahead, nothing holding it — v1's record is
    // history, and no record is taken until it is delayed again.
    await createCorrectedMarket(t.db, {
      marketId: market.id,
      registeredBy: third.id,
      approvedBy: other.id,
    });
    expect(await shownPublic()).toMatchObject({
      judgementVersion: 2,
      judgementDelayed: false,
      judgementDelay: null,
    });
    expect(await currents()).toEqual([false, false]);
    expectRefused(await record(market.id), 'status', 'not delayed');

    // Confirmed: no record is current, every one is kept, and none is taken any more.
    await resolveMarketNow(t.db, market.id);
    const resolved = await shownAdmin();
    expect(resolved).toMatchObject({ status: 'resolved', judgementDelay: null });
    expect(resolved.judgementDelays.map((row) => row.current)).toEqual([false, false]);
    expect((await shownPublic()).judgementDelay).toBeNull();
    expectRefused(await record(market.id), 'status', 'not awaiting a judgement');
    expect(await delaysOf(market.id)).toHaveLength(2);
  });

  // --- the admin on screen ----------------------------------------------------------------------
  it('asks the record for the admin on screen, before anything is read or written', async () => {
    const market = await closed();
    const res = await record(market.id, third, { expectedAccountId: other.id });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).details?.map((issue) => issue.path)).toEqual([['expectedAccountId']]);
    // A write that names none is the pipe's 400 on the field.
    const unnamed = await t.app.inject({
      method: 'POST',
      url: `${marketUrl(market.id)}/judgement-delays`,
      headers: { ...jsonHeaders, cookie: recorder.cookie },
      payload: { reason: REASON, nextReviewAt: iso(Date.now() + DAY_MS) },
    });
    expect(unnamed.statusCode).toBe(400);
    expect(errorOf(unnamed).details?.map((issue) => issue.path)).toEqual([['expectedAccountId']]);
    // A member is no admin.
    const member = await signUpTestUser(t);
    expect((await record(market.id, member)).statusCode).toBe(403);
    expect(await delaysOf(market.id)).toEqual([]);
  });
});
