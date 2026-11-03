import {
  DISPUTE_ELIGIBILITIES,
  DISPUTE_LINKS_MAX,
  DISPUTE_LINK_MAX,
  DISPUTE_NOT_ALLOWED_REASONS,
  DISPUTE_REASON_MAX,
  type ErrorCode,
  MARKET_DISPUTE_STATUSES,
  submitDisputeBodySchema,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type MyDispute, type MyMarketDispute } from './api';
import {
  DISPUTES_KEY,
  DISPUTE_REFUSAL_TEXT,
  DISPUTE_STATUS_LABEL,
  DISPUTE_STATUS_PALETTE,
  EMPTY_DISPUTE_FORM,
  MY_DISPUTES_KEY,
  MY_DISPUTES_PATH,
  myDisputesKey,
  disputeDeadlineWait,
  disputeDraft,
  disputeLoginPath,
  disputePath,
  disputeRefusalOf,
  disputeRetractFailureMessage,
  disputeScreenView,
  disputeNote,
  disputeStatusTime,
  disputeSubmitFailure,
  myDisputePalette,
  myMarketDisputeKey,
  myMarketDisputesKey,
  openDisputeDeadline,
  toSubmitDisputeBody,
} from './disputes';
import { isPrivateQueryKey } from './market-keys';

const MARKET = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
const ACCOUNT = 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46';

function refused(status: number, code: ErrorCode, details?: unknown): ApiError {
  return new ApiError(status, { code, message: code, details });
}

const dispute = (fields: Partial<MyDispute> = {}): MyDispute => ({
  id: 'd1b07384-d9a0-4c9b-8e2f-2d1c0f8a4b11',
  judgementVersion: 1,
  links: ['https://example.com/a'],
  reason: '규칙의 출처와 다릅니다.',
  status: 'pending',
  submittedAt: '2026-11-30T03:00:00.000Z',
  decidedAt: null,
  decisionReason: null,
  retractedAt: null,
  closedAt: null,
  market: {
    id: MARKET.toLowerCase(),
    slug: 'first-snow',
    title: '첫눈이 올까?',
    status: 'provisional',
    judgementVersion: 1,
  },
  retractable: true,
  ...fields,
});

/**
 * 판정 이의's member side (#175, ADR-0104; ADR-0093 decision 1 #173 items 5·6·7·13): the screens'
 * addresses and keys, the statuses' words, the deadline's wait, what the submission screen shows,
 * what the form sends and what a refusal says. The rules are the shared ones the API applies
 * (market-dispute.ts) — these pin that the screens read them and say each in its own words.
 */
describe('the 판정 이의 screens’ addresses and keys', () => {
  it('puts the submission screen under its market and MY 판정 이의 under MY, the login coming back', () => {
    expect(disputePath('first-snow')).toBe('/markets/first-snow/dispute');
    expect(MY_DISPUTES_PATH).toBe('/my/disputes');
    expect(disputeLoginPath('first-snow')).toBe(
      `/login?next=${encodeURIComponent('/markets/first-snow/dispute')}`,
    );
  });

  it('keys the member’s disputes and standing under the private root and the account shown', () => {
    expect(DISPUTES_KEY).toEqual(['disputes']);
    expect(MY_DISPUTES_KEY).toEqual(['disputes', 'mine']);
    expect(myDisputesKey('user-1')).toEqual(['disputes', 'mine', 'user-1']);
    // The market on its canonical uuid, then the account (ADR-0091): every account's entries of
    // one market share the prefix a `market:status` restarts.
    expect(myMarketDisputesKey(MARKET)).toEqual(['disputes', 'market', MARKET.toLowerCase()]);
    expect(myMarketDisputeKey(MARKET, 'user-1')).toEqual([
      'disputes',
      'market',
      MARKET.toLowerCase(),
      'user-1',
    ]);
    for (const key of [
      DISPUTES_KEY,
      MY_DISPUTES_KEY,
      myDisputesKey('user-1'),
      myMarketDisputeKey(MARKET, 'user-1'),
    ]) {
      expect(isPrivateQueryKey(key)).toBe(true);
    }
  });
});

