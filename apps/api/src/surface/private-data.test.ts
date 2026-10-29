/**
 * #113 at run time, against the docker `test` profile. Account A's private data is in the
 * database — email, nickname and time zone, its 본인확인 (verified phone, real name, the code's
 * hash), its start Coin (#70: the grant, its amount and the keyed hash of A's number), password
 * and session, a balance and a ledger memo, orders and the fill one of them got against another
 * account's resting order, a position with its PnL, a payment, two watched markets (#89), a
 * recorded search (#15), its consent records with the address and browser they came with, a
 * nickname it gave up (#58), a post with an image on the market it trades (#46), comments under
 * it (#48) and A's likes of both, made with the keyed hash of A's number (#49), a pinned notice
 * whose operator — its writer, editor and pinner, and its image's uploader — is A, with an earlier
 * version kept for operators, and a notice A wrote and never pinned, which is not public (#138),
 * a 소개 and an interest category on A's public profile (#41), an operator's hiding of A's post
 * with its reason (#50), a report A filed and a report another member filed on A's post (#50), a
 * writing restriction A was given and an operator lifted, with the lift's reason (#185), an
 * account restriction A was given and lifted, each step approved by another admin, and a request
 * to restrict A again that waits for its approval (#139). Then:
 * - every registered public route (registry.ts) is called anonymously, as another account B and
 *   as A itself, and no answer may hold one of A's values or a field PRIVATE_DATA names, nor a
 *   field naming an excluded feature or keeping a probability — except that a route registered
 *   as showing a person (`showsPerson`: a post's or a comment's author, a profile's member,
 *   ADR-0069 decision 5) may hold A's nickname and public id, and must, so the allowance is not
 *   vacuous;
 * - every registered owner-only route is called as B, aimed at A wherever it takes an id or an
 *   account — in its path, its query (a page cursor made from A's row) or its body — and no
 *   answer may hold A's values; the same request as A shows them, so the check is not blind
 *   (N04 §7 "다른 사용자가 비공개 자산·주문을 조회할 수 없어야 한다"). A's own answer is
 *   looked at for one more thing: it may not hold what nobody is shown (`NEVER_SHOWN`: the keyed
 *   hash of A's number, the code hash and client address of A's 본인확인, the client address and
 *   browser of A's consents, A's former nickname). The field names in it
 *   are not looked at: the excluded-feature names are the public API's (owner decision
 *   2026-10-14 #113);
 * - every better-auth route that answers with an account's data (AUTH_ROUTES `answersAccount`)
 *   is called anonymously and as B, aimed at A, and neither answer may hold A's values; A's own
 *   answer shows A's values and none of `NEVER_SHOWN`;
 * - the market room is listened to, anonymously and as B, while A's own events are published and
 *   smuggled onto the market channel and the API publishes a real market event.
 *
 * The routes come from the registry, which registry.test.ts holds to the module graph; this file
 * only knows how to call them. A route whose parameters, query keys or body it does not know
 * fails the run until a case is written here.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createApprovalRequest,
  createCategory,
  createConsents,
  createMarket,
  createMarketLink,
  createComment,
  createCommentLike,
  createMedia,
  createModerationAction,
  createNotice,
  createPhoneVerification,
  createPost,
  createPostLike,
  createProfileImage,
  createReport,
  createSearch,
  createStartGrant,
  createUser,
  createWatch,
} from '@buddha/db/test';
import {
  CONSENT_ITEMS,
  PAGE_LIMIT_MAX,
  currentConsentVersion,
  REALTIME_EVENT_REGISTRY,
  REALTIME_EXCEPTION_EVENT,
  REALTIME_NAMESPACE,
  encodeKeyset,
  findExcludedIdentifier,
  findPrivateField,
  marketChannel,
  namesPersonalProbability,
  type UserRealtimeEvent,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { AUTH, AUTH_BASE_PATH } from '../auth/auth.js';
import { PhoneHasher } from '../identity/phone-hash.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import {
  discoverAuthRoutes,
  discoverRoutes,
  queryKeysOf,
  type DiscoveredRoute,
} from '../test/routes.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep } from '../test/wait.js';
import { AUTH_ROUTES, OWNER_ROUTES, PUBLIC_ROUTES } from './registry.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const ORIGIN = 'http://localhost:3000';

type MarketRow = typeof schema.markets.$inferSelect;

/**
 * One of A's values. `text` is looked for anywhere in an answer (ids, addresses, names, keys);
 * `amount` is a whole number, and matches a JSON value equal to it or a number written into a
 * string or a key (numbersIn: '잔액은 7,654,321 Coin입니다', 'balance=7654321'), so a uuid that
 * happens to hold its digits is not a leak.
 */
interface Sentinel {
  readonly label: string;
  readonly value: string;
  readonly kind: 'text' | 'amount';
}

interface Fixture {
  a: TestUser;
  b: TestUser;
  admin: TestUser;
  /**
   * Open; A holds a position in it, has two orders in it and one fill, and watches it (#89) — so
   * every public call and market-room event about it runs against A's user id and nickname with
   * A among its watchers: a public answer naming who watches a market would carry them. An admin
   * linked it to one other open market (#65), which its 관련 시장 lists.
   */
  market: MarketRow;
  /** The open market linked to `market` (#65): the one item of `market`'s 관련 시장. */
  relatedMarket: MarketRow;
  /**
   * A's post on `market` with A's image in it (#46): what the post routes and the image route are
   * called with, so their answers name A as the author and serve A's upload.
   */
  post: { id: string; mediaId: string };
  /**
   * A's 댓글 under that post (#48), with a 대댓글 of A's under it: what the comment routes are called
   * with, so the comment list names A as an author and B's refused writes aim at A's comment.
   */
  comment: { id: string };
  /**
   * A pinned notice (#138) whose operator is A in every record the API keeps — A wrote, edited and
   * pinned it (`admin_actions`) and uploaded its image — though A holds no admin role: what the
   * notice routes are called with, so an answer naming the notice's operator would carry A.
   */
  notice: { id: string };
  /**
   * A's public id (#46): the profile route (#41) is called with it, so its answer is A's public
   * profile, and the person routes may show it.
   */
  publicId: string;
  /** A's 소개 (#41): public, shown on A's profile — not a sentinel. */
  bio: string;
  /**
   * A's profile image (#141): its id is in every public face of A (`imageUrl`), so the person
   * routes may show it and no other may — a sentinel like A's nickname and public id.
   */
  profileImageId: string;
  /**
   * Closed, and on A's watchlist alone (#89). Closed so no public call here lists it — `GET
   * /markets` is called without a query and lists open markets, and the detail routes are called
   * with `market` — and so its id or slug in an answer can only come from A's watch: a public
   * answer listing what A watches would carry them.
   */
  watched: MarketRow;
  /** The watched market's category slug, the value B's list is filtered by. */
  watchedCategory: string;
  /** A's recorded search (#15): the id B's delete names, its term a sentinel. */
  searchId: string;
  /** A's verified number (ADR-0070), digits: what B's code request names. */
  phone: string;
  /** An active category: what B's refused interest categories name (#58). */
  categoryId: number;
  paymentId: string;
  /** Page cursors made from A's rows: a page from there holds A's newest row and the older ones. */
  cursors: {
    ledger: string;
    orders: string;
    payments: string;
    watchlist: string;
    posts: string;
    comments: string;
    /** A's report (#50). */
    reports: string;
    /** The action an operator took on A (#50). */
    actions: string;
  };
  sentinels: readonly Sentinel[];
}

/** The cursor of a page that starts just after `row`, so the page holds it: A's row, by its id. */
function cursorAfter(row: { createdAt: Date; id: string | number }): string {
  return encodeKeyset({ createdAt: new Date(row.createdAt.getTime() + 1), id: String(row.id) });
}

/** The largest page, so A's page holds every row A has. */
const LIMIT = () => String(PAGE_LIMIT_MAX);

/** Letters only, so the value passes the real-name rule as typed by a person would. */
function letters(count: number): string {
  return Array.from({ length: count }, () => String.fromCharCode(97 + randomInt(26))).join('');
}

/**
 * A's amounts, seven digits each that no other number of a test answer is likely to be: they are
 * looked for inside text as well (leakedValues).
 */
const AMOUNTS = {
  available: 7_654_321n,
  locked: 4_826_159n,
  positionQty: 8_642_097,
  costBasis: 2_718_281n,
  realizedPnl: 3_141_593n,
  startGrant: 5_317_029n,
} as const;

/** The fill everyone may see: anonymous, so its numbers are public (N01 §5). */
const PUBLIC_FILL = { qty: 13, amountCoin: 793n, priceAvgBp: 6_100 } as const;

const routes = discoverRoutes();

function routeOf(key: string): DiscoveredRoute {
  const route = routes.find((candidate) => candidate.key === key);
  if (!route) throw new Error(`${key} is registered but not served (registry.test.ts says so)`);
  return route;
}

// ---- reading an answer ------------------------------------------------------------------

function walk(value: unknown, visit: (key: string | null, scalar: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      visit(key, undefined);
      walk(item, visit);
    }
  } else {
    visit(null, value);
  }
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

/**
 * A whole number written in text, plain or grouped by thousands, with or without a sign, a unit
 * or decimal zeros: '7654321', '7,654,321 Coin', '−3,141,593', 'balance=7654321', '7654321.00'.
 * Not the digits of a longer number ('17,654,321', '0.7654321', '7654321.5') or of a word or an
 * id ('a7654321', '7654321abc', a uuid's hex): no letter or digit of the Latin alphabet before it,
 * none after it but a 'Coin'.
 */
