/**
 * 판정 오류 보상 (#144 part 2, ADR-0166; owner answers 144-1·144-2·144-4·144-6·144-7·144-10·144-12
 * and 144-15·144-16·144-17·144-18; ADR-0107 decision 2 #73 items 3·8; ADR-0120 decisions 5·6)
 * through the admin routes against the docker `test` profile: on a SETTLED market whose 판정 오류
 * 사건 is confirmed, a request — the server's frozen list, counts and totals in its record, the
 * public '승인 대기' — and its refusals in order (no incident, the #93 hold, a waiting or a paid
 * one, nobody owed, no decider, the requester's conflict); the approval that pays every listed
 * account once at the decision's instant (balances, entries, rows, the payees' notices last,
 * `user:balance` and `user:notification` after COMMIT, the public '지급 완료' with its counts and
 * total, the over-paid holder untouched, the market row, judgements, settlement records, payouts
 * and holdings unchanged — AC 2, 3, 6) and its refusals (the requester, the paid version's
 * registrant, a conflicted approver or requester, the hold, a stale list, a blocked account —
 * 144-16, nothing written); a closed account recorded '탈퇴로 지급 못 함' (144-7); the 정리 목적
 * 반려 by the paid registrant or a conflicted admin, then a new request; 철회 by the requester
 * alone and by a self-declared conflict (ADR-0120 decision 6, T19); the wallet's 판정 오류 보상
 * (kind, filter, the members' reason, the market link — 144-10, 144-12), the settlement line's
 * 판정 정정 mark (144-17), the recipients list and the shared queue (T13); and the reconciliations
 * after a payout (AC 7). Skips when TEST_* are unset.
 */
import {
  declareMarketConflict,
  judgementCompensationPayloadOf,
  runAccountReconciliation,
  runMarketReconciliation,
  runSupplyReconciliation,
  schema,
  settleMarketPositions,
} from '@buddha/db';
import {
  balanceOf,
  closeAccount,
  completeOnboarding,
  createApprovalRequest,
  createCategory,
  createProvisionalMarket,
  createStartGrant,
  mintTestPairs,
  resolveMarketNow,
  withLedgerGuardsOff,
} from '@buddha/db/test';
import {
  MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND,
  type AdminJudgementCompensationRecipient,
  type AdminMarket,
  type AdminMarketJudgementIncidentQueueItem,
  type LedgerEntry,
  type Market,
  type MarketResult,
  type MySettlement,
} from '@buddha/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const MINUTE_MS = 60_000;
/** A well-formed request id that names no request. */
const NO_REQUEST = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';

const LINK = 'https://www.bok.or.kr/press/2026-11-correction';
const DESCRIPTION = '발표 원문은 3.25%인데 판정은 3.00%로 읽었다.';
const CONFIRM_REASON = '원문을 다시 확인했고 판정과 다르다.';
const REQUEST_REASON = '정정된 결과에 따라 대상 계정을 보상한다.';
const USER_REASON = '판정 기준 시각의 발표를 잘못 읽어 결과를 바로잡았습니다.';
const APPROVE_REASON = '목록과 금액을 확인했다.';
const REJECT_REASON = '회원에게 보일 사유를 고쳐 다시 요청한다.';

type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: { path: (string | number)[]; message: string }[];
  };
};
type Res = { statusCode: number; json: <U>() => U; body: string };
type Page<T> = { data: T[]; meta: { nextCursor: string | null } };

