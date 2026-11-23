import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  OPERATIONS_CLOSING_WINDOWS,
  OPERATIONS_CLOSING_WINDOW_DEFAULT,
  OPERATIONS_CLOSING_WINDOW_HOURS,
  OPERATIONS_FAILURE_KINDS,
  OPERATIONS_JUDGEMENT_FILTERS,
  OPERATIONS_JUDGEMENT_STAGES,
  OPERATIONS_RECALL_FAILURE_REASONS,
  OPERATIONS_STUCK_AFTER_MINUTES,
  OPERATIONS_STUCK_STAGES,
  adminAwaitingJudgementMarketSchema,
  adminClosingMarketSchema,
  adminOperationsClosingQuerySchema,
  adminOperationsFailurePageSchema,
  adminOperationsFailureSchema,
  adminOperationsFailuresQuerySchema,
  adminOperationsJudgementsQuerySchema,
  adminSettlementRetryBodySchema,
  adminSettlementRetryResultSchema,
  type AdminOperationsFailure,
} from './admin-operations.js';
import { APPROVAL_REASON_MAX_LENGTH } from './approvals.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import * as shared from './index.js';

const MARKET = '0b6c1f5e-6e0c-4b8f-9a3d-2f1e4c5d6a7b';
const REQUEST = '1c7d2a6f-7f1d-4c9a-8b4e-3a2f5d6e7b8c';
const AT = '2026-11-23T03:00:00.000Z';

describe('운영 대기열 constants (#145, ADR-0163)', () => {
  it('offers 24시간·3일·7일 as N × 24 hours, 24시간 first (145-1)', () => {
    expect(OPERATIONS_CLOSING_WINDOWS).toEqual(['24h', '3d', '7d']);
    expect(OPERATIONS_CLOSING_WINDOW_HOURS).toEqual({ '24h': 24, '3d': 72, '7d': 168 });
    expect(OPERATIONS_CLOSING_WINDOW_DEFAULT).toBe('24h');
  });

  it('fixes 처리 멈춤 at 30 minutes over the four automatic transitions (145-4)', () => {
    expect(OPERATIONS_STUCK_AFTER_MINUTES).toBe(30);
    expect(OPERATIONS_STUCK_STAGES).toEqual(['close', 'confirm', 'start', 'complete']);
  });

  it('names the stages, filters, kinds and recall codes of the lists (145-2, 145-11, 145-15)', () => {
    expect(OPERATIONS_JUDGEMENT_FILTERS).toEqual(['all', 'delayed']);
    expect(OPERATIONS_JUDGEMENT_STAGES).toEqual([
      'unregistered',
      'awaiting_approval',
      'dispute_or_correction',
    ]);
    // The index is the list's tie-break (`kindOrder`).
    expect(OPERATIONS_FAILURE_KINDS).toEqual(['settlement_failed', 'stuck', 'recall_failed']);
    // Failed only: the waiting `ledger_hold`·`treasury_capacity` are not listed (145-15).
    expect(OPERATIONS_RECALL_FAILURE_REASONS).toEqual([
      'books_inconsistent',
      'recall_inconsistent',
      'execution_failed',
    ]);
  });

  it('names nothing an excluded feature names (`kindOrder`, never a rank)', () => {
    const names = [
      ...OPERATIONS_CLOSING_WINDOWS,
      ...OPERATIONS_JUDGEMENT_FILTERS,
      ...OPERATIONS_JUDGEMENT_STAGES,
      ...OPERATIONS_FAILURE_KINDS,
      ...OPERATIONS_STUCK_STAGES,
      'kindOrder',
      'market_settlement_retry',
      'settlement-retries',
      'operations',
      ...Object.keys(adminAwaitingJudgementMarketSchema.shape),
      ...Object.keys(adminClosingMarketSchema.shape),
      'settlementLastError',
      'settlementAttempts',
      'recallAttempts',
      'recallReason',
      'retryable',
      'since',
    ];
    for (const name of names) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
      expect(findExcludedIdentifier(name, 'route'), name).toEqual([]);
    }
  });

  it('keeps the admin-only fields private (PRIVATE_DATA `operation-records`)', () => {
    for (const name of ['settlementLastError', 'settlementAttempts', 'recallAttempts']) {
      expect(
        findPrivateField(name).map((hit) => hit.item),
        name,
      ).toContain('operation-records');
    }
  });
});

describe('운영 대기열 queries', () => {
  it('defaults the window to 24h and the filter to all, and refuses other values', () => {
    expect(adminOperationsClosingQuerySchema.parse({})).toEqual({ limit: 20, within: '24h' });
    expect(adminOperationsClosingQuerySchema.parse({ within: '7d', limit: '5' })).toEqual({
      limit: 5,
      within: '7d',
    });
    expect(adminOperationsClosingQuerySchema.safeParse({ within: '30d' }).success).toBe(false);
    expect(adminOperationsJudgementsQuerySchema.parse({})).toEqual({ limit: 20, filter: 'all' });
    expect(adminOperationsJudgementsQuerySchema.parse({ filter: 'delayed' }).filter).toBe(
      'delayed',
    );
    expect(adminOperationsJudgementsQuerySchema.safeParse({ filter: 'late' }).success).toBe(false);
    expect(adminOperationsFailuresQuerySchema.parse({ cursor: 'x' })).toEqual({
      cursor: 'x',
      limit: 20,
    });
  });

  it('carries no component id on the extended queries (swagger expands them)', () => {
    for (const schema of [
      adminOperationsClosingQuerySchema,
      adminOperationsJudgementsQuerySchema,
    ]) {
      expect(z.globalRegistry.get(schema)?.id).toBeUndefined();
    }
  });
});

