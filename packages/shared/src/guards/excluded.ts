import { REPLACED_TERMS } from '../terms.js';

/**
 * What the plan leaves out of the initial product, in one list (#113): the regression checks
 * that keep each of these from coming back read it from here and from nowhere else — the screen
 * text, screen address and menu checks of the web (apps/web/src/excluded-features.test.ts), the
 * mail templates' check (apps/api/src/mail/templates.test.ts), the seed markets' copy check
 * (packages/db/src/seed-markets.test.ts) and the storage name check
 * (packages/db/src/storage-names.test.ts); the `api` surface is the public API's. Nothing reads
 * it at run time. docs/GUARDS.md says where each check lives and how a later issue registers.
 *
 * A feature is looked for on the surfaces it names:
 * - `screen`: text a person reads — the web's copy, string and JSX text, mail, the seed markets'
 *   copy — matched with `words`;
 * - `route`: screen addresses and menu links, matched with `tokens`;
 * - `api`: public API paths and response field names, matched with `tokens`;
 * - `storage`: table, column, constraint and enum names and the stored value lists, matched
 *   with `tokens`.
 *
 * Paid purchase is looked for on screens, screen addresses and public responses only: the
 * payment and coupon code and tables stay (D9, ADR-0049). The term rows of #14, the genre-only
 * 예측 (D22) and the gambling words (D21) are looked for in screen text only.
 *
 * A word that also has an allowed meaning is cleared by TEXT_ALLOWANCES, never by loosening the
 * word: '상승률' is not '승률', '우선순위' is not a ranking.
 */

export const EXCLUSION_SURFACES = ['screen', 'route', 'api', 'storage'] as const;
export type ExclusionSurface = (typeof EXCLUSION_SURFACES)[number];

/** The surfaces matched by identifier tokens rather than by screen words. */
export type IdentifierSurface = Exclude<ExclusionSurface, 'screen'>;

export const EXCLUDED_FEATURE_IDS = [
  'probability-input',
  'scoring',
  'paid-purchase',
  'activity-reward',
  'coin-transfer',
  'cash-out',
  'replaced-term',
  'prediction-word',
  'gambling',
] as const;
export type ExcludedFeatureId = (typeof EXCLUDED_FEATURE_IDS)[number];

export interface ExcludedFeature {
  readonly id: ExcludedFeatureId;
  /** What is left out, as #113 lists it. */
  readonly name: string;
  /** The plan sections (NR, N00~N06 §n) and owner decisions (Dn, ADR) that leave it out. */
  readonly basis: string;
  readonly surfaces: readonly ExclusionSurface[];
  /** Screen text that names it: Korean words and the English names the plan uses. */
  readonly words: readonly RegExp[];
  /**
   * Identifier words that name it, lower case. A word of an identifier matches a token or one
   * of its inflections (`rankings`, `scoring`, `withdrawal`; identifierWords, tokenForms).
   */
  readonly tokens: readonly string[];
}

const ALL_SURFACES: readonly ExclusionSurface[] = EXCLUSION_SURFACES;
const D21 = 'D21';

function literal(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/** The gambling words of D21: the rows of the #14 term table that have no replacement. */
export const GAMBLING_WORDS: readonly string[] = REPLACED_TERMS.filter(
  (row) => row.basis === D21,
).map((row) => row.unused);

/**
 * How screen text shows each `meaning` row of the #14 term table (docs/TERMS.md: the same
 * letters stay in another meaning), or `null` when no pattern can tell the meanings apart:
 * - 예측 is the genre's word as well; the `prediction-word` feature looks for it (D22);
 * - 확률 is the market price's old name; the N02 §5 notice that the price is no promise of a
 *   probability keeps it (TEXT_ALLOWANCES);
 * - 정산 stays as the Coin payout, and only a reader can tell it from judging the result — the
 *   `text` row 정산 기준 covers the one known phrase;
 * - 예 as the YES contract's label stands alone ('예', '예 63%'); inside a word, or as '예:' and
 *   '예)' (for example), it is something else.
 */
export const TERM_MEANING_PATTERNS: Readonly<Record<string, RegExp | null>> = {
  예측: null,
  확률: /확률/,
  정산: null,
  예: /(?<![가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9])예(?![가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9:)])/,
};

