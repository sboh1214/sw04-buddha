import {
  PROPOSAL_BACKGROUND_MAX,
  PROPOSAL_LIMITS,
  PROPOSAL_NOTE_MAX,
  PROPOSAL_QUESTION_MAX,
  PROPOSAL_REJECTION_REASONS,
  PROPOSAL_SOURCES_MAX,
  PROPOSAL_STATUSES,
  PROPOSAL_YES_CONDITION_MAX,
  adoptProposalBodySchema,
  createProposalBodySchema,
  linkProposalMarketBodySchema,
  isProposalDeadlineOpen,
  rejectProposalBodySchema,
  type ProposalStatus,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type Category } from './api';
import { groupCategories } from './category-tree';
import { formatKst } from './datetime';
import { isPrivateQueryKey } from './market-keys';
import { MY_TABS, isMyTabCurrent, myLoginPath } from './my';
import {
  ADMIN_PROPOSALS_KEY,
  ADMIN_PROPOSAL_KEY,
  EMPTY_ADOPT_FORM,
  EMPTY_LINK_FORM,
  EMPTY_PROPOSAL_FORM,
  EMPTY_REJECT_FORM,
  MY_PROPOSALS_KEY,
  MY_PROPOSALS_PATH,
  NEW_PROPOSAL_LOGIN_PATH,
  NEW_PROPOSAL_PATH,
  PROPOSAL_REJECTION_REASON_LABEL,
  PROPOSAL_STATUS_LABEL,
  PROPOSAL_STATUS_TIME_LABEL,
  type ProposalFormValues,
  adminProposalActions,
  adminProposalFailure,
  adminProposalKey,
  adminProposalsKey,
  adoptProposalFormSchema,
  canRetractProposal,
  draftCategoryView,
  formatProposalDate,
  issueMessage,
  issuePath,
  koreanToday,
  linkProposalMarketFormSchema,
  proposalActorName,
  proposalCategoryFitsDraft,
  proposalFailure,
  proposalFormSchema,
  proposalIdParam,
  rejectProposalFormSchema,
  retractFailureMessage,
  retiredWishLine,
  toAdoptProposalBody,
  toCreateProposalBody,
  toLinkProposalMarketBody,
  toRejectProposalBody,
} from './proposals';

/** 2026-10-19 12:00 in Korea (03:00 UTC). */
const NOON_KST = new Date('2026-10-19T03:00:00.000Z');

const refused = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);
const invalid = (path: string[], message = 'invalid') =>
  refused(400, 'VALIDATION_ERROR', [{ path, message }]);
const missing = (path: string[]) => refused(404, 'NOT_FOUND', [{ path, message: 'not found' }]);

/** The first message per field of a refused parse, as a form shows them. */
function messagesByField(
  parsed:
    | { success: true }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } },
): Record<string, string> {
  if (parsed.success) return {};
  const messages: Record<string, string> = {};
  for (const issue of parsed.error.issues) messages[String(issue.path[0])] ??= issue.message;
  return messages;
}

const filled: ProposalFormValues = {
  question: '  2026년 안에 기준금리가 내려갈까?  ',
  deadline: '2026-12-31',
  yesCondition: '  한국은행이 기준금리를 내리면 YES  ',
  expectedSources: ' 한국은행 보도자료 ',
  background: '   ',
  categoryId: '',
};

