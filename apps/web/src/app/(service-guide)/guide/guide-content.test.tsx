import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_TERMS, findExcludedText, formatCoin } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { SERVICE_FACTS, SERVICE_FACT_LIST } from '@/legal/service-facts';
import { SERVICE_GUIDE_ANCHORS, SERVICE_GUIDE_PATH, serviceGuideHref } from '@/lib/service-guide';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { SERVICE_GUIDE, serviceGuideStrings } from './guide-content';
import ServiceGuidePage, { metadata } from './page';

/**
 * 서비스 안내 (#136, ADR-0177) as the page draws it: the eight sections under their anchors, every
 * fact the 이용약관 shares quoted letter for letter, no number of its own, and the words its owner
 * answers chose. The guard over its sentences — negative notices on this page only — is
 * excluded-features.test.ts's; the visitor's and the member's same HTML, and the entry points,
 * are e2e/service-guide.spec.ts's.
 */

const html = renderWithQueries(<ServiceGuidePage />);
const article = byTestId(html, 'service-guide');
/** What the page reads out: the article's text, tags taken out and entities decoded. */
const TEXT = article?.text ?? '';
const STRINGS = serviceGuideStrings();
/** The sentences in the sections' blocks, in reading order — the prose, without the headings. */
const PROSE = SERVICE_GUIDE.sections.flatMap((section) =>
  serviceGuideStrings({ title: '', intro: [], sections: [{ ...section, heading: '' }] }).filter(
    (text) => text !== '',
  ),
);

/** The figures the page may write: the contract's code-fixed values and the 0 (133-2). */
const FIGURES = new Set([
  CONTRACT_TERMS.payoutCoin,
  CONTRACT_TERMS.priceMinCoin,
  CONTRACT_TERMS.priceMaxCoin,
  CONTRACT_TERMS.voidPayoutYesCoin,
  CONTRACT_TERMS.voidPayoutNoCoin,
  0,
]);

/** A count of one contract ('계약 1개', 'YES 1개'): a count, not a figure (service-facts.test.ts). */
const ONE_CONTRACT = /(?<!\d)1개/g;

/** '운영 유동성(봇)': the name's first mention in the text (owner answer 136-1). */
const FIRST_MENTION = '운영 유동성(봇)';

const DIR = path.dirname(fileURLToPath(import.meta.url));

