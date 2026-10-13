import { REPLACED_TERMS } from '../terms.js';

/**
 * What the plan leaves out of the initial product, in one list (#113): the regression checks
 * that keep each of these from coming back read it from here and from nowhere else — the screen
 * text, screen address and menu checks of the web (apps/web/src/excluded-features.test.ts), the
 * mail templates' check (apps/api/src/mail/templates.test.ts), the seed markets' copy check
 * (packages/db/src/seed-markets.test.ts), the storage name check
 * (packages/db/src/storage-names.test.ts) and the API's (apps/api/src/surface/registry.test.ts,
 * private-data.test.ts). Nothing reads it at run time. docs/GUARDS.md says where each check
 * lives and how a later issue registers.
 *
 * A feature is looked for on the surfaces it names:
 * - `screen`: text a person reads — the web's copy, string and JSX text, mail, the seed markets'
 *   copy, notification text — matched with `words`; the admin screens only for the gambling
 *   words (ADMIN_SCREEN_FEATURES);
 * - `route`: screen addresses and menu links, matched with `tokens`;
 * - `api`: the public API — the paths, parameters, schema and field names of the public routes
 *   and documented public operations, the fields of real public answers and of market-channel
 *   events — and notification type names, matched with `tokens`; the path of every route,
 *   owner-only and admin ones too, only for EVERY_ROUTE_PATH_FEATURES;
 * - `storage`: table, column, constraint and enum names and the stored value lists, matched
 *   with `tokens`.
 *
 * Paid purchase is looked for on screens, screen addresses and public, not kept, routes only:
 * the payment and coupon code and tables stay (D9, ADR-0049; registry.test.ts). The term rows of
 * #14, the genre-only 예측 (D22) and the gambling words (D21) are looked for in screen text only.
 * The API and screen scopes are owner decision 2026-10-14 #113.
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
   * of its inflections (`rankings`, `scoring`, `withdrawal`; identifierWords, tokenForms). A
   * two-word token names it only together: `check in` matches two words in a row (`checkIn`,
   * `/me/check-in`, `checked_in`) or the two as one word (`DAILY_CHECKIN`).
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
    tokens: ['forecast', 'belief', 'credence', 'slider'],
  },
  {
    // Not the contest words 상금·참가비·우승: the challenges (#81) revisit them (owner decision
    // 2026-10-14 #113).
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
      /체크인/,
      /리워드/,
      /적립/,
      // 보상 alone is also the compensation N01 §9 records, and 보너스·지급 are the sign-up
      // Coin's and the payout's words; an activity shortly before them in the same sentence
      // makes them a reward ('거래량 보너스', '좋아요 10개마다 Coin 지급', '매일 접속하면').
      // 글 is a post as its own word, not inside 게시글 (named) or 글자·글꼴·글씨.
      /(?:거래량|거래\s*횟수|주문\s*횟수|활동량?|행동량|접속|(?<![가-힣])글(?![자꼴씨])|게시글|답글|댓글|좋아요)[^.?!\n]{0,16}?(?:보상|보너스|지급)/,
    ],
    // `bonus` alone is the sign-up BONUS; storage-names.test.ts holds bonus-named stored values
    // to a list of their own.
    tokens: ['reward', 'attendance', 'check in', 'streak'],
  },
  {
    id: 'coin-transfer',
    name: '사용자 간 Coin 송금',
    basis: 'N01 §2',
    surfaces: ALL_SURFACES,
    words: [
      /송금/,
      /이체/,
      /선물하기/,
      // Coin as the thing sent: 'Coin 보내기', 'Coin을 다른 회원에게 보내기'. A mail or a code is
      // sent as well, so 보내다 alone is not one.
      /(?:Coin|코인)\s*(?:을|를)?\s*(?:[^.?!\n]{0,12}?에게\s*)?보내/,
    ],
    // `send` alone is also a mail's or a verification code's; with Coin it is a transfer.
    tokens: ['transfer', 'gift', 'remit', 'remittance', 'send coin', 'coin send'],
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

/**
 * The features looked for in the path of every API route, owner-only and admin ones too: a
 * transfer or a cash-out would be a route a member calls for their own account, and an activity
 * reward one an admin runs. The rest of the API's name checks look at the public API only
 * (owner decision 2026-10-14 #113).
 */
export const EVERY_ROUTE_PATH_FEATURES: readonly ExcludedFeatureId[] = [
  'activity-reward',
  'coin-transfer',
  'cash-out',
];

/**
 * The features looked for in the admin screens' text: the gambling words only. Members never see
 * those screens; mail and every member screen are held to the whole list (owner decision
 * 2026-10-14 #113).
 */
export const ADMIN_SCREEN_FEATURES: readonly ExcludedFeatureId[] = ['gambling'];

