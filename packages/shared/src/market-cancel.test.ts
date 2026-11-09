import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  APPROVAL_KIND_MAX_LENGTH,
  APPROVAL_KIND_PATTERN,
  APPROVAL_REASON_MAX_LENGTH,
  APPROVAL_REFUSALS,
} from './approvals.js';
import { MARKET_EVENT_TYPES, MARKET_RESULTS } from './enums.js';
import { expectedAccountBodySchema } from './expected-account.js';
import { findExcludedIdentifier, findExcludedText } from './guards/excluded.js';
import * as shared from './index.js';
import {
  MARKET_CANCEL_APPROVAL_KIND,
  MARKET_CANCEL_REFUSALS,
  MARKET_CANCEL_SOURCES,
  MARKET_NO_FILL_CANCEL_REASON,
  adminMarketCancelItemSchema,
  adminMarketCancelStateSchema,
  approveMarketCancelBodySchema,
  marketCancelLogEntrySchema,
  marketCancelRequestPayloadSchema,
  marketCancelRequestSchema,
  marketCancelledPayloadSchema,
  rejectMarketCancelBodySchema,
  requestMarketCancelBodySchema,
  retractMarketCancelBodySchema,
} from './market-cancel.js';
import { MARKET_LIFECYCLE_TRANSITIONS, canTransitionMarket } from './market-lifecycle.js';
import { marketRejectReason } from './orders.js';

const at = '2026-11-08T00:00:00.000Z';
const account = 'admin-1';
const requestId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const marketId = '9b2e1f4c-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const pauseId = '6c1d2e3f-4a5b-4c6d-9e7f-8091a2b3c4d5';
const requester = { id: 'admin-1', nickname: '운영자1' };
const approver = { id: 'admin-2', nickname: null };

const paths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

describe('거래 없는 시장의 취소 (#20, ADR-0107 결정 5)', () => {
  it('names its approval kind like every consumer, refused with no decider', () => {
    expect(MARKET_CANCEL_APPROVAL_KIND).toBe('market_cancel');
    expect(APPROVAL_KIND_PATTERN.test(MARKET_CANCEL_APPROVAL_KIND)).toBe(true);
    expect(MARKET_CANCEL_APPROVAL_KIND.length).toBeLessThanOrEqual(APPROVAL_KIND_MAX_LENGTH);
    expect(APPROVAL_REFUSALS).toContain('no_decider');
  });

  it('reaches CANCELLED from SCHEDULED, OPEN and PAUSED only, never from CLOSED', () => {
    expect(
      Object.entries(MARKET_LIFECYCLE_TRANSITIONS)
        .filter(([, to]) => (to as readonly string[]).includes('cancelled'))
        .map(([from]) => from),
    ).toEqual(['scheduled', 'open', 'paused']);
    expect(canTransitionMarket('closed', 'cancelled')).toBe(false);
    expect(MARKET_LIFECYCLE_TRANSITIONS.cancelled).toEqual([]);
    // One event type for the three paths; a new order on it is refused 마감 (#177 8항's nine).
    expect(MARKET_EVENT_TYPES).toContain('cancelled');
    expect(marketRejectReason('cancelled')).toBe('closed');
    expect(MARKET_CANCEL_SOURCES).toEqual(['job', 'early_close', 'operator']);
  });

  it('stores one system sentence for both automatic cancels, with no excluded word', () => {
    expect(MARKET_NO_FILL_CANCEL_REASON.trim()).toBe(MARKET_NO_FILL_CANCEL_REASON);
    expect(MARKET_NO_FILL_CANCEL_REASON.length).toBeLessThanOrEqual(APPROVAL_REASON_MAX_LENGTH);
    expect(findExcludedText(MARKET_NO_FILL_CANCEL_REASON)).toEqual([]);
    // A public sentence never hints that accounts other than people's trade, nor names a result.
    expect(MARKET_NO_FILL_CANCEL_REASON).not.toContain('사용자');
    for (const result of MARKET_RESULTS) {
      expect(MARKET_NO_FILL_CANCEL_REASON).not.toContain(result);
    }
  });

  it('names its refusals apart under each path', () => {
    expect(MARKET_CANCEL_REFUSALS).toEqual({
      status: { notScheduled: 'not scheduled' },
      cancel: { pending: 'pending', stale: 'stale' },
    });
  });

  it('stores and answers names no excluded feature reads', () => {
    for (const name of [
      MARKET_CANCEL_APPROVAL_KIND,
      ...MARKET_CANCEL_SOURCES,
      'cancelled',
      'cancelledAt',
      'statusEventId',
      'market_cancel_request',
      'market_cancel_approve',
      'market_cancel_reject',
      'market_cancel_retract',
    ]) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
      expect(findExcludedIdentifier(name, 'storage'), name).toEqual([]);
    }
  });
});

