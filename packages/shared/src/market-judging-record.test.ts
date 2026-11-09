import { describe, expect, it } from 'vitest';
import { marketJudgingRecordSchema, publicMarketPauseSchema } from './market-judging-record.js';

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
    });
    expect(record.versions[0]?.correctionReason).toBe('발표가 정정되었다.');
    expect(record.disputes.decisions).toEqual([
      { judgementVersion: 1, decision: 'accepted', reason: '재검토가 필요하다.' },
    ]);
    expect(JSON.stringify(record)).not.toContain('private');
    expect(record.delays).toEqual([{ reason: '발표 대기', nextReviewAt: at, current: true }]);
  });
});
