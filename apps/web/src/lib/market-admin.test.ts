import { readFileSync } from 'node:fs';
import {
  AUDIT_FAILURE_KINDS,
  CATEGORY_UNSELECTABLE_REASONS,
  MARKET_CANCEL_SOURCES,
  MARKET_EVENT_TYPES,
  MARKET_NO_FILL_CANCEL_REASON,
  MARKET_PAUSE_REASONS,
  MARKET_PAUSE_REVIEW_RESULTS,
  MARKET_RESULTS,
  MARKET_STATUSES,
  type MarketStatus,
  MINUS_SIGN,
  OPEN_ITEMS,
  type OpenItem,
  PUBLIC_MARKET_STATUSES,
  RULE_VERSION_ITEMS,
  SETTLEMENT_STEPS,
  SETTLEMENT_STEP_STATUSES,
  SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED,
  SUPPLEMENT_ONLY_WHILE_OPEN,
  TIME_RULE_MESSAGES,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type MarketRuleContent } from './api';
import { formatKst } from './datetime';
import {
  AUDIT_FAILURE_KIND_LABEL,
  CLOSING_SOON_MS,
  MARKET_CANCEL_SOURCE_LABEL,
  MARKET_EVENT_LABEL,
  MARKET_RESULT_LABEL,
  MARKET_STATUS_LABEL,
  MARKET_STATUS_PALETTE,
  type MarketSourceInputs,
  OPEN_ITEM_LABEL,
  PAUSE_REASON_LABEL,
  PAUSE_REVIEW_RESULT_LABEL,
  RULE_VERSION_ITEM_LABEL,
  SETTLEMENT_STEP_LABEL,
  SETTLEMENT_STEP_STATUS_LABEL,
  SETTLEMENT_STEP_STATUS_PALETTE,
  auditFailureKindLabel,
  compactJson,
  deltaLabel,
  deltaMoveKey,
  editsAfterOpen,
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
  marketEventLabel,
  marketEventRows,
  marketFormError,
  openItemsNotice,
  priceProtectionText,
  ruleVersionItemList,
  ruleVersionItemText,
  MAX_TIMEOUT_MS,
  PROVISIONAL_DEADLINE_POLL_MS,
  SCHEDULED_OPEN_POLL_MS,
  SETTLEMENT_POLL_INTERVAL_MS,
  TRADING_CLOSE_POLL_MS,
  adminMarketPollInterval,
  judgementDelayEpisodeText,
  judgementDelayedNote,
  judgementVersionMove,
  judgementVersionName,
  provisionalMarketPollDelay,
  scheduledMarketPollDelay,
  settlementPollInterval,
  settlementStepViews,
  tradingMarketPollDelay,
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
    // Since #152 (ADR-0103) the approved judgement publishes 잠정 결과 and the worker confirms it at
    // the dispute deadline: each event is named, as the worker's start and end of the payout are,
    // by the status it leads to — the one-admin 판정 of old rows was a confirmation too.
    expect(MARKET_EVENT_LABEL.provisional).toBe('잠정 결과 공개');
    expect(MARKET_EVENT_LABEL.resolved).toBe(MARKET_STATUS_LABEL.resolved);
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
    // Two different waits (ADR-0046): closed waits for the admins' 판정 (registered and approved,
    // #152), resolved and settling for the worker's payout (ADR-0093 decision 1, item 1) — a
    // settling row that keeps its badge is a failing step (item 14). A provisional one waits for
    // its dispute deadline, which the detail's 판정 panel shows, not a badge.
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

  it('allows edits while draft, open or paused (an opened market’s category, tags and image)', () => {
    // #80 (ADR-0101) for an open market; a paused one alike since #114 (ADR-0102; ADR-0093
    // decision 2 #172 item 14: 'after the open' takes the pause in) — its version items off.
    expect(MARKET_STATUSES.filter(isEditable)).toEqual(['draft', 'open', 'paused']);
    expect(MARKET_STATUSES.filter(editsAfterOpen)).toEqual(['open', 'paused']);
  });

  it('offers no one-admin 판정 any more (#152, ADR-0103)', async () => {
    // The interim closed → resolved by one admin went with #152: a judgement is registered and
    // another admin approves it (the 판정 panel, lib/market-judgement.ts).
    expect(Object.keys(await import('./market-admin'))).not.toContain('canResolve');
    for (const key of ['adminMarketResolve', 'adminMarketResolveBody', 'adminMarketResolved']) {
      expect(Object.keys(copy), key).not.toContain(key);
    }
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

  it('reads a rules diff written before #23 as the one text before and after', () => {
    expect(marketEventRows('rules_edited', { before: '', after: '한국은행 발표 기준' })).toEqual([
      { label: copy.eventRulesBefore, value: '—' },
      { label: copy.eventRulesAfter, value: '한국은행 발표 기준' },
    ]);
  });

  it('reads a rules diff since #23 as the items changed, then each one before and after', () => {
    // rulesEditedPayload (@buddha/shared): the changed items in RULE_ITEMS order, and their values.
    expect(
      marketEventRows('rules_edited', {
        items: ['yesCondition', 'primarySource'],
        before: { yesCondition: '', primarySource: null },
        after: {
          yesCondition: '한국은행이 내리면 YES',
          primarySource: { name: '한국은행', url: 'https://www.bok.or.kr' },
        },
      }),
    ).toEqual([
      { label: copy.eventRulesItems, value: 'YES 조건 · 1차 출처' },
      { label: 'YES 조건 이전', value: '—' },
      { label: 'YES 조건 이후', value: '한국은행이 내리면 YES' },
      { label: '1차 출처 이전', value: '—' },
      { label: '1차 출처 이후', value: '한국은행 (https://www.bok.or.kr)' },
    ]);
  });

  it('words every rule item: KST, sources, numbered fallbacks or 없음, days', () => {
    const at = '2026-10-31T14:59:00.000Z';
    const rows = marketEventRows('rules_edited', {
      // Listed out of order: the rows keep RULE_ITEMS'.
      items: ['longDelayDays', 'description', 'fallbackSources', 'eventDeadline', 'delayHandling'],
      before: {
        description: null,
        eventDeadline: null,
        fallbackSources: [],
        longDelayDays: null,
        delayHandling: '무효',
      },
      after: {
        description: '배경',
        eventDeadline: at,
        fallbackSources: [
          { name: '연합뉴스', url: 'https://yna.co.kr' },
          { name: '', url: 'https://kosis.kr' },
          { name: '통계청', url: '' },
        ],
        longDelayDays: 14,
        delayHandling: '  ',
      },
    });
    expect(rows).toEqual([
      {
        label: copy.eventRulesItems,
        value: '배경 · 사건 기한 · 대체 출처 · 장기 지연 기한 · 지연·취소·무효 처리',
      },
      { label: '배경 이전', value: '—' },
      { label: '배경 이후', value: '배경' },
      { label: '사건 기한 이전', value: '—' },
      { label: '사건 기한 이후', value: formatKst(at) },
      { label: '대체 출처 이전', value: copy.adminMarketFallbackNone },
      {
        label: '대체 출처 이후',
        value: '1. 연합뉴스 (https://yna.co.kr)\n2. https://kosis.kr\n3. 통계청',
      },
      { label: '장기 지연 기한 이전', value: '—' },
      { label: '장기 지연 기한 이후', value: '예정 판정 시각에서 14일 뒤' },
      { label: '지연·취소·무효 처리 이전', value: '무효' },
      { label: '지연·취소·무효 처리 이후', value: '—' },
    ]);
  });

  it('words the two time items rules_edited counts since #22: the announcement and the zone', () => {
    const at = '2026-11-01T23:00:00.000Z';
    expect(
      marketEventRows('rules_edited', {
        // RULES_EDITED_ITEMS order: the rule items, then the announcement and the zone.
        items: ['judgementTimeZone', 'scheduledAnnouncementAt', 'yesCondition'],
        before: { yesCondition: 'YES', scheduledAnnouncementAt: null, judgementTimeZone: null },
        after: { yesCondition: 'YES!', scheduledAnnouncementAt: at, judgementTimeZone: 'ROK' },
      }),
    ).toEqual([
      { label: copy.eventRulesItems, value: 'YES 조건 · 발표 예정 시각 · 판정 기준 시간대' },
      { label: 'YES 조건 이전', value: 'YES' },
      { label: 'YES 조건 이후', value: 'YES!' },
      // None is 없음 (#172 item 13); the time in KST as every time in these rows.
      { label: '발표 예정 시각 이전', value: copy.adminMarketAnnouncementNone },
      { label: '발표 예정 시각 이후', value: formatKst(at) },
      // The zone by its name as stored, an alias included.
      { label: '판정 기준 시간대 이전', value: '—' },
      { label: '판정 기준 시간대 이후', value: 'ROK' },
    ]);
    // The scheduled open, the close and the judgement are market_update's, never listed here: a
    // row naming one is not read.
    expect(
      marketEventRows('rules_edited', {
        items: ['closeAt'],
        before: { closeAt: at },
        after: { closeAt: at },
      }),
    ).toBeUndefined();
  });

  it('reads an approved supplement as its version, the items and the reason (#80)', () => {
    // MarketRulesSupplementedPayload (@buddha/shared); the actor beside it is the approver. The
    // requester's account id is no row: the 보충 기록 names the requester by nickname.
    const payload = {
      version: 3,
      approvalId: 'a1b2c3d4-0000-4000-8000-000000000001',
      // Listed out of order: the row keeps RULE_VERSION_ITEMS'.
      items: ['closeAt', 'description', 'title'],
      reason: '배경의 오타를 고칩니다.',
      requestedBy: 'requester-id',
    };
    expect(marketEventRows('rules_supplemented', payload)).toEqual([
      { label: copy.eventRulesVersion, value: 'v3' },
      { label: copy.eventRulesItems, value: '질문 · 배경 · 거래 마감 시각' },
      { label: copy.reviewLogReason, value: '배경의 오타를 고칩니다.' },
    ]);
    // A row of another shape is not read: no item, an unknown item, no version.
    expect(marketEventRows('rules_supplemented', { ...payload, items: [] })).toBeUndefined();
    expect(marketEventRows('rules_supplemented', { ...payload, items: ['tags'] })).toBeUndefined();
    expect(marketEventRows('rules_supplemented', { ...payload, version: 0 })).toBeUndefined();
  });

  it('renders the open and close instants in KST', () => {
    expect(marketEventRows('opened', { openAt, closeAt })).toEqual([
      { label: copy.marketOpenAt, value: formatKst(openAt) },
      { label: copy.adminMarketCloseAtShort, value: formatKst(closeAt) },
    ]);
    expect(marketEventRows('closed', { closedAt: closeAt })).toEqual([
      { label: copy.adminMarketCloseAtShort, value: formatKst(closeAt) },
    ]);
    // The worker's close of an open or a paused market (#114): the instant, its `source` the 시스템
    // actor already says.
    expect(marketEventRows('closed', { closedAt: closeAt, source: 'job' })).toEqual([
      { label: copy.adminMarketCloseAtShort, value: formatKst(closeAt) },
    ]);
  });

  describe('the pause (#114, ADR-0102)', () => {
    const ids = {
      pauseId: 'a1b2c3d4-0000-4000-8000-000000000001',
      approvalId: 'a1b2c3d4-0000-4000-8000-000000000002',
      requestedBy: 'requester-account-id',
    };
    const publishedAt = '2026-11-05T03:10:00.000Z';

    it('reads a pause as its reason, and an early result’s publication instant in KST', () => {
      expect(
        marketEventRows('paused', {
          pauseId: ids.pauseId,
          reason: 'early_result',
          resultPublishedAt: publishedAt,
        }),
      ).toEqual([
        { label: '중단 사유', value: '사건 선공개(조기 결과)' },
        { label: '결과 공개 시각', value: formatKst(publishedAt) },
      ]);
      expect(
        marketEventRows('paused', {
          pauseId: ids.pauseId,
          reason: 'ledger_failure',
          resultPublishedAt: null,
        }),
      ).toEqual([{ label: '중단 사유', value: '담보·원장 장애' }]);
      expect(MARKET_EVENT_LABEL.paused).toBe('일시 중단');
      // Not its shape: the JSON line.
      expect(marketEventRows('paused', { reason: 'bot_stop', resultPublishedAt: null })).toBe(
        undefined,
      );
      expect(marketEventRows('paused', { reason: 'basis_change' })).toBeUndefined();
    });

    it('reads a resume and an early close by their review result, never by an account id', () => {
      const resumed = { ...ids, reviewResult: 'judgeable' };
      expect(marketEventRows('resumed', resumed)).toEqual([
        { label: '검토 결과', value: '기존 규칙으로 판정 가능' },
      ]);
      // Without a review result (a pause for another reason) the actor and the badge say it all.
      expect(marketEventRows('resumed', { ...ids, reviewResult: null })).toEqual([]);
      expect(MARKET_EVENT_LABEL.resumed).toBe('재개');
      const early = {
        ...ids,
        closedAt: closeAt,
        source: 'early_close',
        reviewResult: 'not_judgeable',
      };
      const rows = marketEventRows('closed', early);
      expect(rows).toEqual([
        { label: copy.adminMarketCloseAtShort, value: formatKst(closeAt) },
        { label: '검토 결과', value: '판정 불가' },
      ]);
      for (const row of [...(rows ?? []), ...(marketEventRows('resumed', resumed) ?? [])]) {
        expect(row.value).not.toContain(ids.requestedBy);
        expect(row.value).not.toContain(ids.approvalId);
      }
      expect(marketEventRows('closed', { ...early, reviewResult: null })).toEqual([
        { label: copy.adminMarketCloseAtShort, value: formatKst(closeAt) },
      ]);
      expect(marketEventRows('resumed', { reviewResult: 'maybe' })).toBeUndefined();
    });

    it('names an approved early close 조기 마감, every other close 마감', () => {
      const early = { ...ids, closedAt: closeAt, source: 'early_close', reviewResult: null };
      expect(marketEventLabel('closed', early)).toBe('조기 마감');
      expect(marketEventLabel('closed', { closedAt: closeAt, source: 'job' })).toBe('마감');
      expect(marketEventLabel('closed', { closedAt: closeAt })).toBe('마감');
      expect(marketEventLabel('closed', null)).toBe('마감');
      expect(marketEventLabel('paused', early)).toBe('일시 중단');
    });

    it('names every pause reason and review result, the three reasons only (#173 item 3)', () => {
      expect(Object.keys(PAUSE_REASON_LABEL)).toEqual([...MARKET_PAUSE_REASONS]);
      expect(Object.keys(PAUSE_REVIEW_RESULT_LABEL)).toEqual([...MARKET_PAUSE_REVIEW_RESULTS]);
      expect(Object.values(PAUSE_REASON_LABEL)).toEqual([
        '사건 선공개(조기 결과)',
        '담보·원장 장애',
        '실질 기준 변경',
      ]);
      expect(Object.values(PAUSE_REVIEW_RESULT_LABEL)).toEqual([
        '기존 규칙으로 판정 가능',
        '판정 불가',
      ]);
    });
  });

  it('reads the 잠정 결과 공개 as its version, result and dispute deadline, never an id (#152)', () => {
    // The approval's `provisional` event (ADR-0103): the request and its registrant are ids, which
    // no row prints (ADR-0101 9-11's way) — the 판정 panel shows them by nickname.
    const deadline = '2026-12-02T01:00:00.000Z';
    const rows = marketEventRows('provisional', {
      version: 1,
      result: 'NO',
      approvalId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
      requestedBy: 'registrant-id',
      disputeDeadline: deadline,
    });
    expect(rows).toEqual([
      { label: copy.eventJudgementVersion, value: 'v1' },
      { label: copy.marketResolvedResult, value: copy.no },
      { label: copy.eventDisputeDeadline, value: formatKst(deadline) },
    ]);
    expect(JSON.stringify(rows)).not.toContain('registrant-id');
    expect(judgementVersionName(2)).toBe('v2');
    // A VOID too goes through the 잠정 결과 (#173 item 9).
    expect(
      marketEventRows('provisional', { version: 1, result: 'VOID', disputeDeadline: deadline }),
    ).toContainEqual({ label: copy.marketResolvedResult, value: copy.marketResultVoid });
    for (const bad of [
      { version: 0, result: 'YES', disputeDeadline: deadline },
      { version: 1, result: 'MAYBE', disputeDeadline: deadline },
      { version: 1, result: 'YES', disputeDeadline: 'nope' },
      { version: 1, result: 'YES' },
      null,
    ]) {
      expect(marketEventRows('provisional', bad)).toBeUndefined();
    }
  });

  it('reads a 판정 정정 as its versions, results, new deadline and closed disputes (#176)', () => {
    // The approval's `judgement_corrected` event (ADR-0105): no status change; the request and
    // its registrant are ids, which no row prints.
    const deadline = '2026-12-03T01:00:00.000Z';
    const payload = {
      version: 2,
      previousVersion: 1,
      result: 'YES',
      previousResult: 'NO',
      approvalId: '3f2504e0-4f89-11d3-9a0c-0305e82c3303',
      requestedBy: 'registrant-id',
      disputeDeadline: deadline,
      closedDisputes: 3,
    };
    const rows = marketEventRows('judgement_corrected', payload);
    expect(rows).toEqual([
      { label: copy.eventJudgementVersion, value: 'v1 → v2' },
      { label: copy.marketResolvedResult, value: `${copy.no} → ${copy.yes}` },
      { label: copy.eventDisputeDeadline, value: formatKst(deadline) },
      { label: copy.eventClosedDisputes, value: `3${copy.adminMarketDisputesHoldingUnit}` },
    ]);
    expect(JSON.stringify(rows)).not.toContain('registrant-id');
    expect(MARKET_EVENT_LABEL.judgement_corrected).toBe(copy.eventJudgementCorrected);
    expect(marketEventLabel('judgement_corrected', payload)).toBe('판정 정정');
    expect(judgementVersionMove(2)).toBe('v2 → v3');
    // The result kept with new grounds still says both.
    expect(
      marketEventRows('judgement_corrected', { ...payload, result: 'NO', closedDisputes: 0 }),
    ).toContainEqual({ label: copy.marketResolvedResult, value: `${copy.no} → ${copy.no}` });
    for (const bad of [
      { ...payload, version: 1 },
      { ...payload, previousResult: 'MAYBE' },
      { ...payload, disputeDeadline: 'nope' },
      { ...payload, closedDisputes: -1 },
      { version: 2, result: 'YES', disputeDeadline: deadline },
      null,
    ]) {
      expect(marketEventRows('judgement_corrected', bad)).toBeUndefined();
    }
  });

  it('reads a 가격 보호 폭 변경 as the width before and after and the reason (#119)', () => {
    // ADR-0112: one admin's change of an OPEN or PAUSED market's width; no status change. `before`
    // is null only for a market submitted before #119, which had none.
    const payload = { before: 5, after: 3, reason: '호가가 촘촘해져 폭을 좁힙니다.' };
    expect(marketEventRows('price_protection_changed', payload)).toEqual([
      { label: copy.eventRulesBefore, value: '5틱' },
      { label: copy.eventRulesAfter, value: '3틱' },
      { label: copy.reviewLogReason, value: payload.reason },
    ]);
    expect(
      marketEventRows('price_protection_changed', { ...payload, before: null }),
    ).toContainEqual({
      label: copy.eventRulesBefore,
      value: copy.adminMarketPriceProtectionUndecided,
    });
    expect(MARKET_EVENT_LABEL.price_protection_changed).toBe('가격 보호 폭 변경');
    expect(marketEventLabel('price_protection_changed', payload)).toBe('가격 보호 폭 변경');
    for (const bad of [
      { ...payload, after: 0 },
      { ...payload, after: 99 },
      { ...payload, before: 2.5 },
      { ...payload, reason: undefined },
      null,
    ]) {
      expect(marketEventRows('price_protection_changed', bad)).toBeUndefined();
    }
    expect([priceProtectionText(1), priceProtectionText(98), priceProtectionText(null)]).toEqual([
      '1틱',
      '98틱',
      '미정',
    ]);
  });

  it('reads a 취소 by its path, instant and reason, never by an account id (#20)', () => {
    // The `cancelled` event (ADR-0117): the worker's close, an approved early close (with its
    // review result) or an approved cancel of a SCHEDULED market (the request's reason).
    const cancelledAt = '2026-11-29T15:00:00.000Z';
    const sentence = MARKET_NO_FILL_CANCEL_REASON;
    expect(MARKET_EVENT_LABEL.cancelled).toBe('취소');
    expect(MARKET_EVENT_LABEL.cancelled).toBe(MARKET_STATUS_LABEL.cancelled);
    expect(marketEventLabel('cancelled', { cancelledAt, source: 'job', reason: sentence })).toBe(
      '취소',
    );
    expect(marketEventRows('cancelled', { cancelledAt, source: 'job', reason: sentence })).toEqual([
      { label: copy.eventCancelSource, value: '거래 마감' },
      { label: copy.eventCancelledAt, value: formatKst(cancelledAt) },
      { label: copy.eventCancelReason, value: sentence },
    ]);
    const ids = {
      pauseId: 'a1b2c3d4-0000-4000-8000-000000000001',
      approvalId: 'a1b2c3d4-0000-4000-8000-000000000002',
      requestedBy: 'requester-account-id',
    };
    const early = marketEventRows('cancelled', {
      ...ids,
      cancelledAt,
      source: 'early_close',
      reason: sentence,
      reviewResult: 'not_judgeable',
    });
    expect(early).toEqual([
      { label: copy.eventCancelSource, value: '조기 마감' },
      { label: copy.eventCancelledAt, value: formatKst(cancelledAt) },
      { label: copy.eventCancelReason, value: sentence },
      { label: '검토 결과', value: '판정 불가' },
    ]);
    const operator = marketEventRows('cancelled', {
      approvalId: ids.approvalId,
      requestedBy: ids.requestedBy,
      cancelledAt,
      source: 'operator',
      reason: '출처가 사라졌습니다.',
    });
    expect(operator).toEqual([
      { label: copy.eventCancelSource, value: '운영자 취소' },
      { label: copy.eventCancelledAt, value: formatKst(cancelledAt) },
      { label: copy.eventCancelReason, value: '출처가 사라졌습니다.' },
    ]);
    for (const row of [...(early ?? []), ...(operator ?? [])]) {
      expect(row.value).not.toContain(ids.requestedBy);
      expect(row.value).not.toContain(ids.approvalId);
    }
    expect(Object.keys(MARKET_CANCEL_SOURCE_LABEL)).toEqual([...MARKET_CANCEL_SOURCES]);
    // Not its shape: the JSON line.
    for (const bad of [
      { cancelledAt, source: 'admin', reason: sentence },
      { cancelledAt, source: 'job' },
      { source: 'job', reason: sentence },
      null,
    ]) {
      expect(marketEventRows('cancelled', bad)).toBeUndefined();
    }
  });

  it('reads a 판정 지연 기록 as its reason, next review time and the status it was made on (#142)', () => {
    // The record's `judgement_delay_recorded` event (ADR-0106): no status change; the record's id
    // is an id, which no row prints, and the actor beside it is the admin who recorded it.
    const nextReviewAt = '2026-12-02T01:00:00.000Z';
    const payload = {
      delayId: '3f2504e0-4f89-11d3-9a0c-0305e82c3309',
      reason: '출처의 발표가\n늦어지고 있습니다.',
      nextReviewAt,
      marketStatus: 'closed',
      judgementVersion: null,
    };
    const rows = marketEventRows('judgement_delay_recorded', payload);
    expect(rows).toEqual([
      { label: copy.adminMarketJudgementDelayReason, value: payload.reason },
      { label: copy.eventNextReviewAt, value: formatKst(nextReviewAt) },
      { label: copy.adminMarketJudgementDelayEpisode, value: MARKET_STATUS_LABEL.closed },
    ]);
    expect(JSON.stringify(rows)).not.toContain(payload.delayId);
    expect(MARKET_EVENT_LABEL.judgement_delay_recorded).toBe(copy.eventJudgementDelayRecorded);
    expect(marketEventLabel('judgement_delay_recorded', payload)).toBe('판정 지연 기록');
    // On a 잠정 결과, with the version it was made on.
    expect(
      marketEventRows('judgement_delay_recorded', {
        ...payload,
        marketStatus: 'provisional',
        judgementVersion: 2,
      }),
    ).toContainEqual({ label: copy.adminMarketJudgementDelayEpisode, value: '잠정 결과 v2' });
    for (const bad of [
      { ...payload, marketStatus: 'open' },
      { ...payload, nextReviewAt: 'nope' },
      { ...payload, judgementVersion: 0 },
      { ...payload, reason: undefined },
      null,
    ]) {
      expect(marketEventRows('judgement_delay_recorded', bad)).toBeUndefined();
    }
  });

  it('words what a 판정 지연 기록 was made on: 거래 마감, or 잠정 결과 with its version (#142)', () => {
    expect(judgementDelayEpisodeText({ marketStatus: 'closed', judgementVersion: null })).toBe(
      '거래 마감',
    );
    expect(judgementDelayEpisodeText({ marketStatus: 'provisional', judgementVersion: 1 })).toBe(
      '잠정 결과 v1',
    );
  });

  it('reads the worker’s 결과 확정 at the deadline as its version and result (#152)', () => {
    // `{version, result, source: 'deadline'}`: the source is what the 시스템 actor already says.
    expect(marketEventRows('resolved', { version: 1, result: 'YES', source: 'deadline' })).toEqual([
      { label: copy.eventJudgementVersion, value: 'v1' },
      { label: copy.marketResolvedResult, value: copy.yes },
    ]);
  });

  it('reads a 결과 확정 written before #152 as its result, note and evidence; blanks are left out', () => {
    // ADR-0046's one-admin 판정 wrote `resolved` as `{result, note, evidenceUrl}`. The API nulled a
    // blank note / evidence: a row saying "메모 null" would be worse than no row.
    expect(
      marketEventRows('resolved', {
        result: 'YES',
        note: '공식 발표 확인',
        evidenceUrl: 'https://example.com/a',
      }),
    ).toEqual([
      { label: copy.marketResolvedResult, value: copy.yes },
      { label: copy.eventResolveNote, value: '공식 발표 확인' },
      { label: copy.eventResolveEvidence, value: 'https://example.com/a' },
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
    // VOID is chosen in the judgement since #152 (#173 item 4); the payload's result is the stored
    // result type, so a row that carries VOID reads in words, old or new.
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
    // Since #23: an unknown item, none at all, a value missing or of another item's shape.
    const rulesEdited = (items: unknown, before: unknown, after: unknown) =>
      marketEventRows('rules_edited', { items, before, after });
    expect(rulesEdited(['rules'], { rules: 'a' }, { rules: 'b' })).toBeUndefined();
    expect(rulesEdited([], {}, {})).toBeUndefined();
    expect(rulesEdited(['yesCondition'], {}, { yesCondition: 'b' })).toBeUndefined();
    expect(
      rulesEdited(['primarySource'], { primarySource: 'a' }, { primarySource: null }),
    ).toBeUndefined();
    expect(
      rulesEdited(['eventDeadline'], { eventDeadline: 'soon' }, { eventDeadline: null }),
    ).toBeUndefined();
    expect(
      rulesEdited(['longDelayDays'], { longDelayDays: 1.5 }, { longDelayDays: 2 }),
    ).toBeUndefined();
    expect(marketEventRows('opened', { openAt, closeAt: 'not-a-date' })).toBeUndefined();
    expect(marketEventRows('closed', { closedAt: 1 })).toBeUndefined();
    expect(marketEventRows('closed', null)).toBeUndefined();
    expect(marketEventRows('closed', undefined)).toBeUndefined();
  });

  it('reads the 개설 검수 records as their rows, the request they name left out (#78)', () => {
    const approvalId = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    // The gap the submission checked the lead close at, or 미정.
    expect(marketEventRows('submitted', { approvalId, leadCloseGapMinutes: 60 })).toEqual([
      { label: copy.adminMarketLeadCloseGap, value: `60${copy.adminMarketLeadCloseGapMinutes}` },
    ]);
    expect(marketEventRows('submitted', { approvalId, leadCloseGapMinutes: null })).toEqual([
      { label: copy.adminMarketLeadCloseGap, value: copy.adminMarketLeadCloseGapUndecided },
    ]);
    expect(
      marketEventRows('approved', {
        approvalId,
        checklist: [
          'knownResult',
          'ambiguity',
          'duplicate',
          'requiredItems',
          'timeOrder',
          'leadClose',
          'independence',
        ],
        reason: '모두 확인',
      }),
    ).toEqual([
      { label: '체크리스트', value: '7/7개 항목 확인' },
      { label: '사유', value: '모두 확인' },
    ]);
    expect(
      marketEventRows('rejected', { approvalId, rejectReason: 'other', reason: '제목 오타' }),
    ).toEqual([
      { label: '반려 사유', value: '기타' },
      { label: '설명', value: '제목 오타' },
    ]);
    expect(marketEventRows('reverted', { approvalId, reason: '출처 교체' })).toEqual([
      { label: '사유', value: '출처 교체' },
    ]);
    expect(
      marketEventRows('open_rescheduled', { before: openAt, after: closeAt, reason: '늦춤' }),
    ).toEqual([
      { label: '이전 예정 개장', value: formatKst(openAt) },
      { label: '이후 예정 개장', value: formatKst(closeAt) },
      { label: '사유', value: '늦춤' },
    ]);
    // Every review type has its name in the 이벤트 로그, the 검수 기록's name.
    expect(
      (['submitted', 'approved', 'rejected', 'reverted', 'open_rescheduled'] as const).map(
        (type) => MARKET_EVENT_LABEL[type],
      ),
    ).toEqual(['검수 제출', '승인', '반려', '초안으로 되돌림', '예정 개장 시각 변경']);
    // Not its shape: the JSON line.
    expect(marketEventRows('rejected', { approvalId, rejectReason: 'bot', reason: 'x' })).toBe(
      undefined,
    );
    expect(marketEventRows('open_rescheduled', { before: null, after: 'soon' })).toBeUndefined();
    expect(marketEventRows('approved', null)).toBeUndefined();
  });
});

describe('the rule-version items (#80, ADR-0101)', () => {
  const content: MarketRuleContent = {
    title: '첫눈이 올까?',
    description: null,
    yesCondition: 'YES 조건',
    noCondition: '',
    eventDeadline: '2026-11-30T14:59:00.000Z',
    primarySource: { name: '기상청', url: 'https://www.weather.go.kr' },
    fallbackSources: [],
    fallbackCondition: '',
    longDelayDays: 14,
    delayHandling: '무효',
    scheduledOpenAt: '2026-11-01T00:00:00.000Z',
    closeAt: '2026-11-29T15:00:00.000Z',
    scheduledAnnouncementAt: null,
    scheduledJudgementAt: null,
    judgementTimeZone: 'Asia/Seoul',
  };

  it('names every version item as the open-items check does, the announcement its own', () => {
    expect(Object.keys(RULE_VERSION_ITEM_LABEL).sort()).toEqual([...RULE_VERSION_ITEMS].sort());
    for (const item of RULE_VERSION_ITEMS) {
      expect(RULE_VERSION_ITEM_LABEL[item], item).toBe(
        item === 'scheduledAnnouncementAt'
          ? copy.openItemScheduledAnnouncementAt
          : OPEN_ITEM_LABEL[item],
      );
    }
    expect(ruleVersionItemList(['judgementTimeZone', 'title', 'title'])).toBe(
      '질문 · 판정 기준 시간대',
    );
  });

  it('words each item of a full text in KST, blanks as — and no announcement as 없음', () => {
    const text = (item: (typeof RULE_VERSION_ITEMS)[number]) =>
      ruleVersionItemText(item, content, formatKst);
    expect(text('title')).toBe('첫눈이 올까?');
    expect(text('description')).toBe('—');
    expect(text('noCondition')).toBe('—');
    expect(text('eventDeadline')).toBe(formatKst(content.eventDeadline ?? ''));
    expect(text('primarySource')).toBe('기상청 (https://www.weather.go.kr)');
    expect(text('fallbackSources')).toBe(copy.adminMarketFallbackNone);
    expect(text('longDelayDays')).toBe('예정 판정 시각에서 14일 뒤');
    expect(text('scheduledOpenAt')).toBe(formatKst(content.scheduledOpenAt ?? ''));
    expect(text('closeAt')).toBe(formatKst(content.closeAt));
    expect(text('scheduledAnnouncementAt')).toBe(copy.adminMarketAnnouncementNone);
    expect(text('scheduledJudgementAt')).toBe('—');
    expect(text('judgementTimeZone')).toBe('Asia/Seoul');
  });
});

describe('openItemsNotice', () => {
  type NoticeTimes = Omit<Parameters<typeof openItemsNotice>[0], 'status' | 'missingOpenItems'>;
  /** A draft's times, none filled in, and the gap undecided: no time rule can be judged. */
  const UNTIMED: NoticeTimes = {
    scheduledOpenAt: null,
    closeAt: '2026-10-01T00:00:00.000Z',
    scheduledAnnouncementAt: null,
    scheduledJudgementAt: null,
    judgementTimeZone: null,
    eventDeadline: null,
    leadCloseGapMinutes: null,
  };
  const draft = (missingOpenItems: OpenItem[], times: Partial<NoticeTimes> = {}) =>
    openItemsNotice({ ...UNTIMED, ...times, status: 'draft', missingOpenItems });

  it('names every open item, in OPEN_ITEMS order (#17, #23 ADR-0097, #22 ADR-0098)', () => {
    expect(OPEN_ITEMS.map((item) => OPEN_ITEM_LABEL[item])).toEqual([
      '질문',
      '배경',
      'YES 조건',
      'NO 조건',
      '사건 기한',
      '1차 출처',
      '대체 출처',
      '전환 조건',
      '장기 지연 기한',
      '지연·취소·무효 처리',
      '예정 개장 시각',
      '거래 마감 시각',
      '예정 판정 시각',
      '판정 기준 시간대',
      '시각 순서',
      '선행 마감',
      '카테고리',
      '태그 1~5개',
      '가격 보호 폭',
    ]);
    // '정산' is Coin's payout (ADR-0052): no item is named with it any more.
    for (const item of OPEN_ITEMS) expect(OPEN_ITEM_LABEL[item], item).not.toContain('정산');
    // #78's checklist lines (ADR-0093 decision 2 #172 item 4).
    expect([OPEN_ITEM_LABEL.timeOrder, OPEN_ITEM_LABEL.leadClose]).toEqual([
      '시각 순서',
      '선행 마감',
    ]);
  });

  it("says what a draft still lacks, joined with ' · ' in OPEN_ITEMS order", () => {
    // The review's submission (#78) takes the check; the interim open that took it too went with
    // #21 (ADR-0100), and the open checks nothing of it again.
    expect(draft([...OPEN_ITEMS])).toBe(
      '검수 제출 전에 채우거나 고칠 항목: 질문 · 배경 · YES 조건 · NO 조건 · 사건 기한 · 1차 출처 · ' +
        '대체 출처 · 전환 조건 · 장기 지연 기한 · 지연·취소·무효 처리 · 예정 개장 시각 · ' +
        '거래 마감 시각 · 예정 판정 시각 · 판정 기준 시간대 · 시각 순서 · 선행 마감 · 카테고리 · 태그 1~5개 · ' +
        '가격 보호 폭\n' +
        '가격 보호 폭: 표준값(출시 설정)이 미정이라 검수 제출할 수 없습니다',
    );
    // The width is no field of the form: the line says it waits for the release setting (#119).
    expect(draft(['priceProtection'])).toBe(
      `${copy.adminMarketOpenItems}: ${copy.openItemPriceProtection}\n` +
        `${copy.openItemPriceProtection}: ${copy.openItemRulePriceProtectionUndecided}`,
    );
    expect(draft(['tags'])).toBe('검수 제출 전에 채우거나 고칠 항목: 태그 1~5개');
    expect(draft(['tags', 'primarySource', 'yesCondition'])).toBe(
      `${copy.adminMarketOpenItems}: ` +
        [copy.openItemYesCondition, copy.openItemPrimarySource, copy.openItemTags].join(' · '),
    );
  });

  it('adds a line per time rule the market breaks, under 시각 순서 and 선행 마감 (#22)', () => {
    // An announcement and the gap undecided: 선행 마감 cannot hold (ADR-0098).
    const announced = {
      scheduledOpenAt: '2026-09-06T00:00:00.000Z',
      scheduledAnnouncementAt: '2026-10-01T03:00:00.000Z',
      scheduledJudgementAt: '2026-10-02T01:00:00.000Z',
    };
    expect(draft(['leadClose'], announced)).toBe(
      `${copy.adminMarketOpenItems}: ${copy.openItemLeadClose}\n` +
        `${copy.openItemLeadClose}: ${copy.openItemRuleLeadCloseUndecided}`,
    );
    // At a decided gap the line says its minutes: 240 asked, but the close leads by 180.
    expect(draft(['leadClose'], { ...announced, leadCloseGapMinutes: 240 })).toBe(
      `${copy.adminMarketOpenItems}: ${copy.openItemLeadClose}\n` +
        `${copy.openItemLeadClose}: ${copy.openItemRuleLeadCloseBefore} 240${copy.openItemRuleLeadCloseTail}`,
    );
    // The order rules — which the database keeps stored rows from breaking, so this is what the
    // check would say, not what a stored market shows — one line each, in TIME_RULES order.
    expect(
      draft(['timeOrder'], {
        scheduledOpenAt: '2026-10-01T00:00:30.000Z',
        scheduledJudgementAt: '2026-09-30T00:00:00.000Z',
        eventDeadline: '2026-10-31T00:00:00.000Z',
      }),
    ).toBe(
      [
        `${copy.adminMarketOpenItems}: ${copy.openItemTimeOrder}`,
        `${copy.openItemTimeOrder}: ${copy.openItemRuleOpenBeforeClose}`,
        `${copy.openItemTimeOrder}: ${copy.openItemRuleCloseByJudgement}`,
        `${copy.openItemTimeOrder}: ${copy.openItemRuleDeadlineByJudgement}`,
      ].join('\n'),
    );
    // No line for a relation the server did not name.
    expect(draft(['tags'], announced)).toBe(`${copy.adminMarketOpenItems}: ${copy.openItemTags}`);
  });

  it('is nothing once nothing is missing, and nothing on any status but draft', () => {
    expect(draft([])).toBeUndefined();
    // An open market whose category was hidden later keeps it (#172 item 1): the check is what
    // leaving the draft takes, so there is no notice even though the API reports the item.
    for (const status of MARKET_STATUSES.filter((value) => value !== 'draft')) {
      expect(
        openItemsNotice({ ...UNTIMED, status, missingOpenItems: ['category'] }),
        status,
      ).toBeUndefined();
    }
  });
});

describe('marketFormError for RULES_REQUIRED', () => {
  const refusal = (items: string[]) =>
    apiError(
      422,
      'RULES_REQUIRED',
      `Rule items cannot be left missing while the market is open: ${items.join(', ')}`,
      items.map((item) => ({ path: [item], message: 'required while open' })),
    );
  const refused = (...items: string[]) => marketFormError(refusal(items));

  it('puts the refusal on the field of the first item it names (#23)', () => {
    expect(refused('yesCondition', 'delayHandling')).toEqual({
      field: 'yesCondition',
      message: copy.errMarketRulesOpen,
    });
    for (const item of [
      'description',
      'noCondition',
      'eventDeadline',
      'fallbackCondition',
      'longDelayDays',
      'delayHandling',
    ]) {
      expect(refused(item), item).toEqual({ field: item, message: copy.errMarketRulesOpen });
    }
  });

  it("puts a source's, with no form values, on the primary's name or the fallback list", () => {
    expect(refused('primarySource')).toEqual({
      field: 'primarySourceName',
      message: copy.errMarketRulesOpen,
    });
    expect(refused('fallbackSources')).toEqual({
      field: 'fallbackSources',
      message: copy.errMarketRulesOpen,
    });
  });

  it("puts a source's on the blank input the form's values show, as the form's rule does", () => {
    const complete = { name: '통계청', url: 'https://kostat.go.kr' };
    const filled: MarketSourceInputs = {
      primarySourceName: complete.name,
      primarySourceUrl: complete.url,
      fallbackSources: [],
    };
    const fieldOf = (item: string, values: MarketSourceInputs) =>
      marketFormError(refusal([item]), values);
    // The primary: its address when that alone is blank, its name when the name is or both are.
    expect(fieldOf('primarySource', { ...filled, primarySourceUrl: '  ' })).toEqual({
      field: 'primarySourceUrl',
      message: copy.errMarketRulesOpen,
    });
    expect(fieldOf('primarySource', { ...filled, primarySourceName: '' })?.field).toBe(
      'primarySourceName',
    );
    expect(
      fieldOf('primarySource', { ...filled, primarySourceName: '', primarySourceUrl: '' })?.field,
    ).toBe('primarySourceName');
    // The first fallback that is not complete, on its blank input: a complete one is passed over.
    const nameless = { name: '', url: complete.url };
    const fallbacks = [complete, { name: '연합뉴스', url: ' ' }, nameless];
    expect(fieldOf('fallbackSources', { ...filled, fallbackSources: fallbacks })).toEqual({
      field: 'fallbackSources.1.url',
      message: copy.errMarketRulesOpen,
    });
    expect(
      fieldOf('fallbackSources', { ...filled, fallbackSources: [complete, nameless] })?.field,
    ).toBe('fallbackSources.1.name');
    // Values with no such blank input (the API judged other ones): placed as with none.
    expect(fieldOf('primarySource', filled)?.field).toBe('primarySourceName');
    expect(fieldOf('fallbackSources', { ...filled, fallbackSources: [complete] })?.field).toBe(
      'fallbackSources',
    );
    // Any other item is its own field, whatever the sources hold.
    expect(fieldOf('yesCondition', { ...filled, primarySourceName: '' })?.field).toBe(
      'yesCondition',
    );
  });

  it('leaves one naming nothing it knows to the toast', () => {
    expect(refused('rules')).toBeUndefined();
    expect(refused()).toBeUndefined();
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

  it('names the specific refusals of the submission and of a 판정', () => {
    // The one-admin close went with #114 (ADR-0102): no route answers MARKET_NOT_OPEN any more, and
    // the pause's refusals are its own (`pauseFailure`, lib/market-pause.ts).
    expect(transitionErrorMessage(apiError(409, 'MARKET_NOT_OPEN'))).toBe(copy.errUnknown);
    expect(Object.keys(copy)).not.toContain('errMarketNotOpen');
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
    // The interim open's 'not reached yet' went with it (#21, ADR-0100): no transition here names
    // the scheduled open any more — a reschedule's refusals are the review's (`reviewFailure`) — so
    // one would be an ordinary invalid body.
    expect(
      transitionErrorMessage(
        apiError(422, 'VALIDATION_ERROR', 'x', [
          { path: ['scheduledOpenAt'], message: 'not reached yet' },
        ]),
      ),
    ).toBe(copy.errMarketInvalid);
    expect(Object.keys(copy)).not.toContain('errMarketScheduledOpenNotReached');
  });

  it('names no 판정 field: the judgement’s refusals are its own since #152', () => {
    // A transition refused naming `status` is a stale screen, whatever the state named.
    for (const message of ['market is resolved', 'market is settled']) {
      expect(
        transitionErrorMessage(
          apiError(400, 'VALIDATION_ERROR', 'x', [{ path: ['status'], message }]),
        ),
        message,
      ).toBe(copy.errMarketStatus);
    }
    // The one-admin 판정's note and evidence went with its route (ADR-0103): an issue naming them,
    // or a result, is an ordinary invalid body — the judgement's are `judgementFailure`'s.
    const named = (path: string) =>
      transitionErrorMessage(
        apiError(400, 'VALIDATION_ERROR', 'x', [{ path: [path], message: 'bad' }]),
      );
    for (const path of ['result', 'note', 'evidenceUrl']) {
      expect(named(path), path).toBe(copy.errMarketInvalid);
    }
    for (const key of [
      'errMarketResolveNote',
      'errMarketResolveEvidence',
      'errMarketResultRequired',
    ]) {
      expect(Object.keys(copy), key).not.toContain(key);
    }
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
        { path: ['yesCondition'], message: 'required' },
        { path: ['fallbackCondition'], message: 'required' },
        { path: ['category'], message: 'subcategories' },
        { path: ['tags'], message: 'required' },
      ]),
    ).toBe(
      '검수 제출 전에 채우거나 고칠 항목이 있습니다: YES 조건 · 전환 조건 · 카테고리 · 태그 1~5개',
    );
    expect(refused([{ path: ['tags'], message: 'required' }])).toBe(
      `${copy.errMarketOpenItemsMissing}: ${copy.openItemTags}`,
    );
    // The order is OPEN_ITEMS', whatever order the answer listed them in, each once.
    expect(
      refused([
        { path: ['tags'], message: 'required' },
        { path: ['primarySource'], message: 'required' },
        { path: ['title'], message: 'required' },
        { path: ['tags'], message: 'required' },
      ]),
    ).toBe(
      `${copy.errMarketOpenItemsMissing}: ` +
        [copy.openItemTitle, copy.openItemPrimarySource, copy.openItemTags].join(' · '),
    );
    // The label '정산 규칙' and the item `rules` are gone (#23): an old answer naming it is unknown.
    expect(refused([{ path: ['rules'], message: 'required' }])).toBe(
      `${copy.errMarketOpenItemsMissing}.`,
    );
    // No details, or none this screen knows: the line alone.
    expect(refused()).toBe('검수 제출 전에 채우거나 고칠 항목이 있습니다.');
    // The times and the relations between them (#22), with their messages.
    expect(
      refused([
        { path: ['leadClose'], message: 'gap undecided' },
        { path: ['scheduledJudgementAt'], message: 'required' },
        { path: ['timeOrder'], message: 'closeByJudgement' },
        { path: ['scheduledOpenAt'], message: 'required' },
      ]),
    ).toBe(
      `${copy.errMarketOpenItemsMissing}: ` +
        [
          copy.openItemScheduledOpenAt,
          copy.openItemScheduledJudgementAt,
          copy.openItemTimeOrder,
          copy.openItemLeadClose,
        ].join(' · '),
    );
    expect(refused([{ path: ['times'], message: 'required' }])).toBe(
      `${copy.errMarketOpenItemsMissing}.`,
    );
    expect(refused('nope')).toBe(`${copy.errMarketOpenItemsMissing}.`);
    // Not a field refusal: the form leaves it to this toast.
    expect(
      marketFormError(
        apiError(422, 'OPEN_ITEMS_MISSING', 'x', [{ path: ['yesCondition'], message: 'required' }]),
      ),
    ).toBeUndefined();
  });

  it('no longer reads RULES_REQUIRED as a refused open: only a supplement answers it', () => {
    // The interim open answered OPEN_ITEMS_MISSING from #17 until it went with #21; a supplement's
    // RULES_REQUIRED (#80) lands on the rule item it names (`marketFormError`), so a stray one here
    // is the generic toast.
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
    expect(named('imageUrl')).toEqual({ field: 'imageUrl', message: copy.errMarketImageUrl });
    // The rule items (#23): the texts by their length, the deadline and the days by their rule.
    for (const field of ['description', 'yesCondition', 'noCondition', 'delayHandling']) {
      expect(named(field), field).toEqual({ field, message: copy.errMarketText });
    }
    expect(named('eventDeadline')).toEqual({
      field: 'eventDeadline',
      message: copy.errMarketEventDeadline,
    });
    expect(named('longDelayDays')).toEqual({
      field: 'longDelayDays',
      message: copy.errMarketLongDelayDays,
    });
    // The fields #23 replaced have nothing to land on any more.
    expect(named('rules')).toBeUndefined();
    expect(named('resolutionSource')).toBeUndefined();
    // Nor does a name that is no form field, an inherited one included.
    expect(named('toString')).toBeUndefined();
  });

  it('lands a refused time on its input, said by which rule the message is (#22)', () => {
    const refused = (path: string, message: string, gap?: number | null) =>
      marketFormError(
        apiError(422, 'VALIDATION_ERROR', 'x', [{ path: [path], message }]),
        undefined,
        gap,
      );
    // Each order rule says one sentence on both its ends.
    const ORDER = {
      openBeforeClose: copy.errMarketTimeOpenBeforeClose,
      closeByJudgement: copy.errMarketTimeCloseByJudgement,
      deadlineByJudgement: copy.errMarketTimeDeadlineByJudgement,
    } as const;
    for (const [rule, text] of Object.entries(ORDER) as [keyof typeof ORDER, string][]) {
      for (const [field, message] of Object.entries(TIME_RULE_MESSAGES[rule])) {
        expect(refused(field, message), `${rule} ${field}`).toEqual({ field, message: text });
      }
    }
    // The lead close with the gap the market is held to, or without minutes when unknown.
    for (const [field, message] of Object.entries(TIME_RULE_MESSAGES.leadClose)) {
      expect(refused(field, message, 60)).toEqual({
        field,
        message: `${copy.errMarketLeadCloseBefore} 60${copy.errMarketLeadCloseTail}`,
      });
      expect(refused(field, message)).toEqual({ field, message: copy.errMarketLeadClose });
    }
    // The open market's own refusals.
    expect(refused('closeAt', 'cannot move earlier while open')).toEqual({
      field: 'closeAt',
      message: copy.errMarketCloseEarlier,
    });
    // A supplement's close while PAUSED (#80, #172 item 14).
    expect(refused('closeAt', SUPPLEMENT_CLOSE_FIXED_WHILE_PAUSED)).toEqual({
      field: 'closeAt',
      message: copy.errMarketSupplementClosePaused,
    });
    expect(refused('scheduledAnnouncementAt', 'lead-close gap undecided')).toEqual({
      field: 'scheduledAnnouncementAt',
      message: copy.errMarketLeadCloseUndecided,
    });
    // Anything else is the field's own: the close's future, a time's format, the zone's name.
    expect(refused('closeAt', 'must be in the future')).toEqual({
      field: 'closeAt',
      message: copy.errMarketCloseAt,
    });
    expect(refused('scheduledOpenAt', 'Invalid ISO datetime')).toEqual({
      field: 'scheduledOpenAt',
      message: copy.errMarketScheduledTime,
    });
    expect(refused('judgementTimeZone', 'must be an IANA time zone name')).toEqual({
      field: 'judgementTimeZone',
      message: copy.errMarketTimeZone,
    });
    expect(refused('eventDeadline', 'Invalid ISO datetime')).toEqual({
      field: 'eventDeadline',
      message: copy.errMarketEventDeadline,
    });
    // The zone cleared on an open market: RULES_REQUIRED, on the select.
    expect(
      marketFormError(
        apiError(422, 'RULES_REQUIRED', 'x', [
          { path: ['judgementTimeZone'], message: 'required while open' },
        ]),
      ),
    ).toEqual({ field: 'judgementTimeZone', message: copy.errMarketRulesOpen });
  });

  it('lands an open market’s edit of a version item on its input: a supplement’s alone (#80)', () => {
    const refused = (path: string) =>
      marketFormError(
        apiError(400, 'VALIDATION_ERROR', 'x', [
          { path: [path], message: SUPPLEMENT_ONLY_WHILE_OPEN },
        ]),
      );
    const fields: Record<string, string> = {
      primarySource: 'primarySourceName',
    };
    for (const item of RULE_VERSION_ITEMS) {
      expect(refused(item), item).toEqual({
        field: fields[item] ?? item,
        message: copy.errMarketSupplementOnly,
      });
    }
    // Not a version item: the field's own refusal, whatever the message.
    expect(refused('imageUrl')).toEqual({ field: 'imageUrl', message: copy.errMarketImageUrl });
  });

  it('lands a refused source on the input its path names (#23)', () => {
    const refused = (path: (string | number)[], message = 'Invalid URL') =>
      marketFormError(apiError(422, 'VALIDATION_ERROR', 'Validation failed', [{ path, message }]));
    expect(refused(['primarySource', 'url'])).toEqual({
      field: 'primarySourceUrl',
      message: copy.errMarketSourceUrl,
    });
    expect(refused(['primarySource', 'name'], 'Too big')).toEqual({
      field: 'primarySourceName',
      message: copy.errMarketSourceName,
    });
    expect(refused(['fallbackSources', 1, 'url'])).toEqual({
      field: 'fallbackSources.1.url',
      message: copy.errMarketSourceUrl,
    });
    expect(refused(['fallbackSources', 2, 'name'], 'Too big')).toEqual({
      field: 'fallbackSources.2.name',
      message: copy.errMarketSourceName,
    });
    // Both blank: the fallback's row. The form never sends such a primary (it sends null).
    expect(refused(['fallbackSources', 0], 'empty source')).toEqual({
      field: 'fallbackSources.0',
      message: copy.errMarketSourceEmpty,
    });
    expect(refused(['primarySource'], 'empty source')).toBeUndefined();
    // The list over MARKET_FALLBACK_SOURCES_MAX.
    expect(refused(['fallbackSources'], 'Too big: expected array to have <=3 items')).toEqual({
      field: 'fallbackSources',
      message: copy.errMarketFallbackSourcesMax,
    });
    expect(refused(['fallbackSources', 'x', 'url'])).toBeUndefined();
  });

  it('says a switch condition with no fallback as that, and a long one by its length', () => {
    const refused = (message: string) =>
      marketFormError(
        apiError(422, 'VALIDATION_ERROR', 'x', [{ path: ['fallbackCondition'], message }]),
      );
    expect(refused('no fallback source')).toEqual({
      field: 'fallbackCondition',
      message: copy.errMarketFallbackConditionNoSource,
    });
    expect(refused('Too big: expected string to have <=5000 characters')).toEqual({
      field: 'fallbackCondition',
      message: copy.errMarketText,
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

describe('scheduledMarketPollDelay (#21, ADR-0100)', () => {
  const scheduledOpenAt = '2026-11-10T00:00:00.000Z';
  const closeAt = '2026-11-20T00:00:00.000Z';
  const at = (iso: string) => new Date(iso).getTime();
  const scheduled = { status: 'scheduled' as const, scheduledOpenAt, closeAt };
  /** The delay as the hook asks it: right after a read, so read and now are one instant. */
  const delayAt = (market: Parameters<typeof scheduledMarketPollDelay>[0], iso: string) =>
    scheduledMarketPollDelay(market, at(iso), at(iso));

  it('reads it again at its scheduled open', () => {
    expect(delayAt(scheduled, '2026-11-09T23:59:00.000Z')).toBe(60_000);
    expect(delayAt(scheduled, '2026-11-09T23:59:59.999Z')).toBe(1);
  });

  it('then every few seconds until it is no longer 개장 예정, the worker having opened it', () => {
    expect(SCHEDULED_OPEN_POLL_MS).toBe(5_000);
    expect(delayAt(scheduled, scheduledOpenAt)).toBe(SCHEDULED_OPEN_POLL_MS);
    expect(delayAt(scheduled, '2026-11-15T00:00:00.000Z')).toBe(SCHEDULED_OPEN_POLL_MS);
    for (const status of MARKET_STATUSES.filter((value) => value !== 'scheduled')) {
      expect(delayAt({ ...scheduled, status }, '2026-11-15T00:00:00.000Z'), status).toBe(false);
    }
    expect(scheduledMarketPollDelay(undefined, 0)).toBe(false);
  });

  it('and once at its close, for the answer the warning judges; after that read, no more', () => {
    // Under the poll interval to go: the read lands on the close itself.
    expect(delayAt(scheduled, '2026-11-19T23:59:58.000Z')).toBe(2_000);
    // The row read at or after the close stands: nothing opens the market any more.
    expect(delayAt(scheduled, closeAt)).toBe(false);
    expect(delayAt(scheduled, '2026-11-21T00:00:00.000Z')).toBe(false);
  });

  it('re-reads a row read before the close but asked after it at the poll, never at once', () => {
    // A failed read leaves `dataUpdatedAt` before the close (query-core moves only
    // `errorUpdatedAt`): an immediate delay would refire on every failure — on a 401 after a
    // sign-out, a request loop (verification of the Codex fix on #21).
    const before = at('2026-11-19T23:59:59.000Z');
    for (const now of [
      '2026-11-20T00:00:00.000Z',
      '2026-11-20T00:00:00.001Z',
      '2026-11-21T00:00:00Z',
    ]) {
      expect(scheduledMarketPollDelay(scheduled, before, at(now)), now).toBe(
        SCHEDULED_OPEN_POLL_MS,
      );
    }
  });

  it('reads at the close when the scheduled open is the later, or missing', () => {
    // A scheduled open at or past the close cannot be stored (#22), but the earlier one wins.
    expect(delayAt({ ...scheduled, scheduledOpenAt: null }, '2026-11-19T23:00:00.000Z')).toBe(
      3_600_000,
    );
    expect(
      delayAt(
        { ...scheduled, scheduledOpenAt: '2026-11-21T00:00:00.000Z' },
        '2026-11-19T23:00:00Z',
      ),
    ).toBe(3_600_000);
  });

  it('caps a far scheduled open at the longest timer, and gives up on an unreadable close', () => {
    expect(MAX_TIMEOUT_MS).toBe(2_147_483_647);
    const far = {
      ...scheduled,
      scheduledOpenAt: '2027-06-01T00:00:00.000Z',
      closeAt: '2027-07-01T00:00:00.000Z',
    };
    expect(delayAt(far, '2026-11-01T00:00:00.000Z')).toBe(MAX_TIMEOUT_MS);
    expect(delayAt({ ...scheduled, closeAt: 'nope' }, '2026-11-01T00:00:00.000Z')).toBe(false);
  });
});

describe('tradingMarketPollDelay (#114, ADR-0102)', () => {
  const closeAt = '2026-11-20T00:00:00.000Z';
  const at = (iso: string) => new Date(iso).getTime();

  it('reads an open or a paused market again at its close', () => {
    for (const status of ['open', 'paused'] as const) {
      expect(tradingMarketPollDelay({ status, closeAt }, at('2026-11-19T23:59:00.000Z'))).toBe(
        60_000,
      );
      expect(tradingMarketPollDelay({ status, closeAt }, at('2026-11-19T23:59:59.999Z'))).toBe(1);
    }
  });

  it('then every few seconds until the worker closed it, never at once', () => {
    // A paused market closes on schedule too (#173 items 1·3), which makes a waiting next path
    // moot: the detail follows it without a reload. A failed read refires at the poll, not at once.
    expect(TRADING_CLOSE_POLL_MS).toBe(5_000);
    for (const now of [closeAt, '2026-11-20T00:00:00.001Z', '2026-11-21T00:00:00.000Z']) {
      expect(tradingMarketPollDelay({ status: 'paused', closeAt }, at(now)), now).toBe(
        TRADING_CLOSE_POLL_MS,
      );
    }
  });

  it('is nothing for any other status or an unreadable close, and caps a far close', () => {
    for (const status of MARKET_STATUSES.filter(
      (value) => value !== 'open' && value !== 'paused',
    )) {
      expect(tradingMarketPollDelay({ status, closeAt }, at(closeAt)), status).toBe(false);
    }
    expect(tradingMarketPollDelay(undefined)).toBe(false);
    expect(tradingMarketPollDelay({ status: 'open', closeAt: 'nope' })).toBe(false);
    expect(
      tradingMarketPollDelay({ status: 'open', closeAt: '2027-07-01T00:00:00.000Z' }, at(closeAt)),
    ).toBe(MAX_TIMEOUT_MS);
  });
});

describe('judgementDelayedNote (#173 item 11)', () => {
  it('names what holds a delayed market: the schedule, a waiting correction, or a dispute', () => {
    const idle = { pending: null };
    expect(judgementDelayedNote({ status: 'closed', judgement: idle })).toBe(
      copy.adminMarketJudgementDelayedNote,
    );
    // #175: a pending or accepted 판정 이의 holds it past the deadline.
    expect(judgementDelayedNote({ status: 'provisional', judgement: idle })).toBe(
      copy.adminMarketDisputeDelayedNote,
    );
    // #176: a correction waiting for its approval holds it, and is what decides it next.
    expect(judgementDelayedNote({ status: 'provisional', judgement: { pending: {} } })).toBe(
      copy.adminMarketCorrectionDelayedNote,
    );
    // Never a NO for lateness (N03 §4).
    expect(copy.adminMarketCorrectionDelayedNote).not.toMatch(/NO|환불|원금/);
  });
});

describe('provisionalMarketPollDelay (#152, ADR-0103)', () => {
  const disputeDeadline = '2026-12-02T01:00:00.000Z';
  const at = (iso: string) => new Date(iso).getTime();
  /** No 판정 이의 holds it (#175), and no correction waits (#176). */
  const FREE = { holding: 0 };
  const IDLE = { pending: null };

  it('reads a 잠정 결과 market again at its dispute deadline', () => {
    expect(
      provisionalMarketPollDelay(
        { status: 'provisional', disputeDeadline, disputes: FREE, judgement: IDLE },
        at('2026-12-02T00:59:00.000Z'),
      ),
    ).toBe(60_000);
    expect(
      provisionalMarketPollDelay(
        { status: 'provisional', disputeDeadline, disputes: FREE, judgement: IDLE },
        at('2026-12-02T00:59:59.999Z'),
      ),
    ).toBe(1);
  });

  it('then every few seconds until the worker confirmed it, never at once', () => {
    // The job confirms it at the deadline, the per-minute scan within a minute: the detail follows
    // it without a reload. A failed read refires at the poll, not at once.
    expect(PROVISIONAL_DEADLINE_POLL_MS).toBe(5_000);
    for (const now of [disputeDeadline, '2026-12-02T01:00:00.001Z', '2026-12-03T00:00:00.000Z']) {
      expect(
        provisionalMarketPollDelay(
          { status: 'provisional', disputeDeadline, disputes: FREE, judgement: IDLE },
          at(now),
        ),
        now,
      ).toBe(PROVISIONAL_DEADLINE_POLL_MS);
    }
  });

  it('stops past the deadline while a 판정 이의 holds it, and resumes once none does (#175)', () => {
    // ADR-0104: a pending or accepted dispute keeps the market PROVISIONAL past its deadline, and
    // nothing confirms it then; the read at the deadline still comes (its 판정 지연 note).
    const held = {
      status: 'provisional' as const,
      disputeDeadline,
      disputes: { holding: 2 },
      judgement: IDLE,
    };
    expect(provisionalMarketPollDelay(held, at('2026-12-02T00:59:00.000Z'))).toBe(60_000);
    for (const now of [disputeDeadline, '2026-12-03T00:00:00.000Z']) {
      expect(provisionalMarketPollDelay(held, at(now)), now).toBe(false);
    }
    // The last 기각's answer holds none: the API's `market.resolve` confirms it within seconds.
    expect(
      provisionalMarketPollDelay(
        { ...held, disputes: FREE, judgement: IDLE },
        at('2026-12-03T00:00:00.000Z'),
      ),
    ).toBe(PROVISIONAL_DEADLINE_POLL_MS);
  });

  it('stops past the deadline while a correction waits, and resumes once it is decided (#176)', () => {
    // ADR-0105 (decision 3 '#176 정정 대기'): a waiting correction holds the confirmation — on a
    // PROVISIONAL market the registration waiting is one — with no dispute holding it.
    const waiting = {
      status: 'provisional' as const,
      disputeDeadline,
      disputes: FREE,
      judgement: { pending: { requestId: 'r' } },
    };
    expect(provisionalMarketPollDelay(waiting, at('2026-12-02T00:59:00.000Z'))).toBe(60_000);
    for (const now of [disputeDeadline, '2026-12-03T00:00:00.000Z']) {
      expect(provisionalMarketPollDelay(waiting, at(now)), now).toBe(false);
    }
    // Rejected or retracted with nothing holding: the API's `market.resolve` confirms it within
    // seconds, and the detail follows it.
    expect(
      provisionalMarketPollDelay({ ...waiting, judgement: IDLE }, at('2026-12-03T00:00:00.000Z')),
    ).toBe(PROVISIONAL_DEADLINE_POLL_MS);
  });

  it('is nothing for any other status or a missing or unreadable deadline, and caps a far one', () => {
    for (const status of MARKET_STATUSES.filter((value) => value !== 'provisional')) {
      expect(
        provisionalMarketPollDelay(
          { status, disputeDeadline, disputes: FREE, judgement: IDLE },
          at(disputeDeadline),
        ),
        status,
      ).toBe(false);
    }
    expect(provisionalMarketPollDelay(undefined)).toBe(false);
    expect(
      provisionalMarketPollDelay({
        status: 'provisional',
        disputeDeadline: null,
        disputes: FREE,
        judgement: IDLE,
      }),
    ).toBe(false);
    expect(
      provisionalMarketPollDelay({
        status: 'provisional',
        disputeDeadline: 'nope',
        disputes: FREE,
        judgement: IDLE,
      }),
    ).toBe(false);
    expect(
      provisionalMarketPollDelay(
        {
          status: 'provisional',
          disputeDeadline: '2027-07-01T00:00:00.000Z',
          disputes: FREE,
          judgement: IDLE,
        },
        at(disputeDeadline),
      ),
    ).toBe(MAX_TIMEOUT_MS);
  });
});

describe('adminMarketPollInterval', () => {
  const market = (status: MarketStatus) => ({
    status,
    scheduledOpenAt: '2000-01-01T00:00:00.000Z',
    closeAt: '2999-01-01T00:00:00.000Z',
    disputeDeadline: status === 'provisional' ? '2000-01-01T00:00:00.000Z' : null,
    disputes: { holding: 0 },
    judgement: { pending: null },
  });

  it('is the settlement poll for a confirmed market, the 개장 예정 re-read for a scheduled one', () => {
    const readAt = Date.now();
    for (const status of MARKET_STATUSES) {
      const interval = adminMarketPollInterval({ data: market(status), dataUpdatedAt: readAt });
      // A trading market's close is centuries off here: the longest timer, then again (#114). A
      // 잠정 결과 market's deadline has passed: the poll until the worker confirms it (#152).
      const expected =
        status === 'resolved' || status === 'settling'
          ? SETTLEMENT_POLL_INTERVAL_MS
          : status === 'scheduled'
            ? SCHEDULED_OPEN_POLL_MS
            : status === 'open' || status === 'paused'
              ? MAX_TIMEOUT_MS
              : status === 'provisional'
                ? PROVISIONAL_DEADLINE_POLL_MS
                : false;
      expect(interval, status).toBe(expected);
    }
    expect(adminMarketPollInterval({ data: undefined, dataUpdatedAt: 0 })).toBe(false);
  });

  it('is what the admin detail polls by, and the review panel judges the row it read', () => {
    // The fix lives at two call sites the unit tests above cannot reach (components and hooks
    // are not run here): pin them.
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source('../hooks/use-admin-markets.ts')).toContain(
      'refetchInterval: (query) => adminMarketPollInterval(query.state),',
    );
    expect(source('../app/admin/markets/[id]/admin-market-detail.tsx')).toContain(
      'readAt={market.dataUpdatedAt}',
    );
    expect(source('../app/admin/markets/[id]/market-review-panel.tsx')).toContain(
      'const closeLapsed = scheduledCloseLapsed(market, readAt);',
    );
  });
});