describe('the cancel bodies', () => {
  it('take a request, an approval and a 반려 each with a trimmed reason and the account', () => {
    for (const schema of [
      requestMarketCancelBodySchema,
      approveMarketCancelBodySchema,
      rejectMarketCancelBodySchema,
    ]) {
      expect(
        schema.parse({ reason: ' 결과가 이미 정해졌다 ', expectedAccountId: account }),
      ).toEqual({
        reason: '결과가 이미 정해졌다',
        expectedAccountId: account,
      });
      for (const reason of ['', ' ', 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1), undefined]) {
        expect(paths(schema.safeParse({ reason, expectedAccountId: account }))).toEqual(['reason']);
      }
      expect(paths(schema.safeParse({ reason: '확인함' }))).toEqual(['expectedAccountId']);
    }
  });

  it('take a 철회 with the account alone', () => {
    expect(retractMarketCancelBodySchema).toBe(expectedAccountBodySchema);
    expect(retractMarketCancelBodySchema.parse({ expectedAccountId: account })).toEqual({
      expectedAccountId: account,
    });
  });
});

describe('the cancel records and read models', () => {
  it('store the request payload: the status event it pins', () => {
    expect(marketCancelRequestPayloadSchema.parse({ statusEventId: 12 })).toEqual({
      statusEventId: 12,
    });
    for (const statusEventId of [0, -1, 1.5, '12', undefined]) {
      expect(paths(marketCancelRequestPayloadSchema.safeParse({ statusEventId }))).toEqual([
        'statusEventId',
      ]);
    }
  });

  it('parse the cancelled event’s payload by its source', () => {
    const job = { cancelledAt: at, source: 'job', reason: MARKET_NO_FILL_CANCEL_REASON };
    const early = {
      cancelledAt: at,
      source: 'early_close',
      reason: MARKET_NO_FILL_CANCEL_REASON,
      pauseId,
      approvalId: requestId,
      requestedBy: 'admin-1',
      reviewResult: 'not_judgeable',
    };
    const operator = {
      cancelledAt: at,
      source: 'operator',
      reason: '사건이 개장 전에 끝났다.',
      approvalId: requestId,
      requestedBy: 'admin-1',
    };
    for (const payload of [job, early, { ...early, reviewResult: null }, operator]) {
      expect(marketCancelledPayloadSchema.parse(payload)).toEqual(payload);
    }
    expect(marketCancelledPayloadSchema.safeParse({ ...job, source: 'close' }).success).toBe(false);
    const { pauseId: _pauseId, ...earlyWithoutPause } = early;
    expect(paths(marketCancelledPayloadSchema.safeParse(earlyWithoutPause))).toEqual(['pauseId']);
    const { approvalId: _approvalId, ...operatorWithoutApproval } = operator;
    expect(paths(marketCancelledPayloadSchema.safeParse(operatorWithoutApproval))).toEqual([
      'approvalId',
    ]);
  });

  it('show the waiting request, every request with how it ended, and the queue', () => {
    const pending = {
      requestId,
      reason: '사건이 개장 전에 끝났다.',
      requestedBy: requester,
      requestedAt: at,
    };
    const undecided = { decidedBy: null, decidedAt: null, decisionReason: null, retractedAt: null };
    expect(marketCancelRequestSchema.parse(pending)).toEqual(pending);
    const waiting = { ...pending, status: 'pending', ...undecided };
    const approved = {
      ...pending,
      status: 'approved',
      ...undecided,
      decidedBy: approver,
      decidedAt: at,
      decisionReason: '확인함',
    };
    const rejected = { ...approved, status: 'rejected', decisionReason: '아직 열 수 있다' };
    const retracted = { ...pending, status: 'retracted', ...undecided, retractedAt: at };
    for (const entry of [waiting, approved, rejected, retracted]) {
      expect(marketCancelLogEntrySchema.parse(entry)).toEqual(entry);
    }
    const state = { pending, log: [waiting, retracted] };
    expect(adminMarketCancelStateSchema.parse(state)).toEqual(state);
    const none = { pending: null, log: [] };
    expect(adminMarketCancelStateSchema.parse(none)).toEqual(none);
    const item = {
      requestId,
      marketId,
      slug: 'kospi-3000',
      title: '2026년 안에 코스피 3000?',
      status: 'scheduled',
      scheduledOpenAt: at,
      closeAt: at,
      reason: '사건이 개장 전에 끝났다.',
      requestedBy: requester,
      requestedAt: at,
    };
    expect(adminMarketCancelItemSchema.parse(item)).toEqual(item);
    expect(adminMarketCancelItemSchema.parse({ ...item, scheduledOpenAt: null })).toEqual({
      ...item,
      scheduledOpenAt: null,
    });
    expect(paths(adminMarketCancelItemSchema.safeParse({ ...item, status: 'gone' }))).toEqual([
      'status',
    ]);
  });
});

describe('the OpenAPI component ids of the cancel', () => {
  it('are each named once and convert with the admin market', () => {
    const ids = new Set<string>();
    for (const value of Object.values(shared)) {
      if (!(value instanceof z.ZodType)) continue;
      const id = z.globalRegistry.get(value)?.id;
      if (id !== undefined) ids.add(id);
    }
    for (const id of [
      'RequestMarketCancelBody',
      'ApproveMarketCancelBody',
      'RejectMarketCancelBody',
      'MarketCancelRequest',
      'MarketCancelLogEntry',
      'AdminMarketCancelState',
      'AdminMarketCancelItem',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    expect(() =>
      z.toJSONSchema(
        z.object({
          market: shared.adminMarketSchema,
          request: requestMarketCancelBodySchema,
          approve: approveMarketCancelBodySchema,
          reject: rejectMarketCancelBodySchema,
          queue: adminMarketCancelItemSchema,
        }),
      ),
    ).not.toThrow();
  });
});
