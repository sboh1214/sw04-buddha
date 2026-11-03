import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { APPROVAL_REASON_MAX_LENGTH } from './approvals.js';
import { ADMIN_ACTION_TYPES } from './enums.js';
import { ERROR_CODES } from './api/errors.js';
import { expectedAccountBodySchema } from './expected-account.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import * as shared from './index.js';
import {
  ADMIN_DISPUTE_LIST_STATUSES,
  ADMIN_DISPUTE_LIST_STATUS_MEMBERS,
  DISPUTE_DECISION_REFUSALS,
  DISPUTE_ELIGIBILITIES,
  DISPUTE_LINKS_MAX,
  DISPUTE_LINK_MAX,
  DISPUTE_NOT_ALLOWED_REASONS,
  DISPUTE_REASON_MAX,
  DISPUTE_RETRACTION_REFUSALS,
  DISPUTE_SUBMISSION_REFUSALS,
  HOLDING_DISPUTE_STATUSES,
  MARKET_DISPUTE_DECISIONS,
  MARKET_DISPUTE_DECISION_ACTION_TYPES,
  MARKET_DISPUTE_DECISION_STATUSES,
  MARKET_DISPUTE_REFUSALS,
  MARKET_DISPUTE_STATUSES,
  MARKET_DISPUTE_TRANSITIONS,
  adminDisputeListQuerySchema,
  adminDisputeQueueItemSchema,
  adminMarketDisputeSchema,
  adminMarketDisputesSchema,
  canMoveMarketDispute,
  decideDisputeBodySchema,
  disputeDecisionRefusal,
  disputeEligibilitySchema,
  disputeNotAllowedDetailsSchema,
  disputeRetractionRefusal,
  isHoldingDisputeStatus,
  marketDisputeStatusSchema,
  myDisputeSchema,
  myMarketDisputeSchema,
  retractDisputeBodySchema,
  submitDisputeBodySchema,
} from './market-dispute.js';
import { JUDGEMENT_EVIDENCE_LINKS_MAX, JUDGEMENT_EVIDENCE_LINK_MAX } from './market-judgement.js';
import { RETENTION_PURGE_KINDS } from './retention.js';

const at = '2026-11-03T00:00:00.000Z';
const account = 'user-1';
const disputeId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const marketId = '9b2e1f4c-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const link = 'https://www.bok.or.kr/press/1';

