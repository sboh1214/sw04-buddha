import { APPROVAL_REFUSALS, MARKET_STATUSES } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  type AdminMarket,
  type AdminMarketJudgement,
  ApiError,
  type MarketJudgementLogEntry,
  type MarketJudgementPending,
} from './api';
import { formatKst } from './datetime';
import {
  JUDGEMENT_SOURCE_NONE,
  JUDGEMENT_STATUS_LABEL,
  type JudgementFormValues,
  collectedAtWait,
  isJudgementRegistrant,
  judgementApproveDraft,
  judgementCorrectionBase,
  judgementCorrectionDefaults,
  judgementCorrectionEnd,
  judgementCorrectionRows,
  judgementCurrentRows,
  judgementDeadlinePassed,
  judgementDecisionTexts,
  judgementDraft,
  judgementEarly,
  judgementFailure,
  judgementFormDefaults,
  judgementFormUnavailableNote,
  judgementLogRows,
  judgementRegistrationRows,
  judgementSourceChoices,
  judgementSourceLabel,
  judgementSourceText,
  judgementUnapprovable,
  judgementUnapprovableNote,
  judgementUnavailable,
  marketJudgementVoidOnly,
  scheduledJudgementWait,
  showsJudgementPanel,
} from './market-judgement';

const REGISTRANT = { id: 'registrant', nickname: '등록한이' };
const APPROVER = { id: 'approver', nickname: '승인한이' };
const NOW = Date.parse('2026-11-30T03:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;
/** 2026-11-30 12:00 KST = 03:00 UTC: the minute `NOW` is. */
const NOW_LOCAL = '2026-11-30T12:00';

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);
const refused = (path: (string | number)[], message: string) =>
  apiError(400, 'VALIDATION_ERROR', [{ path, message }]);

const none = { current: null, history: [], pending: null, log: [], disputeWindowUndecided: false };

const pending: MarketJudgementPending = {
  requestId: 'a1b2c3d4-0000-4000-8000-000000000001',
  result: 'NO',
  source: { priority: 1, name: '통계청', url: 'https://kostat.go.kr' },
  fallbackReason: '1차 출처가 발표를 미뤘습니다.',
  voidReason: null,
  evidence: {
    links: ['https://kostat.go.kr/a', 'https://kostat.go.kr/b'],
    collectedAt: '2026-11-30T01:00:00.000Z',
  },
  description: '통계청 발표에서 기준을 넘지 않은 것을 확인했습니다.',
  ruleVersion: 2,
  requestedBy: REGISTRANT,
  requestedAt: '2026-11-30T02:00:00.000Z',
  correction: null,
};

const current: AdminMarketJudgement = {
  version: 1,
  result: 'NO',
  source: pending.source,
  fallbackReason: pending.fallbackReason,
  voidReason: null,
  evidence: pending.evidence,
  description: pending.description,
  ruleVersion: 2,
  eventDeadlineConfirmed: true,
  disputeWindowMinutes: 1440,
  publishedAt: '2026-11-30T03:00:00.000Z',
  disputeDeadline: '2026-12-01T03:00:00.000Z',
  approvalId: pending.requestId,
  registeredBy: REGISTRANT,
  approvedBy: APPROVER,
  correctionReason: null,
};

/** A correction of `current` (v1 → v2, #176) waiting for its approval. */
const correcting: MarketJudgementPending = {
  ...pending,
  requestId: 'a1b2c3d4-0000-4000-8000-000000000003',
  result: 'YES',
  source: { priority: 0, name: '기상청', url: 'https://www.weather.go.kr' },
  fallbackReason: null,
  correction: {
    baseVersion: 1,
    reason: '출처가 정정 발표를 냈습니다.',
    disputeIds: ['d1b07384-d9a0-4c9b-8e2f-2d1c0f8a4b11'],
  },
};

/** Each field's value as a good registration holds it, a YES on the primary. */
const good: JudgementFormValues = {
  result: 'YES',
  source: '0',
  fallbackReason: '',
  voidReason: '',
  links: [' https://example.com/a '],
  collectedLocal: '2026-11-30T11:30',
  description: ' 공식 발표를 확인했습니다. ',
  correctionReason: '',
};

/**
 * The pure half of the 판정 screens (#152, ADR-0103): what the panel offers and why not, what the
 * form may send — the rules `registerJudgementBodySchema` holds the API to — and what a refusal
 * says. The panel as drawn is market-judgement-panel.test.tsx's; the API refuses everything again
 * (admin-market-judgements.controller.test.ts).
 */