const NUMBER_IN_TEXT =
  /(?<![0-9A-Za-z]|\d[.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?!\d|[.,]\d|(?!Coin)[A-Za-z])/g;

/** The whole numbers `text` writes, as digits ('7,654,321 Coin' is '7654321'). */
function numbersIn(text: string): string[] {
  return [...text.matchAll(NUMBER_IN_TEXT)]
    .filter((m) => m[2] === undefined || /^0+$/.test(m[2]))
    .map((m) => m[1]!.replaceAll(',', ''));
}

/** The labels of the values an answer holds. */
function leakedValues(body: string, sentinels: readonly Sentinel[]): string[] {
  const numbers = new Set<string>();
  walk(parse(body), (key, scalar) => {
    if (key !== null) {
      for (const n of numbersIn(key)) numbers.add(n);
    } else if (typeof scalar === 'number') {
      numbers.add(String(scalar));
    } else if (typeof scalar === 'string') {
      numbers.add(scalar);
      for (const n of numbersIn(scalar)) numbers.add(n);
    }
  });
  return sentinels
    .filter((sentinel) =>
      sentinel.kind === 'text' ? body.includes(sentinel.value) : numbers.has(sentinel.value),
    )
    .map((sentinel) => sentinel.label);
}

function keysOf(body: string): Set<string> {
  const keys = new Set<string>();
  walk(parse(body), (key) => {
    if (key !== null) keys.add(key);
  });
  return keys;
}

/**
 * The fields of a public answer or event that carry private data, name an excluded feature or
 * keep a probability (N02 §10). Kept paid code answers 404 while sales are closed, so paid
 * purchase is looked for too.
 */
function forbiddenFields(body: string): string[] {
  return [...keysOf(body)].flatMap((key) => [
    ...findPrivateField(key).map((hit) => `${key}: ${hit.item}`),
    ...findExcludedIdentifier(key, 'api').map((hit) => `${key}: ${hit.feature}`),
    ...(namesPersonalProbability(key) ? [`${key}: personal probability`] : []),
  ]);
}

// ---- the cases ---------------------------------------------------------------------------

/**
 * Path parameters of the public routes, by name: A's market, A's post and the image in it, the
 * notice A operated, and A's public id (the profile).
 */
const PUBLIC_PARAMS: Readonly<Record<string, (fixture: Fixture) => string>> = {
  id: (fixture) => fixture.market.id,
  idOrSlug: (fixture) => fixture.market.slug,
  postId: (fixture) => fixture.post.id,
  mediaId: (fixture) => fixture.post.mediaId,
  // A's 댓글, whose 대댓글 the reply page reads (#48, '답글 더 보기').
  commentId: (fixture) => fixture.comment.id,
  noticeId: (fixture) => fixture.notice.id,
  publicId: (fixture) => fixture.publicId,
};

/**
 * What a route that shows a person (`showsPerson`, ADR-0069 decision 5) may hold of A, the author
 * of the post it shows or the member of the profile: A's nickname — the current one (#37-3) —, A's
 * public id and A's profile image (#141, #37-6: its address). Nothing else of A: the account id,
 * the email and every other value stay sentinels there as everywhere.
 */
const PERSON_LABELS: readonly string[] = ['nickname', 'public id', 'profile image'];

/** A post body B sends in its refused writes: one paragraph, nothing of A's. */
const B_POST_BODY = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B의 근거' }] }],
};

/** Bodies of the public routes that take one: A's own address, the request most about A. */
const PUBLIC_BODIES: Readonly<Record<string, (fixture: Fixture) => unknown>> = {
  'POST /auth/register': (fixture) => ({ email: fixture.a.email }),
};

/**
 * A's values no answer may hold, A's own included: what the server keeps about A but never shows
 * anyone — the keyed hash of A's number (ADR-0071: the identity that outlives the number, and the
 * key of every per-number limit), and the 본인확인 sends' code hash and client address
 * (ADR-0070). The response envelope strips nothing, so whatever a service returns goes out; this
 * is what catches a `phoneHash` added to `Me.startGrant` or a grant row echoed whole.
 */
const NEVER_SHOWN: readonly string[] = [
  'phone hash',
  'verification code hash',
  'verification client address',
  // #58: the consent record's client address and browser are the record's alone, and a nickname
  // given up is never shown again (#37-3) — A's own `GET /me` included.
  'consent client address',
  'consent user agent',
  'released nickname',
  // #46: what is kept of A's posts for operators only (#45-4, #45-5) — an earlier version an edit
  // replaced and a post A deleted — whoever asks, A included.
  'post revision',
  'deleted post',
  // #48: the same of A's comments — an earlier version and a deleted 댓글 that shows as its
  // placeholder ('삭제된 글입니다', a 대댓글 under it).
  'comment revision',
  'deleted comment',
  // #138: an earlier version of a notice, kept for operators only, and a notice A wrote and never
  // pinned — only a pinned notice is public (owner decision 2026-10-21).
  'notice revision',
  'unpinned notice',
  // #50: a report on A's post another member filed — nobody but operators reads it, A least of
  // all (#45-13: the reporter is never shown to the member reported) — and the operator who acted
  // on A (#45-13), whose account id is in no answer.
  'report on A',
  'moderator id',
  // #185: why an operator lifted or shortened A's writing restriction — the operators' record;
  // A reads the end as it stands, that it was lifted early or shortened and the end it was given
  // (owner decision 2026-10-23 answer 4), nothing of who changed it or why (ADR-0082).
  'lift reason',
  // #139: who approved A's account restriction and its lift and why, why it was lifted, and a
  // request to restrict A that no admin approved yet — the operators' record; A reads the
  // restriction, its reason, its end and that it was lifted, never who asked or approved (#139
  // «건 운영자는 보이지 않는다»), and nothing that is not in force (ADR-0085).
  'approver id',
  'approval reason',
  'account lift reason',
  'pending restriction request',
  // The operators' memo on a request to restrict A (owner decision 2026-10-23: never the
  // member's), and a request to restrict A its operator retracted: neither is ever A's to read.
  'account restriction memo',
  'retracted restriction request',
];

interface OwnerCase {
  /** Path parameters by name, naming A's records. */
  params?: Readonly<Record<string, (fixture: Fixture) => string>>;
  /**
   * Query parameters by name, one for every key the route reads (queryKeysOf): A's records or A
   * wherever a key can name one — a page cursor made from A's row, A's id.
   */
  query?: Readonly<Record<string, (fixture: Fixture) => string>>;
  /**
   * What B sends: A's account wherever the body names one. JSON, or — a Buffer — the bytes
   * themselves under `contentType`.
   */
  body?: (fixture: Fixture) => unknown;
  /** The type of a body sent as bytes (`body` a Buffer). */
  contentType?: string;
  /** B's answer. */
  status: number;
  /**
   * A's values the same request shows A: proof they were there to leak. Left out for a
   * write, which would change A.
   */
  own?: readonly string[];
}

