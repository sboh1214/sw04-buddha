import {
  CONTRACT_TERMS,
  MARKET_NO_FILL_CANCEL_REASON,
  findExcludedText,
  formatCoin,
  orderQuoteSchema,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { payoutText } from '@/lib/first-order-guide';
import {
  SERVICE_FACTS,
  SERVICE_FACT_KEYS,
  SERVICE_FACT_LIST,
  type ServiceFactKey,
} from './service-facts';

const ALL = SERVICE_FACT_LIST.map((fact) => fact.text);

/** The facts other than `keys`. */
const others = (...keys: ServiceFactKey[]) =>
  SERVICE_FACT_LIST.filter((fact) => !keys.includes(fact.key));

/** The figures a fact may write: the contract's values and the 0 of the fee and of a loss. */
const FIGURES = new Set([
  CONTRACT_TERMS.payoutCoin,
  CONTRACT_TERMS.priceMinCoin,
  CONTRACT_TERMS.priceMaxCoin,
  CONTRACT_TERMS.voidPayoutYesCoin,
  CONTRACT_TERMS.voidPayoutNoCoin,
  0,
]);

/** A count of one contract ('계약 1개', 'YES 1개'): a count, not a figure. */
const ONE_CONTRACT = /(?<!\d)1개/g;

/** '운영 유동성(봇)': the operating market maker's name at its first mention (owner answer 136-1). */
const FIRST_MENTION = '운영 유동성(봇)';

describe('the shared fact sentences (#137, #136)', () => {
  it('are the 32 sentences S01–S32, in order, each once', () => {
    expect(SERVICE_FACT_KEYS).toHaveLength(32);
    expect(new Set(SERVICE_FACT_KEYS).size).toBe(32);
    expect([...SERVICE_FACT_KEYS].sort()).toEqual(Object.keys(SERVICE_FACTS).sort());
    expect(SERVICE_FACT_LIST.map((fact) => fact.id)).toEqual(
      Array.from({ length: 32 }, (_, index) => `S${String(index + 1).padStart(2, '0')}`),
    );
    expect(SERVICE_FACT_LIST.map((fact) => fact.key)).toEqual(SERVICE_FACT_KEYS);
    expect(new Set(ALL).size).toBe(32);
    for (const { id, key, text } of SERVICE_FACT_LIST) {
      expect(text, id).toBe(SERVICE_FACTS[key]);
      // Whole sentences, as written: nothing to fill in and no no-break space.
      expect(text.trim(), id).toBe(text);
      expect(text, id).toMatch(/다\.$/);
      expect(text, id).not.toMatch(/\{\{|\}\}|\u00a0/);
    }
  });

  it('quote the screens word for word where a screen says it first', () => {
    expect(SERVICE_FACTS.operatingLiquidity).toBe(copy.onboardingNoticeCounterparty);
    expect(SERVICE_FACTS.marketPriceNotProbability).toBe(copy.marketPriceNotice);
    expect(SERVICE_FACTS.judgingPrinciple).toBe(copy.judgingPrinciple);
    expect(SERVICE_FACTS.noCashOut).toBe(copy.walletNotice);
    // The first-order guide's payout sentence, its figures kept on their lines there.
    expect(payoutText().replaceAll('\u00a0', ' ')).toContain(SERVICE_FACTS.payout);
  });

  it("use the screens' names for the states, the labels and the limits", () => {
    expect(SERVICE_FACTS.marketPrice).toContain(`'${copy.noFills}'`);
    expect(SERVICE_FACTS.judgingDelay).toContain(`'${copy.marketStatusJudgementDelayed}'`);
    expect(SERVICE_FACTS.resolvedApartFromPaid).toBe(
      `'${copy.marketStatusResolved}'과 '${copy.marketStatusSettled}'는 따로 표시됩니다.`,
    );
    expect(SERVICE_FACTS.provisionalResult).toContain(copy.marketStatusProvisional);
    expect(SERVICE_FACTS.voidResult).toContain(`${copy.marketResultVoid}(VOID)`);
    expect(SERVICE_FACTS.limitOrderExpiry).toContain(copy.orderUnfilledGtc);
    expect(SERVICE_FACTS.regrant).toContain(copy.balance);
    expect(SERVICE_FACTS.limitsAndMonitoring).toContain(copy.reportReasonAbnormalTrading);
    expect(SERVICE_FACTS.limitsAndMonitoring).toContain('주문 속도 제한');
    // The no-fill cancel says what the judging record's system sentence says, and as it does,
    // never hints that accounts other than people's trade (market-cancel.ts).
    expect(MARKET_NO_FILL_CANCEL_REASON).toContain('거래가 끝날 때까지 체결이 한 건도 없');
    expect(SERVICE_FACTS.noFillCancel).toMatch(/^거래가 끝날 때까지 체결이 한 건도 없/);
    expect(SERVICE_FACTS.noFillCancel).not.toMatch(/사용자|사람/);
  });

  it('take every figure from CONTRACT_TERMS (owner answer 133-2)', () => {
    const payout = formatCoin(CONTRACT_TERMS.payoutCoin);
    expect(SERVICE_FACTS.payout).toBe(
      `정답인 계약은 계약마다 ${payout}, 오답인 계약은 ${formatCoin(0)}을 받습니다.`,
    );
    expect(SERVICE_FACTS.priceRange).toContain(
      `${String(CONTRACT_TERMS.priceMinCoin)}–${formatCoin(CONTRACT_TERMS.priceMaxCoin)}`,
    );
    expect(SERVICE_FACTS.pairCollateral).toContain(`쌍마다 ${payout}이 지급 담보로`);
    expect(SERVICE_FACTS.voidResult).toContain(
      `YES·NO 모두 계약마다 ${formatCoin(CONTRACT_TERMS.voidPayoutYesCoin)}을 받으며`,
    );
    // 'YES·NO 모두' holds while VOID pays both sides one figure, together the payout (ADR-0118).
    expect(CONTRACT_TERMS.voidPayoutNoCoin).toBe(CONTRACT_TERMS.voidPayoutYesCoin);
    expect(CONTRACT_TERMS.voidPayoutYesCoin + CONTRACT_TERMS.voidPayoutNoCoin).toBe(
      CONTRACT_TERMS.payoutCoin,
    );
    // The fee is the code's 0: the only value an order's quote may carry (#73 15항).
    expect(SERVICE_FACTS.noFee).toBe(`거래·정산 수수료는 ${formatCoin(0)}입니다.`);
    expect([...orderQuoteSchema.shape.feeCoin.values]).toEqual(['0']);
  });

  it('write no other number: no tick, no percentage, no value an admin sets (137-6 (a))', () => {
    for (const { id, text } of SERVICE_FACT_LIST) {
      const figures = [...text.replace(ONE_CONTRACT, '').matchAll(/\d[\d,]*/g)].map((m) =>
        Number(m[0].replaceAll(',', '')),
      );
      for (const figure of figures) expect(FIGURES, `${id}: ${text}`).toContain(figure);
      expect(text, id).not.toMatch(/\d\s*%/);
    }
    // The price is whole Coin; the 1 Coin tick is not written (137-6 (a)).
    expect(SERVICE_FACTS.priceRange).toContain('정수 Coin');
    for (const text of ALL) expect(text).not.toMatch(/단위|틱|호가 간격/);
  });

  it('send every value an admin sets to the screen (133-2)', () => {
    const shown = '화면에 표시한 값을 따릅니다';
    expect(SERVICE_FACTS.immediateOrder).toContain(`가격 보호 폭은 ${shown}.`);
    expect(SERVICE_FACTS.provisionalResult).toContain(`이의 기간(${shown})`);
    expect(SERVICE_FACTS.startGrant).toContain(`금액은 ${shown}.`);
    expect(SERVICE_FACTS.regrant).toContain(`조건과 금액은 ${shown}.`);
    expect(SERVICE_FACTS.limitsAndMonitoring).toContain('기준 수치는 공개하지 않습니다');
  });

  it("say 확률 only in S14's notice that the market price is no promise of one", () => {
    for (const { id, text } of others('marketPriceNotProbability')) {
      expect(text, id).not.toContain('확률');
    }
    const notice = SERVICE_FACTS.marketPriceNotProbability;
    expect(notice.split('확률')).toHaveLength(2);
    // Allowed everywhere as that notice (TEXT_ALLOWANCES), not as the guide's negative.
    expect(findExcludedText(notice, { features: ['replaced-term'] })).toEqual([]);
  });

  it("call the operating market maker 운영 유동성, '(봇)' at its first mention only (136-1)", () => {
    const joined = ALL.join('\n');
    expect(joined.split(FIRST_MENTION)).toHaveLength(2);
    const first = SERVICE_FACT_LIST.find((fact) => fact.text.includes('운영 유동성'));
    expect(first?.key).toBe('operatingLiquidity');
    expect(first?.text).toContain(FIRST_MENTION);
    expect(SERVICE_FACTS.operatingLiquidityRules).toMatch(/^운영 유동성은/);
    expect(SERVICE_FACTS.lossMoves).toContain('운영 유동성');
    const rest = joined.replace(FIRST_MENTION, '운영 유동성');
    expect(rest).not.toMatch(/봇|마켓\s*메이커|market\s*maker|\bMM\b/i);
  });

  it("hold every excluded feature, with the guide's negative notices allowed (137-4 (a))", () => {
    for (const { id, text } of SERVICE_FACT_LIST) {
      expect(findExcludedText(text, { scope: 'service-guide' }), `${id}: ${text}`).toEqual([]);
    }
    // Why they are a legal body and not screen copy: two say what the product does not offer,
    // which only the service guide may (ADR-0057 결정 1-2).
    const outsideTheGuide = SERVICE_FACT_LIST.filter(
      (fact) => findExcludedText(fact.text).length > 0,
    ).map((fact) => fact.id);
    expect(outsideTheGuide).toEqual(['S01', 'S29']);
  });

  it('speak of Coin only: no paid Coin, no fee to come, no old unit (137-1 (a))', () => {
    for (const { id, text } of SERVICE_FACT_LIST) {
      expect(text, id).not.toMatch(/충전|결제|구매|판매|쿠폰|원화/);
      expect(text, id).not.toMatch(/포인트|\dP|(?<![A-Za-z])P(?![A-Za-z])/);
    }
    for (const { id, text } of others('noFee')) expect(text, id).not.toContain('수수료');
  });
});