describe('where 시장 제안 lives (ADR-0069 decision 4 #77 위치)', () => {
  it('puts 내 제안 under MY with no tab of its own, and the form outside MY', () => {
    expect(MY_PROPOSALS_PATH).toBe('/my/proposals');
    expect(NEW_PROPOSAL_PATH).toBe('/proposals/new');
    // No ninth tab: 내 제안 is linked from the summary and 설정, and no tab is current on it.
    expect(MY_TABS).toHaveLength(8);
    expect(MY_TABS.some((tab) => tab.href === MY_PROPOSALS_PATH)).toBe(false);
    for (const tab of MY_TABS) expect(isMyTabCurrent(MY_PROPOSALS_PATH, tab.href)).toBe(false);
  });

  it('brings a visitor back to the page it asked for after the login', () => {
    // MY's gate covers /my/proposals as every MY page.
    expect(myLoginPath(MY_PROPOSALS_PATH, '')).toBe(
      `/login?next=${encodeURIComponent(MY_PROPOSALS_PATH)}`,
    );
    expect(NEW_PROPOSAL_LOGIN_PATH).toBe('/login?next=%2Fproposals%2Fnew');
  });

  it('keys the member’s proposals under a private root, and the operators’ under admin', () => {
    expect(isPrivateQueryKey(MY_PROPOSALS_KEY)).toBe(true);
    expect(isPrivateQueryKey(adminProposalsKey(''))).toBe(true);
    expect(isPrivateQueryKey(adminProposalKey('x'))).toBe(true);
    // The list prefix and the detail never match each other.
    expect(ADMIN_PROPOSALS_KEY).not.toEqual(ADMIN_PROPOSAL_KEY.slice(0, 2));
    expect(adminProposalsKey('reviewing')).toEqual(['admin', 'proposals', 'reviewing']);
    expect(adminProposalKey('ABCDEF01-0000-4000-8000-000000000000')).toEqual([
      'admin',
      'proposal',
      'abcdef01-0000-4000-8000-000000000000',
    ]);
  });

  it('sends no request for a segment that cannot name a proposal', () => {
    expect(proposalIdParam('not-a-uuid')).toBeUndefined();
    expect(proposalIdParam('ABCDEF01-0000-4000-8000-000000000000')).toBe(
      'abcdef01-0000-4000-8000-000000000000',
    );
  });
});

describe('statuses and reasons', () => {
  it('calls the five statuses by the owner’s words', () => {
    expect(PROPOSAL_STATUSES.map((status) => PROPOSAL_STATUS_LABEL[status])).toEqual([
      '접수',
      '검토',
      '채택',
      '반려',
      '철회',
    ]);
    for (const status of PROPOSAL_STATUSES) {
      expect(PROPOSAL_STATUS_TIME_LABEL[status]).not.toBe('');
    }
  });

  it('lists the owner’s 반려 reasons in their order', () => {
    expect(PROPOSAL_REJECTION_REASONS.map((r) => PROPOSAL_REJECTION_REASON_LABEL[r])).toEqual([
      '중복',
      '판정 기준이 모호함',
      '개설 금지 주제',
      '기타',
    ]);
  });

  it('offers 철회 on a 접수 proposal only', () => {
    const allowed = PROPOSAL_STATUSES.filter(canRetractProposal);
    expect(allowed).toEqual(['submitted']);
  });

  it('offers the operators the moves the status allows, and none once it is final', () => {
    const table = Object.fromEntries(
      PROPOSAL_STATUSES.map((status) => [status, adminProposalActions({ status, adoption: null })]),
    ) as Record<ProposalStatus, ReturnType<typeof adminProposalActions>>;
    expect(table.submitted).toEqual({ review: true, adopt: false, reject: true, link: false });
    expect(table.reviewing).toEqual({ review: false, adopt: true, reject: true, link: false });
    for (const final of ['rejected', 'retracted'] as const) {
      expect(table[final]).toEqual({ review: false, adopt: false, reject: false, link: false });
    }
  });

  it('offers a later market link on a 채택 without one only, once (owner decision 2026-10-19)', () => {
    const market = { id: 'm', slug: 'm', title: 'm', status: 'draft' as const };
    expect(
      adminProposalActions({ status: 'adopted', adoption: { memo: null, market: null } }),
    ).toEqual({ review: false, adopt: false, reject: false, link: true });
    expect(adminProposalActions({ status: 'adopted', adoption: { memo: null, market } }).link).toBe(
      false,
    );
  });
});

