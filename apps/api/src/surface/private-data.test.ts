/**
 * #113 at run time, against the docker `test` profile. Account A's private data is in the
 * database — email, nickname and time zone, its 본인확인 (verified phone, real name, the code's
 * hash), password and session, a balance and a ledger memo, orders and the fill one of them got
 * against another account's resting order, a position with its PnL, a payment, two watched
 * markets (#89), a recorded search (#15). Then:
 * - every registered public route (registry.ts) is called anonymously, as another account B and
 *   as A itself, and no answer may hold one of A's values or a field PRIVATE_DATA names, nor a
 *   field naming an excluded feature or keeping a probability;
 * - every registered owner-only route is called as B, aimed at A wherever it takes an id or an
 *   account — in its path, its query (a page cursor made from A's row) or its body — and no
 *   answer may hold A's values; the same request as A shows them, so the check is not blind
 *   (N04 §7 "다른 사용자가 비공개 자산·주문을 조회할 수 없어야 한다"). What A's own
 *   answer names is not looked at: the excluded-feature names are the public API's (owner
 *   decision 2026-10-14 #113);
 * - every better-auth route that answers with an account's data (AUTH_ROUTES `answersAccount`)
 *   is called anonymously and as B, aimed at A, and neither answer may hold A's values;
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
  createMarket,
  createMarketLink,
  createPhoneVerification,
  createSearch,
  createUser,
  createWatch,
} from '@buddha/db/test';
import {
  PAGE_LIMIT_MAX,
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
  paymentId: string;
  /** A's password login: the `account` row better-auth keeps. */
  accountId: string;
  /** Page cursors made from A's rows: a page from there holds A's newest row and the older ones. */
  cursors: { ledger: string; orders: string; payments: string; watchlist: string };
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

/** Path parameters of the public routes, by name: A's market. */
const PUBLIC_PARAMS: Readonly<Record<string, (fixture: Fixture) => string>> = {
  id: (fixture) => fixture.market.id,
  idOrSlug: (fixture) => fixture.market.slug,
};

/** Bodies of the public routes that take one: A's own address, the request most about A. */
const PUBLIC_BODIES: Readonly<Record<string, (fixture: Fixture) => unknown>> = {
  'POST /auth/register': (fixture) => ({ email: fixture.a.email }),
};

