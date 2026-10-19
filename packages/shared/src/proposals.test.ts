import { describe, expect, it } from 'vitest';
import { PROPOSAL_STATUSES, type ProposalStatus } from './enums.js';
import {
  PENDING_PROPOSAL_STATUSES,
  PROPOSAL_BACKGROUND_MAX,
  PROPOSAL_LIMITS,
  PROPOSAL_SOURCES_MAX,
  adoptProposalBodySchema,
  canMoveProposal,
  createProposalBodySchema,
  isProposalDeadlineOpen,
  proposalDraftCloseAt,
  proposalInternalMemoBodySchema,
  proposalLimitedDetailsSchema,
  rejectProposalBodySchema,
} from './proposals.js';

const form = {
  question: '2027년 기준금리가 3% 아래로 내려갈까?',
  deadline: '2027-12-31',
  yesCondition: '한국은행 발표에서 3% 미만이면 YES',
  expectedSources: '한국은행 보도자료',
  expectedAccountId: 'user-1',
};

describe('createProposalBodySchema (#77)', () => {
  it('takes the four required fields and trims them; the background and category are optional', () => {
    expect(createProposalBodySchema.parse({ ...form, question: `  ${form.question}  ` })).toEqual(
      form,
    );
    expect(
      createProposalBodySchema.parse({ ...form, background: ' 배경 ', categoryId: 3 }),
    ).toMatchObject({ background: '배경', categoryId: 3 });
  });

  it('holds the owner’s lengths and the date shape', () => {
    const ok = (overrides: Record<string, unknown>) =>
      createProposalBodySchema.safeParse({ ...form, ...overrides }).success;
    expect(ok({ question: '가'.repeat(100) })).toBe(true);
    expect(ok({ question: '가'.repeat(101) })).toBe(false);
    expect(ok({ question: '   ' })).toBe(false);
    expect(ok({ yesCondition: '가'.repeat(1_000) })).toBe(true);
    expect(ok({ yesCondition: '가'.repeat(1_001) })).toBe(false);
    // Blank once trimmed: the table's CHECK would refuse it with a 500 instead.
    expect(ok({ yesCondition: '   ' })).toBe(false);
    expect(ok({ expectedSources: '   ' })).toBe(false);
    expect(ok({ background: '가'.repeat(PROPOSAL_BACKGROUND_MAX) })).toBe(true);
    expect(ok({ background: '가'.repeat(PROPOSAL_BACKGROUND_MAX + 1) })).toBe(false);
    expect(ok({ expectedSources: '가'.repeat(PROPOSAL_SOURCES_MAX) })).toBe(true);
    expect(ok({ expectedSources: '가'.repeat(PROPOSAL_SOURCES_MAX + 1) })).toBe(false);
    expect(ok({ expectedSources: '' })).toBe(false);
    expect(ok({ deadline: '2027-02-30' })).toBe(false);
    expect(ok({ deadline: '2027-12-31T00:00:00Z' })).toBe(false);
    expect(ok({ categoryId: 0 })).toBe(false);
    expect(ok({ expectedAccountId: '' })).toBe(false);
  });

  it('has no probability field: one sent is dropped, never kept (N02 §10)', () => {
    const parsed = createProposalBodySchema.parse({ ...form, probability: 70 });
    expect(parsed).not.toHaveProperty('probability');
    expect(Object.keys(createProposalBodySchema.shape).some((key) => /probab/i.test(key))).toBe(
      false,
    );
  });
});