describe('the limits as the screens say them', () => {
  it('say the same numbers as PROPOSAL_LIMITS', () => {
    const { pendingProposals, dailyProposals, dailyWindowSeconds } = PROPOSAL_LIMITS;
    const hours = `${String(dailyWindowSeconds / 3600)}시간`;
    expect(copy.proposalLimitsHint).toContain(`${String(pendingProposals)}건`);
    expect(copy.proposalLimitsHint).toContain(`${hours} 동안 ${String(dailyProposals)}건`);
    expect(copy.errProposalPendingLimit).toContain(`${String(pendingProposals)}건`);
    expect(copy.errProposalDailyLimit).toContain(`${hours} 동안 ${String(dailyProposals)}건`);
    expect(copy.proposalRetractBody).toContain(hours);
  });

  it('say the same lengths as PROPOSAL_*_MAX', () => {
    const n = (max: number) => max.toLocaleString('ko-KR');
    expect(copy.proposalQuestionHint).toContain(`${n(PROPOSAL_QUESTION_MAX)}자까지`);
    expect(copy.errProposalQuestion).toContain(`1~${n(PROPOSAL_QUESTION_MAX)}자`);
    expect(copy.proposalYesConditionHint).toContain(`${n(PROPOSAL_YES_CONDITION_MAX)}자까지`);
    expect(copy.errProposalYesCondition).toContain(`1~${n(PROPOSAL_YES_CONDITION_MAX)}자`);
    expect(copy.proposalExpectedSourcesHint).toContain(`${n(PROPOSAL_SOURCES_MAX)}자까지`);
    expect(copy.errProposalSources).toContain(`1~${n(PROPOSAL_SOURCES_MAX)}자`);
    expect(copy.errProposalBackground).toContain(`${n(PROPOSAL_BACKGROUND_MAX)}자까지`);
    expect(copy.errProposalExplanation).toContain(`1~${n(PROPOSAL_NOTE_MAX)}자`);
    expect(copy.errProposalMemo).toContain(`${n(PROPOSAL_NOTE_MAX)}자까지`);
  });

  it('never promise Coin or an opening for a 채택 (N05 §6)', () => {
    // Not 'not right away': a 채택 may lead to no market at all (ADR-0089 decision 7-7).
    expect(copy.proposalNotice).toContain('열린다는 보장은 없습니다');
    expect(copy.proposalNotice).not.toMatch(/바로|곧/);
    expect(copy.proposalNotice).toContain('지급은 없습니다');
    expect(copy.adminProposalAdoptBody).toContain('열리지 않고');
    expect(copy.adminProposalAdoptBody).toMatch(/Coin/);
    // The draft's sentence is apart, for the draft choice only: no draft without it.
    expect(copy.adminProposalAdoptBody).not.toContain('초안');
    expect(copy.adminProposalAdoptDraftBody).toContain('초안');
  });
});

describe('dates', () => {
  it('offers today in Korea as the earliest date, the day the shared rule opens', () => {
    for (const at of [
      NOON_KST,
      new Date('2026-10-19T14:59:59.999Z'), // 23:59:59.999 in Korea
      new Date('2026-10-19T15:00:00.000Z'), // 00:00 the next day in Korea
      new Date('2026-12-31T15:30:00.000Z'),
    ]) {
      const today = koreanToday(at);
      expect(isProposalDeadlineOpen(today, at)).toBe(true);
      const yesterday = new Date(`${today}T00:00:00.000Z`);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      expect(isProposalDeadlineOpen(yesterday.toISOString().slice(0, 10), at)).toBe(false);
    }
    expect(koreanToday(new Date('2026-10-19T14:59:59.999Z'))).toBe('2026-10-19');
    expect(koreanToday(new Date('2026-10-19T15:00:00.000Z'))).toBe('2026-10-20');
  });

  it('writes a proposal’s date as a day, with no time zone', () => {
    expect(formatProposalDate('2026-11-01')).toBe('2026. 11. 1.');
    expect(formatProposalDate('2027-01-09')).toBe('2027. 1. 9.');
    expect(formatProposalDate('2026-11-01T00:00:00Z')).toBe('');
    expect(formatProposalDate('')).toBe('');
  });
});