/** The #14 rows other than the gambling words, as screen patterns. */
const REPLACED_TERM_WORDS: readonly RegExp[] = REPLACED_TERMS.filter(
  (row) => row.basis !== D21,
).flatMap((row) => {
  if (row.match === 'text') return [literal(row.unused)];
  const pattern = TERM_MEANING_PATTERNS[row.unused];
  return pattern ? [pattern] : [];
});

export const EXCLUDED_FEATURES: readonly ExcludedFeature[] = [
  {
    id: 'probability-input',
    name: '독립 확률 입력·확률 슬라이더·My Forecast·Community Forecast·Forecast 수정 이력',
    basis: 'N02 §1·§10, N00 §5, N04 §5',
    surfaces: ALL_SURFACES,
    words: [
      /확률\s*(?:입력|슬라이더)/,
      /forecast/i,
      /포어?캐스트/,
      /(?:내|커뮤니티)\s*예측/,
      /예측\s*(?:입력|수정|이력|제출)/,
    ],
    tokens: ['forecast', 'belief', 'credence'],
  },
  {
    id: 'scoring',
    name: '점수·평판·카테고리 등급·순위·실력 배지',
    basis: 'N04 §4, N00 §3-08, N02 §2',
    surfaces: ALL_SURFACES,
    words: [
      /점수/,
      /스코어/,
      /평판/,
      /등급/,
      /순위/,
      /랭킹/,
      /리더보드/,
      /실력/,
      /배지/,
      /leaderboard/i,
      /\branking/i,
      /\bscor(?:e|es|ing)\b/i,
    ],
    tokens: ['score', 'rank', 'leaderboard', 'reputation', 'grade', 'badge', 'skill', 'brier'],
  },
  {
    // Coupons are hidden with the charge (D9, ADR-0049) though N06 does not name them.
    id: 'paid-purchase',
    name: '유료 구매 버튼·가격표·구매 보너스·결제 유도(충전·결제·쿠폰)',
    basis: 'N06 초기 제품과의 경계, D9, ADR-0049',
    surfaces: ['screen', 'route', 'api'],
    words: [
      /충전/,
      /결제/,
      /구매/,
      /쿠폰/,
      /가격표/,
      /할인/,
      // A price in won; not 원칙, 원래, 원금, 원본, 원인 or 원하다 after a number.
      /\d\s*원(?![칙래금본인하])/,
      /₩/,
    ],
    tokens: ['charge', 'purchase', 'payment', 'checkout', 'pricing', 'coupon', 'discount', 'krw'],
  },
  {
    id: 'activity-reward',
    name: '활동량 Coin 보상(출석·거래량·주문 횟수, 글·답글·좋아요 수에 따른 지급)',
    basis: 'N01 §2, N05 §2, D5',
    surfaces: ALL_SURFACES,
    words: [
      /출석/,
      /리워드/,
      /적립/,
      // 보상 alone is also the compensation N01 §9 records; an activity in front of it makes it
      // a reward.
      /(?:거래량|거래\s*횟수|주문\s*횟수|활동량?|행동량|글|답글|댓글|좋아요)\s*(?:수\s*)?(?:에\s*따른\s*)?보상/,
    ],
    tokens: ['reward', 'attendance'],
  },
  {
    id: 'coin-transfer',
    name: '사용자 간 Coin 송금',
    basis: 'N01 §2',
    surfaces: ALL_SURFACES,
    words: [/송금/, /이체/, /선물하기/],
    tokens: ['transfer', 'gift', 'remit', 'remittance'],
  },
  {
    id: 'cash-out',
    name: '현금 환전·출금',
    basis: 'N01 §2, N00 §5, N06 초기 제품과의 경계',
    surfaces: ALL_SURFACES,
    words: [/환전/, /출금/, /인출/, /현금화/],
    tokens: ['withdraw', 'cashout', 'cash'],
  },
  {
    id: 'replaced-term',
    name: "거래를 '예측'·'투표'로, 시장가격을 '확률'로 부르는 표현(#14 용어 대응표)",
    basis: 'docs/TERMS.md, ADR-0052',
    surfaces: ['screen'],
    words: REPLACED_TERM_WORDS,
    tokens: [],
  },
  {
    id: 'prediction-word',
    name: "장르명 '예측시장' 밖의 '예측'",
    basis: 'D22',
    surfaces: ['screen'],
    words: [/예측/],
    tokens: [],
  },
  {
    id: 'gambling',
    name: '도박 어휘(베팅·배당·배당률·승률·판돈·당첨)',
    basis: 'D21',
    surfaces: ['screen'],
    words: GAMBLING_WORDS.map(literal),
    tokens: [],
  },
];

