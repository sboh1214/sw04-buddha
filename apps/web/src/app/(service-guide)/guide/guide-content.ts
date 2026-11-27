import { copy } from '@/copy';
import { type LegalBlock, type LegalListItem, bullets, paragraph, table } from '@/legal/document';
import { SERVICE_FACTS as S } from '@/legal/service-facts';
import { SERVICE_GUIDE_ANCHORS, type ServiceGuideAnchor } from '@/lib/service-guide';

/**
 * 서비스 안내 (#136, ADR-0177) as data: the title, the head and the eight sections, each under the
 * anchor `lib/service-guide.ts` names. Every fact the 이용약관 states too is quoted letter for
 * letter from the shared sentences (`SERVICE_FACTS`, S01–S32 — legal/service-facts.ts), so the two
 * documents never say it differently; what only the guide says is its own copy
 * (`copy.serviceGuide*`). The guide is a summary: rights and duties follow the 이용약관 (owner answer
 * 136-3), and it is no consent item (#57-5).
 *
 * - **Numbers.** None of its own. The figures on the page are the shared sentences' — the
 *   contract's code-fixed values from `CONTRACT_TERMS` and the 0 of the fee and of a losing
 *   contract (133-2) — and a value an admin sets is '화면에 표시한 값을 따릅니다'. The tick and the
 *   opening reference are code-fixed too but not written as figures (137-6 (a)); the limits and
 *   the monitoring are only said to exist (133-30); no hours and no processing targets (133-6).
 * - **Words.** The operating market maker is '운영 유동성', '운영 유동성(봇)' at its first mention in
 *   the text — S11, the first sentence of its section (136-1). 확률·투표 stand in negative notices
 *   only, which this page alone may say (ADR-0057 결정 1-2): it lives under `app/(service-guide)`.
 *   No paid Coin, no '추천' explanation (ADR-0065 #4), no per-market participation of the operating
 *   liquidity (ADR-0058 1-20).
 *
 * The same for every visitor: nothing here reads a session, a cookie or the API, and the page is
 * prerendered at build time.
 */

export interface ServiceGuideSection {
  readonly anchor: ServiceGuideAnchor;
  readonly heading: string;
  readonly blocks: readonly LegalBlock[];
}

export interface ServiceGuide {
  readonly title: string;
  /** Under the title: the summary and its relation to the 이용약관 (136-3), then the settings. */
  readonly intro: readonly string[];
  readonly sections: readonly ServiceGuideSection[];
}

/** The market states as the screens label them (ADR-0093 결정 1 #173 12항), with what each means. */
const STATUS_ROWS: readonly (readonly [string, string])[] = [
  [copy.marketStatusScheduled, copy.serviceGuideStatusScheduled],
  [copy.marketStatusOpen, copy.serviceGuideStatusOpen],
  [copy.marketStatusPaused, copy.serviceGuideStatusPaused],
  [copy.marketStatusClosed, copy.serviceGuideStatusClosed],
  [copy.marketStatusProvisional, copy.serviceGuideStatusProvisional],
  [copy.marketStatusDisputeUnderReview, copy.serviceGuideStatusDisputeUnderReview],
  [copy.marketStatusJudgementDelayed, copy.serviceGuideStatusJudgementDelayed],
  [copy.marketStatusResolved, copy.serviceGuideStatusResolved],
  [copy.marketStatusSettling, copy.serviceGuideStatusSettling],
  [copy.marketStatusSettled, copy.serviceGuideStatusSettled],
  [copy.marketStatusCancelled, copy.serviceGuideStatusCancelled],
];

/** The three prices a screen shows side by side (N02 §5, ADR-0107 결정 1 #177 12항). */
const THREE_PRICES: LegalListItem = {
  text: copy.serviceGuideThreePrices,
  items: [copy.serviceGuidePriceLast, copy.serviceGuidePriceBook, copy.serviceGuidePriceAverage],
};

