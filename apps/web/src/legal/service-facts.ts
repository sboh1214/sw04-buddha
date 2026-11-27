import { CONTRACT_TERMS, formatCoin } from '@buddha/shared';

/**
 * The shared fact sentences (#137, #136): what the 이용약관 and the service guide (/guide) both
 * say of how the service works, written once so the two never say it differently. Each document
 * quotes them letter for letter, and each document's test checks that every one is there. They
 * are numbered S01–S32 in the order of `SERVICE_FACT_KEYS`. The owner answers named below are of
 * 2026-11-27 (137-x, 136-x) and of 2026-11-25 (133-x, ADR-0171).
 *
 * - **Numbers.** Only the contract's code-fixed values (owner answer 133-2, ADR-0171) are figures:
 *   the payout, the price range and VOID's split from `CONTRACT_TERMS`, and the 0 of the fee and
 *   of a losing contract. The tick is not (137-6 (a)). A value an admin changes (시작 지급액,
 *   재지급, 이의 기간, 가격 보호 폭) is '화면에 표시한 값을 따릅니다', and an internal one (주문 속도
 *   제한, 이상 거래) is only said to exist (133-30). A changed figure changes the 이용약관's text,
 *   and so its version.
 * - **Words.** The operating market maker is '운영 유동성', and '운영 유동성(봇)' the first time
 *   (S11, the onboarding notice's words); never its admin name (136-1). The market price is never
 *   called a probability, except in S14's notice that it is no promise of one. No sentence speaks
 *   of a fee to come (137-1 (a)): the fee is the code's 0 (ADR-0107 결정 2 #73 15항).
 * - **Guard.** S01 ('투표가 아닙니다') and S29 ('…송금은 없습니다') say what the product does not
 *   offer, which only the service guide may (ADR-0057 결정 1-2). So this file is a legal body
 *   (`LEGAL_BODIES`, test/screen-text.ts), and its unit test holds the sentences to every excluded
 *   feature with the guide's negative notices allowed (137-4 (a)).
 *
 * A sentence only one document says stays in it: the guide's in its own copy, the 이용약관's (no
 * Coin sales today, no expiry, the transitional clause) in terms.ts.
 */