describe('the form', () => {
  const schema = proposalFormSchema(() => NOON_KST);
  const errorsOf = (values: ProposalFormValues) => {
    return messagesByField(schema.safeParse(values));
  };

  it('starts empty and refuses every required field blank, with their messages', () => {
    expect(errorsOf(EMPTY_PROPOSAL_FORM)).toEqual({
      question: copy.errProposalQuestion,
      deadline: copy.errProposalDeadline,
      yesCondition: copy.errProposalYesCondition,
      expectedSources: copy.errProposalSources,
    });
    // Spaces are blank: every text is trimmed, as the API trims.
    expect(errorsOf({ ...filled, question: '   ' })).toEqual({
      question: copy.errProposalQuestion,
    });
  });

  it('takes a filled form, the background and the category being optional', () => {
    expect(errorsOf(filled)).toEqual({});
    expect(errorsOf({ ...filled, categoryId: '12', background: '배경' })).toEqual({});
  });

  it('holds the API’s lengths, at their edges', () => {
    const at = (field: keyof ProposalFormValues, max: number) => {
      expect(errorsOf({ ...filled, [field]: 'a'.repeat(max) })).toEqual({});
      expect(Object.keys(errorsOf({ ...filled, [field]: 'a'.repeat(max + 1) }))).toEqual([field]);
    };
    expect(PROPOSAL_QUESTION_MAX).toBe(100);
    expect(PROPOSAL_YES_CONDITION_MAX).toBe(1_000);
    at('question', PROPOSAL_QUESTION_MAX);
    at('yesCondition', PROPOSAL_YES_CONDITION_MAX);
    at('expectedSources', PROPOSAL_SOURCES_MAX);
    at('background', PROPOSAL_BACKGROUND_MAX);
  });

  it('takes today in Korea and later, never an earlier day or a malformed one', () => {
    expect(errorsOf({ ...filled, deadline: '2026-10-19' })).toEqual({});
    expect(errorsOf({ ...filled, deadline: '2026-10-18' })).toEqual({
      deadline: copy.errProposalDeadline,
    });
    expect(errorsOf({ ...filled, deadline: '2026-02-30' })).toEqual({
      deadline: copy.errProposalDeadline,
    });
    expect(errorsOf({ ...filled, categoryId: 'abc' })).toEqual({
      categoryId: copy.errProposalCategory,
    });
  });

  it('sends the trimmed fields and the account, blanks as none, and nothing else', () => {
    const body = toCreateProposalBody(filled, 'user-1');
    expect(body).toEqual({
      question: '2026년 안에 기준금리가 내려갈까?',
      deadline: '2026-12-31',
      yesCondition: '한국은행이 기준금리를 내리면 YES',
      expectedSources: '한국은행 보도자료',
      background: null,
      categoryId: null,
      expectedAccountId: 'user-1',
    });
    // No probability, nor any field the form does not have (N02 §10).
    expect(Object.keys(body).sort()).toEqual(
      [
        'background',
        'categoryId',
        'deadline',
        'expectedAccountId',
        'expectedSources',
        'question',
        'yesCondition',
      ].sort(),
    );
    expect(createProposalBodySchema.safeParse(body).success).toBe(true);
    expect(
      toCreateProposalBody({ ...filled, categoryId: '7', background: ' 배경 ' }, 'u'),
    ).toMatchObject({ categoryId: 7, background: '배경' });
  });
});

describe('proposalFailure', () => {
  // The member's time zone is the screen's; Korea's here, the end of a restriction being absolute.
  const fail = (error: unknown) => proposalFailure(error, formatKst);

  it('puts a field the server named under that field', () => {
    expect(fail(invalid(['deadline']))).toEqual({
      kind: 'field',
      field: 'deadline',
      message: copy.errProposalDeadline,
    });
    expect(fail(invalid(['categoryId']))).toEqual({
      kind: 'field',
      field: 'categoryId',
      message: copy.errProposalCategory,
    });
    expect(fail(invalid(['probability']))).toEqual({
      kind: 'notice',
      message: copy.errUnknown,
    });
  });

  it('says the waiting limit without a time and the daily one with when', () => {
    expect(
      fail(
        refused(429, 'PROPOSAL_LIMITED', { reason: 'pending', limit: 5, retryAfterSeconds: null }),
      ),
    ).toEqual({ kind: 'notice', message: copy.errProposalPendingLimit });
    expect(
      fail(
        refused(429, 'PROPOSAL_LIMITED', { reason: 'daily', limit: 3, retryAfterSeconds: 3_660 }),
      ),
    ).toEqual({
      kind: 'notice',
      message: `${copy.errProposalDailyLimit} 1시간 1분 ${copy.verificationRetryAfter}`,
    });
    expect(fail(refused(429, 'PROPOSAL_LIMITED', { reason: 'odd' }))).toEqual({
      kind: 'notice',
      message: copy.errUnknown,
    });
  });

  it('tells the address bucket from the limits', () => {
    expect(fail(refused(429, 'RATE_LIMITED', { retryAfterSeconds: 30 }))).toEqual({
      kind: 'notice',
      message: `${copy.errProposalTooManyRequests} 30초 ${copy.verificationRetryAfter}`,
    });
    expect(fail(refused(429, 'RATE_LIMITED'))).toEqual({
      kind: 'notice',
      message: copy.errProposalTooManyRequests,
    });
  });

  it('says which restriction keeps a proposal closed and until when — the form shows the way to 조치·신고 내역 under it (#185, #139)', () => {
    const END = '2026-11-02T06:00:00.000Z';
    expect(fail(refused(403, 'RESTRICTED', { kind: 'writing', endsAt: END }))).toEqual({
      kind: 'restricted',
      message: `${copy.errRestrictedProposal}(${formatKst(END)}${copy.restrictionUntil}).`,
    });
    expect(fail(refused(403, 'RESTRICTED', { kind: 'account', endsAt: null }))).toEqual({
      kind: 'restricted',
      message: `${copy.errRestrictedAccountProposal}(${copy.restrictionIndefinite}).`,
    });
    // Every restriction's refusal in one form (ADR-0085 7-11): the restriction, then what it closes.
    expect(copy.errRestrictedProposal).toBe('작성 제한 중에는 시장을 제안할 수 없습니다');
    expect(copy.errRestrictedAccountProposal).toBe('계정 제한 중에는 시장을 제안할 수 없습니다');
  });

  it('asks for what the screen is out of date about', () => {
    expect(fail(refused(409, 'ONBOARDING_REQUIRED'))).toEqual({
      kind: 'refresh',
      message: copy.errProposalOnboarding,
    });
    expect(fail(refused(403, 'VERIFICATION_REQUIRED'))).toEqual({
      kind: 'refresh',
      message: copy.errProposalVerification,
    });
    expect(
      fail(
        refused(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'another account' }]),
      ),
    ).toEqual({ kind: 'session', message: copy.sessionChanged });
    expect(fail(refused(403, 'FORBIDDEN'))).toEqual({
      kind: 'notice',
      message: copy.errUnknown,
    });
    expect(fail(new Error('offline'))).toEqual({
      kind: 'notice',
      message: copy.errUnknown,
    });
  });
});

