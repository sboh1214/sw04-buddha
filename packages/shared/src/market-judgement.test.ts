import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  APPROVAL_KIND_MAX_LENGTH,
  APPROVAL_KIND_PATTERN,
  APPROVAL_REASON_MAX_LENGTH,
  APPROVAL_REFUSALS,
} from './approvals.js';
import { MARKET_FALLBACK_SOURCES_MAX, MARKET_SOURCE_URL_MAX } from './constants.js';
import { MARKET_RESULTS, MARKET_STATUSES } from './enums.js';
import { expectedAccountBodySchema } from './expected-account.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import * as shared from './index.js';
import {
  DISPUTE_WINDOW_MAX_MINUTES,
  DISPUTE_WINDOW_MIN_MINUTES,
  JUDGEMENT_EVIDENCE_LINKS_MAX,
  JUDGEMENT_EVIDENCE_LINK_MAX,
  MARKET_JUDGEMENT_APPROVAL_KIND,
  MARKET_JUDGEMENT_REFUSALS,
  adminMarketJudgementQueueItemSchema,
  adminMarketJudgementSchema,
  adminMarketJudgementStateSchema,
  approveJudgementBodySchema,
  disputeDeadlineOf,
  type JudgementGrounds,
  judgementCorrectionBodySchema,
  judgementStatusRefusal,
  marketJudgementCorrectionSchema,
  sameJudgementGrounds,
  disputeWindowMinutesSchema,
  duplicateLinkIndexes,
  isBeforeScheduledJudgement,
  isFallbackSourcePriority,
  judgementChoiceRefusals,
  judgementSourcePrioritySchema,
  judgementVersionSchema,
  judgementVoidOnly,
  marketJudgementLogEntrySchema,
  marketJudgementPendingSchema,
  marketJudgementRequestPayloadSchema,
  registerJudgementBodySchema,
  rejectJudgementBodySchema,
  retractJudgementBodySchema,
} from './market-judgement.js';
import { isJudgementDelayed } from './market-times.js';
import { STORABLE_INSTANT_TOO_EARLY } from './market-rules.js';

const at = '2026-11-02T00:00:00.000Z';
const account = 'admin-1';
const requestId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const marketId = '9b2e1f4c-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const approvalId = '6c1d2e3f-4a5b-4c6d-9e7f-8091a2b3c4d5';
const disputeId = '0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';
const registrant = { id: 'admin-1', nickname: '운영자1' };
const reviewer = { id: 'admin-2', nickname: null };
const link = 'https://www.bok.or.kr/press/1';