describe('서비스 안내 (#136)', () => {
  it('is at /guide, titled 서비스 안내, with its eight sections in order under their anchors', () => {
    expect(SERVICE_GUIDE_PATH).toBe('/guide');
    expect(serviceGuideHref()).toBe('/guide');
    expect(serviceGuideHref('judgement')).toBe('/guide#judgement');
    expect(metadata.title).toBe(`${copy.serviceGuideTitle} | ${copy.appName}`);
    expect(article).toBeDefined();
    expect(byTagName(html, 'h2').map((heading) => heading.text)).toEqual([copy.serviceGuideTitle]);
    expect(SERVICE_GUIDE_ANCHORS).toEqual([
      'contract',
      'collateral',
      'orders',
      'market-price',
      'liquidity',
      'judgement',
      'void-cancel',
      'coin',
    ]);
    expect(SERVICE_GUIDE.sections.map((section) => section.anchor)).toEqual(SERVICE_GUIDE_ANCHORS);
    expect(
      testIdsStartingWith(html, 'service-guide-').filter((id) => id !== 'service-guide-terms-link'),
    ).toEqual(SERVICE_GUIDE_ANCHORS.map((anchor) => `service-guide-${anchor}`));
    expect(byTagName(html, 'h3').map((heading) => heading.text)).toEqual([
      copy.serviceGuideContractTitle,
      copy.serviceGuideCollateralTitle,
      copy.serviceGuideOrdersTitle,
      copy.serviceGuideMarketPriceTitle,
      copy.serviceGuideLiquidityTitle,
      copy.serviceGuideJudgementTitle,
      copy.serviceGuideVoidCancelTitle,
      copy.serviceGuideCoinTitle,
    ]);
    for (const anchor of SERVICE_GUIDE_ANCHORS) {
      const section = byTestId(html, `service-guide-${anchor}`);
      // The anchor is the section's own id, and the section is named by its heading.
      expect(html, anchor).toMatch(new RegExp(`<section\\b[^>]*\\sid="${anchor}"`));
      expect(section?.attributes['aria-labelledby'], anchor).toBe(`${anchor}-heading`);
      expect(section?.text.trim(), anchor).not.toBe('');
    }
  });

  it('says it is a summary whose rights and duties follow the 이용약관, and links it (136-3)', () => {
    expect(SERVICE_GUIDE.intro[0]).toBe(copy.serviceGuideIntro);
    expect(copy.serviceGuideIntro).toContain('요약합니다');
    expect(copy.serviceGuideIntro).toContain(`권리와 의무는 ${copy.legalTermsTitle}을 따릅니다`);
    const link = byTestId(html, 'service-guide-terms-link');
    expect(link?.attributes.href).toBe('/terms');
    expect(link?.text).toBe(copy.serviceGuideTermsLink);
    // A value an admin sets is the screen's (133-2), named without a figure.
    expect(copy.serviceGuideIntroSettings).toContain('화면에 표시한 값을 따릅니다');
    // Not a consent item (#57-5): nothing on the page asks for one.
    expect(TEXT).not.toMatch(/동의/);
  });

  it('quotes every fact it shares with the 이용약관 letter for letter (S01–S32)', () => {
    expect(SERVICE_FACT_LIST).toHaveLength(32);
    for (const { id, text } of SERVICE_FACT_LIST) {
      expect(
        STRINGS.filter((string) => string === text),
        id,
      ).toHaveLength(1);
      expect(TEXT, id).toContain(text);
    }
    // The figures come from CONTRACT_TERMS through them.
    expect(TEXT).toContain(`계약마다 ${formatCoin(CONTRACT_TERMS.payoutCoin)}`);
    expect(TEXT).toContain(
      `YES·NO 모두 계약마다 ${formatCoin(CONTRACT_TERMS.voidPayoutYesCoin)}을 받으며`,
    );
    expect(TEXT).toContain(
      `${String(CONTRACT_TERMS.priceMinCoin)}–${formatCoin(CONTRACT_TERMS.priceMaxCoin)}`,
    );
  });

  it('writes no number of its own: only the contract values, no %, no setting (133-2, 137-6 (a))', () => {
    for (const text of [...STRINGS, TEXT]) {
      const figures = [...text.replace(ONE_CONTRACT, '').matchAll(/\d[\d,]*/g)].map((match) =>
        Number(match[0].replaceAll(',', '')),
      );
      for (const figure of figures) expect(FIGURES, text).toContain(figure);
      // No example percentage, no opening reference, no setting's figure.
      expect(text).not.toMatch(/\d\s*%/);
    }
    // The guide's own copy carries no digit at all: every figure is a shared sentence's.
    for (const [key, value] of Object.entries(copy)) {
      if (key.startsWith('serviceGuide')) expect(value, key).not.toMatch(/\d/);
    }
    // The tick is whole Coin, not a figure; no hours, no processing target (133-6, 133-30).
    expect(TEXT).not.toMatch(/틱|호가 간격|영업일|운영 시간|이내 처리|처리 목표|처리 기한/);
    expect(TEXT).toContain(SERVICE_FACTS.limitsAndMonitoring);
  });

  it('offers nothing to buy (N06) and calls no payout a refund (N03 §6)', () => {
    expect(TEXT).not.toMatch(/구매|충전|결제|가격표|쿠폰|원화|판매/);
    // '환불' only as 'not a refund'.
    expect(TEXT.split('환불')).toHaveLength(TEXT.split('환불이 아니').length);
    expect(TEXT).toContain('원금 환불이 아니고');
    // The fee is the code's 0, with no fee to come (137-1).
    const fees = STRINGS.filter((text) => text.includes('수수료'));
    expect(fees).toEqual([SERVICE_FACTS.noFee]);
  });

  it("calls the operating market maker 운영 유동성, '(봇)' at its first mention in the text (136-1)", () => {
    expect(TEXT.split(FIRST_MENTION)).toHaveLength(2);
    const first = PROSE.find((text) => text.includes('운영 유동성'));
    expect(first).toBe(SERVICE_FACTS.operatingLiquidity);
    expect(first).toContain(FIRST_MENTION);
    expect(copy.serviceGuideLiquidityTitle).toBe('운영 유동성');
    expect(TEXT.replace(FIRST_MENTION, '')).not.toMatch(/봇|마켓\s*메이커|market\s*maker|\bMM\b/i);
    // It may be a counterparty, and which markets it trades in is not said (ADR-0058 1-20).
    const liquidity = byTestId(html, 'service-guide-liquidity')?.text ?? '';
    expect(liquidity).toContain(SERVICE_FACTS.operatingLiquidity);
    expect(liquidity).toContain(copy.serviceGuideLiquidityHidden);
    // Left out of the participant count, not of the volume (ADR-0107 결정 1 #177 12항) — under the
    // members' label '참여자', not the admin detail's '참여자 수'.
    expect(copy.serviceGuideLiquidityCounts).toContain(`'${copy.marketTraders}'`);
    expect(copy.serviceGuideLiquidityCounts).not.toContain(copy.marketTraderCount);
    expect(copy.serviceGuideLiquidityCounts).toContain(
      '거래량에는 운영 유동성과의 체결도 들어갑니다',
    );
  });

  it('never calls the market price a probability or a belief but in a negative notice (N02 §5, N00 §4)', () => {
    expect(TEXT).not.toMatch(/예측|투표하|투표를/);
    for (const text of STRINGS) {
      // Whatever it names, it is a notice that this page alone may say (ADR-0057 결정 1-2)…
      expect(findExcludedText(text, { scope: 'service-guide' }), text).toEqual([]);
      // …and never a gambling word, here neither (D21).
      expect(findExcludedText(text, { features: ['gambling'] }), text).toEqual([]);
    }
    const probability = STRINGS.filter((text) => text.includes('확률'));
    expect(probability).toEqual([
      SERVICE_FACTS.marketPriceNotProbability,
      copy.serviceGuideNotBelief,
      copy.serviceGuideOpeningSetting,
    ]);
    for (const text of probability) expect(text).toMatch(/아닙니다\.$/);
    // No '추천' explanation (ADR-0065 #4, ADR-0135 결정 1의 9).
    expect(TEXT).not.toContain(copy.sortRecommended);
  });

  it('labels the states as the screens do, VOID as 무효 (ADR-0093 결정 1 #173 12항)', () => {
    const table = SERVICE_GUIDE.sections
      .find((section) => section.anchor === 'judgement')
      ?.blocks.find((block) => block.kind === 'table');
    expect(table?.kind === 'table' ? table.rows.map(([name]) => name) : []).toEqual([
      copy.marketStatusScheduled,
      copy.marketStatusOpen,
      copy.marketStatusPaused,
      copy.marketStatusClosed,
      copy.marketStatusProvisional,
      copy.marketStatusDisputeUnderReview,
      copy.marketStatusJudgementDelayed,
      copy.marketStatusResolved,
      copy.marketStatusSettling,
      copy.marketStatusSettled,
      copy.marketStatusCancelled,
    ]);
    expect(copy.serviceGuideVoidLabel).toContain(`'${copy.marketResultVoid}'`);
    expect(copy.serviceGuideNoQuote).toContain(`'${copy.marketBookEmpty}'`);
    expect(copy.serviceGuideQuote).toContain(copy.orderQuoteNotice);
    expect(copy.serviceGuideOrderSteps).toContain(`${copy.orderKindIoc}·${copy.orderKindGtc}`);
    expect(copy.serviceGuideImmediateLimits).toContain(`'${copy.orderMaxBuyPrice}'`);
    expect(copy.serviceGuideImmediateLimits).toContain(`'${copy.orderMinSellPrice}'`);
    expect(copy.serviceGuideCloseVsJudgement).toContain(`'${copy.rulesCloseAt}'`);
    expect(copy.serviceGuideCloseVsJudgement).toContain(`'${copy.rulesJudgementAt}'`);
    expect(copy.serviceGuideBuyWithinBalance).toContain(`'${copy.balance}'`);
    // The three prices under the labels members see: the holding row's, the book's, the order's.
    expect(copy.serviceGuidePriceLast.startsWith(`${copy.positionCurrentPrice}: `)).toBe(true);
    expect(copy.serviceGuidePriceAverage.startsWith(`${copy.orderAvgPrice}: `)).toBe(true);
    // The absent features are said here only (ADR-0057 결정 1-2): no score, no rank, no prize.
    expect(TEXT).toContain(copy.serviceGuideNoScore);
  });

  it('is the same page for every visitor: no session, no cookie, no API, no client code', () => {
    expect(renderWithQueries(<ServiceGuidePage />)).toBe(html);
    for (const name of ['page.tsx', 'guide-view.tsx', 'guide-content.ts']) {
      const source = readFileSync(path.join(DIR, name), 'utf8');
      expect(source, name).not.toMatch(/^\s*['"]use client['"]/m);
      expect(source, name).not.toMatch(
        /next\/headers|cookies\(|use-me|use-session|useSession|session\.server|api\.server|@\/lib\/api'|fetch\(/,
      );
    }
    // Nothing of an account: no nickname, no email, no balance figure.
    expect(TEXT).not.toMatch(/@|user_/);
  });
});
