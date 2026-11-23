import { randomUUID } from 'node:crypto';
import {
  MARKET_WORK_KINDS,
  type AdminMarketWorkEntry,
  type AdminMarketWorkPage,
  type MarketWorkKind,
} from '@buddha/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readMarketWorkHistory } from './market-work.js';
import {
  adminActions,
  marketEvents,
  reconciliationHolds,
  reconciliationResults,
} from './schema/index.js';
import {
  createCategory,
  createFill,
  createMarket,
  createSettlementStep,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { clockTimestamp } from './tx-helpers.js';

const SECOND_MS = 1_000;

/** A market snapshot as `market_update` stores it (only the keys a case reads matter). */
function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'market',
    title: '시장',
    categoryId: 1,
    tags: ['AI'],
    imageUrl: null,
    status: 'open',
    lastPrice: 50,
    volumeCoin: '0',
    tradeCount: 0,
    traderCount: 0,
    statsRevision: '0',
    ...overrides,
  };
}

describe.skipIf(!hasTestDb())('시장별 작업 이력 reader (#145, ADR-0164; integration)', () => {
  let t: TestDb;
  let now: Date;
  const at = (seconds: number) => new Date(now.getTime() + seconds * SECOND_MS);

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    now = await clockTimestamp(t.db);
  });

  async function action(input: {
    adminId: string;
    type: string;
    targetType: string | null;
    targetId: string | null;
    payload?: Record<string, unknown> | null;
    createdAt: Date;
  }): Promise<string> {
    const [row] = await t.db
      .insert(adminActions)
      .values({ ...input, payload: input.payload ?? null })
      .returning({ id: adminActions.id });
    return row!.id;
  }

  async function event(input: {
    marketId: string;
    type: string;
    actorId: string | null;
    payload?: Record<string, unknown> | null;
    createdAt: Date;
  }): Promise<string> {
    const [row] = await t.db
      .insert(marketEvents)
      .values({ ...input, payload: input.payload ?? null })
      .returning({ id: marketEvents.id });
    return String(row!.id);
  }

  async function hold(marketId: string): Promise<string> {
    const [failure] = await t.db
      .insert(reconciliationResults)
      .values({
        scope: 'market',
        targetKey: `market:${marketId}`,
        marketId,
        accountId: null,
        userId: null,
        source: 'manual',
        actorId: null,
        passed: false,
        checkedAt: now,
        ledgerCursor: 0,
        findings: [{ code: 'account_balance', expected: '1', actual: '0' }],
        facts: {},
      })
      .returning();
    const [row] = await t.db
      .insert(reconciliationHolds)
      .values({
        scope: 'market',
        targetKey: `market:${marketId}`,
        marketId,
        userId: null,
        failureResultId: failure!.id,
        startedAt: now,
      })
      .returning({ id: reconciliationHolds.id });
    return row!.id;
  }

  /** Every page, `limit` at a time. */
  async function walk(
    marketId: string,
    input: { limit?: number; kind?: MarketWorkKind } = {},
  ): Promise<AdminMarketWorkEntry[]> {
    const rows: AdminMarketWorkEntry[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result: AdminMarketWorkPage = await readMarketWorkHistory(t.db, marketId, {
        ...input,
        cursor,
      });
      rows.push(...result.data);
      if (result.meta.nextCursor === null) return rows;
      cursor = result.meta.nextCursor;
    }
    throw new Error('walk: too many pages');
  }

  /**
   * Two markets with one record of every branch each, and the records the history must leave
   * out. Returns the ids the cases look for.
   */
  async function seed() {
    const admin = (await createUser(t.db, { role: 'admin', nickname: '운영자가' })).user.id;
    const other = (await createUser(t.db, { role: 'admin', nickname: '운영자나' })).user.id;
    const a = await createMarket(t.db, { title: '시장 A' });
    const b = await createMarket(t.db, { title: '시장 B' });

    const ids = {
      admin,
      other,
      a: a.id,
      b: b.id,
      // (G) the worker opened A.
      opened: await event({
        marketId: a.id,
        type: 'opened',
        actorId: null,
        payload: { openAt: at(-100).toISOString(), closeAt: at(100).toISOString(), source: 'job' },
        createdAt: at(-100),
      }),
      // (A) a tag edit while OPEN: 수정, 바뀐 항목.
      tagEdit: await action({
        adminId: admin,
        type: 'market_update',
        targetType: 'market',
        targetId: a.id,
        payload: {
          before: snapshot({ tags: ['AI'], lastPrice: 40 }),
          after: snapshot({ tags: ['AI', '반도체'], lastPrice: 61 }),
        },
        createdAt: at(-90),
      }),
      // (A) a pause and its event in one transaction: the event (with its actor) is not read.
      pause: await action({
        adminId: admin,
        type: 'market_pause',
        targetType: 'market',
        targetId: a.id,
        payload: { pauseId: randomUUID(), reason: 'basis_change', note: '기준 변경 검토' },
        createdAt: at(-80),
      }),
      pausedTwin: await event({
        marketId: a.id,
        type: 'paused',
        actorId: admin,
        payload: { reason: 'basis_change' },
        createdAt: at(-80),
      }),
      // (G) the ledger-failure pause the reconciliation wrote: '시스템'.
      ledgerPause: await event({
        marketId: a.id,
        type: 'paused',
        actorId: null,
        payload: { reason: 'ledger_failure' },
        createdAt: at(-70),
      }),
      // (A) a judgement registration: its 설명 is the reason.
      judgement: await action({
        adminId: other,
        type: 'market_judgement_request',
        targetType: 'market',
        targetId: a.id,
        payload: { approvalId: randomUUID(), result: 'YES', description: '출처 발표 확인' },
        createdAt: at(-60),
      }),
      // (B) a link made from B: A's history shows it, with B as the other end.
      linkFromB: await action({
        adminId: admin,
        type: 'market_link',
        targetType: 'market',
        targetId: b.id,
        payload: { marketId: b.id, relatedMarketId: a.id },
        createdAt: at(-55),
      }),
      // (C) a manual reconciliation run of A.
      run: await action({
        adminId: other,
        type: 'reconciliation_run',
        targetType: 'market',
        targetId: `market:${a.id}`,
        payload: { resultId: '1', passed: false },
        createdAt: at(-50),
      }),
      // (D) a recovery request of A's hold.
      recovery: await action({
        adminId: admin,
        type: 'reconciliation_recovery_request',
        targetType: 'reconciliation_hold',
        targetId: await hold(a.id),
        payload: { approvalId: randomUUID(), reason: '원인 수정 뒤 복구' },
        createdAt: at(-45),
      }),
      // (E) a classification of one of A's fills.
      classification: await action({
        adminId: other,
        type: 'fill_classification_request',
        targetType: 'fill',
        targetId: String((await createFill(t.db, { marketId: a.id, amountCoin: 50n })).id),
        payload: { approvalId: randomUUID(), action: 'exclude', reason: '자전 거래' },
        createdAt: at(-40),
      }),
      // (F) a proposal adopted with A.
      proposal: await action({
        adminId: admin,
        type: 'proposal_adopt',
        targetType: 'market_proposal',
        targetId: randomUUID(),
        payload: { from: 'reviewing', to: 'adopted', marketId: a.id, marketCreated: false },
        createdAt: at(-35),
      }),
      // (G) the payout start and completion; (A) the operator's retry between them.
      settling: await event({
        marketId: a.id,
        type: 'settling',
        actorId: null,
        createdAt: at(-30),
      }),
      retryFailed: await action({
        adminId: admin,
        type: 'market_settlement_retry',
        targetType: 'market',
        targetId: a.id,
        payload: { reason: '보류 확인', outcome: 'failed', error: 'ledger recovery pending' },
        createdAt: at(-25),
      }),
      retrySettled: await action({
        adminId: other,
        type: 'market_settlement_retry',
        targetType: 'market',
        targetId: a.id,
        payload: { reason: '복구 뒤', outcome: 'settled' },
        createdAt: at(-20),
      }),
      finalized: await event({
        marketId: a.id,
        type: 'finalized',
        actorId: null,
        createdAt: at(-20),
      }),
    };
    // (H) A's failure record (at the step's last update: now).
    await createSettlementStep(t.db, {
      marketId: a.id,
      status: 'done',
      attempts: 3,
      completedAt: at(-20),
      lastError: '55P03: ledger recovery pending',
    });

    // Never in A's history: B's own rows, a bot control and a theme link on A, a post
    // moderation, the other market's hold, fill, proposal and step, an admin-actor opened with
    // no source (the retired interim open's twin).
    await action({
      adminId: admin,
      type: 'market_pause',
      targetType: 'market',
      targetId: b.id,
      payload: { reason: 'early_result', note: 'B 중단' },
      createdAt: at(-75),
    });
    await event({ marketId: b.id, type: 'settling', actorId: null, createdAt: at(-30) });
    await action({
      adminId: admin,
      type: 'market_maker_control_request',
      targetType: 'market',
      targetId: a.id,
      payload: { reason: '봇 멈춤' },
      createdAt: at(-65),
    });
    await action({
      adminId: admin,
      type: 'theme_market_link',
      targetType: 'theme',
      targetId: randomUUID(),
      payload: { themeId: randomUUID(), marketId: a.id },
      createdAt: at(-64),
    });
    await action({
      adminId: admin,
      type: 'moderation_post_hide',
      targetType: 'moderation_action',
      targetId: randomUUID(),
      payload: { reason: 'spam' },
      createdAt: at(-63),
    });
    await action({
      adminId: admin,
      type: 'reconciliation_recovery_request',
      targetType: 'reconciliation_hold',
      targetId: await hold(b.id),
      payload: { reason: 'B 복구' },
      createdAt: at(-44),
    });
    await action({
      adminId: other,
      type: 'fill_classification_request',
      targetType: 'fill',
      targetId: String((await createFill(t.db, { marketId: b.id, amountCoin: 50n })).id),
      payload: { reason: 'B 체결' },
      createdAt: at(-39),
    });
    await action({
      adminId: admin,
      type: 'proposal_link',
      targetType: 'market_proposal',
      targetId: randomUUID(),
      payload: { marketId: b.id, marketCreated: false },
      createdAt: at(-34),
    });
    await event({
      marketId: a.id,
      type: 'opened',
      actorId: admin,
      payload: { openAt: at(-99).toISOString(), closeAt: at(100).toISOString() },
      createdAt: at(-99),
    });
    await createSettlementStep(t.db, {
      marketId: b.id,
      status: 'failed',
      attempts: 1,
      lastError: 'B 오류',
    });
    return ids;
  }

  it('collects every bound record of the market in time order, and nothing else (145-13)', async () => {
    const ids = await seed();
    const rows = await walk(ids.a);
    expect(rows.map((row) => row.id)).toEqual([
      `e:${ids.opened}`,
      `a:${ids.tagEdit}`,
      `a:${ids.pause}`,
      `e:${ids.ledgerPause}`,
      `a:${ids.judgement}`,
      `a:${ids.linkFromB}`,
      `a:${ids.run}`,
      `a:${ids.recovery}`,
      `a:${ids.classification}`,
      `a:${ids.proposal}`,
      `e:${ids.settling}`,
      `a:${ids.retryFailed}`,
      // An event and an action at one instant: the system fact first.
      `e:${ids.finalized}`,
      `a:${ids.retrySettled}`,
      's:coin',
    ]);
    expect(rows.map((row) => row.at)).toEqual([...rows.map((row) => row.at)].sort());
  });

  it('names the actor, or 시스템 (null), and the reason or its basis (145-6, 145-16)', async () => {
    const ids = await seed();
    const byId = new Map((await walk(ids.a)).map((row) => [row.id, row]));
    const get = (id: string) => byId.get(id)!;

    expect(get(`e:${ids.opened}`)).toMatchObject({
      source: 'market_event',
      type: 'opened',
      kind: 'other',
      actor: null,
      reasonBasis: 'system',
      details: { source: 'job' },
    });
    expect(get(`a:${ids.tagEdit}`)).toMatchObject({
      source: 'admin_action',
      type: 'market_update',
      kind: 'edit',
      actor: { id: ids.admin, nickname: '운영자가' },
      reason: null,
      reasonBasis: 'changed_items',
      details: {},
      changes: [{ field: 'tags', before: ['AI'], after: ['AI', '반도체'] }],
    });
    expect(get(`a:${ids.pause}`)).toMatchObject({
      kind: 'pause',
      reason: '기준 변경 검토',
      reasonBasis: 'recorded',
      details: { reason: 'basis_change' },
    });
    expect(get(`e:${ids.ledgerPause}`)).toMatchObject({ kind: 'pause', actor: null });
    expect(get(`a:${ids.judgement}`)).toMatchObject({
      kind: 'judgement',
      actor: { id: ids.other, nickname: '운영자나' },
      reason: '출처 발표 확인',
    });
    expect(get(`a:${ids.linkFromB}`)).toMatchObject({
      kind: 'other',
      reasonBasis: 'actor_time',
      relatedMarket: { id: ids.b, title: '시장 B' },
    });
    expect(get(`a:${ids.run}`)).toMatchObject({ kind: 'other', reasonBasis: 'actor_time' });
    expect(get(`a:${ids.recovery}`)).toMatchObject({
      kind: 'settlement',
      reason: '원인 수정 뒤 복구',
    });
    expect(get(`a:${ids.classification}`)).toMatchObject({ kind: 'other', reason: '자전 거래' });
    expect(get(`a:${ids.proposal}`)).toMatchObject({ kind: 'other', reasonBasis: 'actor_time' });
    expect(get(`a:${ids.retryFailed}`)).toMatchObject({
      kind: 'settlement',
      reason: '보류 확인',
      retryOutcome: 'failed',
      details: { outcome: 'failed', error: 'ledger recovery pending' },
    });
    expect(get(`a:${ids.retrySettled}`).retryOutcome).toBe('settled');
    expect(get(`e:${ids.finalized}`)).toMatchObject({ kind: 'settlement', actor: null });
    expect(get('s:coin')).toMatchObject({
      source: 'settlement_step',
      type: 'settlement_step',
      kind: 'settlement',
      actor: null,
      reasonBasis: 'system',
      details: { step: 'coin' },
      settlement: {
        stepStatus: 'done',
        settlementAttempts: 3,
        settlementLastError: '55P03: ledger recovery pending',
        completedAt: at(-20).toISOString(),
      },
    });
    for (const row of byId.values()) {
      if (row.type !== 'market_settlement_retry') expect(row.retryOutcome, row.id).toBeNull();
      if (row.type !== 'market_link') expect(row.relatedMarket, row.id).toBeNull();
    }
  });

  it('shows an opened an approval wrote at once, with its admin (no admin action of its own)', async () => {
    const admin = (await createUser(t.db, { role: 'admin', nickname: '승인자' })).user.id;
    const market = await createMarket(t.db);
    const opened = await event({
      marketId: market.id,
      type: 'opened',
      actorId: admin,
      payload: { openAt: now.toISOString(), closeAt: at(100).toISOString(), source: 'approval' },
      createdAt: at(-1),
    });
    // The approval's own event is the twin of its `market_approve` and is not read.
    await event({ marketId: market.id, type: 'approved', actorId: admin, createdAt: at(-1) });
    const rows = await walk(market.id);
    expect(rows.map((row) => row.id)).toEqual([`e:${opened}`]);
    expect(rows[0]!.actor).toEqual({ id: admin, nickname: '승인자' });
  });

  it('names a moved category by its current name, not its id (145-16 항목: 이전 → 새)', async () => {
    const admin = (await createUser(t.db, { role: 'admin', nickname: '운영자' })).user.id;
    const from = await createCategory(t.db, { nameKo: '옮기기 전 분류' });
    const to = await createCategory(t.db, { nameKo: '옮긴 분류' });
    const market = await createMarket(t.db, { categoryId: to.id });
    const moved = await action({
      adminId: admin,
      type: 'market_update',
      targetType: 'market',
      targetId: market.id,
      payload: {
        before: snapshot({ categoryId: from.id }),
        after: snapshot({ categoryId: to.id, tags: ['AI', '물가'] }),
      },
      createdAt: at(-2),
    });
    // An id no category holds keeps its id with no name.
    const gone = await action({
      adminId: admin,
      type: 'market_update',
      targetType: 'market',
      targetId: market.id,
      payload: {
        before: snapshot({ categoryId: to.id }),
        after: snapshot({ categoryId: 2_000_000_000 }),
      },
      createdAt: at(-1),
    });
    const rows = new Map((await walk(market.id)).map((row) => [row.id, row]));
    expect(rows.get(`a:${moved}`)!.changes).toEqual([
      {
        field: 'categoryId',
        before: { id: from.id, nameKo: '옮기기 전 분류' },
        after: { id: to.id, nameKo: '옮긴 분류' },
      },
      { field: 'tags', before: ['AI'], after: ['AI', '물가'] },
    ]);
    expect(rows.get(`a:${gone}`)!.changes).toEqual([
      {
        field: 'categoryId',
        before: { id: to.id, nameKo: '옮긴 분류' },
        after: { id: 2_000_000_000, nameKo: null },
      },
    ]);
  });

  it('keeps the other market apart: B sees its own rows and the link that names A (AC 6)', async () => {
    const ids = await seed();
    const a = await walk(ids.a);
    const b = await walk(ids.b);
    // `s:<step>` is unique within one market's history only; each market has its own step row.
    const shared = b.filter(
      (row) => row.source !== 'settlement_step' && a.some((entry) => entry.id === row.id),
    );
    expect(shared.map((row) => row.id)).toEqual([`a:${ids.linkFromB}`]);
    expect(b.find((row) => row.id === 's:coin')!.settlement?.settlementLastError).toBe('B 오류');
    expect(a.find((row) => row.id === 's:coin')!.settlement?.settlementLastError).not.toBe(
      'B 오류',
    );
    expect(b.find((row) => row.id === `a:${ids.linkFromB}`)!.relatedMarket).toEqual({
      id: ids.a,
      title: '시장 A',
    });
    expect(b.map((row) => row.type).sort()).toEqual(
      [
        'fill_classification_request',
        'market_link',
        'market_pause',
        'proposal_link',
        'reconciliation_recovery_request',
        'settlement_step',
        'settling',
      ].sort(),
    );
  });

  it('filters by kind, the kinds together making the whole history (145-5)', async () => {
    const ids = await seed();
    const all = await walk(ids.a);
    const byKind = await Promise.all(
      MARKET_WORK_KINDS.map(async (kind) => ({ kind, rows: await walk(ids.a, { kind }) })),
    );
    for (const { kind, rows } of byKind) {
      expect(rows.length, kind).toBeGreaterThan(0);
      expect(
        rows.every((row) => row.kind === kind),
        kind,
      ).toBe(true);
    }
    expect(byKind.flatMap(({ rows }) => rows.map((row) => row.id)).sort()).toEqual(
      all.map((row) => row.id).sort(),
    );
    expect((await walk(ids.a, { kind: 'settlement' })).map((row) => row.id)).toEqual([
      `a:${ids.recovery}`,
      `e:${ids.settling}`,
      `a:${ids.retryFailed}`,
      `e:${ids.finalized}`,
      `a:${ids.retrySettled}`,
      's:coin',
    ]);
  });

  it('pages without repeats or gaps at every size, across a tie of an event and an action', async () => {
    const ids = await seed();
    const all = (await walk(ids.a)).map((row) => row.id);
    const settlement = (await walk(ids.a, { kind: 'settlement' })).map((row) => row.id);
    for (const limit of [1, 2, 3, 4]) {
      expect(
        (await walk(ids.a, { limit })).map((row) => row.id),
        String(limit),
      ).toEqual(all);
      expect(
        (await walk(ids.a, { limit, kind: 'settlement' })).map((row) => row.id),
        `${String(limit)} settlement`,
      ).toEqual(settlement);
    }
  });

  it('answers an empty page for an unknown market or an id that is no uuid', async () => {
    await seed();
    expect(await readMarketWorkHistory(t.db, randomUUID())).toEqual({
      data: [],
      meta: { nextCursor: null },
    });
    expect(await readMarketWorkHistory(t.db, 'not-a-uuid')).toEqual({
      data: [],
      meta: { nextCursor: null },
    });
  });

  it('reads a malformed cursor as the first page', async () => {
    const ids = await seed();
    const first = await readMarketWorkHistory(t.db, ids.a, { limit: 2 });
    expect(await readMarketWorkHistory(t.db, ids.a, { limit: 2, cursor: 'x_y' })).toEqual(first);
  });
});
