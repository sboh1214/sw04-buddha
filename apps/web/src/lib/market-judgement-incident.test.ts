import { MARKET_STATUSES, findExcludedText } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AdminMarket, ApiError } from './api';
import {
  INCIDENT_DECISION_TEXTS,
  INCIDENT_STATUS_LABEL,
  type IncidentFormValues,
  adminResultText,
  incidentDraft,
  incidentFailure,
  incidentFormDefaults,
  incidentPaidText,
  incidentResultChoices,
  incidentReviewUnavailable,
  incidentUnregistrable,
  paidRegistrantOf,
  showsJudgementIncidentPanel,
} from './market-judgement-incident';

const PAID_REGISTRANT = { id: 'paid-registrant', nickname: '판정등록한이' };
const INCIDENT_REGISTRANT = { id: 'incident-registrant', nickname: '사건등록한이' };
const REVIEWER = 'reviewer';
const NOW = Date.parse('2026-11-30T03:00:00.000Z');
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

const pending = {
  requestId: 'a1b2c3d4-0000-4000-8000-000000000001',
  correctedResult: 'NO' as const,
  description: '1차 출처가 발표를 정정했습니다.',
  evidence: { links: ['https://example.com/fix'], collectedAt: '2026-11-30T01:00:00.000Z' },
  requestedBy: INCIDENT_REGISTRANT,
  requestedAt: '2026-11-30T02:00:00.000Z',
};

const confirmed = {
  ...pending,
  incidentId: 'b1b2c3d4-0000-4000-8000-000000000001',
  judgementVersion: 1,
  originalResult: 'YES' as const,
  registeredBy: INCIDENT_REGISTRANT,
  confirmedBy: { id: REVIEWER, nickname: '검토한이' },
  registeredAt: pending.requestedAt,
  confirmedAt: '2026-11-30T02:30:00.000Z',
  reason: '정정 발표를 확인했습니다.',
};

/** A market whose YES was paid on judgement v1, registered by PAID_REGISTRANT. */
const market = (
  status: AdminMarket['status'],
  incident: Partial<AdminMarket['judgementIncident']> = {},
  fields: Partial<AdminMarket> = {},
): AdminMarket =>
  ({
    status,
    resolvedResult: 'YES',
    judgementVersion: 1,
    judgement: {
      current: { version: 1, result: 'YES', registeredBy: PAID_REGISTRANT },
      history: [],
      pending: null,
      log: [],
      disputeWindowUndecided: false,
    },
    judgementIncident: {
      registrable: false,
      confirmable: status === 'settled',
      pending: null,
      confirmed: null,
      log: [],
      ...incident,
    },
    ...fields,
  }) as unknown as AdminMarket;