describe('retractFailureMessage', () => {
  it('says the review started, the proposal is gone, the session changed, or the rest', () => {
    expect(retractFailureMessage(invalid(['status']))).toBe(copy.errProposalRetractStatus);
    expect(retractFailureMessage(refused(404, 'NOT_FOUND'))).toBe(copy.errProposalNotFound);
    // The onboarding never refuses a 철회 (owner decision 2026-10-19): no line of its own.
    expect(copy).not.toHaveProperty('errProposalRetractOnboarding');
    expect(
      retractFailureMessage(
        refused(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'x' }]),
      ),
    ).toBe(copy.sessionChanged);
    expect(retractFailureMessage(refused(500, 'INTERNAL'))).toBe(copy.errUnknown);
  });
});

describe('proposalActorName', () => {
  it('names an account by its nickname, and one its member closed as 탈퇴한 사용자 (#140)', () => {
    expect(proposalActorName({ id: 'a', nickname: 'proposer_one' })).toBe('proposer_one');
    // AdminAccountActor's nickname is null once the account is closed (ADR-0086): never an empty
    // name on the list or in the record — the operators still review its proposals.
    expect(proposalActorName({ id: 'a', nickname: null })).toBe('탈퇴한 사용자');
    expect(proposalActorName({ id: 'a', nickname: null })).toBe(copy.postAuthorFormer);
    expect(proposalActorName(null)).toBe('');
  });
});

describe('the 반려 form', () => {
  const errorsOf = (values: typeof EMPTY_REJECT_FORM) => {
    return messagesByField(rejectProposalFormSchema.safeParse(values));
  };

  it('needs a reason and an explanation, and a market for a 중복', () => {
    expect(errorsOf(EMPTY_REJECT_FORM)).toEqual({
      reason: copy.errProposalRejectReason,
      explanation: copy.errProposalExplanation,
    });
    expect(
      errorsOf({
        reason: 'duplicate',
        explanation: '이미 같은 시장이 있습니다.',
        duplicateMarketId: '',
      }),
    ).toEqual({ duplicateMarketId: copy.errProposalDuplicateMarket });
    expect(
      errorsOf({
        reason: 'other',
        explanation: 'a'.repeat(PROPOSAL_NOTE_MAX + 1),
        duplicateMarketId: '',
      }),
    ).toEqual({ explanation: copy.errProposalExplanation });
  });

  it('sends a market for a 중복 only, in the API’s shape', () => {
    const market = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const duplicate = toRejectProposalBody({
      reason: 'duplicate',
      explanation: ' 같은 시장 ',
      duplicateMarketId: market,
    });
    expect(duplicate).toEqual({
      reason: 'duplicate',
      explanation: '같은 시장',
      duplicateMarketId: market,
    });
    // A market left picked under another reason is not sent: the API refuses one there.
    const other = toRejectProposalBody({
      reason: 'ambiguous_criteria',
      explanation: '기준이 모호합니다.',
      duplicateMarketId: market,
    });
    expect(other).toEqual({ reason: 'ambiguous_criteria', explanation: '기준이 모호합니다.' });
    expect(rejectProposalBodySchema.safeParse(duplicate).success).toBe(true);
    expect(rejectProposalBodySchema.safeParse(other).success).toBe(true);
  });
});