describe('정산 다시 시도 body and answer (145-7)', () => {
  it('takes a trimmed 1–500 reason and the account on screen, and strips everything else', () => {
    expect(
      adminSettlementRetryBodySchema.parse({
        reason: '  대사 보류 복구 승인 뒤 다시 지급  ',
        expectedAccountId: 'admin-1',
        skipReconciliation: true,
        payout: 1,
        status: 'settled',
      }),
    ).toEqual({ reason: '대사 보류 복구 승인 뒤 다시 지급', expectedAccountId: 'admin-1' });
    expect(Object.keys(adminSettlementRetryBodySchema.shape).sort()).toEqual([
      'expectedAccountId',
      'reason',
    ]);
    for (const reason of ['', '   ', 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1)]) {
      expect(
        adminSettlementRetryBodySchema.safeParse({ reason, expectedAccountId: 'a' }).success,
      ).toBe(false);
    }
    expect(
      adminSettlementRetryBodySchema.safeParse({
        reason: 'x'.repeat(APPROVAL_REASON_MAX_LENGTH),
        expectedAccountId: 'a',
      }).success,
    ).toBe(true);
    expect(adminSettlementRetryBodySchema.safeParse({ reason: '사유' }).success).toBe(false);
  });

  it('answers settled with the event id, or failed with the step read back (nullable)', () => {
    expect(
      adminSettlementRetryResultSchema.parse({ outcome: 'settled', statusEventId: '42' }),
    ).toEqual({ outcome: 'settled', statusEventId: '42' });
    for (const failed of [
      { outcome: 'failed', settlementLastError: 'boom', settlementAttempts: 3 },
      { outcome: 'failed', settlementLastError: null, settlementAttempts: null },
    ]) {
      expect(adminSettlementRetryResultSchema.parse(failed)).toEqual(failed);
    }
    expect(adminSettlementRetryResultSchema.safeParse({ outcome: 'skipped' }).success).toBe(false);
  });
});

describe('운영 대기열 rows', () => {
  it('parses each failure kind and refuses a recall row with a waiting code', () => {
    const base = { id: MARKET, slug: 's', title: 't', since: AT };
    const rows: AdminOperationsFailure[] = [
      {
        ...base,
        status: 'settling',
        kind: 'settlement_failed',
        retryable: true,
        settlement: {
          stepStatus: 'failed',
          settlementAttempts: 2,
          settlementLastError: 'XX000 boom',
          lastAttemptAt: AT,
          ledgerHeld: false,
        },
      },
      { ...base, status: 'resolved', kind: 'stuck', retryable: false, stage: 'start' },
      { ...base, status: 'settling', kind: 'stuck', retryable: true, stage: 'complete' },
      {
        ...base,
        status: 'settled',
        kind: 'recall_failed',
        retryable: false,
        recall: { recallAttempts: 3, recallReason: 'execution_failed', lastFailureAt: AT },
      },
    ];
    expect(
      adminOperationsFailurePageSchema.parse({ data: rows, meta: { nextCursor: null } }),
    ).toEqual({ data: rows, meta: { nextCursor: null } });
    expect(
      adminOperationsFailureSchema.safeParse({
        ...rows[3],
        recall: { recallAttempts: 1, recallReason: 'ledger_hold', lastFailureAt: null },
      }).success,
    ).toBe(false);
    expect(adminOperationsFailureSchema.safeParse({ ...rows[0], retryable: false }).success).toBe(
      false,
    );
  });

  it('parses a judgement row with its current delay record', () => {
    const row = {
      id: MARKET,
      slug: 's',
      title: 't',
      status: 'closed',
      stage: 'awaiting_approval',
      closeAt: AT,
      scheduledJudgementAt: AT,
      disputeDeadline: null,
      judgementRequestId: REQUEST,
      holdingDisputes: 0,
      correctionPending: false,
      delay: { reason: '출처 발표가 늦어집니다.', nextReviewAt: AT, recordedAt: AT },
      reviewOverdue: true,
      longDelayDeadline: AT,
      longDelayReached: false,
      delayed: true,
    } as const;
    expect(adminAwaitingJudgementMarketSchema.parse(row)).toEqual(row);
    expect(
      adminClosingMarketSchema.parse({
        id: MARKET,
        slug: 's',
        title: 't',
        status: 'paused',
        closeAt: AT,
        scheduledJudgementAt: null,
        overdue: true,
      }).overdue,
    ).toBe(true);
  });

  it('registers each component once and converts to JSON Schema', () => {
    const ids = new Set<string>();
    for (const value of Object.values(shared)) {
      if (!(value instanceof z.ZodType)) continue;
      const id = z.globalRegistry.get(value)?.id;
      if (id !== undefined) ids.add(id);
    }
    for (const id of [
      'AdminClosingMarket',
      'AdminAwaitingJudgementMarket',
      'AdminOperationsJudgementDelay',
      'AdminOperationsSettlement',
      'AdminOperationsSettlementFailure',
      'AdminOperationsStuck',
      'AdminOperationsRecallFailure',
      'AdminOperationsFailure',
      'AdminSettlementRetryBody',
      'AdminSettlementRetryResult',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    expect(() =>
      z.toJSONSchema(
        z.object({
          closing: adminClosingMarketSchema,
          judgement: adminAwaitingJudgementMarketSchema,
          failure: adminOperationsFailureSchema,
          body: adminSettlementRetryBodySchema,
          result: adminSettlementRetryResultSchema,
        }),
      ),
    ).not.toThrow();
  });
});