// ---- screen text ----------------------------------------------------------------------

/**
 * Where screen text is shown, as far as allowances care: everywhere, or the service guide page
 * (#136), the one place that may say what the product does not offer (owner decisions 2026-10-13
 * and 2026-10-14 #113). Which sources make up that page is the screen check's to say.
 */
export const ALLOWANCE_SCOPES = ['everywhere', 'service-guide'] as const;
export type AllowanceScope = (typeof ALLOWANCE_SCOPES)[number];

/**
 * A sentence that says something is not offered, cannot be done, is not there or is not what it
 * is called: '…을 제공하지 않습니다', '…할 수 없습니다', '…기능은 없습니다', '…은 확률이 아닙니다'.
 * The service guide (#136) may widen it when it words its own sentences.
 */
export const NEGATIVE_NOTICE =
  /(?:제공|지원|지급)하지\s*않|할\s*수\s*없|없(?:습니다|어요)|아닙니다|아니에요/;

const CASH_OUT_WORD = String.raw`(?:현금\s*)?(?:환전|출금|인출|현금화)`;

/**
 * The no-cash notice: the cash-out words themselves, joined by '·', '및', '하거나' and the like,
 * then a particle and NEGATIVE_NOTICE's verbs — 'Coin의 현금 환전·출금은 제공하지 않습니다',
 * '현금으로 환전하거나 출금할 수 없습니다'. The verb belongs to the cash-out word: in '출금 신청은
 * 취소할 수 없습니다' it does not, and the sentence offers a withdrawal.
 */
export const CASH_OUT_NOTICE = new RegExp(
  `${CASH_OUT_WORD}(?:\\s*(?:[·,/]|및|또는|와|과|이나|나|하거나|하고)?\\s*${CASH_OUT_WORD})*` +
    String.raw`(?:\s*(?:기능|서비스))?(?:\s*(?:은|는|을|를|도|이|가))?\s*` +
    String.raw`(?:(?:제공|지원|지급)하지\s*않|(?:할|하실)\s*수\s*없)`,
);

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
    within: 'phrase',
    pattern: CASH_OUT_NOTICE,
    scope: 'everywhere',
    reason: '현금 환전·출금을 제공하지 않는다는 안내(N01 §2, 오너 결정 2026-10-13 #113)',
  },
  {
    features: [
      'probability-input',
      'scoring',
      'paid-purchase',
      'activity-reward',
      'coin-transfer',
      'replaced-term',
      'prediction-word',
    ],
    within: 'sentence',
    pattern: NEGATIVE_NOTICE,
    scope: 'service-guide',
    reason:
      "'점수·순위를 제공하지 않습니다', '시장가격은 확률이 아닙니다' 같은 부정 안내는 서비스 안내(#136)에서만(오너 결정 2026-10-13·2026-10-14 #113). 도박 어휘는 여기서도 쓰지 않는다",
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
  /** The identifier's word that matched, or its two words in a row (`check in`). */
  readonly word: string;
  readonly token: string;
}

/**
 * Each feature with its tokens' inflections: `forms` maps a word to the token it is a form of
 * (a two-word token's joined forms included), `pairs` holds a two-word token's forms word by
 * word.
 */
const FEATURE_FORMS = EXCLUDED_FEATURES.map((feature) => ({
  feature,
  forms: new Map(
    feature.tokens.flatMap((token) =>
      tokenForms(token.replace(' ', '')).map((form) => [form, token] as const),
    ),
  ),
  pairs: feature.tokens.flatMap((token) => {
    const [first, second] = token.split(' ');
    return second === undefined
      ? []
      : [{ token, first: new Set(tokenForms(first!)), second: new Set(tokenForms(second)) }];
  }),
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
  ).flatMap(({ feature, forms, pairs }) =>
    words.flatMap((word, index) => {
      const token = forms.get(word);
      const next = words[index + 1];
      return [
        ...(token === undefined ? [] : [{ feature: feature.id, word, token }]),
        ...pairs
          .filter((pair) => next !== undefined && pair.first.has(word) && pair.second.has(next))
          .map((pair) => ({ feature: feature.id, word: `${word} ${next!}`, token: pair.token })),
      ];
    }),
  );
}

/**
 * Words that make a name a probability or a belief (N02 §10, N04 §4·§5): no table tied to one
 * user or to one order has such a name or such a column, so no buy input or fill price is kept as
 * that person's probability; nothing of the public API — a public route's path, a public
 * operation's parameter, schema or field, a public answer's key, a market-channel event's field —
 * has one either: there a probability is someone's input or the Community Forecast's (N02 §1,
 * N00 §5), and the market price is not called one (docs/TERMS.md).
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
