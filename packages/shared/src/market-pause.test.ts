import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  APPROVAL_KIND_MAX_LENGTH,
  APPROVAL_KIND_PATTERN,
  APPROVAL_REASON_MAX_LENGTH,
  APPROVAL_REFUSALS,
} from './approvals.js';
import { MARKET_STATUSES } from './enums.js';
import { expectedAccountBodySchema } from './expected-account.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import * as shared from './index.js';
import { MARKET_LIFECYCLE_TRANSITIONS, canTransitionMarket } from './market-lifecycle.js';
import {
  MARKET_PAUSE_DECISION_APPROVAL_KIND,
  MARKET_PAUSE_END_KINDS,
  MARKET_PAUSE_PATHS,
  MARKET_PAUSE_PATH_END_KINDS,
  MARKET_PAUSE_PATH_STATUSES,
  MARKET_PAUSE_REASONS,
  MARKET_PAUSE_REFUSALS,
  MARKET_PAUSE_REVIEW_RESULTS,
  adminMarketPauseDecisionItemSchema,
  adminMarketPauseSchema,
  adminMarketPauseStateSchema,
  approvePauseDecisionBodySchema,
  marketPauseDecisionLogEntrySchema,
  marketPauseDecisionPendingSchema,
  marketPauseDecisionRequestPayloadSchema,
  marketPauseEndKindSchema,
  marketPausePathSchema,
  marketPauseReasonSchema,
  marketPauseReviewResultSchema,
  pauseDecisionRefusal,
  pauseMarketBodySchema,
  pauseReasonNeedsPublishedAt,
  pauseReasonNeedsReview,
  rejectPauseDecisionBodySchema,
  requestPauseDecisionBodySchema,
  retractPauseDecisionBodySchema,
} from './market-pause.js';
import { STORABLE_INSTANT_TOO_EARLY } from './market-rules.js';

const at = '2026-11-02T00:00:00.000Z';
const account = 'admin-1';
const requestId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const marketId = '9b2e1f4c-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const pauseId = '6c1d2e3f-4a5b-4c6d-9e7f-8091a2b3c4d5';
const requester = { id: 'admin-1', nickname: '운영자1' };
const approver = { id: 'admin-2', nickname: null };

