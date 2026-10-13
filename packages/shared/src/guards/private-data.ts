import { identifierWords } from './excluded.js';

/**
 * What a public response and a public realtime event must never carry (#113), in one list: the
 * API's public route check reads it for the field names of the OpenAPI document and of every
 * answer it gets (apps/api/src/surface), and the realtime check for the market-channel event
 * schemas (realtime-events.ts). Nothing reads it at run time.
 *
 * The plan's list (N04 §2, N01 §5) and D8's new records start it; the decision issues change it
 * (#37: the scope of 인증 정보 and of the risk flags, and what else outside the owner-only list is
 * public; #180: a market's bot settings; #123·#122: whether a fill says the house was the other
 * side). Items nothing stores yet are named ahead (`pending`), so the route or event that brings
 * one is refused from its first day.
 *
 * A name is matched by its words (identifierWords): an item's field `['real', 'name']` matches
 * `realName`, `real_name` and `buyerRealName`, never `nameKo`. A public fill or price is not
 * private: what makes one a person's is an account beside it or a name that says whose it is.
 */

export const PRIVATE_DATA_IDS = [
  'balance',
  'orders',
  'holdings',
  'pnl',
  'fills',
  'counterparty',
  'email',
  'real-name',
  'phone',
  'identity-verification',
  'auth-secret',
  'risk-flag',
  'author-holding',
] as const;
export type PrivateDataId = (typeof PRIVATE_DATA_IDS)[number];

export interface PrivateData {
  readonly id: PrivateDataId;
  /** What it is, as #113 lists it. */
  readonly name: string;
  /** The plan sections and owner decisions that keep it private. */
  readonly basis: string;
  /** Field names that carry it, each as a run of identifier words, lower case. */
  readonly fields: readonly (readonly string[])[];
  /** Why it is listed before anything stores it; absent once it exists. */
  readonly pending?: string;
}

export const PRIVATE_DATA: readonly PrivateData[] = [
  {
    id: 'balance',
    name: '특정 사용자에게 묶인 잔액',
    basis: 'N04 §2',
    fields: [['balance'], ['balances'], ['available', 'coin'], ['locked', 'coin']],
  },
  {
    id: 'orders',
    name: '특정 사용자에게 묶인 주문',
    basis: 'N04 §2·§7, N05 §2',
    // An order book's levels (price, quantity) are not an order: `orderBook` stays clean.
    fields: [['order', 'id'], ['order', 'ids'], ['orders'], ['idempotency']],
  },
  {
    id: 'holdings',
    name: '특정 사용자에게 묶인 미정산 보유 수량',
    basis: 'N04 §2',
    fields: [['position'], ['positions'], ['holding'], ['holdings'], ['cost', 'basis']],
  },
  {
    id: 'pnl',
    name: '특정 사용자에게 묶인 손익',
    basis: 'N04 §2·§3',
    fields: [['pnl'], ['profit'], ['profits'], ['loss'], ['losses'], ['realized'], ['unrealized']],
  },
  {
    id: 'fills',
    name: '특정 사용자에게 묶인 체결 내역',
    basis: 'N04 §2, N01 §5',
    // Recent fills are public and anonymous; the account beside one is `counterparty`, and a
    // name that says the fills are somebody's (`myFills`) is this.
    fields: [['my'], ['mine']],
  },
  {
    id: 'counterparty',
    name: '체결 당사자 계정(최근 체결은 익명으로만 공개한다)',
    basis: 'N01 §5, N04 §2',
    fields: [
      ['user', 'id'],
      ['user', 'ids'],
      ['account', 'id'],
      ['account', 'ids'],
      ['counterparty'],
      ['maker'],
      ['taker'],
      ['trader', 'id'],
      ['trader', 'ids'],
    ],
  },
  {
    id: 'email',
    name: '계정 이메일',
    basis: 'N04 §2',
    fields: [['email'], ['emails']],
  },
  {
    id: 'real-name',
    name: '실명',
    basis: 'D8, ADR-0043',
    fields: [
      ['real', 'name'],
      ['full', 'name'],
      ['legal', 'name'],
    ],
  },
  {
    id: 'phone',
    name: '휴대전화 번호',
    basis: 'D8, ADR-0043',
    fields: [['phone'], ['phones'], ['mobile'], ['tel'], ['telephone']],
  },
  {
    id: 'identity-verification',
    name: '본인확인 기록',
    basis: 'D8',
    fields: [
      ['verification'],
      ['verifications'],
      ['verified'],
      ['identity'],
      ['otp'],
      ['kyc'],
      ['ci'],
      ['di'],
      ['birth'],
      ['birthday'],
      ['carrier'],
    ],
    pending: 'D8의 휴대폰 SMS OTP 본인확인이 아직 없다',
  },
  {
    id: 'auth-secret',
    name: '인증 정보(비밀번호·세션·토큰)',
    basis: 'N04 §2',
    // #37 sets how far 인증 정보 reaches; these are what it means whatever the answer.
    fields: [
      ['password'],
      ['passwords'],
      ['session'],
      ['sessions'],
      ['token'],
      ['tokens'],
      ['secret'],
      ['secrets'],
      ['hash'],
    ],
  },
  {
    id: 'risk-flag',
    name: '내부 위험 플래그',
    basis: 'N04 §2',
    fields: [
      ['risk'],
      ['flag'],
      ['flags'],
      ['flagged'],
      ['fraud'],
      ['suspicious'],
      ['abuse'],
      ['needs', 'review'],
      ['blocked'],
      ['banned'],
      ['suspended'],
      ['restricted'],
      ['restriction'],
      ['restrictions'],
    ],
    pending: '위험 플래그를 두는 기능이 아직 없다(범위는 #37)',
  },
  {
    id: 'author-holding',
    name: '글 작성자의 보유 방향·주문',
    basis: 'N04 §2, N05 §2',
    fields: [
      ['author', 'position'],
      ['author', 'positions'],
      ['author', 'holding'],
      ['author', 'holdings'],
      ['author', 'side'],
      ['author', 'outcome'],
      ['author', 'order'],
      ['author', 'orders'],
    ],
    pending: '글·댓글 기능이 아직 없다',
  },
];

export interface PrivateFieldHit {
  readonly item: PrivateDataId;
  /** The run of words that matched, joined with spaces. */
  readonly words: string;
}

function containsRun(words: readonly string[], run: readonly string[]): boolean {
  for (let start = 0; start + run.length <= words.length; start++) {
    if (run.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
}

/** The private data a field name carries. Empty when it is clean. */
export function findPrivateField(name: string): PrivateFieldHit[] {
  const words = identifierWords(name);
  return PRIVATE_DATA.flatMap((item) =>
    item.fields
      .filter((run) => containsRun(words, run))
      .map((run) => ({ item: item.id, words: run.join(' ') })),
  );
}