const issues = (result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [];
const paths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

describe('the judgement and its approval (#152, ADR-0093 decision 1 #173, decision 3)', () => {
  it('names its approval kind like every consumer', () => {
    expect(MARKET_JUDGEMENT_APPROVAL_KIND).toBe('market_judgement');
    expect(APPROVAL_KIND_PATTERN.test(MARKET_JUDGEMENT_APPROVAL_KIND)).toBe(true);
    expect(MARKET_JUDGEMENT_APPROVAL_KIND.length).toBeLessThanOrEqual(APPROVAL_KIND_MAX_LENGTH);
    // The registration is refused when no other admin could decide it (as #80's and #114's).
    expect(APPROVAL_REFUSALS).toContain('no_decider');
  });

  it('bounds the evidence, the window and the version', () => {
    expect(JUDGEMENT_EVIDENCE_LINKS_MAX).toBe(5);
    expect(JUDGEMENT_EVIDENCE_LINK_MAX).toBe(MARKET_SOURCE_URL_MAX);
    // A minute to a week: never confirmed at its publication, and a typo guard above.
    expect([DISPUTE_WINDOW_MIN_MINUTES, DISPUTE_WINDOW_MAX_MINUTES]).toEqual([1, 10_080]);
    for (const value of [1, 1_440, 10_080]) {
      expect(disputeWindowMinutesSchema.safeParse(value).success, String(value)).toBe(true);
    }
    for (const value of [0, 10_081, 1.5, '1440']) {
      expect(disputeWindowMinutesSchema.safeParse(value).success, String(value)).toBe(false);
    }
    expect(judgementVersionSchema.parse(1)).toBe(1);
    for (const value of [0, -1, 1.5, 2_147_483_648]) {
      expect(judgementVersionSchema.safeParse(value).success, String(value)).toBe(false);
    }
    // The primary source and the fallbacks in order (ADR-0097 7-3); only a fallback is one.
    expect(MARKET_FALLBACK_SOURCES_MAX).toBe(3);
    for (const priority of [0, 1, 2, 3]) {
      expect(judgementSourcePrioritySchema.parse(priority)).toBe(priority);
    }
    for (const priority of [-1, 4, 0.5]) {
      expect(judgementSourcePrioritySchema.safeParse(priority).success).toBe(false);
    }
    expect([0, 1, 2, 3].filter(isFallbackSourcePriority)).toEqual([1, 2, 3]);
  });

  it('names its refusals apart under each path, each a message a client maps', () => {
    expect(MARKET_JUDGEMENT_REFUSALS).toEqual({
      status: { notClosed: 'not closed', notProvisional: 'not provisional' },
      correction: { stale: 'stale', unchanged: 'unchanged' },
      judgement: { pending: 'pending' },
      disputeWindow: { undecided: 'undecided' },
      source: { required: 'required', unknown: 'unknown' },
      fallbackReason: { required: 'required', fallbackOnly: 'only for a fallback source' },
      voidReason: { required: 'required', voidOnly: 'only for VOID' },
      result: { voidOnly: 'void only' },
      evidence: { duplicateLink: 'duplicate', collectedAfterNow: 'after now' },
      eventDeadlineConfirmed: { required: 'required' },
      requestId: { unknown: 'unknown' },
    });
    for (const [path, messages] of Object.entries(MARKET_JUDGEMENT_REFUSALS)) {
      const values = Object.values(messages);
      expect(new Set(values).size, path).toBe(values.length);
    }
  });

  it('stores and answers names no excluded feature reads', () => {
    for (const name of [
      'market_judgements',
      'judgement_version',
      'judgementVersion',
      'source_priority',
      'source_name',
      'source_url',
      'fallback_reason',
      'fallbackReason',
      'void_reason',
      'voidReason',
      'evidence_links',
      'evidence_description',
      'collected_at',
      'collectedAt',
      'rule_version',
      'event_deadline_confirmed',
      'eventDeadlineConfirmed',
      'dispute_window_minutes',
      'disputeWindowMinutes',
      'disputeWindowUndecided',
      'published_at',
      'publishedAt',
      'dispute_deadline',
      'disputeDeadline',
      'approval_id',
      'registered_by',
      'registeredBy',
      'approved_by',
      'approvedBy',
      'provisional_event_id',
      // #176 (ADR-0105): the correction's names.
      'correction',
      'correction_reason',
      'correctionReason',
      'correction_pending',
      'correctionPending',
      'baseVersion',
      'disputeIds',
      'closedDisputeIds',
      'reopenedDisputeIds',
      'previousVersion',
      'previousResult',
      'closedDisputes',
      'history',
      'judgement_corrected',
      MARKET_JUDGEMENT_APPROVAL_KIND,
      'provisional',
      'market_judgement_request',
      'market_judgement_approve',
      'market_judgement_reject',
      'market_judgement_retract',
      'market.dispute_window',
      'market.resolve',
      'market-resolve-scan',
    ]) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
      expect(findExcludedIdentifier(name, 'storage'), name).toEqual([]);
    }
  });
});

describe('judgementChoiceRefusals (decision 3 판정 출처, #173 items 9·13)', () => {
  const primary = { priority: 0 };
  const fallback = { priority: 2 };

  it('takes a source for YES and NO, a fallback with its reason and a VOID with its reason', () => {
    for (const choice of [
      { result: 'YES', source: primary },
      { result: 'NO', source: fallback, fallbackReason: '1차 출처의 발표가 없다' },
      { result: 'VOID', source: null, voidReason: '규칙 밖의 출처가 필요하다' },
      { result: 'VOID', source: primary, voidReason: '사건이 취소됐다' },
      { result: 'VOID', source: fallback, fallbackReason: '1차 출처 폐쇄', voidReason: '취소' },
    ] as const) {
      expect(judgementChoiceRefusals(choice), JSON.stringify(choice)).toEqual([]);
    }
  });

  it('refuses a YES or NO without a source, and VOID alone may name none', () => {
    for (const result of ['YES', 'NO'] as const) {
      expect(judgementChoiceRefusals({ result, source: null })).toEqual([
        { path: 'source', message: 'required' },
      ]);
    }
  });

  it('asks a fallback source for its reason and refuses one anywhere else', () => {
    expect(judgementChoiceRefusals({ result: 'YES', source: fallback })).toEqual([
      { path: 'fallbackReason', message: 'required' },
    ]);
    expect(
      judgementChoiceRefusals({ result: 'YES', source: fallback, fallbackReason: null }),
    ).toEqual([{ path: 'fallbackReason', message: 'required' }]);
    expect(
      judgementChoiceRefusals({ result: 'NO', source: primary, fallbackReason: '이유' }),
    ).toEqual([{ path: 'fallbackReason', message: 'only for a fallback source' }]);
    expect(
      judgementChoiceRefusals({
        result: 'VOID',
        source: null,
        fallbackReason: '이유',
        voidReason: '취소',
      }),
    ).toEqual([{ path: 'fallbackReason', message: 'only for a fallback source' }]);
  });

  it('asks a VOID for its reason and refuses one on a YES or NO', () => {
    expect(judgementChoiceRefusals({ result: 'VOID', source: primary })).toEqual([
      { path: 'voidReason', message: 'required' },
    ]);
    expect(judgementChoiceRefusals({ result: 'YES', source: primary, voidReason: '취소' })).toEqual(
      [{ path: 'voidReason', message: 'only for VOID' }],
    );
  });

  it('names every refusal at once, the source first', () => {
    expect(
      judgementChoiceRefusals({ result: 'NO', source: null, fallbackReason: 'x', voidReason: 'y' }),
    ).toEqual([
      { path: 'source', message: 'required' },
      { path: 'fallbackReason', message: 'only for a fallback source' },
      { path: 'voidReason', message: 'only for VOID' },
    ]);
  });
});