const issues = (result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [];
const paths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

describe('판정 이의 (#175, ADR-0093 decision 1 #173 items 2·6·7)', () => {
  it('bounds the links as a judgement’s evidence, and the reason as the M5 dispute did', () => {
    expect(DISPUTE_LINKS_MAX).toBe(5);
    expect(DISPUTE_LINKS_MAX).toBe(JUDGEMENT_EVIDENCE_LINKS_MAX);
    expect(DISPUTE_LINK_MAX).toBe(500);
    expect(DISPUTE_LINK_MAX).toBe(JUDGEMENT_EVIDENCE_LINK_MAX);
    expect(DISPUTE_REASON_MAX).toBe(2_000);
  });

  it('ends a pending dispute once — dismissed, accepted, retracted or closed — or reopens', () => {
    expect(MARKET_DISPUTE_STATUSES).toEqual([
      'pending',
      'dismissed',
      'accepted',
      'retracted',
      'closed_by_correction',
    ]);
    expect(marketDisputeStatusSchema.options).toEqual([...MARKET_DISPUTE_STATUSES]);
    // The excluded cash-out token never names the retraction, nor M5's 'open'/'rejected' it.
    for (const other of ['withdrawn', 'open', 'rejected', 'closed', 'corrected', '']) {
      expect(marketDisputeStatusSchema.safeParse(other).success, other).toBe(false);
    }
    expect(Object.keys(MARKET_DISPUTE_TRANSITIONS)).toEqual([...MARKET_DISPUTE_STATUSES]);
    for (const from of MARKET_DISPUTE_STATUSES) {
      for (const to of MARKET_DISPUTE_STATUSES) {
        expect(canMoveMarketDispute(from, to), `${from} → ${to}`).toBe(
          (from === 'pending' && to !== 'pending') || (from === 'accepted' && to === 'pending'),
        );
      }
    }
    // market_disputes.status is varchar(20): '정정으로 종결' fills it exactly.
    for (const status of MARKET_DISPUTE_STATUSES) expect(status.length).toBeLessThanOrEqual(20);
    expect('closed_by_correction').toHaveLength(20);
  });

  it('closes a corrected version’s pending disputes and reopens an accepted one (#176)', () => {
    // #173 item 8: a correction's approval closes the replaced version's pending disputes, no
    // admin deciding them — the one move into the status, and none out of it.
    expect(
      MARKET_DISPUTE_STATUSES.filter((from) => canMoveMarketDispute(from, 'closed_by_correction')),
    ).toEqual(['pending']);
    expect(MARKET_DISPUTE_TRANSITIONS.closed_by_correction).toEqual([]);
    // Owner answer 2026-11-02: a rejected (or retracted) correction sends the accepted disputes it
    // answered back to pending, to be decided again — the one move back, and nothing else leaves
    // a decision.
    expect(MARKET_DISPUTE_TRANSITIONS.accepted).toEqual(['pending']);
    expect(MARKET_DISPUTE_STATUSES.filter((from) => canMoveMarketDispute(from, 'pending'))).toEqual(
      ['accepted'],
    );
    expect(MARKET_DISPUTE_TRANSITIONS.dismissed).toEqual([]);
    expect(MARKET_DISPUTE_TRANSITIONS.retracted).toEqual([]);
    // A closed dispute holds nothing: its version is not the current one any more.
    expect(isHoldingDisputeStatus('closed_by_correction')).toBe(false);
  });

  it('holds the confirmation by a pending or an accepted dispute (owner answer 2026-11-02)', () => {
    expect(HOLDING_DISPUTE_STATUSES).toEqual(['pending', 'accepted']);
    expect(MARKET_DISPUTE_STATUSES.filter(isHoldingDisputeStatus)).toEqual(['pending', 'accepted']);
  });

  it('decides by dismissing or accepting, each its status and its admin action', () => {
    expect(MARKET_DISPUTE_DECISIONS).toEqual(['dismiss', 'accept']);
    expect(MARKET_DISPUTE_DECISION_STATUSES).toEqual({ dismiss: 'dismissed', accept: 'accepted' });
    expect(MARKET_DISPUTE_DECISION_ACTION_TYPES).toEqual({
      dismiss: 'market_dispute_dismiss',
      accept: 'market_dispute_accept',
    });
    for (const type of Object.values(MARKET_DISPUTE_DECISION_ACTION_TYPES)) {
      expect(ADMIN_ACTION_TYPES).toContain(type);
    }
    // Only a dismissal lifts a hold; an acceptance holds until its correction (#176).
    expect(isHoldingDisputeStatus(MARKET_DISPUTE_DECISION_STATUSES.dismiss)).toBe(false);
    expect(isHoldingDisputeStatus(MARKET_DISPUTE_DECISION_STATUSES.accept)).toBe(true);
  });
});

describe('the refusals (DISPUTE_NOT_ALLOWED)', () => {
  it('is an error code of its own, its details one reason', () => {
    expect(ERROR_CODES).toContain('DISPUTE_NOT_ALLOWED');
    expect(DISPUTE_NOT_ALLOWED_REASONS).toEqual([
      'not_provisional',
      'stale_version',
      'deadline_passed',
      'admin',
      'no_fill',
      'duplicate',
      'decided',
      'retracted',
      'registrant',
      'own',
    ]);
    for (const reason of DISPUTE_NOT_ALLOWED_REASONS) {
      expect(disputeNotAllowedDetailsSchema.parse({ reason })).toEqual({ reason });
    }
    // No restriction refuses a dispute (#173 item 6, ADR-0069 #45-12), nor admin staffing (C5).
    for (const reason of ['restricted', 'no_decider', 'onboarding', 'requester']) {
      expect(disputeNotAllowedDetailsSchema.safeParse({ reason }).success, reason).toBe(false);
    }
  });

  it('asks a submission in its order, and a retraction and a decision their own', () => {
    expect(DISPUTE_SUBMISSION_REFUSALS).toEqual([
      'not_provisional',
      'stale_version',
      'deadline_passed',
      'admin',
      'no_fill',
      'duplicate',
    ]);
    expect(DISPUTE_RETRACTION_REFUSALS).toEqual(['decided', 'retracted', 'deadline_passed']);
    expect(DISPUTE_DECISION_REFUSALS).toEqual(['retracted', 'decided', 'registrant', 'own']);
    expect(
      new Set([
        ...DISPUTE_SUBMISSION_REFUSALS,
        ...DISPUTE_RETRACTION_REFUSALS,
        ...DISPUTE_DECISION_REFUSALS,
      ]),
    ).toEqual(new Set(DISPUTE_NOT_ALLOWED_REASONS));
    // The screen's standing is the submission's, the version aside: the read is of the current one.
    expect(DISPUTE_ELIGIBILITIES).toEqual([
      'eligible',
      ...DISPUTE_SUBMISSION_REFUSALS.filter((reason) => reason !== 'stale_version'),
    ]);
    expect(disputeEligibilitySchema.safeParse('stale_version').success).toBe(false);
  });

  it('retracts a pending dispute before its deadline, never at it', () => {
    const deadline = '2026-11-04T00:00:00.123Z';
    const due = Date.parse(deadline);
    const pending = { status: 'pending' } as const;
    expect(disputeRetractionRefusal(pending, deadline, due - 1)).toBeNull();
    expect(disputeRetractionRefusal(pending, new Date(due), due - 1)).toBeNull();
    expect(disputeRetractionRefusal(pending, deadline, due)).toBe('deadline_passed');
    expect(disputeRetractionRefusal(pending, new Date(due), due + 1)).toBe('deadline_passed');
    // The status first: a decided or retracted dispute says so, before its deadline or after —
    // one closed by a correction reads as decided (#176: no reason of its own).
    for (const nowMs of [due - 1, due]) {
      expect(disputeRetractionRefusal({ status: 'dismissed' }, deadline, nowMs)).toBe('decided');
      expect(disputeRetractionRefusal({ status: 'accepted' }, deadline, nowMs)).toBe('decided');
      expect(disputeRetractionRefusal({ status: 'retracted' }, deadline, nowMs)).toBe('retracted');
      expect(disputeRetractionRefusal({ status: 'closed_by_correction' }, deadline, nowMs)).toBe(
        'decided',
      );
    }
  });

  it('lets any admin but the version’s registrant and the submitter decide a pending one', () => {
    const pending = { status: 'pending' } as const;
    expect(disputeDecisionRefusal(pending, 'admin-2', 'admin-1', 'member')).toBeNull();
    expect(disputeDecisionRefusal(pending, 'admin-1', 'admin-1', 'member')).toBe('registrant');
    // A member given the admin role after disputing never decides their own dispute.
    expect(disputeDecisionRefusal(pending, 'member', 'admin-1', 'member')).toBe('own');
    // The status first, so the registrant learns a dispute is gone rather than theirs to skip.
    for (const adminId of ['admin-1', 'admin-2', 'member']) {
      const refusal = (status: 'retracted' | 'dismissed' | 'accepted' | 'closed_by_correction') =>
        disputeDecisionRefusal({ status }, adminId, 'admin-1', 'member');
      expect(refusal('retracted')).toBe('retracted');
      expect(refusal('dismissed')).toBe('decided');
      expect(refusal('accepted')).toBe('decided');
      expect(refusal('closed_by_correction')).toBe('decided');
    }
  });
});

describe('the submission body', () => {
  const body = {
    judgementVersion: 1,
    links: [link],
    reason: '출처의 발표가 다른 값을 말한다.',
    expectedAccountId: account,
  };

  it('takes the version on screen, 1..5 distinct http(s) links and a reason, all required', () => {
    expect(submitDisputeBodySchema.parse(body)).toEqual(body);
    const five = Array.from({ length: DISPUTE_LINKS_MAX }, (_, i) => `${link}/${String(i)}`);
    expect(submitDisputeBodySchema.parse({ ...body, links: five }).links).toEqual(five);
    for (const field of ['judgementVersion', 'links', 'reason', 'expectedAccountId'] as const) {
      const { [field]: _gone, ...without } = body;
      expect(paths(submitDisputeBodySchema.safeParse(without)), field).toEqual([field]);
    }
    expect(paths(submitDisputeBodySchema.safeParse({ ...body, links: [] }))).toEqual(['links']);
    expect(
      paths(submitDisputeBodySchema.safeParse({ ...body, links: [...five, `${link}/x`] })),
    ).toEqual(['links']);
    for (const judgementVersion of [0, 1.5, '1', null]) {
      expect(
        paths(submitDisputeBodySchema.safeParse({ ...body, judgementVersion })),
        String(judgementVersion),
      ).toEqual(['judgementVersion']);
    }
  });

  it('trims each link and refuses one that is not http(s), too long or given twice', () => {
    expect(submitDisputeBodySchema.parse({ ...body, links: [`  ${link}  `] }).links).toEqual([
      link,
    ]);
    for (const bad of ['ftp://example.com/a', 'javascript:alert(1)', 'example.com', '']) {
      expect(
        paths(submitDisputeBodySchema.safeParse({ ...body, links: [link, bad] })),
        bad,
      ).toEqual(['links.1']);
    }
    const long = `https://example.com/${'a'.repeat(DISPUTE_LINK_MAX)}`;
    expect(paths(submitDisputeBodySchema.safeParse({ ...body, links: [long] }))).toEqual([
      'links.0',
    ]);
    const origin = 'https://example.com/';
    const edge = `${origin}${'a'.repeat(DISPUTE_LINK_MAX - origin.length)}`;
    expect(edge).toHaveLength(DISPUTE_LINK_MAX);
    expect(submitDisputeBodySchema.safeParse({ ...body, links: [edge] }).success).toBe(true);
    // Compared trimmed: each repeat is refused on its own index.
    expect(
      issues(submitDisputeBodySchema.safeParse({ ...body, links: [link, ` ${link}`, link] })),
    ).toEqual([
      `links.1: ${MARKET_DISPUTE_REFUSALS.links.duplicateLink}`,
      `links.2: ${MARKET_DISPUTE_REFUSALS.links.duplicateLink}`,
    ]);
    expect(MARKET_DISPUTE_REFUSALS).toEqual({ links: { duplicateLink: 'duplicate' } });
  });

  it('trims the reason, 1..2,000 characters', () => {
    expect(submitDisputeBodySchema.parse({ ...body, reason: '  근거  ' }).reason).toBe('근거');
    expect(
      submitDisputeBodySchema.safeParse({ ...body, reason: 'a'.repeat(DISPUTE_REASON_MAX) })
        .success,
    ).toBe(true);
    for (const reason of ['', '   ', 'a'.repeat(DISPUTE_REASON_MAX + 1)]) {
      expect(paths(submitDisputeBodySchema.safeParse({ ...body, reason })), reason).toEqual([
        'reason',
      ]);
    }
  });

  it('keeps a field the form does not have out of what is stored', () => {
    const parsed = submitDisputeBodySchema.parse({ ...body, status: 'accepted', userId: 'x' });
    expect(parsed).not.toHaveProperty('status');
    expect(parsed).not.toHaveProperty('userId');
  });
});

describe('the retraction and decision bodies', () => {
  it('retracts with the account on screen alone', () => {
    expect(retractDisputeBodySchema).toBe(expectedAccountBodySchema);
    expect(retractDisputeBodySchema.parse({ expectedAccountId: account })).toEqual({
      expectedAccountId: account,
    });
  });

  it('decides with a reason the submitter reads, 1..500 characters, and the admin', () => {
    const body = { reason: '출처의 원문과 같다.', expectedAccountId: 'admin-2' };
    expect(decideDisputeBodySchema.parse(body)).toEqual(body);
    expect(decideDisputeBodySchema.parse({ ...body, reason: ' 같다 ' }).reason).toBe('같다');
    for (const reason of ['', '  ', 'a'.repeat(APPROVAL_REASON_MAX_LENGTH + 1)]) {
      expect(paths(decideDisputeBodySchema.safeParse({ ...body, reason })), reason).toEqual([
        'reason',
      ]);
    }
    const { expectedAccountId: _gone, ...withoutAccount } = body;
    expect(paths(decideDisputeBodySchema.safeParse(withoutAccount))).toEqual(['expectedAccountId']);
  });
});

describe('the read models', () => {
  const market = {
    id: marketId,
    slug: 'kospi-3000',
    title: '코스피 3000?',
    status: 'provisional',
    judgementVersion: 1,
  };
  const fields = {
    id: disputeId,
    judgementVersion: 1,
    links: [link],
    reason: '출처의 발표가 다르다.',
    status: 'pending',
    submittedAt: at,
    decidedAt: null,
    decisionReason: null,
    retractedAt: null,
    closedAt: null,
  };
  const mine = { ...fields, market, retractable: true };
  const admin = {
    ...fields,
    submitter: { id: account, nickname: '예측가' },
    decidedBy: null,
    purgedAt: null,
  };

  it('shows the submitter their dispute, its decision and reason, never who decided it', () => {
    expect(myDisputeSchema.parse(mine)).toEqual(mine);
    const dismissed = {
      ...mine,
      status: 'dismissed',
      decidedAt: at,
      decisionReason: '출처의 원문과 같다.',
      retractable: false,
    };
    expect(myDisputeSchema.parse(dismissed)).toEqual(dismissed);
    const parsed = myDisputeSchema.parse({
      ...dismissed,
      decidedBy: { id: 'admin-2', nickname: '운영자2' },
      submitter: { id: account, nickname: '예측가' },
    });
    expect(parsed).not.toHaveProperty('decidedBy');
    expect(parsed).not.toHaveProperty('submitter');
    for (const field of ['market', 'retractable', 'decisionReason', 'closedAt'] as const) {
      const { [field]: _gone, ...without } = mine;
      expect(paths(myDisputeSchema.safeParse(without)), field).toEqual([field]);
    }
  });

  it('shows a dispute a correction closed or replaced, with the market’s version (#176)', () => {
    // 정정으로 종결: its instant and no decision; the market has moved to the next version.
    const corrected = { ...market, judgementVersion: 2 };
    const closed = {
      ...mine,
      status: 'closed_by_correction',
      closedAt: at,
      market: corrected,
      retractable: false,
    };
    expect(myDisputeSchema.parse(closed)).toEqual(closed);
    // An accepted dispute of the replaced version stays accepted: the version tells it apart.
    const answered = {
      ...mine,
      status: 'accepted',
      decidedAt: at,
      decisionReason: '정정한다.',
      market: corrected,
      retractable: false,
    };
    expect(myDisputeSchema.parse(answered)).toEqual(answered);
    expect(answered.judgementVersion).toBeLessThan(answered.market.judgementVersion);
    // The market's version is a judged market's: never null, never 0.
    for (const judgementVersion of [null, 0, undefined]) {
      expect(
        paths(myDisputeSchema.safeParse({ ...mine, market: { ...market, judgementVersion } })),
        String(judgementVersion),
      ).toEqual(['market.judgementVersion']);
    }
    expect(paths(myDisputeSchema.safeParse({ ...mine, closedAt: 'today' }))).toEqual(['closedAt']);
  });

  it('tells the screen the member’s standing, the version read and their dispute', () => {
    const open = { eligibility: 'eligible', judgementVersion: 1, dispute: null };
    expect(myMarketDisputeSchema.parse(open)).toEqual(open);
    const submitted = { eligibility: 'duplicate', judgementVersion: 1, dispute: mine };
    expect(myMarketDisputeSchema.parse(submitted)).toEqual(submitted);
    const unjudged = { eligibility: 'not_provisional', judgementVersion: null, dispute: null };
    expect(myMarketDisputeSchema.parse(unjudged)).toEqual(unjudged);
    expect(paths(myMarketDisputeSchema.safeParse({ ...open, eligibility: 'restricted' }))).toEqual([
      'eligibility',
    ]);
  });

  it('shows the operators the submitter, the decider and a purge', () => {
    expect(adminMarketDisputeSchema.parse(admin)).toEqual(admin);
    const purged = {
      ...admin,
      links: [],
      reason: '',
      status: 'accepted',
      submitter: { id: account, nickname: null },
      decidedBy: { id: 'admin-2', nickname: '운영자2' },
      decidedAt: at,
      decisionReason: '정정한다.',
      purgedAt: at,
    };
    expect(adminMarketDisputeSchema.parse(purged)).toEqual(purged);
    for (const field of ['submitter', 'decidedBy', 'purgedAt', 'closedAt'] as const) {
      const { [field]: _gone, ...without } = admin;
      expect(paths(adminMarketDisputeSchema.safeParse(without)), field).toEqual([field]);
    }
    // 정정으로 종결 (#176): closed at the correction's approval, nobody deciding it, and purged
    // later like any ended dispute of a closed account.
    const closed = {
      ...admin,
      links: [],
      reason: '',
      status: 'closed_by_correction',
      submitter: { id: account, nickname: null },
      closedAt: at,
      purgedAt: at,
    };
    expect(adminMarketDisputeSchema.parse(closed)).toEqual(closed);
    const state = { holding: 1, items: [admin] };
    expect(adminMarketDisputesSchema.parse(state)).toEqual(state);
    expect(adminMarketDisputesSchema.parse({ holding: 0, items: [] })).toEqual({
      holding: 0,
      items: [],
    });
    for (const holding of [-1, 0.5, '1']) {
      expect(
        paths(adminMarketDisputesSchema.safeParse({ ...state, holding })),
        String(holding),
      ).toEqual(['holding']);
    }
    const item = { ...admin, market };
    expect(adminDisputeQueueItemSchema.parse(item)).toEqual(item);
    expect(paths(adminDisputeQueueItemSchema.safeParse(admin))).toEqual(['market']);
  });

  it('lists the waiting disputes or every other one, waiting unless asked', () => {
    expect(ADMIN_DISPUTE_LIST_STATUSES).toEqual(['pending', 'decided']);
    // 처리됨 holds every ended one, 정정으로 종결 too (#176); a reopened dispute is waiting again.
    expect(ADMIN_DISPUTE_LIST_STATUS_MEMBERS).toEqual({
      pending: ['pending'],
      decided: ['dismissed', 'accepted', 'retracted', 'closed_by_correction'],
    });
    expect(
      [...ADMIN_DISPUTE_LIST_STATUS_MEMBERS.pending, ...ADMIN_DISPUTE_LIST_STATUS_MEMBERS.decided]
        .slice()
        .sort(),
    ).toEqual([...MARKET_DISPUTE_STATUSES].sort());
    expect(adminDisputeListQuerySchema.parse({})).toEqual({ status: 'pending', limit: 20 });
    expect(adminDisputeListQuerySchema.parse({ status: 'decided', limit: '5' })).toEqual({
      status: 'decided',
      limit: 5,
    });
    for (const status of ['dismissed', 'all', '']) {
      expect(adminDisputeListQuerySchema.safeParse({ status }).success, status).toBe(false);
    }
  });
});

describe('the names', () => {
  it('store and answer names no excluded feature reads', () => {
    // The retention empties a closed account's decided ones in place as this kind (ADR-0087 (6)).
    expect(RETENTION_PURGE_KINDS).toContain('market_disputes');
    for (const name of [
      'market_disputes',
      'market_disputes_keep_record',
      'dispute_hold_count',
      'disputeHoldCount',
      'judgement_version',
      'links',
      'reason',
      'submitted_at',
      'submittedAt',
      'decided_by',
      'decidedBy',
      'decided_at',
      'decision_reason',
      'retracted_at',
      'retractedAt',
      'closed_at',
      'closedAt',
      'purged_at',
      'purgedAt',
      'retractable',
      'submitter',
      'eligibility',
      'holding',
      'disputeOpen',
      'disputeUnderReview',
      ...MARKET_DISPUTE_STATUSES,
      ...DISPUTE_NOT_ALLOWED_REASONS,
      ...Object.values(MARKET_DISPUTE_DECISION_ACTION_TYPES),
      'DISPUTE_NOT_ALLOWED',
    ]) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
      expect(findExcludedIdentifier(name, 'storage'), name).toEqual([]);
    }
  });

  it('name each OpenAPI component once, and convert with the admin market', () => {
    const ids = new Set<string>();
    for (const value of Object.values(shared)) {
      if (!(value instanceof z.ZodType)) continue;
      const id = z.globalRegistry.get(value)?.id;
      if (id !== undefined) ids.add(id);
    }
    for (const id of [
      'MarketDisputeStatus',
      'DisputeNotAllowedReason',
      'DisputeNotAllowedDetails',
      'DisputeEligibility',
      'SubmitDisputeBody',
      'DecideDisputeBody',
      'DisputeMarket',
      'MyDispute',
      'MyMarketDispute',
      'AdminMarketDispute',
      'AdminMarketDisputes',
      'AdminDisputeQueueItem',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    expect(() =>
      z.toJSONSchema(
        z.object({
          market: shared.adminMarketSchema,
          submit: submitDisputeBodySchema,
          decide: decideDisputeBodySchema,
          mine: myDisputeSchema,
          standing: myMarketDisputeSchema,
          queue: adminDisputeQueueItemSchema,
          refused: disputeNotAllowedDetailsSchema,
        }),
      ),
    ).not.toThrow();
  });
});