describe('the panel’s state (#152)', () => {
  it('is drawn from the close on, and for any market with a judgement or a registration', () => {
    const shown = MARKET_STATUSES.filter((status) =>
      showsJudgementPanel({ status, judgement: none }),
    );
    expect(shown).toEqual(['closed', 'provisional']);
    // A confirmed market keeps its record, read-only; one judged before #152 has none.
    expect(showsJudgementPanel({ status: 'resolved', judgement: { ...none, current } })).toBe(true);
    expect(
      showsJudgementPanel({
        status: 'settled',
        judgement: { ...none, log: [{ ...pending, ...logOf('approved') }] },
      }),
    ).toBe(true);
    expect(showsJudgementPanel({ status: 'settled', judgement: none })).toBe(false);
  });

  it('offers 판정 등록 on a closed market with none waiting and the dispute window decided', () => {
    expect(judgementUnavailable({ status: 'closed', judgement: none })).toBeNull();
    expect(judgementUnavailable({ status: 'open', judgement: none })).toBe('status');
    expect(judgementUnavailable({ status: 'provisional', judgement: { ...none, current } })).toBe(
      'status',
    );
    expect(judgementUnavailable({ status: 'closed', judgement: { ...none, pending } })).toBe(
      'pending',
    );
    // ADR-0103: no deadline can be fixed from no value, so the registration is refused too.
    expect(
      judgementUnavailable({
        status: 'closed',
        judgement: { ...none, disputeWindowUndecided: true },
      }),
    ).toBe('undecided');
    expect(judgementFormUnavailableNote('undecided', false)).toBe(
      copy.adminMarketJudgementWindowUndecided,
    );
    expect(judgementFormUnavailableNote('status', false)).toBe(copy.adminMarketJudgementFormStatus);
    expect(judgementFormUnavailableNote('pending', false)).toBe(
      copy.adminMarketJudgementFormPending,
    );
  });

  it('offers 판정 정정 on a provisional market with none waiting, on its current version (#176)', () => {
    const provisional = { status: 'provisional' as const, judgement: { ...none, current } };
    expect(judgementUnavailable(provisional, 1)).toBeNull();
    expect(judgementCorrectionBase(provisional)).toBe(current);
    // #173 item 8: before the confirmation alone; one waiting at a time; on the current version.
    for (const status of MARKET_STATUSES.filter((value) => value !== 'provisional')) {
      expect(judgementUnavailable({ ...provisional, status }, 1), status).toBe('status');
      expect(judgementCorrectionBase({ ...provisional, status }), status).toBeNull();
    }
    expect(judgementUnavailable(provisional, 2)).toBe('stale');
    const waiting = {
      ...provisional,
      judgement: { ...provisional.judgement, pending: correcting },
    };
    expect(judgementUnavailable(waiting, 1)).toBe('pending');
    expect(judgementCorrectionBase(waiting)).toBeNull();
    // A correction reads no setting: an undecided window does not stop it (#173 item 5).
    const undecided = {
      ...provisional,
      judgement: { ...provisional.judgement, disputeWindowUndecided: true },
    };
    expect(judgementUnavailable(undecided, 1)).toBeNull();
    // A market with no judgement has nothing to correct.
    expect(judgementCorrectionBase({ status: 'provisional', judgement: none })).toBeNull();
    expect(judgementFormUnavailableNote('status', true)).toBe(
      copy.adminMarketJudgementCorrectionFormStatus,
    );
    expect(judgementFormUnavailableNote('stale', true)).toBe(
      copy.adminMarketJudgementCorrectionFormStale,
    );
  });

  it('approves a waiting registration only on a closed market with the window decided', () => {
    expect(judgementUnapprovable({ status: 'closed', judgement: { ...none, pending } })).toBeNull();
    expect(judgementUnapprovable({ status: 'provisional', judgement: { ...none, pending } })).toBe(
      'status',
    );
    expect(
      judgementUnapprovable({
        status: 'closed',
        judgement: { ...none, pending, disputeWindowUndecided: true },
      }),
    ).toBe('undecided');
    expect(judgementUnapprovableNote('status', false)).toBe(copy.adminMarketJudgementPendingStatus);
    // The undecided window says it in its own warning.
    expect(judgementUnapprovableNote('undecided', false)).toBeNull();
  });

  it('approves a waiting correction only on a provisional market, on its version (#176)', () => {
    const waiting = { ...none, current, pending: correcting };
    expect(judgementUnapprovable({ status: 'provisional', judgement: waiting })).toBeNull();
    // The payload tells a correction, never the status: a first judgement there is 'status'.
    expect(
      judgementUnapprovable({ status: 'provisional', judgement: { ...waiting, pending } }),
    ).toBe('status');
    expect(judgementUnapprovable({ status: 'resolved', judgement: waiting })).toBe('status');
    expect(
      judgementUnapprovable({
        status: 'provisional',
        judgement: { ...waiting, current: { ...current, version: 2 } },
      }),
    ).toBe('stale');
    // It reads no setting.
    expect(
      judgementUnapprovable({
        status: 'provisional',
        judgement: { ...waiting, disputeWindowUndecided: true },
      }),
    ).toBeNull();
    expect(judgementUnapprovableNote('status', true)).toBe(
      copy.adminMarketJudgementCorrectionPendingStatus,
    );
    expect(judgementUnapprovableNote('stale', true)).toBe(
      copy.adminMarketJudgementCorrectionPendingStale,
    );
  });

  it('bars the registrant alone, and nobody until the admin on screen is known (decision 3 역할)', () => {
    expect(isJudgementRegistrant(pending, REGISTRANT.id)).toBe(true);
    expect(isJudgementRegistrant(pending, APPROVER.id)).toBe(false);
    expect(isJudgementRegistrant(pending, undefined)).toBeUndefined();
  });

  it('takes 무효 alone after an early close reviewed 판정 불가 (ADR-0102)', () => {
    const pause = {
      id: 'p',
      reason: 'basis_change' as const,
      note: '규칙이 사건을 담지 못합니다.',
      resultPublishedAt: null,
      pausedAt: '2026-11-20T00:00:00.000Z',
      pausedBy: APPROVER,
      endedAt: '2026-11-21T00:00:00.000Z',
      endedBy: REGISTRANT,
    };
    const voidOnly = (endKind: 'early_closed' | 'resumed', review: 'judgeable' | 'not_judgeable') =>
      marketJudgementVoidOnly({
        pause: {
          history: [{ ...pause, endKind, reviewResult: review }],
          pending: null,
          log: [],
        },
      });
    expect(voidOnly('early_closed', 'not_judgeable')).toBe(true);
    expect(voidOnly('early_closed', 'judgeable')).toBe(false);
    expect(voidOnly('resumed', 'not_judgeable')).toBe(false);
    expect(marketJudgementVoidOnly({ pause: { history: [], pending: null, log: [] } })).toBe(false);
    expect(judgementFormDefaults(true).result).toBe('VOID');
    expect(judgementFormDefaults(false).result).toBe('');
    expect(judgementFormDefaults(false).correctionReason).toBe('');
  });

  it('prefills a correction with the version it replaces, its reason empty (#176)', () => {
    expect(judgementCorrectionDefaults(current)).toEqual({
      result: 'NO',
      source: '1',
      fallbackReason: pending.fallbackReason,
      voidReason: '',
      links: pending.evidence.links,
      // 2026-11-30 01:00 UTC in KST.
      collectedLocal: '2026-11-30T10:00',
      description: pending.description,
      correctionReason: '',
    });
    // A VOID with no source picks 규칙의 출처 없음 and keeps its reason.
    const voided = judgementCorrectionDefaults({
      ...current,
      result: 'VOID',
      source: null,
      fallbackReason: null,
      voidReason: '규칙 밖의 출처뿐입니다.',
    });
    expect(voided).toMatchObject({
      result: 'VOID',
      source: JUDGEMENT_SOURCE_NONE,
      fallbackReason: '',
      voidReason: '규칙 밖의 출처뿐입니다.',
    });
  });

  it('warns before the scheduled judgement alone, and never without one (decision 3 등록 시점)', () => {
    const at = '2026-11-30T03:00:00.000Z';
    expect(judgementEarly({ scheduledJudgementAt: at }, NOW - 1)).toBe(true);
    expect(judgementEarly({ scheduledJudgementAt: at }, NOW)).toBe(false);
    expect(judgementEarly({ scheduledJudgementAt: null }, 0)).toBe(false);
  });

  it('waits until the scheduled judgement has come, a second over and at most a day', () => {
    const at = '2026-11-30T03:00:00.000Z';
    expect(scheduledJudgementWait({ scheduledJudgementAt: at }, NOW - 60_000)).toBe(61_000);
    expect(scheduledJudgementWait({ scheduledJudgementAt: at }, NOW - 3 * DAY_MS)).toBe(DAY_MS);
    expect(scheduledJudgementWait({ scheduledJudgementAt: at }, NOW)).toBeNull();
    expect(scheduledJudgementWait({ scheduledJudgementAt: null }, NOW)).toBeNull();
  });
});

