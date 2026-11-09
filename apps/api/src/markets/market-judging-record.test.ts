/** #24 / ADR-0107: public allowlist, historic decisions and one consistent detail snapshot. */
import { randomUUID } from 'node:crypto';
import { runMarketReconciliation, schema } from '@buddha/db';
import {
  createCorrectedMarket,
  createDispute,
  createJudgementDelay,
  createJudgementRequest,
  createMarket,
  createMarketPause,
  createPosition,
  createProvisionalMarket,
  createSettlementStep,
  createUser,
  resumeMarket,
} from '@buddha/db/test';
import { marketSchema, PUBLIC_MARKET_STATUSES, type Market } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { MarketAdminService } from './market-admin.service.js';
import * as recordReader from './market-judging-record.js';

const emptyRecord = {
  versions: [],
  pauses: [],
  delays: [],
  disputes: { total: 0, byVersion: [], decisions: [] },
  cancellation: null,
  payoutDelayed: false,
};
const HOUR = 3_600_000;
const actualRead = recordReader.readMarketJudgingRecord;

describe.skipIf(!hasTestInfra)('public judging record (integration)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const response = (id: string) => t.app.inject({ method: 'GET', url: `/api/v1/markets/${id}` });
  async function detail(id: string): Promise<Market> {
    const res = await response(id);
    expect(res.statusCode, res.body).toBe(200);
    return marketSchema.parse(res.json<{ data: Market }>().data);
  }

  it('includes an empty record for every public status without inventing a legacy judgement', async () => {
    for (const status of PUBLIC_MARKET_STATUSES) {
      const market = await createMarket(t.db, { status });
      const read = await detail(market.id);
      expect(read.status).toBe(status);
      expect(read.judgingRecord).toEqual(emptyRecord);
    }
    for (const status of ['draft', 'review'] as const) {
      const market = await createMarket(t.db, { status });
      expect((await response(market.id)).statusCode).toBe(404);
    }
    const resolvedAt = new Date(Date.now() - 2 * HOUR);
    const settledAt = new Date(Date.now() - HOUR);
    const legacy = await createMarket(t.db, { status: 'settled', resolvedAt, settledAt });
    expect(await detail(legacy.slug)).toMatchObject({
      resolvedAt: resolvedAt.toISOString(),
      settledAt: settledAt.toISOString(),
      judgementVersion: null,
      judgingRecord: emptyRecord,
    });
  });

  it('returns approved versions and correction grounds identically in public/admin detail, omitting pending, rejected and retracted registrations', async () => {
    const first = await createProvisionalMarket(t.db, {
      description: '공식 발표의 최초 결과',
      approvalReason: 'private-first-approval',
      evidence: { links: ['https://example.com/first'] },
    });
    const second = await createCorrectedMarket(t.db, {
      marketId: first.market.id,
      reason: '공식 발표 정정',
      description: '수정된 공식 결과',
      approvalReason: 'private-second-approval',
      evidence: { links: ['https://example.com/second'] },
    });
    const rejectingAdmin = (await createUser(t.db, { role: 'admin' })).user;
    for (const state of ['pending', 'rejected', 'retracted'] as const) {
      await createJudgementRequest(t.db, {
        marketId: first.market.id,
        description: `private-${state}`,
        ...(state === 'rejected'
          ? { rejected: { by: rejectingAdmin.id, reason: 'private-rejection' } }
          : {}),
        ...(state === 'retracted' ? { retracted: {} } : {}),
      });
    }
    const read = await detail(first.market.id);
    expect(read.judgingRecord.versions).toEqual([
      expect.objectContaining({
        version: 2,
        result: 'NO',
        description: '수정된 공식 결과',
        correctionReason: '공식 발표 정정',
      }),
      expect.objectContaining({
        version: 1,
        result: 'YES',
        description: '공식 발표의 최초 결과',
        correctionReason: null,
      }),
    ]);
    const admin = await t.app.get(MarketAdminService).get(first.market.id);
    expect(admin.judgingRecord).toEqual(read.judgingRecord);
    const json = JSON.stringify(read);
    for (const secret of [
      'private-',
      first.request.id,
      second.request.id,
      first.request.requestedBy,
      first.request.decidedBy!,
      second.request.requestedBy,
      second.request.decidedBy!,
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it('publishes legacy pause facts and previous delay reasons while retaining private notes and identities', async () => {
    const open = await createMarket(t.db, { status: 'open' });
    const resumed = await resumeMarket(t.db, open.id, {
      pause: { reason: 'basis_change', note: '출처의 기준 변경' },
      reason: 'private-resume-request',
      approvalReason: 'private-resume-approval',
      reviewResult: 'judgeable',
    });
    const early = await createMarketPause(t.db, {
      marketId: open.id,
      reason: 'early_result',
      note: '결과 조기 발표',
    });
    expect((await detail(open.id)).judgingRecord.pauses).toEqual([
      {
        reason: 'early_result',
        note: null,
        resultPublishedAt: early.pause.resultPublishedAt!.toISOString(),
        pausedAt: early.pause.pausedAt.toISOString(),
        reviewResult: null,
        endKind: null,
        endedAt: null,
      },
      {
        reason: 'basis_change',
        note: null,
        resultPublishedAt: null,
        pausedAt: resumed.pause.pausedAt.toISOString(),
        reviewResult: 'judgeable',
        endKind: 'resumed',
        endedAt: resumed.pause.endedAt!.toISOString(),
      },
    ]);
    const legacy = await response(open.id);
    expect(legacy.body).not.toContain(early.pause.note);
    expect(legacy.body).not.toContain(resumed.pause.note);
    const admin = await t.app.get(MarketAdminService).get(open.id);
    expect(admin.pause.history.map((pause) => pause.note)).toEqual([
      early.pause.note,
      resumed.pause.note,
    ]);
    const closed = await createMarket(t.db, {
      status: 'closed',
      openAt: new Date(Date.now() - 6 * HOUR),
      closeAt: new Date(Date.now() - 5 * HOUR),
      eventDeadline: new Date(Date.now() - 4 * HOUR),
      scheduledJudgementAt: new Date(Date.now() - 3 * HOUR),
    });
    const old = await createJudgementDelay(t.db, {
      marketId: closed.id,
      reason: '첫 발표 연기',
      recordedAt: new Date(Date.now() - HOUR),
    });
    const latest = await createJudgementDelay(t.db, { marketId: closed.id, reason: '발표 재연기' });
    const read = await detail(closed.id);
    expect(read.judgingRecord.delays).toEqual([
      {
        reason: latest.delay.reason,
        nextReviewAt: latest.delay.nextReviewAt.toISOString(),
        current: true,
      },
      {
        reason: old.delay.reason,
        nextReviewAt: old.delay.nextReviewAt.toISOString(),
        current: false,
      },
    ]);
    for (const secret of [
      old.delay.id,
      old.delay.recordedBy,
      old.delay.recordedAt.toISOString(),
      latest.delay.id,
      latest.delay.recordedBy,
      latest.delay.recordedAt.toISOString(),
    ]) {
      expect(JSON.stringify(read.judgingRecord)).not.toContain(secret);
    }
    await createProvisionalMarket(t.db, { marketId: closed.id });
    expect((await detail(closed.id)).judgingRecord.delays.map((delay) => delay.current)).toEqual([
      false,
      false,
    ]);
  });

  it.each([
    'missing',
    'false',
    'string-true',
    'object',
    'wrong-market',
    'wrong-pause',
    'wrong-type',
    'wrong-event',
    'confirmed',
  ] as const)(
    'reveals a pause note only with exact immutable publication provenance: %s',
    async (kind) => {
      // Old/malformed durable records can exist. Insert rather than mutate immutable history;
      // a marker elsewhere must never retroactively publish this row's private note.
      const market = await createMarket(t.db, { status: 'paused' });
      const foreign = await createMarket(t.db, { status: 'paused' });
      const admin = (await createUser(t.db, { role: 'admin' })).user;
      const pauseId = randomUUID();
      const pausedAt = new Date();
      const publishedAt = new Date(pausedAt.getTime() - HOUR);
      const note = `private-pause-${kind}`;
      const flag =
        kind === 'missing'
          ? {}
          : {
              notePublic:
                kind === 'false'
                  ? false
                  : kind === 'string-true'
                    ? 'true'
                    : kind === 'object'
                      ? { value: true }
                      : true,
            };
      const [event] = await t.db
        .insert(schema.marketEvents)
        .values({
          marketId: kind === 'wrong-market' ? foreign.id : market.id,
          type: kind === 'wrong-type' ? 'opened' : 'paused',
          actorId: admin.id,
          payload: {
            pauseId: kind === 'wrong-pause' ? randomUUID() : pauseId,
            reason: 'early_result',
            resultPublishedAt: publishedAt.toISOString(),
            ...flag,
          },
          createdAt: pausedAt,
        })
        .returning();
      let eventId = event!.id;
      if (kind === 'wrong-event') {
        const [legacyEvent] = await t.db
          .insert(schema.marketEvents)
          .values({
            marketId: market.id,
            type: 'paused',
            payload: {
              pauseId,
              reason: 'early_result',
              resultPublishedAt: publishedAt.toISOString(),
            },
            createdAt: pausedAt,
          })
          .returning();
        eventId = legacyEvent!.id;
      }
      await t.db.insert(schema.marketPauses).values({
        id: pauseId,
        marketId: market.id,
        reason: 'early_result',
        note,
        resultPublishedAt: publishedAt,
        pausedAt,
        pausedBy: admin.id,
        pauseEventId: eventId,
      });
      const res = await response(market.id);
      expect(res.statusCode, res.body).toBe(200);
      const read = marketSchema.parse(res.json<{ data: Market }>().data);
      expect(read.judgingRecord.pauses).toEqual([
        {
          reason: 'early_result',
          note: kind === 'confirmed' ? note : null,
          pausedAt: pausedAt.toISOString(),
          resultPublishedAt: publishedAt.toISOString(),
          reviewResult: null,
          endKind: null,
          endedAt: null,
        },
      ]);
      if (kind !== 'confirmed') expect(res.body).not.toContain(note);
      for (const privateValue of [admin.id, pauseId, 'notePublic'])
        expect(res.body).not.toContain(privateValue);
      const privateRead = await t.app.get(MarketAdminService).get(market.id);
      expect(privateRead.pause.history[0]?.note).toBe(note);
      expect(privateRead.judgingRecord).toEqual(read.judgingRecord);
    },
  );

  it('keeps fallback evidence and a corrected VOID reason, without manufacturing a VOID source', async () => {
    const first = await createProvisionalMarket(t.db, {
      market: { fallbackSources: [{ name: '대체 발표', url: 'https://example.com/fallback' }] },
      source: { priority: 1 },
      fallbackReason: '1차 발표가 없어 대체 출처 사용',
    });
    await createCorrectedMarket(t.db, {
      marketId: first.market.id,
      result: 'VOID',
      source: null,
      reason: '규칙에 따른 결과를 확정할 수 없음',
      voidReason: '공식 자료가 철회됨',
    });
    const record = (await detail(first.market.id)).judgingRecord;
    expect(record.versions[0]).toMatchObject({
      version: 2,
      result: 'VOID',
      source: null,
      voidReason: '공식 자료가 철회됨',
      correctionReason: '규칙에 따른 결과를 확정할 수 없음',
    });
    expect(record.versions[1]).toMatchObject({
      source: { priority: 1, name: '대체 발표', url: 'https://example.com/fallback' },
      fallbackReason: '1차 발표가 없어 대체 출처 사용',
    });
  });

  it('counts all dispute statuses/versions while retaining validated decision history after reopening and avoiding duplicate legacy decisions', async () => {
    const { market } = await createProvisionalMarket(t.db);
    const admin = (await createUser(t.db, { role: 'admin' })).user;
    const at = new Date(Date.now() - 1000);
    const dismissed = await createDispute(t.db, {
      marketId: market.id,
      fill: false,
      status: 'dismissed',
      decidedBy: admin.id,
      decidedAt: at,
      submittedAt: new Date(at.getTime() - 1),
      decisionReason: '기각 공개 사유',
      reason: 'private-submission',
      links: ['https://private.example/dispute'],
    });
    const reopened = await createDispute(t.db, {
      marketId: market.id,
      fill: false,
      status: 'pending',
    });
    await createDispute(t.db, {
      marketId: market.id,
      fill: false,
      status: 'accepted',
      decisionReason: '기록 없는 과거 인정',
    });
    await createDispute(t.db, { marketId: market.id, fill: false, status: 'retracted' });
    const foreign = await createDispute(t.db, { fill: false });
    const audit = (
      disputeId: string,
      judgementVersion: number,
      reason: unknown,
      type = 'market_dispute_accept',
      targetId = market.id,
    ) => ({
      adminId: admin.id,
      type,
      targetType: 'market',
      targetId,
      createdAt: at,
      payload: {
        disputeId,
        judgementVersion,
        reason,
        submitterId: 'private-audit-identity',
        links: ['private-audit-link'],
      },
    });
    await t.db
      .insert(schema.adminActions)
      .values([
        audit(dismissed.dispute.id, 1, '기각 공개 사유', 'market_dispute_dismiss'),
        audit(reopened.dispute.id, 1, '재개 전 인정 공개 사유'),
        audit(foreign.dispute.id, 1, 'private-foreign-dispute'),
        audit(reopened.dispute.id, 999, 'private-wrong-version'),
        audit(reopened.dispute.id, 1, { text: 'private-invalid-reason' }),
        audit(
          reopened.dispute.id,
          1,
          'private-wrong-target',
          'market_dispute_accept',
          foreign.market.id,
        ),
      ]);
    await createCorrectedMarket(t.db, { marketId: market.id });
    await createDispute(t.db, { marketId: market.id, fill: false });
    const read = await detail(market.id);
    expect(read.judgingRecord.disputes).toMatchObject({
      total: 5,
      byVersion: [
        {
          judgementVersion: 2,
          total: 1,
          counts: { pending: 1, accepted: 0, dismissed: 0, retracted: 0, closed_by_correction: 0 },
        },
        {
          judgementVersion: 1,
          total: 4,
          counts: { pending: 0, accepted: 1, dismissed: 1, retracted: 1, closed_by_correction: 1 },
        },
      ],
    });
    expect(read.judgingRecord.disputes.decisions).toEqual(
      expect.arrayContaining([
        { judgementVersion: 1, decision: 'dismissed', reason: '기각 공개 사유' },
        { judgementVersion: 1, decision: 'accepted', reason: '재개 전 인정 공개 사유' },
        { judgementVersion: 1, decision: 'accepted', reason: '기록 없는 과거 인정' },
      ]),
    );
    expect(read.judgingRecord.disputes.decisions).toHaveLength(3);
    expect(JSON.stringify(read)).not.toContain('private-');
    for (const id of [
      dismissed.dispute.id,
      reopened.dispute.id,
      dismissed.dispute.userId,
      admin.id,
    ]) {
      expect(JSON.stringify(read)).not.toContain(id);
    }
  });

  it('publishes cancellation reason/time only, excluding internal event payload', async () => {
    const market = await createMarket(t.db, { status: 'cancelled' });
    const at = new Date(Date.now() - HOUR);
    await t.db.insert(schema.marketEvents).values({
      marketId: market.id,
      type: 'cancelled',
      fromStatus: 'closed',
      toStatus: 'cancelled',
      actorId: 'private-actor',
      createdAt: at,
      payload: {
        reason: '참여자 체결이 없어 취소',
        source: 'private-internal-source',
        requestId: 'private-request',
      },
    });
    const read = await detail(market.id);
    expect(read.judgingRecord.cancellation).toEqual({
      reason: '참여자 체결이 없어 취소',
      cancelledAt: at.toISOString(),
    });
    expect(JSON.stringify(read)).not.toContain('private-');
  });

  it('exposes only a payout-delay flag for failures including final-audit failure and clears it after settlement', async () => {
    const market = await createMarket(t.db, { status: 'settling', settlementSteps: false });
    expect((await detail(market.id)).judgingRecord.payoutDelayed).toBe(false);
    await createSettlementStep(t.db, {
      marketId: market.id,
      status: 'failed',
      lastError: 'private-database-error',
    });
    expect((await detail(market.id)).judgingRecord.payoutDelayed).toBe(true);
    await t.db
      .update(schema.marketSettlementSteps)
      .set({ status: 'done', completedAt: new Date(), lastError: 'private-final-audit' })
      .where(eq(schema.marketSettlementSteps.marketId, market.id));
    const failedFinalAudit = await detail(market.id);
    expect(failedFinalAudit.judgingRecord.payoutDelayed).toBe(true);
    expect(JSON.stringify(failedFinalAudit)).not.toContain('private-');
    await t.db
      .update(schema.markets)
      .set({ status: 'settled', settledAt: new Date() })
      .where(eq(schema.markets.id, market.id));
    expect((await detail(market.id)).judgingRecord.payoutDelayed).toBe(false);
  });

  it('shows a reconciliation hold as payout delay without exposing its findings or account', async () => {
    const market = await createMarket(t.db, { status: 'settling' });
    const owner = (await createUser(t.db)).user;
    // Deliberately unexplained quantity gives the actual auditor a permanent hold.
    await createPosition(t.db, { marketId: market.id, userId: owner.id, outcome: 'YES', qty: 1 });
    const result = await t.db.transaction((tx) =>
      runMarketReconciliation(tx, market.id, { source: 'manual' }),
    );
    expect(result.hold).not.toBeNull();
    const read = await detail(market.id);
    expect(read.judgingRecord.payoutDelayed).toBe(true);
    expect(JSON.stringify(read)).not.toContain(owner.id);
    expect(JSON.stringify(read)).not.toContain(result.hold!.id);
    expect(read.judgingRecord).not.toHaveProperty('findings');
  });

  it('uses the market snapshot for all records when a correction commits during the read', async () => {
    const { market } = await createProvisionalMarket(t.db);
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(recordReader, 'readMarketJudgingRecord').mockImplementationOnce(async (...args) => {
      signalEntered();
      await released;
      return actualRead(...args);
    });
    const reading = detail(market.id);
    try {
      await entered;
      await createCorrectedMarket(t.db, { marketId: market.id });
    } finally {
      release();
    }
    const before = await reading;
    expect(before.judgementVersion).toBe(1);
    expect(before.judgingRecord.versions.map((row) => row.version)).toEqual([1]);
    const after = await detail(market.id);
    expect(after.judgementVersion).toBe(2);
    expect(after.judgingRecord.versions.map((row) => row.version)).toEqual([2, 1]);
  });
});
