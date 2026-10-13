/**
 * How a check can find a row's `unused` expression in screen text.
 *
 * - `text`: the letters themselves appear in no screen string any more, so a plain substring
 *   search finds every slip.
 * - `meaning`: the same letters stay in another meaning — 정산 for the Coin payout, 예측 inside
 *   the genre 예측시장, the one-syllable 예 inside other words — and only the meaning the row
 *   names is gone, so a check has to look at the meaning or at a narrower pattern.
 */
export type TermMatch = 'text' | 'meaning';

/** One row of the term mapping (docs/TERMS.md). */
export interface ReplacedTerm {
  /** What a screen used to say (or must not say), as written. */
  readonly unused: string;
  /**
   * What screens say instead: terms from the plan (docs/plan) or names the owner chose, and
   * nothing else. Empty when nothing takes the place — the thing itself is gone (a separate
   * vote, a probability input) or the word is banned (D21).
   */
  readonly use: readonly string[];
  /** Where `use` (or the removal) comes from: plan sections (NR, N00~N06 §n) or owner decisions. */
  readonly basis: string;
  readonly match: TermMatch;
  /** Which meaning the row covers, or a known look-alike a check must let through. */
  readonly note?: string;
}

/**
 * The term mapping of #14 (ADR-0052): the expressions user and admin screens no longer use, and
 * the plan's term that replaces each. docs/TERMS.md is this list as a table, row for row
 * (terms.test.ts compares the two), and the regression check of #113 imports it from here.
 * Nothing reads it at run time.
 *
 * Out of its reach until their own issues: the legal document bodies (#137) and the charge copy
 * hidden while paid Coin is closed (#111) — docs/TERMS.md lists them.
 */
export const REPLACED_TERMS: readonly ReplacedTerm[] = [
  // 예측 names the genre only (D22).
  {
    unused: '예측',
    use: ['거래', '매수', '매도'],
    basis: 'N01 §1, N02 §1, D22',
    match: 'meaning',
    note: '거래 행동·입력을 부르는 말. 장르명 예측시장에만 남는다',
  },
  { unused: '예측하기', use: ['거래'], basis: 'N02 §1, D22', match: 'text' },
  { unused: '예측 매수', use: ['매수'], basis: 'N02 §1, D22', match: 'text' },
  { unused: '예측 매도', use: ['매도'], basis: 'N02 §1, D22', match: 'text' },
  {
    unused: '예측가',
    use: ['사용자'],
    basis: 'NR, D22',
    match: 'text',
    note: '사용자를 부르는 말',
  },
  { unused: '예측가_', use: ['user_'], basis: '오너 결정 #14-4', match: 'text' },
  { unused: '예측 시장', use: ['예측시장'], basis: 'N01 §1, 오너 결정 #14-1', match: 'text' },
  // Taking part is trading a contract, never handing in an opinion (N02 §1).
  { unused: '투표', use: [], basis: 'NR, N02 §1', match: 'text' },
  { unused: '내 예측', use: [], basis: 'N02 §1', match: 'text' },
  { unused: '예측 제출', use: [], basis: 'N02 §1', match: 'text' },
  { unused: '확률 입력', use: [], basis: 'N02 §1', match: 'text' },
  // The price is a market price, not a probability (N02 §5).
  {
    unused: '확률',
    use: ['시장가격'],
    basis: 'N02 §3·§5',
    match: 'meaning',
    note: '시장가격의 이름. 시장가격이 확률의 보장이 아니라고 말하는 안내(N02 §5)에는 남는다',
  },
  { unused: '확률 추이', use: ['시장가격'], basis: 'N02 §5', match: 'text' },
  { unused: '확률 변화', use: ['시장가격'], basis: 'N02 §5', match: 'text' },
  // Deciding the result is 판정; 정산 is the Coin payout (N03 §5·§7).
  {
    unused: '정산',
    use: ['판정'],
    basis: 'N03 §5·§7',
    match: 'meaning',
    note: '결과를 정하는 일. Coin 지급은 정산 그대로다',
  },
  {
    unused: '정산 기준',
    use: ['규칙'],
    basis: 'N02 §4, N03 §8, 오너 결정 #14-2',
    match: 'text',
    note: '시장 규칙 영역의 이름. 그 안의 출처는 출처 그대로다',
  },
  // YES/NO are the contracts traded (N02 §1).
  {
    unused: '예',
    use: ['YES'],
    basis: 'N02 §1·§4, 오너 결정 #14-3',
    match: 'meaning',
    note: 'YES 계약의 화면 표기. 한 글자라 다른 낱말 안에도 있다',
  },
  { unused: '아니오', use: ['NO'], basis: 'N02 §1·§4, 오너 결정 #14-3', match: 'text' },
  // Trading is not guessing right.
  { unused: '맞히면', use: ['정답 시'], basis: 'N02 §6, 오너 결정 #14-5', match: 'text' },
  { unused: '맞힌', use: ['정답'], basis: 'N02 §6, 오너 결정 #14-5', match: 'text' },
  // Gambling vocabulary, with no replacement (D21).
  { unused: '베팅', use: [], basis: 'D21', match: 'text' },
  { unused: '배당', use: [], basis: 'D21', match: 'text' },
  { unused: '배당률', use: [], basis: 'D21', match: 'text' },
  {
    unused: '승률',
    use: [],
    basis: 'D21',
    match: 'text',
    note: '경제 용어 상승률(시드 시장 제목)은 이 낱말이 아니다',
  },
  { unused: '판돈', use: [], basis: 'D21', match: 'text' },
  { unused: '당첨', use: [], basis: 'D21', match: 'text' },
];
