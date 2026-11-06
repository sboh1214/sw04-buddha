/**
 * 판정 이의 (#175, ADR-0104; ADR-0093 decision 1 #173 items 1·2·5–8·12·13·15, the owner's answers
 * of 2026-11-02 and 2026-11-03) through the routes against the docker `test` profile: a member's
 * submission — by either side of a fill, refused for its body and, in order, for a market that is
 * not public, not provisional, a stale version, the deadline on the database clock, an admin, no
 * fill and one per version (a retracted one included), open under a restriction, closed to an
 * account that has not finished the onboarding — holding the market, republishing its unchanged
 * status and writing no admin action; the 철회 (pending, within the deadline, one's own, signed in
 * is enough); the member's reads (MY 판정 이의, the dispute screen's standing), never the decider;
 * one admin's 기각·수용 — never the version's registrant, its approver may — with the record, the
 * republish, an acceptance still holding and the last dismissal past the deadline registering
 * `market.resolve` with no delay (the worker's confirmation is apps/worker's); the public labels
 * across the deadline on the detail, the cards and a post's badge; the admin detail's disputes and
 * 이의 접수 with its keyset; two writes of one dispute at once; and the screen's account. No fill
 * exists before #119: the factories write them. Skips when TEST_* are unset.
 */
import { clockTimestamp, schema } from '@buddha/db';
import {
  completeOnboarding,
  createDispute,
  createFill,
  createMarket,
  createModerationAction,
  createPost,
  createProvisionalMarket,
  resolveMarketNow,
} from '@buddha/db/test';
import {
  JOB_NAMES,
  marketChannel,
  marketResolveJobId,
  type AdminDisputeQueueItem,
  type AdminMarket,
  type Market,
  type MarketSummary,
  type MyDispute,
  type MyMarketDispute,
  type PostMarket,
} from '@buddha/shared';
import { Queue } from 'bullmq';
import { and, asc, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { MARKETS_QUEUE } from '../jobs/market-jobs.service.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter, waitForMessages } from '../test/wait.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A well-formed id that names nothing. */
const NOTHING = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';

const LINK = 'https://www.bok.or.kr/press/2026-11';
const REASON = '발표 원문은 3.25%인데 판정은 3.00%로 보았다.';
const DECISION = '발표 원문을 다시 확인했고 판정과 같다.';

type ErrorBody = {
  error: { code: string; message: string; details?: unknown };
};
type Page<T> = { data: T[]; meta: { nextCursor: string | null } };
type Res = { statusCode: number; json: <U>() => U; body: string };

describe.skipIf(!hasTestInfra)('market disputes (integration)', () => {
  let t: TestApp;
  /** The worker's view of the `markets` queue: a plain Queue on its own client. */
  let inspector: Redis;
  let jobQueue: Queue;
  /** Registers every judgement here unless a test says otherwise. */
  let registrant: TestUser;
  /** Approves them. */
  let approver: TestUser;
  /** Neither: decides disputes. */
  let third: TestUser;
  /** A member with a fill on the markets that need one (`fillOn`). */
  let member: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    inspector = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    jobQueue = new Queue(MARKETS_QUEUE, { connection: inspector });
  });
  afterAll(async () => {
    await jobQueue?.close();
    await inspector?.quit();
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });

  /** A member who finished the onboarding (#58). */
  async function makeMember(): Promise<TestUser> {
    const user = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: user.id });
    return user;
  }
  /** An admin who finished the onboarding (ADR-0072), past the guard's role cache. */
  async function makeAdmin(): Promise<TestUser> {
    const user = await makeMember();
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, user.id));
    await t.app.get(AdminGuard).invalidate(user.id);
    return user;
  }

  beforeEach(async () => {
    await t.reset();
    await jobQueue.obliterate({ force: true });
    registrant = await makeAdmin();
    approver = await makeAdmin();
    third = await makeAdmin();
    member = await makeMember();
  });

  /**
   * A PROVISIONAL market judged by `registrant` and approved by `approver`, its 이의 기한 at
   * `deadline` — a day after the publication (the window), so a deadline a day ahead at most is
   * published now or earlier. Default: published now, the deadline a day ahead.
   */
  async function provisional(deadline?: Date) {
    const at = deadline ?? new Date((await clockTimestamp(t.db)).getTime() + DAY_MS);
    const { market } = await createProvisionalMarket(t.db, {
      registeredBy: registrant.id,
      approvedBy: approver.id,
      publishedAt: new Date(at.getTime() - DAY_MS),
      disputeWindowMinutes: 1_440,
    });
    expect(market.disputeDeadline).toEqual(at);
    return market;
  }
  /** A PROVISIONAL market published `hours` ago, its deadline a day after that. */
  const publishedAgo = async (hours: number) =>
    provisional(new Date((await clockTimestamp(t.db)).getTime() + DAY_MS - hours * HOUR_MS));
  /** A fill on `marketId` with `taker` and `maker` (a fresh account unless named) on its sides. */
  const fillOn = (marketId: string, taker: TestUser, maker?: TestUser) =>
    createFill(t.db, {
      marketId,
      userId: taker.id,
      ...(maker ? { makerId: maker.id } : {}),
      amountCoin: 50n,
    });
  /**
   * An admin's fill on `marketId`, as one can come about: made while the account was a member,
   * the role granted after (#143) — an admin owns no order (migration 0062,
   * `orders_refuse_admin_owner`).
   */
  const fillBeforeGrant = async (marketId: string, admin: TestUser) => {
    const role = (value: 'user' | 'admin') =>
      t.db.update(schema.profiles).set({ role: value }).where(eq(schema.profiles.userId, admin.id));
    await role('user');
    await fillOn(marketId, admin);
    await role('admin');
    await t.app.get(AdminGuard).invalidate(admin.id);
  };

  // Every write names the account on screen (ADR-0092): `who`'s own unless the payload names
  // another.
  const post = (url: string, who: TestUser, payload: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...payload },
    });
  const get = (url: string, who?: TestUser) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: who ? { cookie: who.cookie } : {},
    });

  const submit = (
    marketId: string,
    who: TestUser = member,
    payload: Record<string, unknown> = {},
  ) =>
    post(`/markets/${marketId}/disputes`, who, {
      judgementVersion: 1,
      links: [LINK],
      reason: REASON,
      ...payload,
    });
  const retract = (disputeId: string, who: TestUser = member) =>
    post(`/me/disputes/${disputeId}/retract`, who);
  const decide = (
    decision: 'dismiss' | 'accept',
    marketId: string,
    disputeId: string,
    who: TestUser = third,
    payload: Record<string, unknown> = {},
  ) =>
    post(`/admin/markets/${marketId}/disputes/${disputeId}/${decision}`, who, {
      reason: DECISION,
      ...payload,
    });
  const standing = (marketId: string, who: TestUser = member) =>
    get(`/me/disputes/markets/${marketId}`, who);

  const data = <T>(res: Res, status = 200) => {
    expect(res.statusCode, res.body).toBe(status);
    return res.json<{ data: T }>().data;
  };
  const errorOf = (res: Res) => res.json<ErrorBody>().error;
  /** DISPUTE_NOT_ALLOWED with `reason`. */
  function expectNotAllowed(res: Res, reason: string) {
    expect({ status: res.statusCode, error: errorOf(res) }).toMatchObject({
      status: 409,
      error: { code: 'DISPUTE_NOT_ALLOWED', details: { reason } },
    });
  }
  function expectError(res: Res, status: number, code: string) {
    expect({ status: res.statusCode, code: errorOf(res).code }).toEqual({ status, code });
  }
  /** A VALIDATION_ERROR whose first detail's path starts with `path`. */
  function expectInvalid(res: Res, ...path: (string | number)[]) {
    expectError(res, 400, 'VALIDATION_ERROR');
    const details = errorOf(res).details as { path: (string | number)[]; message: string }[];
    expect(details[0]!.path.slice(0, path.length)).toEqual(path);
    return details;
  }

  async function marketRow(id: string) {
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, id));
    return row!;
  }
  async function disputesOf(marketId: string) {
    return t.db
      .select()
      .from(schema.marketDisputes)
      .where(eq(schema.marketDisputes.marketId, marketId))
      .orderBy(asc(schema.marketDisputes.submittedAt), asc(schema.marketDisputes.id));
  }
  async function disputeActionsOf(marketId: string) {
    const rows = await t.db
      .select()
      .from(schema.adminActions)
      .where(
        and(
          eq(schema.adminActions.targetType, 'market'),
          eq(schema.adminActions.targetId, marketId),
        ),
      )
      .orderBy(asc(schema.adminActions.createdAt));
    return rows.filter((row) => row.type.startsWith('market_dispute'));
  }
  async function eventTypesOf(marketId: string) {
    const rows = await t.db
      .select({ type: schema.marketEvents.type })
      .from(schema.marketEvents)
      .where(eq(schema.marketEvents.marketId, marketId))
      .orderBy(asc(schema.marketEvents.id));
    return rows.map((row) => row.type);
  }
  async function jobIds() {
    const jobs = await jobQueue.getJobs(['delayed', 'waiting', 'active', 'completed', 'failed']);
    return jobs.map((job) => job.id).sort();
  }
  /** The market's public detail, signed out. */
  const publicOf = async (marketId: string) => data<Market>(await get(`/markets/${marketId}`));
  /** The four display flags of a public read. */
  const flagsOf = (
    market: Pick<MarketSummary, 'disputeOpen' | 'disputeUnderReview' | 'judgementDelayed'>,
  ) => ({
    disputeOpen: market.disputeOpen,
    disputeUnderReview: market.disputeUnderReview,
    judgementDelayed: market.judgementDelayed,
  });

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

  /** An account as the admin screens name it: its id and its nickname. */
  const actorOf = async (user: TestUser) => {
    const [profile] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, user.id));
    return { id: user.id, nickname: profile!.nickname };
  };

  // --- 제출 -----------------------------------------------------------------------------------
  it('takes a dispute from either side of a fill, pending, holding the market and republishing its unchanged status, with no admin action', async () => {
    const market = await provisional();
    const maker = await makeMember();
    await fillOn(market.id, member, maker);
    await listening(market.id, async (received) => {
      // The links and the reason as the member typed them, trimmed.
      const res = await submit(market.id, member, {
        links: [`  ${LINK}  `, 'https://kostat.go.kr/press'],
        reason: `  ${REASON}\n`,
      });
      const dispute = data<MyDispute>(res, 201);
      const [row] = await disputesOf(market.id);
      expect(dispute).toEqual({
        id: row!.id,
        judgementVersion: 1,
        links: [LINK, 'https://kostat.go.kr/press'],
        reason: REASON,
        status: 'pending',
        submittedAt: row!.submittedAt.toISOString(),
        decidedAt: null,
        decisionReason: null,
        retractedAt: null,
        closedAt: null,
        market: {
          id: market.id,
          slug: market.slug,
          title: market.title,
          status: 'provisional',
          judgementVersion: 1,
        },
        retractable: true,
      });
      expect(row).toMatchObject({ userId: member.id, links: dispute.links, reason: REASON });
      // The resting order's account disputes too: either side of a fill counts (#173 item 6).
      data<MyDispute>(await submit(market.id, maker), 201);
      await waitForMessages(received, 2, 'market:status of the two submissions');
      // The status as it was, its key unchanged: an open detail refetches its labels.
      for (const message of received) {
        expect(JSON.parse(message)).toMatchObject({
          type: 'market:status',
          marketId: market.id,
          status: 'provisional',
          resolvedResult: market.resolvedResult,
          statusEventId: String(market.statusEventId),
        });
        expect(message).not.toContain(REASON);
        expect(message).not.toContain(LINK);
      }
    });
    // Two hold it: the mirror the labels read, and the market reads '이의 검토 중'.
    expect((await marketRow(market.id)).disputeHoldCount).toBe(2);
    const shown = await publicOf(market.id);
    expect(flagsOf(shown)).toEqual({
      disputeOpen: true,
      disputeUnderReview: true,
      judgementDelayed: false,
    });
    // Nothing of the disputes is public: neither the submitters nor the body (#173 item 13).
    const body = (await get(`/markets/${market.id}`)).body;
    for (const hidden of [REASON, LINK, member.id, maker.id]) expect(body).not.toContain(hidden);
    // A member's write: no admin action, no market event.
    expect(await disputeActionsOf(market.id)).toEqual([]);
    expect(await eventTypesOf(market.id)).toEqual(['provisional']);
  });

  it('refuses a submission for its body (links and reason) before anything else', async () => {
    const market = await provisional();
    await fillOn(market.id, member);
    expectInvalid(await submit(market.id, member, { links: [] }), 'links');
    expectInvalid(
      await submit(market.id, member, {
        links: Array.from({ length: 6 }, (_, i) => `https://example.com/${String(i)}`),
      }),
      'links',
    );
    expectInvalid(await submit(market.id, member, { links: ['ftp://example.com/a'] }), 'links', 0);
    expectInvalid(
      await submit(market.id, member, { links: [`https://example.com/${'a'.repeat(500)}`] }),
      'links',
      0,
    );
    // Compared trimmed: the second is the first again.
    expect(
      expectInvalid(await submit(market.id, member, { links: [LINK, ` ${LINK} `] }), 'links', 1),
    ).toEqual([{ path: ['links', 1], message: 'duplicate' }]);
    expectInvalid(await submit(market.id, member, { reason: '   ' }), 'reason');
    expectInvalid(await submit(market.id, member, { reason: 'a'.repeat(2_001) }), 'reason');
    expectInvalid(await submit(market.id, member, { judgementVersion: 0 }), 'judgementVersion');
    // 2,000 characters is the limit, taken.
    data<MyDispute>(await submit(market.id, member, { reason: 'a'.repeat(2_000) }), 201);
    expect(await disputesOf(market.id)).toHaveLength(1);
  });

  it('refuses, in order: a market not public, not provisional, a stale version, the deadline, an admin, no fill, one already submitted', async () => {
    // No such market, and a draft: NOT_FOUND, as the public detail answers them.
    expectError(await submit(NOTHING), 404, 'NOT_FOUND');
    const draft = await createMarket(t.db, { status: 'draft' });
    await fillOn(draft.id, member);
    expectError(await submit(draft.id), 404, 'NOT_FOUND');
    // Public but not provisional — open, or confirmed — first, whatever the version.
    const open = await createMarket(t.db, { status: 'open' });
    await fillOn(open.id, member);
    expectNotAllowed(await submit(open.id, member, { judgementVersion: 2 }), 'not_provisional');
    const confirmed = await provisional(new Date(Date.now() - HOUR_MS));
    await fillOn(confirmed.id, member);
    await resolveMarketNow(t.db, confirmed.id);
    expectNotAllowed(await submit(confirmed.id), 'not_provisional');

    // A deadline passed: the stale version first, then the deadline — before the role.
    const late = await provisional(new Date(Date.now() - MINUTE_MS));
    const admin = await makeAdmin();
    await fillBeforeGrant(late.id, admin);
    expectNotAllowed(await submit(late.id, admin, { judgementVersion: 2 }), 'stale_version');
    expectNotAllowed(await submit(late.id, admin), 'deadline_passed');
    // Ahead: an admin is refused with a fill (from before a grant, #143) or without one, before
    // the fill is asked (#173 item 15).
    const market = await provisional();
    expectNotAllowed(await submit(market.id, admin), 'admin');
    await fillBeforeGrant(market.id, admin);
    expectNotAllowed(await submit(market.id, admin), 'admin');
    // A member with no fill on this market — a fill on another counts for nothing.
    await fillOn(open.id, member);
    expectNotAllowed(await submit(market.id), 'no_fill');
    // One per member and version, a retracted one included (#173 item 6 '고칠 수는 없다').
    await fillOn(market.id, member);
    const first = data<MyDispute>(await submit(market.id), 201);
    expectNotAllowed(await submit(market.id, member, { reason: '다시 쓴 사유' }), 'duplicate');
    data<MyDispute>(await retract(first.id));
    expectNotAllowed(await submit(market.id), 'duplicate');
    expect((await disputesOf(market.id)).map((row) => row.status)).toEqual(['retracted']);
    expect((await marketRow(market.id)).disputeHoldCount).toBe(0);
  });

  it('decides the deadline on the database clock after the locks: refused once it has come, taken before it', async () => {
    // A deadline at the database clock's instant now: the submission's clock, read after its
    // locks, is at it or past it (`now >= deadline`, ADR-0103 9-2) — the confirmation's own
    // `deadline <= now`, so the two never overlap. The millisecond itself is @buddha/db's test.
    const clock = await clockTimestamp(t.db);
    const due = await provisional(clock);
    await fillOn(due.id, member);
    expectNotAllowed(await submit(due.id), 'deadline_passed');
    expect(flagsOf(await publicOf(due.id))).toEqual({
      disputeOpen: false,
      disputeUnderReview: false,
      judgementDelayed: false,
    });
    // Seconds ahead: taken, and retractable until then.
    const soon = await provisional(
      new Date((await clockTimestamp(t.db)).getTime() + 30 * SECOND_MS),
    );
    await fillOn(soon.id, member);
    expect(data<MyDispute>(await submit(soon.id), 201).retractable).toBe(true);
  });

  it('takes a dispute under a writing restriction, and refuses an account that has not finished the onboarding (#173 item 6, #57 item 8)', async () => {
    const market = await provisional();
    // A writing restriction refuses posts, never a 판정 이의 (#45-12); the account restriction
    // is account-restrictions.controller.test.ts's.
    await createModerationAction(t.db, {
      userId: member.id,
      createdBy: third.id,
      type: 'writing_restriction',
      endsAt: null,
    });
    await fillOn(market.id, member);
    data<MyDispute>(await submit(market.id), 201);
    // Signed up, not onboarded: the guard refuses before the body is read.
    const fresh = await signUpTestUser(t);
    await fillOn(market.id, fresh);
    expectError(await submit(market.id, fresh), 409, 'ONBOARDING_REQUIRED');
    expectError(await submit(market.id, fresh, { links: [] }), 409, 'ONBOARDING_REQUIRED');
    expect(await disputesOf(market.id)).toHaveLength(1);
  });

  it('refuses a body naming another account than the cookie’s, before anything is read (ADR-0092)', async () => {
    const market = await provisional();
    await fillOn(market.id, member);
    const other = await makeMember();
    expectError(await submit(market.id, member, { expectedAccountId: other.id }), 403, 'FORBIDDEN');
    const { dispute } = await createDispute(t.db, { marketId: market.id, userId: other.id });
    expectError(
      await post(`/me/disputes/${dispute.id}/retract`, other, { expectedAccountId: member.id }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await decide('dismiss', market.id, dispute.id, third, { expectedAccountId: approver.id }),
      403,
      'FORBIDDEN',
    );
    expect((await disputesOf(market.id)).map((row) => row.status)).toEqual(['pending']);
  });

  // --- 철회 -----------------------------------------------------------------------------------
  it('retracts one’s own pending dispute within the deadline, signed in whatever the onboarding; the hold goes with it', async () => {
    const market = await provisional();
    await fillOn(market.id, member);
    const submitted = data<MyDispute>(await submit(market.id), 201);
    await listening(market.id, async (received) => {
      const retracted = data<MyDispute>(await retract(submitted.id));
      const [row] = await disputesOf(market.id);
      expect(retracted).toEqual({
        ...submitted,
        status: 'retracted',
        retractedAt: row!.retractedAt!.toISOString(),
        retractable: false,
      });
      await waitForMessages(received, 1, 'market:status of the retraction');
      expect(JSON.parse(received[0]!)).toMatchObject({ status: 'provisional' });
    });
    expect((await marketRow(market.id)).disputeHoldCount).toBe(0);
    expect(flagsOf(await publicOf(market.id))).toEqual({
      disputeOpen: true,
      disputeUnderReview: false,
      judgementDelayed: false,
    });
    // Once retracted, refused as such.
    expectNotAllowed(await retract(submitted.id), 'retracted');

    // An account a terms revision sent back (or that never finished) still takes back its own.
    const fresh = await signUpTestUser(t);
    const { dispute } = await createDispute(t.db, { marketId: market.id, userId: fresh.id });
    expect(data<MyDispute>(await retract(dispute.id, fresh)).status).toBe('retracted');
  });

  it('refuses the 철회 of a decided dispute, one past its deadline, and another account’s (NOT_FOUND)', async () => {
    const market = await provisional();
    const { dispute: dismissed } = await createDispute(t.db, {
      marketId: market.id,
      userId: member.id,
      status: 'dismissed',
      decidedBy: third.id,
    });
    expectNotAllowed(await retract(dismissed.id), 'decided');
    const accepter = await makeMember();
    const { dispute: accepted } = await createDispute(t.db, {
      marketId: market.id,
      userId: accepter.id,
      status: 'accepted',
      decidedBy: third.id,
    });
    expectNotAllowed(await retract(accepted.id, accepter), 'decided');
    // Another account's, and none at all: NOT_FOUND, looked up among the caller's own.
    expectError(await retract(accepted.id, member), 404, 'NOT_FOUND');
    expectError(await retract(NOTHING), 404, 'NOT_FOUND');
    // Past the deadline it is the reason the market waits: no longer retractable.
    const late = await provisional(new Date(Date.now() - MINUTE_MS));
    const { dispute: waiting } = await createDispute(t.db, {
      marketId: late.id,
      userId: member.id,
    });
    expectNotAllowed(await retract(waiting.id), 'deadline_passed');
    expect((await disputesOf(late.id)).map((row) => row.status)).toEqual(['pending']);
  });

  // --- 본인의 읽기 ------------------------------------------------------------------------------
  it('answers the dispute screen’s standing on a market as a submission would be refused, with the member’s dispute of its version', async () => {
    const standingOf = async (marketId: string, who: TestUser = member) =>
      data<MyMarketDispute>(await standing(marketId, who));
    // Not public: NOT_FOUND.
    expectError(await standing(NOTHING), 404, 'NOT_FOUND');
    const draft = await createMarket(t.db, { status: 'draft' });
    expectError(await standing(draft.id), 404, 'NOT_FOUND');
    // Open: not provisional, no version.
    const open = await createMarket(t.db, { status: 'open' });
    expect(await standingOf(open.id)).toEqual({
      eligibility: 'not_provisional',
      judgementVersion: null,
      dispute: null,
    });
    const market = await provisional();
    expect(await standingOf(market.id)).toEqual({
      eligibility: 'no_fill',
      judgementVersion: 1,
      dispute: null,
    });
    expect(await standingOf(market.id, third)).toMatchObject({ eligibility: 'admin' });
    await fillOn(market.id, member);
    expect(await standingOf(market.id)).toEqual({
      eligibility: 'eligible',
      judgementVersion: 1,
      dispute: null,
    });
    const submitted = data<MyDispute>(await submit(market.id), 201);
    expect(await standingOf(market.id)).toEqual({
      eligibility: 'duplicate',
      judgementVersion: 1,
      dispute: submitted,
    });
    // Past the deadline: deadline_passed, the dispute still shown, no longer retractable; and
    // after the confirmation, with its result and reason (#173 item 7).
    const late = await provisional(new Date(Date.now() - MINUTE_MS));
    const { dispute } = await createDispute(t.db, {
      marketId: late.id,
      userId: member.id,
      status: 'dismissed',
      decidedBy: third.id,
      decisionReason: DECISION,
    });
    expect(await standingOf(late.id)).toMatchObject({
      eligibility: 'deadline_passed',
      dispute: {
        id: dispute.id,
        status: 'dismissed',
        decisionReason: DECISION,
        retractable: false,
      },
    });
    await resolveMarketNow(t.db, late.id);
    expect(await standingOf(late.id)).toMatchObject({
      eligibility: 'not_provisional',
      judgementVersion: 1,
      dispute: { id: dispute.id, status: 'dismissed', market: { status: 'resolved' } },
    });
  });

  it('lists the member’s own disputes, the newest first, with a keyset cursor, never who decided them', async () => {
    const first = await publishedAgo(2);
    const second = await publishedAgo(2);
    const at = (await clockTimestamp(t.db)).getTime() - HOUR_MS;
    const { dispute: older } = await createDispute(t.db, {
      marketId: first.id,
      userId: member.id,
      status: 'dismissed',
      submittedAt: new Date(at),
      decidedBy: third.id,
      decidedAt: new Date(at + MINUTE_MS),
      decisionReason: DECISION,
    });
    const { dispute: newer } = await createDispute(t.db, {
      marketId: second.id,
      userId: member.id,
      submittedAt: new Date(at + 2 * MINUTE_MS),
    });
    // Another member's is nobody's business here.
    const other = await makeMember();
    await createDispute(t.db, { marketId: second.id, userId: other.id });
    const page = await get('/me/disputes?limit=1', member);
    const one = page.json<Page<MyDispute>>();
    expect(page.statusCode).toBe(200);
    expect(one.data.map((row) => row.id)).toEqual([newer.id]);
    expect(one.data[0]).toMatchObject({ status: 'pending', retractable: true });
    expect(one.meta.nextCursor).not.toBeNull();
    const next = (
      await get(`/me/disputes?limit=1&cursor=${encodeURIComponent(one.meta.nextCursor!)}`, member)
    ).json<Page<MyDispute>>();
    expect(next.data).toEqual([
      {
        id: older.id,
        judgementVersion: 1,
        links: older.links,
        reason: older.reason,
        status: 'dismissed',
        submittedAt: new Date(at).toISOString(),
        decidedAt: new Date(at + MINUTE_MS).toISOString(),
        decisionReason: DECISION,
        retractedAt: null,
        closedAt: null,
        market: {
          id: first.id,
          slug: first.slug,
          title: first.title,
          status: 'provisional',
          judgementVersion: 1,
        },
        retractable: false,
      },
    ]);
    expect(next.meta.nextCursor).toBeNull();
    // The decider is the operators' alone (#173 item 13).
    const all = await get('/me/disputes', member);
    expect(all.body).not.toContain(third.id);
    expect(all.json<Page<MyDispute>>().data).toHaveLength(2);
    expect((await get('/me/disputes')).statusCode).toBe(401);
  });

  // --- 기각·수용 --------------------------------------------------------------------------------
  it('dismisses a pending dispute by an admin who did not register the judgement — its approver may — writing the record and republishing the status', async () => {
    const market = await provisional();
    await fillOn(market.id, member);
    const submitted = data<MyDispute>(await submit(market.id), 201);
    // The registrant of the version decides nothing of its disputes (#173 item 2).
    expectNotAllowed(await decide('dismiss', market.id, submitted.id, registrant), 'registrant');
    expectNotAllowed(await decide('accept', market.id, submitted.id, registrant), 'registrant');
    await listening(market.id, async (received) => {
      const answer = data<AdminMarket>(
        await decide('dismiss', market.id, submitted.id, approver, { reason: `  ${DECISION} ` }),
      );
      const [row] = await disputesOf(market.id);
      expect(row).toMatchObject({
        status: 'dismissed',
        decidedBy: approver.id,
        decisionReason: DECISION,
      });
      expect(answer.disputes).toEqual({
        holding: 0,
        items: [
          {
            id: submitted.id,
            judgementVersion: 1,
            links: [LINK],
            reason: REASON,
            status: 'dismissed',
            submittedAt: submitted.submittedAt,
            decidedAt: row!.decidedAt!.toISOString(),
            decisionReason: DECISION,
            retractedAt: null,
            closedAt: null,
            submitter: await actorOf(member),
            decidedBy: await actorOf(approver),
            purgedAt: null,
          },
        ],
      });
      expect(flagsOf(answer)).toEqual({
        disputeOpen: true,
        disputeUnderReview: false,
        judgementDelayed: false,
      });
      expect(await disputeActionsOf(market.id)).toEqual([
        expect.objectContaining({
          adminId: approver.id,
          type: 'market_dispute_dismiss',
          targetType: 'market',
          targetId: market.id,
          createdAt: row!.decidedAt,
          payload: { disputeId: submitted.id, judgementVersion: 1, reason: DECISION },
        }),
      ]);
      await waitForMessages(received, 1, 'market:status of the dismissal');
      expect(JSON.parse(received[0]!)).toMatchObject({
        status: 'provisional',
        statusEventId: answer.statusEventId,
      });
    });
    // Before the deadline nothing is registered: the approval's job confirms it at the deadline.
    expect(await jobIds()).toEqual([]);
    // The member reads the result and its reason, never who decided (#173 items 7·13).
    const mine = await get('/me/disputes', member);
    expect(mine.json<Page<MyDispute>>().data[0]).toMatchObject({
      status: 'dismissed',
      decisionReason: DECISION,
    });
    expect(mine.body).not.toContain(approver.id);
    // Final: decided once.
    expectNotAllowed(await decide('accept', market.id, submitted.id), 'decided');
    expectNotAllowed(await decide('dismiss', market.id, submitted.id), 'decided');
    expect(await disputeActionsOf(market.id)).toHaveLength(1);
  });

  it('accepts a dispute, which keeps holding the market past its deadline until a correction, registering no confirmation', async () => {
    // Submitted before the deadline, which has passed with it pending: '판정 지연' (owner answer
    // 2026-11-03).
    const market = await provisional(new Date(Date.now() - MINUTE_MS));
    const { dispute: submitted } = await createDispute(t.db, {
      marketId: market.id,
      userId: member.id,
      submittedAt: new Date(market.disputeDeadline!.getTime() - HOUR_MS),
    });
    expect(flagsOf(await publicOf(market.id))).toEqual({
      disputeOpen: false,
      disputeUnderReview: true,
      judgementDelayed: true,
    });
    const answer = data<AdminMarket>(await decide('accept', market.id, submitted.id));
    expect(answer.disputes).toMatchObject({
      holding: 1,
      items: [{ id: submitted.id, status: 'accepted', decidedBy: await actorOf(third) }],
    });
    // Still held: the mirror kept, the labels as they were, nothing registered for the worker.
    expect((await marketRow(market.id)).disputeHoldCount).toBe(1);
    expect(flagsOf(await publicOf(market.id))).toEqual({
      disputeOpen: false,
      disputeUnderReview: true,
      judgementDelayed: true,
    });
    expect(await jobIds()).toEqual([]);
    expect(await disputeActionsOf(market.id)).toEqual([
      expect.objectContaining({
        adminId: third.id,
        type: 'market_dispute_accept',
        payload: { disputeId: submitted.id, judgementVersion: 1, reason: DECISION },
      }),
    ]);
    expectNotAllowed(await decide('dismiss', market.id, submitted.id), 'decided');
  });

  it('registers market.resolve with no delay once the last holding dispute is dismissed past the deadline, and not before', async () => {
    const market = await provisional(new Date(Date.now() - MINUTE_MS));
    const { dispute: one } = await createDispute(t.db, { marketId: market.id });
    const { dispute: two } = await createDispute(t.db, { marketId: market.id });
    // One retracted before the deadline holds nothing.
    await createDispute(t.db, { marketId: market.id, status: 'retracted' });
    expect((await marketRow(market.id)).disputeHoldCount).toBe(2);
    // One dismissed, one still pending: held, nothing registered.
    data<AdminMarket>(await decide('dismiss', market.id, one.id));
    expect(await jobIds()).toEqual([]);
    const held = data<AdminMarket>(await get(`/admin/markets/${market.id}`, third));
    expect(held.disputes.holding).toBe(1);
    expect(flagsOf(held)).toMatchObject({ disputeUnderReview: true, judgementDelayed: true });
    // The last: the worker's job, due at once, under the deadline's id (#173 item 7 '바로 확정';
    // ADR-0103 9-12 — the worker confirms it).
    const answer = data<AdminMarket>(await decide('dismiss', market.id, two.id));
    expect(answer).toMatchObject({ status: 'provisional', disputes: { holding: 0 } });
    expect(flagsOf(answer)).toEqual({
      disputeOpen: false,
      disputeUnderReview: false,
      judgementDelayed: false,
    });
    const jobId = marketResolveJobId(market.id, market.disputeDeadline!);
    expect(await jobIds()).toEqual([jobId]);
    expect(await jobQueue.getJob(jobId)).toMatchObject({
      name: JOB_NAMES.marketResolve,
      data: { marketId: market.id },
      delay: 0,
    });
  });

  it('refuses a decision on a dispute of no such market, a retracted one, and a reason out of bounds', async () => {
    const market = await provisional();
    const elsewhere = await provisional();
    const { dispute } = await createDispute(t.db, { marketId: market.id, userId: member.id });
    expectError(await decide('dismiss', elsewhere.id, dispute.id), 404, 'NOT_FOUND');
    expectError(await decide('dismiss', NOTHING, dispute.id), 404, 'NOT_FOUND');
    expectError(await decide('accept', market.id, NOTHING), 404, 'NOT_FOUND');
    expectInvalid(await decide('dismiss', market.id, dispute.id, third, { reason: ' ' }), 'reason');
    expectInvalid(
      await decide('accept', market.id, dispute.id, third, { reason: 'a'.repeat(501) }),
      'reason',
    );
    data<MyDispute>(await retract(dispute.id));
    expectNotAllowed(await decide('dismiss', market.id, dispute.id), 'retracted');
    expectNotAllowed(await decide('accept', market.id, dispute.id, registrant), 'retracted');
    expect(await disputeActionsOf(market.id)).toEqual([]);
  });

  it('refuses a decision by the dispute’s own submitter, given the admin role after disputing', async () => {
    const market = await provisional();
    await fillOn(market.id, member);
    const submitted = data<MyDispute>(await submit(market.id), 201);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, member.id));
    await t.app.get(AdminGuard).invalidate(member.id);
    expectNotAllowed(await decide('dismiss', market.id, submitted.id, member), 'own');
    expectNotAllowed(await decide('accept', market.id, submitted.id, member), 'own');
    const [row] = await disputesOf(market.id);
    expect(row).toMatchObject({ status: 'pending', decidedBy: null });
    expect(await disputeActionsOf(market.id)).toEqual([]);
    // Another admin still decides it.
    data<AdminMarket>(await decide('dismiss', market.id, submitted.id, third));
  });

  it('refuses a decision by an admin whose role was revoked after the guard let it through', async () => {
    const market = await provisional();
    const { dispute } = await createDispute(t.db, { marketId: market.id, userId: member.id });
    // Revoked in the database, the guard's role cache not told: only the service's read under
    // the admin-roles lock sees it.
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(eq(schema.profiles.userId, third.id));
    expectError(await decide('dismiss', market.id, dispute.id, third), 403, 'FORBIDDEN');
    const [row] = await disputesOf(market.id);
    expect(row).toMatchObject({ status: 'pending', decidedBy: null });
    expect(await disputeActionsOf(market.id)).toEqual([]);
  });

  it('serialises two writes of one dispute on the market lock: the second finds it decided or retracted', async () => {
    async function inTurn(
      marketId: string,
      first: () => Promise<Res>,
      then: () => Promise<Res>,
    ): Promise<[Res, Res]> {
      const holder = await t.db.$client.connect();
      let pending: [Promise<Res>, Promise<Res>] | undefined;
      let released = false;
      try {
        await holder.query('SELECT pg_advisory_lock(hashtext($1))', [marketId]);
        const a = first();
        await waitForLockWaiter(holder, 'the first write on the market lock');
        const b = then();
        await waitForLockWaiter(holder, 'the second write on the market lock', 2);
        pending = [a, b];
        await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [marketId]);
        released = true;
        return [await a, await b];
      } finally {
        if (!released) await holder.query('SELECT pg_advisory_unlock_all()');
        holder.release();
        await Promise.allSettled(pending ?? []);
      }
    }
    const market = await provisional();
    const { dispute } = await createDispute(t.db, { marketId: market.id, userId: member.id });
    const [dismissed, retracted] = await inTurn(
      market.id,
      () => decide('dismiss', market.id, dispute.id),
      () => retract(dispute.id),
    );
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expectNotAllowed(retracted, 'decided');
    const { dispute: next } = await createDispute(t.db, { marketId: market.id });
    const [first, second] = await inTurn(
      market.id,
      () => decide('accept', market.id, next.id),
      () => decide('dismiss', market.id, next.id, approver),
    );
    expect(first.statusCode, first.body).toBe(200);
    expectNotAllowed(second, 'decided');
    expect((await disputesOf(market.id)).map((row) => row.status)).toEqual([
      'dismissed',
      'accepted',
    ]);
    expect((await marketRow(market.id)).disputeHoldCount).toBe(1);
  });

  // --- 공개 표시 --------------------------------------------------------------------------------
  it('carries the deadline, the version and the labels on every public read: the detail, the cards and a post’s badge', async () => {
    const before = await createMarket(t.db, { status: 'open' });
    const open = await provisional();
    const held = await provisional(new Date(Date.now() - MINUTE_MS));
    await createDispute(t.db, { marketId: held.id });
    const quiet = await provisional(new Date(Date.now() - MINUTE_MS));
    await createDispute(t.db, { marketId: quiet.id, status: 'dismissed', decidedBy: third.id });
    const confirmed = await provisional(new Date(Date.now() - HOUR_MS));
    await resolveMarketNow(t.db, confirmed.id);
    const expected = new Map([
      // Before a judgement: no version, no deadline.
      [before.id, { open: false, under: false, delayed: false }],
      [open.id, { open: true, under: false, delayed: false }],
      // Held past its deadline: '판정 지연' (owner answer 2026-11-03), still under review.
      [held.id, { open: false, under: true, delayed: true }],
      // Past it with nothing holding: neither (the worker confirms it).
      [quiet.id, { open: false, under: false, delayed: false }],
      // Confirmed: the version and its deadline kept.
      [confirmed.id, { open: false, under: false, delayed: false }],
    ]);
    const cards = (await get('/markets?status=all&limit=100')).json<Page<MarketSummary>>().data;
    for (const [id, want] of expected) {
      const row = await marketRow(id);
      const shape = {
        judgementVersion: row.judgementVersion,
        disputeDeadline: row.disputeDeadline?.toISOString() ?? null,
        disputeOpen: want.open,
        disputeUnderReview: want.under,
        judgementDelayed: want.delayed,
      };
      const card = cards.find((candidate) => candidate.id === id);
      expect({ id, card }).toMatchObject({ id, card: shape });
      expect({ id, detail: await publicOf(id) }).toMatchObject({ id, detail: shape });
    }
    // A post on the held market reads as its card does (#46's badge; `PostMarket`).
    const author = await makeMember();
    const written = await createPost(t.db, { marketId: held.id, authorId: author.id });
    const badge = data<{ market: PostMarket }>(await get(`/posts/${written.id}`)).market;
    expect(badge).toMatchObject({
      status: 'provisional',
      disputeUnderReview: true,
      judgementDelayed: true,
    });
  });

  // --- 관리자 화면 ------------------------------------------------------------------------------
  it('answers the admin detail with the current version’s disputes, the oldest first, and how many hold it', async () => {
    const empty = data<AdminMarket>(
      await get(`/admin/markets/${(await createMarket(t.db, { status: 'open' })).id}`, third),
    );
    expect(empty.disputes).toEqual({ holding: 0, items: [] });
    const market = await publishedAgo(2);
    const at = (await clockTimestamp(t.db)).getTime() - HOUR_MS;
    const others = [await makeMember(), await makeMember(), await makeMember()];
    const made = [];
    for (const [index, status] of (['pending', 'accepted', 'retracted'] as const).entries()) {
      made.push(
        (
          await createDispute(t.db, {
            marketId: market.id,
            userId: others[index]!.id,
            status,
            submittedAt: new Date(at + index * MINUTE_MS),
            ...(status === 'accepted' ? { decidedBy: third.id } : {}),
          })
        ).dispute,
      );
    }
    const detail = data<AdminMarket>(await get(`/admin/markets/${market.id}`, third));
    expect(detail.disputes.holding).toBe(2);
    expect(
      detail.disputes.items.map(({ id, status, submitter, decidedBy }) => ({
        id,
        status,
        submitter: submitter.id,
        decidedBy: decidedBy?.id ?? null,
      })),
    ).toEqual([
      { id: made[0]!.id, status: 'pending', submitter: others[0]!.id, decidedBy: null },
      { id: made[1]!.id, status: 'accepted', submitter: others[1]!.id, decidedBy: third.id },
      { id: made[2]!.id, status: 'retracted', submitter: others[2]!.id, decidedBy: null },
    ]);
    expect(detail).toMatchObject({ disputeUnderReview: true, judgementVersion: 1 });
  });

  it('lists 이의 접수 in two halves with a keyset cursor: pending the oldest first, decided the latest first', async () => {
    const first = await publishedAgo(3);
    const second = await publishedAgo(3);
    const at = (await clockTimestamp(t.db)).getTime() - 2 * HOUR_MS;
    const submitters = [await makeMember(), await makeMember(), await makeMember()];
    const pending = [];
    for (const [index, who] of submitters.entries()) {
      pending.push(
        (
          await createDispute(t.db, {
            marketId: index === 1 ? second.id : first.id,
            userId: who.id,
            submittedAt: new Date(at + index * MINUTE_MS),
          })
        ).dispute,
      );
    }
    const decider = await actorOf(third);
    const { dispute: dismissed } = await createDispute(t.db, {
      marketId: second.id,
      status: 'dismissed',
      submittedAt: new Date(at),
      decidedBy: third.id,
      decidedAt: new Date(at + HOUR_MS),
      decisionReason: DECISION,
    });
    const { dispute: retracted } = await createDispute(t.db, {
      marketId: second.id,
      status: 'retracted',
      submittedAt: new Date(at + MINUTE_MS),
      retractedAt: new Date(at + 90 * MINUTE_MS),
    });
    const list = (query: string) => get(`/admin/market-disputes${query}`, third);

    // 검토 대기 (the default): the oldest first, two to a page.
    const page = (await list('?limit=2')).json<Page<AdminDisputeQueueItem>>();
    expect(page.data.map((row) => row.id)).toEqual([pending[0]!.id, pending[1]!.id]);
    expect(page.data[0]).toEqual({
      id: pending[0]!.id,
      judgementVersion: 1,
      links: pending[0]!.links,
      reason: pending[0]!.reason,
      status: 'pending',
      submittedAt: new Date(at).toISOString(),
      decidedAt: null,
      decisionReason: null,
      retractedAt: null,
      closedAt: null,
      submitter: await actorOf(submitters[0]!),
      decidedBy: null,
      purgedAt: null,
      market: {
        id: first.id,
        slug: first.slug,
        title: first.title,
        status: 'provisional',
        judgementVersion: 1,
      },
    });
    const rest = (
      await list(`?status=pending&limit=2&cursor=${encodeURIComponent(page.meta.nextCursor!)}`)
    ).json<Page<AdminDisputeQueueItem>>();
    expect(rest.data.map((row) => row.id)).toEqual([pending[2]!.id]);
    expect(rest.meta.nextCursor).toBeNull();
    // 처리됨: the latest decision or retraction first.
    const decided = (await list('?status=decided&limit=1')).json<Page<AdminDisputeQueueItem>>();
    expect(decided.data.map((row) => [row.id, row.status])).toEqual([[retracted.id, 'retracted']]);
    const older = (
      await list(`?status=decided&limit=1&cursor=${encodeURIComponent(decided.meta.nextCursor!)}`)
    ).json<Page<AdminDisputeQueueItem>>();
    expect(older.data).toEqual([
      expect.objectContaining({
        id: dismissed.id,
        status: 'dismissed',
        decidedBy: decider,
        decisionReason: DECISION,
      }),
    ]);
    // No price, majority or position on the list (N03 §5): the market is its reference alone,
    // with its current judgement version (public; #176).
    expect(Object.keys(older.data[0]!.market).sort()).toEqual([
      'id',
      'judgementVersion',
      'slug',
      'status',
      'title',
    ]);
    expectError(await list('?status=everything'), 400, 'VALIDATION_ERROR');
    expectError(await get('/admin/market-disputes', member), 403, 'FORBIDDEN');
  });
});