describe('proposalCategoryFitsDraft', () => {
  const category = (id: number, slug: string, parentId: number | null): Category => ({
    id,
    slug,
    nameKo: slug,
    sortOrder: id,
    parentId,
  });
  // 경제 has leaves, 날씨 has none (or only retired ones: the API lists active rows only).
  const tree = groupCategories([
    category(1, 'economy', null),
    category(2, 'weather', null),
    category(11, 'rates', 1),
  ]);
  const wish = (slug: string, isActive = true) => ({ slug, isActive });

  it('lets the wish stand in where a market may sit: a leaf, or a parent with no leaves (ADR-0041)', () => {
    expect(proposalCategoryFitsDraft(wish('rates'), tree)).toBe(true);
    expect(proposalCategoryFitsDraft(wish('weather'), tree)).toBe(true);
  });

  it('makes the operator pick for a wished parent that has leaves, or no wish', () => {
    expect(proposalCategoryFitsDraft(wish('economy'), tree)).toBe(false);
    expect(proposalCategoryFitsDraft(null, tree)).toBe(false);
  });

  it('never lets a retired wish stand in: the operator picks (owner decision 2026-10-19)', () => {
    expect(proposalCategoryFitsDraft(wish('retired', false), tree)).toBe(false);
    expect(proposalCategoryFitsDraft(wish('rates', false), tree)).toBe(false);
    expect(proposalCategoryFitsDraft(wish('retired', false), [])).toBe(false);
    expect(retiredWishLine('날씨')).toBe(
      '제안자가 바란 카테고리: 날씨 (지금은 쓰지 않는 카테고리)',
    );
  });

  it('leaves an active wish not in the tree to the server (the list not loaded yet)', () => {
    expect(proposalCategoryFitsDraft(wish('economy'), [])).toBe(true);
  });
});

describe('draftCategoryView', () => {
  const category = (
    id: number,
    slug: string,
    nameKo: string,
    parentId: number | null,
  ): Category => ({
    id,
    slug,
    nameKo,
    sortOrder: id,
    parentId,
  });
  // 경제 has leaves, 날씨 has none.
  const tree = groupCategories([
    category(1, 'economy', '경제', null),
    category(2, 'weather', '날씨', null),
    category(11, 'rates', '금리', 1),
  ]);
  const wish = (slug: string, nameKo: string, isActive = true) => ({ slug, nameKo, isActive });
  const placeholder = copy.adminMarketCategoryPlaceholder;

  it('names a retired wish below as retired, the blank option left to pick (owner decision 2026-10-19 13)', () => {
    const retired = {
      wishFits: false,
      blankLabel: placeholder,
      hint: { kind: 'retired', text: retiredWishLine('예전') },
    };
    expect(draftCategoryView(wish('old', '예전', false), tree)).toEqual(retired);
    expect(retired.hint.text).toBe('제안자가 바란 카테고리: 예전 (지금은 쓰지 않는 카테고리)');
    // Retired is said whatever level the wish was — a leaf, a parent with leaves, one with none —
    // and never the ask to pick a leaf; the list not loaded yet changes nothing.
    for (const [slug, nameKo] of [
      ['rates', '금리'],
      ['economy', '경제'],
      ['weather', '날씨'],
    ] as const) {
      expect(draftCategoryView(wish(slug, nameKo, false), tree)).toEqual({
        wishFits: false,
        blankLabel: placeholder,
        hint: { kind: 'retired', text: retiredWishLine(nameKo) },
      });
    }
    expect(draftCategoryView(wish('old', '예전', false), [])).toEqual(retired);
  });

  it('names an active wished parent that has leaves below with the ask to pick a leaf (ADR-0041)', () => {
    expect(draftCategoryView(wish('economy', '경제'), tree)).toEqual({
      wishFits: false,
      blankLabel: placeholder,
      hint: {
        kind: 'wish',
        text: `${copy.adminProposalDraftCategoryFromProposal}: 경제. ${copy.adminProposalDraftCategoryPickLeaf}`,
      },
    });
  });

  it('makes a wish that may stand in the blank option, with nothing below', () => {
    const fromProposal = (name: string) =>
      `${copy.adminProposalDraftCategoryFromProposal} (${name})`;
    expect(draftCategoryView(wish('rates', '금리'), tree)).toEqual({
      wishFits: true,
      blankLabel: fromProposal('금리'),
      hint: null,
    });
    expect(draftCategoryView(wish('weather', '날씨'), tree)).toEqual({
      wishFits: true,
      blankLabel: fromProposal('날씨'),
      hint: null,
    });
    // The list not loaded yet: left to the server, as proposalCategoryFitsDraft.
    expect(draftCategoryView(wish('economy', '경제'), [])).toEqual({
      wishFits: true,
      blankLabel: fromProposal('경제'),
      hint: null,
    });
  });

  it('leaves no wish to pick, with nothing below', () => {
    expect(draftCategoryView(null, tree)).toEqual({
      wishFits: false,
      blankLabel: placeholder,
      hint: null,
    });
  });
});