const OWNER_CASES: Readonly<Record<string, OwnerCase>> = {
  'GET /me': {
    status: 200,
    own: [
      'email',
      'nickname',
      'profile image',
      'time zone',
      'real name',
      'phone',
      'available balance',
      'locked balance',
      'start grant amount',
    ],
  },
  // B's cookie naming A's account: refused before anything is read or written (#58) — A's
  // nickname stays and no change of B's is spent (below).
  'PATCH /me': {
    body: (fixture) => ({ nickname: `b_${letters(8)}`, expectedAccountId: fixture.a.id }),
    status: 403,
  },
  // B's cookie naming A's account: nobody's consent is recorded, nobody's nickname set and no
  // start Coin granted (below).
  'POST /me/consents': {
    body: (fixture) => ({
      consents: Object.fromEntries(
        CONSENT_ITEMS.map((item) => [item, { version: currentConsentVersion(item), agreed: true }]),
      ),
      expectedAccountId: fixture.a.id,
    }),
    status: 403,
  },
  'POST /me/onboarding/nickname': {
    body: (fixture) => ({ nickname: `b_${letters(8)}`, expectedAccountId: fixture.a.id }),
    status: 403,
  },
  // The account check refuses both before the service reads anything (no OnboardedGuard: the
  // service asks the onboarding for the step's first answer or a new value only, ADR-0078). The
  // skip — what the onboarding screen sends when it is left — answers nobody's step either.
  'POST /me/onboarding/interests': {
    body: (fixture) => ({ categoryIds: [], expectedAccountId: fixture.a.id }),
    status: 403,
  },
  'PUT /me/interest-categories': {
    body: (fixture) => ({ categoryIds: [fixture.categoryId], expectedAccountId: fixture.a.id }),
    status: 403,
  },
  'POST /me/password': {
    body: (fixture) => ({ newPassword: 'another-password-1', expectedAccountId: fixture.a.id }),
    status: 403,
  },
  // B's cookie naming A's account (and A's number): refused before a code is drawn or texted, a
  // confirmation looked up or a name written — A's record stays and nobody was texted (below).
  'POST /me/phone-verification/code': {
    body: (fixture) => ({
      realName: '다른사람',
      phone: fixture.phone,
      expectedAccountId: fixture.a.id,
    }),
    status: 403,
  },
  'POST /me/phone-verification/confirm': {
    body: (fixture) => ({ code: '123456', expectedAccountId: fixture.a.id }),
    status: 403,
  },
  'PUT /me/real-name': {
    body: (fixture) => ({ realName: '다른사람', expectedAccountId: fixture.a.id }),
    status: 403,
  },
  // B's cookie naming A's account (#41): the account check refuses it before anything is read or
  // written — A's 소개 stays (below).
  'PUT /me/bio': {
    body: (fixture) => ({ bio: 'B가 쓴 소개', expectedAccountId: fixture.a.id }),
    status: 403,
  },
  // B's cookie naming A's account (#141): the file is the body, so the account rides in the query —
  // refused before the body is looked at; nothing is stored and A's image stays A's (below). Sent
  // as an image, as a post's upload is: the route takes no JSON (415 before any check of the
  // account — image-body.ts).
  'PUT /me/profile-image': {
    query: { expectedAccountId: (fixture) => fixture.a.id },
    body: () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    contentType: 'image/jpeg',
    status: 403,
  },
  // B's cookie naming A's account (#141): refused before anything is read — A's image stays, row
  // and object (below).
  'POST /me/profile-image/delete': {
    body: (fixture) => ({ expectedAccountId: fixture.a.id }),
    status: 403,
  },
  // B's cookie naming A's account: refused before anything is written, and A's zone stays (below).
  'PUT /me/time-zone': {
    body: (fixture) => ({ timeZone: 'Europe/Paris', expectedAccountId: fixture.a.id }),
    status: 403,
  },
  'GET /me/ledger': {
    query: { cursor: (fixture) => fixture.cursors.ledger, limit: LIMIT },
    status: 200,
    own: ['ledger memo', 'start grant id', 'start grant amount'],
  },
  'GET /me/payments': {
    query: { cursor: (fixture) => fixture.cursors.payments, limit: LIMIT },
    status: 200,
    own: ['payment id'],
  },
  'GET /me/payments/:id': {
    params: { id: (fixture) => fixture.paymentId },
    status: 404,
    own: ['payment id'],
  },
  'GET /me/positions': {
    query: { status: () => 'open' },
    status: 200,
    own: ['position qty', 'cost basis', 'realized pnl'],
  },
  'GET /me/orders': {
    query: { cursor: (fixture) => fixture.cursors.orders, limit: LIMIT },
    status: 200,
    own: ['filled order id', 'open order id'],
  },
  // B's list, paged from A's watch in the order that cursor was made for (최근 관심 등록 순) and
  // filtered to the watched market's status and category: B watches nothing, so nothing of A's
  // may come back.
  'GET /me/watchlist': {
    query: {
      cursor: (fixture) => fixture.cursors.watchlist,
      limit: LIMIT,
      status: (fixture) => fixture.watched.status,
      category: (fixture) => fixture.watchedCategory,
      sort: () => 'watched',
    },
    status: 200,
    own: ['watched market id', 'watched market slug'],
  },
  // B asking about A's watched market answers B's own state, false (checked below): the answer
  // is a yes or no with no market in it, so no `own` label can show the check is not blind.
  'GET /me/watchlist/:marketId': {
    params: { marketId: (fixture) => fixture.watched.id },
    status: 200,
  },
  // B's cookie naming A's account, unwatching A's market: refused before anything is written,
  // and A's watch and its history stay (below).
  'PUT /me/watchlist/:marketId': {
    params: { marketId: (fixture) => fixture.watched.id },
    body: (fixture) => ({ watched: false, expectedAccountId: fixture.a.id }),
    status: 403,
  },
  // B's recent searches: B searched nothing, so nothing of A's may come back (#15, ADR-0066).
  'GET /me/search-history': {
    status: 200,
    own: ['search term', 'search id'],
  },
  // B's cookie naming A's account: refused before anything is written — B's term lands in
  // nobody's history, A's included (below).
  'POST /me/search-history': {
    body: (fixture) => ({ query: 'b-search', expectedAccountId: fixture.a.id }),
    status: 403,
  },
  // B's cookie naming A's account and A's entry: refused, and A's search stays (below). B naming
  // itself is checked there too: the entry is looked up among B's own rows only.
  'POST /me/search-history/:id/delete': {
    params: { id: (fixture) => fixture.searchId },
    body: (fixture) => ({ expectedAccountId: fixture.a.id }),
    status: 403,
  },
  'POST /me/search-history/clear': {
    body: (fixture) => ({ expectedAccountId: fixture.a.id }),
    status: 403,
  },
  // B's cookie naming A's account (#46): refused before anything is read or written — no post of
  // B's, A's post as it was (below). B naming itself on A's post is refused there too.
  'POST /posts': {
    body: (fixture) => ({
      marketId: fixture.market.id,
      title: 'B의 글',
      body: B_POST_BODY,
      expectedAccountId: fixture.a.id,
    }),
    status: 403,
  },
  'PUT /posts/:postId': {
    params: { postId: (fixture) => fixture.post.id },
    body: (fixture) => ({
      title: 'B가 고친 글',
      body: B_POST_BODY,
      expectedAccountId: fixture.a.id,
    }),
    status: 403,
  },
  'POST /posts/:postId/delete': {
    params: { postId: (fixture) => fixture.post.id },
    body: (fixture) => ({ expectedAccountId: fixture.a.id }),
    status: 403,
  },
  // B's cookie naming A's account (#48): refused before anything is read or written — no comment
  // of B's, A's comment as it was (below). B naming itself on A's comment is refused there too.
  'POST /posts/:postId/comments': {
    params: { postId: (fixture) => fixture.post.id },
    body: (fixture) => ({
      parentId: fixture.comment.id,
      body: 'B의 대댓글',
      expectedAccountId: fixture.a.id,
    }),
    status: 403,
  },
  'PUT /comments/:commentId': {
    params: { commentId: (fixture) => fixture.comment.id },
    body: (fixture) => ({ body: 'B가 고친 댓글', expectedAccountId: fixture.a.id }),
    status: 403,
  },
  'POST /comments/:commentId/delete': {
    params: { commentId: (fixture) => fixture.comment.id },
    body: (fixture) => ({ expectedAccountId: fixture.a.id }),
    status: 403,
  },
  // B's cookie naming A's account (#49), taking back A's likes: refused before anything is read
  // or written — A's likes stay, B has none (below).
  'PUT /posts/:postId/like': {
    params: { postId: (fixture) => fixture.post.id },
    body: (fixture) => ({ liked: false, expectedAccountId: fixture.a.id }),
    status: 403,
  },
  'PUT /comments/:commentId/like': {
    params: { commentId: (fixture) => fixture.comment.id },
    body: (fixture) => ({ liked: false, expectedAccountId: fixture.a.id }),
    status: 403,
  },
  // B asking what it liked on A's post, which A liked with A's comment: B's own state, nothing
  // (checked below). The answer is yes or no and comment ids, public ones, so no `own` label can
  // show the check is not blind; below, A hears A's.
  'GET /me/likes/posts/:postId': {
    params: { postId: (fixture) => fixture.post.id },
    status: 200,
  },
  // B's MY 내 글 (#51), paged from A's newest post and comment — the hidden ones, which only A's
  // own list shows: B wrote nothing, so nothing of A's may come back. A's own shows A's hidden
  // post and comment (#45-5) and never what A deleted (`NEVER_SHOWN`).
  'GET /me/posts': {
    query: { cursor: (fixture) => fixture.cursors.posts, limit: LIMIT },
    status: 200,
    // #50: the hiding's reason, the operator's explanation among it (ADR-0080).
    own: ['hidden post', 'moderation note'],
  },
  'GET /me/comments': {
    query: { cursor: (fixture) => fixture.cursors.comments, limit: LIMIT },
    status: 200,
    own: ['hidden comment'],
  },
  // B's cookie naming A's account (#50), reporting A's post, comment and profile: refused before
  // anything is read or written — no report of B's (below). B's own report is checked there too.
  'POST /posts/:postId/reports': {
    params: { postId: (fixture) => fixture.post.id },
    body: (fixture) => ({ reason: 'spam', expectedAccountId: fixture.a.id }),
    status: 403,
  },
  'POST /comments/:commentId/reports': {
    params: { commentId: (fixture) => fixture.comment.id },
    body: (fixture) => ({ reason: 'spam', expectedAccountId: fixture.a.id }),
    status: 403,
  },
  'POST /profiles/:publicId/reports': {
    params: { publicId: (fixture) => fixture.publicId },
    body: (fixture) => ({ reason: 'impersonation', expectedAccountId: fixture.a.id }),
    status: 403,
  },
  // B's reports and the actions taken on B (#50), paged from A's: B has none, so nothing of A's
  // may come back. A's own show A's report and the operator's reason on A's hidden post — never
  // the report another member filed on A's post, nor the operator (`NEVER_SHOWN`).
  'GET /me/reports': {
    query: { cursor: (fixture) => fixture.cursors.reports, limit: LIMIT },
    status: 200,
    own: ['report description'],
  },
  'GET /me/moderation/actions': {
    query: { cursor: (fixture) => fixture.cursors.actions, limit: LIMIT },
    status: 200,
    // #185: a writing restriction's explanation too — never the reason an operator lifted it for.
    // #139: an account restriction's explanation — never who approved it, nor why it was lifted.
    own: ['moderation note', 'restriction note', 'account restriction note'],
  },
  // B's restrictions now (#185, #139): B has none — A's (lifted) never answer for B, nor the
  // request to restrict A that waits for its approval.
  'GET /me/moderation/restriction': {
    status: 200,
  },
  // The file is the body, so the account rides in the query: B naming A is refused before the
  // file is looked at, and nothing is stored (below). Sent as an image: the route takes no JSON
  // (415 before any check of the account — image-body.ts). Said to be a notice's (#185 owner
  // decision 2026-10-23 answer 13: an admin's alone), it is refused the same, before that.
  'POST /media/images': {
    query: { expectedAccountId: (fixture) => fixture.a.id, purpose: () => 'notice' },
    body: () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    contentType: 'image/jpeg',
    status: 403,
  },
  'POST /payments/charge': {
    body: (fixture) => ({
      packageId: randomUUID(),
      expectedAmountCoin: '10000',
      expectedPriceKrw: 9_700,
      expectedAccountId: fixture.a.id,
    }),
    status: 404,
  },
  'POST /coupons/redeem': {
    body: (fixture) => ({ code: 'LEAK-CHECK', expectedAccountId: fixture.a.id }),
    status: 404,
  },
};

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** A request to a better-auth route. */
interface AuthRequest {
  query?: Readonly<Record<string, string>>;
  body?: unknown;
}

interface AuthCase {
  /** What an anonymous caller and B send: A's account wherever it takes one. */
  request?: (fixture: Fixture) => AuthRequest;
  /** Their answers. */
  status: { anonymous: number; B: number };
  /**
   * What A sends to see its own data (the same request when left out), and the labels of A's
   * values it shows: proof they were there to leak. Left out where that would change A, or where
   * nothing of A's could show (A has no provider account).
   */
  own?: { request?: (fixture: Fixture) => AuthRequest; labels: readonly string[] };
}

const WRONG_PASSWORD = 'not-the-password-1';

/** The better-auth routes that answer with an account's data (AUTH_ROUTES `answersAccount`). */
const AUTH_CASES: Readonly<Record<string, AuthCase>> = {
  'POST /sign-in/social': {
    // Only a provider's genuine ID token for A could sign in as A. A provider no environment
    // configures keeps the answer the same whatever a developer's .env holds.
    request: () => ({ body: { provider: 'github', idToken: { token: 'forged-id-token' } } }),
    status: { anonymous: 404, B: 404 },
  },
  'GET /get-session': {
    status: { anonymous: 200, B: 200 },
    own: { labels: ['user id', 'email'] },
  },
  'POST /get-session': {
    // Refused while the deferred session refresh is off (AUTH_ROUTES).
    status: { anonymous: 405, B: 405 },
  },
  'POST /sign-in/email': {
    request: (fixture) => ({ body: { email: fixture.a.email, password: WRONG_PASSWORD } }),
    status: { anonymous: 401, B: 401 },
    own: {
      request: (fixture) => ({ body: { email: fixture.a.email, password: fixture.a.password } }),
      labels: ['user id', 'email'],
    },
  },
  'GET /verify-email': {
    request: () => ({ query: { token: 'forged-token' } }),
    status: { anonymous: 401, B: 401 },
  },
  'POST /change-password': {
    request: () => ({
      body: { currentPassword: WRONG_PASSWORD, newPassword: 'another-password-1' },
    }),
    status: { anonymous: 401, B: 400 },
  },
  'POST /update-session': {
    request: (fixture) => ({ body: { userId: fixture.a.id } }),
    status: { anonymous: 401, B: 400 },
  },
  'GET /list-sessions': {
    status: { anonymous: 401, B: 200 },
    own: { labels: ['user id'] },
  },
  'GET /list-accounts': {
    status: { anonymous: 401, B: 200 },
    own: { labels: ['user id', 'account id'] },
  },
};

/** The parameter names of a route: `id` of `/me/payments/:id`. */
const paramsOf = (route: DiscoveredRoute) => [...route.url.matchAll(/:(\w+)/g)].map((m) => m[1]!);

/** Each parameter's value for this fixture. */
function valuesOf(
  params: Readonly<Record<string, (fixture: Fixture) => string>> | undefined,
  fixture: Fixture,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params ?? {}).map(([name, value]) => [name, value(fixture)]),
  );
}

