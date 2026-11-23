import { randomUUID } from 'node:crypto';
import {
  MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND,
  type MarketJudgementIncidentRequestPayload,
  type MarketResult,
} from '@buddha/shared';
import { eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MarketConflictError, declareMarketConflict } from './market-conflicts.js';
import {
  effectiveResultSql,
  readMarketJudgementIncident,
  readMarketJudgementIncidentRequests,
  recordMarketJudgementIncident,
} from './market-judgement-incident.js';
import {
  adminActions,
  approvalRequests,
  marketJudgementIncidents,
  markets,
  profiles,
} from './schema/index.js';
import {
  createApprovalRequest,
  createMarket,
  createProvisionalMarket,
  createUser,
  resolveMarketNow,
} from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { clockTimestamp, lockAdminRoles, lockMarket } from './tx-helpers.js';

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

/** Rejects with `name`: a trigger raised under its own name (23000) or a CHECK (23514). */
const refusedBy = (name: string) => (error: unknown) =>
  ['23000', '23514', '23505'].includes(sqlState(error) ?? '') && sqlConstraint(error) === name;

const LINK = 'https://www.bok.or.kr/press/1';
const DESCRIPTION = '발표 원문의 수치를 잘못 읽었다.';

/**
 * 판정 오류 사건 (#144 part 1, ADR-0165; 144-3, 144-4, 144-13, 144-14): migration 0080's table and
 * guards, and @buddha/db's writer, readers and `effectiveResultSql`, on the docker test profile.
 */
