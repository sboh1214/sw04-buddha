import {
  AUDIT_FAILURE_KINDS,
  MARKET_EVENT_TYPES,
  MARKET_STATUSES,
  MINUS_SIGN,
  PUBLIC_MARKET_STATUSES,
  SETTLEMENT_STEPS,
  SETTLEMENT_STEP_STATUSES,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError } from './api';
import { formatKst } from './datetime';
import {
  AUDIT_FAILURE_KIND_LABEL,
  CLOSING_SOON_MS,
  MARKET_EVENT_LABEL,
  MARKET_STATUS_LABEL,
  MARKET_STATUS_PALETTE,
  SETTLEMENT_STEP_LABEL,
  SETTLEMENT_STEP_STATUS_LABEL,
  SETTLEMENT_STEP_STATUS_PALETTE,
  auditFailureKindLabel,
  canEditLiquidity,
  canResolve,
  canVoid,
  compactJson,
  deltaLabel,
  deltaMoveKey,
  formatBp,
  formatContracts,
  formatNoPrice,
  formatPricePerContract,
  formatQuantity,
  formatYesPrice,
  isAwaitingResolution,
  isAwaitingSettlement,
  isClosingSoon,
  isEditable,
  marketIdParam,
  marketEventRows,
  marketFormError,
  settlementStepViews,
  transitionErrorMessage,
} from './market-admin';

const apiError = (status: number, code: string, message = 'x', details?: unknown) =>
  new ApiError(status, {
    code,
    message,
    ...(details === undefined ? {} : { details }),
  } as never);

describe('status and event labels', () => {
  it('names every market status and event type in Korean', () => {
    for (const status of MARKET_STATUSES) {
      expect(MARKET_STATUS_LABEL[status], status).toMatch(/[가-힣]/);
    }
    for (const type of MARKET_EVENT_TYPES) {
      expect(MARKET_EVENT_LABEL[type], type).toMatch(/[가-힣]/);
    }
  });

  it('names the statuses after the plan: 거래 마감, 판정 완료, 정산 완료 (O-5, ADR-0046)', () => {
    expect(MARKET_STATUS_LABEL).toEqual({
      draft: copy.marketStatusDraft,
      open: copy.marketStatusOpen,
      closed: '거래 마감',
      resolved: '판정 완료',
      settled: '정산 완료',
      voided: copy.marketStatusVoided,
    });
    // The home status filter walks PUBLIC_MARKET_STATUSES through these labels (D4: 판정 완료 is
    // a filter of its own, 1:1).
    expect(PUBLIC_MARKET_STATUSES.map((status) => MARKET_STATUS_LABEL[status])).toEqual([
      copy.marketStatusOpen,
      '거래 마감',
      '판정 완료',
      '정산 완료',
      copy.marketStatusVoided,
    ]);
    // The judgement is its own event; M5's two legacy events keep their labels for old logs.
    expect(MARKET_EVENT_LABEL.resolved).toBe(copy.eventResolved);
    expect(copy.eventResolved).toBe('판정');
    expect(MARKET_EVENT_LABEL.finalized).toBe('정산 완료');
    expect(MARKET_EVENT_LABEL.resolve_proposed).toBe(copy.eventResolveProposed);
    expect(MARKET_EVENT_LABEL.result_changed).toBe(copy.eventResultChanged);
  });

  it('colours a status brand while live, orange while it waits, gray when over, `no` for voided', () => {
    expect(MARKET_STATUS_PALETTE).toEqual({
      draft: 'gray',
      open: 'brand',
      closed: 'orange',
      resolved: 'orange',
      settled: 'gray',
      voided: 'no',
    });
  });

  it('names every settlement step and step status in Korean, never by colour alone', () => {
    for (const step of SETTLEMENT_STEPS) {
      expect(SETTLEMENT_STEP_LABEL[step], step).toMatch(/[가-힣]/);
    }
    for (const status of SETTLEMENT_STEP_STATUSES) {
      expect(SETTLEMENT_STEP_STATUS_LABEL[status], status).toMatch(/[가-힣]/);
    }
    expect(SETTLEMENT_STEP_LABEL).toEqual({ coin: '포지션 정산' });
    expect(SETTLEMENT_STEP_STATUS_LABEL).toEqual({ pending: '대기', done: '완료', failed: '실패' });
    // Orange while it waits for the worker, gray once done, `no` once an attempt rolled back —
    // `no` is one of the palettes theme/contrast.test.ts measures on a solid fill.
    expect(SETTLEMENT_STEP_STATUS_PALETTE).toEqual({
      pending: 'orange',
      done: 'gray',
      failed: 'no',
    });
  });

  it('names every audit failure kind in Korean and shows an unknown kind verbatim', () => {
    for (const kind of AUDIT_FAILURE_KINDS) {
      expect(AUDIT_FAILURE_KIND_LABEL[kind], kind).toMatch(/[가-힣]/);
      expect(auditFailureKindLabel(kind)).toBe(AUDIT_FAILURE_KIND_LABEL[kind]);
    }
    // The API types `kind` as a string: a kind the worker learns first is not hidden.
    expect(auditFailureKindLabel('future_kind')).toBe('future_kind');
  });
});