describe('reading an answer for A’s values (static)', () => {
  const sentinels: readonly Sentinel[] = [
    { label: 'available balance', value: String(AMOUNTS.available), kind: 'amount' },
    { label: 'realized pnl', value: String(AMOUNTS.realizedPnl), kind: 'amount' },
    { label: 'position qty', value: String(AMOUNTS.positionQty), kind: 'amount' },
  ];
  const leaks = (answer: unknown) => leakedValues(JSON.stringify(answer), sentinels);

  it('finds an amount as a JSON value, a whole string, or written into a string', () => {
    expect(leaks({ availableCoin: 7_654_321 })).toEqual(['available balance']);
    expect(leaks({ availableCoin: '7654321' })).toEqual(['available balance']);
    // Formatted or explained: thousands separators, the Coin unit, a sign, decimal zeros.
    for (const message of [
      '잔액은 7,654,321 Coin입니다',
      'balance=7654321',
      '7,654,321Coin',
      '(7654321)',
      'id-7654321',
      '7654321.00',
    ]) {
      expect(leaks({ message }), message).toEqual(['available balance']);
    }
    for (const message of ['손익 −3,141,593 Coin', 'pnl: -3141593', '+3,141,593']) {
      expect(leaks({ message }), message).toEqual(['realized pnl']);
    }
    expect(leaks({ error: { message: `수량 ${(8_642_097).toLocaleString('en-US')}개` } })).toEqual([
      'position qty',
    ]);
    // A body that is not JSON is read as one string.
    expect(leakedValues('available: 7,654,321 Coin', sentinels)).toEqual(['available balance']);
  });

  it('does not take the digits of another number or of an id for an amount', () => {
    for (const message of [
      '17654321',
      '76543210',
      '7,654,3210',
      '17,654,321',
      '0.7654321',
      '7654321.5',
      'a7654321b',
      'v7654321',
      '7654321abc',
      '3.141593',
    ]) {
      expect(leaks({ message }), message).toEqual([]);
    }
    // An id's hex digits, at the start of a group or anywhere in it.
    expect(leaks({ id: '07654321-4b1a-4c1a-9c1a-7654321abcde' })).toEqual([]);
  });
});

describe('private data cases (static)', () => {
  // So a route nobody wrote a case for fails without a database too.
  it('knows how to call every registered public route', () => {
    const missing = Object.keys(PUBLIC_ROUTES).flatMap((key) => {
      const route = routeOf(key);
      return [
        ...paramsOf(route)
          .filter((name) => !(name in PUBLIC_PARAMS))
          .map((name) => `${key} :${name}`),
        ...(SAFE_METHODS.has(route.method) || key in PUBLIC_BODIES ? [] : [`${key} body`]),
      ];
    });
    expect(missing).toEqual([]);
  });

  it('has a case for every better-auth route that answers with an account’s data', () => {
    expect(Object.keys(AUTH_CASES).sort()).toEqual(
      Object.entries(AUTH_ROUTES)
        .filter(([, entry]) => entry.answersAccount === true)
        .map(([key]) => key)
        .sort(),
    );
  });

  it('has a cross-account case for every registered owner-only route', () => {
    expect(Object.keys(OWNER_CASES).sort()).toEqual(Object.keys(OWNER_ROUTES).sort());
    const missing = Object.entries(OWNER_CASES).flatMap(([key, ownerCase]) => {
      const route = routeOf(key);
      return [
        ...paramsOf(route)
          .filter((name) => !(name in (ownerCase.params ?? {})))
          .map((name) => `${key} :${name}`),
        // Every query key the route reads, so a key that may name A is called with A's.
        ...queryKeysOf(route)
          .filter((name) => !(name in (ownerCase.query ?? {})))
          .map((name) => `${key} ?${name}`),
        ...(SAFE_METHODS.has(route.method) || ownerCase.body ? [] : [`${key} body`]),
      ];
    });
    expect(missing).toEqual([]);
  });
});