const issues = (result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [];
const paths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

describe('the pause and its next path (#114, ADR-0093 decision 1 #173 items 2·3·4)', () => {
  it('names its approval kind like every consumer', () => {
    expect(MARKET_PAUSE_DECISION_APPROVAL_KIND).toBe('market_pause_decision');
    expect(APPROVAL_KIND_PATTERN.test(MARKET_PAUSE_DECISION_APPROVAL_KIND)).toBe(true);
    expect(MARKET_PAUSE_DECISION_APPROVAL_KIND.length).toBeLessThanOrEqual(
      APPROVAL_KIND_MAX_LENGTH,
    );
    // The request is refused when no other admin could decide it (#139's refusal, as #80's).
    expect(APPROVAL_REFUSALS).toContain('no_decider');
  });

  it('pauses for the three reasons only (#173 item 3), Q2’s earlier schedule among them', () => {
    expect(MARKET_PAUSE_REASONS).toEqual(['early_result', 'ledger_failure', 'basis_change']);
    expect(marketPauseReasonSchema.options).toEqual([...MARKET_PAUSE_REASONS]);
    for (const other of ['schedule_change', 'bot_stop', 'other', '']) {
      expect(marketPauseReasonSchema.safeParse(other).success, other).toBe(false);
    }
    // Only an early result records the publication instant; only a basis change is reviewed.
    expect(MARKET_PAUSE_REASONS.filter(pauseReasonNeedsPublishedAt)).toEqual(['early_result']);
    expect(MARKET_PAUSE_REASONS.filter(pauseReasonNeedsReview)).toEqual(['basis_change']);
  });

  it('reviews a basis change as judgeable or not, and ends a pause by a path or the close', () => {
    expect(MARKET_PAUSE_REVIEW_RESULTS).toEqual(['judgeable', 'not_judgeable']);
    expect(marketPauseReviewResultSchema.options).toEqual([...MARKET_PAUSE_REVIEW_RESULTS]);
    expect(MARKET_PAUSE_PATHS).toEqual(['resume', 'early_close']);
    expect(marketPausePathSchema.options).toEqual([...MARKET_PAUSE_PATHS]);
    expect(MARKET_PAUSE_END_KINDS).toEqual(['resumed', 'early_closed', 'closed_at_close']);
    expect(marketPauseEndKindSchema.options).toEqual([...MARKET_PAUSE_END_KINDS]);
    // Each path is a lifecycle edge out of PAUSED and gives the pause its own end; the worker's
    // close at `close_at` is the third end, which no path gives.
    expect(MARKET_PAUSE_PATH_STATUSES).toEqual({ resume: 'open', early_close: 'closed' });
    for (const path of MARKET_PAUSE_PATHS) {
      expect(canTransitionMarket('paused', MARKET_PAUSE_PATH_STATUSES[path]), path).toBe(true);
    }
    expect(MARKET_LIFECYCLE_TRANSITIONS.open).toContain('paused');
    expect(MARKET_PAUSE_PATH_END_KINDS).toEqual({ resume: 'resumed', early_close: 'early_closed' });
    expect(Object.values(MARKET_PAUSE_PATH_END_KINDS)).not.toContain('closed_at_close');
    // No reopening after the close (#173 item 4).
    expect(canTransitionMarket('closed', 'open')).toBe(false);
    expect(canTransitionMarket('closed', 'paused')).toBe(false);
    // Every stored value fits its varchar(40) column.
    for (const value of [
      ...MARKET_PAUSE_REASONS,
      ...MARKET_PAUSE_REVIEW_RESULTS,
      ...MARKET_PAUSE_END_KINDS,
      ...MARKET_PAUSE_PATHS,
    ]) {
      expect(value.length).toBeLessThanOrEqual(40);
    }
    for (const status of Object.values(MARKET_PAUSE_PATH_STATUSES)) {
      expect(MARKET_STATUSES).toContain(status);
    }
  });

  it('names its refusals apart under each path, each a message a client maps', () => {
    expect(MARKET_PAUSE_REFUSALS).toEqual({
      status: { notOpen: 'not open', notPaused: 'not paused' },
      closeAt: { closed: 'closed' },
      pause: { pending: 'pending', stale: 'stale' },
      reviewResult: { required: 'required', basisChangeOnly: 'only for basis_change' },
      path: { earlyCloseOnly: 'early close only' },
      resultPublishedAt: {
        required: 'required',
        earlyResultOnly: 'only for early_result',
        afterPause: 'after the pause',
      },
    });
    for (const [path, messages] of Object.entries(MARKET_PAUSE_REFUSALS)) {
      const values = Object.values(messages);
      expect(new Set(values).size, path).toBe(values.length);
    }
  });

  it('stores and answers names no excluded feature reads', () => {
    for (const name of [
      'market_pauses',
      'pausedAt',
      'pausedBy',
      'paused_by',
      'resultPublishedAt',
      'result_published_at',
      'reviewResult',
      'review_result',
      'endKind',
      'end_kind',
      'endedBy',
      'end_approval_id',
      'pause_event_id',
      'end_event_id',
      'pauseId',
      MARKET_PAUSE_DECISION_APPROVAL_KIND,
      ...MARKET_PAUSE_REASONS,
      ...MARKET_PAUSE_REVIEW_RESULTS,
      ...MARKET_PAUSE_PATHS,
      ...MARKET_PAUSE_END_KINDS,
    ]) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
      expect(findExcludedIdentifier(name, 'storage'), name).toEqual([]);
    }
  });
});

describe('pauseDecisionRefusal (owner answers Q1·Q2, 2026-11-02)', () => {
  it('lets a basis change go either way once judgeable, and only close early when not', () => {
    for (const path of MARKET_PAUSE_PATHS) {
      expect(pauseDecisionRefusal('basis_change', { path, reviewResult: 'judgeable' })).toBeNull();
    }
    // Q2: an earlier schedule is a basis change reviewed judgeable and closed early.
    expect(
      pauseDecisionRefusal('basis_change', { path: 'early_close', reviewResult: 'judgeable' }),
    ).toBeNull();
    expect(
      pauseDecisionRefusal('basis_change', { path: 'early_close', reviewResult: 'not_judgeable' }),
    ).toBeNull();
    expect(
      pauseDecisionRefusal('basis_change', { path: 'resume', reviewResult: 'not_judgeable' }),
    ).toEqual({ path: 'path', message: 'early close only' });
  });

  it('requires the review of a basis change and refuses one for any other reason first', () => {
    for (const path of MARKET_PAUSE_PATHS) {
      for (const reviewResult of [undefined, null]) {
        expect(pauseDecisionRefusal('basis_change', { path, reviewResult })).toEqual({
          path: 'reviewResult',
          message: 'required',
        });
      }
    }
    for (const reason of ['early_result', 'ledger_failure'] as const) {
      for (const path of MARKET_PAUSE_PATHS) {
        // The operator's choice, with no review (#173 items 2·4).
        expect(pauseDecisionRefusal(reason, { path })).toBeNull();
        expect(pauseDecisionRefusal(reason, { path, reviewResult: null })).toBeNull();
        for (const reviewResult of MARKET_PAUSE_REVIEW_RESULTS) {
          // The review result is named before the path, even where the path is refused too.
          expect(pauseDecisionRefusal(reason, { path, reviewResult })).toEqual({
            path: 'reviewResult',
            message: 'only for basis_change',
          });
        }
      }
    }
  });
});