describe('a dispute’s status', () => {
  it('reads 검토 중 · 기각 · 수용 · 철회 · 정정으로 종결, each with its colour', () => {
    expect(MARKET_DISPUTE_STATUSES.map((status) => DISPUTE_STATUS_LABEL[status])).toEqual([
      '검토 중',
      '기각',
      '수용',
      '철회',
      '정정으로 종결',
    ]);
    // A holding status reads orange (the market waits for it), a dismissal `no`, a 철회 and a
    // closure by a correction (no decision either way, #176) gray.
    expect(DISPUTE_STATUS_PALETTE).toEqual({
      pending: 'orange',
      dismissed: 'no',
      accepted: 'orange',
      retracted: 'gray',
      closed_by_correction: 'gray',
    });
  });

  it('turns gray in MY for a 수용 a correction already answered (#176)', () => {
    // Accepted on v1 and the market at v1: it holds the market, waiting for its correction.
    expect(myDisputePalette(dispute({ status: 'accepted' }))).toBe('orange');
    // The market at v2: the correction answered it (`disputeNote`'s 'corrected') — nothing waits.
    const moved = { ...dispute().market, judgementVersion: 2 };
    expect(myDisputePalette(dispute({ status: 'accepted', market: moved }))).toBe('gray');
    // Every other status keeps its own colour, the version moved or not.
    for (const status of ['pending', 'dismissed', 'retracted', 'closed_by_correction'] as const) {
      expect(myDisputePalette(dispute({ status, market: moved })), status).toBe(
        DISPUTE_STATUS_PALETTE[status],
      );
      expect(myDisputePalette(dispute({ status })), status).toBe(DISPUTE_STATUS_PALETTE[status]);
    }
  });

  it('names the instant it took its status', () => {
    expect(disputeStatusTime(dispute())).toEqual({
      label: copy.disputeSubmittedAt,
      at: '2026-11-30T03:00:00.000Z',
    });
    expect(
      disputeStatusTime(
        dispute({ status: 'dismissed', decidedAt: '2026-12-01T00:00:00.000Z', retractable: false }),
      ),
    ).toEqual({ label: copy.disputeDecidedAt, at: '2026-12-01T00:00:00.000Z' });
    expect(
      disputeStatusTime(
        dispute({
          status: 'retracted',
          retractedAt: '2026-11-30T04:00:00.000Z',
          retractable: false,
        }),
      ),
    ).toEqual({ label: copy.disputeRetractedAt, at: '2026-11-30T04:00:00.000Z' });
    // Closed by a correction (#176): the correction's approval.
    expect(
      disputeStatusTime(
        dispute({
          status: 'closed_by_correction',
          closedAt: '2026-11-30T05:00:00.000Z',
          retractable: false,
        }),
      ),
    ).toEqual({ label: copy.disputeClosedAt, at: '2026-11-30T05:00:00.000Z' });
    // Sent back to 검토 중 by a rejected correction: its decision cleared, 낸 시각 again.
    expect(disputeStatusTime(dispute({ status: 'pending', decidedAt: null }))).toEqual({
      label: copy.disputeSubmittedAt,
      at: '2026-11-30T03:00:00.000Z',
    });
  });

  it('says once the judgement was corrected past its version, and that a correction follows (#176)', () => {
    // Accepted on the current version: the correction follows (#173 item 7).
    expect(disputeNote(dispute({ status: 'accepted' }))).toEqual({
      kind: 'accepted',
      text: copy.disputeAcceptedNote,
    });
    // Accepted on v1, the market at v2: the correction answered it.
    const moved = { ...dispute().market, judgementVersion: 2 };
    expect(disputeNote(dispute({ status: 'accepted', market: moved }))).toEqual({
      kind: 'corrected',
      text: copy.disputeAcceptedCorrectedNote,
    });
    // Closed by the correction: the corrected judgement takes a new one (#173 item 8).
    expect(disputeNote(dispute({ status: 'closed_by_correction', market: moved }))).toEqual({
      kind: 'closed',
      text: copy.disputeClosedByCorrectionNote,
    });
    for (const status of ['pending', 'dismissed', 'retracted'] as const) {
      expect(disputeNote(dispute({ status, market: moved })), status).toBeNull();
    }
  });
});

