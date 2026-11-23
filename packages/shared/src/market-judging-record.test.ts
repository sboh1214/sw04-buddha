import { describe, expect, it } from 'vitest';
import {
  marketJudgingRecordSchema,
  publicMarketJudgementCorrectionSchema,
  publicMarketPauseSchema,
} from './market-judging-record.js';

const at = '2026-11-09T00:00:00.000Z';

describe('public judging record', () => {
  it('keeps the public pause facts when a legacy note is withheld', () => {
    expect(
      publicMarketPauseSchema.parse({
        reason: 'early_result',
        note: null,
        resultPublishedAt: at,
        pausedAt: at,
        reviewResult: null,
        endKind: 'closed_at_close',
        endedAt: at,
      }),
    ).toMatchObject({ note: null, reason: 'early_result', resultPublishedAt: at, endedAt: at });
  });

  it('keeps public grounds while removing identities, approvals, dispute bodies and internal errors', () => {
    const record = marketJudgingRecordSchema.parse({
      versions: [
        {
          version: 2,
          result: 'NO',
          source: { priority: 0, name: '출처', url: 'https://example.com' },
          fallbackReason: null,
          voidReason: null,
          evidence: {
            links: ['https://example.com/result'],
            collectedAt: at,
            internalMemo: 'private',
          },
          description: '공식 발표를 확인했다.',
          ruleVersion: 1,
          publishedAt: at,
          disputeDeadline: at,
          correctionReason: '발표가 정정되었다.',
          registeredBy: { id: 'private' },
          approvedBy: { id: 'private' },
          approvalReason: 'private',
        },
      ],
      pauses: [
        {
          reason: 'early_result',
          note: '결과가 먼저 발표되었다.',
          resultPublishedAt: at,
          pausedAt: at,
          reviewResult: null,
          endKind: null,
          endedAt: null,
          id: 'private',
          pausedBy: 'private',
          approvalReason: 'private',
        },
      ],
      delays: [
        {
          reason: '발표 대기',
          nextReviewAt: at,
          current: true,
          recordedAt: at,
          recordedBy: 'private',
          id: 'private',
        },
      ],
      disputes: {
        total: 1,
        byVersion: [
          {
            judgementVersion: 1,
            total: 1,
            counts: {
              pending: 1,
              accepted: 0,
              dismissed: 0,
              retracted: 0,
              closed_by_correction: 0,
            },
          },
        ],
        decisions: [
          {
            judgementVersion: 1,
            decision: 'accepted',
            reason: '재검토가 필요하다.',
            disputeId: 'private',
            submitterId: 'private',
            decidedBy: 'private',
            decisionAt: at,
          },
        ],
        submissions: [{ reason: 'private', links: ['private'] }],
      },
      cancellation: null,
      payoutDelayed: true,
      lastError: 'private',
      correction: null,
    });
    expect(record.versions[0]?.correctionReason).toBe('발표가 정정되었다.');
    expect(record.disputes.decisions).toEqual([
      { judgementVersion: 1, decision: 'accepted', reason: '재검토가 필요하다.' },
    ]);
    expect(JSON.stringify(record)).not.toContain('private');
    expect(record.delays).toEqual([{ reason: '발표 대기', nextReviewAt: at, current: true }]);
  });

  it('publishes a 판정 정정 by its allowlist alone: no identity, no reviewer reason (#144, 144-5)', () => {
    const correction = {
      result: 'NO',
      originalResult: 'YES',
      judgementVersion: 1,
      confirmedAt: at,
      description: '발표 원문의 수치를 잘못 읽었다.',
      evidence: { links: ['https://example.com/source'], collectedAt: at, memo: 'private' },
      // What the admin record has and the public one must not carry (#173 item 13).
      incidentId: 'private',
      requestId: 'private',
      registeredBy: { id: 'private', nickname: 'private' },
      confirmedBy: { id: 'private', nickname: 'private' },
      paidRegisteredBy: 'private',
      reason: 'private',
      registeredAt: at,
      appliedTxid: 'private',
    };
    const parsed = publicMarketJudgementCorrectionSchema.parse(correction);
    expect(parsed).toEqual({
      result: 'NO',
      originalResult: 'YES',
      judgementVersion: 1,
      confirmedAt: at,
      description: '발표 원문의 수치를 잘못 읽었다.',
      evidence: { links: ['https://example.com/source'], collectedAt: at },
    });
    expect(JSON.stringify(parsed)).not.toContain('private');
    expect(Object.keys(publicMarketJudgementCorrectionSchema.shape).sort()).toEqual([
      'confirmedAt',
      'description',
      'evidence',
      'judgementVersion',
      'originalResult',
      'result',
    ]);
    // A record carries it, or null, and never leaves it out.
    const base = {
      versions: [],
      pauses: [],
      delays: [],
      disputes: {
        total: 0,
        byVersion: [],
        decisions: [],
      },
      cancellation: null,
      payoutDelayed: false,
    };
    expect(marketJudgingRecordSchema.safeParse(base).success).toBe(false);
    expect(marketJudgingRecordSchema.parse({ ...base, correction: null }).correction).toBeNull();
    expect(marketJudgingRecordSchema.parse({ ...base, correction }).correction).toEqual(parsed);
    expect(
      publicMarketJudgementCorrectionSchema.safeParse({ ...correction, result: 'MAYBE' }).success,
    ).toBe(false);
  });
});