describe('the statuses (#77)', () => {
  it('moves 접수 → 검토 → 채택·반려, 접수 → 반려 and 접수 → 철회 only', () => {
    const moves = PROPOSAL_STATUSES.flatMap((from) =>
      PROPOSAL_STATUSES.filter((to) => canMoveProposal(from, to)).map((to) => `${from}→${to}`),
    );
    expect(moves.sort()).toEqual(
      [
        'submitted→reviewing',
        'submitted→rejected',
        'submitted→retracted',
        'reviewing→adopted',
        'reviewing→rejected',
      ].sort(),
    );
    for (const final of ['adopted', 'rejected', 'retracted'] as ProposalStatus[]) {
      expect(PROPOSAL_STATUSES.some((to) => canMoveProposal(final, to))).toBe(false);
    }
    expect(PENDING_PROPOSAL_STATUSES).toEqual(['submitted', 'reviewing']);
    expect(PROPOSAL_LIMITS).toMatchObject({ pendingProposals: 5, dailyProposals: 3 });
  });
});

describe('the date (#77)', () => {
  it('opens today in Korea and later, whatever the UTC date', () => {
    // 2027-03-01 00:30 in Korea is still 2027-02-28 in UTC.
    const now = new Date('2027-02-28T15:30:00.000Z');
    expect(isProposalDeadlineOpen('2027-03-01', now)).toBe(true);
    expect(isProposalDeadlineOpen('2027-03-02', now)).toBe(true);
    expect(isProposalDeadlineOpen('2027-02-28', now)).toBe(false);
  });

  it('starts a draft closing at 00:00 in Korea of the date', () => {
    expect(proposalDraftCloseAt('2027-03-01').toISOString()).toBe('2027-02-28T15:00:00.000Z');
  });
});

describe('the operators’ bodies (#77)', () => {
  it('rejects with a reason and an explanation, and a market for a 중복 only', () => {
    const ok = (body: Record<string, unknown>) => rejectProposalBodySchema.safeParse(body);
    const market = '7C0B4D3E-2E8A-4C4B-9F7E-0E5A2B9C1D11';
    const duplicate = ok({ reason: 'duplicate', explanation: '중복', duplicateMarketId: market });
    expect(duplicate.success && duplicate.data.duplicateMarketId).toBe(market.toLowerCase());
    for (const body of [
      { reason: 'duplicate', explanation: '중복' },
      { reason: 'other', explanation: '기타', duplicateMarketId: market },
      { reason: 'other', explanation: '  ' },
      { reason: 'spam', explanation: '설명' },
    ]) {
      const parsed = ok(body);
      expect(parsed.success, JSON.stringify(body)).toBe(false);
    }
    const missing = ok({ reason: 'duplicate', explanation: '중복' });
    expect(missing.success ? [] : missing.error.issues.map((issue) => issue.path)).toEqual([
      ['duplicateMarketId'],
    ]);
    expect(ok({ reason: 'prohibited_topic', explanation: '개설 금지 주제' }).success).toBe(true);
  });

  it('adopts with an optional memo and a draft, an existing market or none', () => {
    expect(adoptProposalBodySchema.parse({})).toEqual({});
    expect(
      adoptProposalBodySchema.parse({ memo: ' 메모 ', market: { type: 'draft', categoryId: 2 } }),
    ).toEqual({ memo: '메모', market: { type: 'draft', categoryId: 2 } });
    expect(
      adoptProposalBodySchema.safeParse({ market: { type: 'existing', marketId: 'x' } }).success,
    ).toBe(false);
    expect(adoptProposalBodySchema.safeParse({ market: { type: 'open' } }).success).toBe(false);
  });

  it('keeps an internal memo or clears it', () => {
    expect(proposalInternalMemoBodySchema.parse({ memo: null })).toEqual({ memo: null });
    expect(proposalInternalMemoBodySchema.safeParse({ memo: '가'.repeat(1_001) }).success).toBe(
      false,
    );
  });

  it('describes a limit refusal: pending with no time, daily with one', () => {
    expect(
      proposalLimitedDetailsSchema.parse({ reason: 'pending', limit: 5, retryAfterSeconds: null }),
    ).toMatchObject({ reason: 'pending' });
    expect(
      proposalLimitedDetailsSchema.safeParse({ reason: 'daily', limit: 3, retryAfterSeconds: 0 })
        .success,
    ).toBe(false);
  });
});