describe('the judgement helpers', () => {
  it('finds each link that repeats an earlier one, trimmed and exactly', () => {
    expect(duplicateLinkIndexes([])).toEqual([]);
    expect(duplicateLinkIndexes([link, `${link}/2`])).toEqual([]);
    expect(duplicateLinkIndexes([link, ` ${link} `, `${link}/2`, link])).toEqual([1, 3]);
    // Another spelling of the address is another link.
    expect(duplicateLinkIndexes([link, link.toUpperCase()])).toEqual([]);
  });

  it('takes a VOID alone after an early close reviewed 판정 불가 (ADR-0102)', () => {
    expect(judgementVoidOnly({ endKind: 'early_closed', reviewResult: 'not_judgeable' })).toBe(
      true,
    );
    for (const pause of [
      null,
      { endKind: 'early_closed', reviewResult: 'judgeable' },
      { endKind: 'early_closed', reviewResult: null },
      { endKind: 'closed_at_close', reviewResult: null },
      { endKind: 'resumed', reviewResult: 'judgeable' },
      { endKind: null, reviewResult: null },
    ] as const) {
      expect(judgementVoidOnly(pause), JSON.stringify(pause)).toBe(false);
    }
  });

  it('tells an approval before the scheduled judgement, the complement of the delay', () => {
    const scheduled = '2026-11-02T09:00:00.000Z';
    const ms = Date.parse(scheduled);
    expect(isBeforeScheduledJudgement(scheduled, ms - 1)).toBe(true);
    expect(isBeforeScheduledJudgement(new Date(ms), ms - 1)).toBe(true);
    // At the instant it is no longer before: the delay starts there.
    expect(isBeforeScheduledJudgement(scheduled, ms)).toBe(false);
    expect(isBeforeScheduledJudgement(new Date(ms), ms + 1)).toBe(false);
    for (const nowMs of [ms - 1, ms, ms + 1]) {
      expect(isBeforeScheduledJudgement(scheduled, nowMs)).toBe(
        !isJudgementDelayed(
          {
            status: 'closed',
            scheduledJudgementAt: scheduled,
            disputeDeadline: null,
            disputeHoldCount: 0,
            correctionPending: false,
          },
          nowMs,
        ),
      );
    }
    // A market opened before #22 has no scheduled judgement: no warning, no confirmation.
    expect(isBeforeScheduledJudgement(null, 0)).toBe(false);
  });

  it('tells a correction that changes neither the result nor its grounds (#176)', () => {
    const base = {
      version: 1,
      result: 'NO',
      source: { priority: 1, name: '통계청', url: 'https://kostat.go.kr' },
      fallbackReason: '1차 출처의 발표가 늦어졌다',
      voidReason: null,
      evidence: { links: [link, `${link}/2`], collectedAt: '2026-11-02T00:00:00Z' },
      description: '대체 출처의 발표로 확인했다.',
    } as const;
    // The registration's spelling: the priority alone, reasons left out or trimmed, the instant
    // by its moment.
    const same: JudgementGrounds = {
      result: 'NO',
      source: { priority: 1 },
      fallbackReason: ' 1차 출처의 발표가 늦어졌다 ',
      evidence: {
        links: [` ${link}`, `${link}/2`],
        collectedAt: new Date('2026-11-02T00:00:00.000Z'),
      },
      description: '대체 출처의 발표로 확인했다. ',
    };
    expect(sameJudgementGrounds(base, base)).toBe(true);
    expect(sameJudgementGrounds(base, same)).toBe(true);
    expect(sameJudgementGrounds(same, base)).toBe(true);
    // Each ground changed on its own is a correction — the result kept or not ("결과나 근거").
    const changes: JudgementGrounds[] = [
      { ...same, result: 'YES' },
      { ...same, result: 'VOID', voidReason: '취소' },
      { ...same, source: { priority: 2 } },
      { ...same, source: null },
      { ...same, fallbackReason: '다른 이유' },
      { ...same, fallbackReason: null },
      { ...same, voidReason: '취소' },
      { ...same, evidence: { ...same.evidence, links: [`${link}/2`, link] } },
      { ...same, evidence: { ...same.evidence, links: [link] } },
      { ...same, evidence: { ...same.evidence, links: [link, `${link}/2`, `${link}/3`] } },
      { ...same, evidence: { ...same.evidence, collectedAt: '2026-11-02T00:00:00.001Z' } },
      { ...same, description: '다른 설명' },
    ];
    for (const next of changes) {
      expect(sameJudgementGrounds(base, next), JSON.stringify(next)).toBe(false);
    }
    // A VOID with no source against one with none: the same.
    const voided: JudgementGrounds = { ...same, result: 'VOID', source: null, voidReason: '취소' };
    expect(
      sameJudgementGrounds(voided, { ...voided, fallbackReason: ' 1차 출처의 발표가 늦어졌다' }),
    ).toBe(true);
  });

  it('takes a first judgement on a CLOSED market and a correction on a PROVISIONAL one', () => {
    for (const status of MARKET_STATUSES) {
      expect(judgementStatusRefusal(status, false), status).toBe(
        status === 'closed' ? null : 'not closed',
      );
      // #173 item 8: a correction only before the confirmation — never RESOLVED or later (#144).
      expect(judgementStatusRefusal(status, true), status).toBe(
        status === 'provisional' ? null : 'not provisional',
      );
    }
  });

  it('fixes the deadline at the publication plus the window, to the millisecond', () => {
    const publishedAt = new Date('2026-11-02T23:59:30.123Z');
    expect(disputeDeadlineOf(publishedAt, 1).toISOString()).toBe('2026-11-03T00:00:30.123Z');
    expect(disputeDeadlineOf(publishedAt, 1_440).toISOString()).toBe('2026-11-03T23:59:30.123Z');
  });
});