describe('the 이의 기한 on screen (#173 item 5)', () => {
  const deadline = '2026-12-01T03:00:00.000Z';
  const at = Date.parse(deadline);

  it('waits until the deadline, to the millisecond, and no more once it has come', () => {
    expect(disputeDeadlineWait(deadline, at - 60_000)).toBe(60_000);
    expect(disputeDeadlineWait(deadline, at - 1)).toBe(1);
    // `now < deadline` takes disputes, so the deadline's own instant is closed (`isDisputeOpen`).
    expect(disputeDeadlineWait(deadline, at)).toBeNull();
    expect(disputeDeadlineWait(deadline, at + 1)).toBeNull();
    expect(disputeDeadlineWait('nope', at)).toBeNull();
    // A day at most at once: the timer waits again (no timer outlives 2^31 ms).
    expect(disputeDeadlineWait(deadline, at - 3 * 24 * 60 * 60 * 1_000)).toBe(24 * 60 * 60 * 1_000);
  });

  it('times only a deadline the API says is still open', () => {
    expect(openDisputeDeadline({ disputeOpen: true, disputeDeadline: deadline })).toBe(deadline);
    expect(openDisputeDeadline({ disputeOpen: false, disputeDeadline: deadline })).toBeNull();
    expect(openDisputeDeadline({ disputeOpen: false, disputeDeadline: null })).toBeNull();
  });
});

describe('the submission screen (disputeScreenView)', () => {
  const standing = (fields: Partial<MyMarketDispute> = {}): MyMarketDispute => ({
    eligibility: 'eligible',
    judgementVersion: 2,
    dispute: null,
    ...fields,
  });

  it('offers the form for an eligible member, submitting the version the standing was read for', () => {
    expect(
      disputeScreenView({
        status: 'provisional',
        judgementVersion: 2,
        open: true,
        standing: standing(),
        failed: false,
      }),
    ).toEqual({ kind: 'form', judgementVersion: 2 });
  });

  it('says why not, one sentence each, the live row first', () => {
    // A market confirmed or a deadline come on screen outranks a standing read before them.
    expect(
      disputeScreenView({
        status: 'resolved',
        judgementVersion: 2,
        open: false,
        standing: standing(),
        failed: false,
      }),
    ).toEqual({ kind: 'closed', reason: 'not_provisional' });
    expect(
      disputeScreenView({
        status: 'provisional',
        judgementVersion: 2,
        open: false,
        standing: standing(),
        failed: false,
      }),
    ).toEqual({ kind: 'closed', reason: 'deadline_passed' });
    for (const eligibility of DISPUTE_ELIGIBILITIES.filter((value) => value !== 'eligible')) {
      expect(
        disputeScreenView({
          status: 'provisional',
          judgementVersion: 2,
          open: true,
          standing: standing({ eligibility }),
          failed: false,
        }),
        eligibility,
      ).toEqual({ kind: 'closed', reason: eligibility });
      expect(DISPUTE_REFUSAL_TEXT[eligibility].trim(), eligibility).not.toBe('');
    }
    // The fill rule's own sentence (#173 item 6), and the admin's (#173 item 15).
    expect(DISPUTE_REFUSAL_TEXT.no_fill).toBe(
      '이 시장에 체결한 이력이 있는 회원만 낼 수 있습니다.',
    );
    expect(DISPUTE_REFUSAL_TEXT.admin).toBe(copy.disputeRefusalAdmin);
  });

  it('waits for the standing, and says its failure apart', () => {
    const live = { status: 'provisional', judgementVersion: 2, open: true } as const;
    expect(disputeScreenView({ ...live, standing: undefined, failed: false })).toEqual({
      kind: 'pending',
    });
    expect(disputeScreenView({ ...live, standing: undefined, failed: true })).toEqual({
      kind: 'failed',
    });
  });

  it('says nothing of a version it has not read: a row an event moved, a standing of another', () => {
    // The `provisional` event moved the row before its REST read: no version, no deadline yet —
    // not '이의 기한이 지났습니다'.
    expect(
      disputeScreenView({
        status: 'provisional',
        judgementVersion: null,
        open: false,
        standing: standing({ eligibility: 'not_provisional', judgementVersion: null }),
        failed: false,
      }),
    ).toEqual({ kind: 'pending' });
    // The standing read on the CLOSED market (no version) or for an earlier version: read again,
    // its refusal never standing for this one — and a failed read again says so.
    for (const held of [
      standing({ eligibility: 'not_provisional', judgementVersion: null }),
      standing({ eligibility: 'duplicate', judgementVersion: 1 }),
    ]) {
      const live = { status: 'provisional', judgementVersion: 2, open: true } as const;
      expect(disputeScreenView({ ...live, standing: held, failed: false })).toEqual({
        kind: 'pending',
      });
      expect(disputeScreenView({ ...live, standing: held, failed: true })).toEqual({
        kind: 'failed',
      });
    }
  });
});

