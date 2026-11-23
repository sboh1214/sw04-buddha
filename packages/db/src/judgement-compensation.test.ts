import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import {
  compareAccountIdsBytewise,
  judgementCompensationOwed,
  judgementCompensationRequestPayload,
  MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND,
  MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND,
  publicJudgementCompensationOf,
  settlementPayoutPerContract,
  type MarketJudgementCompensationRequestPayload,
  type MarketJudgementIncidentRequestPayload,
  type MarketResult,
} from '@buddha/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  JudgementCompensationBlockedError,
  judgementCompensationNotificationInputs,
  judgementCompensationPayloadOf,
  judgementCompensationTargets,
  payJudgementCompensation,
  prepareJudgementCompensationPayout,
  readJudgementCompensationFacts,
  readJudgementCompensationRequests,
  readJudgementCompensationRows,
} from './judgement-compensation.js';
import { findLedgerAccount, LedgerEntryError, ledgerKeys, recordLedgerEntry } from './ledger.js';
import {
  readMarketJudgementIncident,
  recordMarketJudgementIncident,
  type MarketJudgementIncidentRow,
} from './market-judgement-incident.js';
import { settleMarketPositions } from './market-settlement.js';
import { createNotifications } from './notifications.js';
import {
  runAccountReconciliation,
  runMarketReconciliation,
  runSupplyReconciliation,
  selectDueMarketReconciliationIds,
} from './reconciliation-audit.js';
import {
  approvalRequests,
  balances,
  judgementCompensations,
  ledgerEntries,
  marketJudgements,
  markets,
  notifications,
  positions,
  positionSettlements,
} from './schema/index.js';
import {
  closeAccount,
  createApprovalRequest,
  createMarket,
  createMarketMakerAccount,
  createModerationAction,
  createProvisionalMarket,
  createUser,
  resolveMarketNow,
} from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import {
  balanceOf,
  fundMarketMakerFunds,
  ledgerSupply,
  mintTestPairs,
  withLedgerGuardsOff,
} from './test/ledger.js';
import { waitForLockWaiter } from './test/wait.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

/** Postgres SQLSTATE, wrapped (drizzle) or bare. */
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

/** The constraint a refusal names. */
function sqlConstraint(error: unknown): string | undefined {
  const e = error as { constraint?: string; cause?: { constraint?: string } } | null;
  return e?.cause?.constraint ?? e?.constraint;
}

/** The Postgres message (a trigger's RAISE), wrapped or bare. */
function errorMessage(error: unknown): string {
  const e = error as { message?: string; cause?: { message?: string } } | null;
  return e?.cause?.message ?? e?.message ?? '';
}

/** Rejects with `name`: a trigger raised under its own name (23000), a CHECK or a UNIQUE. */
const refusedBy = (name: string, message?: RegExp) => (error: unknown) =>
  ['23000', '23514', '23505'].includes(sqlState(error) ?? '') &&
  sqlConstraint(error) === name &&
  (message === undefined || message.test(errorMessage(error)));

const LINK = 'https://www.bok.or.kr/press/1';
const USER_REASON = '판정 기준 시각의 발표를 잘못 읽어 결과를 바로잡았습니다.';

/** The six paid → corrected pairs (144-1's worked table). */
const PAIRS: readonly [MarketResult, MarketResult][] = [
  ['YES', 'NO'],
  ['YES', 'VOID'],
  ['NO', 'YES'],
  ['NO', 'VOID'],
  ['VOID', 'YES'],
  ['VOID', 'NO'],
];

/**
 * The 18 worked cases (ADR-0166; brief §4): what each pair owes a YES 2 holder (a), a NO 3 holder
 * (b) and a YES 2 + NO 1 holder (c), written out by hand from the per-contract deltas — never from
 * the code under test.
 */
const WORKED: Readonly<Record<string, { a: bigint; b: bigint; c: bigint }>> = {
  'YES→NO': { a: -200n, b: 300n, c: -100n },
  'YES→VOID': { a: -100n, b: 150n, c: -50n },
  'NO→YES': { a: 200n, b: -300n, c: 100n },
  'NO→VOID': { a: 100n, b: -150n, c: 50n },
  'VOID→YES': { a: 100n, b: -150n, c: 50n },
  'VOID→NO': { a: -100n, b: 150n, c: -50n },
};

/**
 * 판정 오류 보상 (#144 part 2, ADR-0166; 144-1, 144-2, 144-4, 144-7, 144-12, 144-16, 144-18):
 * migration 0081's ledger type, table and guards, and @buddha/db's amounts, approval checks,
 * payout writer, notice inputs and readers, on the docker test profile.
 */
