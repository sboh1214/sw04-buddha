/**
 * 판정 오류 사건 (#144 part 1, ADR-0165; owner answers 144-3·144-4·144-5·144-8·144-13·144-14;
 * ADR-0093 decision 1 #173 items 8·12·13·15; ADR-0120 범위·decisions 5·6) through the admin routes
 * against the docker `test` profile: a registration on a market whose result is confirmed —
 * RESOLVED, SETTLING or SETTLED — the request with its frozen payload and the record, nothing
 * public; its refusals in order (the status, legacy, the paid result itself, evidence after now,
 * a confirmed or a waiting incident, no decider) and the registrant's conflict and the admin on
 * screen; 오류 확인 by another admin on a SETTLED market — the permanent incident at the
 * decision's instant, the record, the unchanged `market:status` republished, the public 판정 정정
 * without identities or the reviewer's reason, the market row, judgements, settlement records,
 * payouts and holdings unchanged (AC 2) — and its refusals: the registrant (`requester`), the paid
 * version's registrant (`registrant`, 144-4), a conflicted decider or registrant, a SETTLING
 * market (144-13), one no longer waiting; 기각 with the same exclusions, taken while SETTLING,
 * after which another registration is taken; 철회 by the registrant alone; a self-declared
 * conflict retracting the declarer's waiting incident (ADR-0120 decision 6); the theme results and
 * the related markets following the corrected result (144-5); and the 판정 오류 사건 검토 대기
 * queue. Skips when TEST_* are unset.
 */
import {
  declareMarketConflict,
  lockAdminRoles,
  lockMarket,
  schema,
  settleMarketPositions,
} from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createMarket,
  createMarketLink,
  createProvisionalMarket,
  createStartGrant,
  createTheme,
  createThemeMarket,
  createUser,
  mintTestPairs,
  resolveMarketNow,
} from '@buddha/db/test';
import {
  MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND,
  type AdminMarket,
  type AdminMarketJudgementIncidentQueueItem,
  type Market,
  type MarketResult,
  type MarketSummary,
  type ThemeResult,
} from '@buddha/shared';
import { and, asc, eq, ne } from 'drizzle-orm';
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
const DISMISS_REASON = '원문과 판정이 같다.';

type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: { path: (string | number)[]; message: string }[];
  };
};
type Res = { statusCode: number; json: <U>() => U; body: string };
type Page<T> = { data: T[]; meta: { nextCursor: string | null } };