interface OwnerCase {
  /** Path parameters by name, naming A's records. */
  params?: Readonly<Record<string, (fixture: Fixture) => string>>;
  /**
   * Query parameters by name, one for every key the route reads (queryKeysOf): A's records or A
   * wherever a key can name one — a page cursor made from A's row, A's id.
   */
  query?: Readonly<Record<string, (fixture: Fixture) => string>>;
  /** What B sends: A's account wherever the body names one. */
  body?: (fixture: Fixture) => unknown;
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
      'time zone',
      'real name',
      'phone',
      'available balance',
      'locked balance',
    ],
  },
  'PATCH /me': { body: () => ({ nickname: `b_${letters(8)}` }), status: 200 },
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
  // B's cookie naming A's account: refused before anything is written, and A's zone stays (below).
  'PUT /me/time-zone': {
    body: (fixture) => ({ timeZone: 'Europe/Paris', expectedAccountId: fixture.a.id }),
    status: 403,
  },
  'GET /me/ledger': {
    query: { cursor: (fixture) => fixture.cursors.ledger, limit: LIMIT },
    status: 200,
    own: ['ledger memo'],
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

/** A's login account and A, as better-auth's account-token routes take them. */
const aimedAtA = (fixture: Fixture) => ({ accountId: fixture.accountId, userId: fixture.a.id });

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
  'POST /refresh-token': {
    request: (fixture) => ({ body: aimedAtA(fixture) }),
    status: { anonymous: 401, B: 400 },
  },
  'POST /get-access-token': {
    request: (fixture) => ({ body: aimedAtA(fixture) }),
    status: { anonymous: 401, B: 400 },
  },
  'GET /account-info': {
    request: (fixture) => ({ query: aimedAtA(fixture) }),
    status: { anonymous: 401, B: 400 },
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
    await t.app.get(AdminGuard).invalidate(admin.id);

    const nickname = `leak_${tag}`;
    // A zone nobody else here picks (B's refused write in OWNER_CASES sends Europe/Paris), so its
    // name in an answer can only be A's.
    const timeZone = 'Pacific/Chatham';
    await t.db
      .update(schema.profiles)
      .set({ nickname, timeZone })
      .where(eq(schema.profiles.userId, a.id));
    // A's 본인확인 (ADR-0070): the record, and the code it was confirmed with (its hash a
    // sentinel too: nobody but A may see whether, when or how A verified).
    const realName = `숨김${letters(8)}`;
    const phone = `010${String(randomInt(10_000_000, 100_000_000))}`;
    await createPhoneVerification(t.db, { userId: a.id, realName, phone });
    const codeHash = randomUUID().replaceAll('-', '').repeat(2);
    await t.db.insert(schema.phoneVerificationCodes).values({
      id: randomUUID(),
      userId: a.id,
      phone,
      realName,
      codeHash,
      expiresAt: new Date(Date.now() + 180_000),
      consumedAt: new Date(),
    });

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
      watchedCategory: watchedCategory!.slug,
      searchId: search.id,
      phone,
      paymentId: payment!.id,
      accountId: account!.id,
      cursors: {
        ledger: cursorAfter(entry!),
        // The later of A's two orders, so the page holds both.
        orders: cursorAfter(open.createdAt >= filled.createdAt ? open : filled),
        payments: cursorAfter(payment!),
        watchlist: cursorAfter({ createdAt: watch.watch.watchedAt, id: watched.id }),
      },
      sentinels: [
        text('user id', a.id),
        text('email', a.email),
        text('nickname', nickname),
        text('time zone', timeZone),
        text('real name', realName),
        text('phone', phone),
        text('verification code hash', codeHash),
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
    return t.app.inject({
      method: route.method as 'GET',
      url,
      headers: {
        origin: ORIGIN,
        ...(safe ? {} : { 'content-type': 'application/json' }),
        ...(input.cookie ? { cookie: input.cookie } : {}),
      },
      ...(safe ? {} : { payload: JSON.stringify(input.body) }),
    });
  }

  /** The labels of A's values an answer holds. */
  const leaked = (body: string) => leakedValues(body, f.sentinels);

  // ---- public routes ----------------------------------------------------------------------

  it('answers every public route without A’s private data, whoever asks', async () => {
    const answers: { route: string; caller: string; status: number; leaks: string[] }[] = [];
    const bodies = new Map<string, string>();
    for (const key of Object.keys(PUBLIC_ROUTES)) {
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
        answers.push({
          route: key,
          caller,
          // Kept paid code answers 404 while paid Coin is off; everything else answers, so
          // the check below read a real answer and not an error.
          status: res.statusCode,
          leaks: [...leaked(res.body), ...forbiddenFields(res.body)],
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
    const shown: { route: string; status: number; missing: string[] }[] = [];
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
    expect(shown).toEqual(shown.map(({ route }) => ({ route, status: 200, missing: [] })));
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
    const answers: { route: string; status: number; leaks: string[] }[] = [];
    const shown: { route: string; status: number; missing: string[] }[] = [];
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
        });
      }
    }
    expect(answers).toEqual(
      answers.map(({ route }) => ({ route, status: OWNER_CASES[route]!.status, leaks: [] })),
    );
    expect(shown).toEqual(shown.map(({ route }) => ({ route, status: 200, missing: [] })));

    // B's refused writes changed nothing of A's: A's record and code stay, B has neither, and
    // nobody was texted (ADR-0070).
    const sentinel = (label: string) => f.sentinels.find((s) => s.label === label)!.value;
    expect(
      await t.db
        .select({
          userId: schema.phoneVerifications.userId,
          realName: schema.phoneVerifications.realName,
          phone: schema.phoneVerifications.phone,
        })
        .from(schema.phoneVerifications),
    ).toEqual([{ userId: f.a.id, realName: sentinel('real name'), phone: sentinel('phone') }]);
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