describe('the registration body', () => {
  const body = {
    noConflictConfirmed: true,
    result: 'YES',
    source: { priority: 0 },
    evidence: { links: [link], collectedAt: at },
    description: '한국은행 발표에서 기준금리 인하를 확인했다.',
    expectedAccountId: account,
  };

  it('requires a fresh explicit conflict acknowledgement without defaulting it', () => {
    for (const noConflictConfirmed of [undefined, false]) {
      expect(
        paths(registerJudgementBodySchema.safeParse({ ...body, noConflictConfirmed })),
      ).toEqual(['noConflictConfirmed']);
      expect(
        paths(
          approveJudgementBodySchema.safeParse({
            reason: '확인',
            eventDeadlineConfirmed: true,
            expectedAccountId: account,
            noConflictConfirmed,
          }),
        ),
      ).toEqual(['noConflictConfirmed']);
    }
  });

  it('takes each result with its source, reasons and evidence, trimmed', () => {
    expect(registerJudgementBodySchema.parse(body)).toEqual({ ...body, correction: null });
    const fallback = {
      ...body,
      result: 'NO',
      source: { priority: 3 },
      fallbackReason: ' 1차 출처가 닫혔다 ',
      voidReason: null,
      evidence: {
        links: [` ${link} `, 'http://example.com/a', 'https://example.com/b'],
        collectedAt: '2026-10-01T09:30:00.000Z',
      },
      description: ' 설명 ',
    };
    expect(registerJudgementBodySchema.parse(fallback)).toEqual({
      ...fallback,
      fallbackReason: '1차 출처가 닫혔다',
      evidence: { ...fallback.evidence, links: [link, ...fallback.evidence.links.slice(1)] },
      description: '설명',
      correction: null,
    });
    // VOID needs no source — a source outside the rules, a 판정 불가 early close — but its reason.
    const voided = { ...body, result: 'VOID', source: null, voidReason: '판정 불가로 조기 마감' };
    expect(registerJudgementBodySchema.parse(voided)).toEqual({ ...voided, correction: null });
    // The source is its priority: the server copies its name and address.
    expect(
      registerJudgementBodySchema.parse({
        ...body,
        source: { priority: 0, name: '가짜', url: 'https://evil.example' },
      }).source,
    ).toEqual({ priority: 0 });
    for (const result of MARKET_RESULTS) {
      const choice = result === 'VOID' ? { voidReason: '취소' } : {};
      expect(registerJudgementBodySchema.safeParse({ ...body, result, ...choice }).success).toBe(
        true,
      );
    }
  });

  it('takes a 판정 정정 of a version with its reason, and none for a first judgement (#176)', () => {
    // Left out or null: a first judgement, as every caller before #176 sends it.
    expect(registerJudgementBodySchema.parse(body).correction).toBeNull();
    expect(registerJudgementBodySchema.parse({ ...body, correction: null }).correction).toBeNull();
    // The version it corrects and the 정정 사유, trimmed; the other fields are the new version's.
    const corrected = registerJudgementBodySchema.parse({
      ...body,
      result: 'NO',
      correction: { baseVersion: 1, reason: ' 1차 출처가 발표를 고쳤다 ' },
    });
    expect(corrected).toEqual({
      ...body,
      result: 'NO',
      correction: { baseVersion: 1, reason: '1차 출처가 발표를 고쳤다' },
    });
    expect(judgementCorrectionBodySchema.parse({ baseVersion: 3, reason: '정정' })).toEqual({
      baseVersion: 3,
      reason: '정정',
    });
    // The server lists the disputes it answers: a client's list is no field.
    expect(
      registerJudgementBodySchema.parse({
        ...body,
        correction: { baseVersion: 2, reason: '정정', disputeIds: [disputeId] },
      }).correction,
    ).toEqual({ baseVersion: 2, reason: '정정' });
    for (const [correction, path] of [
      [{ baseVersion: 0, reason: '정정' }, 'correction.baseVersion'],
      [{ baseVersion: 1.5, reason: '정정' }, 'correction.baseVersion'],
      [{ baseVersion: '1', reason: '정정' }, 'correction.baseVersion'],
      [{ reason: '정정' }, 'correction.baseVersion'],
      [{ baseVersion: 1 }, 'correction.reason'],
      [{ baseVersion: 1, reason: '  ' }, 'correction.reason'],
      [{ baseVersion: 1, reason: 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1) }, 'correction.reason'],
      ['정정', 'correction'],
    ] as const) {
      expect(
        paths(registerJudgementBodySchema.safeParse({ ...body, correction })),
        JSON.stringify(correction),
      ).toEqual([path]);
    }
  });

  it('refuses what the result, the source and the reasons do not go together for', () => {
    expect(issues(registerJudgementBodySchema.safeParse({ ...body, source: null }))).toEqual([
      'source: required',
    ]);
    expect(
      issues(registerJudgementBodySchema.safeParse({ ...body, source: { priority: 1 } })),
    ).toEqual(['fallbackReason: required']);
    expect(
      issues(registerJudgementBodySchema.safeParse({ ...body, fallbackReason: '이유' })),
    ).toEqual(['fallbackReason: only for a fallback source']);
    expect(issues(registerJudgementBodySchema.safeParse({ ...body, result: 'VOID' }))).toEqual([
      'voidReason: required',
    ]);
    expect(issues(registerJudgementBodySchema.safeParse({ ...body, voidReason: '취소' }))).toEqual([
      'voidReason: only for VOID',
    ]);
    // A blank reason is no reason: refused as text, not read as left out.
    expect(
      paths(
        registerJudgementBodySchema.safeParse({
          ...body,
          source: { priority: 1 },
          fallbackReason: '  ',
        }),
      ),
    ).toEqual(['fallbackReason']);
  });

  it('takes one to five distinct http(s) links and an instant from STORABLE_INSTANT_MIN on', () => {
    const evidence = (links: string[], collectedAt = at) => ({
      ...body,
      evidence: { links, collectedAt },
    });
    const five = [1, 2, 3, 4, 5].map((n) => `${link}/${String(n)}`);
    expect(registerJudgementBodySchema.safeParse(evidence(five)).success).toBe(true);
    expect(paths(registerJudgementBodySchema.safeParse(evidence([])))).toEqual(['evidence.links']);
    expect(paths(registerJudgementBodySchema.safeParse(evidence([...five, `${link}/6`])))).toEqual([
      'evidence.links',
    ]);
    expect(
      issues(registerJudgementBodySchema.safeParse(evidence([link, ` ${link}`, link]))),
    ).toEqual(['evidence.links.1: duplicate', 'evidence.links.2: duplicate']);
    const long = `https://example.com/${'a'.repeat(JUDGEMENT_EVIDENCE_LINK_MAX - 19)}`;
    expect(long).toHaveLength(JUDGEMENT_EVIDENCE_LINK_MAX + 1);
    for (const bad of ['', '  ', 'javascript:alert(1)', 'ftp://example.com/a', 'bok.or.kr', long]) {
      expect(paths(registerJudgementBodySchema.safeParse(evidence([bad]))), bad).toEqual([
        'evidence.links.0',
      ]);
    }
    expect(
      issues(registerJudgementBodySchema.safeParse(evidence([link], '0099-12-31T23:59:59.999Z'))),
    ).toEqual([`evidence.collectedAt: ${STORABLE_INSTANT_TOO_EARLY}`]);
    for (const collectedAt of ['2026-11-02', '2026-11-02T09:00:00+09:00', null]) {
      expect(
        paths(
          registerJudgementBodySchema.safeParse({
            ...body,
            evidence: { links: [link], collectedAt },
          }),
        ),
        String(collectedAt),
      ).toEqual(['evidence.collectedAt']);
    }
    expect(paths(registerJudgementBodySchema.safeParse({ ...body, evidence: undefined }))).toEqual([
      'evidence',
    ]);
  });

  it('refuses an unknown result or source, no description, no source key and no account', () => {
    const { source: _source, ...withoutSource } = body;
    const { expectedAccountId: _account, ...withoutAccount } = body;
    for (const [bad, path] of [
      [{ ...body, result: 'MAYBE' }, 'result'],
      [{ ...body, result: 'yes' }, 'result'],
      [withoutSource, 'source'],
      // Out of range is its own one issue, never read as a fallback without its reason.
      [{ ...body, source: { priority: 4 } }, 'source.priority'],
      [{ ...body, source: { priority: -1 } }, 'source.priority'],
      [{ ...body, source: 0 }, 'source'],
      [{ ...body, description: ' ' }, 'description'],
      [{ ...body, description: 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1) }, 'description'],
      [{ ...body, voidReason: 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1) }, 'voidReason'],
      [withoutAccount, 'expectedAccountId'],
    ] as const) {
      expect(paths(registerJudgementBodySchema.safeParse(bad)), path).toEqual([path]);
    }
  });
});