// ---- screen text ----------------------------------------------------------------------

/**
 * Where screen text is shown, as far as allowances care: everywhere, or the service guide page
 * (#136), the one place that may say what the product does not offer (owner decision 2026-10-13
 * #113). Which sources make up that page is the screen check's to say.
 */
export const ALLOWANCE_SCOPES = ['everywhere', 'service-guide'] as const;
export type AllowanceScope = (typeof ALLOWANCE_SCOPES)[number];

/**
 * A sentence that says something is not offered or cannot be done: '…을 제공하지 않습니다',
 * '…할 수 없습니다'. The service guide (#136) may widen it when it words its own sentences.
 */
export const NEGATIVE_NOTICE = /(?:제공|지원|지급)하지\s*않|할\s*수\s*없/;

export interface TextAllowance {
  /** The features whose hits it clears. */
  readonly features: readonly ExcludedFeatureId[];
  /**
   * `phrase`: a hit inside a match of `pattern` is cleared — the word is part of another one.
   * `sentence`: every hit in a sentence that matches `pattern` is cleared.
   */
  readonly within: 'phrase' | 'sentence';
  readonly pattern: RegExp;
  readonly scope: AllowanceScope;
  readonly reason: string;
}

/**
 * Words that contain an excluded word without meaning it, and the notices that may name an
 * excluded feature. A screen check adds its own, narrower allowances (a copy key, a file) on
 * top; these hold for any screen text.
 */
export const TEXT_ALLOWANCES: readonly TextAllowance[] = [
  {
    features: ['prediction-word'],
    within: 'phrase',
    pattern: /예측시장/,
    scope: 'everywhere',
    reason: '장르명 예측시장(D22, 오너 결정 #14-1)',
  },
  {
    features: ['replaced-term'],
    within: 'phrase',
    pattern: /확률[^.?!\n]{0,8}보장[^.?!\n]{0,12}(?:아니|아닙|않)/,
    scope: 'everywhere',
    reason: '시장가격이 확률의 보장이 아니라는 안내(N02 §5, docs/TERMS.md의 확률 행)',
  },
  {
    features: ['gambling'],
    within: 'phrase',
    pattern: /상승률/,
    scope: 'everywhere',
    reason: '경제 용어 상승률은 승률이 아니다(docs/TERMS.md의 승률 행)',
  },
  {
    features: ['scoring'],
    within: 'phrase',
    pattern: /우선\s*순위/,
    scope: 'everywhere',
    reason: '주문 체결의 가격·시간 우선순위(N01 §4)는 사용자 순위가 아니다',
  },
  {
    features: ['paid-purchase'],
    within: 'phrase',
    pattern: /미결제/,
    scope: 'everywhere',
    reason: '미결제 계약(아직 정산되지 않은 계약 수)은 결제가 아니다',
  },
  {
    features: ['coin-transfer'],
    within: 'phrase',
    pattern: /계좌\s*이체/,
    scope: 'everywhere',
    reason: '보존한 결제 코드(D9)의 결제 수단 이름. 사용자 간 Coin 송금이 아니다',
  },
  {
    features: ['cash-out'],
    within: 'sentence',
    pattern: NEGATIVE_NOTICE,
    scope: 'everywhere',
    reason: '현금 환전·출금을 제공하지 않는다는 안내(N01 §2, 오너 결정 2026-10-13 #113)',
  },
  {
    features: ['probability-input', 'scoring', 'paid-purchase', 'activity-reward', 'coin-transfer'],
    within: 'sentence',
    pattern: NEGATIVE_NOTICE,
    scope: 'service-guide',
    reason:
      "'점수·순위를 제공하지 않습니다' 같은 부정 안내는 서비스 안내(#136)에서만(오너 결정 2026-10-13 #113)",
  },
];

export interface ExcludedTextHit {
  readonly feature: ExcludedFeatureId;
  /** The text the word matched. */
  readonly match: string;
  readonly index: number;
}

export interface FindExcludedTextOptions {
  /** The features to look for; every feature looked for on screens when left out. */
  readonly features?: readonly ExcludedFeatureId[];
  /** Where the text is shown. */
  readonly scope?: AllowanceScope;
}

function global(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
}

const SENTENCE_END = /[.?!。\n]/;