describe('the sources a judgement may name (decision 3 판정 출처)', () => {
  const sources: Pick<AdminMarket, 'primarySource' | 'fallbackSources'> = {
    primarySource: { name: '기상청', url: 'https://www.weather.go.kr' },
    fallbackSources: [
      { name: '통계청', url: 'https://kostat.go.kr' },
      { name: '언론', url: 'https://news.example.com' },
    ],
  };

  it('are the rule’s by priority: 0 the 1차 출처, 1.. the 대체 출처 in order (ADR-0097 7-3)', () => {
    expect(judgementSourceChoices(sources).map((choice) => choice.priority)).toEqual([0, 1, 2]);
    expect(judgementSourceChoices(sources)[2]?.source.name).toBe('언론');
    expect(judgementSourceChoices({ primarySource: null, fallbackSources: [] })).toEqual([]);
    expect(judgementSourceLabel(0)).toBe('1차 출처');
    expect(judgementSourceLabel(2)).toBe('대체 출처 2');
  });

  it('reads as one line, and none as 규칙의 출처 없음', () => {
    expect(judgementSourceText(pending.source)).toBe('대체 출처 1 · 통계청 (https://kostat.go.kr)');
    expect(judgementSourceText(null)).toBe(copy.adminMarketJudgementSourceNone);
  });
});

function logOf(status: MarketJudgementLogEntry['status']) {
  return {
    status,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    retractedAt: null,
    version: null,
  };
}

