import { identifierWords } from './excluded.js';

/**
 * What a public response and a public realtime event must never carry (#113), in one list: the
 * API's public route check reads it for the field names of the OpenAPI document and of every
 * answer it gets (apps/api/src/surface), and the realtime check for the market-channel event
 * schemas (realtime-events.ts). Nothing reads it at run time.
 *
 * The plan's list (N04 §2, N01 §5) and D8's new records start it; the decision issues change it
 * (#37: the scope of 인증 정보 and of the risk flags, and what else outside the owner-only list is
 * public; #123·#122: whether a fill says the house was the other side). #180 kept a market's bot
 * participation and settings to admins (ADR-0058). The owner kept a user's time zone out while a
 * market's judging time zone (#22) stays public (2026-10-16, ADR-0063), and kept every watchlist
 * and every market's watch count to nobody but the member (#37 for #89, ADR-0061 decision 3,
 * ADR-0064). A member's recorded searches are listed by ADR-0066's own choice: the owner decided
 * they are recorded and shown to the member (#15, ADR-0061 decision 3), not who else may see them.
 * Items nothing stores yet
 * are named ahead (`pending`), so the route or event that brings one is refused from its first
 * day.
 *
 * A name is matched by its words (identifierWords): an item's field `['real', 'name']` matches
 * `realName`, `real_name` and `buyerRealName`, never `nameKo`. A public fill or price is not
 * private: what makes one a person's is an account beside it or a name that says whose it is
 * (`owned`: `userFills`, `fillsByAccount`, while `recentFills` stays public). A time zone is the
 * same: `userTimeZone` is a person's, `judgingTimeZone` a market's.
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
  'time-zone',
  'watchlist',
  'search-history',
  'identity-verification',
  'auth-secret',
  'risk-flag',
  'author-holding',
  'market-maker',
] as const;
export type PrivateDataId = (typeof PRIVATE_DATA_IDS)[number];

export interface PrivateData {
  readonly id: PrivateDataId;
  /** What it is, as #113 lists it. */
  readonly name: string;
  /** The plan sections and owner decisions that keep it private. */
  readonly basis: string;
  /**
   * Field names that carry it, each as a run of identifier words, lower case. Empty for an item
   * only `owned` names (`time-zone`).
   */
  readonly fields: readonly (readonly string[])[];
  /**
   * What is public on its own and private once a name says whose it is: a name holding one of
   * `words` and one of `whose` anywhere, in either order (`userFills`, `fillsByAccount`,
   * `memberTradeHistory`). Lower case.
   */
  readonly owned?: { readonly words: readonly string[]; readonly whose: readonly string[] };
  /** Why it is listed before anything stores it; absent once it exists. */
  readonly pending?: string;
}

/** Words that say whose something is: a user's, an account's, one's own. */
const WHOSE: readonly string[] = [
  'user',
  'users',
  'account',
  'accounts',
  'member',
  'members',
  'trader',
  'traders',
  'participant',
  'participants',
  'customer',
  'customers',
  'player',
  'players',
  'holder',
  'holders',
  'owner',
  'owners',
  'own',
  'person',
  'personal',
  'profile',
  'profiles',
];

/**
 * WHOSE, and the words a name uses for the one reading it: `myTimeZone`, `viewerZone`. Only the
 * time-zone item uses them (`my`·`mine` alone are already a fills field).
 */