describe('the 판정 오류 사건 panel (#144, ADR-0165)', () => {
  it('is drawn from 결과 확정 on (144-8), and on any market with an incident', () => {
    for (const status of MARKET_STATUSES) {
      expect(showsJudgementIncidentPanel(market(status)), status).toBe(
        ['resolved', 'settling', 'settled'].includes(status),
      );
    }
    // A record never goes away, whatever the status reads.
    expect(showsJudgementIncidentPanel(market('closed', { pending }))).toBe(true);
    expect(showsJudgementIncidentPanel(market('closed', { log: [] }))).toBe(false);
  });

  it('says why a registration is not taken, in the order the server refuses', () => {
    expect(incidentUnregistrable(market('provisional'))).toBe('status');
    expect(incidentUnregistrable(market('cancelled'))).toBe('status');
    expect(incidentUnregistrable(market('settled', {}, { judgementVersion: null }))).toBe('legacy');
    // 144-14: none after a confirmed one, even with none waiting.
    expect(incidentUnregistrable(market('settled', { confirmed }))).toBe('confirmed');
    expect(incidentUnregistrable(market('settled', { pending }))).toBe('pending');
    for (const status of ['resolved', 'settling', 'settled'] as const) {
      expect(incidentUnregistrable(market(status)), status).toBeNull();
    }
  });

  it('names the paid version’s registrant from the current judgement (144-4)', () => {
    expect(paidRegistrantOf(market('settled'))).toBe(PAID_REGISTRANT.id);
    expect(
      paidRegistrantOf({ judgement: { ...market('settled').judgement, current: null } }),
    ).toBeNull();
  });

  it('offers 오류 확인 and 기각 to neither registrant, and 오류 확인 only once paid (144-4, 144-13)', () => {
    const settled = market('settled', { pending });
    expect(incidentReviewUnavailable(settled, 'confirm', undefined)).toBe('operator');
    // The incident's registrant: the approval engine's `requester` (#171).
    expect(incidentReviewUnavailable(settled, 'confirm', INCIDENT_REGISTRANT.id)).toBe('own');
    expect(incidentReviewUnavailable(settled, 'dismiss', INCIDENT_REGISTRANT.id)).toBe('own');
    // The paid version's registrant: both decisions (144-4 '검토' = 오류 확인·기각).
    expect(incidentReviewUnavailable(settled, 'confirm', PAID_REGISTRANT.id)).toBe('registrant');
    expect(incidentReviewUnavailable(settled, 'dismiss', PAID_REGISTRANT.id)).toBe('registrant');
    expect(incidentReviewUnavailable(settled, 'confirm', REVIEWER)).toBeNull();
    expect(incidentReviewUnavailable(settled, 'dismiss', REVIEWER)).toBeNull();
    // 결과 확정·지급 중: 기각 yes, 오류 확인 waits for 지급 완료.
    for (const status of ['resolved', 'settling'] as const) {
      const unpaid = market(status, { pending });
      expect(incidentReviewUnavailable(unpaid, 'confirm', REVIEWER), status).toBe('status');
      expect(incidentReviewUnavailable(unpaid, 'dismiss', REVIEWER), status).toBeNull();
    }
    // The paid registrant may register one (144-4 "사건 등록 … 할 수 있다"): the incident's own
    // registrant is then the same admin, and `own` is what the panel says.
    const self = market('settled', { pending: { ...pending, requestedBy: PAID_REGISTRANT } });
    expect(incidentReviewUnavailable(self, 'confirm', PAID_REGISTRANT.id)).toBe('own');
  });

  it('offers every result but the paid one', () => {
    expect(incidentResultChoices('YES')).toEqual(['NO', 'VOID']);
    expect(incidentResultChoices('VOID')).toEqual(['YES', 'NO']);
    expect(incidentResultChoices(null)).toEqual(['YES', 'NO', 'VOID']);
  });

  it('writes the admin detail’s 결과 line as the paid result, then → 판정 정정 the corrected one', () => {
    expect(adminResultText(market('settled', {}, { resolvedResult: null }))).toBe('—');
    expect(adminResultText(market('settled'))).toBe('YES');
    expect(adminResultText(market('settled', { confirmed }))).toBe('YES → 판정 정정 NO');
    expect(incidentPaidText(1, 'VOID')).toBe('무효 (v1)');
    expect(incidentPaidText(null, 'NO')).toBe('NO');
  });

  it('labels every end of a registration in the approved words (144-19)', () => {
    expect(INCIDENT_STATUS_LABEL).toEqual({
      pending: '검토 중',
      approved: '오류 확인',
      rejected: '기각',
      retracted: '철회',
    });
    expect(INCIDENT_DECISION_TEXTS.confirm.confirm).toBe('오류 확인');
    expect(INCIDENT_DECISION_TEXTS.dismiss.confirm).toBe('기각');
    expect(INCIDENT_DECISION_TEXTS.retract.confirm).toBe('철회');
    expect(copy.adminMarketJudgementIncidentConfirmWaits).toBe(
      '지급이 끝난 뒤 확인할 수 있습니다.',
    );
  });
});