describe.skipIf(!hasTestInfra)('private data in public and owner-only answers (#113)', () => {
  let t: TestApp;
  let f: Fixture;
  const sockets: ClientSocket[] = [];

  beforeAll(async () => {
    // Listening: the realtime case needs a real socket.io handshake; inject() serves the rest.
    t = await createTestApp({ listen: true });
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    f = await seed();
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  /** An active category of its own, when the reset left none (#58's interest categories). */
  async function createCategoryRow(): Promise<number> {
    return (await createCategory(t.db)).id;
  }

  async function seed(): Promise<Fixture> {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const a = await signUpTestUser(t, {
      email: `leak-a-${tag}@test.local`,
      password: `pw-${tag}-secret`,
    });
    const b = await signUpTestUser(t);
    const admin = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    // An admin finishes the onboarding like any account before /admin answers it (ADR-0072).
    await completeOnboarding(t.db, { userId: admin.id });
    await t.app.get(AdminGuard).invalidate(admin.id);

    const nickname = `leak_${tag}`;
    // A zone nobody else here picks (B's refused write in OWNER_CASES sends Europe/Paris), so its
    // name in an answer can only be A's.
    const timeZone = 'Pacific/Chatham';
    await t.db
      .update(schema.profiles)
      .set({ nickname, timeZone })
      .where(eq(schema.profiles.userId, a.id));
    // A's 본인확인 (ADR-0070): the record, and the code it was confirmed with (its hash and the
    // address it was asked from sentinels too: nobody but A may see whether, when, how or from
    // where A verified — and no route shows A the address either).
    const realName = `숨김${letters(8)}`;
    const phone = `010${String(randomInt(10_000_000, 100_000_000))}`;
    await createPhoneVerification(t.db, { userId: a.id, realName, phone });
    const codeHash = randomUUID().replaceAll('-', '').repeat(2);
    const clientIp = `2001:db8::${randomInt(0x1000, 0x10000).toString(16)}:${randomInt(0x1000, 0x10000).toString(16)}`;
    await t.db.insert(schema.phoneVerificationCodes).values({
      id: randomUUID(),
      userId: a.id,
      phone,
      realName,
      codeHash,
      expiresAt: new Date(Date.now() + 180_000),
      consumedAt: new Date(),
      clientIp,
    });

    // A's start Coin (#70, ADR-0071), paid: its amount and grant id are A's wallet, and the
    // keyed hash of A's number is nobody's to see, A's own answers included (`NEVER_SHOWN`).
    const phoneHash = t.app.get(PhoneHasher).hash(phone);
    const startGrant = await createStartGrant(t.db, {
      userId: a.id,
      phoneHash,
      amountCoin: AMOUNTS.startGrant,
    });

    // A's consents (#58), each with the address and browser it came with (sentinels: nobody, A
    // included, is shown them), and a nickname A gave up (#37-3: never shown again). B has done
    // the onboarding, so its refused writes behind OnboardedGuard reach the account check.
    const consentIp = `2001:db8::${randomInt(0x1000, 0x10000).toString(16)}:${randomInt(0x1000, 0x10000).toString(16)}`;
    const consentAgent = `LeakBrowser/${tag}`;
    await createConsents(t.db, {
      userId: a.id,
      marketing: true,
      clientIp: consentIp,
      userAgent: consentAgent,
    });
    const releasedNickname = `gone_${tag}`;
    await t.db.insert(schema.nicknameHolds).values({ nickname: releasedNickname, userId: a.id });
    await completeOnboarding(t.db, { userId: b.id });
    const [category] = await t.db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(eq(schema.categories.isActive, true))
      .limit(1);
    const categoryId = category?.id ?? (await createCategoryRow());
    // A's public profile items (#41): a 소개 and an interest category, which A's profile shows to
    // everyone — so its answer has them for the field checks, and B's refused writes aim at them.
    const bio = `A의 소개 ${tag}\n둘째 줄`;
    await t.db.update(schema.profiles).set({ bio }).where(eq(schema.profiles.userId, a.id));
    await t.db.insert(schema.profileInterestCategories).values({ userId: a.id, categoryId });
    // A's profile image (#141), its object in the test's store: every public face of A carries its
    // address, so its id is A's to show on the `showsPerson` routes only (its label joins
    // PERSON_LABELS).
    const profileImage = await createProfileImage(t.db, { userId: a.id, contentType: 'image/png' });
    await t.storage.put(
      profileImage.storageKey,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'image/png',
    );

    // The balance as the books would have it: the change is an ADMIN_ADJUST entry.
    const [before] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, a.id));
    const memo = `leak-memo-${tag}`;
    await t.db
      .update(schema.balances)
      .set({ availableCoin: AMOUNTS.available, lockedCoin: AMOUNTS.locked })
      .where(eq(schema.balances.userId, a.id));
    const [entry] = await t.db
      .insert(schema.ledgerEntries)
      .values({
        userId: a.id,
        type: 'ADMIN_ADJUST',
        amountCoin: AMOUNTS.available - before!.availableCoin,
        balanceAfterCoin: AMOUNTS.available,
        memo,
      })
      .returning();

    const market = await createMarket(t.db, {
      createdBy: admin.id,
      lastPrice: 61,
      volumeCoin: PUBLIC_FILL.amountCoin,
      tradeCount: 1,
    });
    // The other side of A's fill: a resting order of a third account (the counterparty).
    const maker = await createUser(t.db);
    const order = (values: {
      userId: string;
      side: 'buy' | 'sell';
      type: 'limit' | 'market';
      qty: number;
      filledQty?: number;
      key: string;
    }) =>
      t.db
        .insert(schema.orders)
        .values({
          userId: values.userId,
          marketId: market.id,
          outcome: 'YES',
          side: values.side,
          type: values.type,
          limitPrice: values.type === 'limit' ? (values.side === 'sell' ? 61 : 40) : null,
          qty: values.qty,
          filledQty: values.filledQty ?? 0,
          status: values.filledQty === values.qty ? 'filled' : 'open',
          timeInForce: values.type === 'limit' ? 'gtc' : 'ioc',
          idempotencyKey: values.key,
        })
        .returning()
        .then((rows) => rows[0]!);
    const makerKey = `leak-maker-${tag}`;
    const filledKey = `leak-filled-${tag}`;
    const openKey = `leak-open-${tag}`;
    const resting = await order({
      userId: maker.user.id,
      side: 'sell',
      type: 'limit',
      qty: 1_000,
      key: makerKey,
    });
    const filled = await order({
      userId: a.id,
      side: 'buy',
      type: 'market',
      qty: PUBLIC_FILL.qty,
      filledQty: PUBLIC_FILL.qty,
      key: filledKey,
    });
    const open = await order({ userId: a.id, side: 'buy', type: 'limit', qty: 21, key: openKey });
    await t.db.insert(schema.fills).values({
      marketId: market.id,
      orderId: filled.id,
      counterpartyType: 'order',
      counterpartyOrderId: resting.id,
      outcome: 'YES',
      side: 'buy',
      qty: PUBLIC_FILL.qty,
      amountCoin: PUBLIC_FILL.amountCoin,
      priceAvgBp: PUBLIC_FILL.priceAvgBp,
    });
    await t.db.insert(schema.positions).values({
      userId: a.id,
      marketId: market.id,
      outcome: 'YES',
      qty: AMOUNTS.positionQty,
      costBasisCoin: AMOUNTS.costBasis,
      realizedPnlCoin: AMOUNTS.realizedPnl,
    });

    // A's watches (#89), each with its `watch` event: a closed market nobody else watches, whose
    // id and slug are sentinels (a public list of A's watches), and the market every public call
    // reads (a public list of a market's watchers). The second is newer, so the cursor below,
    // which starts just after the first, leaves it out of every page as well as the status does.
    const watched = await createMarket(t.db, { createdBy: admin.id, status: 'closed' });
    const [watchedCategory] = await t.db
      .select({ slug: schema.categories.slug })
      .from(schema.categories)
      .where(eq(schema.categories.id, watched.categoryId));
    const watch = await createWatch(t.db, { userId: a.id, marketId: watched.id });
    await createWatch(t.db, {
      userId: a.id,
      marketId: market.id,
      watchedAt: new Date(watch.watch.watchedAt.getTime() + 1_000),
    });

    // 관련 시장 (#65): A's market linked by the admin to another open market, so `GET
    // /markets/:id/related` answers an item rather than an empty page — its field names are then
    // checked like every public answer's, and its values against A's. Not linked to the watched
    // market: a closed one would be listed, and its id is A's sentinel.
    const related = await createMarket(t.db, { createdBy: admin.id });
    await createMarketLink(t.db, {
      marketId: market.id,
      relatedMarketId: related.id,
      createdBy: admin.id,
    });

    // A's post (#46) on the market A trades, with A's image in it (its object in the test's
    // store): the post routes name A as its author — A's nickname and public id, which those
    // routes may show (`showsPerson`) and no other may — and the image route serves A's upload.
    const media = await createMedia(t.db, { ownerId: a.id, contentType: 'image/png' });
    await t.storage.put(media.storageKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png');
    const post = await createPost(t.db, {
      marketId: market.id,
      authorId: a.id,
      title: `A의 근거 ${tag}`,
      imageIds: [media.id],
    });
    const [{ publicId } = { publicId: '' }] = await t.db
      .select({ publicId: schema.profiles.publicId })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, a.id));
    // What is kept of A's posts for operators only (#45-4, #45-5): an earlier version of that
    // post, as an edit leaves it, and a post A deleted with nothing under it. Neither is anyone's
    // to read through the API, A's included (`NEVER_SHOWN`).
    const revisionText = `leak-revision-${tag}`;
    await t.db.insert(schema.postRevisions).values({
      postId: post.id,
      title: revisionText,
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: revisionText }] }],
      },
      bodyText: revisionText,
      imageIds: [],
      writtenAt: new Date(post.createdAt.getTime() - 60_000),
    });
    const deletedText = `leak-deleted-${tag}`;
    await createPost(t.db, {
      marketId: market.id,
      authorId: a.id,
      title: deletedText,
      text: deletedText,
      deletedAt: new Date(),
    });

    // A's comments under that post (#48): a 댓글 with A's 대댓글 under it, which the comment list
    // shows with A as their author; a 댓글 A deleted that shows as its placeholder (a 대댓글 hangs
    // under it) and an earlier version of A's 댓글, as an edit leaves it — both A's words that are
    // nobody's to read through the API, A's included (`NEVER_SHOWN`).
    const comment = await createComment(t.db, {
      postId: post.id,
      authorId: a.id,
      body: `A의 댓글 ${tag}`,
    });
    await createComment(t.db, { postId: post.id, authorId: a.id, parentId: comment.id });
    const commentRevisionText = `leak-comment-revision-${tag}`;
    await t.db.insert(schema.postCommentRevisions).values({
      commentId: comment.id,
      body: commentRevisionText,
      writtenAt: new Date(comment.createdAt.getTime() - 60_000),
    });
    const deletedCommentText = `leak-deleted-comment-${tag}`;
    const deletedComment = await createComment(t.db, {
      postId: post.id,
      authorId: a.id,
      body: deletedCommentText,
      // After A's other 댓글, so the list's order (oldest first) is the expectation's.
      createdAt: new Date(comment.createdAt.getTime() + 1_000),
      deletedAt: new Date(),
    });
    await createComment(t.db, { postId: post.id, authorId: a.id, parentId: deletedComment.id });
    // A's likes (#49) of A's own post and 댓글 — allowed — held by A's account and the keyed hash
    // of A's number, as LikesService writes them: who liked is nobody's to see, and the hash is
    // nobody's either (`NEVER_SHOWN`), whatever answer counts them. Each item's count has them;
    // A's profile total leaves them out (owner decision 2026-10-21 answer 3, ADR-0078).
    await createPostLike(t.db, { postId: post.id, userId: a.id, phoneHash });
    await createCommentLike(t.db, { commentId: comment.id, userId: a.id, phoneHash });
    // A's post an operator hid, with A's 댓글 under it that was hidden too (#45-5): A's words that
    // only A reads, on MY 내 글 (#51) — every public list leaves them out, and the post page and
    // the comment list would show them as placeholders. A's newest post and comment, so the
    // cursors below start from them.
    const hiddenPostText = `leak-hidden-post-${tag}`;
    const hiddenPost = await createPost(t.db, {
      marketId: market.id,
      authorId: a.id,
      title: hiddenPostText,
      text: hiddenPostText,
      createdAt: new Date(post.createdAt.getTime() + 2_000),
      hiddenAt: new Date(),
    });
    const hiddenCommentText = `leak-hidden-comment-${tag}`;
    const hiddenComment = await createComment(t.db, {
      postId: hiddenPost.id,
      authorId: a.id,
      body: hiddenCommentText,
      createdAt: new Date(comment.createdAt.getTime() + 2_000),
      hiddenAt: new Date(),
    });
    // The operator's hiding of that post (#50), with the explanation A reads on MY 내 글 and on MY's
    // record of actions — never the operator, and never anywhere public (`moderation`).
    const moderationNote = `leak-moderation-note-${tag}`;
    const hiding = await createModerationAction(t.db, {
      userId: a.id,
      createdBy: admin.id,
      postId: hiddenPost.id,
      reason: 'harassment',
      note: moderationNote,
    });
    // A writing restriction A was given before that (#185, ADR-0082) — 30 days, lifted early the
    // next day — with the explanation A reads on MY's record of actions: A's alone, never anywhere
    // public (#45-12, #37-8: an internal risk flag). The operator's reason for the lift is the
    // operators' record only, A's own answers included (`NEVER_SHOWN`).
    const restrictionNote = `leak-restriction-note-${tag}`;
    const restrictedAt = new Date(hiding.createdAt.getTime() - 10 * 24 * 60 * 60 * 1_000);
    const liftedAt = new Date(restrictedAt.getTime() + 24 * 60 * 60 * 1_000);
    const restriction = await createModerationAction(t.db, {
      userId: a.id,
      createdBy: admin.id,
      type: 'writing_restriction',
      reason: 'spam',
      note: restrictionNote,
      createdAt: restrictedAt,
      endsAt: liftedAt,
    });
    const liftReason = `leak-lift-reason-${tag}`;
    await t.db.insert(schema.restrictionEndChanges).values({
      actionId: restriction.id,
      kind: 'lift',
      previousEndsAt: new Date(restrictedAt.getTime() + 30 * 24 * 60 * 60 * 1_000),
      endsAt: liftedAt,
      reason: liftReason,
      createdBy: admin.id,
      createdAt: liftedAt,
    });
    // An account restriction A was given before that (#139, ADR-0085) — 7 days, lifted early two
    // days in — each step asked for by the admin and approved by another (ADR-0056 1-7), with the
    // explanation A reads on MY's record of actions: A's alone, never anywhere public (#37-8). Who
    // approved, why, and why it was lifted are the operators' record only, A's own answers
    // included (`NEVER_SHOWN`); so is a request to restrict A again, pending — not in force — with
    // the operators' memo on it (owner decision 2026-10-23), and one its operator retracted.
    const { user: approver } = await createUser(t.db, { role: 'admin' });
    const approvalReason = `leak-approval-reason-${tag}`;
    const accountNote = `leak-account-restriction-note-${tag}`;
    const accountAt = new Date(hiding.createdAt.getTime() - 5 * 24 * 60 * 60 * 1_000);
    const accountLiftedAt = new Date(accountAt.getTime() + 2 * 24 * 60 * 60 * 1_000);
    const accountRestriction = await createModerationAction(t.db, {
      userId: a.id,
      createdBy: admin.id,
      approvedBy: approver.id,
      type: 'account_restriction',
      reason: 'multi_account',
      note: accountNote,
      createdAt: accountAt,
      endsAt: accountLiftedAt,
    });
    const accountLiftReason = `leak-account-lift-reason-${tag}`;
    const accountLift = await createApprovalRequest(t.db, {
      kind: 'account_restriction_lift',
      targetType: 'moderation_action',
      targetId: accountRestriction.id,
      payload: { userId: a.id, actionId: accountRestriction.id },
      requestedBy: admin.id,
      reason: accountLiftReason,
      requestedAt: new Date(accountLiftedAt.getTime() - 60_000),
      decision: {
        status: 'approved',
        by: approver.id,
        reason: approvalReason,
        at: accountLiftedAt,
      },
    });
    await t.db.insert(schema.restrictionEndChanges).values({
      actionId: accountRestriction.id,
      kind: 'lift',
      previousEndsAt: new Date(accountAt.getTime() + 7 * 24 * 60 * 60 * 1_000),
      endsAt: accountLiftedAt,
      reason: accountLiftReason,
      createdBy: admin.id,
      createdAt: accountLiftedAt,
      approvalId: accountLift.id,
    });
    const pendingRestriction = `leak-pending-restriction-${tag}`;
    const accountMemo = `leak-account-restriction-memo-${tag}`;
    await createApprovalRequest(t.db, {
      kind: 'account_restriction',
      targetType: 'user',
      targetId: a.id,
      payload: {
        userId: a.id,
        reason: 'spam',
        note: pendingRestriction,
        days: 7,
        subject: null,
        memo: accountMemo,
      },
      requestedBy: admin.id,
      reason: pendingRestriction,
    });
    const retractedRestriction = `leak-retracted-restriction-${tag}`;
    await createApprovalRequest(t.db, {
      kind: 'account_restriction',
      targetType: 'user',
      targetId: a.id,
      payload: {
        userId: a.id,
        reason: 'spam',
        note: retractedRestriction,
        days: 3,
        subject: null,
        memo: null,
      },
      requestedBy: admin.id,
      reason: retractedRestriction,
      retracted: {},
    });
    // A report A filed on another member's profile (#50), with A's description: A's own record,
    // nobody else's. And a report the admin filed on A's post, pending: nobody but operators reads
    // it, A included (`NEVER_SHOWN`, #45-13).
    const reportText = `leak-report-${tag}`;
    const report = await createReport(t.db, {
      reporterId: a.id,
      reportedUserId: maker.user.id,
      reporterPhoneHash: phoneHash,
      reason: 'other',
      description: reportText,
    });
    const reportOnA = `leak-report-on-a-${tag}`;
    await createReport(t.db, {
      reporterId: admin.id,
      reportedUserId: a.id,
      postId: post.id,
      reason: 'other',
      description: reportOnA,
    });

    // A notice (#138) A operated, pinned, with A's image in it (its object in the test's store)
    // and an earlier version kept for operators: the notice routes are called with it, and
    // nothing of its operator — A — may ride on them. A is no admin; the records are written here
    // as the admin routes write them, so whatever a notice answer might read of its operator
    // would be A's.
    const noticeMedia = await createMedia(t.db, { ownerId: a.id, contentType: 'image/png' });
    await t.storage.put(
      noticeMedia.storageKey,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'image/png',
    );
    const notice = await createNotice(t.db, {
      title: `운영 공지 ${tag}`,
      imageIds: [noticeMedia.id],
      editedAt: new Date(),
      pinSlot: 1,
    });
    const noticeRevisionText = `leak-notice-revision-${tag}`;
    await t.db.insert(schema.noticeRevisions).values({
      noticeId: notice.id,
      title: noticeRevisionText,
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: noticeRevisionText }] }],
      },
      bodyText: noticeRevisionText,
      imageIds: [],
      writtenAt: notice.createdAt,
    });
    await t.db.insert(schema.adminActions).values(
      (['notice_create', 'notice_update', 'notice_pin'] as const).map((type) => ({
        adminId: a.id,
        type,
        targetType: 'notice',
        targetId: notice.id,
      })),
    );
    // And a notice A wrote and never pinned: not public, so no answer may hold its words — the
    // fixed area lists the pinned one alone (owner decision 2026-10-21, ADR-0077).
    const unpinnedNoticeText = `leak-unpinned-notice-${tag}`;
    const unpinnedNotice = await createNotice(t.db, {
      title: unpinnedNoticeText,
      text: unpinnedNoticeText,
    });
    await t.db.insert(schema.adminActions).values({
      adminId: a.id,
      type: 'notice_create',
      targetType: 'notice',
      targetId: unpinnedNotice.id,
    });

    // A's search (#15): a term nobody else types, and no market's title holds it.
    const searchTerm = `leak-search-${tag}`;
    const search = await createSearch(t.db, { userId: a.id, query: searchTerm });

    const paymentKey = `leak-payment-${tag}`;
    const [payment] = await t.db
      .insert(schema.payments)
      .values({
        userId: a.id,
        amountCoin: 10_000n,
        priceKrw: 9_700,
        provider: 'mock',
        status: 'succeeded',
        approvedAt: new Date(),
        idempotencyKey: paymentKey,
      })
      .returning();

    const [session] = await t.db
      .select({ token: schema.session.token })
      .from(schema.session)
      .where(eq(schema.session.userId, a.id));
    const [account] = await t.db
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(eq(schema.account.userId, a.id));

    const text = (label: string, value: string): Sentinel => ({ label, value, kind: 'text' });
    const amount = (label: string, value: bigint | number): Sentinel => ({
      label,
      value: String(value),
      kind: 'amount',
    });
    return {
      a,
      b,
      admin,
      market,
      watched,
      relatedMarket: related,
      post: { id: post.id, mediaId: media.id },
      comment: { id: comment.id },
      notice: { id: notice.id },
      publicId,
      bio,
      profileImageId: profileImage.id,
      watchedCategory: watchedCategory!.slug,
      searchId: search.id,
      phone,
      categoryId,
      paymentId: payment!.id,
      cursors: {
        ledger: cursorAfter(entry!),
        // The later of A's two orders, so the page holds both.
        orders: cursorAfter(open.createdAt >= filled.createdAt ? open : filled),
        payments: cursorAfter(payment!),
        watchlist: cursorAfter({ createdAt: watch.watch.watchedAt, id: watched.id }),
        posts: cursorAfter(hiddenPost),
        comments: cursorAfter(hiddenComment),
        reports: cursorAfter(report),
        actions: cursorAfter(hiding),
      },
      sentinels: [
        text('user id', a.id),
        text('email', a.email),
        text('nickname', nickname),
        text('public id', publicId),
        text('profile image', profileImage.id),
        text('post revision', revisionText),
        text('deleted post', deletedText),
        text('comment revision', commentRevisionText),
        text('deleted comment', deletedCommentText),
        text('notice revision', noticeRevisionText),
        text('unpinned notice', unpinnedNoticeText),
        text('hidden post', hiddenPostText),
        text('hidden comment', hiddenCommentText),
        text('moderation note', moderationNote),
        text('restriction note', restrictionNote),
        text('lift reason', liftReason),
        text('account restriction note', accountNote),
        text('approver id', approver.id),
        text('approval reason', approvalReason),
        text('account lift reason', accountLiftReason),
        text('pending restriction request', pendingRestriction),
        text('account restriction memo', accountMemo),
        text('retracted restriction request', retractedRestriction),
        text('report description', reportText),
        text('report on A', reportOnA),
        text('moderator id', admin.id),
        text('time zone', timeZone),
        text('real name', realName),
        text('phone', phone),
        text('verification code hash', codeHash),
        text('verification client address', clientIp),
        text('consent client address', consentIp),
        text('consent user agent', consentAgent),
        text('released nickname', releasedNickname),
        text('password', a.password),
        text('session token', session!.token),
        text('account id', account!.id),
        text('ledger memo', memo),
        text('filled order id', filled.id),
        text('open order id', open.id),
        text('filled order key', filledKey),
        text('open order key', openKey),
        text('counterparty user id', maker.user.id),
        text('counterparty email', maker.user.email),
        text('counterparty order id', resting.id),
        text('counterparty order key', makerKey),
        text('payment id', payment!.id),
        text('payment key', paymentKey),
        text('watched market id', watched.id),
        text('watched market slug', watched.slug),
        text('search term', searchTerm),
        text('search id', search.id),
        text('start grant id', startGrant.id),
        text('phone hash', phoneHash),
        amount('start grant amount', AMOUNTS.startGrant),
        amount('available balance', AMOUNTS.available),
        amount('locked balance', AMOUNTS.locked),
        amount('position qty', AMOUNTS.positionQty),
        amount('cost basis', AMOUNTS.costBasis),
        amount('realized pnl', AMOUNTS.realizedPnl),
      ],
    };
  }

  function call(
    route: DiscoveredRoute,
    input: {
      params?: Record<string, string>;
      query?: Record<string, string>;
      body?: unknown;
      /** The type of a body that is bytes (a Buffer); JSON otherwise. */
      contentType?: string;
      cookie?: string;
    },
  ) {
    const query = new URLSearchParams(input.query ?? {}).toString();
    const url = `${route.url.replaceAll(/:(\w+)/g, (_, name: string) => {
      const value = input.params?.[name];
      if (value === undefined) {
        throw new Error(`no value for :${name} of ${route.key}: add it to this file's cases`);
      }
      return encodeURIComponent(value);
    })}${query === '' ? '' : `?${query}`}`;
    const safe = SAFE_METHODS.has(route.method);
    if (!safe && input.body === undefined) {
      throw new Error(`no body for ${route.key}: add it to this file's cases`);
    }
    const bytes = Buffer.isBuffer(input.body) ? input.body : undefined;
    return t.app.inject({
      method: route.method as 'GET',
      url,
      headers: {
        origin: ORIGIN,
        ...(safe
          ? {}
          : {
              'content-type': bytes
                ? (input.contentType ?? 'application/octet-stream')
                : 'application/json',
            }),
        ...(input.cookie ? { cookie: input.cookie } : {}),
      },
      ...(safe ? {} : { payload: bytes ?? JSON.stringify(input.body) }),
    });
  }

  /** The labels of A's values an answer holds. */
  const leaked = (body: string) => leakedValues(body, f.sentinels);

  // ---- public routes ----------------------------------------------------------------------

  it('answers every public route without A’s private data, whoever asks', async () => {
    const answers: { route: string; caller: string; status: number; leaks: string[] }[] = [];
    const bodies = new Map<string, string>();
    const persons: { route: string; caller: string; shown: string[] }[] = [];
    for (const key of Object.keys(PUBLIC_ROUTES)) {
      // A route that shows a person (ADR-0069 decision 5) may hold A's nickname and public id as
      // the author it shows; every other value of A — the account id first — is still a leak.
      const allowed = PUBLIC_ROUTES[key]!.showsPerson === undefined ? [] : PERSON_LABELS;
      for (const [caller, cookie] of [
        ['anonymous', undefined],
        ['B', f.b.cookie],
        ['A', f.a.cookie],
      ] as const) {
        const res = await call(routeOf(key), {
          params: valuesOf(PUBLIC_PARAMS, f),
          body: PUBLIC_BODIES[key]?.(f),
          cookie,
        });
        if (caller === 'anonymous') bodies.set(key, res.body);
        const held = leaked(res.body);
        if (allowed.length > 0) {
          persons.push({
            route: key,
            caller,
            shown: held.filter((label) => allowed.includes(label)),
          });
        }
        answers.push({
          route: key,
          caller,
          // Kept paid code answers 404 while paid Coin is off; everything else answers, so
          // the check below read a real answer and not an error.
          status: res.statusCode,
          leaks: [
            ...held.filter((label) => !allowed.includes(label)),
            ...forbiddenFields(res.body),
          ],
        });
      }
    }
    expect(answers).toEqual(
      answers.map(({ route, caller }) => ({
        route,
        caller,
        status: PUBLIC_ROUTES[route]!.preservedPaid ? 404 : 200,
        leaks: [],
      })),
    );
    // The allowance is not vacuous: every route that may show a person showed A, the author of
    // the post it was called with, to everyone — the list and the post page (#46), the post's
    // comments and a comment's reply page (#48) and the 토론 of the market the post is on (#47) —
    // and A's profile showed A (#41), each with A's profile image (#141).
    expect(persons.map(({ route }) => route)).toEqual(
      expect.arrayContaining([
        'GET /posts',
        'GET /posts/:postId',
        'GET /posts/:postId/comments',
        'GET /comments/:commentId/replies',
        'GET /markets/:id/posts',
        'GET /profiles/:publicId',
        'GET /profiles/:publicId/posts',
        'GET /profiles/:publicId/comments',
      ]),
    );
    expect(persons).toEqual(
      persons.map(({ route, caller }) => ({ route, caller, shown: PERSON_LABELS })),
    );
    // The post routes answered A's post, and the image route served A's upload.
    const listed = parse(bodies.get('GET /posts')!) as { data: { id: string }[] };
    expect(listed.data.map((row) => row.id)).toEqual([f.post.id]);
    // The market's 토론 (#47) answered the same card and counted it alone: A's deleted post is in
    // neither its cards nor its count.
    const discussion = parse(bodies.get('GET /markets/:id/posts')!) as {
      data: { id: string }[];
      meta: { total: number };
    };
    expect(discussion.data.map((row) => row.id)).toEqual([f.post.id]);
    expect(discussion.meta.total).toBe(1);
    expect(parse(bodies.get('GET /posts/:postId')!)).toMatchObject({
      data: { state: 'published', id: f.post.id },
    });
    expect(bodies.get('GET /media/:mediaId')).toContain('PNG');
    // The notice routes answered the notice A operated (#138): the fixed area lists it and its
    // page shows it — with nothing of A, whose values the check above found in neither.
    const pinned = parse(bodies.get('GET /notices')!) as { data: { id: string }[] };
    expect(pinned.data.map((row) => row.id)).toEqual([f.notice.id]);
    expect(parse(bodies.get('GET /notices/:noticeId')!)).toMatchObject({
      data: { id: f.notice.id },
    });
    // A's profile image is served the same way, to anyone (#141).
    const profileImage = await t.app.inject({
      method: 'GET',
      url: `/api/v1/media/${f.profileImageId}`,
    });
    expect(profileImage.statusCode).toBe(200);
    expect(profileImage.body).toContain('PNG');
    // The comment route answered A's 댓글 with its 대댓글 and the placeholder of the deleted one.
    const threads = parse(bodies.get('GET /posts/:postId/comments')!) as {
      data: {
        comment: { state: string; id: string };
        replies: { state: string }[];
        repliesNextCursor: string | null;
      }[];
    };
    expect(
      threads.data.map(({ comment, replies, repliesNextCursor }) => ({
        state: comment.state,
        id: comment.id,
        replies: replies.map((reply) => reply.state),
        repliesNextCursor,
      })),
    ).toEqual([
      { state: 'published', id: f.comment.id, replies: ['published'], repliesNextCursor: null },
      {
        state: 'deleted',
        id: expect.any(String) as unknown,
        replies: ['published'],
        repliesNextCursor: null,
      },
    ]);
    // The reply page answered A's 대댓글 under A's 댓글, A named as its author (above).
    const replyPage = parse(bodies.get('GET /comments/:commentId/replies')!) as {
      data: { state: string; parentId: string }[];
    };
    expect(replyPage.data).toEqual([
      expect.objectContaining({ state: 'published', parentId: f.comment.id }),
    ]);
    // The placeholder object is its id alone, read off the raw answer: no author or time rides on
    // it. (A page cursor is the (time, id) of the page's last row, a placeholder's too when one
    // ends a page — ADR-0074 7-10; here none does.)
    expect(threads.data[1]?.comment).toEqual({
      state: 'deleted',
      id: expect.any(String) as unknown,
    });
    // The profile route answered A's profile with its public items (#41) — the 소개 and the
    // category — and counted A's visible posts (not the deleted one) and comments (the 댓글, its
    // 대댓글 and the 대댓글 under the deleted 댓글), so its field names were checked on a full answer.
    // The two likes they hold are A's own, which the total the member received leaves out (owner
    // decision 2026-10-21 answer 3).
    expect(parse(bodies.get('GET /profiles/:publicId')!)).toMatchObject({
      data: {
        member: {
          kind: 'member',
          publicId: f.publicId,
          imageUrl: `/api/v1/media/${f.profileImageId}`,
          isAdmin: false,
        },
        bio: f.bio,
        interestCategories: [expect.objectContaining({ slug: expect.any(String) as unknown })],
        postCount: 1,
        commentCount: 3,
        receivedLikeCount: 0,
      },
    });
    // The profile's lists (#51) answered A's post and A's three comments the profile counts — not
    // the deleted ones, nor the hidden post and comment — newest first, so their field names were
    // checked on full answers.
    const profilePosts = parse(bodies.get('GET /profiles/:publicId/posts')!) as {
      data: { id: string }[];
    };
    expect(profilePosts.data.map((row) => row.id)).toEqual([f.post.id]);
    const profileComments = parse(bodies.get('GET /profiles/:publicId/comments')!) as {
      data: { id: string; post: { state: string; id: string } }[];
    };
    expect(profileComments.data).toHaveLength(3);
    expect(profileComments.data.map(({ post }) => [post.state, post.id])).toEqual(
      Array.from({ length: 3 }, () => ['published', f.post.id]),
    );
    expect(profileComments.data.map((row) => row.id)).toContain(f.comment.id);
    // The answers held A's market, A's fill and the market linked to A's — anonymously — so there
    // was something to leak, and the 관련 시장 answer's item had its field names checked rather
    // than an empty page passing for one.
    expect(bodies.get('GET /markets')).toContain(f.market.id);
    const related = parse(bodies.get('GET /markets/:id/related')!) as { data: { id: string }[] };
    expect(related.data.map((row) => row.id)).toEqual([f.relatedMarket.id]);
    const fills = parse(bodies.get('GET /markets/:id/fills')!) as { data: object[] };
    expect(fills.data).toEqual([
      expect.objectContaining({
        qty: PUBLIC_FILL.qty,
        amountCoin: String(PUBLIC_FILL.amountCoin),
        priceAvgBp: PUBLIC_FILL.priceAvgBp,
      }),
    ]);
  });

  // ---- better-auth ------------------------------------------------------------------------

  it('serves the better-auth routes AUTH_ROUTES registers, as the app is configured here', () => {
    // registry.test.ts lists them from an instance built like the app's; this is the app's own.
    expect(
      discoverAuthRoutes(t.app.get(AUTH))
        .map((route) => route.key)
        .sort(),
    ).toEqual(Object.keys(AUTH_ROUTES).sort());
  });

  /** A better-auth route, called the way the browser does: same origin, JSON. */
  function callAuth(key: string, request: AuthRequest, cookie?: string) {
    const [method, path] = key.split(' ') as [string, string];
    const query = new URLSearchParams(request.query ?? {}).toString();
    const safe = SAFE_METHODS.has(method);
    return t.app.inject({
      method: method as 'GET',
      url: `${AUTH_BASE_PATH}${path}${query === '' ? '' : `?${query}`}`,
      headers: {
        origin: ORIGIN,
        ...(safe ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      ...(safe ? {} : { payload: JSON.stringify(request.body ?? {}) }),
    });
  }

  it('never answers anyone but A with A’s data on a better-auth route, and A’s data is there', async () => {
    const answers: { route: string; caller: string; status: number; leaks: string[] }[] = [];
    const shown: { route: string; status: number; missing: string[]; shownAnyway: string[] }[] = [];
    for (const [key, authCase] of Object.entries(AUTH_CASES)) {
      const request = authCase.request?.(f) ?? {};
      for (const [caller, cookie] of [
        ['anonymous', undefined],
        ['B', f.b.cookie],
      ] as const) {
        const res = await callAuth(key, request, cookie);
        answers.push({ route: key, caller, status: res.statusCode, leaks: leaked(res.body) });
      }
      if (authCase.own) {
        const own = await callAuth(key, authCase.own.request?.(f) ?? request, f.a.cookie);
        const held = leaked(own.body);
        shown.push({
          route: key,
          status: own.statusCode,
          missing: authCase.own.labels.filter((label) => !held.includes(label)),
          shownAnyway: held.filter((label) => NEVER_SHOWN.includes(label)),
        });
      }
    }
    expect(answers).toEqual(
      answers.map(({ route, caller }) => ({
        route,
        caller,
        status: AUTH_CASES[route]!.status[caller as 'anonymous' | 'B'],
        leaks: [],
      })),
    );
    expect(shown).toEqual(
      shown.map(({ route }) => ({ route, status: 200, missing: [], shownAnyway: [] })),
    );
    // B's session read answered with B: the request reached a session at all.
    expect((await callAuth('GET /get-session', {}, f.b.cookie)).body).toContain(f.b.email);
  });

  // ---- owner-only routes ------------------------------------------------------------------

  it('never answers B with A’s data on an owner-only route, and A’s data is there', async () => {
    const password = () =>
      t.db
        .select({ hash: schema.account.password })
        .from(schema.account)
        .where(eq(schema.account.userId, f.a.id))
        .then((rows) => rows.map((row) => row.hash));
    const passwordBefore = await password();
    // #58: what B's refused onboarding writes would have written — consents, a nickname and its
    // hold, a start grant, interest categories — as it stands before them.
    const onboardingState = () =>
      Promise.all([
        t.db.select().from(schema.consentRecords).orderBy(schema.consentRecords.id),
        t.db
          .select({
            userId: schema.profiles.userId,
            nickname: schema.profiles.nickname,
            confirmed: schema.profiles.nicknameConfirmedAt,
            changed: schema.profiles.nicknameChangedAt,
            interests: schema.profiles.interestsAnsweredAt,
            bio: schema.profiles.bio,
            // #141: the image B's refused upload and deletion would have changed.
            image: schema.profiles.imageId,
          })
          .from(schema.profiles)
          .orderBy(schema.profiles.userId),
        t.db.select().from(schema.nicknameHolds).orderBy(schema.nicknameHolds.id),
        t.db.select().from(schema.startGrants).orderBy(schema.startGrants.id),
        t.db.select().from(schema.profileInterestCategories),
      ]);
    const onboardingBefore = await onboardingState();
    // #46: what B's refused post writes and upload would have written — posts, their history,
    // uploads and their objects — as it stands before them.
    const postState = async () => [
      ...(await Promise.all([
        t.db.select().from(schema.posts).orderBy(schema.posts.id),
        t.db.select().from(schema.postRevisions),
        t.db.select().from(schema.mediaObjects).orderBy(schema.mediaObjects.id),
        t.db.select().from(schema.postImages),
        // #48: the comments and their history B's refused comment writes would have written.
        t.db.select().from(schema.postComments).orderBy(schema.postComments.id),
        t.db.select().from(schema.postCommentRevisions),
        // #49: the likes B's refused unlikes would have taken back.
        t.db.select().from(schema.postLikes),
        t.db.select().from(schema.commentLikes),
        // #50: the reports B's refused reports would have written.
        t.db.select().from(schema.reports).orderBy(schema.reports.id),
        t.db.select().from(schema.moderationActions).orderBy(schema.moderationActions.id),
      ])),
      [...t.storage.objects.keys()].sort(),
    ];
    const postsBefore = await postState();
    const answers: { route: string; status: number; leaks: string[] }[] = [];
    const shown: { route: string; status: number; missing: string[]; shownAnyway: string[] }[] = [];
    for (const key of Object.keys(OWNER_ROUTES)) {
      const ownerCase = OWNER_CASES[key];
      if (!ownerCase) continue; // the case above names it
      const route = routeOf(key);
      const params = valuesOf(ownerCase.params, f);
      const query = valuesOf(ownerCase.query, f);
      const res = await call(route, {
        params,
        query,
        body: ownerCase.body?.(f),
        contentType: ownerCase.contentType,
        cookie: f.b.cookie,
      });
      answers.push({ route: key, status: res.statusCode, leaks: leaked(res.body) });
      if (ownerCase.own) {
        const own = await call(route, { params, query, cookie: f.a.cookie });
        const held = leaked(own.body);
        shown.push({
          route: key,
          status: own.statusCode,
          missing: ownerCase.own.filter((label) => !held.includes(label)),
          // GET /me and GET /me/ledger read the start grant: its amount and id are A's, its hash
          // is nobody's.
          shownAnyway: held.filter((label) => NEVER_SHOWN.includes(label)),
        });
      }
    }
    expect(answers).toEqual(
      answers.map(({ route }) => ({ route, status: OWNER_CASES[route]!.status, leaks: [] })),
    );
    expect(shown).toEqual(
      shown.map(({ route }) => ({ route, status: 200, missing: [], shownAnyway: [] })),
    );

    // B's refused writes changed nothing of A's: A's record and code stay, B has no code (its
    // record is its own onboarding's, #58), and nobody was texted (ADR-0070).
    const sentinel = (label: string) => f.sentinels.find((s) => s.label === label)!.value;
    expect(
      await t.db
        .select({
          userId: schema.phoneVerifications.userId,
          realName: schema.phoneVerifications.realName,
          phone: schema.phoneVerifications.phone,
        })
        .from(schema.phoneVerifications)
        .where(eq(schema.phoneVerifications.userId, f.a.id)),
    ).toEqual([{ userId: f.a.id, realName: sentinel('real name'), phone: sentinel('phone') }]);
    // The admin's record is its own onboarding's too (ADR-0072: /admin asks for it).
    expect(
      (await t.db.select().from(schema.phoneVerifications)).map((row) => row.userId).sort(),
    ).toEqual([f.a.id, f.b.id, f.admin.id].sort());
    expect(
      await t.db
        .select({ userId: schema.phoneVerificationCodes.userId })
        .from(schema.phoneVerificationCodes),
    ).toEqual([{ userId: f.a.id }]);
    expect(t.sms.messages).toEqual([]);
    const [profile] = await t.db
      .select({ timeZone: schema.profiles.timeZone })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, f.a.id));
    expect(profile?.timeZone).toBe(sentinel('time zone'));
    expect(passwordBefore).toHaveLength(1);
    expect(await password()).toEqual(passwordBefore);
    // B's refused consent, nickname, change, interests step and interest categories changed
    // nobody's (#58), nor did its 소개 (#41).
    expect(await onboardingState()).toEqual(onboardingBefore);

    // B's refused unwatch left A's watches and their `watch` events, and wrote nothing for B. B
    // asking about that market heard its own state, and A hears A's (#89).
    const watches = await t.db
      .select()
      .from(schema.marketWatches)
      .orderBy(schema.marketWatches.watchedAt);
    expect(watches.map((row) => ({ userId: row.userId, marketId: row.marketId }))).toEqual([
      { userId: f.a.id, marketId: f.watched.id },
      { userId: f.a.id, marketId: f.market.id },
    ]);
    const events = await t.db
      .select()
      .from(schema.marketWatchEvents)
      .orderBy(schema.marketWatchEvents.id);
    expect(
      events.map((row) => ({ userId: row.userId, marketId: row.marketId, action: row.action })),
    ).toEqual([
      { userId: f.a.id, marketId: f.watched.id, action: 'watch' },
      { userId: f.a.id, marketId: f.market.id, action: 'watch' },
    ]);
    const stateRoute = routeOf('GET /me/watchlist/:marketId');
    const params = { marketId: f.watched.id };
    const stateOf = async (cookie: string) =>
      (await call(stateRoute, { params, cookie })).json<{ data: unknown }>().data;
    expect(await stateOf(f.b.cookie)).toEqual({ watched: false });
    expect(await stateOf(f.a.cookie)).toEqual({ watched: true });

    // B's refused unlikes left A's likes (in `postState` below), and B asking what it liked on A's
    // post heard its own nothing while A hears A's (#49).
    const likesRoute = routeOf('GET /me/likes/posts/:postId');
    const likesOf = async (cookie: string) =>
      (await call(likesRoute, { params: { postId: f.post.id }, cookie })).json<{ data: unknown }>()
        .data;
    expect(await likesOf(f.b.cookie)).toEqual({ postLiked: false, likedCommentIds: [] });
    expect(await likesOf(f.a.cookie)).toEqual({
      postLiked: true,
      likedCommentIds: [f.comment.id],
    });

    // B's refused writes left A's search and wrote nothing for B (#15). B's delete naming A's
    // entry as B itself is accepted and reaches nothing: the entry is looked up among B's rows.
    const searches = () =>
      t.db
        .select({ userId: schema.marketSearches.userId, query: schema.marketSearches.query })
        .from(schema.marketSearches);
    const aSearch = { userId: f.a.id, query: sentinel('search term') };
    expect(await searches()).toEqual([aSearch]);
    const asB = await call(routeOf('POST /me/search-history/:id/delete'), {
      params: { id: f.searchId },
      body: { expectedAccountId: f.b.id },
      cookie: f.b.cookie,
    });
    expect(asB.statusCode).toBe(200);
    expect(asB.json<{ data: unknown }>().data).toEqual([]);
    expect(await searches()).toEqual([aSearch]);

    // B's refused post writes and upload wrote nothing (#46). B naming itself on A's post is
    // refused too — only its author changes a post — and A's post stays as it was.
    expect(await postState()).toEqual(postsBefore);
    for (const [key, body] of [
      [
        'PUT /posts/:postId',
        { title: 'B가 고친 글', body: B_POST_BODY, expectedAccountId: f.b.id },
      ],
      ['POST /posts/:postId/delete', { expectedAccountId: f.b.id }],
    ] as const) {
      const res = await call(routeOf(key), {
        params: { postId: f.post.id },
        body,
        cookie: f.b.cookie,
      });
      expect({ key, status: res.statusCode, leaks: leaked(res.body) }).toEqual({
        key,
        status: 403,
        leaks: [],
      });
    }
    // The same of A's comment (#48): only its author changes it.
    for (const [key, body] of [
      ['PUT /comments/:commentId', { body: 'B가 고친 댓글', expectedAccountId: f.b.id }],
      ['POST /comments/:commentId/delete', { expectedAccountId: f.b.id }],
    ] as const) {
      const res = await call(routeOf(key), {
        params: { commentId: f.comment.id },
        body,
        cookie: f.b.cookie,
      });
      expect({ key, status: res.statusCode, leaks: leaked(res.body) }).toEqual({
        key,
        status: 403,
        leaks: [],
      });
    }
    expect(await postState()).toEqual(postsBefore);

    // B reporting A's post as B itself is taken (#50), and its answer — B's own report — holds
    // nothing of A's but what the public reads of the post (its title and start, not sentinels).
    const reported = await call(routeOf('POST /posts/:postId/reports'), {
      params: { postId: f.post.id },
      body: { reason: 'spam', expectedAccountId: f.b.id },
      cookie: f.b.cookie,
    });
    expect({ status: reported.statusCode, leaks: leaked(reported.body) }).toEqual({
      status: 201,
      leaks: [],
    });
    const mine = await call(routeOf('GET /me/reports'), { cookie: f.b.cookie });
    expect({ status: mine.statusCode, leaks: leaked(mine.body) }).toEqual({
      status: 200,
      leaks: [],
    });
  });

  // ---- the market room --------------------------------------------------------------------

  async function openSocket(cookie?: string): Promise<ClientSocket> {
    const socket = io(`${t.url!}${REALTIME_NAMESPACE}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      ...(cookie ? { extraHeaders: { cookie, origin: ORIGIN } } : {}),
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not connect')), 5_000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('connect_error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return socket;
  }

  /**
   * Subscribes and waits until the gateway has applied it: `marketIds: []` is refused, and the
   * gateway handles one socket's messages in order (market.gateway.test.ts `roundTrip`). The
   * refusal it waited for is returned: a direct send (REALTIME_EMITS), read like any answer.
   */
  async function subscribe(socket: ClientSocket, marketId: string): Promise<unknown> {
    socket.emit('subscribe', { marketIds: [marketId] });
    const refused = new Promise<unknown>((resolve) => {
      socket.once(REALTIME_EXCEPTION_EVENT, (payload: unknown) => resolve(payload));
    });
    socket.emit('subscribe', { marketIds: [] });
    return refused;
  }

  it('keeps the market room public: none of A’s events, values or fields reach it', async () => {
    const watchers = { anonymous: await openSocket(), B: await openSocket(f.b.cookie) };
    const received: { watcher: string; event: string; payload: unknown }[] = [];
    for (const [watcher, socket] of Object.entries(watchers)) {
      const refusal = JSON.stringify(await subscribe(socket, f.market.id));
      // The refusal envelope a socket is sent directly carries nothing of A's either.
      expect({
        watcher,
        refusal,
        leaks: [...leaked(refusal), ...forbiddenFields(refusal)],
      }).toEqual({
        watcher,
        refusal: expect.stringContaining('VALIDATION_ERROR') as string,
        leaks: [],
      });
      socket.onAny((event: string, payload: unknown) => {
        received.push({ watcher, event, payload });
      });
    }

    // A's own events: published to A's room as the API does, and smuggled onto the market's.
    const ts = new Date().toISOString();
    const own = {
      'user:balance': {
        type: 'user:balance',
        availableCoin: String(AMOUNTS.available),
        lockedCoin: String(AMOUNTS.locked),
        ledgerEntryId: '1',
        ts,
      },
      'user:position': {
        type: 'user:position',
        marketId: f.market.id,
        outcome: 'YES',
        qty: AMOUNTS.positionQty,
        costBasisCoin: String(AMOUNTS.costBasis),
        realizedPnlCoin: String(AMOUNTS.realizedPnl),
        settled: false,
        version: 1,
        ts,
      },
    } satisfies { [K in UserRealtimeEvent['type']]: Extract<UserRealtimeEvent, { type: K }> };
    const publisher = t.app.get(MarketPublisher);
    const raw = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    try {
      for (const event of Object.values(own)) {
        await publisher.publishUser(f.a.id, event);
        await raw.publish(marketChannel(f.market.id), JSON.stringify(event));
      }
    } finally {
      await raw.quit();
    }
    // Then a real public event, published after them: the admin closes the market.
    const closed = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/markets/${f.market.id}/close`,
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: f.admin.cookie },
      payload: '{}',
    });
    expect(closed.statusCode).toBe(200);
    const started = Date.now();
    while (received.filter((entry) => entry.event === 'market:status').length < 2) {
      if (Date.now() - started > 5_000) throw new Error('market:status did not reach both');
      await sleep(20);
    }

    // Delivered in publish order on one subscriber connection, so everything A's events could
    // have caused has arrived by now.
    expect(received.map(({ watcher, event }) => `${watcher} ${event}`).sort()).toEqual([
      'B market:status',
      'anonymous market:status',
    ]);
    for (const { event, payload } of received) {
      const registered = REALTIME_EVENT_REGISTRY[event as keyof typeof REALTIME_EVENT_REGISTRY];
      expect({ event, channel: registered?.channel }).toEqual({ event, channel: 'market' });
      const body = JSON.stringify(payload);
      expect({ event, leaks: [...leaked(body), ...forbiddenFields(body)] }).toEqual({
        event,
        leaks: [],
      });
    }
  });
});