describe('the 채택 form', () => {
  const now = () => NOON_KST.getTime();
  const errorsOf = (values: typeof EMPTY_ADOPT_FORM, wishFits: boolean) => {
    return messagesByField(adoptProposalFormSchema(wishFits, now).safeParse(values));
  };

  it('takes no market, a memo or none', () => {
    expect(errorsOf(EMPTY_ADOPT_FORM, false)).toEqual({});
    expect(
      errorsOf({ ...EMPTY_ADOPT_FORM, memo: 'a'.repeat(PROPOSAL_NOTE_MAX + 1) }, false),
    ).toEqual({
      memo: copy.errProposalMemo,
    });
  });

  it('needs a category for a draft when the proposal’s cannot stand in, and a future close time if one is typed', () => {
    const draft = { ...EMPTY_ADOPT_FORM, market: 'draft' as const };
    expect(errorsOf(draft, false)).toEqual({ categoryId: copy.errProposalDraftCategory });
    expect(errorsOf(draft, true)).toEqual({});
    expect(errorsOf({ ...draft, categoryId: '3' }, false)).toEqual({});
    // 2026-10-19 11:00 in Korea is an hour before `now`.
    expect(errorsOf({ ...draft, closeAt: '2026-10-19T11:00' }, true)).toEqual({
      closeAt: copy.errProposalDraftCloseAt,
    });
    expect(errorsOf({ ...draft, closeAt: '2026-10-19T13:00' }, true)).toEqual({});
  });

  it('needs a picked market to link one', () => {
    const existing = { ...EMPTY_ADOPT_FORM, market: 'existing' as const };
    expect(errorsOf(existing, true)).toEqual({ marketId: copy.errProposalExistingMarket });
    expect(errorsOf({ ...existing, marketId: 'm' }, true)).toEqual({});
  });

  it('sends the API’s shapes: none, a draft with what was given, an existing market', () => {
    const market = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const bodies = [
      toAdoptProposalBody({ ...EMPTY_ADOPT_FORM, memo: '  ' }),
      toAdoptProposalBody({ ...EMPTY_ADOPT_FORM, market: 'draft', memo: ' 좋은 제안 ' }),
      toAdoptProposalBody({
        ...EMPTY_ADOPT_FORM,
        market: 'draft',
        categoryId: '4',
        closeAt: '2026-11-01T09:30',
      }),
      toAdoptProposalBody({ ...EMPTY_ADOPT_FORM, market: 'existing', marketId: market }),
    ];
    expect(bodies).toEqual([
      { memo: null, market: null },
      { memo: '좋은 제안', market: { type: 'draft' } },
      {
        memo: null,
        market: { type: 'draft', categoryId: 4, closeAt: '2026-11-01T00:30:00.000Z' },
      },
      { memo: null, market: { type: 'existing', marketId: market } },
    ]);
    for (const body of bodies) expect(adoptProposalBodySchema.safeParse(body).success).toBe(true);
  });
});