describe('isClosingSoon', () => {
  const now = Date.parse('2026-09-06T00:00:00.000Z');
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();

  it('flags an open market closing within 24 hours', () => {
    expect(isClosingSoon({ status: 'open', closeAt: at(60_000) }, now)).toBe(true);
    expect(isClosingSoon({ status: 'open', closeAt: at(CLOSING_SOON_MS) }, now)).toBe(true);
  });

  it('ignores a market closing later, already past its close time, or not open', () => {
    expect(isClosingSoon({ status: 'open', closeAt: at(CLOSING_SOON_MS + 1) }, now)).toBe(false);
    // Past close time: the close job owns it; 판정 대기 takes over once it is closed.
    expect(isClosingSoon({ status: 'open', closeAt: at(-1) }, now)).toBe(false);
    expect(isClosingSoon({ status: 'closed', closeAt: at(60_000) }, now)).toBe(false);
    expect(isClosingSoon({ status: 'draft', closeAt: at(60_000) }, now)).toBe(false);
    expect(isClosingSoon({ status: 'open', closeAt: 'not-a-date' }, now)).toBe(false);
  });
});

describe('status predicates', () => {
  it('badges a closed market 판정 대기 and a resolved one 정산 대기, nothing else', () => {
    // Two different waits (ADR-0046): closed waits for the admin's 판정, resolved for the
    // worker's settlement — a resolved row that keeps its badge is a failing step.
    expect(MARKET_STATUSES.filter(isAwaitingResolution)).toEqual(['closed']);
    expect(MARKET_STATUSES.filter(isAwaitingSettlement)).toEqual(['resolved']);
    expect(copy.adminMarketAwaitingResolution).toBe('판정 대기');
    expect(copy.adminMarketAwaitingSettlement).toBe('정산 대기');
  });

  it('allows edits while draft or open, liquidity while draft, void before the 판정 only', () => {
    expect(MARKET_STATUSES.filter(isEditable)).toEqual(['draft', 'open']);
    expect(MARKET_STATUSES.filter(canEditLiquidity)).toEqual(['draft']);
    // A judged market cannot be voided (ADR-0046, #26 decides): the API refuses naming `status`,
    // so the button is not offered.
    expect(MARKET_STATUSES.filter(canVoid)).toEqual(['open', 'closed']);
  });

  it('judges a closed market only', () => {
    expect(MARKET_STATUSES.filter(canResolve)).toEqual(['closed']);
  });
});

