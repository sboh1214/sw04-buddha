import {
  AUDIT_FAILURE_KINDS,
  CATEGORY_UNSELECTABLE_REASONS,
  MARKET_EVENT_TYPES,
  MARKET_RESULTS,
  MARKET_STATUSES,
  MINUS_SIGN,
  OPEN_ITEMS,
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
  MARKET_RESULT_LABEL,
  MARKET_STATUS_LABEL,
  MARKET_STATUS_PALETTE,
  OPEN_ITEM_LABEL,
  SETTLEMENT_STEP_LABEL,
  SETTLEMENT_STEP_STATUS_LABEL,
  SETTLEMENT_STEP_STATUS_PALETTE,
  auditFailureKindLabel,
  canResolve,
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
  openItemsNotice,
  SETTLEMENT_POLL_INTERVAL_MS,
  settlementPollInterval,
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
  it('names every market status, result and event type in Korean, and nothing else', () => {
    for (const status of MARKET_STATUSES) {
      expect(MARKET_STATUS_LABEL[status], status).toMatch(/[가-힣]/);
      expect(MARKET_STATUS_PALETTE[status], status).toBeDefined();
    }
    for (const type of MARKET_EVENT_TYPES) {
      expect(MARKET_EVENT_LABEL[type], type).toMatch(/[가-힣]/);
    }
    // Complete and no more: a status, a result or an event type the enum dropped (voided,
    // resolve_proposed, result_changed) leaves no key behind.
    expect(Object.keys(MARKET_STATUS_LABEL).sort()).toEqual([...MARKET_STATUSES].sort());
    expect(Object.keys(MARKET_STATUS_PALETTE).sort()).toEqual([...MARKET_STATUSES].sort());
    expect(Object.keys(MARKET_EVENT_LABEL).sort()).toEqual([...MARKET_EVENT_TYPES].sort());
    expect(Object.keys(MARKET_RESULT_LABEL).sort()).toEqual([...MARKET_RESULTS].sort());
    // One label per status: no two badges read alike.
    expect(new Set(Object.values(MARKET_STATUS_LABEL)).size).toBe(MARKET_STATUSES.length);
  });

  it('names the statuses as ADR-0093 decision 1, item 12 words them (#174)', () => {
    expect(MARKET_STATUS_LABEL).toEqual({
      draft: '초안',
      review: '검수 중',
      scheduled: '개장 예정',
      open: '거래 중',
      paused: '거래 일시 중단',
      closed: '거래 마감',
      provisional: '잠정 결과',
      resolved: '결과 확정',
      settling: '지급 중',
      settled: '지급 완료',
      cancelled: '취소',
    });
    // Every public status has a label of its own, 1:1: the statuses the API's `status` filter
    // takes, as the status badges name them, in lifecycle order — the search screen's choices
    // (#15). The home has no status filter (ADR-0065).
    expect(PUBLIC_MARKET_STATUSES.map((status) => MARKET_STATUS_LABEL[status])).toEqual([
      '개장 예정',
      '거래 중',
      '거래 일시 중단',
      '거래 마감',
      '잠정 결과',
      '결과 확정',
      '지급 중',
      '지급 완료',
      '취소',
    ]);
    // The judgement is its own event; the worker's start and end of the payout follow the labels
    // of the statuses they lead to.
    expect(MARKET_EVENT_LABEL.resolved).toBe(copy.eventResolved);
    expect(copy.eventResolved).toBe('판정');
    expect(MARKET_EVENT_LABEL.settling).toBe('지급 시작');
    expect(MARKET_EVENT_LABEL.finalized).toBe(MARKET_STATUS_LABEL.settled);
  });

  it('names a result YES·NO as the contracts and VOID 무효 — never NO (#174)', () => {
    expect(MARKET_RESULT_LABEL).toEqual({ YES: copy.yes, NO: copy.no, VOID: '무효' });
    expect(MARKET_RESULT_LABEL.VOID).not.toBe(copy.no);
  });

  it('colours a status brand while it trades, orange while it waits, gray when nothing is coming', () => {
    expect(MARKET_STATUS_PALETTE).toEqual({
      draft: 'gray',
      review: 'gray',
      scheduled: 'orange',
      open: 'brand',
      paused: 'orange',
      closed: 'orange',
      provisional: 'orange',
      resolved: 'orange',
      settling: 'orange',
      settled: 'gray',
      cancelled: 'gray',
    });
    // `no` is a refusal's or a failure's: no status is one (VOID is a result, cancelled is over).
    expect(Object.values(MARKET_STATUS_PALETTE)).not.toContain('no');
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

  it('flags a paused one too: it still closes on schedule (ADR-0093 decision 1, item 3)', () => {
    expect(isClosingSoon({ status: 'paused', closeAt: at(60_000) }, now)).toBe(true);
    expect(isClosingSoon({ status: 'paused', closeAt: at(CLOSING_SOON_MS + 1) }, now)).toBe(false);
    expect(isClosingSoon({ status: 'paused', closeAt: at(-1) }, now)).toBe(false);
  });

  it('ignores a market closing later, already past its close time, or neither open nor paused', () => {
    expect(isClosingSoon({ status: 'open', closeAt: at(CLOSING_SOON_MS + 1) }, now)).toBe(false);
    // Past close time: the close job owns it; 판정 대기 takes over once it is closed.
    expect(isClosingSoon({ status: 'open', closeAt: at(-1) }, now)).toBe(false);
    expect(isClosingSoon({ status: 'open', closeAt: 'not-a-date' }, now)).toBe(false);
    // Every other status, a scheduled one included: it is not "closing" before it has opened.
    const closingSoon = MARKET_STATUSES.filter((status) =>
      isClosingSoon({ status, closeAt: at(60_000) }, now),
    );
    expect(closingSoon).toEqual(['open', 'paused']);
  });
});

describe('status predicates', () => {
  it('badges a closed market 판정 대기 and a resolved or settling one 정산 대기, nothing else', () => {
    // Two different waits (ADR-0046): closed waits for the admin's 판정, resolved and settling
    // for the worker's payout (ADR-0093 decision 1, item 1) — a settling row that keeps its badge
    // is a failing step (item 14).
    expect(MARKET_STATUSES.filter(isAwaitingResolution)).toEqual(['closed']);
    expect(MARKET_STATUSES.filter(isAwaitingSettlement)).toEqual(['resolved', 'settling']);
    expect(copy.adminMarketAwaitingResolution).toBe('판정 대기');
    expect(copy.adminMarketAwaitingSettlement).toBe('정산 대기');
  });

  it('re-reads the admin detail only while the market waits for its settlement', () => {
    // The panel has no realtime source: polling is how it sees the worker finish or fail a
    // step, and it must stop once the market is settled (or before anything was judged).
    for (const status of MARKET_STATUSES) {
      expect(settlementPollInterval({ status })).toBe(
        status === 'resolved' || status === 'settling' ? SETTLEMENT_POLL_INTERVAL_MS : false,
      );
    }
    expect(settlementPollInterval(undefined)).toBe(false);
  });

  it('allows edits while draft or open', () => {
    expect(MARKET_STATUSES.filter(isEditable)).toEqual(['draft', 'open']);
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
    // The API sends an empty list before the result is confirmed and for a cancelled market; the
    // panel hides then.
    expect(settlementStepViews([])).toEqual([]);
  });
});

describe('formats', () => {
  it('pairs the price with its label (PLAN 11.2: never colour alone)', () => {
    expect(formatYesPrice(63)).toBe(`${copy.yes} 63%`);
  });

  it('reads a market with no fill as 체결 없음, never as a number (N02 §5)', () => {
    expect(copy.noFills).toBe('체결 없음');
    expect(formatYesPrice(null)).toBe(copy.noFills);
  });

  it('renders basis points and quantities for reading', () => {
    expect(formatBp(6300)).toBe('63.00%');
    expect(formatBp(5)).toBe('0.05%');
    expect(formatQuantity('1234.5678901234')).toBe('1,234.5679');
    expect(formatQuantity('0.0000000000')).toBe('0');
    expect(formatQuantity('abc')).toBe('abc');
  });

  it('reads the NO side as the complement of the same price', () => {
    // The two labels on one card must add up to 100, so both come from lastPrice.
    expect(formatNoPrice(63)).toBe(`${copy.no} 37%`);
    expect(formatNoPrice(1)).toBe(`${copy.no} 99%`);
  });

  it('reads basis points as what one contract costs', () => {
    expect(formatPricePerContract(6300)).toBe('63.00 Coin');
    expect(formatPricePerContract(5)).toBe('0.05 Coin');
  });

  it('appends the contract unit to a grouped count', () => {
    expect(formatContracts(1234)).toBe(`1,234${copy.unitContracts}`);
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

  it('reads a VOID result as 무효, not as NO or raw JSON (the result type, #174)', () => {
    // The interim 판정 writes YES or NO alone until #152, which is where VOID is chosen; the
    // payload's result is the stored result type, so a row that carries VOID reads in words.
    expect(marketEventRows('resolved', { result: 'VOID', note: null })).toEqual([
      { label: copy.marketResolvedResult, value: copy.marketResultVoid },
    ]);
    expect(marketEventRows('finalized', { result: 'VOID' })).toEqual([
      { label: copy.marketResolvedResult, value: copy.marketResultVoid },
    ]);
  });

  it('reads the start of the payout as no row: its `source` is what 시스템 already says', () => {
    // The worker's resolved → settling writes `{source: 'job'}` (market-finalize.ts).
    expect(marketEventRows('settling', { source: 'job' })).toEqual([]);
    expect(marketEventRows('settling', { reason: 1 })).toBeUndefined();
  });

  it('reads the finalize summary the worker writes, with the counts optional', () => {
    // apps/worker/src/jobs/market-finalize.ts also writes `positions`, which is not shown.
    expect(
      marketEventRows('finalized', {
        result: 'YES',
        settledAccounts: 3,
        paidAccounts: 2,
        paidCoin: '20000',
        positions: 4,
      }),
    ).toEqual([
      { label: copy.marketResolvedResult, value: copy.yes },
      { label: copy.eventSettledAccounts, value: '3' },
      { label: copy.eventPaidAccounts, value: '2' },
      { label: copy.eventPaidTotal, value: '20,000 Coin' },
    ]);
    expect(marketEventRows('finalized', { result: 'NO' })).toEqual([
      { label: copy.marketResolvedResult, value: copy.no },
    ]);
  });

  it('leaves the create body and every unknown type to compactJson', () => {
    expect(marketEventRows('created', { title: 'x', closeAt })).toBeUndefined();
    // A 판정 without its result or off the enum, a summary with a result off the enum or a total
    // that is not an amount.
    expect(marketEventRows('resolved', { note: 'x' })).toBeUndefined();
    expect(marketEventRows('resolved', { result: 'MAYBE' })).toBeUndefined();
    expect(marketEventRows('resolved', null)).toBeUndefined();
    expect(marketEventRows('finalized', { result: 'MAYBE' })).toBeUndefined();
    expect(marketEventRows('finalized', { result: 'YES', paidCoin: 'abc' })).toBeUndefined();
    expect(marketEventRows('finalized', null)).toBeUndefined();
  });

  it('falls back when a known type carries an unexpected shape', () => {
    // A half-read row ("이전 undefined", "정산 지급 합계 NaN") is worse than the raw JSON.
    expect(marketEventRows('rules_edited', { before: 'a' })).toBeUndefined();
    expect(marketEventRows('rules_edited', 'a → b')).toBeUndefined();
    expect(marketEventRows('opened', { openAt, closeAt: 'not-a-date' })).toBeUndefined();
    expect(marketEventRows('closed', { closedAt: 1 })).toBeUndefined();
    expect(marketEventRows('closed', null)).toBeUndefined();
    expect(marketEventRows('closed', undefined)).toBeUndefined();
  });
});

describe('openItemsNotice', () => {
  it('names the open-items labels the brief gives, one per item (#17)', () => {
    expect(OPEN_ITEMS.map((item) => OPEN_ITEM_LABEL[item])).toEqual([
      '정산 규칙',
      '카테고리',
      '태그 1~5개',
    ]);
  });

  it("says what a draft still lacks, joined with ' · ' in OPEN_ITEMS order", () => {
    expect(
      openItemsNotice({ status: 'draft', missingOpenItems: ['rules', 'category', 'tags'] }),
    ).toBe('열기 전에 채울 항목: 정산 규칙 · 카테고리 · 태그 1~5개');
    expect(openItemsNotice({ status: 'draft', missingOpenItems: ['tags'] })).toBe(
      '열기 전에 채울 항목: 태그 1~5개',
    );
    expect(openItemsNotice({ status: 'draft', missingOpenItems: ['tags', 'rules'] })).toBe(
      `${copy.adminMarketOpenItems}: ${copy.openItemRules} · ${copy.openItemTags}`,
    );
  });

  it('is nothing once nothing is missing, and nothing on any status but draft', () => {
    expect(openItemsNotice({ status: 'draft', missingOpenItems: [] })).toBeUndefined();
    // An open market whose category was hidden later keeps it (#172 item 1): the check is what
    // leaving the draft takes, so there is no notice even though the API reports the item.
    for (const status of MARKET_STATUSES.filter((value) => value !== 'draft')) {
      expect(openItemsNotice({ status, missingOpenItems: ['category'] }), status).toBeUndefined();
    }
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
  it('says the session changed when the cookie is another account’s (ADR-0092)', () => {
    // Every market write names the admin on screen; nothing was done, and the screen's caller
    // asks for the session again.
    expect(
      transitionErrorMessage(
        apiError(403, 'FORBIDDEN', 'x', [
          { path: ['expectedAccountId'], message: 'session belongs to another account' },
        ]),
      ),
    ).toBe(copy.sessionChanged);
    // Not a field the form has: the toast, not a field error.
    expect(
      marketFormError(
        apiError(403, 'FORBIDDEN', 'x', [
          { path: ['expectedAccountId'], message: 'session belongs to another account' },
        ]),
      ),
    ).toBeUndefined();
    expect(transitionErrorMessage(apiError(403, 'FORBIDDEN'))).toBe(copy.errUnknown);
  });

  it('names the specific refusals of open / close / void', () => {
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
  });

  it('names the refusal of a second 판정 as a stale screen', () => {
    // A market is judged once (ADR-0046): a second 판정 is refused naming `status` — the screen
    // showed a state another admin has already moved on.
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

  it('names every item the open-items check found missing, in OPEN_ITEMS order (#17)', () => {
    // The API's details: one `{path: [item], message}` per missing item; for the category the
    // message is why (here 'subcategories'), which the toast does not repeat.
    const refused = (details?: unknown) =>
      transitionErrorMessage(
        apiError(422, 'OPEN_ITEMS_MISSING', 'The market misses what it needs to open', details),
      );
    expect(
      refused([
        { path: ['rules'], message: 'required' },
        { path: ['category'], message: 'subcategories' },
        { path: ['tags'], message: 'required' },
      ]),
    ).toBe('열기 전에 채울 항목이 있습니다: 정산 규칙 · 카테고리 · 태그 1~5개');
    expect(refused([{ path: ['tags'], message: 'required' }])).toBe(
      `${copy.errMarketOpenItemsMissing}: ${copy.openItemTags}`,
    );
    // The order is OPEN_ITEMS', whatever order the answer listed them in, each once.
    expect(
      refused([
        { path: ['tags'], message: 'required' },
        { path: ['rules'], message: 'required' },
        { path: ['tags'], message: 'required' },
      ]),
    ).toBe(`${copy.errMarketOpenItemsMissing}: ${copy.openItemRules} · ${copy.openItemTags}`);
    // No details, or none this screen knows: the line alone.
    expect(refused()).toBe('열기 전에 채울 항목이 있습니다.');
    expect(refused([{ path: ['times'], message: 'required' }])).toBe(
      `${copy.errMarketOpenItemsMissing}.`,
    );
    expect(refused('nope')).toBe(`${copy.errMarketOpenItemsMissing}.`);
    // Not a field refusal: the form leaves it to this toast.
    expect(
      marketFormError(
        apiError(422, 'OPEN_ITEMS_MISSING', 'x', [{ path: ['rules'], message: 'required' }]),
      ),
    ).toBeUndefined();
  });

  it('no longer reads RULES_REQUIRED as a refused open: only an open market PATCH answers it', () => {
    // Open answers OPEN_ITEMS_MISSING since #17; the PATCH's RULES_REQUIRED lands on the rules
    // field (`marketFormError`), so a stray one here is the generic toast.
    expect(transitionErrorMessage(apiError(422, 'RULES_REQUIRED'))).toBe(copy.errUnknown);
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

  it('lands an unknown category, or one a market may not be filed under, on the category field', () => {
    expect(
      marketFormError(
        apiError(404, 'NOT_FOUND', 'Category not found', [
          { path: ['categoryId'], message: 'not found' },
        ]),
      ),
    ).toEqual({ field: 'categoryId', message: copy.errMarketCategoryUnavailable });
    // #17: the issue's message is why (CATEGORY_UNSELECTABLE_REASONS), and the field says it.
    const refused = (message: string) =>
      marketFormError(apiError(400, 'VALIDATION_ERROR', 'x', [{ path: ['categoryId'], message }]));
    expect(refused('inactive')).toEqual({
      field: 'categoryId',
      message: copy.errMarketCategoryHidden,
    });
    expect(refused('parent_inactive')).toEqual({
      field: 'categoryId',
      message: copy.errMarketCategoryParentHidden,
    });
    expect(refused('subcategories')).toEqual({
      field: 'categoryId',
      message: copy.errMarketCategoryHasChildren,
    });
    expect(refused('something new')).toEqual({
      field: 'categoryId',
      message: copy.errMarketCategoryUnavailable,
    });
    for (const reason of CATEGORY_UNSELECTABLE_REASONS) {
      expect(refused(reason)?.message, reason).not.toBe(copy.errMarketCategoryUnavailable);
    }
  });

  it('lands every refusal of the tags on the tags field, said by which rule (#17)', () => {
    const refused = (path: (string | number)[], message: string) =>
      marketFormError(apiError(400, 'VALIDATION_ERROR', 'Validation failed', [{ path, message }]));
    // marketTagsSchema: a second name of one tag, naming its index.
    expect(refused(['tags', 1], 'duplicate tag')).toEqual({
      field: 'tags',
      message: copy.errMarketTagDuplicate,
    });
    // An open market edited down to none (#17 구현의 선택).
    expect(refused(['tags'], 'required while open')).toEqual({
      field: 'tags',
      message: copy.errMarketTagsOpen,
    });
    // The list itself over MARKET_TAGS_MAX.
    expect(refused(['tags'], 'Too big: expected array to have <=5 items')).toEqual({
      field: 'tags',
      message: copy.errMarketTagsMax,
    });
    // One name: too long, or outside the pattern.
    expect(refused(['tags', 0], 'Too big: expected string to have <=20 characters')).toEqual({
      field: 'tags',
      message: copy.errMarketTagLength,
    });
    expect(refused(['tags', 2], 'only Korean, letters, digits, spaces and -_.&+·')).toEqual({
      field: 'tags',
      message: copy.errMarketTagFormat,
    });
  });

  it('maps the remaining API field names onto the form', () => {
    const named = (path: string) =>
      marketFormError(apiError(400, 'VALIDATION_ERROR', 'x', [{ path: [path], message: 'bad' }]));
    expect(named('closeAt')).toEqual({ field: 'closeAt', message: copy.errMarketCloseAt });
    // The direct-AMM fields went with the form inputs (#125): a stale API naming one has no field
    // to land on, so it falls to the generic toast.
    expect(named('initialProbBp')).toBeUndefined();
    expect(named('liquidityB')).toBeUndefined();
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
  it('is the whole percent and the label, the fallback a caller without a moveId gets', () => {
    expect(deltaMoveKey(63, '+2%p')).toBe('63:+2%p');
    // 체결 없음 has no price to key on, and no move to badge either.
    expect(deltaMoveKey(null, '')).toBe(':');
  });

  it('collapses two small moves inside one percent, which is why the call site passes a moveId', () => {
    // `lastPrice` is the whole percent, so two +0.1%p moves inside it share one identity — the
    // badge, dismissed after the first, would stay dark for the second (`recentMove`, ticks.ts).
    const label = deltaLabel(0.1);
    expect(deltaMoveKey(50, label)).toBe(deltaMoveKey(50, label));
  });
});