describe('사건 등록’s draft (registerJudgementIncidentBodySchema’s rules)', () => {
  const whole: IncidentFormValues = {
    correctedResult: 'NO',
    description: '  1차 출처가 발표를 정정했습니다.  ',
    links: [' https://example.com/fix ', 'https://example.com/fix-2'],
    collectedLocal: '2026-11-30T11:55',
  };

  it('opens empty, and sends the trimmed fields with the instant in UTC', () => {
    expect(incidentFormDefaults()).toEqual({
      correctedResult: '',
      description: '',
      links: [''],
      collectedLocal: '',
    });
    expect(incidentDraft(whole, 'YES', NOW).registration).toEqual({
      correctedResult: 'NO',
      description: '1차 출처가 발표를 정정했습니다.',
      evidence: {
        links: ['https://example.com/fix', 'https://example.com/fix-2'],
        collectedAt: '2026-11-30T02:55:00.000Z',
      },
    });
  });

  it('refuses the paid result, a missing one, a blank description and bad links or instants', () => {
    const errors = (values: Partial<IncidentFormValues>) =>
      incidentDraft({ ...whole, ...values }, 'YES', NOW).errors;
    expect(errors({ correctedResult: 'YES' }).correctedResult).toBe(
      copy.errMarketJudgementIncidentSameResult,
    );
    expect(errors({ correctedResult: '' }).correctedResult).toBe(
      copy.errMarketJudgementIncidentResult,
    );
    expect(errors({ description: '   ' }).description).toBe(
      copy.errMarketJudgementIncidentDescription,
    );
    expect(errors({ description: 'x'.repeat(501) }).description).toBe(
      copy.errMarketJudgementIncidentDescription,
    );
    expect(errors({ links: ['ftp://example.com'] }).links).toEqual([copy.errMarketJudgementLink]);
    expect(errors({ links: ['https://example.com/a', ' https://example.com/a'] }).links).toEqual([
      null,
      copy.errMarketJudgementLinkDuplicate,
    ]);
    expect(
      errors({ links: Array.from({ length: 6 }, (_, n) => `https://e.com/${String(n)}`) }).links,
    ).toEqual(Array.from({ length: 6 }, () => copy.errMarketJudgementLinks));
    expect(errors({ collectedLocal: '' }).collectedAt).toBe(
      copy.errMarketJudgementCollectedAtRequired,
    );
    // After now (the server checks its own clock again); now itself is taken.
    expect(errors({ collectedLocal: '2026-11-30T12:01' }).collectedAt).toBe(
      copy.errMarketJudgementCollectedAtAfter,
    );
    expect(errors({ collectedLocal: NOW_LOCAL }).collectedAt).toBeNull();
    for (const values of [
      { correctedResult: 'YES' },
      { description: '' },
      { links: [''] },
      { collectedLocal: '' },
    ]) {
      expect(incidentDraft({ ...whole, ...values }, 'YES', NOW).registration).toBeNull();
    }
  });
});