describe('the rows', () => {
  it('read a registration whole: result, source, reasons, links, instant, description, version', () => {
    const rows = judgementRegistrationRows(pending, formatKst);
    expect(rows.map((row) => row.label)).toEqual([
      copy.adminMarketJudgementResult,
      copy.adminMarketJudgementSource,
      copy.adminMarketJudgementFallbackReason,
      copy.adminMarketJudgementLinks,
      copy.adminMarketJudgementCollectedAt,
      copy.adminMarketJudgementDescription,
      copy.adminMarketJudgementRuleVersion,
    ]);
    expect(rows[0]?.value).toBe(copy.no);
    expect(rows[3]?.value).toBe('https://kostat.go.kr/a\nhttps://kostat.go.kr/b');
    expect(rows[4]?.value).toBe(formatKst(pending.evidence.collectedAt));
    expect(rows[6]?.value).toBe('v2');
    // A VOID with no source: its reason, and none for the source; a market opened before #80.
    const voided = judgementRegistrationRows(
      {
        ...pending,
        result: 'VOID',
        source: null,
        fallbackReason: null,
        voidReason: '규칙 밖의 출처뿐입니다.',
        ruleVersion: null,
      },
      formatKst,
    );
    expect(voided).toContainEqual({
      label: copy.adminMarketJudgementVoidReason,
      value: '규칙 밖의 출처뿐입니다.',
    });
    expect(voided).toContainEqual({
      label: copy.adminMarketJudgementSource,
      value: copy.adminMarketJudgementSourceNone,
    });
    expect(voided.map((row) => row.label)).not.toContain(copy.adminMarketJudgementFallbackReason);
    expect(voided.at(-1)?.value).toBe(copy.adminMarketJudgementNoRuleVersion);
  });

  it('read the current judgement’s version, registrant, approver, publication, window and deadline', () => {
    expect(judgementCurrentRows(current, formatKst)).toEqual([
      { label: copy.adminMarketJudgementVersion, value: 'v1' },
      { label: copy.adminMarketJudgementRegisteredBy, value: '등록한이' },
      { label: copy.adminMarketJudgementApprovedBy, value: '승인한이' },
      { label: copy.adminMarketJudgementPublishedAt, value: formatKst(current.publishedAt) },
      { label: copy.adminMarketJudgementWindow, value: '1,440분' },
      { label: copy.adminMarketJudgementDeadline, value: formatKst(current.disputeDeadline) },
      {
        label: copy.adminMarketJudgementDeadlineConfirmed,
        value: copy.adminMarketJudgementDeadlineConfirmedDone,
      },
    ]);
    // Approved after the scheduled judgement: nothing was confirmed, and nothing is said.
    expect(
      judgementCurrentRows({ ...current, eventDeadlineConfirmed: false }, formatKst).map(
        (row) => row.label,
      ),
    ).not.toContain(copy.adminMarketJudgementDeadlineConfirmed);
    // An account closed since keeps its place.
    expect(
      judgementCurrentRows(
        { ...current, approvedBy: { id: 'gone', nickname: null } },
        formatKst,
      )[2],
    ).toEqual({ label: copy.adminMarketJudgementApprovedBy, value: copy.postAuthorFormer });
    // A version a correction made says why, last (#176): the history's entries read the same.
    expect(
      judgementCurrentRows(
        { ...current, version: 2, correctionReason: '출처가 정정 발표를 냈습니다.' },
        formatKst,
      ).at(-1),
    ).toEqual({
      label: copy.adminMarketJudgementCorrectionReason,
      value: '출처가 정정 발표를 냈습니다.',
    });
    expect(judgementCurrentRows(current, formatKst).map((row) => row.label)).not.toContain(
      copy.adminMarketJudgementCorrectionReason,
    );
  });

  it('read a log entry with how it ended, never an account id', () => {
    const rejected = judgementLogRows(
      {
        ...pending,
        ...logOf('rejected'),
        decidedBy: APPROVER,
        decidedAt: '2026-11-30T04:00:00.000Z',
        decisionReason: '증거가 부족합니다.',
      },
      formatKst,
    );
    expect(rejected.slice(-3)).toEqual([
      { label: copy.judgementLogDecidedBy, value: '승인한이' },
      { label: copy.judgementLogDecidedAt, value: formatKst('2026-11-30T04:00:00.000Z') },
      { label: copy.judgementLogDecisionReason, value: '증거가 부족합니다.' },
    ]);
    const approved = judgementLogRows({ ...pending, ...logOf('approved'), version: 1 }, formatKst);
    expect(approved).toContainEqual({ label: copy.adminMarketJudgementVersion, value: 'v1' });
    const retracted = judgementLogRows(
      { ...pending, ...logOf('retracted'), retractedAt: '2026-11-30T05:00:00.000Z' },
      formatKst,
    );
    expect(retracted.at(-1)).toEqual({
      label: copy.judgementLogRetractedAt,
      value: formatKst('2026-11-30T05:00:00.000Z'),
    });
    for (const rows of [rejected, approved, retracted]) {
      expect(JSON.stringify(rows)).not.toMatch(/registrant"|approver"/);
    }
    expect(Object.values(JUDGEMENT_STATUS_LABEL)).toEqual(['대기', '승인', '반려', '철회']);
    // A first judgement says no correction.
    expect(approved.map((row) => row.label)).not.toContain(
      copy.adminMarketJudgementCorrectionReason,
    );
  });

  it('read a correction’s move and reason first, never its disputes’ ids (#176)', () => {
    expect(judgementCorrectionRows(correcting.correction)).toEqual([
      { label: copy.adminMarketJudgementCorrectionVersion, value: 'v1 → v2' },
      { label: copy.adminMarketJudgementCorrectionReason, value: '출처가 정정 발표를 냈습니다.' },
    ]);
    expect(judgementCorrectionRows(null)).toEqual([]);
    const rows = judgementLogRows({ ...correcting, ...logOf('approved'), version: 2 }, formatKst);
    expect(rows.slice(0, 2)).toEqual(judgementCorrectionRows(correcting.correction));
    // The move names the version the approval made: no second '판정 버전' row.
    expect(rows.filter((row) => row.label === copy.adminMarketJudgementVersion)).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('d1b07384');
  });
});