describe.skipIf(!hasTestInfra)('admin market judgement compensations (integration)', () => {
  let t: TestApp;
  /** Registered the paid judgement (144-4: may ask for the compensation, never approve it). */
  let registrant: TestUser;
  /** Confirms incidents and approves compensations. */
  let reviewer: TestUser;
  /** Approved the paid judgement; free to approve a compensation. */
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
    vi.restoreAllMocks();
    await t.reset();
    registrant = await makeAdmin();
    reviewer = await makeAdmin();
    third = await makeAdmin();
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
  });

  /** Every write names the admin on screen (ADR-0092); the payload is sent as given. */
  const post = (url: string, who: TestUser, payload: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...payload },
    });
  const get = (url: string, who?: TestUser) =>
    t.app.inject({ method: 'GET', url, headers: who ? { cookie: who.cookie } : {} });

  const marketUrl = (id: string) => `/api/v1/admin/markets/${id}`;
  const compensationsUrl = (id: string) => `${marketUrl(id)}/judgement-compensations`;
  /** 보상 요청: both reasons and the conflict confirmation, unless told. */
  const request = (id: string, who: TestUser = registrant, payload: Record<string, unknown> = {}) =>
    post(compensationsUrl(id), who, {
      reason: REQUEST_REASON,
      userReason: USER_REASON,
      noConflictConfirmed: true,
      ...payload,
    });
  const approve = (
    id: string,
    requestId: string,
    who: TestUser = reviewer,
    payload: Record<string, unknown> = {},
  ) =>
    post(`${compensationsUrl(id)}/${requestId}/approve`, who, {
      reason: APPROVE_REASON,
      noConflictConfirmed: true,
      ...payload,
    });
  /** 보상 반려: the reason and the admin on screen alone (a 정리 목적 반려). */
  const reject = (id: string, requestId: string, who: TestUser = reviewer) =>
    post(`${compensationsUrl(id)}/${requestId}/reject`, who, { reason: REJECT_REASON });
  const retract = (id: string, requestId: string, who: TestUser = registrant) =>
    post(`${compensationsUrl(id)}/${requestId}/retract`, who);
  const declare = (id: string, who: TestUser) =>
    post(`${marketUrl(id)}/conflicts`, who, { reason: '이 시장의 결과에 이해관계가 있다.' });

  const data = <T>(res: Res) => res.json<{ data: T }>().data;
  const detail = (res: Res) => data<AdminMarket>(res);
  const errorOf = (res: Res) => res.json<ErrorBody>().error;
  const publicMarket = async (id: string) => {
    const res = await get(`/api/v1/markets/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return data<Market>(res);
  };
  const publicCompensation = async (id: string) =>
    (await publicMarket(id)).judgingRecord.correction?.compensation;

  /** A refusal VALIDATION_ERROR naming `path` with `message`. */
  function expectRefused(res: Res, path: string, message: string) {
    expect({ status: res.statusCode, details: errorOf(res).details }, res.body).toEqual({
      status: 400,
      details: [{ path: [path], message }],
    });
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  }
  /** APPROVAL_NOT_ALLOWED with `reason`. */
  function expectNotAllowed(res: Res, reason: string) {
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).code).toBe('APPROVAL_NOT_ALLOWED');
    expect(errorOf(res).details).toEqual([{ path: ['request'], message: reason }]);
  }
  /** FORBIDDEN `market_conflict` (#143). */
  function expectConflict(res: Res) {
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res).details).toEqual([{ path: ['conflict'], message: 'market_conflict' }]);
  }

  /** A member signed in, with Coin to hold contracts. */
  async function member(): Promise<TestUser> {
    const user = await signUpTestUser(t);
    await createStartGrant(t.db, { userId: user.id, amountCoin: 10_000n });
    return user;
  }

  /**
   * A market judged `result` (v1 registered by `registrant`, approved by `third`), confirmed and
   * paid for real (`settleMarketPositions`) to `pairs` pairs of members — a YES holder and a NO
   * holder of 2 contracts each — then SETTLED, as the payout leaves it.
   */
  async function paidMarket(input: { result?: MarketResult; pairs?: number } = {}) {
    const { result = 'YES', pairs = 1 } = input;
    const published = await createProvisionalMarket(t.db, {
      result,
      registeredBy: registrant.id,
      approvedBy: third.id,
      market: { createdBy: registrant.id, categoryId: category.id },
    });
    const id = published.market.id;
    await resolveMarketNow(t.db, id);
    const yes: TestUser[] = [];
    const no: TestUser[] = [];
    for (let index = 0; index < pairs; index += 1) {
      const y = await member();
      const n = await member();
      await mintTestPairs(t.db, { marketId: id, yesHolderId: y.id, noHolderId: n.id, qty: 2 });
      yes.push(y);
      no.push(n);
    }
    await t.db.update(schema.markets).set({ status: 'settling' }).where(eq(schema.markets.id, id));
    if (pairs > 0) await t.db.transaction((tx) => settleMarketPositions(tx, id));
    await t.db
      .update(schema.markets)
      .set({ status: 'settled', settledAt: new Date() })
      .where(eq(schema.markets.id, id));
    return { id, slug: published.market.slug, title: published.market.title, yes, no };
  }

  /**
   * The market's 판정 오류 사건 to `corrected`, registered by the paid version's registrant (144-4
   * lets them) and confirmed by `reviewer`, through PR 1's routes.
   */
  async function confirmedIncident(id: string, corrected: MarketResult = 'NO') {
    const registered = await post(`${marketUrl(id)}/judgement-incidents`, registrant, {
      noConflictConfirmed: true,
      correctedResult: corrected,
      description: DESCRIPTION,
      evidence: { links: [LINK], collectedAt: new Date(Date.now() - MINUTE_MS).toISOString() },
    });
    expect(registered.statusCode, registered.body).toBe(200);
    const requestId = detail(registered).judgementIncident.pending!.requestId;
    const confirmed = await post(
      `${marketUrl(id)}/judgement-incidents/${requestId}/confirm`,
      reviewer,
      { noConflictConfirmed: true, reason: CONFIRM_REASON },
    );
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const [incident] = await t.db
      .select()
      .from(schema.marketJudgementIncidents)
      .where(eq(schema.marketJudgementIncidents.marketId, id));
    return incident!;
  }

  /** Asks for the compensation and answers the waiting request's id. */
  async function requested(id: string, who: TestUser = registrant) {
    const res = await request(id, who);
    expect(res.statusCode, res.body).toBe(200);
    const pending = detail(res).judgementIncident.compensation?.pending;
    expect(pending).toBeTruthy();
    return pending!.requestId;
  }

  async function requestsFor(marketId: string) {
    return t.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.kind, MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND),
          eq(schema.approvalRequests.targetId, marketId),
        ),
      )
      .orderBy(asc(schema.approvalRequests.requestedAt));
  }
  async function actionsFor(marketId: string, prefix = 'market_judgement_compensation_') {
    const rows = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, marketId))
      .orderBy(asc(schema.adminActions.createdAt), asc(schema.adminActions.id));
    return rows.filter((row) => row.type.startsWith(prefix));
  }
  const compensationRows = (marketId: string) =>
    t.db
      .select()
      .from(schema.judgementCompensations)
      .where(eq(schema.judgementCompensations.marketId, marketId));
  const compensationEntries = (marketId: string) =>
    t.db
      .select()
      .from(schema.ledgerEntries)
      .where(
        and(
          eq(schema.ledgerEntries.marketId, marketId),
          eq(schema.ledgerEntries.type, 'JUDGEMENT_COMPENSATION'),
        ),
      )
      .orderBy(asc(schema.ledgerEntries.id));
  const compensationNotices = () =>
    t.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.type, 'market_judgement_compensated'));

  /** Everything #144 must never move about a paid market (AC 2, ADR-0165 decision 2). */
  async function paidRecords(marketId: string) {
    const [market] = await t.db
      .select({
        status: schema.markets.status,
        resolvedResult: schema.markets.resolvedResult,
        judgementVersion: schema.markets.judgementVersion,
        statusEventId: schema.markets.statusEventId,
        resolvedAt: schema.markets.resolvedAt,
        settledAt: schema.markets.settledAt,
        updatedAt: schema.markets.updatedAt,
      })
      .from(schema.markets)
      .where(eq(schema.markets.id, marketId));
    const judgements = await t.db
      .select()
      .from(schema.marketJudgements)
      .where(eq(schema.marketJudgements.marketId, marketId))
      .orderBy(asc(schema.marketJudgements.version));
    const settlements = await t.db
      .select()
      .from(schema.positionSettlements)
      .where(eq(schema.positionSettlements.marketId, marketId))
      .orderBy(asc(schema.positionSettlements.userId), asc(schema.positionSettlements.outcome));
    const positions = await t.db
      .select()
      .from(schema.positions)
      .where(eq(schema.positions.marketId, marketId))
      .orderBy(asc(schema.positions.userId), asc(schema.positions.outcome));
    const payouts = await t.db
      .select()
      .from(schema.ledgerEntries)
      .where(
        and(
          eq(schema.ledgerEntries.marketId, marketId),
          eq(schema.ledgerEntries.type, 'SETTLEMENT_PAYOUT'),
        ),
      )
      .orderBy(asc(schema.ledgerEntries.id));
    return { market, judgements, settlements, positions, payouts };
  }

  const settlementsOf = async (who: TestUser, marketId: string) => {
    const res = await get(`/api/v1/me/settlements?marketId=${marketId}`, who);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Page<MySettlement>>().data;
  };
  const ledgerOf = async (who: TestUser, query = '') => {
    const res = await get(`/api/v1/me/ledger${query}`, who);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Page<LedgerEntry>>().data;
  };

  it('asks with the server’s frozen list: counts and totals in its record, the public 승인 대기, no account in public (144-1, 144-6, 144-15)', async () => {
    const market = await paidMarket({ pairs: 2 });
    await confirmedIncident(market.id);
    const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishMarket');

    // Confirmed, nothing asked: 보상 준비 중, and the admin preview counts the list to come.
    expect(await publicCompensation(market.id)).toEqual({
      status: 'preparing',
      accountCount: null,
      paidCount: null,
      totalCoin: null,
    });
    const before = await get(marketUrl(market.id), reviewer);
    expect(before.statusCode, before.body).toBe(200);
    expect(detail(before).judgementIncident.compensation).toEqual({
      preview: { accountCount: 2, totalCoin: '400', closedCount: 0, blockedCount: 0 },
      held: false,
      pending: null,
      paid: null,
      log: [],
    });

    // The paid version's registrant may ask (144-4 "보상 요청은 할 수 있다").
    const res = await request(market.id, registrant, { userReason: `  ${USER_REASON}  ` });
    expect(res.statusCode, res.body).toBe(200);
    const compensation = detail(res).judgementIncident.compensation!;
    const [frozen] = await requestsFor(market.id);
    expect(compensation.pending).toEqual({
      requestId: frozen!.id,
      requestedBy: { id: registrant.id, nickname: expect.any(String) as string },
      requestedAt: frozen!.requestedAt.toISOString(),
      accountCount: 2,
      totalCoin: '400',
      reason: REQUEST_REASON,
      userReason: USER_REASON,
    });
    // YES → NO: each NO 2 holder is owed 200; the YES holders were over-paid and keep it.
    const owed = market.no.map((who) => who.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(judgementCompensationPayloadOf(frozen!)).toEqual({
      noConflictConfirmed: true,
      incidentId: expect.any(String) as string,
      correctedResult: 'NO',
      recipients: owed.map((userId) => ({ userId, amountCoin: '200' })),
      accountCount: 2,
      totalCoin: '400',
      userReason: USER_REASON,
    });
    expect(frozen!.requestReason).toBe(REQUEST_REASON);
    const [action] = await actionsFor(market.id);
    expect(action).toMatchObject({
      adminId: registrant.id,
      type: 'market_judgement_compensation_request',
      createdAt: frozen!.requestedAt,
      payload: {
        approvalId: frozen!.id,
        reason: REQUEST_REASON,
        accountCount: 2,
        totalCoin: '400',
        closedCount: 0,
        userReason: USER_REASON,
      },
    });
    // Counts and totals only: no recipient in the work history (ADR-0064).
    for (const who of [...market.no, ...market.yes]) {
      expect(JSON.stringify(action!.payload)).not.toContain(who.id);
    }

    // Public: 승인 대기 with the 대상 count alone, no account, amount or reason.
    expect(await publicCompensation(market.id)).toEqual({
      status: 'pending',
      accountCount: 2,
      paidCount: null,
      totalCoin: null,
    });
    const body = (await get(`/api/v1/markets/${market.id}`)).body;
    for (const hidden of [USER_REASON, REQUEST_REASON, frozen!.id, ...owed]) {
      expect(body).not.toContain(hidden);
    }
    // The same key and the paid result: open pages refetch the moved public status.
    expect(publish).toHaveBeenCalledWith(
      market.id,
      expect.objectContaining({ type: 'market:status', status: 'settled', resolvedResult: 'YES' }),
    );
    // Nothing paid yet.
    expect(await compensationRows(market.id)).toEqual([]);
    expect(await compensationEntries(market.id)).toEqual([]);
  });

  it('refuses a request without a confirmed incident, held, waiting, paid, owing no one, with no decider, or from a conflicted admin', async () => {
    // No incident.
    const bare = await paidMarket();
    expectRefused(await request(bare.id), 'incident', 'not confirmed');
    // The body's conflict confirmation is required.
    const unconfirmed = await request(bare.id, registrant, { noConflictConfirmed: undefined });
    expect(unconfirmed.statusCode, unconfirmed.body).toBe(400);
    expect(errorOf(unconfirmed).details?.[0]?.path).toEqual(['noConflictConfirmed']);
    // No amount or account in the body: an extra field is not taken as one.
    const nobodyHeld = await paidMarket({ pairs: 0 });
    await confirmedIncident(nobodyHeld.id);
    expectRefused(await request(nobodyHeld.id), 'recipients', 'none');
    expect(await publicCompensation(nobodyHeld.id)).toMatchObject({ status: 'none' });

    const market = await paidMarket();
    await confirmedIncident(market.id);
    // A conflicted requester (#143, T19).
    expect((await declare(market.id, third)).statusCode).toBe(200);
    expectConflict(await request(market.id, third));
    // No decider: the requester and the paid version's registrant are out, the third conflicted.
    expectNotAllowed(await request(market.id, reviewer), 'no_decider');
    // Pending, then paid.
    const requestId = await requested(market.id);
    expectRefused(await request(market.id, reviewer), 'compensation', 'pending');
    const paid = await approve(market.id, requestId, reviewer);
    expect(paid.statusCode, paid.body).toBe(200);
    expectRefused(await request(market.id, reviewer), 'compensation', 'paid');
    expect(await requestsFor(market.id)).toHaveLength(1);

    // Held by the #93 market reconciliation: the collateral off its books.
    const held = await paidMarket();
    await confirmedIncident(held.id);
    await withLedgerGuardsOff((client) =>
      client.query(
        "UPDATE balances SET available_coin = available_coin + 10 WHERE account_id = (SELECT id FROM ledger_accounts WHERE kind = 'market_collateral' AND market_id = $1)",
        [held.id],
      ),
    );
    const audited = await t.db.transaction((tx) =>
      runMarketReconciliation(tx, held.id, { source: 'manual' }),
    );
    expect(audited.hold).not.toBeNull();
    expectRefused(await request(held.id), 'market', 'held');
    const heldDetail = await get(marketUrl(held.id), reviewer);
    expect(detail(heldDetail).judgementIncident.compensation?.held).toBe(true);
  });

  it('pays every listed account once at the decision’s instant, the notices last, nothing else moving (AC 2, 3, 5, 6; 144-2, 144-18)', async () => {
    const market = await paidMarket({ pairs: 2 });
    const incident = await confirmedIncident(market.id);
    const requestId = await requested(market.id);
    const books = await paidRecords(market.id);
    const balancesBefore = new Map(
      await Promise.all(
        [...market.yes, ...market.no].map(
          async (who) => [who.id, (await balanceOf(t.db, who.id))!] as const,
        ),
      ),
    );
    const settlementsBefore = await settlementsOf(market.no[0]!, market.id);
    const publisher = t.app.get(MarketPublisher);
    const publishUser = vi.spyOn(publisher, 'publishUser');
    const publish = vi.spyOn(publisher, 'publishMarket');

    const res = await approve(market.id, requestId, third);
    expect(res.statusCode, res.body).toBe(200);
    const [decided] = await requestsFor(market.id);
    expect(decided).toMatchObject({
      status: 'approved',
      decidedBy: third.id,
      decisionReason: APPROVE_REASON,
    });
    const at = decided!.decidedAt!;

    // Each NO holder +200 by one JUDGEMENT_COMPENSATION entry naming the market, at the instant.
    const entries = await compensationEntries(market.id);
    const rows = await compensationRows(market.id);
    expect(entries).toHaveLength(2);
    expect(rows).toHaveLength(2);
    for (const who of market.no) {
      const row = rows.find((r) => r.userId === who.id)!;
      const entry = entries.find((e) => e.id === row.ledgerEntryId)!;
      expect(row).toMatchObject({
        incidentId: incident.id,
        approvalId: requestId,
        amountCoin: 200n,
        outcome: 'paid',
        userReason: USER_REASON,
        requestedBy: registrant.id,
        approvedBy: third.id,
        createdAt: at,
      });
      expect(entry).toMatchObject({
        type: 'JUDGEMENT_COMPENSATION',
        fromAccountId: null,
        amountCoin: 200n,
        marketId: market.id,
        refType: 'judgement_compensation',
        refId: row.id,
        idempotencyKey: `${requestId}:${who.id}`,
        createdAt: at,
      });
      const after = (await balanceOf(t.db, who.id))!;
      const before = balancesBefore.get(who.id)!;
      expect(after.availableCoin).toBe(before.availableCoin + 200n);
      expect(after.lockedCoin).toBe(before.lockedCoin);
    }
    // No claw-back (AC 3): the over-paid YES holders keep every Coin.
    for (const who of market.yes) {
      expect(await balanceOf(t.db, who.id)).toEqual(balancesBefore.get(who.id));
    }
    const { rows: negative } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM balances
        WHERE available_coin < 0 OR locked_coin < 0 OR ledger_coin < 0`,
    );
    expect(negative[0]!.n).toBe(0);
    // AC 2: the market row, its judgements, settlement records, payouts and holdings as paid.
    expect(await paidRecords(market.id)).toEqual(books);

    // The record: counts and totals at the decision's instant.
    const actions = await actionsFor(market.id);
    expect(actions.at(-1)).toMatchObject({
      adminId: third.id,
      type: 'market_judgement_compensation_approve',
      createdAt: at,
      payload: {
        approvalId: requestId,
        incidentId: incident.id,
        reason: APPROVE_REASON,
        paidCount: 2,
        paidCoin: '400',
        closedCount: 0,
      },
    });

    // One notice per payee (144-18): the market category, its detail, both results and its amount.
    const notices = await compensationNotices();
    expect(notices.map((notice) => notice.userId).sort()).toEqual(
      market.no.map((who) => who.id).sort(),
    );
    for (const notice of notices) {
      expect(notice).toMatchObject({
        category: 'market',
        target: { kind: 'market', slug: market.slug },
        params: {
          marketTitle: market.title,
          originalResult: 'YES',
          correctedResult: 'NO',
          compensationCoin: '200',
        },
        occurredAt: at,
      });
    }
    // After COMMIT: each payee's balance and notice, and the market's unchanged status.
    for (const who of market.no) {
      expect(publishUser).toHaveBeenCalledWith(
        who.id,
        expect.objectContaining({ type: 'user:balance', ts: at.toISOString() }),
      );
      expect(publishUser).toHaveBeenCalledWith(
        who.id,
        expect.objectContaining({ type: 'user:notification' }),
      );
    }
    for (const who of market.yes) {
      expect(publishUser.mock.calls.filter(([userId]) => userId === who.id)).toEqual([]);
    }
    expect(publish).toHaveBeenCalledWith(
      market.id,
      expect.objectContaining({
        type: 'market:status',
        status: 'settled',
        resolvedResult: 'YES',
        statusEventId: String(books.market!.statusEventId),
      }),
    );

    // Admin: the paid request and its counts; no preview once paid.
    const compensation = detail(res).judgementIncident.compensation!;
    expect(compensation).toMatchObject({
      preview: null,
      pending: null,
      paid: {
        requestId,
        approvedBy: { id: third.id },
        approvedAt: at.toISOString(),
        paidCount: 2,
        paidCoin: '400',
        closedCount: 0,
        accountCount: 2,
        totalCoin: '400',
      },
    });
    expect(compensation.log.map((entry) => entry.status)).toEqual(['approved']);
    // Public 지급 완료 with the counts and total, never an account.
    expect(await publicCompensation(market.id)).toEqual({
      status: 'paid',
      accountCount: 2,
      paidCount: 2,
      totalCoin: '400',
    });

    // The wallet (144-10, 144-12): its own kind, the members' reason, the market link, the filter.
    const payee = market.no[0]!;
    const [latest] = await ledgerOf(payee);
    const row = rows.find((r) => r.userId === payee.id)!;
    expect(latest).toMatchObject({
      kind: 'JUDGEMENT_COMPENSATION',
      amountCoin: '200',
      refType: 'judgement_compensation',
      refId: row.id,
      memo: USER_REASON,
      marketId: market.id,
      marketSlug: market.slug,
      marketTitle: market.title,
      createdAt: at.toISOString(),
    });
    for (const hidden of [requestId, incident.id, REQUEST_REASON, APPROVE_REASON, third.id]) {
      expect(JSON.stringify(latest)).not.toContain(hidden);
    }
    expect(await ledgerOf(payee, '?kind=JUDGEMENT_COMPENSATION')).toEqual([latest]);
    expect((await ledgerOf(payee, `?marketId=${market.id}`)).map((entry) => entry.kind)).toContain(
      'JUDGEMENT_COMPENSATION',
    );
    expect(await ledgerOf(market.yes[0]!, '?kind=JUDGEMENT_COMPENSATION')).toEqual([]);
    // The settlement line keeps what was paid and gains the mark alone (144-10, 144-17).
    expect(await settlementsOf(payee, market.id)).toEqual(
      settlementsBefore.map((line) => ({ ...line, correctedResult: 'NO' })),
    );
    expect(settlementsBefore.every((line) => line.correctedResult === 'NO')).toBe(true);

    // Once: a second approval is `decided`, and nothing more is written.
    expectNotAllowed(await approve(market.id, requestId, reviewer), 'decided');
    expect(await compensationEntries(market.id)).toHaveLength(2);
    expect(await compensationNotices()).toHaveLength(2);

    // AC 7: supply, every payee's account and the market's books still reconcile.
    await t.db.transaction(async (tx) => {
      expect((await runSupplyReconciliation(tx, { source: 'manual' })).result.passed).toBe(true);
      for (const who of [...market.no, ...market.yes]) {
        const run = await runAccountReconciliation(tx, { userId: who.id }, { source: 'manual' });
        expect(run.result.passed, who.id).toBe(true);
      }
      const books = await runMarketReconciliation(tx, market.id, { source: 'manual' });
      expect(books.result.passed).toBe(true);
    });
  });

  it('refuses an approval by the requester, the paid version’s registrant, a conflicted approver or requester, an unknown request — nothing written', async () => {
    const market = await paidMarket();
    await confirmedIncident(market.id);
    // The third asks: the paid version's registrant is free to try.
    const requestId = await requested(market.id, third);
    expectRefused(await approve(market.id, NO_REQUEST), 'requestId', 'unknown');
    expectNotAllowed(await approve(market.id, requestId, third), 'requester');
    expectRefused(await approve(market.id, requestId, registrant), 'decider', 'registrant');
    const unconfirmed = await approve(market.id, requestId, reviewer, {
      noConflictConfirmed: undefined,
    });
    expect(unconfirmed.statusCode, unconfirmed.body).toBe(400);
    // The requester's conflict, recorded after the request, also refuses it (ADR-0120 decision 5,
    // the requester re-checked). The route's declaration would retract the request (decision 6),
    // so the record is written as the declaration writes it, without that retraction.
    const other = await paidMarket();
    await confirmedIncident(other.id);
    const otherRequest = await requested(other.id, reviewer);
    await t.db.transaction(async (tx) => {
      const [declaredBy] = await tx
        .insert(schema.adminActions)
        .values({
          adminId: reviewer.id,
          type: 'market_conflict_declare',
          targetType: 'market',
          targetId: other.id,
          payload: { reason: '나중에 드러난 이해관계가 있다.' },
        })
        .returning({ id: schema.adminActions.id, createdAt: schema.adminActions.createdAt });
      await declareMarketConflict(tx, {
        marketId: other.id,
        userId: reviewer.id,
        reason: '나중에 드러난 이해관계가 있다.',
        adminActionId: declaredBy!.id,
        at: declaredBy!.createdAt,
      });
    });
    expectConflict(await approve(other.id, otherRequest, third));
    expect((await requestsFor(other.id))[0]!.status).toBe('pending');
    // A conflicted approver.
    expect((await declare(market.id, reviewer)).statusCode).toBe(200);
    expectConflict(await approve(market.id, requestId, reviewer));
    expect(await compensationRows(market.id)).toEqual([]);
    expect((await requestsFor(market.id))[0]!.status).toBe('pending');
  });

  it('refuses the whole approval while held, for a stale list, or for an account off its ledger — the count alone (144-16, T18, T21)', async () => {
    const market = await paidMarket({ pairs: 2 });
    const incident = await confirmedIncident(market.id);
    const requestId = await requested(market.id);

    // One payee's balance record off its ledger: 원장 확인 필요, the whole approval refused.
    const blockedUser = market.no[1]!;
    await withLedgerGuardsOff((client) =>
      client.query(
        "UPDATE balances SET available_coin = available_coin - 7, ledger_coin = ledger_coin - 7 WHERE account_id = (SELECT id FROM ledger_accounts WHERE kind = 'user' AND owner_id = $1)",
        [blockedUser.id],
      ),
    );
    const blocked = await approve(market.id, requestId);
    expectRefused(blocked, 'recipients', 'blocked');
    expect(errorOf(blocked).message).toContain('1 listed account');
    expect(blocked.body).not.toContain(blockedUser.id);
    expect(await compensationRows(market.id)).toEqual([]);
    expect(await compensationEntries(market.id)).toEqual([]);
    expect((await requestsFor(market.id))[0]!.status).toBe('pending');
    const shown = detail(await get(marketUrl(market.id), reviewer)).judgementIncident.compensation!;
    expect(shown.preview).toMatchObject({ accountCount: 2, blockedCount: 1 });
    // The recipients list shows which, to the admins.
    const list = await get(`${compensationsUrl(market.id)}/recipients`, reviewer);
    expect(list.statusCode, list.body).toBe(200);
    expect(
      list
        .json<Page<AdminJudgementCompensationRecipient>>()
        .data.find((row) => row.account.id === blockedUser.id)?.state,
    ).toBe('blocked');

    // A tampered frozen list (written by hand): the live list differs — stale.
    await t.db
      .update(schema.approvalRequests)
      .set({ status: 'retracted', retractedAt: new Date() })
      .where(eq(schema.approvalRequests.id, requestId));
    const payload = judgementCompensationPayloadOf((await requestsFor(market.id))[0]!);
    const tampered = await createApprovalRequest(t.db, {
      kind: MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND,
      targetType: 'market',
      targetId: market.id,
      payload: {
        ...payload,
        incidentId: incident.id,
        recipients: payload.recipients.map((r, index) =>
          index === 0 ? { ...r, amountCoin: String(BigInt(r.amountCoin) + 1n) } : r,
        ),
        totalCoin: String(BigInt(payload.totalCoin) + 1n),
      },
      requestedBy: registrant.id,
      reason: REQUEST_REASON,
    });
    expectRefused(await approve(market.id, tampered.id), 'recipients', 'stale');

    // Held by the #93 market reconciliation (the collateral off its books).
    await withLedgerGuardsOff((client) =>
      client.query(
        "UPDATE balances SET available_coin = available_coin + 10 WHERE account_id = (SELECT id FROM ledger_accounts WHERE kind = 'market_collateral' AND market_id = $1)",
        [market.id],
      ),
    );
    const audited = await t.db.transaction((tx) =>
      runMarketReconciliation(tx, market.id, { source: 'manual' }),
    );
    expect(audited.hold).not.toBeNull();
    expectRefused(await approve(market.id, tampered.id), 'market', 'held');
    expect(await compensationRows(market.id)).toEqual([]);
  });

  it('records a closed account ‘탈퇴로 지급 못 함’: no entry, no notice, the public 대상 count kept (144-7, 144-15)', async () => {
    const market = await paidMarket({ pairs: 2 });
    await confirmedIncident(market.id);
    const gone = market.no[0]!;
    const kept = market.no[1]!;
    const requestId = await requested(market.id);
    await closeAccount(t.db, gone.id);
    const res = await approve(market.id, requestId);
    expect(res.statusCode, res.body).toBe(200);
    const rows = await compensationRows(market.id);
    expect(rows.find((row) => row.userId === gone.id)).toMatchObject({
      outcome: 'closed',
      ledgerEntryId: null,
      amountCoin: 200n,
    });
    expect(rows.find((row) => row.userId === kept.id)).toMatchObject({ outcome: 'paid' });
    expect((await compensationEntries(market.id)).length).toBe(1);
    expect((await compensationNotices()).map((notice) => notice.userId)).toEqual([kept.id]);
    expect(await publicCompensation(market.id)).toEqual({
      status: 'paid',
      accountCount: 2,
      paidCount: 1,
      totalCoin: '200',
    });
    expect(detail(res).judgementIncident.compensation!.paid).toMatchObject({
      paidCount: 1,
      paidCoin: '200',
      closedCount: 1,
    });
    const list = await get(`${compensationsUrl(market.id)}/recipients`, reviewer);
    expect(
      list
        .json<Page<AdminJudgementCompensationRecipient>>()
        .data.map((row) => [row.account.id, row.state])
        .sort(),
    ).toEqual(
      [
        [gone.id, 'closed'],
        [kept.id, 'paid'],
      ].sort(),
    );
  });

  it('pays nothing when every target is closed, sends no notice, and shows the 대상 count with 0 Coin', async () => {
    const market = await paidMarket();
    await confirmedIncident(market.id);
    const requestId = await requested(market.id);
    await closeAccount(t.db, market.no[0]!.id);
    const res = await approve(market.id, requestId);
    expect(res.statusCode, res.body).toBe(200);
    expect(await compensationEntries(market.id)).toEqual([]);
    expect(await compensationNotices()).toEqual([]);
    expect(await publicCompensation(market.id)).toEqual({
      status: 'paid',
      accountCount: 1,
      paidCount: 0,
      totalCoin: '0',
    });
  });

  it('takes a 정리 목적 반려 from the paid registrant or a conflicted admin, then a new request; 철회 by the requester alone (ADR-0120 decision 5, T7)', async () => {
    const market = await paidMarket();
    await confirmedIncident(market.id);
    const first = await requested(market.id, third);
    // No conflict confirmation, no registrant check: the paid version's registrant rejects.
    expectNotAllowed(await reject(market.id, first, third), 'requester');
    const rejected = await reject(market.id, first, registrant);
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await publicCompensation(market.id)).toMatchObject({ status: 'preparing' });
    expect((await actionsFor(market.id)).at(-1)).toMatchObject({
      type: 'market_judgement_compensation_reject',
      adminId: registrant.id,
      payload: { approvalId: first, reason: REJECT_REASON },
    });
    expectNotAllowed(await reject(market.id, first, reviewer), 'decided');

    // A conflicted admin rejects too.
    const second = await requested(market.id, third);
    expect((await declare(market.id, reviewer)).statusCode).toBe(200);
    expect((await reject(market.id, second, reviewer)).statusCode).toBe(200);

    // 철회: the requester's alone.
    const third_ = await requested(market.id, registrant);
    expectNotAllowed(await retract(market.id, third_, third), 'not_requester');
    expectRefused(await retract(market.id, NO_REQUEST), 'requestId', 'unknown');
    const retracted = await retract(market.id, third_, registrant);
    expect(retracted.statusCode, retracted.body).toBe(200);
    expect(detail(retracted).judgementIncident.compensation!.log.map((e) => e.status)).toEqual([
      'retracted',
      'rejected',
      'rejected',
    ]);
    expect((await actionsFor(market.id)).at(-1)).toMatchObject({
      type: 'market_judgement_compensation_retract',
      payload: { approvalId: third_ },
    });
    expect(await publicCompensation(market.id)).toMatchObject({ status: 'preparing' });
    expect(await compensationRows(market.id)).toEqual([]);
  });

  it('retracts the declarer’s own waiting request on a self-declared conflict (ADR-0120 decision 6, T19)', async () => {
    const market = await paidMarket();
    await confirmedIncident(market.id);
    const requestId = await requested(market.id, third);
    expect(await publicCompensation(market.id)).toMatchObject({ status: 'pending' });
    const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishMarket');
    const declared = await declare(market.id, third);
    expect(declared.statusCode, declared.body).toBe(200);
    // The public status moved back, and open pages hear the same-key repeat (decision 6).
    expect(await publicCompensation(market.id)).toMatchObject({ status: 'preparing' });
    expect(publish).toHaveBeenCalledWith(
      market.id,
      expect.objectContaining({ type: 'market:status', status: 'settled' }),
    );
    const [row] = await requestsFor(market.id);
    expect(row).toMatchObject({ id: requestId, status: 'retracted' });
    const [retraction] = await actionsFor(market.id, 'market_judgement_compensation_retract');
    expect(retraction).toMatchObject({
      adminId: third.id,
      payload: { approvalId: requestId, conflictDeclarationId: expect.any(String) as string },
    });
  });

  it('lists the recipients to admins alone, bytewise and paged; an empty page without an incident', async () => {
    const market = await paidMarket({ pairs: 3 });
    const recipientsUrl = `${compensationsUrl(market.id)}/recipients`;
    // No incident (and an unknown market): an empty page.
    for (const url of [
      recipientsUrl,
      `${compensationsUrl('0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f61')}/recipients`,
    ]) {
      const res = await get(url, reviewer);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<Page<unknown>>()).toEqual({ data: [], meta: { nextCursor: null } });
    }
    expect((await get(recipientsUrl, market.no[0])).statusCode).toBe(403);
    expect((await get(recipientsUrl)).statusCode).toBe(401);

    await confirmedIncident(market.id);
    const ids = market.no.map((who) => who.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const walk = async () => {
      const seen: AdminJudgementCompensationRecipient[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
        const res = await get(`${recipientsUrl}${query}`, reviewer);
        expect(res.statusCode, res.body).toBe(200);
        const page = res.json<Page<AdminJudgementCompensationRecipient>>();
        seen.push(...page.data);
        cursor = page.meta.nextCursor;
      } while (cursor !== null);
      return seen;
    };
    // Before a request: the live list.
    const live = await walk();
    expect(live.map((row) => row.account.id)).toEqual(ids);
    expect(live.every((row) => row.amountCoin === '200' && row.state === 'pending')).toBe(true);
    expect(live[0]!.account.nickname).toEqual(expect.any(String) as string);
    // While a request waits: its frozen list; once approved: the rows.
    const requestId = await requested(market.id);
    expect((await walk()).map((row) => row.account.id)).toEqual(ids);
    expect((await approve(market.id, requestId)).statusCode).toBe(200);
    const paid = await walk();
    expect(paid.map((row) => [row.account.id, row.state])).toEqual(ids.map((id) => [id, 'paid']));
  });

  it('waits in the 판정 오류 사건 검토 대기 queue with its kind, count and total (T13)', async () => {
    const market = await paidMarket({ pairs: 2 });
    await confirmedIncident(market.id);
    const requestId = await requested(market.id);
    const res = await get('/api/v1/admin/market-judgement-incidents', reviewer);
    expect(res.statusCode, res.body).toBe(200);
    const row = res
      .json<Page<AdminMarketJudgementIncidentQueueItem>>()
      .data.find((item) => item.requestId === requestId);
    expect(row).toEqual({
      kind: 'compensation',
      requestId,
      marketId: market.id,
      slug: market.slug,
      title: market.title,
      status: 'settled',
      originalResult: 'YES',
      correctedResult: 'NO',
      requestedBy: { id: registrant.id, nickname: expect.any(String) as string },
      requestedAt: expect.any(String) as string,
      accountCount: 2,
      totalCoin: '400',
    });
    for (const who of market.no) expect(res.body).not.toContain(who.id);
    expect((await approve(market.id, requestId)).statusCode).toBe(200);
    const after = await get('/api/v1/admin/market-judgement-incidents', reviewer);
    expect(after.body).not.toContain(requestId);
  });
});