describe('the decision bodies', () => {
  it('take an approval with a reason and the event-deadline confirmation, either way', () => {
    for (const eventDeadlineConfirmed of [true, false]) {
      expect(
        approveJudgementBodySchema.parse({
          noConflictConfirmed: true,
          reason: ' 근거 확인 ',
          eventDeadlineConfirmed,
          expectedAccountId: account,
        }),
      ).toEqual({
        noConflictConfirmed: true,
        reason: '근거 확인',
        eventDeadlineConfirmed,
        expectedAccountId: account,
      });
    }
    for (const [bad, path] of [
      [{ reason: '확인', expectedAccountId: account }, 'eventDeadlineConfirmed'],
      [
        { reason: '확인', eventDeadlineConfirmed: 'true', expectedAccountId: account },
        'eventDeadlineConfirmed',
      ],
      [{ reason: '', eventDeadlineConfirmed: true, expectedAccountId: account }, 'reason'],
      [{ reason: '확인', eventDeadlineConfirmed: true }, 'expectedAccountId'],
    ] as const) {
      expect(
        paths(approveJudgementBodySchema.safeParse({ noConflictConfirmed: true, ...bad })),
        path,
      ).toEqual([path]);
    }
  });

  it('take a 반려 with a reason and a 철회 with the account alone', () => {
    expect(
      rejectJudgementBodySchema.parse({ reason: ' 증거 부족 ', expectedAccountId: account }),
    ).toEqual({ reason: '증거 부족', expectedAccountId: account });
    expect(paths(rejectJudgementBodySchema.safeParse({ expectedAccountId: account }))).toEqual([
      'reason',
    ]);
    expect(paths(rejectJudgementBodySchema.safeParse({ reason: '사유' }))).toEqual([
      'expectedAccountId',
    ]);
    expect(retractJudgementBodySchema).toBe(expectedAccountBodySchema);
    expect(retractJudgementBodySchema.parse({ expectedAccountId: account })).toEqual({
      expectedAccountId: account,
    });
  });
});