/** The sentence around `index`: from the previous sentence end to the next one. */
function sentenceAt(text: string, index: number): string {
  let start = index;
  while (start > 0 && !SENTENCE_END.test(text.charAt(start - 1))) start--;
  let end = index;
  while (end < text.length && !SENTENCE_END.test(text.charAt(end))) end++;
  return text.slice(start, end);
}

function allowed(text: string, hit: ExcludedTextHit, scope: AllowanceScope): boolean {
  return TEXT_ALLOWANCES.some((allowance) => {
    if (allowance.scope !== 'everywhere' && allowance.scope !== scope) return false;
    if (!allowance.features.includes(hit.feature)) return false;
    if (allowance.within === 'sentence') {
      return allowance.pattern.test(sentenceAt(text, hit.index));
    }
    const end = hit.index + hit.match.length;
    return [...text.matchAll(global(allowance.pattern))].some(
      (m) => m.index <= hit.index && m.index + m[0].length >= end,
    );
  });
}

/**
 * The excluded features `text` names, past TEXT_ALLOWANCES: one hit per match of a feature's
 * word. Empty when the text is clean.
 */
export function findExcludedText(
  text: string,
  options: FindExcludedTextOptions = {},
): ExcludedTextHit[] {
  const scope = options.scope ?? 'everywhere';
  const hits: ExcludedTextHit[] = [];
  for (const feature of EXCLUDED_FEATURES) {
    if (!feature.surfaces.includes('screen')) continue;
    if (options.features && !options.features.includes(feature.id)) continue;
    for (const word of feature.words) {
      for (const m of text.matchAll(global(word))) {
        const hit: ExcludedTextHit = { feature: feature.id, match: m[0], index: m.index };
        if (!allowed(text, hit, scope)) hits.push(hit);
      }
    }
  }
  return hits;
}

// ---- identifiers ----------------------------------------------------------------------

/**
 * The words of an identifier, lower case: `realized_pnl_coin`, `realizedPnlCoin`,
 * `SETTLEMENT_PAYOUT`, `/admin/audit-failures`, `pYesBp` (p, yes, bp).
 */
export function identifierWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

/**
 * A token and its inflections: `rank` → ranks, ranking, ranked; `score` → scoring;
 * `transfer` → transferred.
 */
export function tokenForms(token: string): readonly string[] {
  const stem = token.replace(/e$/, '');
  const doubled = token + token.slice(-1);
  return [
    ...new Set([
      token,
      `${token}s`,
      `${token}es`,
      `${token}ed`,
      `${token}al`,
      `${token}als`,
      `${stem}ing`,
      `${stem}ings`,
      `${stem}ed`,
      `${doubled}ed`,
      `${doubled}ing`,
    ]),
  ];
}

export interface ExcludedIdentifierHit {
  readonly feature: ExcludedFeatureId;
  /** The identifier's word that matched. */
  readonly word: string;
  readonly token: string;
}

/** Each feature with its tokens' inflections, form → token. */
const FEATURE_FORMS = EXCLUDED_FEATURES.map((feature) => ({
  feature,
  forms: new Map(
    feature.tokens.flatMap((token) => tokenForms(token).map((form) => [form, token] as const)),
  ),
}));

/**
 * The excluded features an identifier on `surface` names — a route segment, an API path or
 * field, a table, column, constraint or enum name, a stored value. Empty when it is clean.
 */
export function findExcludedIdentifier(
  name: string,
  surface: IdentifierSurface,
  options: { readonly features?: readonly ExcludedFeatureId[] } = {},
): ExcludedIdentifierHit[] {
  const words = identifierWords(name);
  return FEATURE_FORMS.filter(
    ({ feature }) =>
      feature.surfaces.includes(surface) &&
      (options.features === undefined || options.features.includes(feature.id)),
  ).flatMap(({ feature, forms }) =>
    words.flatMap((word) => {
      const token = forms.get(word);
      return token === undefined ? [] : [{ feature: feature.id, word, token }];
    }),
  );
}

/**
 * Words that make a name a probability or a belief: a table tied to one user or to one order
 * must have no such column, so no buy input or fill price is kept as that person's probability
 * (N02 §10, N04 §4·§5).
 */
export const PERSONAL_PROBABILITY_WORDS: readonly string[] = [
  'prob',
  'probability',
  'probabilities',
  'belief',
  'beliefs',
  'credence',
  'confidence',
  'forecast',
  'forecasts',
];

export function namesPersonalProbability(name: string): boolean {
  return identifierWords(name).some((word) => PERSONAL_PROBABILITY_WORDS.includes(word));
}