describe('the pause body', () => {
  const body = {
    reason: 'ledger_failure',
    note: ' 원장 대사가 맞지 않는다. ',
    publicNoteConfirmed: true,
    expectedAccountId: account,
  };

  it('takes each reason with a trimmed note, the publication instant for an early result', () => {
    expect(pauseMarketBodySchema.parse(body)).toEqual({
      reason: 'ledger_failure',
      note: '원장 대사가 맞지 않는다.',
      publicNoteConfirmed: true,
      expectedAccountId: account,
    });
    for (const reason of ['ledger_failure', 'basis_change']) {
      expect(
        pauseMarketBodySchema.parse({ ...body, reason, resultPublishedAt: null }),
      ).toMatchObject({ reason, resultPublishedAt: null });
    }
    expect(
      pauseMarketBodySchema.parse({ ...body, reason: 'early_result', resultPublishedAt: at }),
    ).toEqual({
      reason: 'early_result',
      note: '원장 대사가 맞지 않는다.',
      publicNoteConfirmed: true,
      resultPublishedAt: at,
      expectedAccountId: account,
    });
  });

  it('requires a literal public-note acknowledgement from new clients', () => {
    for (const publicNoteConfirmed of [undefined, null, false, 'true', 1]) {
      expect(paths(pauseMarketBodySchema.safeParse({ ...body, publicNoteConfirmed }))).toEqual([
        'publicNoteConfirmed',
      ]);
    }
  });

  it('requires the publication instant for an early result and refuses it for any other', () => {
    for (const resultPublishedAt of [undefined, null]) {
      expect(
        issues(
          pauseMarketBodySchema.safeParse({ ...body, reason: 'early_result', resultPublishedAt }),
        ),
      ).toEqual(['resultPublishedAt: required']);
    }
    for (const reason of ['ledger_failure', 'basis_change']) {
      expect(
        issues(pauseMarketBodySchema.safeParse({ ...body, reason, resultPublishedAt: at })),
      ).toEqual(['resultPublishedAt: only for early_result']);
    }
    // An instant the database stores, as every market time; whether it is after the pause is the
    // service's (the database clock).
    expect(
      issues(
        pauseMarketBodySchema.safeParse({
          ...body,
          reason: 'early_result',
          resultPublishedAt: '0099-12-31T23:59:59.999Z',
        }),
      ),
    ).toEqual([`resultPublishedAt: ${STORABLE_INSTANT_TOO_EARLY}`]);
    expect(
      paths(
        pauseMarketBodySchema.safeParse({
          ...body,
          reason: 'early_result',
          resultPublishedAt: '2026-11-02 09:00',
        }),
      ),
    ).toEqual(['resultPublishedAt']);
  });

  it('refuses a reason outside the three, a note out of bounds and no account', () => {
    for (const reason of [undefined, 'other', 'early-result']) {
      expect(paths(pauseMarketBodySchema.safeParse({ ...body, reason }))).toEqual(['reason']);
    }
    for (const note of [undefined, null, '', '   ', 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1)]) {
      expect(paths(pauseMarketBodySchema.safeParse({ ...body, note }))).toEqual(['note']);
    }
    expect(
      pauseMarketBodySchema.parse({ ...body, note: 'x'.repeat(APPROVAL_REASON_MAX_LENGTH) }).note,
    ).toHaveLength(APPROVAL_REASON_MAX_LENGTH);
    expect(paths(pauseMarketBodySchema.safeParse({ ...body, expectedAccountId: '' }))).toEqual([
      'expectedAccountId',
    ]);
  });
});