describe.skipIf(!hasTestDb())('the 판정 오류 보상 (#144, docker test profile)', () => {
  let t: TestDb;
  let migrate: Client;

  beforeAll(async () => {
    t = await connectTestDb();
    migrate = new Client({ connectionString: testDbUrls()!.migrateUrl });
    await migrate.connect();
  });
  afterAll(async () => {
    await migrate?.end();
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const admin = async () => (await createUser(t.db, { role: 'admin' })).user.id;
  const member = async (id?: string) =>
    (await createUser(t.db, { balanceCoin: 1_000n, ...(id === undefined ? {} : { id }) })).user.id;

  interface Holders {
    /** YES 2. */
    a: string;
    /** NO 3. */
    b: string;
    /** YES 2 + NO 1. */
    c: string;
    /** NO 1 (c's counterparty). */
    d: string;
    /** YES 1 (c's NO counterparty). */
    e: string;
  }

  interface SettledMarket {
    marketId: string;
    title: string;
    paidRegistrant: string;
    incident: MarketJudgementIncidentRow;
  }

  /**
   * A market traded the real way (pair mints), judged `paid` by `paidRegistrant` and approved by
   * another admin, confirmed, paid out by the settlement core and SETTLED — then a 판정 오류 사건
   * to `corrected` registered by one admin and confirmed by another (neither the paid registrant,
   * 144-4), as PR 1's 오류 확인 writes it.
   */
  async function settledMarket(
    paid: MarketResult,
    corrected: MarketResult,
    mint: (marketId: string) => Promise<void>,
  ): Promise<SettledMarket> {
    const paidRegistrant = await admin();
    const market = await createMarket(t.db);
    await mint(market.id);
    await t.db.update(markets).set({ status: 'closed' }).where(eq(markets.id, market.id));
    await createProvisionalMarket(t.db, {
      marketId: market.id,
      result: paid,
      registeredBy: paidRegistrant,
    });
    await resolveMarketNow(t.db, market.id);
    await t.db.update(markets).set({ status: 'settling' }).where(eq(markets.id, market.id));
    await t.db.transaction((tx) => settleMarketPositions(tx, market.id));
    await t.db.update(markets).set({ status: 'settled' }).where(eq(markets.id, market.id));
    const registrant = await admin();
    const confirmer = await admin();
    const payload: MarketJudgementIncidentRequestPayload = {
      noConflictConfirmed: true,
      judgementVersion: 1,
      originalResult: paid,
      correctedResult: corrected,
      evidence: { links: [LINK], collectedAt: '2026-11-20T00:00:00.000Z' },
    };
    const request = await createApprovalRequest(t.db, {
      kind: MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND,
      targetType: 'market',
      targetId: market.id,
      payload,
      requestedBy: registrant,
      reason: '발표 원문의 수치를 잘못 읽었다.',
    });
    const incident = await t.db.transaction(async (tx) => {
      await lockMarket(tx, market.id);
      const at = await clockTimestamp(tx);
      const [approved] = await tx
        .update(approvalRequests)
        .set({
          status: 'approved',
          decidedBy: confirmer,
          decisionReason: '원문을 확인했다.',
          decidedAt: at,
        })
        .where(eq(approvalRequests.id, request.id))
        .returning();
      return recordMarketJudgementIncident(tx, {
        marketId: market.id,
        request: approved!,
        paidRegisteredBy: paidRegistrant,
      });
    });
    return { marketId: market.id, title: market.title, paidRegistrant, incident };
  }

  /** The three worked holdings (and their two counterparties) on `marketId`. */
  async function mintWorked(marketId: string, ids: Partial<Holders> = {}): Promise<Holders> {
    const holders: Holders = {
      a: await member(ids.a),
      b: await member(ids.b),
      c: await member(ids.c),
      d: await member(ids.d),
      e: await member(ids.e),
    };
    const pair = (yes: string, no: string, qty: number) =>
      mintTestPairs(t.db, { marketId, yesHolderId: yes, noHolderId: no, qty });
    await pair(holders.a, holders.b, 2);
    await pair(holders.c, holders.b, 1);
    await pair(holders.c, holders.d, 1);
    await pair(holders.e, holders.c, 1);
    return holders;
  }

  /** A settled, corrected market with the worked holdings. */
  async function workedMarket(paid: MarketResult, corrected: MarketResult, ids?: Partial<Holders>) {
    let holders!: Holders;
    const settled = await settledMarket(paid, corrected, async (marketId) => {
      holders = await mintWorked(marketId, ids);
    });
    return { ...settled, holders };
  }

  /** An account's settlement records of a market, as `judgementCompensationOwed` takes them. */
  async function recordsOf(marketId: string, userId: string) {
    const rows = await t.db
      .select()
      .from(positionSettlements)
      .where(
        and(eq(positionSettlements.marketId, marketId), eq(positionSettlements.userId, userId)),
      );
    return rows.map((row) => ({ outcome: row.outcome, qty: row.qty, payoutCoin: row.payoutCoin }));
  }

  /** `judgement_compensation_owed` (migration 0081) for one account. */
  async function owedInSql(marketId: string, corrected: MarketResult, userId: string) {
    const { rows } = await t.db.execute<{ owed: string }>(
      sql`SELECT judgement_compensation_owed(${marketId}::uuid, ${corrected}::market_result,
        ${userId})::text AS owed`,
    );
    return BigInt(rows[0]!.owed);
  }

  /** A waiting compensation request with the server's list (or `payload`), as the API asks it. */
  async function requestCompensation(
    market: SettledMarket,
    by: string,
    payload?: MarketJudgementCompensationRequestPayload,
  ) {
    const owed = await judgementCompensationTargets(
      t.db,
      market.marketId,
      market.incident.correctedResult,
    );
    return createApprovalRequest(t.db, {
      kind: MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND,
      targetType: 'market',
      targetId: market.marketId,
      payload:
        payload ??
        judgementCompensationRequestPayload({
          incidentId: market.incident.id,
          correctedResult: market.incident.correctedResult,
          owed,
          userReason: USER_REASON,
        }),
      requestedBy: by,
      reason: '정정된 결과에 따라 보상한다.',
    });
  }

  /**
   * 보상 승인 as the API's transaction runs it (ADR-0166 §6.2): the market lock and row, the
   * request, the checks under every lock, the decision at the clock after them, the payout at that
   * instant, and the notices last.
   */
  const approve = (market: SettledMarket, requestId: string, by: string) =>
    t.db.transaction(async (tx) => {
      await lockMarket(tx, market.marketId);
      const [row] = await tx
        .select()
        .from(markets)
        .where(eq(markets.id, market.marketId))
        .for('update');
      const [request] = await tx
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, requestId))
        .for('update');
      const incident = (await readMarketJudgementIncident(tx, market.marketId))!;
      const check = await prepareJudgementCompensationPayout(tx, {
        marketId: market.marketId,
        incident,
        payload: judgementCompensationPayloadOf(request!),
      });
      if (check.outcome !== 'ready') return check;
      const at = await clockTimestamp(tx);
      const [approved] = await tx
        .update(approvalRequests)
        .set({
          status: 'approved',
          decidedBy: by,
          decisionReason: '목록을 확인했다.',
          decidedAt: at,
        })
        .where(eq(approvalRequests.id, requestId))
        .returning();
      const paid = await payJudgementCompensation(tx, {
        marketId: market.marketId,
        marketTitle: row!.title,
        incident,
        request: approved!,
        recipients: check.recipients,
      });
      const notices = await createNotifications(
        tx,
        judgementCompensationNotificationInputs(paid.paid, row!, {
          originalResult: incident.originalResult,
          correctedResult: incident.correctedResult,
          eventKey: `admin_action:${randomUUID()}`,
          occurredAt: paid.at,
        }),
      );
      return { outcome: 'paid' as const, ...paid, notices };
    });

  /** What #144 never writes (AC 2): the market row, its judgements, records, holdings, payouts. */
  async function paidBooks(marketId: string) {
    return {
      market: (await t.db.select().from(markets).where(eq(markets.id, marketId)))[0],
      judgements: await t.db
        .select()
        .from(marketJudgements)
        .where(eq(marketJudgements.marketId, marketId)),
      records: await t.db
        .select()
        .from(positionSettlements)
        .where(eq(positionSettlements.marketId, marketId))
        .orderBy(asc(positionSettlements.userId), asc(positionSettlements.outcome)),
      holdings: await t.db
        .select()
        .from(positions)
        .where(eq(positions.marketId, marketId))
        .orderBy(asc(positions.userId), asc(positions.outcome)),
      payouts: await t.db
        .select()
        .from(ledgerEntries)
        .where(
          and(eq(ledgerEntries.marketId, marketId), eq(ledgerEntries.type, 'SETTLEMENT_PAYOUT')),
        )
        .orderBy(asc(ledgerEntries.id)),
    };
  }

  const negativeBalances = async () =>
    (
      await t.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM balances
          WHERE available_coin < 0 OR locked_coin < 0 OR ledger_coin < 0`,
      )
    ).rows[0]!.n;

  // ---- the amounts (144-1) ------------------------------------------------------------

  describe('the amounts (144-1)', () => {
    it.each(PAIRS)(
      'owes %s → %s exactly the worked cases, in SQL and in the shared twin alike',
      async (paid, corrected) => {
        const market = await workedMarket(paid, corrected);
        const worked = WORKED[`${paid}→${corrected}`]!;
        const { a, b, c, d, e } = market.holders;
        for (const [who, expected] of [
          [a, worked.a],
          [b, worked.b],
          [c, worked.c],
        ] as const) {
          expect(await owedInSql(market.marketId, corrected, who), who).toBe(expected);
        }
        // Every account, the counterparties too: the database's sum is the shared function's.
        const owed = new Map<string, bigint>();
        for (const who of [a, b, c, d, e]) {
          const twin = judgementCompensationOwed(await recordsOf(market.marketId, who), corrected);
          expect(await owedInSql(market.marketId, corrected, who), who).toBe(twin);
          owed.set(who, twin);
        }
        // The live list: the positive ones, bytewise, none closed or blocked; a holder the paid
        // result over-paid, or one even, is no target (nothing taken back, N03 §7).
        const expected = [...owed]
          .filter(([, amount]) => amount > 0n)
          .map(([userId, amountCoin]) => ({ userId, amountCoin, closed: false, blocked: false }))
          .sort((x, y) => compareAccountIdsBytewise(x.userId, y.userId));
        expect(await judgementCompensationTargets(t.db, market.marketId, corrected)).toEqual(
          expected,
        );
        expect(expected.length).toBeGreaterThan(0);
      },
    );

    it.each(['YES', 'NO', 'VOID'] as const)(
      'owes every account 0 for the paid result %s itself: the function’s CASE is the payout CHECK’s',
      async (paid) => {
        // A correction to the paid result owes Σ qty × unit − Σ payout = 0 for every account
        // exactly when the function's per-contract unit is the one
        // position_settlements_payout_check (0064) stored, for each (result, outcome) — the worked
        // holdings hold both outcomes.
        const other: MarketResult = paid === 'YES' ? 'NO' : 'YES';
        const market = await workedMarket(paid, other);
        const { a, b, c, d, e } = market.holders;
        for (const who of [a, b, c, d, e]) {
          expect(await owedInSql(market.marketId, paid, who), who).toBe(0n);
          for (const record of await t.db
            .select()
            .from(positionSettlements)
            .where(
              and(
                eq(positionSettlements.marketId, market.marketId),
                eq(positionSettlements.userId, who),
              ),
            )) {
            expect(record.payoutPerContractCoin).toBe(
              settlementPayoutPerContract(paid, record.outcome),
            );
          }
        }
        // And an account with no record (sold out before the payout) is owed 0, not NULL.
        expect(await owedInSql(market.marketId, other, await member())).toBe(0n);
      },
    );

    it('lists people only, in bytewise order, with each one’s closure and ledger state', async () => {
      // Ids that sort differently under the database's collation (en_US: 'a…' before 'B…') and
      // byte by byte ('B…' first), as the frozen list, the stale check and the lock order need.
      const suffix = randomUUID();
      const ids = {
        a: `x-${suffix}`,
        b: `B-${suffix}`,
        c: `y-${suffix}`,
        d: `a-${suffix}`,
        e: `Z-${suffix}`,
      };
      let holders!: Holders;
      let bot!: string;
      const market = await settledMarket('YES', 'NO', async (marketId) => {
        holders = await mintWorked(marketId, ids);
        // The 운영 마켓메이커 holds NO 2 too, whom NO would pay (its funds, ADR-0107 결정 2 #73
        // 11항): never a target — it has no user ledger account (T16).
        bot = await createMarketMakerAccount(t.db);
        await fundMarketMakerFunds(t.db, marketId, 1_000n);
        await mintTestPairs(t.db, { marketId, yesHolderId: holders.a, noHolderId: bot, qty: 2 });
      });
      expect(await owedInSql(market.marketId, 'NO', bot)).toBe(200n);
      const list = await judgementCompensationTargets(t.db, market.marketId, 'NO');
      // a now holds YES 4 (over-paid), b NO 3 (+300), c YES 2 + NO 1 (−100), d NO 1 (+100).
      expect(list).toEqual([
        { userId: ids.b, amountCoin: 300n, closed: false, blocked: false },
        { userId: ids.d, amountCoin: 100n, closed: false, blocked: false },
      ]);
      // A linguistic collation puts them the other way round (why COLLATE "C" is spelt: a
      // database whose default collation is one would list them so).
      const { rows: icu } = await t.db.execute<{ id: string }>(
        sql`SELECT collname AS id FROM pg_collation WHERE collname = 'und-x-icu'`,
      );
      if (icu.length > 0) {
        const { rows } = await t.db.execute<{ id: string }>(
          sql`SELECT v.id FROM (VALUES (${ids.b}), (${ids.d})) AS v(id)
            ORDER BY v.id COLLATE "und-x-icu"`,
        );
        expect(rows.map((row) => row.id)).toEqual([ids.d, ids.b]);
      }
      // Closed, and blocked: the live list says so for the admin preview.
      await closeAccount(t.db, holders.d);
      const account = (await findLedgerAccount(t.db, { kind: 'user', userId: holders.b }))!;
      await withLedgerGuardsOff((client) =>
        client.query(
          'UPDATE balances SET available_coin = available_coin - 7, ledger_coin = ledger_coin - 7 WHERE account_id = $1',
          [account.id],
        ),
      );
      expect(await judgementCompensationTargets(t.db, market.marketId, 'NO')).toEqual([
        { userId: ids.b, amountCoin: 300n, closed: false, blocked: true },
        { userId: ids.d, amountCoin: 100n, closed: true, blocked: false },
      ]);
    });
  });

  // ---- the payout (144-2, 144-7) -------------------------------------------------------

  describe('the approval and its payout (144-2, 144-4, 144-7)', () => {
    it('pays every listed account once at the decision’s instant, moving nothing else (AC 2, 3, 6, 7)', async () => {
      const market = await workedMarket('VOID', 'YES');
      const { a, b, c, d, e } = market.holders;
      // VOID → YES: a (YES 2) +100, c (YES 2 + NO 1) +50, e (YES 1) +50; b and d were over-paid.
      const balancesBefore = new Map(
        await Promise.all(
          [a, b, c, d, e].map(async (who) => [who, (await balanceOf(t.db, who))!] as const),
        ),
      );
      const supplyBefore = await ledgerSupply(t.db);
      const audited = await t.db.transaction((tx) =>
        runMarketReconciliation(tx, market.marketId, { source: 'manual' }),
      );
      expect(audited.result.passed).toBe(true);
      const before = await paidBooks(market.marketId);

      // The paid version's registrant may ask (144-4 "보상 요청은 할 수 있다").
      const request = await requestCompensation(market, market.paidRegistrant);
      const payload = judgementCompensationPayloadOf(request);
      expect(payload).toMatchObject({ accountCount: 3, totalCoin: '200' });
      expect(
        publicJudgementCompensationOf(await readJudgementCompensationFacts(t.db, market.incident)),
      ).toEqual({ status: 'pending', accountCount: 3, paidCount: null, totalCoin: null });

      const approver = await admin();
      const done = await approve(market, request.id, approver);
      if (done.outcome !== 'paid') throw new Error(`refused: ${done.reason}`);
      const [decided] = await t.db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, request.id));
      expect(done.at).toEqual(decided!.decidedAt);
      expect(done.paidCoin).toBe(200n);
      expect(done.closed).toEqual([]);
      const owedTo = new Map([
        [a, 100n],
        [c, 50n],
        [e, 50n],
      ]);
      expect(done.paid.map((p) => p.userId)).toEqual([a, c, e].sort(compareAccountIdsBytewise));
      for (const paid of done.paid) {
        expect(paid.amountCoin).toBe(owedTo.get(paid.userId));
        expect(paid.entry).toMatchObject({
          type: 'JUDGEMENT_COMPENSATION',
          fromAccountId: null,
          marketId: market.marketId,
          refType: 'judgement_compensation',
          refId: paid.row.id,
          idempotencyKey: ledgerKeys.judgementCompensation(request.id, paid.userId),
          amountCoin: paid.amountCoin,
          createdAt: done.at,
        });
        expect(paid.row).toMatchObject({
          incidentId: market.incident.id,
          marketId: market.marketId,
          approvalId: request.id,
          outcome: 'paid',
          ledgerEntryId: paid.entry.id,
          userReason: USER_REASON,
          requestedBy: market.paidRegistrant,
          approvedBy: approver,
          createdAt: done.at,
        });
      }
      // Each payee is up by its amount, everyone else exactly where they were (no claw-back).
      for (const who of [a, b, c, d, e]) {
        const now = (await balanceOf(t.db, who))!;
        const then = balancesBefore.get(who)!;
        const owed = owedTo.get(who) ?? 0n;
        expect(now.availableCoin, who).toBe(then.availableCoin + owed);
        expect(now.ledgerCoin, who).toBe(then.ledgerCoin + owed);
      }
      expect(await negativeBalances()).toBe(0);
      // The market row, its judgements, the settlement records, holdings and payouts: as paid.
      expect(await paidBooks(market.marketId)).toEqual(before);
      // A mint: the supply grew by the total, and still reconciles.
      const supplyAfter = await ledgerSupply(t.db);
      expect(supplyAfter.mintedCoin).toBe(supplyBefore.mintedCoin + 200n);
      expect(supplyAfter.heldCoin).toBe(supplyAfter.mintedCoin - supplyAfter.burnedCoin);
      // #93 (AC 7): the supply, every holder's account and the market (whose ledger cursor the
      // entries moved, so it is due again) all pass.
      await t.db.transaction(async (tx) => {
        expect((await runSupplyReconciliation(tx, { source: 'manual' })).result.passed).toBe(true);
        for (const who of [a, b, c, d, e]) {
          const run = await runAccountReconciliation(tx, { userId: who }, { source: 'manual' });
          expect(run.result.passed, who).toBe(true);
        }
      });
      expect(await selectDueMarketReconciliationIds(t.db)).toContain(market.marketId);
      const again = await t.db.transaction((tx) =>
        runMarketReconciliation(tx, market.marketId, { source: 'manual' }),
      );
      expect(again.result.passed).toBe(true);
      expect(again.hold).toBeNull();
      // The notices: one per payee (52-20, 144-18), a 시장 one to the market.
      expect(done.notices.map((n) => [n.kind, n.userId])).toEqual(
        done.paid.map((p) => ['created', p.userId]),
      );
      const written = await t.db
        .select()
        .from(notifications)
        .where(eq(notifications.type, 'market_judgement_compensated'));
      expect(written).toHaveLength(3);
      for (const notice of written) {
        expect(notice).toMatchObject({
          type: 'market_judgement_compensated',
          category: 'market',
          params: {
            marketTitle: market.title,
            originalResult: 'VOID',
            correctedResult: 'YES',
            compensationCoin: String(owedTo.get(notice.userId)),
          },
        });
      }
      // The readers: the rows, the requests, the public facts.
      expect((await readJudgementCompensationRows(t.db, request.id)).map((r) => r.id)).toEqual(
        done.paid.map((p) => p.row.id),
      );
      expect(await readJudgementCompensationRequests(t.db, market.marketId)).toEqual([
        expect.objectContaining({ id: request.id, status: 'approved', decidedBy: approver }),
      ]);
      expect(
        publicJudgementCompensationOf(await readJudgementCompensationFacts(t.db, market.incident)),
      ).toEqual({ status: 'paid', accountCount: 3, paidCount: 3, totalCoin: '200' });
    });

    it('records a closed account ‘탈퇴로 지급 못 함’, pays a restricted and an account-held one, and tells only the paid', async () => {
      const market = await workedMarket('YES', 'NO');
      const { b, d } = market.holders;
      // YES → NO: b (NO 3) +300 and d (NO 1) +100. d closes after the payout; b is restricted
      // (144-7 "제한과 상관없이") and held by #93 for an account mismatch (#73 10항: its payouts
      // still come; the gap rides along).
      await closeAccount(t.db, d);
      await createModerationAction(t.db, {
        userId: b,
        createdBy: await admin(),
        approvedBy: await admin(),
        type: 'account_restriction',
        reason: 'spam',
      });
      await withLedgerGuardsOff((client) =>
        client.query('UPDATE balances SET available_coin = available_coin + 3 WHERE user_id = $1', [
          b,
        ]),
      );
      const held = await t.db.transaction((tx) =>
        runAccountReconciliation(tx, { userId: b }, { source: 'manual' }),
      );
      expect(held.hold).not.toBeNull();
      const request = await requestCompensation(market, await admin());
      expect(judgementCompensationPayloadOf(request)).toMatchObject({
        accountCount: 2,
        totalCoin: '400',
      });
      const bBefore = (await balanceOf(t.db, b))!;
      const done = await approve(market, request.id, await admin());
      if (done.outcome !== 'paid') throw new Error(`refused: ${done.reason}`);
      expect(done.paid.map((p) => [p.userId, p.amountCoin])).toEqual([[b, 300n]]);
      expect(done.closed).toEqual([
        expect.objectContaining({
          userId: d,
          amountCoin: 100n,
          outcome: 'closed',
          ledgerEntryId: null,
        }),
      ]);
      expect((await balanceOf(t.db, b))!.availableCoin).toBe(bBefore.availableCoin + 300n);
      expect(
        await t.db
          .select()
          .from(ledgerEntries)
          .where(eq(ledgerEntries.type, 'JUDGEMENT_COMPENSATION')),
      ).toHaveLength(1);
      expect(
        (
          await t.db
            .select()
            .from(notifications)
            .where(eq(notifications.type, 'market_judgement_compensated'))
        ).map((n) => n.userId),
      ).toEqual([b]);
      // 144-15: '대상 계정 2개 중 1개 지급 · 총 300 Coin'.
      expect(
        publicJudgementCompensationOf(await readJudgementCompensationFacts(t.db, market.incident)),
      ).toEqual({ status: 'paid', accountCount: 2, paidCount: 1, totalCoin: '300' });
    });

    it('records every target closed and pays nothing when all have closed', async () => {
      const market = await workedMarket('YES', 'NO');
      await closeAccount(t.db, market.holders.b);
      await closeAccount(t.db, market.holders.d);
      const request = await requestCompensation(market, await admin());
      const supply = await ledgerSupply(t.db);
      const done = await approve(market, request.id, await admin());
      if (done.outcome !== 'paid') throw new Error(`refused: ${done.reason}`);
      expect(done.paid).toEqual([]);
      expect(done.paidCoin).toBe(0n);
      expect(done.closed.map((row) => row.userId)).toEqual(
        [market.holders.b, market.holders.d].sort(compareAccountIdsBytewise),
      );
      expect(done.notices).toEqual([]);
      expect(await ledgerSupply(t.db)).toEqual(supply);
      expect(
        publicJudgementCompensationOf(await readJudgementCompensationFacts(t.db, market.incident)),
      ).toEqual({ status: 'paid', accountCount: 2, paidCount: 0, totalCoin: '0' });
    });

    it('shows 보상 준비 중 before a request and 보상 대상 없음 when no one is owed (144-15)', async () => {
      const market = await workedMarket('YES', 'NO');
      expect(
        publicJudgementCompensationOf(await readJudgementCompensationFacts(t.db, market.incident)),
      ).toEqual({ status: 'preparing', accountCount: null, paidCount: null, totalCoin: null });
      // A market where the correction owes no one: one YES·NO pair per account, YES → VOID
      // (each held both sides: 100 paid, 50 + 50 owed).
      let holder!: string;
      const even = await settledMarket('YES', 'VOID', async (marketId) => {
        holder = await member();
        const other = await member();
        await mintTestPairs(t.db, { marketId, yesHolderId: holder, noHolderId: other, qty: 1 });
        await mintTestPairs(t.db, { marketId, yesHolderId: other, noHolderId: holder, qty: 1 });
      });
      expect(await owedInSql(even.marketId, 'VOID', holder)).toBe(0n);
      expect(await judgementCompensationTargets(t.db, even.marketId, 'VOID')).toEqual([]);
      expect(
        publicJudgementCompensationOf(await readJudgementCompensationFacts(t.db, even.incident)),
      ).toEqual({ status: 'none', accountCount: null, paidCount: null, totalCoin: null });
    });

    it('refuses the whole approval while an open target’s ledger copy left its ledger (144-16)', async () => {
      const market = await workedMarket('YES', 'NO');
      const { b, d } = market.holders;
      const request = await requestCompensation(market, await admin());
      const account = (await findLedgerAccount(t.db, { kind: 'user', userId: d }))!;
      await withLedgerGuardsOff((client) =>
        client.query(
          'UPDATE balances SET available_coin = available_coin - 5, ledger_coin = ledger_coin - 5 WHERE account_id = $1',
          [account.id],
        ),
      );
      const bBefore = await balanceOf(t.db, b);
      const approver = await admin();
      // The count only — never which account.
      expect(await approve(market, request.id, approver)).toEqual({
        outcome: 'refused',
        reason: 'blocked',
        blockedCount: 1,
      });
      const [still] = await t.db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, request.id));
      expect(still!.status).toBe('pending');
      expect(await t.db.select().from(judgementCompensations)).toEqual([]);
      expect(await balanceOf(t.db, b)).toEqual(bBefore);
      // Why the check exists: the payout itself refuses it typed, and the ledger would refuse the
      // entry as an untyped integrity error inside its INSERT check (migration 0060).
      await expect(
        t.db.transaction(async (tx) => {
          await lockMarket(tx, market.marketId);
          const incident = (await readMarketJudgementIncident(tx, market.marketId))!;
          const at = await clockTimestamp(tx);
          const [approved] = await tx
            .update(approvalRequests)
            .set({ status: 'approved', decidedBy: approver, decisionReason: '확인', decidedAt: at })
            .where(eq(approvalRequests.id, request.id))
            .returning();
          return payJudgementCompensation(tx, {
            marketId: market.marketId,
            marketTitle: market.title,
            incident,
            request: approved!,
            recipients: {
              open: [
                {
                  userId: b,
                  amountCoin: 300n,
                  accountId: (await findLedgerAccount(tx, { kind: 'user', userId: b }))!.id,
                },
                { userId: d, amountCoin: 100n, accountId: account.id },
              ].sort((x, y) => compareAccountIdsBytewise(x.userId, y.userId)),
              closed: [],
            },
          });
        }),
      ).rejects.toBeInstanceOf(JudgementCompensationBlockedError);
      await expect(
        t.db.transaction((tx) =>
          recordLedgerEntry(tx, {
            type: 'JUDGEMENT_COMPENSATION',
            amountCoin: 100n,
            from: null,
            to: { kind: 'user', userId: d },
            marketId: market.marketId,
            refType: 'judgement_compensation',
            refId: randomUUID(),
            idempotencyKey: randomUUID(),
          }),
        ),
      ).rejects.toSatisfy(refusedBy('ledger_entries_check', /does not continue/));
    });

    it('refuses while the market is ledger-held (#93), and a list that is no longer the live one', async () => {
      const market = await workedMarket('YES', 'NO');
      const request = await requestCompensation(market, await admin());
      // A frozen list the settlement records do not support: stale.
      const tampered = await requestCompensation(market, await admin(), {
        ...judgementCompensationPayloadOf(request),
        recipients: judgementCompensationPayloadOf(request).recipients.map((r, index) =>
          index === 0 ? { ...r, amountCoin: String(BigInt(r.amountCoin) + 1n) } : r,
        ),
        totalCoin: String(BigInt(judgementCompensationPayloadOf(request).totalCoin) + 1n),
      });
      expect(await approve(market, tampered.id, await admin())).toEqual({
        outcome: 'refused',
        reason: 'stale',
      });
      // The collateral off its books: the market reconciliation holds the market.
      await withLedgerGuardsOff((client) =>
        client.query(
          "UPDATE balances SET available_coin = available_coin + 10 WHERE account_id = (SELECT id FROM ledger_accounts WHERE kind = 'market_collateral' AND market_id = $1)",
          [market.marketId],
        ),
      );
      const audited = await t.db.transaction((tx) =>
        runMarketReconciliation(tx, market.marketId, { source: 'manual' }),
      );
      expect(audited.hold).not.toBeNull();
      expect(await approve(market, request.id, await admin())).toEqual({
        outcome: 'refused',
        reason: 'held',
      });
      // And whoever writes, the row is refused while held.
      await expect(rawPayout(market, request.id, await admin())).rejects.toSatisfy(
        refusedBy('judgement_compensations_check', /ledger-held/),
      );
      expect(await t.db.select().from(judgementCompensations)).toEqual([]);
    });

    it('pays once: a second approval of the incident, a replayed payout, a second request all fail', async () => {
      const market = await workedMarket('YES', 'NO');
      const first = await requestCompensation(market, await admin());
      const second = await requestCompensation(market, await admin());
      const approver = await admin();
      const done = await approve(market, first.id, approver);
      expect(done.outcome).toBe('paid');
      const rows = await t.db.select().from(judgementCompensations);
      // Another request of the same incident cannot pay an account twice (UNIQUE incident, user).
      await expect(approve(market, second.id, await admin())).rejects.toSatisfy(
        refusedBy('judgement_compensations_incident_id_user_id_unique'),
      );
      // The same request's payout replayed in another transaction: its keys are taken.
      await expect(
        t.db.transaction(async (tx) => {
          const [request] = await tx
            .select()
            .from(approvalRequests)
            .where(eq(approvalRequests.id, first.id));
          const incident = (await readMarketJudgementIncident(tx, market.marketId))!;
          const ready = await prepareJudgementCompensationPayout(tx, {
            marketId: market.marketId,
            incident,
            payload: judgementCompensationPayloadOf(request!),
          });
          if (ready.outcome !== 'ready') throw new Error('not ready');
          return payJudgementCompensation(tx, {
            marketId: market.marketId,
            marketTitle: market.title,
            incident,
            request: request!,
            recipients: ready.recipients,
          });
        }),
      ).rejects.toThrow(/recorded already/);
      expect(await t.db.select().from(judgementCompensations)).toEqual(rows);
      const [secondNow] = await t.db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, second.id));
      expect(secondNow!.status).toBe('pending');
    });

    it('takes the decision’s instant after the recipients’ locks: a racing writer comes first in id and time', async () => {
      const market = await workedMarket('YES', 'NO');
      const { b } = market.holders;
      const request = await requestCompensation(market, await admin());
      const approver = await admin();
      const account = (await findLedgerAccount(t.db, { kind: 'user', userId: b }))!;
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let holding!: () => void;
      const held = new Promise<void>((resolve) => (holding = resolve));
      // A writer of b's Coin (a fill's, here a grant's) holds b's balance row first.
      const racing = t.db.transaction(async (tx) => {
        await tx.select().from(balances).where(eq(balances.accountId, account.id)).for('update');
        holding();
        await released;
        return recordLedgerEntry(tx, {
          type: 'START_GRANT',
          amountCoin: 1n,
          from: null,
          to: { kind: 'user', userId: b },
          refType: 'start_grant',
          refId: randomUUID(),
          idempotencyKey: randomUUID(),
        });
      });
      await held;
      const approval = approve(market, request.id, approver);
      await waitForLockWaiter(t.db.$client, 'the approval waits on the payee’s balance row');
      release();
      const raced = await racing;
      const done = await approval;
      if (done.outcome !== 'paid' || raced.outcome !== 'recorded') throw new Error('not paid');
      const ours = done.paid.find((p) => p.userId === b)!.entry;
      expect(ours.id).toBeGreaterThan(raced.entry.id);
      expect(ours.createdAt.getTime()).toBeGreaterThanOrEqual(raced.entry.createdAt.getTime());
      expect(ours.toBalanceAfterCoin).toBe(raced.entry.toBalanceAfterCoin! + 300n);
    });
  });

  // ---- the guards (migration 0081) ------------------------------------------------------

  /**
   * A payout written by hand in one transaction — the request approved by `by` at the clock, then
   * for each listed account its entry (unless closed) and row, with `overrides` on the rows — so a
   * guard's refusal is the database's, not the writer's.
   */
  async function rawPayout(
    market: SettledMarket,
    requestId: string,
    by: string,
    options: {
      rows?: (
        row: typeof judgementCompensations.$inferInsert,
      ) => typeof judgementCompensations.$inferInsert | null;
      at?: (at: Date) => Date;
    } = {},
  ) {
    return t.db.transaction(async (tx) => {
      await lockMarket(tx, market.marketId);
      const at = await clockTimestamp(tx);
      const [approved] = await tx
        .update(approvalRequests)
        .set({ status: 'approved', decidedBy: by, decisionReason: '확인', decidedAt: at })
        .where(eq(approvalRequests.id, requestId))
        .returning();
      const payload = judgementCompensationPayloadOf(approved!);
      const rowAt = options.at ? options.at(at) : at;
      for (const listed of payload.recipients) {
        const id = randomUUID();
        const amountCoin = BigInt(listed.amountCoin);
        const entry = await recordLedgerEntry(tx, {
          type: 'JUDGEMENT_COMPENSATION',
          amountCoin,
          from: null,
          to: { kind: 'user', userId: listed.userId },
          marketId: market.marketId,
          refType: 'judgement_compensation',
          refId: id,
          idempotencyKey: ledgerKeys.judgementCompensation(requestId, listed.userId),
          at: rowAt,
        });
        const base: typeof judgementCompensations.$inferInsert = {
          id,
          incidentId: market.incident.id,
          marketId: market.marketId,
          userId: listed.userId,
          approvalId: requestId,
          amountCoin,
          outcome: 'paid',
          ledgerEntryId: entry.entry.id,
          userReason: payload.userReason,
          requestedBy: approved!.requestedBy,
          approvedBy: by,
          // The insert takes the SQL; the row type a test's override sees names text.
          appliedTxid: sql`pg_current_xact_id()::text` as unknown as string,
          createdAt: rowAt,
        };
        const row = options.rows ? options.rows(base) : base;
        if (row) await tx.insert(judgementCompensations).values(row);
      }
    });
  }

  /** A one-target market (YES → NO: the NO 1 holder owed 100) and its waiting request. */
  async function oneTarget() {
    let yes!: string;
    let no!: string;
    const market = await settledMarket('YES', 'NO', async (marketId) => {
      yes = await member();
      no = await member();
      await mintTestPairs(t.db, { marketId, yesHolderId: yes, noHolderId: no, qty: 1 });
    });
    const requester = await admin();
    const request = await requestCompensation(market, requester);
    return { market, yes, no, requester, request };
  }

  describe('the database’s guards (migration 0081)', () => {
    it('lets a hand-written payout of the approved list commit, and nothing else', async () => {
      const { market, request } = await oneTarget();
      await rawPayout(market, request.id, await admin());
      expect(await t.db.select().from(judgementCompensations)).toHaveLength(1);
    });

    it('recomputes the amount, and holds the row to its request, its list and its instant', async () => {
      const { market, request, yes, no } = await oneTarget();
      const approver = await admin();
      const cases: [string, Parameters<typeof rawPayout>[3], string, RegExp][] = [
        [
          'another amount',
          { rows: (row) => ({ ...row, amountCoin: 99n }) },
          'judgement_compensations_check',
          /listing it/,
        ],
        [
          'an account the list does not name',
          { rows: (row) => ({ ...row, userId: yes }) },
          'judgement_compensations_check',
          /listing it/,
        ],
        [
          'another members’ reason',
          { rows: (row) => ({ ...row, userReason: '다른 사유' }) },
          'judgement_compensations_check',
          /listing it/,
        ],
        [
          'another instant than the decision’s',
          { rows: (row) => ({ ...row, createdAt: new Date(row.createdAt.getTime() - 1) }) },
          'judgement_compensations_check',
          /listing it/,
        ],
        [
          'a row written by another transaction',
          { rows: (row) => ({ ...row, appliedTxid: '1' }) },
          'judgement_compensations_check',
          /transaction that approves/,
        ],
        [
          'an open account recorded closed',
          { rows: (row) => ({ ...row, outcome: 'closed', ledgerEntryId: null }) },
          'judgement_compensations_check',
          /closed exactly when/,
        ],
        [
          'another requester',
          { rows: (row) => ({ ...row, requestedBy: no }) },
          'judgement_compensations_check',
          /listing it/,
        ],
      ];
      for (const [what, options, constraint, message] of cases) {
        await expect(rawPayout(market, request.id, approver, options), what).rejects.toSatisfy(
          refusedBy(constraint, message),
        );
      }
      // A frozen list that itself names a wrong amount: the row matches its list, so only the
      // recomputation from the settlement records refuses it (144-1, decision 2).
      const listed = judgementCompensationPayloadOf(request);
      const overpaid = await requestCompensation(market, await admin(), {
        ...listed,
        recipients: listed.recipients.map((r) => ({
          ...r,
          amountCoin: String(BigInt(r.amountCoin) + 1n),
        })),
        totalCoin: String(BigInt(listed.totalCoin) + BigInt(listed.recipients.length)),
      });
      await expect(rawPayout(market, overpaid.id, approver)).rejects.toSatisfy(
        refusedBy('judgement_compensations_check', /not what the settlement records owe/),
      );
      // A frozen list for another corrected result than the incident's.
      const otherResult = await requestCompensation(market, await admin(), {
        ...listed,
        correctedResult: 'VOID',
      });
      await expect(rawPayout(market, otherResult.id, approver)).rejects.toSatisfy(
        refusedBy('judgement_compensations_check', /names its market's confirmed incident/),
      );
      expect(await t.db.select().from(judgementCompensations)).toEqual([]);
    });

    it('binds a paid row to its own entry, and an entry to its row', async () => {
      const { market, request, no } = await oneTarget();
      const approver = await admin();
      // A paid row naming another entry (the payee's start grant).
      const [grant] = await t.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.type, 'START_GRANT'))
        .limit(1);
      await expect(
        rawPayout(market, request.id, approver, {
          rows: (row) => ({ ...row, ledgerEntryId: grant!.id }),
        }),
      ).rejects.toSatisfy(refusedBy('judgement_compensations_own_entry'));
      // An entry with no row, and so an approval without its rows: refused at COMMIT (whichever
      // deferred check runs first).
      const noBalance = await balanceOf(t.db, no);
      await expect(rawPayout(market, request.id, approver, { rows: () => null })).rejects.toSatisfy(
        (e) =>
          refusedBy('ledger_entries_judgement_compensation_record')(e) ||
          refusedBy('approval_requests_compensation_record')(e),
      );
      expect(await balanceOf(t.db, no)).toEqual(noBalance);
      expect(await t.db.select().from(judgementCompensations)).toEqual([]);
    });

    it('refuses a row without an approved request, and an approval without its listed rows', async () => {
      const { market, request } = await oneTarget();
      // The request still pending: a row for it is refused whoever writes.
      await expect(
        t.db.transaction(async (tx) => {
          const at = await clockTimestamp(tx);
          await tx.insert(judgementCompensations).values({
            incidentId: market.incident.id,
            marketId: market.marketId,
            userId: judgementCompensationPayloadOf(request).recipients[0]!.userId,
            approvalId: request.id,
            amountCoin: 100n,
            outcome: 'closed',
            userReason: USER_REASON,
            requestedBy: request.requestedBy,
            approvedBy: await admin(),
            appliedTxid: sql`pg_current_xact_id()::text`,
            createdAt: at,
          });
        }),
      ).rejects.toSatisfy(refusedBy('judgement_compensations_check', /approved/));
      // Approved with no row: refused at COMMIT, and the request stays pending.
      const approver = await admin();
      await expect(
        t.db.transaction(async (tx) => {
          const at = await clockTimestamp(tx);
          await tx
            .update(approvalRequests)
            .set({ status: 'approved', decidedBy: approver, decisionReason: '확인', decidedAt: at })
            .where(eq(approvalRequests.id, request.id));
        }),
      ).rejects.toSatisfy(refusedBy('approval_requests_compensation_record'));
      const [still] = await t.db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, request.id));
      expect(still!.status).toBe('pending');
    });

    it('refuses the paid version’s registrant as the approver, and lets them reject (144-4, ADR-0120 decision 5)', async () => {
      const { market, request } = await oneTarget();
      const decide = (status: 'approved' | 'rejected') =>
        t.db.transaction(async (tx) => {
          const at = await clockTimestamp(tx);
          await tx
            .update(approvalRequests)
            .set({
              status,
              decidedBy: market.paidRegistrant,
              decisionReason: '확인',
              decidedAt: at,
            })
            .where(eq(approvalRequests.id, request.id));
        });
      await expect(decide('approved')).rejects.toSatisfy(
        refusedBy('approval_requests_compensation_registrant'),
      );
      // Even a hand-written payout behind it: refused at the decision first.
      await expect(rawPayout(market, request.id, market.paidRegistrant)).rejects.toSatisfy(
        refusedBy('approval_requests_compensation_registrant'),
      );
      // A 반려 is a 정리 목적 반려: allowed.
      await decide('rejected');
      const [rejected] = await t.db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, request.id));
      expect(rejected!.status).toBe('rejected');
    });

    it('refuses the 운영 마켓메이커 and a closed account written paid', async () => {
      let bot!: string;
      let gone!: string;
      const market = await settledMarket('YES', 'NO', async (marketId) => {
        bot = await createMarketMakerAccount(t.db);
        await fundMarketMakerFunds(t.db, marketId, 1_000n);
        gone = await member();
        const yes = await member();
        await mintTestPairs(t.db, { marketId, yesHolderId: yes, noHolderId: bot, qty: 1 });
        await mintTestPairs(t.db, { marketId, yesHolderId: yes, noHolderId: gone, qty: 1 });
      });
      await closeAccount(t.db, gone);
      // A list naming the bot (owed 100 by its records) and the closed account.
      const payload = judgementCompensationRequestPayload({
        incidentId: market.incident.id,
        correctedResult: 'NO',
        owed: [
          { userId: bot, amountCoin: 100n },
          { userId: gone, amountCoin: 100n },
        ],
        userReason: USER_REASON,
      });
      const request = await requestCompensation(market, await admin(), payload);
      const approver = await admin();
      await expect(
        t.db.transaction(async (tx) => {
          const at = await clockTimestamp(tx);
          await tx
            .update(approvalRequests)
            .set({ status: 'approved', decidedBy: approver, decisionReason: '확인', decidedAt: at })
            .where(eq(approvalRequests.id, request.id));
          await tx.insert(judgementCompensations).values({
            incidentId: market.incident.id,
            marketId: market.marketId,
            userId: bot,
            approvalId: request.id,
            amountCoin: 100n,
            outcome: 'closed',
            userReason: USER_REASON,
            requestedBy: request.requestedBy,
            approvedBy: approver,
            appliedTxid: sql`pg_current_xact_id()::text`,
            createdAt: at,
          });
        }),
      ).rejects.toSatisfy(refusedBy('judgement_compensations_check', /not a person/));
      // The closed account recorded paid (naming some entry): refused before its entry matters.
      const [grant] = await t.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.type, 'START_GRANT'))
        .limit(1);
      await expect(
        t.db.transaction(async (tx) => {
          const at = await clockTimestamp(tx);
          await tx
            .update(approvalRequests)
            .set({ status: 'approved', decidedBy: approver, decisionReason: '확인', decidedAt: at })
            .where(eq(approvalRequests.id, request.id));
          await tx.insert(judgementCompensations).values({
            incidentId: market.incident.id,
            marketId: market.marketId,
            userId: gone,
            approvalId: request.id,
            amountCoin: 100n,
            outcome: 'paid',
            ledgerEntryId: grant!.id,
            userReason: USER_REASON,
            requestedBy: request.requestedBy,
            approvedBy: approver,
            appliedTxid: sql`pg_current_xact_id()::text`,
            createdAt: at,
          });
        }),
      ).rejects.toSatisfy(refusedBy('judgement_compensations_check', /closed exactly when/));
    });

    it('never changes or removes a compensation, whoever writes', async () => {
      const { market, request } = await oneTarget();
      await rawPayout(market, request.id, await admin());
      const [row] = await t.db.select().from(judgementCompensations);
      // buddha_app holds neither privilege (migration 0081's REVOKE).
      await expect(
        t.db
          .update(judgementCompensations)
          .set({ userReason: '바꾼 사유' })
          .where(eq(judgementCompensations.id, row!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(
        t.db.delete(judgementCompensations).where(eq(judgementCompensations.id, row!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      // The owner role meets the trigger.
      for (const statement of [
        `UPDATE judgement_compensations SET user_reason = 'x' WHERE id = $1`,
        'DELETE FROM judgement_compensations WHERE id = $1',
      ]) {
        await expect(migrate.query(statement, [row!.id])).rejects.toSatisfy(
          refusedBy('judgement_compensations_keep_record'),
        );
      }
      expect(await t.db.select().from(judgementCompensations)).toEqual([row]);
    });
  });

  describe('the notice inputs (52-20, 144-18)', () => {
    it('refuses a market that is not SETTLED, and names the payee’s own amount only', () => {
      const notice = {
        originalResult: 'YES' as const,
        correctedResult: 'NO' as const,
        eventKey: 'admin_action:1',
        occurredAt: new Date('2026-11-23T00:00:00.000Z'),
      };
      expect(() =>
        judgementCompensationNotificationInputs(
          [],
          { slug: 's', title: 't', status: 'settling' },
          notice,
        ),
      ).toThrow(/settling/);
      expect(
        judgementCompensationNotificationInputs(
          [{ userId: 'u', amountCoin: 150n }],
          { slug: 's', title: 't', status: 'settled' },
          notice,
        ),
      ).toEqual([
        {
          userId: 'u',
          type: 'market_judgement_compensated',
          eventKey: 'admin_action:1',
          occurredAt: notice.occurredAt,
          target: { kind: 'market', slug: 's' },
          params: {
            marketTitle: 't',
            originalResult: 'YES',
            correctedResult: 'NO',
            compensationCoin: '150',
          },
        },
      ]);
    });
  });

  it('keeps LedgerEntryError for a compensation the write API refuses (no market)', async () => {
    const someone = await member();
    await expect(
      t.db.transaction((tx) =>
        recordLedgerEntry(tx, {
          type: 'JUDGEMENT_COMPENSATION',
          amountCoin: 1n,
          from: null,
          to: { kind: 'user', userId: someone },
          refType: 'judgement_compensation',
          refId: randomUUID(),
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toBeInstanceOf(LedgerEntryError);
  });
});

// ---- static ---------------------------------------------------------------------------------

const ROOT = new URL('../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');

/** Every production source of every app and package, relative to the repository root. */
function sourceFiles(): string[] {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(new URL(`${group}/`, ROOT), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const src = `${group}/${entry.name}/src`;
        let files: string[];
        try {
          files = readdirSync(new URL(`${src}/`, ROOT), { recursive: true, encoding: 'utf8' });
        } catch {
          return [];
        }
        return files
          .map((file) => file.replaceAll('\\', '/'))
          .filter((file) => /\.(ts|tsx|mts)$/.test(file) && !/\.test\.tsx?$/.test(file))
          .map((file) => `${src}/${file}`)
          .filter((file) => !file.startsWith('packages/db/src/test/'));
      }),
  );
}

describe('the 판정 오류 보상’s one writer (#144 AC 3, static)', () => {
  const WRITER = 'packages/db/src/judgement-compensation.ts';

  it('writes JUDGEMENT_COMPENSATION and nothing else, and nothing else writes it', () => {
    // N03 §7 "자동 회수·음수 잔액을 만들지 않는다": the writer's one ledger call mints the
    // compensation; it debits no one and writes no other type (no claw-back path).
    const source = read(WRITER);
    const calls = [...source.matchAll(/\brecordLedgerEntry\(tx, \{([\s\S]*?)\n {4}\}\);/g)];
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatch(/type: 'JUDGEMENT_COMPENSATION',\s+amountCoin,\s+from: null,/);
    expect(source.match(/\brecordLedgerEntry\(/g)).toHaveLength(1);
    // No other writer of the books gives an entry the type (@buddha/shared's rule tables are no
    // writer; a writer that only reads the type, as the wallet's ledger page does, is not one).
    expect(
      sourceFiles()
        .filter((file) => /\brecordLedgerEntry\(/.test(read(file)))
        .filter((file) => /\btype: 'JUDGEMENT_COMPENSATION'/.test(read(file))),
    ).toEqual([WRITER]);
    // Nor does it write the paid records the books compare (ADR-0165 decision 2).
    expect(source).not.toMatch(
      /\.(?:insert|update|delete)\(\s*(?:positions|positionSettlements|markets|marketJudgements)\b/,
    );
  });
});