describe('what a refused incident write says', () => {
  it('lands each registration refusal under its field', () => {
    expect(incidentFailure(refused(['correctedResult'], 'same result'))).toEqual({
      kind: 'field',
      field: 'correctedResult',
      message: copy.errMarketJudgementIncidentSameResult,
    });
    expect(incidentFailure(refused(['evidence', 'collectedAt'], 'after now'))).toEqual({
      kind: 'field',
      field: 'collectedAt',
      message: copy.errMarketJudgementCollectedAtAfter,
    });
    expect(incidentFailure(refused(['evidence', 'links', 1], 'duplicate'))).toEqual({
      kind: 'field',
      field: 'links',
      index: 1,
      message: copy.errMarketJudgementLinkDuplicate,
    });
    expect(incidentFailure(refused(['description'], 'too_small'))).toMatchObject({
      field: 'description',
    });
    expect(incidentFailure(refused(['reason'], 'too_small'))).toMatchObject({ field: 'reason' });
  });

  it('says the state refusals above the buttons and reads the detail again', () => {
    for (const [path, message, said] of [
      [['status'], 'not result confirmed', copy.errMarketJudgementIncidentStatus],
      [['status'], 'not settled', copy.errMarketJudgementIncidentNotSettled],
      [['judgement'], 'legacy', copy.errMarketJudgementIncidentLegacy],
      [['incident'], 'confirmed', copy.errMarketJudgementIncidentConfirmed],
      [['incident'], 'pending', copy.errMarketJudgementIncidentPending],
      [['decider'], 'registrant', copy.errMarketJudgementIncidentRegistrant],
      [['requestId'], 'unknown', copy.errMarketJudgementIncidentUnknown],
    ] as const) {
      expect(incidentFailure(refused([...path], message)), message).toEqual({
        kind: 'alert',
        message: said,
        refresh: true,
      });
    }
    for (const [reason, said] of [
      ['requester', copy.errMarketJudgementIncidentRequester],
      ['decided', copy.errApprovalDecided],
      ['retracted', copy.errApprovalRetracted],
      ['not_requester', copy.errApprovalNotRequester],
      ['no_decider', copy.errMarketJudgementIncidentNoDecider],
    ] as const) {
      expect(
        incidentFailure(
          apiError(409, 'APPROVAL_NOT_ALLOWED', [{ path: ['request'], message: reason }]),
        ),
        reason,
      ).toEqual({ kind: 'alert', message: said, refresh: true });
    }
    expect(
      incidentFailure(
        apiError(403, 'FORBIDDEN', [{ path: ['conflict'], message: 'market_conflict' }]),
      ),
    ).toEqual({ kind: 'alert', message: copy.marketConflictRefused, refresh: true });
    expect(incidentFailure(apiError(403, 'FORBIDDEN'))).toEqual({
      kind: 'alert',
      message: copy.adminOnly,
      refresh: false,
    });
    expect(incidentFailure(refused(['noConflictConfirmed'], 'invalid_value'))).toEqual({
      kind: 'alert',
      message: copy.marketConflictConfirmRequired,
      refresh: false,
    });
  });

  it('closes with a toast on another account’s cookie (ADR-0092)', () => {
    expect(
      incidentFailure(
        apiError(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'another' }]),
      ),
    ).toEqual({ kind: 'toast', message: copy.sessionChanged });
  });
});

describe('the incident’s words (#144, 144-19; excluded.ts)', () => {
  it('passes the excluded-feature words and promises no refund or recovery path', () => {
    const texts = Object.entries(copy).filter(
      ([key]) =>
        key.startsWith('adminMarketJudgementIncident') ||
        key.startsWith('errMarketJudgementIncident') ||
        key.startsWith('adminMarketWorkIncident') ||
        [
          'judgingCorrection',
          'judgingCorrectedResult',
          'judgingOriginalResult',
          'judgingCorrectionNoClawback',
          'judgingCorrectionDescription',
          'judgingCorrectionConfirmedAt',
          'judgingPostPayoutReport',
          'marketSettledCorrected',
          'marketResultCorrected',
          'adminMarketResultCorrected',
        ].includes(key),
    );
    expect(texts.length).toBeGreaterThan(60);
    for (const [key, text] of texts) {
      expect(findExcludedText(text), key).toEqual([]);
      // 정산 means the Coin payout alone (terms.ts): an error is a 판정 오류, never a 정산 오류;
      // no refund, principal or transfer word, no 보상 before PR 2, and no 정답 or per-contract
      // amount (ADR-0165 결정 12: the copy outside 144-19's table is held here).
      expect(text, key).not.toMatch(
        /정산 오류|환불|원금|송금|이체|리워드|적립|보상|정답|맞힌|\d+ Coin씩/,
      );
    }
  });
});