describe('judgementDraft (registerJudgementBodySchema’s rules)', () => {
  const draft = (values: Partial<JudgementFormValues>, voidOnly = false) =>
    judgementDraft({ ...good, ...values }, voidOnly, NOW);

  it('sends a whole registration trimmed, the instant in UTC, no reason it takes none of', () => {
    const { ready, registration, needsFallbackReason, needsVoidReason } = draft({});
    expect(ready).toBe(true);
    expect(needsFallbackReason).toBe(false);
    expect(needsVoidReason).toBe(false);
    expect(registration).toEqual({
      result: 'YES',
      source: { priority: 0 },
      fallbackReason: null,
      voidReason: null,
      evidence: { links: ['https://example.com/a'], collectedAt: '2026-11-30T02:30:00.000Z' },
      description: '공식 발표를 확인했습니다.',
      // A first judgement: the generated body asks the key (openapi-typescript's default).
      correction: null,
    });
    // A reason typed and then left behind by another choice is not sent (the API refuses it).
    expect(draft({ fallbackReason: '남은 글', voidReason: '남은 글' }).registration).toMatchObject({
      fallbackReason: null,
      voidReason: null,
    });
  });

  it('asks a result, and 무효 alone after an early close reviewed 판정 불가', () => {
    expect(draft({ result: '' }).errors.result).toBe(copy.errMarketJudgementResult);
    expect(draft({ result: 'MAYBE' }).ready).toBe(false);
    expect(draft({}, true).errors.result).toBe(copy.errMarketJudgementVoidOnly);
    expect(
      draft({ result: 'VOID', source: JUDGEMENT_SOURCE_NONE, voidReason: '판정 불가' }, true).ready,
    ).toBe(true);
  });

  it('asks a source, none for a VOID alone, and the fallback’s reason (decision 3 판정 출처)', () => {
    expect(draft({ source: '' }).errors.source).toBe(copy.errMarketJudgementSource);
    expect(draft({ source: JUDGEMENT_SOURCE_NONE }).errors.source).toBe(
      copy.errMarketJudgementSource,
    );
    const fallback = draft({ source: '2' });
    expect(fallback.needsFallbackReason).toBe(true);
    expect(fallback.errors.fallbackReason).toBe(copy.errMarketJudgementFallbackReason);
    const reasoned = draft({ source: '2', fallbackReason: ' 1차 출처가 닫혔습니다. ' });
    expect(reasoned.ready).toBe(true);
    expect(reasoned.registration).toMatchObject({
      source: { priority: 2 },
      fallbackReason: '1차 출처가 닫혔습니다.',
    });
    expect(draft({ source: '2', fallbackReason: 'a'.repeat(501) }).ready).toBe(false);
  });

  it('asks a VOID its reason and lets it name no source (#173 items 9·13)', () => {
    const voided = draft({ result: 'VOID', source: JUDGEMENT_SOURCE_NONE });
    expect(voided.needsVoidReason).toBe(true);
    expect(voided.errors.voidReason).toBe(copy.errMarketJudgementVoidReason);
    expect(voided.errors.source).toBeNull();
    const ready = draft({ result: 'VOID', source: JUDGEMENT_SOURCE_NONE, voidReason: ' 규칙 밖 ' });
    expect(ready.registration).toMatchObject({
      result: 'VOID',
      source: null,
      voidReason: '규칙 밖',
    });
    // A VOID may still name a rule source.
    expect(draft({ result: 'VOID', voidReason: '규칙 밖' }).registration?.source).toEqual({
      priority: 0,
    });
  });

  it('holds the links to 1..5 distinct http(s) addresses of 500 characters at most', () => {
    const links = draft({
      links: ['https://a.example/1', 'ftp://a.example', '', 'https://a.example/1 '],
    });
    expect(links.errors.links).toEqual([
      null,
      copy.errMarketJudgementLink,
      copy.errMarketJudgementLink,
      copy.errMarketJudgementLinkDuplicate,
    ]);
    expect(draft({ links: [`https://a.example/${'x'.repeat(490)}`] }).errors.links).toEqual([
      copy.errMarketJudgementLink,
    ]);
    expect(draft({ links: [] }).ready).toBe(false);
    expect(
      draft({ links: Array.from({ length: 6 }, (_, at) => `https://a.example/${String(at)}`) })
        .errors.links,
    ).toEqual(Array.from({ length: 6 }, () => copy.errMarketJudgementLinks));
    expect(
      draft({ links: Array.from({ length: 5 }, (_, at) => `https://a.example/${String(at)}`) })
        .ready,
    ).toBe(true);
  });

  it('holds the collection instant to a readable one not after now, with no lower bound', () => {
    expect(draft({ collectedLocal: '' }).errors.collectedAt).toBe(
      copy.errMarketJudgementCollectedAtRequired,
    );
    expect(draft({ collectedLocal: 'nope' }).errors.collectedAt).toBe(
      copy.errMarketJudgementCollectedAtTime,
    );
    expect(draft({ collectedLocal: NOW_LOCAL }).ready).toBe(true);
    expect(draft({ collectedLocal: '2026-11-30T12:01' }).errors.collectedAt).toBe(
      copy.errMarketJudgementCollectedAtAfter,
    );
    // An early result can predate the close: long ago is fine.
    expect(draft({ collectedLocal: '2020-01-01T09:00' }).ready).toBe(true);
    expect(collectedAtWait('2026-11-30T12:01', NOW)).toBe(61_000);
    expect(collectedAtWait(NOW_LOCAL, NOW)).toBeNull();
  });

  it('asks what was confirmed, 1..500 characters', () => {
    expect(draft({ description: '  ' }).errors.description).toBe(
      copy.errMarketJudgementDescription,
    );
    expect(draft({ description: 'a'.repeat(501) }).ready).toBe(false);
    expect(draft({ description: 'a'.repeat(500) }).ready).toBe(true);
  });
});

