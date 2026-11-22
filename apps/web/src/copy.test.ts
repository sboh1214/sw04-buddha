import { CONTRACT_TERMS, PAYOUT_PER_CONTRACT_COIN, formatCoin } from '@buddha/shared';
import { describe, expect, it, vi } from 'vitest';
import { copy } from './copy';
import {
  AUTH_ERROR,
  authErrorMessage,
  authNoticeFor,
  fetchOrNetworkError,
  safeNextPath,
  verifyLinkErrorCode,
} from './lib/auth-client';

describe('copy', () => {
  it('has the wallet notice: no cash exchange or withdrawal, and nothing about charging', () => {
    // N01 §2 in the plan's own words ('제공하지 않는다'); paid Coin is closed (ADR-0049).
    expect(copy.walletNotice).toContain('환전');
    expect(copy.walletNotice).toContain('출금');
    expect(copy.walletNotice).toContain('제공하지 않습니다');
    for (const word of ['충전', '결제', '쿠폰', '구매']) {
      expect(copy.walletNotice).not.toContain(word);
    }
  });

  it('promises no refund for a cancelled market or a 무효 result (N03 §6: not a cost refund)', () => {
    // #125 took the admin void and its cost refund away; since #174 a cancelled market ends with
    // no result, and a 무효 result is paid 50/50 by #126 — neither is a refund of what was spent.
    for (const text of [copy.marketCancelledNotice, copy.marketSettledPayoutVoid]) {
      expect(text).not.toContain('환불');
    }
  });

  it('never says 100 Coin for a 무효 result, which has no winning side (ADR-0093 decision 1)', () => {
    expect(copy.marketSettledPayout).toContain('100 Coin');
    expect(copy.marketSettledPayoutVoid).not.toContain('100');
    expect(copy.marketSettledPayoutVoid).not.toContain('정답');
    // #34 (ADR-0145; ADR-0135 결정 4): 무효 pays each contract half the winning payout — a payout,
    // never what was spent given back — and both lines hold for any visitor of the public notice.
    // The sentence states the terms' one amount, so a change of terms has to change it too.
    expect(CONTRACT_TERMS.voidPayoutYesCoin).toBe(CONTRACT_TERMS.voidPayoutNoCoin);
    expect(BigInt(CONTRACT_TERMS.voidPayoutYesCoin)).toBe(PAYOUT_PER_CONTRACT_COIN / 2n);
    expect(copy.marketSettledPayoutVoid).toContain(`${String(PAYOUT_PER_CONTRACT_COIN / 2n)} Coin`);
    for (const text of [copy.marketSettledPayout, copy.marketSettledPayoutVoid]) {
      expect(text).not.toMatch(/환불|원금/);
      expect(text).toContain('정산 때 계약을 보유한 계정은');
    }
  });

  it('words the recap’s links and its empty line with no score, rank or refund (#34)', () => {
    // N04 §3·§4: a P&L is trade accounting, never a score; I3: the orders link opens ended orders.
    const recap = [
      copy.marketHistoryFills,
      copy.marketHistorySettlements,
      copy.marketHistoryOrders,
      copy.marketMyPositionEmptyEnded,
    ];
    expect(recap).toEqual([
      '이 시장 체결 이력',
      '이 시장 정산 이력',
      '이 시장 끝난 주문',
      '이 시장에서 보유한 계약이 없습니다.',
    ]);
    for (const text of recap) {
      expect(text).not.toMatch(/환불|원금|순위|랭킹|실력|점수|스코어|수익률|승률|적중|참여/);
    }
  });

  it('labels every status as ADR-0093 decision 1 item 12 words it, and VOID as 무효', () => {
    // The user labels word for word; 초안 and 검수 중 are the admin's alone.
    expect([
      copy.marketStatusScheduled,
      copy.marketStatusOpen,
      copy.marketStatusPaused,
      copy.marketStatusClosed,
      copy.marketStatusProvisional,
      copy.marketStatusResolved,
      copy.marketStatusSettling,
      copy.marketStatusSettled,
      copy.marketStatusCancelled,
    ]).toEqual([
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
    expect([copy.marketStatusDraft, copy.marketStatusReview]).toEqual(['초안', '검수 중']);
    expect(copy.marketResultVoid).toBe('무효');
    // A display, not a status (#173 item 11, #22): what a closed market late for its judgement
    // reads in place of 거래 마감.
    expect(copy.marketStatusJudgementDelayed).toBe('판정 지연');
    // Another display (#173 item 12, #175): a provisional market a 판정 이의 holds, before its
    // deadline — past it the same market reads 판정 지연 (owner answer 2026-11-03).
    expect(copy.marketStatusDisputeUnderReview).toBe('이의 검토 중');
  });

  it("names the rules area's time rows apart from the status badges (#22)", () => {
    // '개장 예정' and '거래 마감' are badges; the rows are times, and the long delay counts from
    // the row named 예정 판정 시각.
    const rows = [
      copy.rulesScheduledOpenAt,
      copy.rulesCloseAt,
      copy.rulesAnnouncementAt,
      copy.rulesJudgementAt,
    ];
    expect(rows).toEqual(['예정 개장 시각', '거래 마감 시각', '발표 예정 시각', '예정 판정 시각']);
    for (const row of rows) {
      expect([copy.marketStatusScheduled, copy.marketStatusClosed]).not.toContain(row);
    }
    expect(copy.rulesLongDelayBefore).toContain(copy.rulesJudgementAt);
    // The card's 개장 예정 line (#61, ADR-0136) is a time too, of the same stem as the row.
    expect(copy.marketScheduledOpenAt).toBe('예정 개장');
    expect([copy.marketStatusScheduled, copy.marketStatusClosed]).not.toContain(
      copy.marketScheduledOpenAt,
    );
  });

  it('never makes a late result a NO, nor promises a refund for it (N03 §4, §6)', () => {
    for (const text of [
      copy.marketJudgementDelayedNotice,
      copy.adminMarketJudgementDelayedNote,
      copy.adminMarketScheduledJudgementAtHint,
      // A 잠정 결과 held past its deadline by a dispute or a waiting correction (#175, #176).
      copy.marketProvisionalDelayed,
      copy.marketProvisionalDelayedCorrection,
      copy.adminMarketDisputeDelayedNote,
      copy.adminMarketCorrectionDelayedNote,
      // The 판정 지연 기록's (#142): the public rows and 갱신 대기, the admin section, its warnings —
      // the late update and the long delay, whose rule is applied through 판정 등록 — and the dialog.
      copy.marketJudgementDelayReason,
      copy.marketNextReviewAt,
      copy.marketNextReviewPassed,
      copy.marketNextReviewPassedNote,
      copy.adminMarketJudgementDelaysIntro,
      copy.adminMarketJudgementDelayLate,
      copy.adminMarketJudgementLongDelay,
      copy.adminMarketJudgementDelayBody,
      copy.adminMarketJudgementDelayReasonHint,
      copy.adminMarketJudgementDelayNextReviewHint,
      copy.adminMarketJudgementDelayUnscheduled,
      copy.adminMarketJudgementDelayEarly,
      copy.adminMarketJudgementDelayUnheld,
      copy.adminMarketJudgementDelayNoCurrent,
      copy.eventJudgementDelayRecorded,
      // Its notice to watchers and holders (#188, ADR-0160; 52-11): the reason and the next review.
      copy.notificationJudgementDelayed,
    ]) {
      expect(text).not.toMatch(/NO|환불|원금/);
    }
  });

  it('words the 판정·정산 알림 with no refund, P&L, rank or score, and no amount of its own (#188)', () => {
    // N03 §6: a 무효 payout is a 지급, never what was paid given back; N04 §1·§3·§4 and 52-15
    // ('손익 없음'): nothing beside a result or a payout reads as a score, a rank or a return.
    const notices = [
      copy.notificationJudgementDelayed,
      copy.notificationProvisionalResult,
      copy.notificationJudgementCorrected,
      copy.notificationDisputeDecided,
      copy.notificationDisputeClosedByCorrection,
      copy.notificationMarketSettled,
      copy.notificationMarketSettledWatcher,
    ];
    for (const text of notices) {
      expect(text).not.toMatch(
        /환불|원금|순위|랭킹|실력|점수|스코어|수익률|승률|적중|정답|맞힌|손익|정산 기준/,
      );
    }
    // The payout is the member's own, a placeholder — no amount is written into the sentence,
    // and the watcher's sentence has none at all (52-15).
    for (const text of [copy.notificationMarketSettled, copy.notificationMarketSettledWatcher]) {
      expect(text).not.toMatch(/\d|Coin/);
      expect(text).toContain('결과 확정: {result} · 지급 완료');
    }
    expect(copy.notificationMarketSettled).toContain('{payout}');
    expect(copy.notificationMarketSettledWatcher).not.toContain('{payout}');
    // No expected payout on a 잠정 결과 or its correction (52-15 '예상 지급액 없음').
    for (const text of [copy.notificationProvisionalResult, copy.notificationJudgementCorrected]) {
      expect(text).not.toMatch(/지급|\{payout\}/);
    }
  });

  it('names no operator in the public 판정 지연 기록 and offers no withdrawal of one (#142)', () => {
    // #173 item 13, decision 3 '#142 지연 사유': the public detail shows the reason and the time,
    // never who recorded it nor when — those words are the admin section's alone.
    for (const [key, text] of Object.entries(copy).filter(
      ([key]) => key.startsWith('marketJudgementDelay') || key.startsWith('marketNextReview'),
    )) {
      expect(text, key).not.toMatch(/관리자|운영자|기록한|기록 시각/);
    }
    // Owner answer 2026-11-03 (4): a change is a new record — no 철회 or 수정 of one.
    for (const [key, text] of Object.entries(copy).filter(([key]) =>
      key.startsWith('adminMarketJudgementDelay'),
    )) {
      expect(text, key).not.toMatch(/철회|수정/);
    }
    // What the admin words say stays off the public detail is who recorded it and the record's
    // time — never read as the next review time, which is public.
    for (const text of [copy.adminMarketJudgementDelaysIntro, copy.adminMarketJudgementDelayBody]) {
      expect(text).toContain('기록한 관리자와 기록 시각');
    }
    // '갱신 대기' is the same word on both sides (owner answer (2)).
    expect(copy.adminMarketJudgementDelayPassed).toBe(copy.marketNextReviewPassed);
  });

  it('keeps the public rule history to versions, texts and reasons (#80, #172 item 15)', () => {
    // The public 규칙 버전 card names no operator and no 정산 영향 검토 (#173 item 13's analogue):
    // those are the admin panel's words alone.
    const publicKeys = Object.entries(copy).filter(([key]) => key.startsWith('ruleVersion'));
    expect(publicKeys.length).toBeGreaterThan(0);
    for (const [key, text] of publicKeys) {
      expect(text, key).not.toMatch(/관리자|운영자|정산|환불|원금/);
    }
    // The request screen says the boundary (#80 AC 8): a change of meaning goes to the pause.
    expect(copy.adminMarketSupplementBoundary).toContain('거래를 멈추고 검토');
    expect(copy.supplementRejectMeaningChange).toContain('거래를 멈추고 검토');
  });

  it('words 거래·정산 이력 with no refund, no principal and nothing beside a P&L (#124)', () => {
    // N03 §6: a 무효 payout is a payout with its own P&L, not what was paid given back. N04 §3: a
    // P&L is trade accounting — no rank, skill, score or rate of return stands beside one.
    const historyKeys = Object.entries(copy).filter(([key]) => key.startsWith('history'));
    expect(historyKeys.length).toBeGreaterThan(20);
    for (const [key, text] of historyKeys) {
      expect(text, key).not.toMatch(/환불|원금/);
      expect(text, key).not.toMatch(/순위|랭킹|실력|점수|스코어|수익률|승률|적중/);
    }
    // The words the owner fixed (ADR-0135 G1~G3·결과 4) and the issue's own column names.
    expect([copy.historyKindOrders, copy.historyKindFills, copy.historyKindSettlements]).toEqual([
      '주문',
      '체결',
      '정산',
    ]);
    expect([
      copy.historyPeriodAll,
      copy.historyPeriod7d,
      copy.historyPeriod30d,
      copy.historyPeriod90d,
    ]).toEqual(['전체 기간', '최근 7일', '최근 30일', '최근 90일']);
    expect(copy.historyOnlyMarket).toBe('이 시장만 보기');
    expect([
      copy.historySettlementQty,
      copy.historyPayoutPerContract,
      copy.historyPayout,
      copy.historySettlementPnl,
      copy.historyResolvedAt,
      copy.historySettledAt,
    ]).toEqual([
      '정산 때 보유 수량',
      '계약당 지급',
      '지급액',
      '정산 손익',
      '결과 확정',
      '지급 완료',
    ]);
    // The three empty lines: each list's own, and one for a filter that left nothing.
    expect(copy.historyFillsEmpty).toBe('아직 체결 내역이 없습니다.');
    expect(copy.historySettlementsEmpty).toBe('아직 정산 기록이 없습니다.');
    expect(copy.historyFilteredEmpty).toBe('조건에 맞는 기록이 없습니다.');
    // The P&L names the lists draw are names alone.
    for (const name of [copy.positionRealizedPnl, copy.historySettlementPnl]) {
      expect(name).toMatch(/^(실현|정산) 손익$/);
    }
  });

  it('has no empty strings (every key renders something)', () => {
    for (const [key, text] of Object.entries(copy)) {
      expect(text.trim(), key).not.toBe('');
    }
    // The detail header and chart's words (#64, ADR-0135 결정 1의 3·5, ADR-0139): the notice word
    // for word, the badge's period, and the price's name apart from the table column's key.
    expect(copy.marketPriceNotice).toBe('시장가격은 실제 발생 확률의 보장이 아닙니다.');
    expect(copy.marketDelta24h).toBe('24시간');
    expect(copy.marketPriceName).toBe(copy.chartValue);
    expect(copy.chartSummaryLast).toBe('마지막');
    // #64 AC 7: the last fill's price, a fill's price, the average fill price and the two book
    // sides appear together on the detail page, so each carries its own name.
    const priceNames = [
      copy.marketPriceName,
      copy.fillPrice,
      copy.fillAvgPrice,
      copy.marketBookAsks,
      copy.marketBookBids,
    ];
    expect(new Set(priceNames).size).toBe(priceNames.length);
  });

  it('formats Coin via @buddha/shared (workspace wiring)', () => {
    expect(formatCoin(12345n)).toBe('12,345 Coin');
  });
});

describe('safeNextPath', () => {
  it('keeps same-origin paths', () => {
    expect(safeNextPath('/my/settings')).toBe('/my/settings');
    expect(safeNextPath('/markets/abc?x=1')).toBe('/markets/abc?x=1');
  });

  it('rejects absolute and protocol-relative targets', () => {
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
    expect(safeNextPath(undefined, '/x')).toBe('/x');
  });

  it('rejects control characters the URL parser would strip (tab/newline open redirect)', () => {
    // `?next=/%09/evil.com` decodes to '/\t/evil.com', which new URL() resolves to evil.com.
    expect(safeNextPath('/\t/evil.com')).toBe('/');
    expect(safeNextPath('/\n/evil.com')).toBe('/');
    expect(safeNextPath('/\r\n//evil.com')).toBe('/');
    expect(safeNextPath('/my/settings\\..')).toBe('/');
  });

  it('rejects a repeated ?next= (Next hands the page an array, not a string)', () => {
    // `/login?next=/a&next=/b` used to reach next.startsWith() and answer 500.
    expect(safeNextPath(['/a', '/b'])).toBe('/');
    expect(safeNextPath(['/a'], '/x')).toBe('/x');
    expect(safeNextPath([], '/x')).toBe('/x');
  });
});

describe('authErrorMessage', () => {
  it('maps known better-auth codes to Korean copy', () => {
    expect(authErrorMessage({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' })).toBe(
      copy.emailAlreadyUsed,
    );
    expect(authErrorMessage({ code: 'PROVIDER_NOT_FOUND' })).toBe(copy.socialUnavailable);
    expect(authErrorMessage({ code: 'FAILED_TO_UNLINK_LAST_ACCOUNT' })).toBe(copy.unlinkRefused);
  });

  it('never surfaces the English message: unknown codes use the fallback', () => {
    expect(authErrorMessage({ code: 'INVALID_EMAIL', message: 'English text' })).toBe(
      copy.errEmailInvalid,
    );
    expect(authErrorMessage({ code: 'SOMETHING_NEW', message: 'English text' })).toBe(
      copy.errUnknown,
    );
    expect(authErrorMessage({ code: 'SOMETHING_NEW' }, copy.signupFailed)).toBe(copy.signupFailed);
    expect(authErrorMessage({ status: 0, message: 'Failed to fetch' })).toBe(copy.errNetwork);
    expect(authErrorMessage(null)).toBe(copy.errUnknown);
  });
});

describe('authNoticeFor', () => {
  it('reports only the verify-email codes as a broken link', () => {
    expect(authNoticeFor('TOKEN_EXPIRED', copy.socialUnavailable)).toBe(copy.verifyLinkInvalid);
    expect(authNoticeFor('INVALID_TOKEN', copy.linkFailed)).toBe(copy.verifyLinkInvalid);
    expect(authNoticeFor('USER_NOT_FOUND', copy.linkFailed)).toBe(copy.verifyLinkInvalid);
    expect(authNoticeFor('INVALID_USER', copy.linkFailed)).toBe(copy.verifyLinkInvalid);
  });

  it('keeps OAuth failures on the social copy even when the code contains "user"', () => {
    // better-auth's OAuth callback emits these; a substring match on "user" would call them
    // an expired verification link.
    expect(authNoticeFor('unable_to_get_user_info', copy.socialUnavailable)).toBe(
      copy.socialUnavailable,
    );
    expect(authNoticeFor('unable_to_create_user', copy.linkFailed)).toBe(copy.linkFailed);
    expect(
      authNoticeFor(['link', 'account_already_linked_to_different_user'], copy.linkFailed),
    ).toBe(copy.linkAlreadyUsed);
    expect(authNoticeFor(['social', 'TOKEN_EXPIRED'], copy.socialUnavailable)).toBe(
      copy.verifyLinkInvalid,
    );
    expect(authNoticeFor(undefined, copy.linkFailed)).toBeUndefined();
  });
});

describe('fetchOrNetworkError', () => {
  // Without this wrapper better-fetch rejects on a transport failure, and every call site
  // (`const { error } = await ...` inside `void onSubmit(e)`) swallows it silently.
  it('turns a transport rejection into a response the UI can localize', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    try {
      const response = await fetchOrNetworkError('/api/auth/sign-in/email');
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ code: AUTH_ERROR.NETWORK });
      expect(authErrorMessage({ code: AUTH_ERROR.NETWORK, status: 503 })).toBe(copy.errNetwork);
    } finally {
      spy.mockRestore();
    }
  });

  it('re-throws an abort, which is a cancellation and not a network failure', async () => {
    const abort = new DOMException('This operation was aborted', 'AbortError');
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(abort);
    try {
      await expect(fetchOrNetworkError('/api/auth/get-session')).rejects.toBe(abort);
    } finally {
      spy.mockRestore();
    }
  });

  it('passes a real response through with its status and body intact', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"code":"INVALID_EMAIL_OR_PASSWORD"}', { status: 401 }));
    try {
      const response = await fetchOrNetworkError('/api/auth/sign-in/email');
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ code: 'INVALID_EMAIL_OR_PASSWORD' });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('verifyLinkErrorCode', () => {
  // /set-password renders its own notice and forwards the code to /login, so it must pick
  // the code that actually matched rather than whatever came first.
  it('returns the verify-link code better-auth redirects with', () => {
    expect(verifyLinkErrorCode('TOKEN_EXPIRED')).toBe('token_expired');
    expect(verifyLinkErrorCode('INVALID_TOKEN')).toBe('invalid_token');
    expect(verifyLinkErrorCode('USER_NOT_FOUND')).toBe('user_not_found');
    expect(verifyLinkErrorCode(['social', 'TOKEN_EXPIRED'])).toBe('token_expired');
  });

  it('stays undefined for everything that is not a broken link', () => {
    // Unlike authNoticeFor there is no fallback: an unknown code must not paint an alert on
    // a page that still works.
    expect(verifyLinkErrorCode(undefined)).toBeUndefined();
    expect(verifyLinkErrorCode('')).toBeUndefined();
    expect(verifyLinkErrorCode('unable_to_get_user_info')).toBeUndefined();
    expect(verifyLinkErrorCode('social')).toBeUndefined();
  });
});