describe('the next-path bodies', () => {
  const body = { pauseId, path: 'resume', reason: ' 대사를 마쳤다 ', expectedAccountId: account };

  it('take a request of a pause for either path, with or without a review result, trimmed', () => {
    for (const path of MARKET_PAUSE_PATHS) {
      expect(requestPauseDecisionBodySchema.parse({ ...body, path })).toEqual({
        pauseId,
        path,
        reason: '대사를 마쳤다',
        expectedAccountId: account,
      });
      for (const reviewResult of [null, ...MARKET_PAUSE_REVIEW_RESULTS]) {
        expect(
          requestPauseDecisionBodySchema.parse({ ...body, path, reviewResult }).reviewResult,
        ).toBe(reviewResult);
      }
    }
    // Shapes alone: what the pause's reason allows is the service's (pauseDecisionRefusal).
    expect(
      requestPauseDecisionBodySchema.safeParse({ ...body, reviewResult: 'not_judgeable' }).success,
    ).toBe(true);
  });

  it('refuse a request with no pause, an unknown path or result, no reason or no account', () => {
    // The pause its author saw (`pause` 'stale' when it is not the lasting one: the service's).
    for (const id of [undefined, null, '', 'pause-1', pauseId.slice(1)]) {
      expect(paths(requestPauseDecisionBodySchema.safeParse({ ...body, pauseId: id }))).toEqual([
        'pauseId',
      ]);
    }
    for (const path of [undefined, null, 'close', 'reopen']) {
      expect(paths(requestPauseDecisionBodySchema.safeParse({ ...body, path }))).toEqual(['path']);
    }
    for (const reviewResult of ['', 'void', 'unjudgeable']) {
      expect(paths(requestPauseDecisionBodySchema.safeParse({ ...body, reviewResult }))).toEqual([
        'reviewResult',
      ]);
    }
    for (const reason of [undefined, '', ' ', 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1)]) {
      expect(paths(requestPauseDecisionBodySchema.safeParse({ ...body, reason }))).toEqual([
        'reason',
      ]);
    }
    expect(
      paths(requestPauseDecisionBodySchema.safeParse({ ...body, expectedAccountId: undefined })),
    ).toEqual(['expectedAccountId']);
  });

  it('take an approval and a 반려 each with a reason, and a 철회 with the account alone', () => {
    for (const schema of [approvePauseDecisionBodySchema, rejectPauseDecisionBodySchema]) {
      expect(schema.parse({ reason: ' 확인함 ', expectedAccountId: account })).toEqual({
        reason: '확인함',
        expectedAccountId: account,
      });
      for (const reason of ['', ' ', 'x'.repeat(APPROVAL_REASON_MAX_LENGTH + 1), undefined]) {
        expect(paths(schema.safeParse({ reason, expectedAccountId: account }))).toEqual(['reason']);
      }
      expect(paths(schema.safeParse({ reason: '확인함' }))).toEqual(['expectedAccountId']);
    }
    expect(retractPauseDecisionBodySchema).toBe(expectedAccountBodySchema);
    expect(retractPauseDecisionBodySchema.parse({ expectedAccountId: account })).toEqual({
      expectedAccountId: account,
    });
  });
});