describe('judgementDraft for a correction (#176, ADR-0105)', () => {
  /** The current judgement with an instant to the millisecond, as an API write could hold it. */
  const base: AdminMarketJudgement = {
    ...current,
    evidence: { ...current.evidence, collectedAt: '2026-11-30T01:00:30.123Z' },
  };
  const prefilled = judgementCorrectionDefaults(base);
  const draft = (values: Partial<JudgementFormValues>) =>
    judgementDraft({ ...prefilled, ...values }, false, NOW, base);

  it('sends the version it replaces and its reason, trimmed, with the new grounds', () => {
    const { ready, registration } = draft({
      result: 'YES',
      source: '0',
      correctionReason: ' 출처가 정정 발표를 냈습니다. ',
    });
    expect(ready).toBe(true);
    expect(registration).toMatchObject({
      result: 'YES',
      source: { priority: 0 },
      // The fallback reason typed for the old source is not sent with the primary.
      fallbackReason: null,
      correction: { baseVersion: 1, reason: '출처가 정정 발표를 냈습니다.' },
    });
  });

  it('asks the correction reason, 1..500 characters', () => {
    const changed = { result: 'YES', source: '0' };
    expect(draft(changed).errors.correctionReason).toBe(copy.errMarketJudgementCorrectionReason);
    expect(draft(changed).ready).toBe(false);
    expect(draft({ ...changed, correctionReason: 'a'.repeat(501) }).ready).toBe(false);
    expect(draft({ ...changed, correctionReason: 'a'.repeat(500) }).ready).toBe(true);
    // A first judgement asks none, whatever the field holds.
    expect(judgementDraft(good, false, NOW).errors.correctionReason).toBeNull();
  });

  it('refuses one that changes neither the result nor its grounds, as the API does (#173 item 7)', () => {
    const same = draft({ correctionReason: '다시 봤습니다.' });
    expect(same.errors.correction).toBe(copy.errMarketJudgementCorrectionUnchanged);
    expect(same.ready).toBe(false);
    expect(same.registration).toBeNull();
    // Untouched, the instant is the base's own to the millisecond: still the same grounds.
    expect(prefilled.collectedLocal).toBe('2026-11-30T10:00');
    // Text compared trimmed: spaces alone change nothing.
    expect(
      draft({ correctionReason: '다시 봤습니다.', description: ` ${base.description} ` }).errors
        .correction,
    ).toBe(copy.errMarketJudgementCorrectionUnchanged);
    // The same result with new grounds is a correction (#173 item 7 '결과나 근거').
    const regrounded = draft({
      correctionReason: '증거를 보탭니다.',
      links: [...base.evidence.links, 'https://kostat.go.kr/c'],
    });
    expect(regrounded.ready).toBe(true);
    expect(regrounded.registration?.result).toBe('NO');
    expect(regrounded.registration?.evidence.collectedAt).toBe(base.evidence.collectedAt);
    // A new instant typed is sent as typed (KST, to the minute).
    expect(
      draft({ correctionReason: '다시 확인했습니다.', collectedLocal: '2026-11-30T11:00' })
        .registration?.evidence.collectedAt,
    ).toBe('2026-11-30T02:00:00.000Z');
  });

  it('compares only grounds that could be sent: each field says what it lacks first', () => {
    const blank = draft({ description: '', correctionReason: '사유' });
    expect(blank.errors.description).toBe(copy.errMarketJudgementDescription);
    expect(blank.errors.correction).toBeNull();
  });
});

describe('judgementApproveDraft (decision 3 등록 시점)', () => {
  it('needs a reason, and before the scheduled judgement the event deadline confirmed', () => {
    expect(judgementApproveDraft('', false, false).ready).toBe(false);
    expect(judgementApproveDraft(' 확인 ', false, false)).toEqual({
      ready: true,
      reason: '확인',
      eventDeadlineConfirmed: false,
    });
    expect(judgementApproveDraft('확인', false, true).ready).toBe(false);
    expect(judgementApproveDraft('확인', true, true)).toEqual({
      ready: true,
      reason: '확인',
      eventDeadlineConfirmed: true,
    });
    // A box checked while not asked is not sent as a confirmation.
    expect(judgementApproveDraft('확인', true, false).eventDeadlineConfirmed).toBe(false);
  });
});