export const SERVICE_FACTS = {
  /** S01 (NR). */
  contractChoice: 'YES/NO 선택은 거래할 계약의 선택이며 투표가 아닙니다.',
  /** S02 (NR). */
  eventContract: '계약은 결과에 따라 지급되는 사건 계약입니다.',
  /** S03: the first-order guide's sentence (`payoutText`), 정답·오답 (owner decision #14-5). */
  payout: `정답인 계약은 계약마다 ${formatCoin(CONTRACT_TERMS.payoutCoin)}, 오답인 계약은 ${formatCoin(0)}을 받습니다.`,
  /** S04: the price range in whole Coin, without the tick (137-6 (a)). */
  priceRange: `가격은 계약 1개에 ${String(CONTRACT_TERMS.priceMinCoin)}–${formatCoin(CONTRACT_TERMS.priceMaxCoin)}이고, 정수 Coin으로만 정합니다.`,
  /** S05 (N01 §3). */
  pairCollateral: `계약은 YES 1개와 NO 1개가 한 쌍으로 생기며, 그때 쌍마다 ${formatCoin(CONTRACT_TERMS.payoutCoin)}이 지급 담보로 잠깁니다.`,
  /** S06 (N01 §3). */
  noLeverage: '레버리지·대출·무담보 공매도는 제공하지 않으며, 매도는 보유한 계약으로만 합니다.',
  /** S07 (N02 §1). */
  holdingByFill: '주문이 체결되어야 계약을 보유합니다. 주문만 낸 상태는 보유가 아닙니다.',
  /** S08: all of an immediate order's unfilled rest is cancelled (orderEndState; #177 2·8항). */
  immediateOrder:
    '즉시 거래는 확인 화면에 표시한 가격 한도 안에서 지금 체결할 수 있는 만큼만 체결하고, 남은 수량은 바로 취소합니다. 가격 보호 폭은 화면에 표시한 값을 따릅니다.',
  /** S09 (N02 §6). */
  limitOrderExpiry: '지정가 주문의 체결되지 않은 수량은 시장 마감 때 만료됩니다.',
  /** S10 (ADR-0093 결정 1 #173 3항; ADR-0107 결정 4 #119·#178). */
  waitingOrdersCancelled:
    '시장 거래가 일시 중단되거나 계정이 제한되거나 탈퇴하면 기다리던 주문은 취소되고 잠금이 풀립니다. 원장 장애로 멈춘 시장의 주문은 복구한 뒤 처리합니다.',
  /** S11: the onboarding notice (`copy.onboardingNoticeCounterparty`, #57-10), the first mention. */
  operatingLiquidity: '거래할 때 운영 유동성(봇)이 거래 상대가 될 수 있습니다.',
  /** S12 (N01 §5): one matching rule; bot-to-bot fills never happen (sameSelfTradeGroup). */
  operatingLiquidityRules:
    '운영 유동성은 회원 주문과 같은 규칙으로 체결하며, 체결 상대는 익명으로 표시됩니다.',
  /** S13: the market price's definition (ADR-0107 결정 4 #121; ADR-0061 결정 1 2항). */
  marketPrice:
    "시장가격은 마지막 체결의 YES 기준 가격을 지급액에 대한 %로 나타낸 값이며, 그 체결의 시각을 함께 표시합니다. 첫 체결 전에는 '체결 없음'으로 표시합니다.",
  /** S14: the market detail's notice (`copy.marketPriceNotice`, N02 §5). */
  marketPriceNotProbability: '시장가격은 실제 발생 확률의 보장이 아닙니다.',
  /** S15: the code's 0 — the quote's `feeCoin` and the fills' CHECK (ADR-0107 결정 2 #73 15항). */
  noFee: `거래·정산 수수료는 ${formatCoin(0)}입니다.`,
  /** S16: without exception (ADR-0093 결정 1 #173 4항). */
  noReopen: '거래가 마감된 시장은 다시 열지 않습니다.',
  /** S17: the judging record's principle (`copy.judgingPrinciple`, ADR-0107 결정 4 #24). */
  judgingPrinciple: '판정은 규칙의 출처와 증거로 하며 시장가격이나 다수 의견으로 정하지 않습니다.',
  /** S18 (N03 §4; ADR-0093 결정 1 #173 11항). */
  judgingDelay:
    "예정한 판정 시각이 지나도 결과가 없으면 '판정 지연'으로 표시하며, 늦었다는 이유만으로 NO로 판정하지 않습니다.",
  /** S19: another admin approves; an admin never orders while holding the role (#173 1·15항). */
  judgingApproval:
    '판정은 등록한 관리자와 다른 관리자가 승인합니다. 관리자는 관리자 권한이 있는 동안 어느 시장에서도 주문할 수 없습니다.',
  /** S20 (N03 §5; ADR-0093 결정 1 #173 5·6항). */
  provisionalResult:
    '판정은 먼저 잠정 결과로 공개됩니다. 이의 기간(화면에 표시한 값을 따릅니다) 동안 그 시장에서 체결한 적이 있는 회원은 근거 링크와 사유를 붙여 판정 이의를 낼 수 있고, 이의를 검토하는 동안에는 지급하지 않습니다.',
  /** S21 (ADR-0093 결정 1 #173 12항). */
  resolvedApartFromPaid: "'결과 확정'과 '지급 완료'는 따로 표시됩니다.",
  /** S22: corrected only while provisional (ADR-0093 결정 1 #173 5·8항). */
  provisionalCorrection:
    '잠정 결과 동안 판정 오류가 확인되면 잠정 결과를 정정하고, 처음과 같은 길이의 이의 기간을 다시 줍니다.',
  /** S23: an error after the result is final (N03 §7; ADR-0165, ADR-0166). */
  resolvedError:
    '결과가 확정된 뒤 판정 오류가 확인되면 지급한 Coin을 회수하지 않고 잔액을 음수로 만들지 않으며, 정정 기록을 공개하고 별도로 승인된 보상으로 처리합니다.',
  /** S24: VOID pays both sides one figure (ADR-0093 결정 1 #173 9항, ADR-0118). */
  voidResult: `무효(VOID)도 잠정 결과와 이의 기간을 거쳐 확정됩니다. 무효로 끝나면 YES·NO 모두 계약마다 ${formatCoin(CONTRACT_TERMS.voidPayoutYesCoin)}을 받으며, 이는 원금 환불이 아니고 매입가에 따라 손익이 생깁니다.`,
  /** S25: the no-fill cancel (MARKET_NO_FILL_CANCEL_REASON's words; #173 10항, ADR-0117). */
  noFillCancel:
    '거래가 끝날 때까지 체결이 한 건도 없던 시장은 결과를 정하지 않고 취소로 끝나며, 남은 주문은 만료되고 잠긴 Coin이 풀립니다. 취소는 무효가 아닙니다.',
  /** S26 (#57-1). */
  startGrant:
    '시작 Coin은 본인확인한 휴대전화 번호마다 한 번 받고, 금액은 화면에 표시한 값을 따릅니다.',
  /** S27: the re-grant's conditions (ADR-0155). */
  regrant:
    '가용 코인이 기준액 이하로 줄면 재지급을 신청할 수 있습니다. 대기 중인 주문이나 정산 전 보유 계약이 있으면 받을 수 없고, 조건과 금액은 화면에 표시한 값을 따릅니다.',
  /** S28: the wallet's notice (`copy.walletNotice`, N01 §2). */
  noCashOut: 'Coin의 현금 환전·출금은 제공하지 않습니다.',
  /** S29 (N01 §2). */
  noRewardOrTransfer: '출석·거래량·주문 횟수에 따른 보상과 회원 사이의 Coin 송금은 없습니다.',
  /** S30: a loss moves; only the closure's forfeit burns (ADR-0107 결정 2 #73 16항). */
  lossMoves:
    '거래에서 잃은 Coin은 거래 상대(다른 회원이나 운영 유동성)에게 옮겨 가며, 자동으로 소각되지 않습니다.',
  /** S31 (N02 §8; N04 §4). */
  grantsNotProfit: '시작 지급과 재지급은 거래 수익으로 세지 않습니다.',
  /** S32: the limits exist, their numbers are not published (133-30). */
  limitsAndMonitoring: '주문 속도 제한과 이상 거래 감시가 있으며, 기준 수치는 공개하지 않습니다.',
} as const satisfies Readonly<Record<string, string>>;