describe.skipIf(!hasTestDb())('the 판정 오류 사건 (#144, docker test profile)', () => {
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

  const admin = async () => (await createUser(t.db, { role: 'admin' })).user.id;

  /**
   * A SETTLED market paid on its judgement v1 (`result`), registered by `paidRegistrant`: the
   * judgement published and confirmed as the routes and the worker leave it, then the status
   * moved on as the payout does (no holdings: nothing to pay).
   */
  async function settledMarket(
    result: MarketResult = 'YES',
    status: 'resolved' | 'settling' | 'settled' = 'settled',
  ) {
    const paidRegistrant = await admin();
    const published = await createProvisionalMarket(t.db, { result, registeredBy: paidRegistrant });
    await resolveMarketNow(t.db, published.market.id);
    await t.db.update(markets).set({ status }).where(eq(markets.id, published.market.id));
    return { marketId: published.market.id, paidRegistrant, version: published.judgement.version };
  }

  interface RegisterInput {
    marketId: string;
    by: string;
    original?: MarketResult;
    corrected?: MarketResult;
    version?: number;
    collectedAt?: string;
    requestedAt?: Date;
  }

  /** A waiting incident, as the registration writes it (the payload frozen, the reason the 설명). */
  async function register(input: RegisterInput) {
    const payload: MarketJudgementIncidentRequestPayload = {
      noConflictConfirmed: true,
      judgementVersion: input.version ?? 1,
      originalResult: input.original ?? 'YES',
      correctedResult: input.corrected ?? 'NO',
      evidence: { links: [LINK], collectedAt: input.collectedAt ?? '2026-11-20T00:00:00.000Z' },
    };
    return createApprovalRequest(t.db, {
      kind: MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND,
      targetType: 'market',
      targetId: input.marketId,
      payload,
      requestedBy: input.by,
      reason: DESCRIPTION,
      ...(input.requestedAt ? { requestedAt: input.requestedAt } : {}),
    });
  }

  /**
   * 오류 확인 as the API's transaction runs it: the market lock, the request approved by `by` at
   * the clock, then the incident written at that instant.
   */
  const confirm = (
    marketId: string,
    requestId: string,
    by: string,
    paidRegisteredBy: string,
    overrides: Partial<typeof marketJudgementIncidents.$inferInsert> = {},
  ) =>
    t.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const at = await clockTimestamp(tx);
      const [approved] = await tx
        .update(approvalRequests)
        .set({
          status: 'approved',
          decidedBy: by,
          decisionReason: '원문을 확인했다.',
          decidedAt: at,
        })
        .where(eq(approvalRequests.id, requestId))
        .returning();
      if (Object.keys(overrides).length === 0) {
        return recordMarketJudgementIncident(tx, {
          marketId,
          request: approved!,
          paidRegisteredBy,
        });
      }
      const [row] = await tx
        .insert(marketJudgementIncidents)
        .values({
          marketId,
          appliedTxid: sql`pg_current_xact_id()::text`,
          judgementVersion: 1,
          originalResult: 'YES',
          correctedResult: 'NO',
          description: DESCRIPTION,
          evidenceLinks: [LINK],
          evidenceCollectedAt: new Date('2026-11-20T00:00:00.000Z'),
          approvalId: requestId,
          registeredBy: approved!.requestedBy,
          paidRegisteredBy,
          confirmedBy: by,
          registeredAt: approved!.requestedAt,
          confirmedAt: at,
          ...overrides,
        })
        .returning();
      return row!;
    });

  /** The request's status, as the database holds it. */
  const statusOf = async (requestId: string) =>
    (
      await t.db
        .select({ status: approvalRequests.status })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, requestId))
    )[0]?.status;

  describe('the writer and the readers', () => {
    it('confirms a paid market’s incident at the decision’s instant, from its frozen request', async () => {
      const { marketId, paidRegistrant } = await settledMarket('YES');
      const registrant = await admin();
      const reviewer = (await createUser(t.db, { role: 'admin', nickname: '검토자' })).user.id;
      const request = await register({ marketId, by: registrant });
      const row = await confirm(marketId, request.id, reviewer, paidRegistrant);
      const [decided] = await t.db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, request.id));
      expect(row).toMatchObject({
        marketId,
        judgementVersion: 1,
        originalResult: 'YES',
        correctedResult: 'NO',
        description: DESCRIPTION,
        evidenceLinks: [LINK],
        evidenceCollectedAt: new Date('2026-11-20T00:00:00.000Z'),
        approvalId: request.id,
        registeredBy: registrant,
        paidRegisteredBy: paidRegistrant,
        confirmedBy: reviewer,
        registeredAt: decided!.requestedAt,
        confirmedAt: decided!.decidedAt,
      });
      expect(row.appliedTxid).toMatch(/^\d+$/);
      expect(await readMarketJudgementIncident(t.db, marketId)).toEqual(row);
      expect(await readMarketJudgementIncident(t.db, randomUUID())).toBeNull();
      const [read] = await readMarketJudgementIncidentRequests(t.db, marketId);
      expect(read).toMatchObject({
        id: request.id,
        status: 'approved',
        description: DESCRIPTION,
        requestedBy: registrant,
        decidedBy: reviewer,
        decidedByNickname: '검토자',
        decisionReason: '원문을 확인했다.',
        retractedAt: null,
        payload: {
          noConflictConfirmed: true,
          judgementVersion: 1,
          originalResult: 'YES',
          correctedResult: 'NO',
          evidence: { links: [LINK], collectedAt: '2026-11-20T00:00:00.000Z' },
        },
      });
      expect(read!.requestedByNickname).toEqual(expect.any(String));
      // The market row, its judgement and its status event never move (ADR-0165 decision 2).
      const [market] = await t.db.select().from(markets).where(eq(markets.id, marketId));
      expect(market).toMatchObject({
        status: 'settled',
        resolvedResult: 'YES',
        judgementVersion: 1,
      });
    });

    it('lists a market’s incident requests newest first, of this kind and market alone', async () => {
      const { marketId } = await settledMarket('YES');
      const other = await settledMarket('NO');
      const registrant = await admin();
      const reviewer = await admin();
      const base = await clockTimestamp(t.db);
      const first = await createApprovalRequest(t.db, {
        kind: MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND,
        targetType: 'market',
        targetId: marketId,
        payload: {
          noConflictConfirmed: true,
          judgementVersion: 1,
          originalResult: 'YES',
          correctedResult: 'VOID',
          evidence: { links: [LINK], collectedAt: '2026-11-20T00:00:00.000Z' },
        },
        requestedBy: registrant,
        reason: DESCRIPTION,
        requestedAt: new Date(base.getTime() - 3_000),
        retracted: {},
      });
      const second = await register({
        marketId,
        by: registrant,
        requestedAt: new Date(base.getTime() - 2_000),
      });
      await t.db
        .update(approvalRequests)
        .set({
          status: 'rejected',
          decidedBy: reviewer,
          decisionReason: '오류가 아니다.',
          decidedAt: new Date(base.getTime() - 1_000),
        })
        .where(eq(approvalRequests.id, second.id));
      const third = await register({ marketId, by: registrant, requestedAt: base });
      await register({
        marketId: other.marketId,
        by: registrant,
        original: 'NO',
        corrected: 'YES',
      });
      // Another kind on the same market is not an incident.
      await createApprovalRequest(t.db, {
        kind: 'market_judgement',
        targetType: 'market',
        targetId: marketId,
        payload: {},
        requestedBy: registrant,
      });
      const reads = await readMarketJudgementIncidentRequests(t.db, marketId);
      expect(reads.map((read) => [read.id, read.status])).toEqual([
        [third.id, 'pending'],
        [second.id, 'rejected'],
        [first.id, 'retracted'],
      ]);
      expect(reads[1]).toMatchObject({ decidedBy: reviewer, decisionReason: '오류가 아니다.' });
      expect(reads[2]!.retractedAt).toEqual(expect.any(Date));
      expect(reads[2]!.payload.correctedResult).toBe('VOID');
      expect(await readMarketJudgementIncidentRequests(t.db, randomUUID())).toEqual([]);
    });

    it('re-checks the confirmer and the registrant for a conflict on the market (#143)', async () => {
      const { marketId, paidRegistrant } = await settledMarket('YES');
      const registrant = await admin();
      const reviewer = await admin();
      const request = await register({ marketId, by: registrant });
      // As market-conflicts.test.ts declares one: the locks, then the action and its row at one
      // instant.
      await t.db.transaction(async (tx) => {
        await lockMarket(tx, marketId);
        await lockAdminRoles(tx, 'shared');
        const at = new Date();
        const [action] = await tx
          .insert(adminActions)
          .values({
            adminId: registrant,
            type: 'market_conflict_declare',
            targetType: 'market',
            targetId: marketId,
            payload: { reason: '가족이 당사자다' },
            createdAt: at,
          })
          .returning();
        await declareMarketConflict(tx, {
          marketId,
          userId: registrant,
          reason: '가족이 당사자다',
          adminActionId: action!.id,
          at,
        });
      });
      await expect(confirm(marketId, request.id, reviewer, paidRegistrant)).rejects.toBeInstanceOf(
        MarketConflictError,
      );
      // Rolled back whole: the request still waits and no incident exists.
      expect(await statusOf(request.id)).toBe('pending');
      expect(await readMarketJudgementIncident(t.db, marketId)).toBeNull();
    });

    it('reads the effective result: the paid one, or the confirmed incident’s (144-5)', async () => {
      const corrected = await settledMarket('YES');
      const plain = await settledMarket('VOID');
      const open = await createMarket(t.db, { status: 'open' });
      const registrant = await admin();
      const reviewer = await admin();
      const request = await register({ marketId: corrected.marketId, by: registrant });
      await confirm(corrected.marketId, request.id, reviewer, corrected.paidRegistrant);
      const rows = await t.db
        .select({ id: markets.id, result: effectiveResultSql() })
        .from(markets)
        .leftJoin(marketJudgementIncidents, eq(marketJudgementIncidents.marketId, markets.id));
      const resultOf = new Map(rows.map((row) => [row.id, row.result]));
      expect(rows).toHaveLength(3);
      expect(resultOf.get(corrected.marketId)).toBe('NO');
      expect(resultOf.get(plain.marketId)).toBe('VOID');
      expect(resultOf.get(open.id)).toBeNull();
      // As a predicate, the way the related markets drop a VOID: YES→NO stays, VOID is hidden.
      const shown = await t.db
        .select({ id: markets.id })
        .from(markets)
        .leftJoin(marketJudgementIncidents, eq(marketJudgementIncidents.marketId, markets.id))
        .where(sql`${effectiveResultSql()} IS DISTINCT FROM 'VOID'`);
      expect(shown.map((row) => row.id).sort()).toEqual([corrected.marketId, open.id].sort());
    });

    it('hides a market whose incident corrected it to VOID and shows one corrected from VOID', async () => {
      const toVoid = await settledMarket('YES');
      const fromVoid = await settledMarket('VOID');
      const registrant = await admin();
      const reviewer = await admin();
      const a = await register({ marketId: toVoid.marketId, by: registrant, corrected: 'VOID' });
      await confirm(toVoid.marketId, a.id, reviewer, toVoid.paidRegistrant);
      const b = await register({
        marketId: fromVoid.marketId,
        by: registrant,
        original: 'VOID',
        corrected: 'YES',
      });
      await confirm(fromVoid.marketId, b.id, reviewer, fromVoid.paidRegistrant);
      const shown = await t.db
        .select({ id: markets.id })
        .from(markets)
        .leftJoin(marketJudgementIncidents, eq(marketJudgementIncidents.marketId, markets.id))
        .where(sql`${effectiveResultSql()} IS DISTINCT FROM 'VOID'`);
      expect(shown.map((row) => row.id)).toEqual([fromVoid.marketId]);
    });
  });

  describe('migration 0080', () => {
    it('confirms on a SETTLED market alone (144-13), never while resolved or settling', async () => {
      for (const status of ['resolved', 'settling'] as const) {
        const { marketId, paidRegistrant } = await settledMarket('YES', status);
        const request = await register({ marketId, by: await admin() });
        await expect(
          confirm(marketId, request.id, await admin(), paidRegistrant),
          status,
        ).rejects.toSatisfy(refusedBy('market_judgement_incidents_check'));
        expect(await statusOf(request.id)).toBe('pending');
      }
    });

    it('refuses the paid version’s registrant as the decider, on 오류 확인 and 기각 (144-4)', async () => {
      const { marketId, paidRegistrant } = await settledMarket('YES');
      const request = await register({ marketId, by: await admin() });
      for (const status of ['approved', 'rejected'] as const) {
        await expect(
          t.db.transaction((tx) =>
            tx
              .update(approvalRequests)
              .set({
                status,
                decidedBy: paidRegistrant,
                decisionReason: '결정',
                decidedAt: new Date(),
              })
              .where(eq(approvalRequests.id, request.id)),
          ),
          status,
        ).rejects.toSatisfy(refusedBy('approval_requests_incident_registrant'));
      }
      expect(await statusOf(request.id)).toBe('pending');
      // Another admin may dismiss it; and the paid registrant may register one (144-4).
      const other = await admin();
      await t.db
        .update(approvalRequests)
        .set({
          status: 'rejected',
          decidedBy: other,
          decisionReason: '기각',
          decidedAt: new Date(),
        })
        .where(eq(approvalRequests.id, request.id));
      expect(await statusOf(request.id)).toBe('rejected');
      const own = await register({ marketId, by: paidRegistrant });
      await confirm(marketId, own.id, other, paidRegistrant);
      expect((await readMarketJudgementIncident(t.db, marketId))?.registeredBy).toBe(
        paidRegistrant,
      );
    });

    it('leaves every other approval kind to its own rules: the trigger fires for incidents alone', async () => {
      const { marketId, paidRegistrant } = await settledMarket('YES');
      const request = await createApprovalRequest(t.db, {
        kind: 'market_cancel',
        targetType: 'market',
        targetId: marketId,
        payload: { statusEventId: 1 },
        requestedBy: await admin(),
        decision: { status: 'rejected', by: paidRegistrant },
      });
      expect(request.status).toBe('rejected');
    });

    it('commits an approved incident request only with its incident, written by the same transaction', async () => {
      const { marketId, paidRegistrant } = await settledMarket('YES');
      const registrant = await admin();
      const reviewer = await admin();
      const request = await register({ marketId, by: registrant });
      // Approved with no row: refused at COMMIT.
      await expect(
        t.db
          .update(approvalRequests)
          .set({
            status: 'approved',
            decidedBy: reviewer,
            decisionReason: '확인',
            decidedAt: new Date(),
          })
          .where(eq(approvalRequests.id, request.id)),
      ).rejects.toSatisfy(refusedBy('approval_requests_incident_record'));
      expect(await statusOf(request.id)).toBe('pending');
      // A row naming another transaction is refused at its insert.
      await expect(
        confirm(marketId, request.id, reviewer, paidRegistrant, { appliedTxid: '1' }),
      ).rejects.toSatisfy(refusedBy('market_judgement_incidents_check'));
      expect(await statusOf(request.id)).toBe('pending');
      expect(await readMarketJudgementIncident(t.db, marketId)).toBeNull();
    });

    it('refuses a row that is not its approved request’s or its market’s paid version', async () => {
      const { marketId, paidRegistrant } = await settledMarket('YES');
      const registrant = await admin();
      const reviewer = await admin();
      const request = await register({ marketId, by: registrant });
      const stranger = await admin();
      const otherMarket = await settledMarket('YES');
      const cases: [string, Partial<typeof marketJudgementIncidents.$inferInsert>][] = [
        ['original result', { originalResult: 'VOID', correctedResult: 'NO' }],
        ['corrected result', { correctedResult: 'VOID' }],
        ['paid registrant', { paidRegisteredBy: stranger }],
        ['registrant', { registeredBy: stranger }],
        ['confirmed at', { confirmedAt: new Date('2099-01-01T00:00:00.000Z') }],
        ['registered at', { registeredAt: new Date('2026-11-21T00:00:00.000Z') }],
        ['description', { description: '다른 설명' }],
        ['links', { evidenceLinks: [`${LINK}/2`] }],
        ['collected at', { evidenceCollectedAt: new Date('2026-11-19T00:00:00.000Z') }],
        [
          'market',
          { marketId: otherMarket.marketId, paidRegisteredBy: otherMarket.paidRegistrant },
        ],
      ];
      for (const [name, overrides] of cases) {
        await expect(
          confirm(marketId, request.id, reviewer, paidRegistrant, overrides),
          name,
        ).rejects.toSatisfy(refusedBy('market_judgement_incidents_check'));
      }
      // A version the market is not on: no such judgement (the composite key) — refused by the
      // trigger before the key is checked.
      await expect(
        confirm(marketId, request.id, reviewer, paidRegistrant, { judgementVersion: 2 }),
      ).rejects.toSatisfy(refusedBy('market_judgement_incidents_check'));
      expect(await statusOf(request.id)).toBe('pending');
      // Another kind's approved request cannot back an incident.
      const cancel = await createApprovalRequest(t.db, {
        kind: 'market_cancel',
        targetType: 'market',
        targetId: marketId,
        payload: { statusEventId: 1 },
        requestedBy: registrant,
        reason: DESCRIPTION,
        decision: { status: 'approved', by: reviewer },
      });
      await expect(
        t.db.transaction((tx) =>
          tx.insert(marketJudgementIncidents).values({
            marketId,
            appliedTxid: sql`pg_current_xact_id()::text`,
            judgementVersion: 1,
            originalResult: 'YES',
            correctedResult: 'NO',
            description: DESCRIPTION,
            evidenceLinks: [LINK],
            evidenceCollectedAt: new Date('2026-11-20T00:00:00.000Z'),
            approvalId: cancel.id,
            registeredBy: registrant,
            paidRegisteredBy: paidRegistrant,
            confirmedBy: reviewer,
            registeredAt: cancel.requestedAt,
            confirmedAt: cancel.decidedAt!,
          }),
        ),
      ).rejects.toSatisfy(refusedBy('market_judgement_incidents_check'));
    });

    it('takes one confirmed incident per market (144-14)', async () => {
      const { marketId, paidRegistrant } = await settledMarket('YES');
      const registrant = await admin();
      const reviewer = await admin();
      const first = await register({ marketId, by: registrant });
      await confirm(marketId, first.id, reviewer, paidRegistrant);
      const second = await register({ marketId, by: registrant, corrected: 'VOID' });
      await expect(confirm(marketId, second.id, reviewer, paidRegistrant)).rejects.toSatisfy(
        refusedBy('market_judgement_incidents_market_id_unique'),
      );
      expect(await statusOf(second.id)).toBe('pending');
    });

    it('confirms with a registrant who lost the admin role since (no role check on the row)', async () => {
      const { marketId, paidRegistrant } = await settledMarket('YES');
      const registrant = await admin();
      const reviewer = await admin();
      const request = await register({ marketId, by: registrant });
      await t.db.update(profiles).set({ role: 'user' }).where(eq(profiles.userId, registrant));
      const row = await confirm(marketId, request.id, reviewer, paidRegistrant);
      expect(row.registeredBy).toBe(registrant);
    });

    it('holds a row to its CHECKs whoever writes: results, two people and the evidence', async () => {
      const { marketId, paidRegistrant } = await settledMarket('YES');
      const registrant = await admin();
      const reviewer = await admin();
      const request = await register({ marketId, by: registrant });
      const owner = new Client({ connectionString: testDbUrls()!.migrateUrl });
      await owner.connect();
      try {
        const attempt = async (column: string, value: unknown) => {
          await owner.query('BEGIN');
          try {
            await owner.query(
              'ALTER TABLE market_judgement_incidents DISABLE TRIGGER market_judgement_incidents_check',
            );
            const row: Record<string, unknown> = {
              market_id: marketId,
              applied_txid: 'x',
              judgement_version: 1,
              original_result: 'YES',
              corrected_result: 'NO',
              description: DESCRIPTION,
              evidence_links: [LINK],
              evidence_collected_at: '2026-11-20T00:00:00.000Z',
              approval_id: request.id,
              registered_by: registrant,
              paid_registered_by: paidRegistrant,
              confirmed_by: reviewer,
              registered_at: '2026-11-21T00:00:00.000Z',
              confirmed_at: '2026-11-22T00:00:00.000Z',
              [column]: value,
            };
            const columns = Object.keys(row);
            await owner.query(
              `INSERT INTO market_judgement_incidents (${columns.join(', ')}) VALUES (${columns
                .map((_, index) => `$${String(index + 1)}`)
                .join(', ')})`,
              Object.values(row),
            );
          } finally {
            await owner.query('ROLLBACK');
          }
        };
        const cases: [string, unknown, string][] = [
          ['corrected_result', 'YES', 'market_judgement_incidents_result_check'],
          ['judgement_version', 0, 'market_judgement_incidents_result_check'],
          ['confirmed_by', registrant, 'market_judgement_incidents_confirmer_check'],
          ['confirmed_by', paidRegistrant, 'market_judgement_incidents_confirmer_check'],
          [
            'confirmed_at',
            '2026-11-21T00:00:00.000Z',
            'market_judgement_incidents_confirmer_check',
          ],
          ['evidence_links', [], 'market_judgement_incidents_evidence_check'],
          [
            'evidence_links',
            [1, 2, 3, 4, 5, 6].map((n) => `${LINK}/${String(n)}`),
            'market_judgement_incidents_evidence_check',
          ],
          ['evidence_links', [LINK, null], 'market_judgement_incidents_evidence_check'],
          ['evidence_links', [[LINK]], 'market_judgement_incidents_evidence_check'],
          [
            'evidence_collected_at',
            '2026-11-21T00:00:00.001Z',
            'market_judgement_incidents_evidence_check',
          ],
          ['description', '  ', 'market_judgement_incidents_evidence_check'],
          ['description', 'x'.repeat(501), 'market_judgement_incidents_evidence_check'],
        ];
        for (const [column, value, constraint] of cases) {
          await expect(attempt(column, value), `${column} ${String(value)}`).rejects.toSatisfy(
            refusedBy(constraint),
          );
        }
      } finally {
        await owner.end();
      }
    });

    it('keeps an incident for good: no UPDATE or DELETE, by the app or the owner', async () => {
      const { marketId, paidRegistrant } = await settledMarket('YES');
      const request = await register({ marketId, by: await admin() });
      const row = await confirm(marketId, request.id, await admin(), paidRegistrant);
      await expect(
        t.db
          .update(marketJudgementIncidents)
          .set({ correctedResult: 'VOID' })
          .where(eq(marketJudgementIncidents.id, row.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(
        t.db.delete(marketJudgementIncidents).where(eq(marketJudgementIncidents.id, row.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      const owner = new Client({ connectionString: testDbUrls()!.migrateUrl });
      await owner.connect();
      try {
        for (const statement of [
          "UPDATE market_judgement_incidents SET corrected_result = 'VOID' WHERE id = $1",
          'DELETE FROM market_judgement_incidents WHERE id = $1',
        ]) {
          await expect(owner.query(statement, [row.id]), statement).rejects.toSatisfy(
            refusedBy('market_judgement_incidents_keep_record'),
          );
        }
      } finally {
        await owner.end();
      }
      expect(await readMarketJudgementIncident(t.db, marketId)).toEqual(row);
    });

    it('fixes the search path of its functions', async () => {
      const names = [
        'approval_requests_incident_record',
        'approval_requests_incident_registrant',
        'market_judgement_incidents_check',
        'market_judgement_incidents_keep_record',
      ];
      const { rows } = await t.db.execute<{ name: string; config: string[] | null }>(sql`
        SELECT proname AS name, proconfig AS config FROM pg_proc
        WHERE proname IN (${sql.join(
          names.map((name) => sql`${name}`),
          sql`, `,
        )})
        ORDER BY proname`);
      expect(rows).toEqual(
        names.map((name) => ({ name, config: ['search_path=pg_catalog, public, pg_temp'] })),
      );
    });
  });
});