const WHOSE_OR_VIEWER: readonly string[] = [...WHOSE, 'my', 'mine', 'viewer', 'viewers'];

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
    // name that says the fills are somebody's (`myFills`, `userFills`, `fillsByAccount`) is
    // this. A trade is a fill (`market:trade`).
    fields: [['my'], ['mine']],
    owned: { words: ['fill', 'fills', 'trade', 'trades'], whose: WHOSE },
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
    id: 'time-zone',
    name: '특정 사용자에게 묶인 시간대',
    basis: 'ADR-0063(오너 결정 2026-10-16)',
    // A zone on its own is public: the judging time zone #22 puts on a market (`timeZone`,
    // `judgingTimeZone`, `resolutionTimeZone`). A name that says whose it is (`userTimeZone`,
    // `profileTimeZone`, `memberZone`, `myTz`) is a person's. A person's zone under a bare
    // `timeZone` in a nested object (`Me.profile.timeZone`) is not caught by its name: the
    // public route check finds account A's zone by its value (apps/api/src/surface).
    fields: [],
    owned: {
      words: ['zone', 'zones', 'timezone', 'timezones', 'tz'],
      whose: WHOSE_OR_VIEWER,
    },
  },
  {
    id: 'watchlist',
    name: '특정 사용자의 관심 시장 목록과 시장별 관심 등록 수',
    basis: 'ADR-0061 결정 3(#89·#37, 오너 결정 2026-10-16), ADR-0064',
    // Nobody but the member sees whom a market is watched by or how many (#37): a public market
    // shape never says it is watched (`watched`, `isWatched`), counts watchers (`watchCount`,
    // `watcherCount`, `watchersCount`) or lists anybody's watchlist — nor under the feature's
    // own Korean name put into English (관심: `interestedCount`, `isInterested`) or the names such
    // a feature goes by elsewhere (`favoriteCount`, `bookmarked`). `interest` and `interests`
    // are left out: a market's open interest is a public trading figure. `subscribe` is the
    // realtime room message, not a watch. The member's own `GET /me/watchlist` is an owner-only
    // route, which this list does not read.
    fields: [
      ['watch'],
      ['watches'],
      ['watched'],
      ['watching'],
      ['watcher'],
      ['watchers'],
      ['watchlist'],
      ['watchlists'],
      ['interested'],
      ['favorite'],
      ['favorites'],
      ['favourite'],
      ['favourites'],
      ['bookmark'],
      ['bookmarks'],
      ['bookmarked'],
    ],
  },
  {
    id: 'search-history',
    name: '특정 사용자의 검색 기록(검색어와 시각)',
    basis:
      'ADR-0066 결정 6(구현의 선택: ADR-0061 결정 3의 #15 행은 기록과 본인의 최근 검색만 정했다)',
    // A member's recorded searches stay out of every public answer (ADR-0066's choice; the owner
    // decided they are recorded and shown to the member, and who else may see them is open, #37
    // item 11 for operators). A public shape never lists what was searched (`searches`,
    // `recentSearch`, `searchHistory`, `searchLog`, `searchTerms`, `searchQuery`) or when
    // (`searchedAt`, `lastSearched`), and a name that says the terms are
    // somebody's (`userQueries`, `myKeywords`, `viewerSearch`) is a person's. A public answer that
    // counted or ranked other people's terms ('인기 검색어') would be caught too: nothing decides it
    // may be public. The `q` a public request takes is the caller's own and is not an answer. The
    // member's own `GET /me/search-history` is an owner-only route, which this list does not read.
    fields: [
      ['searches'],
      ['searched'],
      ['recent', 'search'],
      ['search', 'history'],
      ['search', 'histories'],
      ['search', 'log'],
      ['search', 'logs'],
      ['search', 'query'],
      ['search', 'queries'],
      ['search', 'term'],
      ['search', 'terms'],
    ],
    owned: {
      words: ['search', 'query', 'queries', 'keyword', 'keywords'],
      whose: WHOSE_OR_VIEWER,
    },
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
  {
    id: 'market-maker',
    name: '시장별 운영 마켓메이커의 참여 여부·설정·재고·손익·위험',
    basis: 'ADR-0058(#180 결정 1의 20), N04 §2',
    // Admins see these (#182); the public sees neither whether a market has a bot nor its
    // budget, loss limit, b, ladder settings, inventory or risk.
    fields: [
      ['bot'],
      ['bots'],
      ['market', 'maker'],
      ['market', 'makers'],
      ['liquidity', 'b'],
      ['liquidity', 'setting'],
      ['liquidity', 'settings'],
      ['liquidity', 'config'],
      ['max', 'loss'],
      ['safety', 'ticks'],
      ['safety', 'spread'],
      ['inventory'],
      ['utilization'],
      ['allocated'],
      ['allocation'],
      ['vault'],
      ['treasury'],
      ['concentration'],
    ],
    pending: '운영 마켓메이커가 아직 없다(#72·#129·#182)',
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

/** The words of `owned` a name holds, whose first: `user fills`. */
function ownedIn(words: readonly string[], owned: PrivateData['owned']): string | undefined {
  const whose = words.find((word) => owned?.whose.includes(word));
  const thing = words.find((word) => owned?.words.includes(word));
  return whose === undefined || thing === undefined ? undefined : `${whose} ${thing}`;
}

/** The private data a field name carries. Empty when it is clean. */
export function findPrivateField(name: string): PrivateFieldHit[] {
  const words = identifierWords(name);
  return PRIVATE_DATA.flatMap((item) => {
    const owned = ownedIn(words, item.owned);
    return [
      ...item.fields
        .filter((run) => containsRun(words, run))
        .map((run) => ({ item: item.id, words: run.join(' ') })),
      ...(owned === undefined ? [] : [{ item: item.id, words: owned }]),
    ];
  });
}