describe('judgementDecisionTexts (#176)', () => {
  /** A correction's end as its dialog reads it: the disputes it carried, the deadline passed. */
  const end = (reopened: number, deadlinePassed: boolean) => ({ reopened, deadlinePassed });

  it('says what each decision does, a correction’s in its own words', () => {
    expect(judgementDecisionTexts('approve', null)).toEqual({
      title: copy.adminMarketJudgementApproveTitle,
      body: copy.adminMarketJudgementApproveBody,
      done: copy.adminMarketJudgementApproved,
    });
    // #173 items 5·8: the first deadline's length from the approval; pending disputes closed.
    const approve = judgementDecisionTexts('approve', end(1, true));
    expect(approve.title).toBe(copy.adminMarketJudgementCorrectionApproveTitle);
    expect(approve.body).toBe(copy.adminMarketJudgementCorrectionApproveBody);
    expect(approve.body).toContain('첫 이의 기한과 같은 길이');
    expect(approve.body).toContain('정정으로 종결');
    expect(approve.done).toBe(copy.adminMarketJudgementCorrectionApproved);
    // Decision 3 '#176 정정 대기': the version carries on.
    for (const kind of ['reject', 'retract'] as const) {
      const texts = judgementDecisionTexts(kind, end(0, false));
      expect(texts.body, kind).toContain('그대로 이어집니다');
      expect(texts.body, kind).not.toContain('거래 마감');
      expect(texts.title, kind).toContain('판정 정정');
    }
    expect(judgementDecisionTexts('reject', null).body).toBe(copy.adminMarketJudgementRejectBody);
    expect(judgementDecisionTexts('retract', null).done).toBe(copy.adminMarketJudgementRetracted);
  });

  it('sends the disputes it carried back to 검토 중 — only when it carried any', () => {
    // Owner answer 2026-11-02: an accepted dispute's correction rejected — or retracted, ADR-0105 —
    // sends it back to 검토 중.
    for (const kind of ['reject', 'retract'] as const) {
      expect(judgementDecisionTexts(kind, end(2, false)).body, kind).toContain(
        copy.adminMarketJudgementCorrectionReopen,
      );
      expect(judgementDecisionTexts(kind, end(2, false)).body, kind).toContain(
        '검토 중으로 돌아갑니다',
      );
      expect(judgementDecisionTexts(kind, end(0, false)).body, kind).not.toContain('검토 중');
    }
    expect(judgementDecisionTexts('reject', end(1, false)).body).toBe(
      `${copy.adminMarketJudgementCorrectionRejectBody} ${copy.adminMarketJudgementCorrectionReopen}`,
    );
    expect(judgementDecisionTexts('reject', end(0, false)).body).toBe(
      copy.adminMarketJudgementCorrectionRejectBody,
    );
  });

  it('says, past the deadline, that the version is confirmed within seconds and then stays', () => {
    // The API queues the confirmation at once once nothing holds it (ADR-0105, as the last 기각).
    expect(copy.adminMarketJudgementCorrectionEndConfirms).toContain('곧 확정');
    expect(copy.adminMarketJudgementCorrectionEndConfirms).toContain('정정할 수 없습니다');
    for (const kind of ['reject', 'retract'] as const) {
      expect(judgementDecisionTexts(kind, end(0, true)).body, kind).toContain(
        copy.adminMarketJudgementCorrectionEndConfirms,
      );
      expect(judgementDecisionTexts(kind, end(0, false)).body, kind).not.toContain('곧 확정');
    }
    // Each sentence in its order, the 철회's question last.
    expect(judgementDecisionTexts('retract', end(1, true)).body).toBe(
      [
        copy.adminMarketJudgementCorrectionRetractBody,
        copy.adminMarketJudgementCorrectionReopen,
        copy.adminMarketJudgementCorrectionEndConfirms,
        copy.adminMarketJudgementCorrectionRetractConfirm,
      ].join(' '),
    );
    expect(judgementDecisionTexts('retract', end(0, false)).body).toBe(
      `${copy.adminMarketJudgementCorrectionRetractBody} ${copy.adminMarketJudgementCorrectionRetractConfirm}`,
    );
    // A first judgement's 반려 and 철회 have no deadline yet to speak of.
    expect(judgementDecisionTexts('reject', null).body).not.toContain('곧 확정');
  });

  it('reads the deadline at the detail’s read instant, and the disputes off the correction', () => {
    const provisional = {
      status: 'provisional' as const,
      disputeDeadline: current.disputeDeadline,
    };
    const deadline = Date.parse(current.disputeDeadline);
    expect(judgementDeadlinePassed(provisional, deadline - 1)).toBe(false);
    expect(judgementDeadlinePassed(provisional, deadline)).toBe(true);
    expect(judgementDeadlinePassed({ ...provisional, status: 'resolved' }, deadline + 1)).toBe(
      false,
    );
    expect(judgementDeadlinePassed({ ...provisional, disputeDeadline: null }, deadline)).toBe(
      false,
    );
    expect(judgementDeadlinePassed({ ...provisional, disputeDeadline: 'x' }, deadline)).toBe(false);
    expect(judgementCorrectionEnd(correcting, provisional, deadline)).toEqual({
      reopened: 1,
      deadlinePassed: true,
    });
    expect(
      judgementCorrectionEnd(
        { correction: { baseVersion: 1, reason: '사유', disputeIds: [] } },
        provisional,
        deadline - 1,
      ),
    ).toEqual({ reopened: 0, deadlinePassed: false });
    // A first judgement's registration, or none: no correction's end.
    expect(judgementCorrectionEnd(pending, provisional, deadline)).toBeNull();
    expect(judgementCorrectionEnd(null, provisional, deadline)).toBeNull();
  });
});