describe.skipIf(!hasTestInfra)('admin market judgement incidents (integration)', () => {
  let t: TestApp;
  /** Registered the paid judgement (144-4: may register an incident, never review one). */
  let registrant: TestUser;
  /** Reviews the incidents. */
  let reviewer: TestUser;
  /** Approved the paid judgement; registers incidents where a test says so. */
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

  // Every write names the admin on screen (ADR-0092); a registration and a review confirm no
  // interest unless the payload says otherwise.
  const post = (url: string, who: TestUser, payload: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: {
        expectedAccountId: who.id,
        ...(/\/judgement-incidents(?:$|\/[^/]+\/(?:confirm|dismiss)$)/.test(url)
          ? { noConflictConfirmed: true }
          : {}),
        ...payload,
      },
    });
  const get = (url: string, who?: TestUser) =>
    t.app.inject({ method: 'GET', url, headers: who ? { cookie: who.cookie } : {} });

  const marketUrl = (id: string) => `/api/v1/admin/markets/${id}`;
  const incidentsUrl = (id: string) => `${marketUrl(id)}/judgement-incidents`;
  /** 등록: NO for a paid YES, one link collected a minute ago, unless told. */
  const register = (
    id: string,
    who: TestUser = registrant,
    payload: Record<string, unknown> = {},
  ) =>
    post(incidentsUrl(id), who, {
      correctedResult: 'NO',
      description: DESCRIPTION,
      evidence: { links: [LINK], collectedAt: new Date(Date.now() - MINUTE_MS).toISOString() },
      ...payload,
    });
  const confirm = (
    id: string,
    requestId: string,
    who: TestUser = reviewer,
    payload: Record<string, unknown> = {},
  ) =>
    post(`${incidentsUrl(id)}/${requestId}/confirm`, who, { reason: CONFIRM_REASON, ...payload });
  const dismiss = (
    id: string,
    requestId: string,
    who: TestUser = reviewer,
    payload: Record<string, unknown> = {},
  ) =>
    post(`${incidentsUrl(id)}/${requestId}/dismiss`, who, { reason: DISMISS_REASON, ...payload });
  const retract = (id: string, requestId: string, who: TestUser = registrant) =>
    post(`${incidentsUrl(id)}/${requestId}/retract`, who);
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

  /** A refusal VALIDATION_ERROR naming `path` (a field, or a field inside one) with `message`. */
  function expectRefused(res: Res, path: string | (string | number)[], message: string) {
    expect({ status: res.statusCode, details: errorOf(res).details }).toEqual({
      status: 400,
      details: [{ path: typeof path === 'string' ? [path] : path, message }],
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

  /** An account as the admin screens name it: its id and its nickname. */
  const actorOf = async (user: TestUser) => {
    const [profile] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, user.id));
    return { id: user.id, nickname: profile!.nickname };
  };

  /** A member with Coin to hold contracts. */
  async function holder(): Promise<string> {
    const { user } = await createUser(t.db);
    await createStartGrant(t.db, { userId: user.id, amountCoin: 10_000n });
    return user.id;
  }

  /**
   * A market judged `result` (v1 registered by `registrant`, approved by `third`) and confirmed
   * by the worker, then moved to `status` as the payout does. With `holders`, two members hold
   * a pair each side and SETTLING/SETTLED markets are paid for real (`settleMarketPositions`).
   */
  async function paidMarket(
    input: {
      result?: MarketResult;
      status?: 'resolved' | 'settling' | 'settled';
      holders?: boolean;
    } = {},
  ) {
    const { result = 'YES', status = 'settled', holders = false } = input;
    const published = await createProvisionalMarket(t.db, {
      result,
      registeredBy: registrant.id,
      approvedBy: third.id,
      market: { createdBy: registrant.id, categoryId: category.id },
    });
    const id = published.market.id;
    await resolveMarketNow(t.db, id);
    let yes: string | null = null;
    let no: string | null = null;
    if (holders) {
      yes = await holder();
      no = await holder();
      await mintTestPairs(t.db, { marketId: id, yesHolderId: yes, noHolderId: no, qty: 2 });
    }
    if (status !== 'resolved') {
      await t.db
        .update(schema.markets)
        .set({ status: 'settling' })
        .where(eq(schema.markets.id, id));
      if (holders) await t.db.transaction((tx) => settleMarketPositions(tx, id));
      if (status === 'settled') {
        await t.db
          .update(schema.markets)
          .set({ status: 'settled', settledAt: new Date() })
          .where(eq(schema.markets.id, id));
      }
    }
    return { id, slug: published.market.slug, yes, no };
  }

  /** The market's incident registrations, oldest first. */
  async function requestsFor(marketId: string) {
    return t.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.kind, MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND),
          eq(schema.approvalRequests.targetId, marketId),
        ),
      )
      .orderBy(asc(schema.approvalRequests.requestedAt));
  }
  async function actionsFor(marketId: string) {
    return t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, marketId))
      .orderBy(asc(schema.adminActions.createdAt), asc(schema.adminActions.id));
  }
  /** Registers and answers the waiting request's id. */
  async function registered(id: string, who: TestUser = registrant, payload = {}) {
    const res = await register(id, who, payload);
    expect(res.statusCode, res.body).toBe(200);
    const pending = detail(res).judgementIncident.pending;
    expect(pending).not.toBeNull();
    return pending!.requestId;
  }

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
    const entries = await t.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.marketId, marketId))
      .orderBy(asc(schema.ledgerEntries.id));
    const balances = await t.db
      .select()
      .from(schema.balances)
      .orderBy(asc(schema.balances.accountId));
    return { market, judgements, settlements, positions, entries, balances };
  }

  it('registers an incident on a resolved, settling or settled market — the frozen request and its record, nothing public', async () => {
    const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishMarket');
    for (const status of ['resolved', 'settling', 'settled'] as const) {
      const market = await paidMarket({ status });
      const collectedAt = new Date(Date.now() - 5 * MINUTE_MS).toISOString();
      const res = await register(market.id, registrant, {
        // Trimmed and kept as given (the judgement's link rule).
        description: `  ${DESCRIPTION}  `,
        evidence: { links: [LINK, 'https://kostat.go.kr/press/1'], collectedAt },
      });
      expect(res.statusCode, res.body).toBe(200);
      const [request] = await requestsFor(market.id);
      expect(request).toMatchObject({
        status: 'pending',
        targetType: 'market',
        requestedBy: registrant.id,
        requestReason: DESCRIPTION,
        payload: {
          noConflictConfirmed: true,
          judgementVersion: 1,
          originalResult: 'YES',
          correctedResult: 'NO',
          evidence: { links: [LINK, 'https://kostat.go.kr/press/1'], collectedAt },
        },
      });
      const incident = detail(res).judgementIncident;
      expect(incident).toEqual({
        registrable: false,
        confirmable: status === 'settled',
        pending: {
          requestId: request!.id,
          correctedResult: 'NO',
          description: DESCRIPTION,
          evidence: { links: [LINK, 'https://kostat.go.kr/press/1'], collectedAt },
          requestedBy: await actorOf(registrant),
          requestedAt: request!.requestedAt.toISOString(),
        },
        confirmed: null,
        log: [
          expect.objectContaining({
            requestId: request!.id,
            status: 'pending',
            decidedBy: null,
            decisionReason: null,
            retractedAt: null,
          }),
        ],
      });
      const actions = await actionsFor(market.id);
      expect(actions.map((row) => [row.type, row.adminId])).toEqual([
        ['market_judgement_incident_register', registrant.id],
      ]);
      expect(actions[0]!.createdAt).toEqual(request!.requestedAt);
      expect(actions[0]!.payload).toEqual({
        approvalId: request!.id,
        judgementVersion: 1,
        originalResult: 'YES',
        correctedResult: 'NO',
        description: DESCRIPTION,
        evidence: { links: [LINK, 'https://kostat.go.kr/press/1'], collectedAt },
      });
      // A waiting incident is not public, and nothing is published.
      expect((await publicMarket(market.id)).judgingRecord.correction).toBeNull();
      expect(JSON.stringify(await publicMarket(market.id))).not.toContain(DESCRIPTION);
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses a registration in order: status, legacy, the paid result, evidence after now, confirmed, pending, no decider', async () => {
    // Before the result's confirmation, and once cancelled (144-8 counts from RESOLVED).
    for (const status of ['closed', 'provisional', 'cancelled'] as const) {
      const market = await createMarket(t.db, {
        createdBy: registrant.id,
        categoryId: category.id,
        status,
      });
      expectRefused(await register(market.id), 'status', 'not result confirmed');
    }
    // Judged before #152, with no judgement version (D4).
    const legacy = await createMarket(t.db, {
      createdBy: registrant.id,
      categoryId: category.id,
      status: 'settled',
      resolvedResult: 'YES',
    });
    expectRefused(await register(legacy.id), 'judgement', 'legacy');
    const market = await paidMarket();
    expectRefused(
      await register(market.id, registrant, { correctedResult: 'YES' }),
      'correctedResult',
      'same result',
    );
    expectRefused(
      await register(market.id, registrant, {
        evidence: { links: [LINK], collectedAt: new Date(Date.now() + 10 * MINUTE_MS) },
      }),
      ['evidence', 'collectedAt'],
      'after now',
    );
    // The body's own rules first: the confirmation, the link rule, the description.
    for (const payload of [
      { noConflictConfirmed: false },
      { evidence: { links: [LINK, LINK], collectedAt: new Date().toISOString() } },
      { description: '   ' },
      { correctedResult: 'MAYBE' },
    ]) {
      const res = await register(market.id, registrant, payload);
      expect(res.statusCode, res.body).toBe(400);
    }
    // The admin on screen (ADR-0092).
    const other = await register(market.id, registrant, { expectedAccountId: reviewer.id });
    expect(other.statusCode).toBe(403);

    // One waits at a time, whoever registers.
    const requestId = await registered(market.id);
    expectRefused(
      await register(market.id, third, { correctedResult: 'VOID' }),
      'incident',
      'pending',
    );
    // None once one is confirmed (144-14) — after a dismissal another is taken.
    expect((await confirm(market.id, requestId)).statusCode).toBe(200);
    expectRefused(
      await register(market.id, third, { correctedResult: 'VOID' }),
      'incident',
      'confirmed',
    );

    // No admin but the registrant and the paid version's registrant could decide it.
    const lone = await paidMarket();
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(
        and(
          eq(schema.profiles.role, 'admin'),
          ne(schema.profiles.userId, registrant.id),
          ne(schema.profiles.userId, third.id),
        ),
      );
    expectNotAllowed(await register(lone.id, third), 'no_decider');
    expect(await requestsFor(lone.id)).toEqual([]);
  });

  it('refuses a conflicted registrant (#143) and the reviewer who registered (no_decider when both admins are excluded)', async () => {
    const market = await paidMarket();
    expect((await declare(market.id, third)).statusCode).toBe(200);
    expectConflict(await register(market.id, third));
    // The reviewer registers: the paid registrant and the reviewer are excluded, the third is
    // conflicted — nobody could decide it.
    expectNotAllowed(await register(market.id, reviewer), 'no_decider');
  });

  it('confirms on a settled market at the decision’s instant: the incident, its record, the public 판정 정정 and the unchanged status republished — nothing paid moves (AC 2)', async () => {
    const market = await paidMarket({ holders: true });
    const before = await paidRecords(market.id);
    expect(before.settlements).toHaveLength(2);
    const requestId = await registered(market.id);
    const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishMarket');

    const res = await confirm(market.id, requestId);
    expect(res.statusCode, res.body).toBe(200);
    const [request] = await requestsFor(market.id);
    const [incident] = await t.db
      .select()
      .from(schema.marketJudgementIncidents)
      .where(eq(schema.marketJudgementIncidents.marketId, market.id));
    expect(request).toMatchObject({
      status: 'approved',
      decidedBy: reviewer.id,
      decisionReason: CONFIRM_REASON,
    });
    expect(incident).toMatchObject({
      approvalId: requestId,
      judgementVersion: 1,
      originalResult: 'YES',
      correctedResult: 'NO',
      description: DESCRIPTION,
      evidenceLinks: [LINK],
      registeredBy: registrant.id,
      paidRegisteredBy: registrant.id,
      confirmedBy: reviewer.id,
      registeredAt: request!.requestedAt,
      confirmedAt: request!.decidedAt,
    });
    const actions = await actionsFor(market.id);
    expect(actions.map((row) => row.type)).toEqual([
      'market_judgement_incident_register',
      'market_judgement_incident_confirm',
    ]);
    expect(actions[1]).toMatchObject({
      adminId: reviewer.id,
      createdAt: request!.decidedAt,
      payload: {
        approvalId: requestId,
        incidentId: incident!.id,
        correctedResult: 'NO',
        reason: CONFIRM_REASON,
      },
    });
    // The admin detail.
    expect(detail(res).judgementIncident).toMatchObject({
      registrable: false,
      confirmable: true,
      pending: null,
      confirmed: {
        incidentId: incident!.id,
        requestId,
        judgementVersion: 1,
        originalResult: 'YES',
        correctedResult: 'NO',
        description: DESCRIPTION,
        evidence: { links: [LINK] },
        registeredBy: await actorOf(registrant),
        confirmedBy: await actorOf(reviewer),
        registeredAt: request!.requestedAt.toISOString(),
        confirmedAt: request!.decidedAt!.toISOString(),
        reason: CONFIRM_REASON,
      },
      log: [expect.objectContaining({ status: 'approved', decisionReason: CONFIRM_REASON })],
    });
    expect(detail(res).resolvedResult).toBe('YES');

    // The public 판정 정정 (#173 item 13): no identity, no reviewer's reason.
    const shown = await publicMarket(market.slug);
    expect(shown.resolvedResult).toBe('YES');
    expect(shown.judgingRecord.correction).toEqual({
      result: 'NO',
      originalResult: 'YES',
      judgementVersion: 1,
      confirmedAt: request!.decidedAt!.toISOString(),
      description: DESCRIPTION,
      evidence: { links: [LINK], collectedAt: incident!.evidenceCollectedAt.toISOString() },
    });
    const body = JSON.stringify(shown);
    for (const hidden of [CONFIRM_REASON, reviewer.id, registrant.id, requestId, incident!.id]) {
      expect(body).not.toContain(hidden);
    }

    // The same key and the paid result: a subscriber refetches, nothing is rewritten.
    expect(publish).toHaveBeenCalledWith(
      market.id,
      expect.objectContaining({
        type: 'market:status',
        status: 'settled',
        resolvedResult: 'YES',
        statusEventId: String(before.market!.statusEventId),
      }),
    );
    // AC 2: the market row, its judgements, the settlement records, the payouts, the holdings
    // and every balance are as they were paid.
    expect(await paidRecords(market.id)).toEqual(before);
  });

  it('refuses a confirmation by the registrant, the paid version’s registrant, a conflicted decider or registrant, on a settling market, and once decided', async () => {
    // The third registers, so the paid version's registrant is free to try.
    const market = await paidMarket();
    const requestId = await registered(market.id, third);
    expectNotAllowed(await confirm(market.id, requestId, third), 'requester');
    expectRefused(await confirm(market.id, requestId, registrant), 'decider', 'registrant');
    expectRefused(await dismiss(market.id, requestId, registrant), 'decider', 'registrant');
    expectRefused(await confirm(market.id, NO_REQUEST), 'requestId', 'unknown');
    const noBox = await confirm(market.id, requestId, reviewer, { noConflictConfirmed: false });
    expect(noBox.statusCode).toBe(400);

    // A conflicted reviewer; then the registrant conflicted (re-checked, ADR-0120 decision 5).
    const fourth = await makeAdmin();
    expect((await declare(market.id, fourth)).statusCode).toBe(200);
    expectConflict(await confirm(market.id, requestId, fourth));
    expectConflict(await dismiss(market.id, requestId, fourth));
    // The registrant's own interest, recorded without the route (which would retract the
    // registration, ADR-0120 decision 6).
    await t.db.transaction(async (tx) => {
      await lockMarket(tx, market.id);
      await lockAdminRoles(tx, 'shared');
      const at = new Date();
      const [action] = await tx
        .insert(schema.adminActions)
        .values({
          adminId: third.id,
          type: 'market_conflict_declare',
          targetType: 'market',
          targetId: market.id,
          payload: { reason: '등록자의 이해관계' },
          createdAt: at,
        })
        .returning();
      await declareMarketConflict(tx, {
        marketId: market.id,
        userId: third.id,
        reason: '등록자의 이해관계',
        adminActionId: action!.id,
        at,
      });
    });
    expectConflict(await confirm(market.id, requestId, reviewer));
    expect((await requestsFor(market.id))[0]!.status).toBe('pending');

    // 오류 확인 waits for 지급 완료 (144-13); 기각 is taken while the payout runs.
    const settling = await paidMarket({ status: 'settling' });
    const waiting = await registered(settling.id);
    expectRefused(await confirm(settling.id, waiting), 'status', 'not settled');
    const dismissed = await dismiss(settling.id, waiting);
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect(detail(dismissed).judgementIncident).toMatchObject({
      registrable: true,
      confirmable: false,
      pending: null,
      confirmed: null,
      log: [
        expect.objectContaining({
          requestId: waiting,
          status: 'rejected',
          decidedBy: await actorOf(reviewer),
          decisionReason: DISMISS_REASON,
        }),
      ],
    });
    expect((await actionsFor(settling.id)).map((row) => [row.type, row.payload])).toEqual([
      ['market_judgement_incident_register', expect.anything()],
      [
        'market_judgement_incident_dismiss',
        { approvalId: waiting, correctedResult: 'NO', reason: DISMISS_REASON },
      ],
    ]);
    // Nothing is public after a dismissal, and another may be registered.
    expect((await publicMarket(settling.id)).judgingRecord.correction).toBeNull();
    expect(
      await t.db
        .select()
        .from(schema.marketJudgementIncidents)
        .where(eq(schema.marketJudgementIncidents.marketId, settling.id)),
    ).toEqual([]);
    expectNotAllowed(await dismiss(settling.id, waiting), 'decided');
    expectNotAllowed(await confirm(settling.id, waiting), 'decided');
    await registered(settling.id, third, { correctedResult: 'VOID' });
  });

  it('lets the registrant alone retract a waiting incident, in any status', async () => {
    const market = await paidMarket({ status: 'resolved' });
    const requestId = await registered(market.id);
    expectNotAllowed(await retract(market.id, requestId, reviewer), 'not_requester');
    expectRefused(await retract(market.id, NO_REQUEST), 'requestId', 'unknown');
    const res = await retract(market.id, requestId);
    expect(res.statusCode, res.body).toBe(200);
    expect(detail(res).judgementIncident.log).toEqual([
      expect.objectContaining({ status: 'retracted', retractedAt: expect.any(String) as string }),
    ]);
    const [request] = await requestsFor(market.id);
    const actions = await actionsFor(market.id);
    expect(actions.at(-1)).toMatchObject({
      type: 'market_judgement_incident_retract',
      adminId: registrant.id,
      createdAt: request!.retractedAt,
      payload: { approvalId: requestId, correctedResult: 'NO' },
    });
    expectNotAllowed(await retract(market.id, requestId), 'retracted');
    expectNotAllowed(await confirm(market.id, requestId), 'retracted');
  });

  it('retracts the declarer’s own waiting incident with a self-declared conflict (ADR-0120 decision 6)', async () => {
    const market = await paidMarket();
    const requestId = await registered(market.id, third);
    const res = await declare(market.id, third);
    expect(res.statusCode, res.body).toBe(200);
    const answered = data<{ market: AdminMarket }>(res).market;
    expect(answered.judgementIncident.pending).toBeNull();
    const [request] = await requestsFor(market.id);
    expect(request!.status).toBe('retracted');
    const [declaration] = await t.db
      .select()
      .from(schema.marketConflictDeclarations)
      .where(eq(schema.marketConflictDeclarations.marketId, market.id));
    const retracted = (await actionsFor(market.id)).find(
      (row) => row.type === 'market_judgement_incident_retract',
    );
    expect(retracted?.payload).toEqual({
      conflictDeclarationId: declaration!.id,
      approvalId: requestId,
      correctedResult: 'NO',
    });
  });

  it('shows the corrected result in the theme results and the related markets (144-5)', async () => {
    const theme = await createTheme(t.db, { createdBy: registrant.id, publishedAt: new Date() });
    const base = await createMarket(t.db, {
      createdBy: registrant.id,
      categoryId: category.id,
      status: 'open',
    });
    // YES → VOID: hidden from the related markets once confirmed; VOID → YES: shown.
    const toVoid = await paidMarket({ result: 'YES' });
    const fromVoid = await paidMarket({ result: 'VOID' });
    const plain = await paidMarket({ result: 'NO' });
    for (const market of [toVoid, fromVoid, plain]) {
      await createThemeMarket(t.db, {
        themeId: theme.id,
        marketId: market.id,
        createdBy: registrant.id,
      });
      await createMarketLink(t.db, {
        marketId: base.id,
        relatedMarketId: market.id,
        createdBy: registrant.id,
      });
    }
    const related = async () => {
      const res = await get(`/api/v1/markets/${base.id}/related?limit=50`);
      expect(res.statusCode, res.body).toBe(200);
      return data<MarketSummary[]>(res)
        .map((row) => row.id)
        .sort();
    };
    const results = async () => {
      const res = await get(`/api/v1/themes/${theme.id}/results?limit=50`);
      expect(res.statusCode, res.body).toBe(200);
      return new Map(data<ThemeResult[]>(res).map((row) => [row.marketId, row]));
    };
    expect(await related()).toEqual([toVoid.id, plain.id].sort());
    expect([...(await results()).values()].map((row) => row.corrected)).toEqual([
      false,
      false,
      false,
    ]);

    for (const [market, corrected] of [
      [toVoid, 'VOID'],
      [fromVoid, 'YES'],
    ] as const) {
      const requestId = await registered(market.id, registrant, { correctedResult: corrected });
      expect((await confirm(market.id, requestId)).statusCode).toBe(200);
    }
    expect(await related()).toEqual([fromVoid.id, plain.id].sort());
    const after = await results();
    expect(after.get(toVoid.id)).toMatchObject({ result: 'VOID', corrected: true });
    expect(after.get(fromVoid.id)).toMatchObject({ result: 'YES', corrected: true });
    expect(after.get(plain.id)).toMatchObject({ result: 'NO', corrected: false });
  });

  it('lists the waiting incidents, the oldest first, paged, for admins', async () => {
    const first = await paidMarket();
    const second = await paidMarket({ status: 'settling', result: 'NO' });
    const one = await registered(first.id, registrant, { correctedResult: 'VOID' });
    const two = await registered(second.id, third, { correctedResult: 'YES' });
    const decided = await paidMarket();
    const gone = await registered(decided.id);
    expect((await dismiss(decided.id, gone)).statusCode).toBe(200);

    const page = await get('/api/v1/admin/market-judgement-incidents?limit=1', reviewer);
    expect(page.statusCode, page.body).toBe(200);
    const firstPage = page.json<Page<AdminMarketJudgementIncidentQueueItem>>();
    expect(firstPage.data).toEqual([
      {
        requestId: one,
        marketId: first.id,
        slug: first.slug,
        title: expect.any(String) as string,
        status: 'settled',
        originalResult: 'YES',
        correctedResult: 'VOID',
        requestedBy: await actorOf(registrant),
        requestedAt: expect.any(String) as string,
      },
    ]);
    expect(firstPage.meta.nextCursor).not.toBeNull();
    const next = await get(
      `/api/v1/admin/market-judgement-incidents?limit=1&cursor=${encodeURIComponent(
        firstPage.meta.nextCursor!,
      )}`,
      reviewer,
    );
    const secondPage = next.json<Page<AdminMarketJudgementIncidentQueueItem>>();
    expect(secondPage.data.map((row) => [row.requestId, row.status, row.originalResult])).toEqual([
      [two, 'settling', 'NO'],
    ]);
    expect(secondPage.meta.nextCursor).toBeNull();
    // A member is refused, as on every admin route.
    const member = await signUpTestUser(t);
    expect((await get('/api/v1/admin/market-judgement-incidents', member)).statusCode).toBe(403);
  });
});
