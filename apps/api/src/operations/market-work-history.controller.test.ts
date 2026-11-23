/**
 * 시장별 작업 이력 (#145, ADR-0164; 145-5, 145-6, 145-7, 145-12, 145-13, 145-16) through
 * `GET /admin/markets/:id/work-history` against the docker `test` profile, every record made by
 * the real routes (no admin action inserted by hand but the excluded bot control's stand-in):
 * - 수정·그 밖: a draft made, edited and given liquidity, submitted, approved past its scheduled
 *   open (opened at once by its approver), its tags and 가격 보호 폭 changed while open and a related
 *   market linked — each entry with its admin, time and reason or the basis that stands for one
 *   (바뀐 항목 with 항목: 이전 → 새, 담당자와 시각만), the twins' events never read twice;
 * - 중단: a pause with its note, a 재개 asked and approved by another admin, and the system's
 *   pause on a ledger mismatch found by a manual reconciliation run (actor null, '시스템');
 * - 판정: a 판정 지연 기록, an 이해충돌 신고, a registration (its 설명) and approval, and the
 *   system's 결과 확정;
 * - 지급: a 정산 다시 시도 that fails on a ledger hold, the hold's recovery asked and approved, the
 *   retry that settles (결과 성공·실패, 145-7), the system's 지급 완료 and the step's failure record
 *   with its attempts and last error (145-6);
 * - two markets with one action of each kind: neither's history holds the other's records but the
 *   link row naming both (AC 6); bot controls and theme records never appear (145-5, 145-13);
 * - each kind filter is the whole history's rows of that kind, the pages add up, an unknown market
 *   is an empty page, a member is refused (403) and a visitor too (401), and no public answer
 *   carries a record's reason.
 * Skips when TEST_* are unset.
 */
import { randomUUID } from 'node:crypto';
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createMarket,
  createOpenedMarket,
  createTheme,
  createUser,
  mintTestPairs,
  openOrderIntake,
  prepareMarketMakerOpening,
  resolveMarketNow,
  setReleaseSetting,
  withLedgerGuardsOff,
  TEST_PRICE_PROTECTION_TICKS,
} from '@buddha/db/test';
import {
  DISPUTE_WINDOW_SETTING,
  LEAD_CLOSE_GAP_SETTING,
  MARKET_PAUSE_DECISION_APPROVAL_KIND,
  MARKET_REVIEW_CHECKLIST,
  MARKET_SNAPSHOT_CHANGE_FIELDS,
  MARKET_SNAPSHOT_IGNORED_FIELDS,
  MARKET_WORK_KINDS,
  PRICE_PROTECTION_TICKS_SETTING,
  adminMarketWorkPageSchema,
  floorToMinute,
  isJudgementCorrection,
  marketWorkKindOf,
  type AdminMarketWorkEntry,
  type AdminMarketWorkPage,
  type MarketWorkKind,
} from '@buddha/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { MarketJobs } from '../jobs/market-jobs.service.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A well-formed market id that names no market. */
const NO_MARKET = '3d9a1c7e-5b2f-4e8a-9c0d-1e2f3a4b5c6d';

/** Reasons the routes store, each unique so a public answer can be searched for it. */
const LIQUIDITY_REASON = '작업 이력 시험의 유동성 설정 사유';
const APPROVE_REASON = '작업 이력 시험의 검수 통과 사유';
const PROTECTION_REASON = '작업 이력 시험의 가격 보호 폭 사유';
const PAUSE_NOTE = '작업 이력 시험의 일시 중단 공개 안내';
const RESUME_REASON = '작업 이력 시험의 재개 요청 사유';
const RESUME_APPROVAL = '작업 이력 시험의 재개 승인 사유';
const DELAY_REASON = '작업 이력 시험의 판정 지연 사유';
const CONFLICT_REASON = '작업 이력 시험의 이해충돌 신고 사유';
const DESCRIPTION = '작업 이력 시험의 판정 설명: 한국은행 보도자료에서 확인했다.';
const JUDGEMENT_APPROVAL = '작업 이력 시험의 판정 승인 사유';
const CORRECTION_REASON = '작업 이력 시험의 판정 정정 사유';
const CORRECTION_APPROVAL = '작업 이력 시험의 판정 정정 승인 사유';
const RETRY_REASON = '작업 이력 시험의 정산 다시 시도 사유';
const RECOVERY_REASON = '작업 이력 시험의 대사 보류 복구 사유';
const RECOVERY_APPROVAL = '작업 이력 시험의 대사 보류 복구 승인 사유';

type Res = { statusCode: number; json: <U>() => U; body: string };

/** An ISO instant, `ms` from the epoch. */
const iso = (ms: number) => new Date(ms).toISOString();
/** A whole minute a week ahead: the close the tests' markets start from. */
const week = () => floorToMinute(Date.now()) + 7 * DAY_MS;