const SECTIONS: Readonly<Record<ServiceGuideAnchor, Omit<ServiceGuideSection, 'anchor'>>> = {
  // NR, N01 §3, N02 §1; ADR-0107 결정 1 #177 1항·결정 2 #73 15항.
  contract: {
    heading: copy.serviceGuideContractTitle,
    blocks: [
      bullets(S.contractChoice, S.eventContract, S.payout, S.priceRange, S.holdingByFill, S.noFee),
    ],
  },
  // N01 §3·§4.
  collateral: {
    heading: copy.serviceGuideCollateralTitle,
    blocks: [
      bullets(
        S.pairCollateral,
        copy.serviceGuidePairFill,
        copy.serviceGuideBuyWithinBalance,
        S.noLeverage,
        copy.serviceGuideLocks,
        copy.serviceGuideBudgetLock,
      ),
    ],
  },
  // N01 §4·§8, N02 §6·§7; ADR-0093 결정 1 #173 3항, ADR-0107 결정 1 #177, 결정 4 #119·#178; 133-30.
  orders: {
    heading: copy.serviceGuideOrdersTitle,
    blocks: [
      bullets(
        copy.serviceGuideOrderSteps,
        S.immediateOrder,
        copy.serviceGuideImmediateLimits,
        copy.serviceGuideBudgetUnused,
        copy.serviceGuideNoMarketOrder,
        copy.serviceGuideLimitWaits,
        S.limitOrderExpiry,
        S.waitingOrdersCancelled,
        copy.serviceGuidePartialFill,
        copy.serviceGuideQuote,
        copy.serviceGuidePriority,
        copy.serviceGuideSelfTrade,
        copy.serviceGuideCancelPending,
        S.limitsAndMonitoring,
      ),
    ],
  },
  // N02 §5, N00 §4·§7; ADR-0107 결정 4 #121, ADR-0061 결정 1 2항.
  'market-price': {
    heading: copy.serviceGuideMarketPriceTitle,
    blocks: [
      bullets(
        S.marketPrice,
        copy.serviceGuideYesBasis,
        S.marketPriceNotProbability,
        copy.serviceGuideNotBelief,
        THREE_PRICES,
        copy.serviceGuideNoQuote,
      ),
    ],
  },
  // N01 §5·§6·§8, N00 §5; ADR-0058 1-2·1-20, ADR-0107 결정 2 #73 11항, ADR-0135 B4.
  liquidity: {
    heading: copy.serviceGuideLiquidityTitle,
    blocks: [
      bullets(
        S.operatingLiquidity,
        S.operatingLiquidityRules,
        copy.serviceGuideLiquidityHidden,
        copy.serviceGuideLiquidityNotPerson,
        copy.serviceGuideLiquidityCounts,
        copy.serviceGuideLiquidityNoSelfFill,
        copy.serviceGuideLiquidityContinues,
        copy.serviceGuideOpeningSetting,
      ),
    ],
  },
  // N03 §3·§4·§5·§7; ADR-0093 결정 1 #173, ADR-0165, ADR-0166.
  judgement: {
    heading: copy.serviceGuideJudgementTitle,
    blocks: [
      bullets(
        copy.serviceGuideCloseVsJudgement,
        S.noReopen,
        S.judgingApproval,
        S.judgingPrinciple,
        S.judgingDelay,
        S.provisionalResult,
        copy.serviceGuideDisputeRules,
      ),
      paragraph(copy.serviceGuideStatusIntro),
      table(
        copy.serviceGuideStatusCaption,
        [copy.serviceGuideStatusHeadName, copy.serviceGuideStatusHeadMeaning],
        STATUS_ROWS,
      ),
      bullets(S.resolvedApartFromPaid, S.provisionalCorrection, S.resolvedError),
    ],
  },
  // N03 §3·§6; ADR-0093 결정 1 #173 9·10항, ADR-0117.
  'void-cancel': {
    heading: copy.serviceGuideVoidCancelTitle,
    blocks: [
      bullets(
        S.voidResult,
        copy.serviceGuideVoidRules,
        copy.serviceGuideVoidLabel,
        copy.serviceGuideNoUnwind,
        S.noFillCancel,
        copy.serviceGuideCancelNoJudgement,
        copy.serviceGuideScheduledCancel,
      ),
    ],
  },
  // N01 §2, N02 §8, N04 §4; ADR-0069 #81, ADR-0088, ADR-0155.
  coin: {
    heading: copy.serviceGuideCoinTitle,
    blocks: [
      bullets(
        S.startGrant,
        S.regrant,
        S.grantsNotProfit,
        S.noRewardOrTransfer,
        S.noCashOut,
        S.lossMoves,
        copy.serviceGuideNoScore,
      ),
    ],
  },
};

export const SERVICE_GUIDE: ServiceGuide = {
  title: copy.serviceGuideTitle,
  intro: [copy.serviceGuideIntro, copy.serviceGuideIntroSettings],
  sections: SERVICE_GUIDE_ANCHORS.map((anchor) => ({ anchor, ...SECTIONS[anchor] })),
};

/** Every string of the guide in reading order: the title, the head, each section's heading and blocks. */
export function serviceGuideStrings(guide: ServiceGuide = SERVICE_GUIDE): string[] {
  const ofItem = (item: LegalListItem): string[] =>
    typeof item === 'string' ? [item] : [item.text, ...item.items];
  const ofBlock = (block: LegalBlock): string[] => {
    switch (block.kind) {
      case 'paragraph':
        return [block.text];
      case 'list':
        return block.items.flatMap(ofItem);
      case 'table':
        return [block.caption, ...block.head, ...block.rows.flat()];
    }
  };
  return [
    guide.title,
    ...guide.intro,
    ...guide.sections.flatMap((section) => [section.heading, ...section.blocks.flatMap(ofBlock)]),
  ];
}