describe('settlementStepViews', () => {
  const at = '2026-10-01T00:05:00.000Z';

  it('reads every step in words, in the order the API answered', () => {
    expect(
      settlementStepViews([
        { step: 'coin', status: 'pending', attempts: 0, completedAt: null, lastError: null },
      ]),
    ).toEqual([
      {
        step: 'coin',
        label: '포지션 정산',
        statusLabel: '대기',
        palette: 'orange',
        failed: false,
        attempts: '0',
        completedAt: '—',
        lastError: '—',
      },
    ]);
  });

  it('marks a failed step and carries the message of its last attempt', () => {
    const [failed] = settlementStepViews([
      {
        step: 'coin',
        status: 'failed',
        attempts: 2,
        completedAt: null,
        lastError: 'Balance not found for account u-1',
      },
    ]);
    expect(failed).toMatchObject({
      statusLabel: '실패',
      palette: 'no',
      failed: true,
      attempts: '2',
      completedAt: '—',
      lastError: 'Balance not found for account u-1',
    });
  });

  it('shows the completion instant in KST, and keeps an error a later success left behind', () => {
    // The worker keeps `last_error` when a retry succeeds (ADR-0046 D6): it is the record of
    // why the earlier attempt failed, and the 완료 badge beside it says the failure is over.
    const [done] = settlementStepViews([
      { step: 'coin', status: 'done', attempts: 3, completedAt: at, lastError: 'timeout' },
    ]);
    expect(done).toMatchObject({
      statusLabel: '완료',
      palette: 'gray',
      failed: false,
      attempts: '3',
      completedAt: formatKst(at),
      lastError: 'timeout',
    });
    expect(done?.completedAt).not.toBe('—');
  });

  it('answers no rows for a market that has not been judged', () => {
    // The API sends an empty list before the 판정 and for a voided market; the panel hides then.
    expect(settlementStepViews([])).toEqual([]);
  });
});