describe('judgementFailure', () => {
  it('says the session changed for another account’s cookie (ADR-0092)', () => {
    expect(
      judgementFailure(
        apiError(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'another' }]),
        'register',
      ),
    ).toEqual({ kind: 'toast', message: copy.sessionChanged });
    expect(judgementFailure(apiError(403, 'FORBIDDEN'), 'decision')).toEqual({
      kind: 'alert',
      message: copy.adminOnly,
      refresh: false,
    });
  });

  it('says every two-person refusal, the registrant’s in its own words, and reads the detail again', () => {
    for (const reason of APPROVAL_REFUSALS) {
      const failure = judgementFailure(
        apiError(409, 'APPROVAL_NOT_ALLOWED', [{ path: ['request'], message: reason }]),
        'decision',
      );
      expect(failure.kind, reason).toBe('alert');
      expect(failure).toHaveProperty('refresh', true);
    }
    expect(
      judgementFailure(
        apiError(409, 'APPROVAL_NOT_ALLOWED', [{ path: ['request'], message: 'requester' }]),
        'decision',
      ),
    ).toMatchObject({ message: copy.adminMarketJudgementExcludedRequester });
    expect(
      judgementFailure(
        apiError(409, 'APPROVAL_NOT_ALLOWED', [{ path: ['request'], message: 'no_decider' }]),
        'register',
      ),
    ).toMatchObject({ message: copy.marketConflictNoDecider });
  });

  it('says the market’s state above the buttons and reads the detail again', () => {
    const alert = (path: string[], message: string, write: 'register' | 'decision' = 'register') =>
      judgementFailure(refused(path, message), write);
    expect(alert(['status'], 'not closed')).toEqual({
      kind: 'alert',
      message: copy.errMarketJudgementStatus,
      refresh: true,
    });
    expect(alert(['status'], 'not closed', 'decision')).toMatchObject({
      message: copy.errMarketJudgementDecisionStatus,
    });
    // A correction's (#176): the market no longer PROVISIONAL, its version moved meanwhile.
    expect(alert(['status'], 'not provisional')).toEqual({
      kind: 'alert',
      message: copy.errMarketJudgementCorrectionStatus,
      refresh: true,
    });
    expect(alert(['status'], 'not provisional', 'decision')).toMatchObject({
      message: copy.errMarketJudgementCorrectionDecisionStatus,
      refresh: true,
    });
    expect(alert(['correction', 'baseVersion'], 'stale')).toEqual({
      kind: 'alert',
      message: copy.errMarketJudgementCorrectionStale,
      refresh: true,
    });
    expect(alert(['correction', 'baseVersion'], 'stale', 'decision')).toMatchObject({
      message: copy.errMarketJudgementCorrectionDecisionStale,
      refresh: true,
    });
    expect(alert(['correction', 'baseVersion'], 'Too small')).toMatchObject({
      kind: 'alert',
      message: copy.errMarketInvalid,
    });
    expect(alert(['judgement'], 'pending')).toMatchObject({
      message: copy.errMarketJudgementPending,
      refresh: true,
    });
    expect(alert(['disputeWindow'], 'undecided', 'decision')).toMatchObject({
      message: copy.adminMarketJudgementWindowUndecided,
      refresh: true,
    });
    expect(alert(['source'], 'unknown')).toMatchObject({
      message: copy.errMarketJudgementSourceUnknown,
      refresh: true,
    });
    expect(alert(['requestId'], 'unknown', 'decision')).toMatchObject({
      message: copy.errMarketJudgementUnknown,
      refresh: true,
    });
    expect(judgementFailure(apiError(404, 'NOT_FOUND'), 'register')).toMatchObject({
      message: copy.adminMarketNotFound,
      refresh: true,
    });
    // A rule version moved under an approval is the API's INTERNAL.
    expect(judgementFailure(apiError(500, 'INTERNAL'), 'decision')).toMatchObject({
      message: copy.errUnknown,
    });
  });

  it('puts every field refusal under its input, a link’s under its own', () => {
    const at = (path: (string | number)[], message: string) =>
      judgementFailure(refused(path, message), 'register');
    expect(at(['result'], 'void only')).toEqual({
      kind: 'field',
      field: 'result',
      message: copy.errMarketJudgementVoidOnly,
    });
    expect(at(['source'], 'required')).toMatchObject({
      field: 'source',
      message: copy.errMarketJudgementSource,
    });
    expect(at(['fallbackReason'], 'required')).toMatchObject({
      message: copy.errMarketJudgementFallbackReason,
    });
    expect(at(['fallbackReason'], 'only for a fallback source')).toMatchObject({
      message: copy.errMarketJudgementFallbackOnly,
    });
    expect(at(['voidReason'], 'required')).toMatchObject({
      message: copy.errMarketJudgementVoidReason,
    });
    expect(at(['voidReason'], 'only for VOID')).toMatchObject({
      message: copy.errMarketJudgementVoidReasonOnly,
    });
    expect(at(['evidence', 'links', 2], 'duplicate')).toEqual({
      kind: 'field',
      field: 'links',
      index: 2,
      message: copy.errMarketJudgementLinkDuplicate,
    });
    expect(at(['evidence', 'links', 0], 'Invalid URL')).toMatchObject({
      index: 0,
      message: copy.errMarketJudgementLink,
    });
    expect(at(['evidence', 'links'], 'Too big')).toEqual({
      kind: 'field',
      field: 'links',
      message: copy.errMarketJudgementLinks,
    });
    expect(at(['evidence', 'collectedAt'], 'after now')).toMatchObject({
      field: 'collectedAt',
      message: copy.errMarketJudgementCollectedAtAfter,
    });
    expect(at(['evidence', 'collectedAt'], 'Invalid')).toMatchObject({
      message: copy.errMarketJudgementCollectedAtTime,
    });
    expect(at(['description'], 'Too small')).toMatchObject({
      field: 'description',
      message: copy.errMarketJudgementDescription,
    });
    // A correction's reason, and a correction that changes nothing (#176).
    expect(at(['correction', 'reason'], 'Too small')).toEqual({
      kind: 'field',
      field: 'correctionReason',
      message: copy.errMarketJudgementCorrectionReason,
    });
    expect(at(['correction'], 'unchanged')).toEqual({
      kind: 'field',
      field: 'correction',
      message: copy.errMarketJudgementCorrectionUnchanged,
    });
    expect(
      judgementFailure(refused(['eventDeadlineConfirmed'], 'required'), 'decision'),
    ).toMatchObject({
      field: 'eventDeadlineConfirmed',
      message: copy.errMarketJudgementDeadlineConfirm,
    });
    expect(judgementFailure(refused(['reason'], 'Too small'), 'decision')).toMatchObject({
      field: 'reason',
      message: copy.errMarketReviewReason,
    });
    expect(at(['somethingElse'], 'x')).toMatchObject({
      kind: 'alert',
      message: copy.errMarketInvalid,
    });
  });
});