describe('the later market link’s form (owner decision 2026-10-19)', () => {
  const now = () => NOON_KST.getTime();
  const errorsOf = (values: typeof EMPTY_LINK_FORM, wishFits: boolean) =>
    messagesByField(linkProposalMarketFormSchema(wishFits, now).safeParse(values));

  it('starts at an existing market, and needs one picked', () => {
    expect(EMPTY_LINK_FORM.market).toBe('existing');
    expect(errorsOf(EMPTY_LINK_FORM, true)).toEqual({ marketId: copy.errProposalExistingMarket });
    expect(errorsOf({ ...EMPTY_LINK_FORM, marketId: 'm' }, true)).toEqual({});
  });

  it('offers a draft as the 채택 does, with its checks, and never none', () => {
    const draft = { ...EMPTY_LINK_FORM, market: 'draft' as const };
    expect(errorsOf(draft, false)).toEqual({ categoryId: copy.errProposalDraftCategory });
    expect(errorsOf(draft, true)).toEqual({});
    expect(errorsOf({ ...draft, closeAt: '2026-10-19T11:00' }, true)).toEqual({
      closeAt: copy.errProposalDraftCloseAt,
    });
    expect(
      linkProposalMarketFormSchema(true, now).safeParse({ ...EMPTY_LINK_FORM, market: 'none' })
        .success,
    ).toBe(false);
  });

  it('sends the API’s shape: a draft with what was given, or an existing market', () => {
    const market = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const bodies = [
      toLinkProposalMarketBody({ ...EMPTY_LINK_FORM, market: 'draft' }),
      toLinkProposalMarketBody({ ...EMPTY_LINK_FORM, market: 'draft', categoryId: '4' }),
      toLinkProposalMarketBody({ ...EMPTY_LINK_FORM, marketId: market }),
    ];
    expect(bodies).toEqual([
      { market: { type: 'draft' } },
      { market: { type: 'draft', categoryId: 4 } },
      { market: { type: 'existing', marketId: market } },
    ]);
    for (const body of bodies) {
      expect(linkProposalMarketBodySchema.safeParse(body).success).toBe(true);
    }
  });
});

describe('adminProposalFailure', () => {
  it('reads a status that moved as a reason to read the proposal again', () => {
    expect(adminProposalFailure(invalid(['status']))).toEqual({
      message: copy.errProposalStatus,
      refresh: true,
    });
    // A market another operator linked first: the link is once (owner decision 2026-10-19).
    expect(adminProposalFailure(invalid(['market'], 'already linked'))).toEqual({
      message: copy.errProposalMarketAlreadyLinked,
      refresh: true,
    });
    expect(adminProposalFailure(refused(404, 'NOT_FOUND'))).toEqual({
      message: copy.errProposalNotFound,
      refresh: true,
    });
  });

  it('puts the draft’s and the market’s refusals on their fields', () => {
    expect(adminProposalFailure(invalid(['market', 'categoryId'], 'required'))).toEqual({
      message: copy.errProposalDraftCategory,
      field: 'categoryId',
      refresh: false,
    });
    // A retired category is not a missing one: the proposal may well name one.
    expect(adminProposalFailure(invalid(['market', 'categoryId'], 'inactive'))).toEqual({
      message: copy.errProposalDraftCategoryInactive,
      field: 'categoryId',
      refresh: false,
    });
    expect(adminProposalFailure(invalid(['market', 'categoryId']))).toEqual({
      message: copy.errProposalDraftCategory,
      field: 'categoryId',
      refresh: false,
    });
    expect(adminProposalFailure(invalid(['market', 'closeAt']))).toEqual({
      message: copy.errProposalDraftCloseAt,
      field: 'closeAt',
      refresh: false,
    });
    expect(adminProposalFailure(missing(['market', 'marketId']))).toEqual({
      message: copy.errProposalMarketNotFound,
      field: 'marketId',
      refresh: false,
    });
    expect(adminProposalFailure(missing(['duplicateMarketId']))).toEqual({
      message: copy.errProposalMarketNotFound,
      field: 'duplicateMarketId',
      refresh: false,
    });
    expect(adminProposalFailure(missing(['market', 'categoryId']))).toEqual({
      message: copy.errProposalCategoryNotFound,
      field: 'categoryId',
      refresh: false,
    });
    expect(adminProposalFailure(invalid(['duplicateMarketId']))).toMatchObject({
      field: 'duplicateMarketId',
    });
    expect(adminProposalFailure(refused(500, 'INTERNAL'))).toEqual({
      message: copy.errUnknown,
      refresh: false,
    });
  });

  it('reads the path the first issue names, joined, and its own word', () => {
    expect(issuePath(invalid(['market', 'closeAt']))).toBe('market.closeAt');
    expect(issuePath(refused(400, 'VALIDATION_ERROR'))).toBeUndefined();
    expect(issuePath(refused(400, 'VALIDATION_ERROR', [{ path: [] }]))).toBeUndefined();
    expect(issuePath(new Error('x'))).toBeUndefined();
    expect(issueMessage(invalid(['market', 'categoryId'], 'inactive'))).toBe('inactive');
    expect(issueMessage(refused(400, 'VALIDATION_ERROR', [{ path: ['x'] }]))).toBeUndefined();
    expect(issueMessage(refused(400, 'VALIDATION_ERROR', ['inactive']))).toBeUndefined();
    expect(issueMessage(new Error('inactive'))).toBeUndefined();
  });
});