describe.skipIf(!hasTestInfra)('시장별 작업 이력 (integration)', () => {
  let t: TestApp;
  /** Makes the drafts, pauses, registers and retries unless a test says otherwise. */
  let creator: TestUser;
  /** Decides what `creator` asks. */
  let second: TestUser;
  /** Approves the reviews (neither creator, editor nor submitter). */
  let third: TestUser;
  let member: TestUser;
  let category: { id: number; slug: string };
  let drafts = 0;

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
    await t.reset();
    creator = await makeAdmin();
    second = await makeAdmin();
    third = await makeAdmin();
    member = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: member.id });
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
    for (const [key, value] of [
      [PRICE_PROTECTION_TICKS_SETTING.key, TEST_PRICE_PROTECTION_TICKS],
      [LEAD_CLOSE_GAP_SETTING.key, 30],
      [DISPUTE_WINDOW_SETTING.key, 1_440],
    ] as const) {
      await setReleaseSetting(t.db, { adminId: creator.id, key, status: 'test', value });
    }
    // Publishes and jobs are the other suites'; here they only must not reach Redis consumers.
    vi.spyOn(t.app.get(MarketJobs), 'recallMarketMaker').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Every write names the admin on screen (ADR-0092): `who`'s own account.
  const send = (
    method: 'POST' | 'PATCH',
    url: string,
    who: TestUser,
    payload: Record<string, unknown> = {},
  ) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: {
        expectedAccountId: who.id,
        ...(/\/judgements(?:$|\/[^/]+\/approve$)/.test(url) ? { noConflictConfirmed: true } : {}),
        ...payload,
      },
    });
  async function ok(res: Res | Promise<Res>, status = 200): Promise<Res> {
    const done = await res;
    expect(done.statusCode, done.body).toBe(status);
    return done;
  }
  const post = (url: string, who: TestUser, payload: Record<string, unknown> = {}) =>
    ok(send('POST', url, who, payload));
  const get = (url: string, cookie?: string) =>
    t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: cookie ? { cookie } : {} });
  const marketUrl = (id: string) => `/admin/markets/${id}`;

  /** One page of the history as an admin reads it, checked against the shared schema. */
  async function page(
    id: string,
    query = '',
    who: TestUser = second,
  ): Promise<AdminMarketWorkPage> {
    const res = await get(`${marketUrl(id)}/work-history${query}`, who.cookie);
    expect(res.statusCode, res.body).toBe(200);
    return adminMarketWorkPageSchema.parse(res.json<AdminMarketWorkPage>());
  }
  /** The whole history (or one kind's), page after page. */
  async function history(id: string, kind?: MarketWorkKind, limit = 100) {
    const entries: AdminMarketWorkEntry[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ limit: String(limit) });
      if (kind) params.set('kind', kind);
      if (cursor) params.set('cursor', cursor);
      const next = await page(id, `?${params.toString()}`);
      entries.push(...next.data);
      cursor = next.meta.nextCursor;
    } while (cursor !== null);
    return entries;
  }

  /** An admin as the history names one: the account and its nickname. */
  const actorOf = async (user: TestUser) => {
    const [profile] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, user.id));
    return { id: user.id, nickname: profile!.nickname };
  };

  /**
   * What every entry holds (AC 6 "각 기록에 담당자·시각·사유"): its kind from the shared map, an
   * instant, oldest first, and an actor or '시스템' (null, then the rule is the reason); a reason
   * where one is recorded — every `recorded` row the routes wrote has one — and none otherwise.
   */
  function expectWellFormed(entries: AdminMarketWorkEntry[]) {
    for (const entry of entries) {
      expect(entry.kind, entry.type).toBe(marketWorkKindOf(entry.type));
      expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
      // '시스템' reads the rule as its reason; an admin's `opened` (an approval or a reschedule
      // that found the open come, its only human event) reads it too, the decision's reason being
      // on its own action.
      if (entry.actor === null || entry.source === 'market_event') {
        expect(entry.reasonBasis, entry.type).toBe('system');
      } else {
        expect(entry.reasonBasis, entry.type).not.toBe('system');
      }
      if (entry.reasonBasis === 'recorded') {
        expect(entry.reason?.trim(), entry.type).toBeTruthy();
      } else if (entry.type !== 'cancelled') {
        expect(entry.reason, entry.type).toBeNull();
      }
    }
    const times = entries.map((entry) => Date.parse(entry.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
  }
  /** The entries of one type (one expected unless `n` says otherwise). */
  function ofType(entries: AdminMarketWorkEntry[], type: string, n = 1) {
    const found = entries.filter((entry) => entry.type === type);
    expect(found.map((entry) => entry.type)).toEqual(Array<string>(n).fill(type));
    return found;
  }
  /** Each kind filter answers exactly the whole history's rows of that kind, in its order. */
  async function expectKindsAddUp(id: string, all: AdminMarketWorkEntry[]) {
    for (const kind of MARKET_WORK_KINDS) {
      const filtered = await history(id, kind);
      expect(filtered.map((entry) => entry.id)).toEqual(
        all.filter((entry) => entry.kind === kind).map((entry) => entry.id),
      );
    }
  }

  // --- the routes' flows --------------------------------------------------------------------
  /** A complete draft's body closing at `closeMs` (as admin-markets-review.controller.test). */
  const draftBody = (closeMs: number, overrides: Record<string, unknown> = {}) => {
    drafts += 1;
    return {
      title: `작업 이력 시험 시장 ${String(drafts)}`,
      description: '한국은행 금융통화위원회는 해마다 여덟 번 기준금리를 정한다.',
      yesCondition: `사건 기한까지 기준금리를 3% 이하로 내리면 YES. (${String(drafts)})`,
      noCondition: '사건 기한까지 3% 이하로 내리지 않으면 NO.',
      eventDeadline: iso(closeMs + DAY_MS),
      primarySource: { name: '한국은행 보도자료', url: 'https://www.bok.or.kr' },
      longDelayDays: 14,
      delayHandling: '장기 지연 기한까지 발표가 없으면 무효로 판정한다.',
      categoryId: category.id,
      scheduledOpenAt: iso(closeMs - 2 * DAY_MS),
      closeAt: iso(closeMs),
      scheduledJudgementAt: iso(closeMs + 2 * DAY_MS),
      judgementTimeZone: 'Asia/Seoul',
      tags: ['검수'],
      ...overrides,
    };
  };
  /**
   * A market made through the routes by `creator` and opened at once by `third`'s approval (its
   * scheduled open already passed, #21): 초안 만들기, 유동성 설정, 검수 제출, 승인.
   */
  async function openedThroughRoutes(): Promise<{ id: string; title: string }> {
    const close = week();
    const created = await ok(
      send(
        'POST',
        '/admin/markets',
        creator,
        draftBody(close, {
          scheduledOpenAt: iso(floorToMinute(Date.now()) - MINUTE_MS),
          scheduledAnnouncementAt: iso(close + HOUR_MS),
        }),
      ),
      201,
    );
    const { id, title } = created.json<{ data: { id: string; title: string } }>().data;
    await post(`${marketUrl(id)}/liquidity-settings`, creator, {
      baseVersion: null,
      reason: LIQUIDITY_REASON,
      settings: {
        budgetCoin: '10000',
        maxLossCoin: '5000',
        b: 100,
        levels: 3,
        quantity: 10,
        safetyTicks: 1,
      },
    });
    await post(`${marketUrl(id)}/submit`, creator);
    await prepareMarketMakerOpening(t.db, id);
    const [request] = await t.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.targetId, id),
          eq(schema.approvalRequests.status, 'pending'),
        ),
      );
    const approved = await post(`${marketUrl(id)}/approve`, third, {
      requestId: request!.id,
      checklist: [...MARKET_REVIEW_CHECKLIST],
      reason: APPROVE_REASON,
    });
    expect(approved.json<{ data: { status: string } }>().data.status).toBe('open');
    return { id, title };
  }

  /** An OPEN market made by the factory, as the worker opens one (a system `opened`). */
  async function opened(tags = ['이력']) {
    const { market } = await createOpenedMarket(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
      tags,
      closeAt: new Date(week()),
    });
    return market;
  }

  /** 거래 일시 중단 by `creator` for a basis change, with the public note. */
  const pause = (id: string) =>
    post(`${marketUrl(id)}/pause`, creator, {
      publicNoteConfirmed: true,
      reason: 'basis_change',
      note: PAUSE_NOTE,
    });
  /** 재개 asked by `creator` and approved by `second`. */
  async function resume(id: string) {
    const [newest] = await t.db
      .select()
      .from(schema.marketPauses)
      .where(eq(schema.marketPauses.marketId, id))
      .orderBy(asc(schema.marketPauses.pausedAt));
    await post(`${marketUrl(id)}/pause-decisions`, creator, {
      pauseId: newest!.id,
      reason: RESUME_REASON,
      path: 'resume',
      reviewResult: 'judgeable',
    });
    const [request] = await t.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.kind, MARKET_PAUSE_DECISION_APPROVAL_KIND),
          eq(schema.approvalRequests.targetId, id),
          eq(schema.approvalRequests.status, 'pending'),
        ),
      );
    await post(`${marketUrl(id)}/pause-decisions/${request!.id}/approve`, second, {
      reason: RESUME_APPROVAL,
    });
  }

  /** A manual reconciliation run of the market (`reconciliation_run`, 대사 실행). */
  async function reconcile(id: string) {
    const res = await post('/admin/reconciliation/run', creator, {
      target: { scope: 'market', marketId: id },
    });
    return res.json<{
      data: {
        result: { passed: boolean };
        hold: { id: string; failureResultId: string } | null;
      };
    }>().data;
  }
  /** The market's collateral account moved by `delta` behind the ledger guards: a mismatch. */
  async function tamperCollateral(id: string, delta: number) {
    const [collateral] = await t.db
      .select()
      .from(schema.ledgerAccounts)
      .where(
        and(
          eq(schema.ledgerAccounts.marketId, id),
          eq(schema.ledgerAccounts.kind, 'market_collateral'),
        ),
      );
    await withLedgerGuardsOff((client) =>
      client.query(
        'UPDATE balances SET available_coin = available_coin + $1 WHERE account_id = $2',
        [delta, collateral!.id],
      ),
    );
  }
  /** Two members holding three pairs of the market (its collateral account with them). */
  async function holders(id: string) {
    const yes = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    const no = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    await mintTestPairs(t.db, {
      marketId: id,
      yesHolderId: yes,
      noHolderId: no,
      qty: 3,
      yesPriceCoin: 60,
    });
  }

  /** A failed market reconciliation's hold, planted: the payout refuses until it is recovered. */
  async function holdLedger(marketId: string): Promise<{ holdId: string; failureId: number }> {
    return t.db.transaction(async (tx) => {
      const at = await clockTimestamp(tx);
      const [failure] = await tx
        .insert(schema.reconciliationResults)
        .values({
          scope: 'market',
          targetKey: `market:${marketId}`,
          marketId,
          accountId: null,
          userId: null,
          source: 'manual',
          actorId: null,
          passed: false,
          checkedAt: at,
          ledgerCursor: 0,
          findings: [{ code: 'account_balance', expected: '1', actual: '0' }],
          facts: {},
        })
        .returning();
      const [hold] = await tx
        .insert(schema.reconciliationHolds)
        .values({
          scope: 'market',
          targetKey: `market:${marketId}`,
          marketId,
          userId: null,
          failureResultId: failure!.id,
          startedAt: at,
        })
        .returning();
      return { holdId: hold!.id, failureId: failure!.id };
    });
  }
  /** 대사 보류 복구: asked by `creator` after a clean run, approved by `second`. */
  async function recover(holdId: string, failureId: number) {
    const requested = await post(
      `/admin/reconciliation/holds/${holdId}/recovery-requests`,
      creator,
      { failureResultId: String(failureId), reason: RECOVERY_REASON },
    );
    const requestId = requested.json<{ data: { requests: { id: string }[] } }>().data.requests[0]!
      .id;
    await post(
      `/admin/reconciliation/holds/${holdId}/recovery-requests/${requestId}/approve`,
      second,
      { reason: RECOVERY_APPROVAL },
    );
  }
  /** 정산 다시 시도 by `creator`. */
  const retry = (id: string) =>
    post(`${marketUrl(id)}/settlement-retries`, creator, { reason: RETRY_REASON });

  /** 이해충돌 신고 by `who`. */
  const declareConflict = (id: string, who: TestUser = third) =>
    post(`${marketUrl(id)}/conflicts`, who, { reason: CONFLICT_REASON });

  // --- 수정 · 그 밖 ---------------------------------------------------------------------------
  it('수정·그 밖: the draft, its liquidity, the review, the open at once, the tags and category, the 가격 보호 폭 and a link, each with its admin, time and reason basis', async () => {
    const market = await openedThroughRoutes();
    const other = await createMarket(t.db, { createdBy: creator.id, categoryId: category.id });
    // The category moves with the tags (145-10: a market's category change is its history's).
    const moved = await createCategory(t.db, { slug: 'prices', nameKo: '물가' });
    await ok(
      send('PATCH', marketUrl(market.id), creator, {
        tags: ['검수', '금리'],
        categoryId: moved.id,
      }),
    );
    await post(`${marketUrl(market.id)}/price-protection`, creator, {
      priceProtectionTicks: TEST_PRICE_PROTECTION_TICKS + 2,
      reason: PROTECTION_REASON,
    });
    await post(`${marketUrl(market.id)}/related`, second, { marketId: other.id });

    const all = await history(market.id);
    expectWellFormed(all);
    const by = { creator: await actorOf(creator), second: await actorOf(second) };
    const approver = await actorOf(third);

    // 초안 만들기 (바뀐 항목: every field it fills, from nothing).
    const [create] = ofType(all, 'market_create');
    expect(create).toMatchObject({
      kind: 'edit',
      source: 'admin_action',
      actor: by.creator,
      reason: null,
      reasonBasis: 'changed_items',
      relatedMarket: null,
      settlement: null,
      retryOutcome: null,
    });
    expect(create!.id).toMatch(/^a:/);
    expect(create!.changes).toContainEqual({ field: 'title', before: null, after: market.title });
    // 유동성 설정 (recorded), then the tags edit while open (바뀐 항목: 이전 → 새).
    const [liquidity, tags] = ofType(all, 'market_update', 2);
    expect(liquidity).toMatchObject({
      kind: 'edit',
      actor: by.creator,
      reason: LIQUIDITY_REASON,
      reasonBasis: 'recorded',
      changes: [],
    });
    expect(tags).toMatchObject({
      kind: 'edit',
      actor: by.creator,
      reason: null,
      reasonBasis: 'changed_items',
      changes: [
        // The category by its current name, never a bare id (145-16 항목: 이전 → 새).
        {
          field: 'categoryId',
          before: { id: category.id, nameKo: '경제' },
          after: { id: moved.id, nameKo: '물가' },
        },
        { field: 'tags', before: ['검수'], after: ['검수', '금리'] },
      ],
    });
    // The draft's category, from nothing, by its name too.
    expect(create!.changes).toContainEqual({
      field: 'categoryId',
      before: null,
      after: { id: category.id, nameKo: '경제' },
    });
    // The snapshots stay out of the details: their rule texts are in the changes alone.
    expect(Object.keys(tags!.details)).not.toContain('before');
    expect(Object.keys(tags!.details)).not.toContain('after');
    // 가격 보호 폭: its reason, the widths before and after kept (scalars).
    expect(ofType(all, 'market_price_protection_change')[0]).toMatchObject({
      kind: 'edit',
      actor: by.creator,
      reason: PROTECTION_REASON,
      reasonBasis: 'recorded',
      details: {
        before: TEST_PRICE_PROTECTION_TICKS,
        after: TEST_PRICE_PROTECTION_TICKS + 2,
      },
    });
    // 개설 검수: the submission (바뀐 항목) and the approval with its reason.
    expect(ofType(all, 'market_submit')[0]).toMatchObject({
      kind: 'other',
      actor: by.creator,
      reasonBasis: 'changed_items',
    });
    expect(ofType(all, 'market_approve')[0]).toMatchObject({
      kind: 'other',
      actor: approver,
      reason: APPROVE_REASON,
      reasonBasis: 'recorded',
    });
    // The open at once is the approver's own event (no admin action of its own, 'always').
    const [open] = ofType(all, 'opened');
    expect(open).toMatchObject({
      kind: 'other',
      source: 'market_event',
      actor: approver,
      reason: null,
      reasonBasis: 'system',
      details: { source: 'approval' },
    });
    expect(open!.id).toMatch(/^e:\d+$/);
    // 관련 시장: 담당자와 시각만, the other end named.
    expect(ofType(all, 'market_link')[0]).toMatchObject({
      kind: 'other',
      actor: by.second,
      reason: null,
      reasonBasis: 'actor_time',
      relatedMarket: { id: other.id, title: other.title },
    });
    // One source per fact: the events that twin an admin action are never read.
    for (const twin of ['created', 'submitted', 'approved']) ofType(all, twin, 0);
    expect(all.map((entry) => entry.type).slice(0, 4)).toEqual([
      'market_create',
      'market_update',
      'market_submit',
      // the approval and its open share the transaction; either may come first
      expect.stringMatching(/^(market_approve|opened)$/),
    ]);
    // The link shows on the other market too, naming this one.
    expect(await history(other.id)).toEqual([
      expect.objectContaining({
        id: ofType(all, 'market_link')[0]!.id,
        relatedMarket: { id: market.id, title: market.title },
      }),
    ]);

    // Every key the real snapshot writes is compared or ignored, never both (shared lists).
    const [stored] = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.id, tags!.id.slice(2)));
    const keys = Object.keys((stored!.payload as { after: object }).after).sort();
    expect(keys).toEqual(
      [...MARKET_SNAPSHOT_CHANGE_FIELDS, ...MARKET_SNAPSHOT_IGNORED_FIELDS].sort(),
    );
    expect(
      MARKET_SNAPSHOT_CHANGE_FIELDS.filter((field) =>
        (MARKET_SNAPSHOT_IGNORED_FIELDS as readonly string[]).includes(field),
      ),
    ).toEqual([]);

    await expectKindsAddUp(market.id, all);
    // The pages add up at any size, across the tie of the approval and its open.
    for (const limit of [1, 2, 3]) {
      expect((await history(market.id, undefined, limit)).map((entry) => entry.id)).toEqual(
        all.map((entry) => entry.id),
      );
    }
  });

  // --- 중단 ----------------------------------------------------------------------------------
  it('중단: a pause with its note, a 재개 asked and approved, and the system’s pause on a ledger mismatch', async () => {
    const market = await opened();
    await pause(market.id);
    await resume(market.id);
    await holders(market.id);
    await tamperCollateral(market.id, 1);
    expect((await reconcile(market.id)).result.passed).toBe(false);

    const all = await history(market.id);
    expectWellFormed(all);
    const pauses = all.filter((entry) => entry.kind === 'pause');
    expect(
      pauses.map((entry) => [entry.type, entry.actor?.id ?? null, entry.reason, entry.reasonBasis]),
    ).toEqual([
      ['market_pause', creator.id, PAUSE_NOTE, 'recorded'],
      ['market_pause_decision_request', creator.id, RESUME_REASON, 'recorded'],
      ['market_pause_decision_approve', second.id, RESUME_APPROVAL, 'recorded'],
      // 원장 불일치 자동 중단 (145-6, 145-12): '시스템', the rule its reason.
      ['paused', null, null, 'system'],
    ]);
    expect(pauses[0]!.details).toMatchObject({ reason: 'basis_change' });
    expect(pauses[3]).toMatchObject({
      source: 'market_event',
      actor: null,
      details: { reason: 'ledger_failure' },
    });
    // The admin's own pause and resume events are their actions' twins: not read again.
    ofType(all, 'resumed', 0);
    // The worker's open is '시스템' too, and the run that found the mismatch is 대사 실행.
    expect(ofType(all, 'opened')[0]).toMatchObject({ kind: 'other', actor: null });
    expect(ofType(all, 'reconciliation_run')[0]).toMatchObject({
      kind: 'other',
      actor: await actorOf(creator),
      reason: null,
      reasonBasis: 'actor_time',
    });
    await expectKindsAddUp(market.id, all);
  });

  // --- 판정 ----------------------------------------------------------------------------------
  it('판정: a 판정 지연 기록, an 이해충돌 신고, a registration and its approval, and the system’s 결과 확정', async () => {
    const market = await createMarket(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
      status: 'closed',
      openAt: new Date(Date.now() - 10 * DAY_MS),
      closeAt: new Date(Date.now() - 3 * DAY_MS),
    });
    await post(`${marketUrl(market.id)}/judgement-delays`, creator, {
      reason: DELAY_REASON,
      nextReviewAt: iso(Date.now() + DAY_MS),
    });
    await declareConflict(market.id);
    await post(`${marketUrl(market.id)}/judgements`, creator, {
      result: 'YES',
      source: { priority: 0 },
      evidence: {
        links: ['https://www.bok.or.kr/press/2026-10'],
        collectedAt: iso(Date.now() - MINUTE_MS),
      },
      description: DESCRIPTION,
    });
    const [request] = await t.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.targetId, market.id),
          eq(schema.approvalRequests.status, 'pending'),
        ),
      );
    await post(`${marketUrl(market.id)}/judgements/${request!.id}/approve`, second, {
      reason: JUDGEMENT_APPROVAL,
      eventDeadlineConfirmed: false,
    });
    await resolveMarketNow(t.db, market.id);

    const all = await history(market.id);
    expectWellFormed(all);
    expect(
      all.map((entry) => [
        entry.type,
        entry.kind,
        entry.actor?.id ?? null,
        entry.reason,
        entry.reasonBasis,
      ]),
    ).toEqual([
      ['market_delay_record', 'judgement', creator.id, DELAY_REASON, 'recorded'],
      ['market_conflict_declare', 'judgement', third.id, CONFLICT_REASON, 'recorded'],
      // 판정 등록: its 설명 stands as the reason (145-16).
      ['market_judgement_request', 'judgement', creator.id, DESCRIPTION, 'recorded'],
      ['market_judgement_approve', 'judgement', second.id, JUDGEMENT_APPROVAL, 'recorded'],
      // 결과 확정 (시스템): the dispute deadline passed with nothing holding it.
      ['resolved', 'judgement', null, null, 'system'],
    ]);
    // The approval's `provisional` and the delay's event are their actions' twins.
    for (const twin of ['provisional', 'judgement_delay_recorded']) ofType(all, twin, 0);
    expect(all[4]).toMatchObject({ details: { source: 'deadline', result: 'YES' } });
    await expectKindsAddUp(market.id, all);
  });

  it('판정 정정: its registration with its 설명 as its reason like any 판정 등록 and its approval, a second one retracted (#176)', async () => {
    const market = await createMarket(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
      status: 'closed',
      openAt: new Date(Date.now() - 10 * DAY_MS),
      closeAt: new Date(Date.now() - 3 * DAY_MS),
    });
    const registration = (result: string, extra: Record<string, unknown> = {}) => ({
      result,
      source: { priority: 0 },
      evidence: {
        links: ['https://www.bok.or.kr/press/2026-10'],
        collectedAt: iso(Date.now() - MINUTE_MS),
      },
      description: DESCRIPTION,
      ...extra,
    });
    const pending = async () => {
      const [request] = await t.db
        .select()
        .from(schema.approvalRequests)
        .where(
          and(
            eq(schema.approvalRequests.targetId, market.id),
            eq(schema.approvalRequests.status, 'pending'),
          ),
        );
      return request!.id;
    };
    // v1, then its correction to NO (v2), then a correction of v2 its registrant retracts.
    await post(`${marketUrl(market.id)}/judgements`, creator, registration('YES'));
    await post(`${marketUrl(market.id)}/judgements/${await pending()}/approve`, second, {
      reason: JUDGEMENT_APPROVAL,
      eventDeadlineConfirmed: false,
    });
    await post(
      `${marketUrl(market.id)}/judgements`,
      creator,
      registration('NO', { correction: { baseVersion: 1, reason: CORRECTION_REASON } }),
    );
    await post(`${marketUrl(market.id)}/judgements/${await pending()}/approve`, second, {
      reason: CORRECTION_APPROVAL,
      eventDeadlineConfirmed: false,
    });
    await post(
      `${marketUrl(market.id)}/judgements`,
      creator,
      registration('YES', { correction: { baseVersion: 2, reason: CORRECTION_REASON } }),
    );
    await post(`${marketUrl(market.id)}/judgements/${await pending()}/retract`, creator);

    const all = await history(market.id);
    expectWellFormed(all);
    expect(
      all.map((entry) => [
        entry.type,
        isJudgementCorrection(entry.type, entry.details),
        entry.reason,
        entry.reasonBasis,
      ]),
    ).toEqual([
      // 판정 등록: its 설명 (145-16).
      ['market_judgement_request', false, DESCRIPTION, 'recorded'],
      ['market_judgement_approve', false, JUDGEMENT_APPROVAL, 'recorded'],
      // 판정 정정: the same 판정 등록, so its 설명 (145-16 "판정 등록은 그 설명"); its 정정 사유
      // is in the details.
      ['market_judgement_request', true, DESCRIPTION, 'recorded'],
      ['market_judgement_approve', true, CORRECTION_APPROVAL, 'recorded'],
      ['market_judgement_request', true, DESCRIPTION, 'recorded'],
      ['market_judgement_retract', true, null, 'retracted'],
    ]);
    expect(all[2]!.details).toMatchObject({
      description: DESCRIPTION,
      correction: { baseVersion: 1, reason: CORRECTION_REASON, disputeIds: [] },
    });
    expect(all[3]!.details).toMatchObject({
      version: 2,
      result: 'NO',
      correction: { baseVersion: 1, reason: CORRECTION_REASON },
    });
    expect(all[5]!.details).toMatchObject({ result: 'YES', reopenedDisputeIds: [] });
    // The approval's `judgement_corrected` is its action's twin.
    ofType(all, 'judgement_corrected', 0);
    await expectKindsAddUp(market.id, all);
  });

  // --- 지급 ----------------------------------------------------------------------------------
  it('지급: a retry that fails on the hold, its recovery, the retry that settles, the system’s 지급 완료 and the step’s failure record', async () => {
    vi.spyOn(t.app.get(MarketPublisher), 'publishMarket').mockResolvedValue(undefined);
    vi.spyOn(t.app.get(MarketPublisher), 'publishUser').mockResolvedValue(undefined);
    const market = await createMarket(t.db, {
      createdBy: creator.id,
      categoryId: category.id,
      status: 'settling',
      resolvedResult: 'YES',
      judgementVersion: null,
    });
    await holders(market.id);
    const { holdId, failureId } = await holdLedger(market.id);
    const failed = await retry(market.id);
    expect(failed.json<{ data: { outcome: string } }>().data.outcome).toBe('failed');
    expect((await reconcile(market.id)).result.passed).toBe(true);
    await recover(holdId, failureId);
    const settled = await retry(market.id);
    expect(settled.json<{ data: { outcome: string } }>().data.outcome).toBe('settled');

    const all = await history(market.id);
    expectWellFormed(all);
    const by = await actorOf(creator);
    // The settled retry's row is written before the payout's `finalized` event in one
    // transaction (ADR-0163): at the same millisecond the event sorts first (one source per fact).
    const shown = all.filter((entry) => entry.kind === 'settlement');
    const [last, end] = [shown[3]!, shown[4]!];
    const tied = last.type === 'finalized' && last.at === end.at;
    const payout = tied ? [...shown.slice(0, 3), end, last, ...shown.slice(5)] : shown;
    expect(payout.map((entry) => [entry.type, entry.actor?.id ?? null])).toEqual([
      ['market_settlement_retry', creator.id],
      ['reconciliation_recovery_request', creator.id],
      ['reconciliation_recovery_approve', second.id],
      ['market_settlement_retry', creator.id],
      // 지급 완료 (시스템): the payout's own transition, the operator being the retry row.
      ['finalized', null],
      // 정산 실패 기록 (145-6): at the step's last update, after the success that kept its error.
      ['settlement_step', null],
    ]);
    // 145-7: 담당자·시각·사유와 결과(성공·실패).
    expect(payout[0]).toMatchObject({
      actor: by,
      reason: RETRY_REASON,
      reasonBasis: 'recorded',
      retryOutcome: 'failed',
    });
    expect(payout[0]!.details.outcome).toBe('failed');
    expect(payout[0]!.details.error).toMatch(/\S/);
    expect(payout[3]).toMatchObject({
      actor: by,
      reason: RETRY_REASON,
      reasonBasis: 'recorded',
      retryOutcome: 'settled',
    });
    expect(payout[1]).toMatchObject({ reason: RECOVERY_REASON, reasonBasis: 'recorded' });
    expect(payout[2]).toMatchObject({ reason: RECOVERY_APPROVAL, reasonBasis: 'recorded' });
    expect(payout[4]).toMatchObject({ source: 'market_event', reasonBasis: 'system' });
    const [step] = await t.db
      .select()
      .from(schema.marketSettlementSteps)
      .where(eq(schema.marketSettlementSteps.marketId, market.id));
    expect(payout[5]).toEqual({
      id: 's:coin',
      source: 'settlement_step',
      type: 'settlement_step',
      kind: 'settlement',
      at: step!.updatedAt.toISOString(),
      actor: null,
      reason: null,
      reasonBasis: 'system',
      details: { step: 'coin' },
      changes: [],
      relatedMarket: null,
      settlement: {
        stepStatus: 'done',
        settlementAttempts: 2,
        settlementLastError: step!.lastError,
        completedAt: step!.completedAt!.toISOString(),
      },
      retryOutcome: null,
    });
    expect(step!.lastError).toBeTruthy();
    // The manual run that preceded the recovery is 대사 실행, 그 밖 (145-12).
    expect(ofType(all, 'reconciliation_run')[0]).toMatchObject({ kind: 'other' });
    await expectKindsAddUp(market.id, all);
  });

  // --- AC 6: 다른 시장의 기록은 섞이지 않는다 --------------------------------------------------
  it('keeps two markets apart: one action of each kind on both, only the link row in both, no bot control or theme record', async () => {
    await openOrderIntake(t.db, { adminId: creator.id });
    const a = await opened(['가']);
    const b = await opened(['나']);
    for (const market of [a, b]) {
      // 수정: the tags while open.
      await ok(send('PATCH', marketUrl(market.id), creator, { tags: ['다', '라'] }));
      // 판정: an 이해충돌 신고.
      await declareConflict(market.id);
      // 지급: a planted hold's recovery after a clean run (대사 실행, 그 밖).
      const { holdId, failureId } = await holdLedger(market.id);
      expect((await reconcile(market.id)).result.passed).toBe(true);
      await recover(holdId, failureId);
      // 중단: a pause.
      await pause(market.id);
    }
    // 그 밖: the pair's one link, made from A.
    await post(`${marketUrl(a.id)}/related`, creator, { marketId: b.id });
    // Excluded (145-5, 145-13): a bot control request on A, and A put in a theme.
    const [runtime] = await t.db
      .select()
      .from(schema.marketMakerRuntime)
      .where(eq(schema.marketMakerRuntime.marketId, a.id));
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, a.id));
    await post(`${marketUrl(a.id)}/market-maker/control-requests`, creator, {
      reason: '작업 이력 밖의 봇 통제',
      baseVersion: row!.currentLiquidityVersion,
      baseControlGeneration: runtime!.controlGeneration.toString(),
      change: { action: 'stop' },
    });
    const theme = await createTheme(t.db, { createdBy: creator.id });
    await post(`/admin/themes/${theme.id}/markets`, creator, { marketId: a.id });
    const excluded = await t.db
      .select({ type: schema.adminActions.type })
      .from(schema.adminActions)
      .where(
        and(
          eq(schema.adminActions.type, 'market_maker_control_request'),
          eq(schema.adminActions.targetId, a.id),
        ),
      );
    expect(excluded).toHaveLength(1);

    const historyA = await history(a.id);
    const historyB = await history(b.id);
    expectWellFormed(historyA);
    expectWellFormed(historyB);
    for (const entries of [historyA, historyB]) {
      expect(new Set(entries.map((entry) => entry.kind))).toEqual(new Set(MARKET_WORK_KINDS));
      for (const entry of entries) {
        expect(entry.type).not.toMatch(/^(market_maker_control_|theme_)/);
      }
    }
    const idsA = new Set(historyA.map((entry) => entry.id));
    const shared = historyB.filter((entry) => idsA.has(entry.id));
    expect(shared.map((entry) => entry.type)).toEqual(['market_link']);
    expect(historyA.find((entry) => entry.id === shared[0]!.id)?.relatedMarket?.id).toBe(b.id);
    expect(shared[0]!.relatedMarket?.id).toBe(a.id);
    // Each market's actions are exactly the records bound to it (145-13): its own target, its
    // run's `market:` key, its hold's recovery, or the link naming it — the bot control and the
    // theme record left out, and nothing of the other market.
    const actionIds = (entries: AdminMarketWorkEntry[]) =>
      entries.filter((entry) => entry.source === 'admin_action').map((entry) => entry.id.slice(2));
    const holdMarket = new Map(
      (await t.db.select().from(schema.reconciliationHolds)).map((hold) => [
        hold.id,
        hold.marketId,
      ]),
    );
    const rows = await t.db.select().from(schema.adminActions);
    const boundTo = (row: (typeof rows)[number]): unknown[] => {
      if (/^(market_maker_control_|theme_)/.test(row.type)) return [];
      if (row.targetType === 'reconciliation_hold') return [holdMarket.get(row.targetId!)];
      if (row.targetType !== 'market') return [];
      if (row.targetId!.startsWith('market:')) return [row.targetId!.slice('market:'.length)];
      const payload = row.payload as { relatedMarketId?: string };
      return row.type === 'market_link' ? [row.targetId, payload.relatedMarketId] : [row.targetId];
    };
    for (const [market, entries] of [
      [a, historyA],
      [b, historyB],
    ] as const) {
      expect(actionIds(entries).sort()).toEqual(
        rows
          .filter((row) => boundTo(row).includes(market.id))
          .map((row) => row.id)
          .sort(),
      );
    }
  });

  // --- the surface -------------------------------------------------------------------------
  it('answers an empty page for an unknown market and refuses a malformed id', async () => {
    expect(await page(NO_MARKET)).toEqual({ data: [], meta: { nextCursor: null } });
    expect(await page(randomUUID(), '?kind=settlement')).toEqual({
      data: [],
      meta: { nextCursor: null },
    });
    const malformed = await get(`${marketUrl('not-a-uuid')}/work-history`, second.cookie);
    expect(malformed.statusCode).toBe(400);
    const badKind = await get(`${marketUrl(NO_MARKET)}/work-history?kind=bots`, second.cookie);
    expect(badKind.statusCode).toBe(400);
  });

  it('is every admin’s and no one else’s: a member 403, a visitor 401, no public answer with a record', async () => {
    const market = await opened();
    await pause(market.id);
    await declareConflict(market.id);
    const url = `${marketUrl(market.id)}/work-history`;
    expect((await get(url, member.cookie)).statusCode).toBe(403);
    expect((await get(url)).statusCode).toBe(401);
    expect((await page(market.id, '', third)).data.length).toBeGreaterThan(0);
    // The public detail and its records carry the pause's public note (#24) and nothing else of
    // the history: no admin's reason, no reason basis.
    for (const path of [
      `/markets/${market.id}`,
      `/markets/${market.slug}`,
      `/markets/${market.id}/related`,
      `/markets?limit=100`,
    ]) {
      for (const cookie of [undefined, member.cookie]) {
        const res = await get(path, cookie);
        expect(res.statusCode, path).toBe(200);
        expect(res.body).not.toContain(CONFLICT_REASON);
        expect(res.body).not.toContain('reasonBasis');
        expect(res.body).not.toContain('retryOutcome');
      }
    }
  });
});