describe('the form (disputeDraft)', () => {
  const values = (links: string[], reason = '사유') => ({ links, reason });

  it('starts with one empty link and no reason, and is not ready', () => {
    expect(EMPTY_DISPUTE_FORM).toEqual({ links: [''], reason: '' });
    const draft = disputeDraft(EMPTY_DISPUTE_FORM);
    expect(draft.ready).toBe(false);
    expect(draft.errors).toEqual({ links: [copy.errDisputeLink], reason: copy.errDisputeReason });
  });

  it('takes 1..5 distinct http(s) links of at most 500 characters and a 1..2,000 reason, trimmed', () => {
    const draft = disputeDraft(values([' https://a.example/1 ', 'http://b.example'], '  사유  '));
    expect(draft).toEqual({
      ready: true,
      links: ['https://a.example/1', 'http://b.example'],
      reason: '사유',
      errors: { links: [null, null], reason: null },
    });
    // The body is the API's own (`submitDisputeBodySchema`), with the version and the account.
    const body = toSubmitDisputeBody(draft, 3, ACCOUNT);
    expect(body).toEqual({
      judgementVersion: 3,
      links: draft.links,
      reason: '사유',
      expectedAccountId: ACCOUNT,
    });
    expect(submitDisputeBodySchema.safeParse(body).success).toBe(true);
  });

  it('refuses what the API refuses, each under its field', () => {
    const long = `https://a.example/${'x'.repeat(DISPUTE_LINK_MAX)}`;
    const draft = disputeDraft(
      values(['ftp://a.example', long, 'https://c.example', ' https://c.example ']),
    );
    expect(draft.ready).toBe(false);
    expect(draft.errors.links).toEqual([
      copy.errDisputeLink,
      copy.errDisputeLink,
      null,
      copy.errDisputeLinkDuplicate,
    ]);
    // Six links: every input says their count.
    const six = Array.from(
      { length: DISPUTE_LINKS_MAX + 1 },
      (_, i) => `https://e.example/${String(i)}`,
    );
    expect(disputeDraft(values(six)).errors.links).toEqual(six.map(() => copy.errDisputeLinks));
    expect(disputeDraft(values([], '사유')).ready).toBe(false);
    // The reason: blank, or over the limit once trimmed.
    expect(disputeDraft(values(['https://a.example'], '   ')).errors.reason).toBe(
      copy.errDisputeReason,
    );
    expect(
      disputeDraft(values(['https://a.example'], 'ㄱ'.repeat(DISPUTE_REASON_MAX + 1))).errors
        .reason,
    ).toBe(copy.errDisputeReason);
    expect(
      disputeDraft(values(['https://a.example'], ` ${'ㄱ'.repeat(DISPUTE_REASON_MAX)} `)).ready,
    ).toBe(true);
  });
});

