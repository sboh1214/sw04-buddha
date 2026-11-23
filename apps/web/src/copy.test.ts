import {
  CONTRACT_TERMS,
  PAYOUT_PER_CONTRACT_COIN,
  findExcludedText,
  formatCoin,
} from '@buddha/shared';
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

  it('words the 판정 정정 as 144-19 approved it, with no refund, no 정답 and no amount (#144)', () => {
    // Public (144-5, 144-9, 144-19): the section, its two results, 144-5's fact, the detail's
    // mark and settled sentence, and the 결과 확정 뒤 report line (its address filled from the
    // business info, as the appeal guidance's).
    expect([
      copy.judgingCorrection,
      copy.marketResultCorrected,
      copy.judgingCorrectedResult,
      copy.judgingOriginalResult,
      copy.judgingCorrectionNoClawback,
    ]).toEqual([
      '판정 정정',
      '판정 정정',
      '정정된 결과',
      '원래 결과',
      '원래 결과로 지급했고, 지급한 Coin은 회수하지 않습니다.',
    ]);
    expect(copy.marketSettledCorrected).toBe(
      '원래 결과({paid})로 지급했고, 지급한 Coin은 회수하지 않습니다. 판정 정정은 판정 기록에서 볼 수 있습니다.',
    );
    expect(copy.judgingPostPayoutReport.replace('({{email}})', '')).toBe(
      '결과 확정 뒤의 판정 오류는 고객센터 이메일로 알려 주세요.',
    );
    // Admin (144-19): 판정 오류 사건 apart from #176's 판정 정정, and 144-13's disabled line.
    expect([
      copy.adminMarketJudgementIncident,
      copy.adminMarketJudgementIncidentRegister,
      copy.adminMarketJudgementIncidentCorrectedResult,
      copy.adminMarketJudgementIncidentDescription,
      copy.adminMarketJudgementIncidentEvidence,
      copy.adminMarketJudgementIncidentConfirm,
      copy.adminMarketJudgementIncidentDismiss,
      copy.adminMarketJudgementIncidentRetract,
      copy.adminMarketJudgementIncidentConfirmWaits,
    ]).toEqual([
      '판정 오류 사건',
      '사건 등록',
      '올바른 결과',
      '오류 내용',
      '근거',
      '오류 확인',
      '기각',
      '철회',
      '지급이 끝난 뒤 확인할 수 있습니다.',
    ]);
    // 144-19 (다).
    expect(copy.adminRelatedHintHiddenResultTail).toContain('(정정된 결과 포함)');
    for (const text of [
      copy.judgingCorrectionNoClawback,
      copy.marketSettledCorrected,
      copy.judgingPostPayoutReport,
      copy.adminMarketJudgementIncidentIntro,
      copy.adminMarketJudgementIncidentConfirmBody,
      copy.errMarketJudgementIncidentNoDecider,
    ]) {
      expect(text).not.toMatch(
        /환불|원금|정답|맞힌|정산 오류|보상|송금|이체|리워드|적립|\d+ Coin씩/,
      );
    }
    // 사건 등록's no_decider names the 144-4 exclusion too, not a conflict alone (the judgement's).
    expect(copy.errMarketJudgementIncidentNoDecider).not.toBe(copy.marketConflictNoDecider);
    expect(copy.errMarketJudgementIncidentNoDecider).toContain('지급한 판정을 등록한 관리자');
  });

  it('words the 판정 오류 보상 as 144-15·144-18·144-19 approved, with no refund, P&L or 정답 (#144)', () => {
    // Public (144-6, 144-15): the 보상 line's four states, the closed targets counted apart.
    expect([
      copy.judgingCompensationPreparing,
      copy.judgingCompensationNone,
      copy.judgingCompensationPending,
      copy.judgingCompensationPaid,
      copy.judgingCompensationPaidPartly,
    ]).toEqual([
      '보상 준비 중',
      '보상 대상 없음',
      '승인 대기 · 대상 계정 {n}개',
      '지급 완료 · 대상 계정 {n}개 · 총 {coin}',
      '지급 완료 · 대상 계정 {n}개 중 {m}개 지급 · 총 {coin}',
    ]);
    // Member (144-10, 144-11, 144-17, 144-18, 144-19): the wallet's kind, the recap's lines, MY
    // 정산 이력's mark and the notification.
    expect(copy.ledgerTypeJudgementCompensation).toBe('판정 오류 보상');
    expect([
      copy.recapCorrection,
      copy.recapCorrectedResult,
      copy.recapCompensationAmount,
      copy.recapCompensationNone,
      copy.recapCompensationPending,
      copy.recapCompensationPreparing,
      copy.recapJudgingRecord,
    ]).toEqual([
      '판정 정정',
      '정정된 결과 {result}',
      '내 보상 {coin}',
      '보상 없음',
      '보상 승인 대기',
      '보상 준비 중',
      '판정 기록 보기',
    ]);
    expect(copy.historySettlementCorrected).toBe('판정 정정 · 결과 {result}');
    expect(copy.notificationJudgementCompensated).toBe(
      '{market} 판정 정정 · 결과를 {result}로 바로잡고 {coin}을 보상했습니다.',
    );
    // Admin (144-19): the approved words.
    expect([
      copy.adminMarketJudgementCompensationRequest,
      copy.adminMarketJudgementCompensationUserReason,
      copy.adminMarketJudgementCompensationApprove,
      copy.adminMarketJudgementCompensationReject,
      copy.adminMarketJudgementCompensationRecipients,
      copy.adminMarketJudgementCompensationStateClosed,
      copy.adminMarketJudgementCompensationStateBlocked,
    ]).toEqual([
      '보상 요청',
      '회원에게 보일 사유',
      '보상 승인',
      '보상 반려',
      '대상 계정',
      '탈퇴로 지급 못 함',
      '원장 확인 필요',
    ]);
    // The queue intro bars the paid registrant from 보상 승인 alone; 보상 반려 is a 정리 목적의
    // 반려 any admin but the requester may give (ADR-0120 decision 5, panel registrant note).
    const [approveRule, rejectRule] = copy.adminMarketJudgementCompensationQueueIntro
      .split('. ')
      .slice(1);
    expect(approveRule).toMatch(/지급한 판정을 등록하지도 않은 관리자가 .*보상 승인합니다$/);
    expect(approveRule).not.toMatch(/반려/);
    expect(rejectRule).toBe('보상 반려는 요청한 관리자가 아니면 할 수 있습니다.');
    expect(rejectRule).not.toMatch(/지급한 판정/);
    // Every new 보상·지급 string passes the excluded words (활동·접속·글… never before 보상·지급).
    const texts = Object.entries(copy).filter(
      ([key]) =>
        key.startsWith('adminMarketJudgementCompensation') ||
        key.startsWith('errMarketJudgementCompensation') ||
        key.startsWith('adminMarketWorkCompensation') ||
        key.startsWith('judgingCompensation') ||
        key.startsWith('recapC') ||
        [
          'recapJudgingRecord',
          'historySettlementCorrected',
          'ledgerTypeJudgementCompensation',
          'notificationJudgementCompensated',
        ].includes(key),
    );
    expect(texts.length).toBeGreaterThan(90);
    for (const [key, text] of texts) {
      expect(findExcludedText(text), key).toEqual([]);
      expect(text, key).not.toMatch(
        /환불|원금|송금|이체|리워드|적립|정산 오류|손익|정답|맞힌|\d+ Coin씩|수익률|순위|점수/,
      );
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

  it('words the 커뮤니티 알림 with no score, rank or reward, and never the reporter or the operator (#135)', () => {
    // N05 §2, N04 §4, #135 AC 5: a merged count of replies is never a score or a skill, and no
    // reward sits near a reply; #45 13항, 135-2: what an action names is its kind and end alone.
    const notices = Object.entries(copy).filter(
      ([key]) =>
        key.startsWith('notificationPostReplied') ||
        key.startsWith('notificationCommentReplied') ||
        key === 'notificationReplyAuthorAdmin' ||
        key.startsWith('notificationModeration') ||
        key.startsWith('notificationRestriction') ||
        key === 'notificationProposalDecided',
    );
    expect(notices).toHaveLength(15);
    for (const [key, text] of notices) {
      expect(text, key).not.toMatch(
        /점수|순위|랭킹|실력|평판|등급|스코어|보상|보너스|지급|배지|예측|좋아요/,
      );
      expect(text, key).not.toMatch(/신고|관리자|사유|처리한/);
      // '운영자' only as the tag on an admin replier's own nickname (#45-9).
      if (text.includes('운영자')) expect(key).toBe('notificationReplyAuthorAdmin');
    }
  });

  it('words 알림 수신 as the owner approved, with no channel, price item, lock or reward (#56)', () => {
    // 56-5: the §6 table as written, the link '정산 기록 보기'; 56-3: the owner's sentence and a
    // period. #56 AC 9 (N05 §4, N04 §7, N06): no channel choice and no price or score item; 52-21
    // locks nothing; 52-20/52-23 leave 지급 후 보상 to #144.
    expect(copy.settingsNotifications).toBe('알림 수신');
    expect(copy.notificationsSettingsLink).toBe('수신 설정');
    expect(copy.notificationSettingsHistoryNote).toBe(
      '알림을 꺼도 정산 기록은 MY 거래·정산 이력에서 볼 수 있습니다.',
    );
    expect(copy.notificationSettingsHistoryLink).toBe('정산 기록 보기');
    expect([copy.notificationSettingOn, copy.notificationSettingOff]).toEqual([
      '{label}을 켰습니다.',
      '{label}을 껐습니다.',
    ]);
    const settings = Object.entries(copy).filter(
      ([key]) =>
        key.startsWith('settingsNotifications') ||
        key.startsWith('notificationSetting') ||
        key === 'errNotificationSetting' ||
        key === 'notificationsSettingsLink',
    );
    expect(settings).toHaveLength(14);
    for (const [key, text] of settings) {
      expect(text, key).not.toMatch(
        /이메일|푸시|채널|가격|점수|순위|랭킹|Forecast|구매|충전|결제|보상|필수|잠금|잠그|끌 수 없|배지/,
      );
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
