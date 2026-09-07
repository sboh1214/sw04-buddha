import { AUDIT_FAILURE_KINDS, MARKET_EVENT_TYPES, MARKET_STATUSES } from '@buddha/shared';
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
  auditFailureKindLabel,
  canEditLiquidity,
  canVoid,
  compactJson,
  formatBp,
  formatQuantity,
  formatYesPrice,
  isAwaitingSettlement,
  isClosingSoon,
  isEditable,
  marketIdParam,
  marketEventRows,
  marketFormError,
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

  it('colours a status brand while live, gray when it is over, `no` for voided', () => {
    expect(MARKET_STATUS_PALETTE).toEqual({
      draft: 'gray',
      open: 'brand',
      closed: 'orange',
      resolving: 'orange',
      settled: 'gray',
      voided: 'no',
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
    // Past close time: the close job owns it; 정산 대기 takes over once it is closed.
    expect(isClosingSoon({ status: 'open', closeAt: at(-1) }, now)).toBe(false);
    expect(isClosingSoon({ status: 'closed', closeAt: at(60_000) }, now)).toBe(false);
    expect(isClosingSoon({ status: 'draft', closeAt: at(60_000) }, now)).toBe(false);
    expect(isClosingSoon({ status: 'open', closeAt: 'not-a-date' }, now)).toBe(false);
  });
});

describe('status predicates', () => {
  it('awaits settlement while closed or resolving only', () => {
    expect(MARKET_STATUSES.filter(isAwaitingSettlement)).toEqual(['closed', 'resolving']);
  });

  it('allows edits while draft or open, liquidity while draft, void per PLAN 5.2', () => {
    expect(MARKET_STATUSES.filter(isEditable)).toEqual(['draft', 'open']);
    expect(MARKET_STATUSES.filter(canEditLiquidity)).toEqual(['draft']);
    expect(MARKET_STATUSES.filter(canVoid)).toEqual(['open', 'closed', 'resolving']);
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

  it('renders a payload as one JSON line', () => {
    expect(compactJson({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
    expect(compactJson(null)).toBe('');
    expect(compactJson(undefined)).toBe('');
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(compactJson(cyclic)).toBe(copy.payloadUnreadable);
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

  it('leaves the create body and every unknown type to compactJson', () => {
    expect(marketEventRows('created', { title: 'x', closeAt })).toBeUndefined();
    expect(marketEventRows('resolve_proposed', { result: 'YES' })).toBeUndefined();
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