describe('the pause records and read models', () => {
  const pause = {
    id: pauseId,
    reason: 'basis_change',
    note: '사건 일정이 앞당겨졌다.',
    resultPublishedAt: null,
    pausedAt: at,
    pausedBy: requester,
    reviewResult: null,
    endKind: null,
    endedAt: null,
    endedBy: null,
  };
  const pending = {
    requestId,
    pauseId,
    path: 'early_close',
    reviewResult: 'judgeable',
    reason: '일정이 앞당겨져 마감을 당긴다',
    requestedBy: requester,
    requestedAt: at,
  };
  const undecided = {
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    retractedAt: null,
  };

  it('store the request payload frozen at the insert', () => {
    const payload = { pauseId, path: 'resume', reviewResult: null };
    expect(marketPauseDecisionRequestPayloadSchema.parse(payload)).toEqual(payload);
    expect(
      paths(marketPauseDecisionRequestPayloadSchema.safeParse({ pauseId, path: 'resume' })),
    ).toEqual(['reviewResult']);
    expect(
      paths(marketPauseDecisionRequestPayloadSchema.safeParse({ ...payload, pauseId: 'x' })),
    ).toEqual(['pauseId']);
  });

  it('show each pause with how it ended, nobody for the worker’s close', () => {
    expect(adminMarketPauseSchema.parse(pause)).toEqual(pause);
    const closedEarly = {
      ...pause,
      reviewResult: 'not_judgeable',
      endKind: 'early_closed',
      endedAt: '2026-11-02T01:00:00.000Z',
      endedBy: approver,
    };
    const earlyResult = {
      ...pause,
      reason: 'early_result',
      resultPublishedAt: '2026-11-01T23:50:00.000Z',
      endKind: 'closed_at_close',
      endedAt: '2026-11-02T03:00:00.000Z',
    };
    for (const entry of [closedEarly, earlyResult]) {
      expect(adminMarketPauseSchema.parse(entry)).toEqual(entry);
    }
    // Every field is said, null where it has none.
    for (const field of Object.keys(pause)) {
      const { [field as keyof typeof pause]: _gone, ...without } = pause;
      expect(paths(adminMarketPauseSchema.safeParse(without)), field).toEqual([field]);
    }
    expect(paths(adminMarketPauseSchema.safeParse({ ...pause, endKind: 'reopened' }))).toEqual([
      'endKind',
    ]);
  });

  it('show the waiting request, every request with how it ended, and the queue', () => {
    expect(marketPauseDecisionPendingSchema.parse(pending)).toEqual(pending);
    const waiting = { ...pending, status: 'pending', ...undecided };
    const approved = {
      ...pending,
      status: 'approved',
      ...undecided,
      decidedBy: approver,
      decidedAt: at,
      decisionReason: '확인함',
    };
    const rejected = { ...approved, status: 'rejected', decisionReason: '아직 이르다' };
    const retracted = { ...pending, status: 'retracted', ...undecided, retractedAt: at };
    for (const entry of [waiting, approved, rejected, retracted]) {
      expect(marketPauseDecisionLogEntrySchema.parse(entry)).toEqual(entry);
    }
    const { retractedAt: _retractedAt, ...withoutRetraction } = approved;
    expect(paths(marketPauseDecisionLogEntrySchema.safeParse(withoutRetraction))).toEqual([
      'retractedAt',
    ]);
    const state = { history: [pause], pending, log: [waiting, retracted] };
    expect(adminMarketPauseStateSchema.parse(state)).toEqual(state);
    const none = { history: [], pending: null, log: [] };
    expect(adminMarketPauseStateSchema.parse(none)).toEqual(none);
    const item = {
      requestId,
      marketId,
      slug: 'kospi-3000',
      title: '2026년 안에 코스피 3000?',
      status: 'closed',
      closeAt: at,
      pauseId,
      reason: 'basis_change',
      path: 'early_close',
      reviewResult: 'judgeable',
      requestedBy: requester,
      requestedAt: at,
    };
    expect(adminMarketPauseDecisionItemSchema.parse(item)).toEqual(item);
    expect(
      paths(adminMarketPauseDecisionItemSchema.safeParse({ ...item, reason: 'meaning_change' })),
    ).toEqual(['reason']);
  });
});

describe('the OpenAPI component ids of the pause', () => {
  it('are each named once and convert with the admin market', () => {
    const ids = new Set<string>();
    for (const value of Object.values(shared)) {
      if (!(value instanceof z.ZodType)) continue;
      const id = z.globalRegistry.get(value)?.id;
      if (id !== undefined) ids.add(id);
    }
    for (const id of [
      'MarketPauseReason',
      'MarketPauseReviewResult',
      'MarketPausePath',
      'MarketPauseEndKind',
      'PauseMarketBody',
      'RequestPauseDecisionBody',
      'ApprovePauseDecisionBody',
      'RejectPauseDecisionBody',
      'AdminMarketPause',
      'MarketPauseDecisionPending',
      'MarketPauseDecisionLogEntry',
      'AdminMarketPauseState',
      'AdminMarketPauseDecisionItem',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    expect(() =>
      z.toJSONSchema(
        z.object({
          market: shared.adminMarketSchema,
          pause: pauseMarketBodySchema,
          request: requestPauseDecisionBodySchema,
          approve: approvePauseDecisionBodySchema,
          reject: rejectPauseDecisionBodySchema,
          queue: adminMarketPauseDecisionItemSchema,
        }),
      ),
    ).not.toThrow();
  });
});