export type ServiceFactKey = keyof typeof SERVICE_FACTS;

/** The sentences in order: S01 is the first, S32 the last. */
export const SERVICE_FACT_KEYS = [
  'contractChoice',
  'eventContract',
  'payout',
  'priceRange',
  'pairCollateral',
  'noLeverage',
  'holdingByFill',
  'immediateOrder',
  'limitOrderExpiry',
  'waitingOrdersCancelled',
  'operatingLiquidity',
  'operatingLiquidityRules',
  'marketPrice',
  'marketPriceNotProbability',
  'noFee',
  'noReopen',
  'judgingPrinciple',
  'judgingDelay',
  'judgingApproval',
  'provisionalResult',
  'resolvedApartFromPaid',
  'provisionalCorrection',
  'resolvedError',
  'voidResult',
  'noFillCancel',
  'startGrant',
  'regrant',
  'noCashOut',
  'noRewardOrTransfer',
  'lossMoves',
  'grantsNotProfit',
  'limitsAndMonitoring',
] as const satisfies readonly ServiceFactKey[];

export interface ServiceFact {
  /** 'S01'…'S32'. */
  readonly id: string;
  readonly key: ServiceFactKey;
  readonly text: string;
}

/** Every sentence with its number, in order. */
export const SERVICE_FACT_LIST: readonly ServiceFact[] = SERVICE_FACT_KEYS.map((key, index) => ({
  id: `S${String(index + 1).padStart(2, '0')}`,
  key,
  text: SERVICE_FACTS[key],
}));