describe('a refused submission (disputeSubmitFailure)', () => {
  it('says DISPUTE_NOT_ALLOWED by its reason above the form, and reads the standing again', () => {
    for (const reason of DISPUTE_NOT_ALLOWED_REASONS) {
      const error = refused(409, 'DISPUTE_NOT_ALLOWED', { reason });
      expect(disputeRefusalOf(error), reason).toBe(reason);
      expect(disputeSubmitFailure(error), reason).toEqual({
        kind: 'refusal',
        message: DISPUTE_REFUSAL_TEXT[reason],
        refresh: true,
      });
    }
    // One whose reason the screen cannot read says the plain refusal.
    expect(disputeSubmitFailure(refused(409, 'DISPUTE_NOT_ALLOWED', { reason: 'other' }))).toEqual({
      kind: 'refusal',
      message: copy.errUnknown,
      refresh: true,
    });
    expect(DISPUTE_REFUSAL_TEXT.stale_version).toBe(copy.disputeRefusalStaleVersion);
  });

  it('puts a link’s or the reason’s refusal under it', () => {
    const issue = (path: (string | number)[], message = 'invalid') =>
      refused(400, 'VALIDATION_ERROR', [{ path, message }]);
    expect(disputeSubmitFailure(issue(['links', 2]))).toEqual({
      kind: 'field',
      field: 'links',
      index: 2,
      message: copy.errDisputeLink,
    });
    expect(disputeSubmitFailure(issue(['links', 1], 'duplicate'))).toEqual({
      kind: 'field',
      field: 'links',
      index: 1,
      message: copy.errDisputeLinkDuplicate,
    });
    expect(disputeSubmitFailure(issue(['links']))).toEqual({
      kind: 'field',
      field: 'links',
      message: copy.errDisputeLinks,
    });
    expect(disputeSubmitFailure(issue(['reason']))).toEqual({
      kind: 'field',
      field: 'reason',
      message: copy.errDisputeReason,
    });
    expect(disputeSubmitFailure(issue(['judgementVersion']))).toEqual({
      kind: 'refusal',
      message: copy.disputeRefusalStaleVersion,
      refresh: true,
    });
    expect(disputeSubmitFailure(issue(['other']))).toEqual({
      kind: 'notice',
      message: copy.errUnknown,
    });
  });

  it('asks for the session, `GET /me`, or says the market gone; no restriction refuses it', () => {
    expect(
      disputeSubmitFailure(
        refused(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'x' }]),
      ),
    ).toEqual({ kind: 'session', message: copy.sessionChanged });
    expect(disputeSubmitFailure(refused(409, 'ONBOARDING_REQUIRED'))).toEqual({
      kind: 'onboarding',
      message: copy.errDisputeOnboarding,
    });
    expect(disputeSubmitFailure(refused(404, 'NOT_FOUND'))).toEqual({
      kind: 'refusal',
      message: copy.errDisputeMarketGone,
      refresh: true,
    });
    expect(disputeSubmitFailure(refused(401, 'UNAUTHENTICATED'))).toEqual({
      kind: 'notice',
      message: copy.errUnauthenticated,
    });
    expect(disputeSubmitFailure(new TypeError('fetch failed'))).toEqual({
      kind: 'notice',
      message: copy.errNetwork,
    });
  });
});

describe('a refused 철회', () => {
  it('says the deadline, the status, the dispute gone or the session', () => {
    const notAllowed = (reason: string) => refused(409, 'DISPUTE_NOT_ALLOWED', { reason });
    expect(disputeRetractFailureMessage(notAllowed('deadline_passed'))).toBe(
      copy.errDisputeRetractDeadline,
    );
    expect(disputeRetractFailureMessage(notAllowed('decided'))).toBe(copy.disputeRefusalDecided);
    expect(disputeRetractFailureMessage(notAllowed('retracted'))).toBe(
      copy.disputeRefusalRetracted,
    );
    expect(disputeRetractFailureMessage(refused(404, 'NOT_FOUND'))).toBe(copy.errDisputeNotFound);
    expect(
      disputeRetractFailureMessage(
        refused(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'x' }]),
      ),
    ).toBe(copy.sessionChanged);
    expect(disputeRetractFailureMessage(refused(500, 'INTERNAL'))).toBe(copy.errUnknown);
  });
});

describe('the member’s 판정 이의 copy', () => {
  const memberKeys = Object.entries(copy).filter(
    ([key]) =>
      key.startsWith('dispute') ||
      key.startsWith('errDispute') ||
      key.startsWith('myDisputes') ||
      key.startsWith('marketDispute') ||
      key.startsWith('marketProvisional') ||
      key === 'discussionDisputeNote' ||
      key === 'marketStatusDisputeUnderReview',
  );

  it('says 판정 이의, names no operator by person and promises no refund, payout or result', () => {
    expect(memberKeys.length).toBeGreaterThan(30);
    for (const [key, text] of memberKeys) {
      // #173 item 13: who decided is nobody's but the operators'; a 무효 is no refund (N03 §6).
      expect(text, key).not.toMatch(/관리자|환불|원금|정산|지급|YES|NO\b/);
    }
    // Never a bare 이의 where a sanction appeal could be meant: the screens' names say 판정 이의.
    for (const text of [
      copy.disputeTitle,
      copy.myDisputes,
      copy.marketDisputeSubmit,
      copy.discussionDisputeNote,
    ]) {
      expect(text).toContain('판정 이의');
    }
    // The two kinds are kept apart where a member could confuse them (ADR-0084).
    expect(copy.disputeNotAppealNote).toContain('제재 이의');
    expect(copy.myDisputesSettingsHint).toContain('제재 이의');
  });

  it('keeps the discussion note to its one line (decision 3 ‘#175 토론의 이의 안내’)', () => {
    expect(copy.discussionDisputeNote).toBe('토론 글은 판정 이의가 아닙니다.');
  });
});