describe('the judgement records and read models', () => {
  const source = { priority: 1, name: '통계청', url: 'https://kostat.go.kr' };
  const registration = {
    result: 'NO',
    source,
    fallbackReason: '1차 출처의 발표가 늦어졌다',
    voidReason: null,
    evidence: { links: [link], collectedAt: at },
    description: '대체 출처의 발표로 확인했다.',
    ruleVersion: 2,
  };
  const pending = {
    requestId,
    ...registration,
    correction: null,
    requestedBy: registrant,
    requestedAt: at,
  };
  const correction = { baseVersion: 1, reason: '1차 출처가 정정 발표를 냈다', disputeIds: [] };
  const undecided = {
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    retractedAt: null,
    version: null,
  };
  const current = {
    version: 1,
    ...registration,
    correctionReason: null,
    eventDeadlineConfirmed: false,
    disputeWindowMinutes: 1_440,
    publishedAt: '2026-11-02T01:00:00.000Z',
    disputeDeadline: '2026-11-03T01:00:00.000Z',
    approvalId,
    registeredBy: registrant,
    approvedBy: reviewer,
  };

  it('store the request payload frozen at the insert, its source copied', () => {
    const { description: _description, ...payload } = registration;
    // A row written before #176 has no `correction`: a first judgement's, read as null.
    expect(marketJudgementRequestPayloadSchema.parse(payload)).toEqual({
      ...payload,
      correction: null,
    });
    // A VOID with no source, on a market opened before #80 (no rule version).
    const voided = {
      ...payload,
      result: 'VOID',
      source: null,
      fallbackReason: null,
      voidReason: '판정 불가',
      ruleVersion: null,
    };
    expect(marketJudgementRequestPayloadSchema.parse(voided)).toEqual({
      ...voided,
      correction: null,
    });
    // A 판정 정정 (#176): the version it corrects, its reason and the accepted disputes it answers.
    const correction = {
      baseVersion: 1,
      reason: '1차 출처가 정정 발표를 냈다',
      disputeIds: [disputeId],
    };
    const corrected = { ...payload, correction };
    expect(marketJudgementRequestPayloadSchema.parse(corrected)).toEqual(corrected);
    const unanswered = { ...payload, correction: { ...correction, disputeIds: [] } };
    expect(marketJudgementRequestPayloadSchema.parse(unanswered)).toEqual(unanswered);
    expect(marketJudgementCorrectionSchema.parse(correction)).toEqual(correction);
    for (const [bad, path] of [
      [{ ...correction, baseVersion: 0 }, 'correction.baseVersion'],
      [{ ...correction, disputeIds: ['dispute-1'] }, 'correction.disputeIds.0'],
      [{ baseVersion: 1, reason: '정정' }, 'correction.disputeIds'],
      [{ baseVersion: 1, disputeIds: [] }, 'correction.reason'],
    ] as const) {
      expect(
        paths(marketJudgementRequestPayloadSchema.safeParse({ ...payload, correction: bad })),
        path,
      ).toEqual([path]);
    }
    for (const field of Object.keys(payload)) {
      const { [field as keyof typeof payload]: _gone, ...without } = payload;
      expect(paths(marketJudgementRequestPayloadSchema.safeParse(without)), field).toEqual([field]);
    }
    expect(
      paths(marketJudgementRequestPayloadSchema.safeParse({ ...payload, source: { priority: 1 } })),
    ).toEqual(['source.name', 'source.url']);
  });

  it('show the current judgement with what fixed its deadline and who made it', () => {
    expect(adminMarketJudgementSchema.parse(current)).toEqual(current);
    for (const field of Object.keys(current)) {
      const { [field as keyof typeof current]: _gone, ...without } = current;
      expect(paths(adminMarketJudgementSchema.safeParse(without)), field).toEqual([field]);
    }
    for (const disputeWindowMinutes of [0, 10_081]) {
      expect(
        paths(adminMarketJudgementSchema.safeParse({ ...current, disputeWindowMinutes })),
      ).toEqual(['disputeWindowMinutes']);
    }
    // An account closed since keeps its id with no nickname.
    const closed = { ...current, registeredBy: { id: 'gone', nickname: null } };
    expect(adminMarketJudgementSchema.parse(closed)).toEqual(closed);
    // A correction's version (#176): its 정정 사유, and its base version's window length.
    const corrected = {
      ...current,
      version: 2,
      result: 'YES',
      correctionReason: correction.reason,
      publishedAt: '2026-11-02T12:00:00.000Z',
      disputeDeadline: '2026-11-03T12:00:00.000Z',
    };
    expect(adminMarketJudgementSchema.parse(corrected)).toEqual(corrected);
  });

  it('show the waiting registration, every registration with how it ended, and the queue', () => {
    expect(marketJudgementPendingSchema.parse(pending)).toEqual(pending);
    const waiting = { ...pending, status: 'pending', ...undecided };
    const approved = {
      ...pending,
      status: 'approved',
      ...undecided,
      decidedBy: reviewer,
      decidedAt: at,
      decisionReason: '확인함',
      version: 1,
    };
    const rejected = {
      ...approved,
      status: 'rejected',
      decisionReason: '증거가 부족하다',
      version: null,
    };
    const retracted = { ...pending, status: 'retracted', ...undecided, retractedAt: at };
    // A 판정 정정 (#176) waits and ends as a first judgement does, its correction shown.
    const correcting = { ...pending, correction };
    expect(marketJudgementPendingSchema.parse(correcting)).toEqual(correcting);
    const corrected = { ...approved, correction, version: 2 };
    for (const entry of [waiting, approved, rejected, retracted, corrected]) {
      expect(marketJudgementLogEntrySchema.parse(entry)).toEqual(entry);
    }
    const { correction: _correction, ...withoutCorrection } = pending;
    expect(paths(marketJudgementPendingSchema.safeParse(withoutCorrection))).toEqual([
      'correction',
    ]);
    const { version: _version, ...withoutVersion } = approved;
    expect(paths(marketJudgementLogEntrySchema.safeParse(withoutVersion))).toEqual(['version']);
    const state = {
      current,
      history: [],
      pending,
      log: [waiting, approved],
      disputeWindowUndecided: false,
    };
    expect(adminMarketJudgementStateSchema.parse(state)).toEqual(state);
    const none = {
      current: null,
      history: [],
      pending: null,
      log: [],
      disputeWindowUndecided: true,
    };
    expect(adminMarketJudgementStateSchema.parse(none)).toEqual(none);
    const { disputeWindowUndecided: _undecided, ...withoutWindow } = none;
    expect(paths(adminMarketJudgementStateSchema.safeParse(withoutWindow))).toEqual([
      'disputeWindowUndecided',
    ]);
    // 판정 버전 이력 (#176): the versions a correction replaced, the newest first, each in full.
    const v2 = { ...current, version: 2, correctionReason: '정정', approvalId: requestId };
    const v3 = { ...current, version: 3, correctionReason: '다시 정정' };
    const twice = { ...state, current: v3, history: [v2, current], pending: correcting };
    expect(adminMarketJudgementStateSchema.parse(twice)).toEqual(twice);
    const { history: _history, ...withoutHistory } = state;
    expect(paths(adminMarketJudgementStateSchema.safeParse(withoutHistory))).toEqual(['history']);
    expect(
      paths(adminMarketJudgementStateSchema.safeParse({ ...state, history: [{ version: 1 }] }))[0],
    ).toMatch(/^history\.0\./);
    const item = {
      requestId,
      marketId,
      slug: 'kospi-3000',
      title: '2026년 안에 코스피 3000?',
      status: 'closed',
      closeAt: at,
      scheduledJudgementAt: null,
      result: 'VOID',
      correction: null,
      requestedBy: registrant,
      requestedAt: at,
    };
    expect(adminMarketJudgementQueueItemSchema.parse(item)).toEqual(item);
    // The queue marks a correction (#176): a PROVISIONAL market's.
    const queued = { ...item, status: 'provisional', result: 'NO', correction };
    expect(adminMarketJudgementQueueItemSchema.parse(queued)).toEqual(queued);
    expect(
      paths(adminMarketJudgementQueueItemSchema.safeParse({ ...item, result: 'MAYBE' })),
    ).toEqual(['result']);
  });
});

describe('the OpenAPI component ids of the judgement', () => {
  it('are each named once and convert with the admin market', () => {
    const ids = new Set<string>();
    for (const value of Object.values(shared)) {
      if (!(value instanceof z.ZodType)) continue;
      const id = z.globalRegistry.get(value)?.id;
      if (id !== undefined) ids.add(id);
    }
    for (const id of [
      'JudgementSource',
      'JudgementEvidence',
      'RegisterJudgementBody',
      'ApproveJudgementBody',
      'RejectJudgementBody',
      'AdminMarketJudgement',
      'MarketJudgementPending',
      'MarketJudgementLogEntry',
      'AdminMarketJudgementState',
      'AdminMarketJudgementQueueItem',
      'MarketJudgementCorrection',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    // The interim one-admin judgement's body is gone with its route.
    expect(ids.has('ResolveMarketBody')).toBe(false);
    expect(() =>
      z.toJSONSchema(
        z.object({
          market: shared.adminMarketSchema,
          register: registerJudgementBodySchema,
          approve: approveJudgementBodySchema,
          reject: rejectJudgementBodySchema,
          queue: adminMarketJudgementQueueItemSchema,
        }),
      ),
    ).not.toThrow();
  });
});