describe('formats', () => {
  it('pairs the price with its label (PLAN 11.2: never colour alone)', () => {
    expect(formatYesPrice(63)).toBe(`${copy.yes} 63%`);
  });

  it('renders basis points and quantities for reading', () => {
    expect(formatBp(6300)).toBe('63.00%');
    expect(formatBp(5)).toBe('0.05%');
    expect(formatQuantity('1234.5678901234')).toBe('1,234.5679');
    expect(formatQuantity('0.0000000000')).toBe('0');
    expect(formatQuantity('abc')).toBe('abc');
  });

  it('reads the 아니오 side as the complement of the same price', () => {
    // The two labels on one card must add up to 100, so both come from lastPrice.
    expect(formatNoPrice(63)).toBe(`${copy.no} 37%`);
    expect(formatNoPrice(1)).toBe(`${copy.no} 99%`);
  });

  it('reads basis points as what one contract costs', () => {
    expect(formatPricePerContract(6300)).toBe('63.00P');
    expect(formatPricePerContract(5)).toBe('0.05P');
  });

  it('appends the contract unit to a grouped count', () => {
    expect(formatContracts(1234)).toBe(`1,234${copy.tradeUnitContracts}`);
    // A quote answers fractional shares; formatQuantity trims them the same way it trims the
    // quantity strings the API sends.
    expect(formatContracts(0.5)).toBe(`0.5${copy.tradeUnitContracts}`);
  });

  it('renders a payload as one JSON line', () => {
    expect(compactJson({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
    expect(compactJson(null)).toBe('');
    expect(compactJson(undefined)).toBe('');
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(compactJson(cyclic)).toBe(copy.payloadUnreadable);
  });
});

describe('deltaLabel', () => {
  it('signs a rise and says nothing when there is nothing to report', () => {
    expect(deltaLabel(2)).toBe('+2%p');
    expect(deltaLabel(2.34)).toBe('+2.3%p');
    expect(deltaLabel(0)).toBe('');
    expect(deltaLabel(null)).toBe('');
    // Under a tenth of a point the badge stays away entirely rather than showing "+0%p":
    // 실시간은 조용하게 (PLAN 11.1-5).
    expect(deltaLabel(0.04)).toBe('');
    expect(deltaLabel(Number.NaN)).toBe('');
  });

  it('falls with U+2212, never an ASCII hyphen', () => {
    // A hyphen is narrower than the plus and reads as a stray dash beside the number.
    expect(deltaLabel(-2)).toBe(`${MINUS_SIGN}2%p`);
    expect(deltaLabel(-2)).not.toContain('-');
    expect(deltaLabel(-1.24)).toBe(`${MINUS_SIGN}1.2%p`);
  });
});

describe('marketEventRows', () => {
  const openAt = '2026-09-06T00:00:00.000Z';
  const closeAt = '2026-10-01T00:00:00.000Z';

  it('reads the void summary as reason, refunded accounts and refunded total', () => {
    expect(
      marketEventRows('voided', { reason: '중복 시장', refundedAccounts: 3, refundedP: '12500' }),
    ).toEqual([
      { label: copy.eventVoidReason, value: '중복 시장' },
      { label: copy.eventRefundedAccounts, value: '3' },
      { label: copy.eventRefundedTotal, value: '12,500P' },
    ]);
    expect(
      marketEventRows('voided', { reason: '', refundedAccounts: 0, refundedP: '0' })?.map(
        (row) => row.value,
      ),
    ).toEqual(['', '0', '0P']);
  });

  it('reads the rules diff as before and after, with a blank as a dash', () => {
    expect(marketEventRows('rules_edited', { before: '', after: '한국은행 발표 기준' })).toEqual([
      { label: copy.eventRulesBefore, value: '—' },
      { label: copy.eventRulesAfter, value: '한국은행 발표 기준' },
    ]);
  });

  it('renders the open and close instants in KST', () => {
    expect(marketEventRows('opened', { openAt, closeAt })).toEqual([
      { label: copy.marketOpenAt, value: formatKst(openAt) },
      { label: copy.adminMarketCloseAtShort, value: formatKst(closeAt) },
    ]);
    expect(marketEventRows('closed', { closedAt: closeAt })).toEqual([
      { label: copy.adminMarketCloseAtShort, value: formatKst(closeAt) },
    ]);
  });

  it('adds the discarded proposal to an old void, and nothing to one from closed', () => {
    // A-M3-23: voiding a market inside M5's dispute window cleared its result, and the event
    // kept what was thrown away. Only old rows carry it (a judged market can no longer be
    // voided, ADR-0046); a void from `closed` never had one, and the API omits the pair.
    expect(
      marketEventRows('voided', {
        reason: '출처 오류',
        refundedAccounts: 2,
        refundedP: '300',
        discardedResult: 'NO',
        discardedDisputeUntil: closeAt,
      }),
    ).toEqual([
      { label: copy.eventVoidReason, value: '출처 오류' },
      { label: copy.eventRefundedAccounts, value: '2' },
      { label: copy.eventRefundedTotal, value: '300P' },
      { label: copy.eventDiscardedResult, value: copy.no },
    ]);
    expect(
      marketEventRows('voided', {
        reason: 'x',
        refundedAccounts: 0,
        refundedP: '0',
        discardedResult: null,
        discardedDisputeUntil: null,
      })?.map((row) => row.label),
    ).toEqual([copy.eventVoidReason, copy.eventRefundedAccounts, copy.eventRefundedTotal]);
  });

  it('reads the 판정 as its result, note and evidence; blanks are left out', () => {
    // ADR-0046's `resolved` event: `{result, note, evidenceUrl}`. The API nulls a blank note /
    // evidence (market-admin.service.ts `detail`): a row saying "메모 null" would be worse than
    // no row.
    expect(
      marketEventRows('resolved', {
        result: 'YES',
        note: '공식 발표 확인',
        evidenceUrl: 'https://example.com/a',
      }),
    ).toEqual([
      { label: copy.marketResolvedResult, value: copy.yes },
      { label: copy.adminMarketResolveNote, value: '공식 발표 확인' },
      { label: copy.adminMarketResolveEvidence, value: 'https://example.com/a' },
    ]);
    expect(marketEventRows('resolved', { result: 'NO', note: null, evidenceUrl: null })).toEqual([
      { label: copy.marketResolvedResult, value: copy.no },
    ]);
    // Omitted rather than nulled reads the same.
    expect(marketEventRows('resolved', { result: 'NO' })).toEqual([
      { label: copy.marketResolvedResult, value: copy.no },
    ]);
  });

  it('reads an old proposed result without the dispute window it carried', () => {
    // M5's legacy `resolve_proposed` stays in old logs (market_events is append-only). Its
    // `disputeUntil` still parses — optional — but is never shown: the window describes a
    // stage the product no longer has.
    const rows = [
      { label: copy.marketResolvedResult, value: copy.yes },
      { label: copy.adminMarketResolveNote, value: '공식 발표 확인' },
      { label: copy.adminMarketResolveEvidence, value: 'https://example.com/a' },
    ];
    expect(
      marketEventRows('resolve_proposed', {
        result: 'YES',
        note: '공식 발표 확인',
        evidenceUrl: 'https://example.com/a',
        disputeUntil: closeAt,
      }),
    ).toEqual(rows);
    expect(
      marketEventRows('resolve_proposed', {
        result: 'YES',
        note: '공식 발표 확인',
        evidenceUrl: 'https://example.com/a',
      }),
    ).toEqual(rows);
    expect(
      marketEventRows('resolve_proposed', {
        result: 'NO',
        note: null,
        evidenceUrl: null,
        disputeUntil: closeAt,
      }),
    ).toEqual([{ label: copy.marketResolvedResult, value: copy.no }]);
  });

  it('reads an old changed result as before / after, without the restarted window', () => {
    expect(
      marketEventRows('result_changed', {
        before: 'YES',
        after: 'NO',
        note: '출처 재확인',
        evidenceUrl: null,
        disputeUntil: closeAt,
      }),
    ).toEqual([
      { label: copy.eventRulesBefore, value: copy.yes },
      { label: copy.eventRulesAfter, value: copy.no },
      { label: copy.adminMarketResolveNote, value: '출처 재확인' },
    ]);
  });

  it('reads the finalize summary the worker writes, with the counts optional', () => {
    // apps/worker/src/jobs/market-finalize.ts also writes `positions`, which is not shown.
    expect(
      marketEventRows('finalized', {
        result: 'YES',
        settledAccounts: 3,
        paidAccounts: 2,
        paidP: '20000',
        positions: 4,
      }),
    ).toEqual([
      { label: copy.marketResolvedResult, value: copy.yes },
      { label: copy.eventSettledAccounts, value: '3' },
      { label: copy.eventPaidAccounts, value: '2' },
      { label: copy.eventPaidTotal, value: '20,000P' },
    ]);
    expect(marketEventRows('finalized', { result: 'NO' })).toEqual([
      { label: copy.marketResolvedResult, value: copy.no },
    ]);
  });

  it('leaves the create body and every unknown type to compactJson', () => {
    expect(marketEventRows('created', { title: 'x', closeAt })).toBeUndefined();
    // A 판정 without its result or off the enum, a change without its before, an old window
    // that is not an instant, a result off the enum.
    expect(marketEventRows('resolved', { note: 'x' })).toBeUndefined();
    expect(marketEventRows('resolved', { result: 'MAYBE' })).toBeUndefined();
    expect(marketEventRows('resolved', null)).toBeUndefined();
    expect(
      marketEventRows('resolve_proposed', { result: 'YES', disputeUntil: 'not-a-date' }),
    ).toBeUndefined();
    expect(
      marketEventRows('result_changed', { after: 'NO', disputeUntil: closeAt }),
    ).toBeUndefined();
    expect(marketEventRows('finalized', { result: 'MAYBE' })).toBeUndefined();
    expect(marketEventRows('finalized', { result: 'YES', paidP: 'abc' })).toBeUndefined();
    expect(marketEventRows('finalized', null)).toBeUndefined();
  });

  it('falls back when a known type carries an unexpected shape', () => {
    // A half-read row ("사유 undefined", "환불 합계 NaN") is worse than the raw JSON.
    expect(marketEventRows('voided', { reason: 'x' })).toBeUndefined();
    expect(
      marketEventRows('voided', { reason: 'x', refundedAccounts: 1, refundedP: 'abc' }),
    ).toBeUndefined();
    expect(
      marketEventRows('voided', { reason: 'x', refundedAccounts: 1.5, refundedP: '1' }),
    ).toBeUndefined();
    expect(marketEventRows('rules_edited', { before: 'a' })).toBeUndefined();
    expect(marketEventRows('rules_edited', 'a → b')).toBeUndefined();
    expect(marketEventRows('opened', { openAt, closeAt: 'not-a-date' })).toBeUndefined();
    expect(marketEventRows('closed', { closedAt: 1 })).toBeUndefined();
    expect(marketEventRows('closed', null)).toBeUndefined();
    expect(marketEventRows('closed', undefined)).toBeUndefined();
  });
});

describe('marketFormError for RULES_REQUIRED', () => {
  it('puts the refusal of blank rules on an open market under the rules field', () => {
    const error = apiError(
      422,
      'RULES_REQUIRED',
      'Rules cannot be blank while the market is open',
      [{ path: ['rules'], message: 'required' }],
    );
    expect(marketFormError(error)).toEqual({ field: 'rules', message: copy.errMarketRulesOpen });
  });
});

describe('marketIdParam', () => {
  it('answers the canonical id, which is the one the API answers rows with', () => {
    const lower = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(marketIdParam(lower)).toBe(lower);
    // Either case is accepted, like the API — and both name ONE market. Keeping the segment
    // as typed instead is what left an upper-case URL reading a key its own rows do not name.
    expect(marketIdParam(lower.toUpperCase())).toBe(lower);
    // A malformed id is a 400 from the API, not a 404: the screen must not offer a retry.
    expect(marketIdParam('abc')).toBeUndefined();
    expect(marketIdParam('3f2504e0-4f89-11d3-9a0c')).toBeUndefined();
    expect(marketIdParam('')).toBeUndefined();
  });
});

describe('transitionErrorMessage', () => {
  it('names the specific refusals of open / close / void', () => {
    expect(transitionErrorMessage(apiError(422, 'RULES_REQUIRED'))).toBe(
      copy.errMarketRulesRequired,
    );
    expect(transitionErrorMessage(apiError(409, 'MARKET_NOT_OPEN'))).toBe(copy.errMarketNotOpen);
    expect(
      transitionErrorMessage(
        apiError(400, 'VALIDATION_ERROR', 'x', [{ path: ['status'], message: 'market is draft' }]),
      ),
    ).toBe(copy.errMarketStatus);
    expect(
      transitionErrorMessage(
        apiError(400, 'VALIDATION_ERROR', 'x', [{ path: ['closeAt'], message: 'past' }]),
      ),
    ).toBe(copy.errMarketCloseAt);
    expect(
      transitionErrorMessage(
        apiError(400, 'VALIDATION_ERROR', 'x', [{ path: ['reason'], message: 'blank' }]),
      ),
    ).toBe(copy.errMarketVoidReason);
  });

  it('names the refusals of the 판정 and of a void after it as a stale screen', () => {
    // A market is judged once (ADR-0046): a second 판정, and a void of a judged market, are both
    // refused naming `status` — the screen showed a state another admin has already moved on.
    for (const message of ['market is resolved', 'market is settled']) {
      expect(
        transitionErrorMessage(
          apiError(400, 'VALIDATION_ERROR', 'x', [{ path: ['status'], message }]),
        ),
        message,
      ).toBe(copy.errMarketStatus);
    }
    // No "same result" refusal exists any more: a `result` issue is an ordinary invalid body.
    expect(
      transitionErrorMessage(
        apiError(400, 'VALIDATION_ERROR', 'x', [{ path: ['result'], message: 'bad' }]),
      ),
    ).toBe(copy.errMarketInvalid);
    const named = (path: string) =>
      transitionErrorMessage(
        apiError(400, 'VALIDATION_ERROR', 'x', [{ path: [path], message: 'bad' }]),
      );
    expect(named('note')).toBe(copy.errMarketResolveNote);
    expect(named('evidenceUrl')).toBe(copy.errMarketResolveEvidence);
  });

  it('names a market that no longer exists rather than asking for a retry', () => {
    expect(transitionErrorMessage(apiError(404, 'NOT_FOUND', 'Market not found'))).toBe(
      copy.adminMarketNotFound,
    );
  });

  it('falls back to the generic messages', () => {
    expect(transitionErrorMessage(apiError(400, 'VALIDATION_ERROR'))).toBe(copy.errMarketInvalid);
    expect(transitionErrorMessage(apiError(500, 'INTERNAL'))).toBe(copy.errUnknown);
    expect(transitionErrorMessage(new Error('network'))).toBe(copy.errUnknown);
  });
});

describe('marketFormError', () => {
  it('lands a taken slug on the slug field with the collision message', () => {
    expect(
      marketFormError(
        apiError(400, 'VALIDATION_ERROR', 'This slug is already taken', [
          { path: ['slug'], message: 'already exists' },
        ]),
      ),
    ).toEqual({ field: 'slug', message: copy.errMarketSlugTaken });
  });

  it('lands a malformed slug on the slug field with the format message', () => {
    expect(
      marketFormError(
        apiError(400, 'VALIDATION_ERROR', 'Validation failed', [
          { path: ['slug'], message: 'slug must not look like a uuid' },
        ]),
      ),
    ).toEqual({ field: 'slug', message: copy.errMarketSlug });
  });

  it('lands an unknown or retired category on the category field', () => {
    expect(
      marketFormError(
        apiError(404, 'NOT_FOUND', 'Category not found', [
          { path: ['categoryId'], message: 'not found' },
        ]),
      ),
    ).toEqual({ field: 'categoryId', message: copy.errMarketCategoryUnavailable });
    expect(
      marketFormError(
        apiError(400, 'VALIDATION_ERROR', 'This category is disabled', [
          { path: ['categoryId'], message: 'inactive' },
        ]),
      ),
    ).toEqual({ field: 'categoryId', message: copy.errMarketCategoryUnavailable });
  });

  it('maps the remaining API field names onto the form', () => {
    const named = (path: string) =>
      marketFormError(apiError(400, 'VALIDATION_ERROR', 'x', [{ path: [path], message: 'bad' }]));
    expect(named('closeAt')).toEqual({ field: 'closeAt', message: copy.errMarketCloseAt });
    expect(named('initialProbBp')?.field).toBe('probabilityPct');
    expect(named('liquidityB')).toEqual({ field: 'liquidityB', message: copy.errMarketLiquidity });
    expect(named('title')).toEqual({ field: 'title', message: copy.errMarketTitle });
    expect(named('rules')).toEqual({ field: 'rules', message: copy.errMarketText });
    expect(named('imageUrl')).toEqual({ field: 'imageUrl', message: copy.errMarketImageUrl });
    expect(named('resolutionSource')).toEqual({
      field: 'resolutionSource',
      message: copy.errMarketSource,
    });
  });

  it('is undefined for anything the form has no field for', () => {
    // `status` is a VALIDATION_ERROR too, but not a field on the form: the generic toast.
    expect(
      marketFormError(
        apiError(400, 'VALIDATION_ERROR', 'x', [{ path: ['status'], message: 'market is open' }]),
      ),
    ).toBeUndefined();
    expect(marketFormError(apiError(400, 'VALIDATION_ERROR'))).toBeUndefined();
    expect(marketFormError(apiError(404, 'NOT_FOUND'))).toBeUndefined();
    expect(marketFormError(apiError(409, 'MARKET_NOT_OPEN'))).toBeUndefined();
    expect(marketFormError(new Error('network'))).toBeUndefined();
    expect(marketFormError(undefined)).toBeUndefined();
  });
});

describe('deltaMoveKey', () => {
  it('gives consecutive small moves distinct identities, where the whole percent did not', () => {
    // THE HAZARD: `lastPrice` is the whole percent, so three +0.1%p trades inside one percent all
    // produced `50:+0.1%p`. The badge remembers the last DISMISSED identity, so the second and
    // third moves matched it and the badge — five seconds, PLAN 11.4 — never came back.
    const label = deltaLabel(0.1);
    expect(deltaMoveKey(5010, 50, label)).not.toBe(deltaMoveKey(5020, 50, label));
    expect(deltaMoveKey(5020, 50, label)).not.toBe(deltaMoveKey(5030, 50, label));
    // The old identity, kept here to show what it collapsed: all three were one string.
    expect(`${String(50)}:${label}`).toBe(`${String(50)}:${label}`);
  });

  it('is the whole percent only for a caller that has no basis points', () => {
    // A card omits `pYesBp` (PLAN 11.1-1 wants the percentage alone); today the badge has one
    // call site and it passes both, so this is the contract, not a live path.
    expect(deltaMoveKey(undefined, 63, '+2%p')).toBe('63:+2%p');
    expect(deltaMoveKey(6300, 63, '+2%p')).toBe('6300:+2%p');
  });

  it('cannot collide for two consecutive moves, because a move that ends where it began is hidden', () => {
    // The property the fix rests on: sharing an identity requires the same ending probability,
    // and a move from 5010 to 5010 has a zero delta, which `deltaLabel` renders as '' — no badge.
    expect(deltaLabel(0)).toBe('');
    expect(deltaMoveKey(5010, 50, deltaLabel(0))).toBe('5010:');
  });
});
