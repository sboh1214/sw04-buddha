/**
 * Admin market CRUD and transitions (PLAN 5.2, 5.5, 12; M3 design 3.4) against the docker
 * `test` profile: create/update per status, open/close with their audit rows, list/detail, and
 * the guard surface (401/403/CSRF). Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createMarket,
  createPosition,
  createUser,
} from '@buddha/db/test';
import {
  INT4_MAX,
  marketChannel,
  type AdminMarket,
  type Market,
  type MarketSummary,
  type PriceSeries,
} from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep, waitForLockWaiter, waitForMessages } from '../test/wait.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const DAY_MS = 24 * 60 * 60 * 1000;
/** U+0000: Postgres refuses it in text and jsonb, so the pipe must refuse it first. */
const NUL = String.fromCharCode(0);
/** What the direct AMM kept on a market and the admin detail showed (#125 removed them). */
const AMM_FIELDS = ['liquidityB', 'qYes', 'qNo', 'initialProbBp', 'reserveCoin', 'pYesBp'] as const;

type ListPage = { data: MarketSummary[]; meta: { nextCursor: string | null } };
type ErrorBody = {
  error: { code: string; message: string; details?: { path: (string | number)[] }[] };
};

describe.skipIf(!hasTestInfra)('admin markets (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let member: TestUser;
  let category: { id: number; slug: string };

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    admin = await signUpTestUser(t);
    member = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    // An admin finishes the onboarding like any account before /admin answers it (ADR-0072).
    await completeOnboarding(t.db, { userId: admin.id });
    // The guard caches roles for 60 s (PLAN 10.5); the promotion above happened behind it.
    await t.app.get(AdminGuard).invalidate(admin.id);
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
  });

  const future = () => new Date(Date.now() + 7 * DAY_MS).toISOString();

  // Tagged, so a created draft passes the open-items check (#17) unless a test says otherwise.
  const createBody = (overrides: Record<string, unknown> = {}) => ({
    title: '기준금리 3% 이하로 인하?',
    rules: '한국은행 발표 기준. 기한까지 3% 이하로 내리지 않으면 NO.',
    categoryId: category.id,
    closeAt: future(),
    tags: ['금리', '한국은행'],
    ...overrides,
  });

  // Every write names the admin on screen (ADR-0092): `who`'s own account unless the payload
  // names another.
  const post = (url: string, payload: Record<string, unknown> = {}, who: TestUser = admin) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...payload },
    });
  const patch = (url: string, payload: Record<string, unknown>, who: TestUser = admin) =>
    t.app.inject({
      method: 'PATCH',
      url,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...payload },
    });
  const get = (url: string, cookie = admin.cookie) =>
    t.app.inject({ method: 'GET', url, headers: { cookie } });

  const create = (overrides: Record<string, unknown> = {}) =>
    post('/api/v1/admin/markets', createBody(overrides));
  const open = (id: string) => post(`/api/v1/admin/markets/${id}/open`);
  const close = (id: string) => post(`/api/v1/admin/markets/${id}/close`);

  /**
   * A market row written by the factory (no events, no tick) owned by the test admin, with one
   * tag so a draft passes the open-items check (#17) unless the test gives others or none.
   */
  const market = (input: Parameters<typeof createMarket>[1] = {}) =>
    createMarket(t.db, {
      createdBy: admin.id,
      categoryId: category.id,
      tags: ['테스트'],
      ...input,
    });

  const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
  const detail = (res: { json: <U>() => U }) => data<AdminMarket>(res);
  const errorOf = (res: { json: <U>() => U }) => res.json<ErrorBody>().error;
  const detailPath = (res: { json: <U>() => U }) => errorOf(res).details?.[0]?.path;

  async function actionsFor(targetId: string) {
    return t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, targetId))
      .orderBy(asc(schema.adminActions.createdAt));
  }
  async function marketRow(id: string) {
    const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, id));
    return row!;
  }
  async function eventsFor(marketId: string) {
    return t.db
      .select()
      .from(schema.marketEvents)
      .where(eq(schema.marketEvents.marketId, marketId))
      .orderBy(asc(schema.marketEvents.id));
  }
  // --- create ---------------------------------------------------------------------------
  it('creates a draft with no price and an audit trail', async () => {
    const res = await create({ slug: 'rate-cut-2026' });
    expect(res.statusCode).toBe(201);
    const created = detail(res);
    expect(created).toMatchObject({
      slug: 'rate-cut-2026',
      title: '기준금리 3% 이하로 인하?',
      status: 'draft',
      category: { slug: 'economy', nameKo: '경제' },
      // No fill yet, so no price (N02 §5): nothing stands in for one.
      lastPrice: null,
      volumeCoin: '0',
      tradeCount: 0,
      openAt: null,
      createdBy: admin.id,
      netCollectedCoin: '0',
      openInterest: { yes: 0, no: 0 },
      settlementSteps: [],
      description: null,
      imageUrl: null,
      // In the order sent (#17); and nothing missing, so it may open.
      tags: ['금리', '한국은행'],
      missingOpenItems: [],
    });
    for (const field of AMM_FIELDS) expect(created).not.toHaveProperty(field);
    expect(created.events.map((event) => event.type)).toEqual(['created']);
    // The row's birth names the status it starts in and no status it left (#174); the payload
    // is the body as sent, tags included.
    expect(created.events[0]).toMatchObject({
      actorId: admin.id,
      fromStatus: null,
      toStatus: 'draft',
      payload: { slug: 'rate-cut-2026', tags: ['금리', '한국은행'] },
    });
    expect(await eventsFor(created.id)).toMatchObject([
      { type: 'created', actorId: admin.id, fromStatus: null, toStatus: 'draft' },
    ]);
    // Keyed from birth (M5): the `created` event is the row's first transition event.
    expect(created.statusEventId).toBe(created.events[0]!.id);
    expect((await marketRow(created.id)).statusEventId).toBe(Number(created.events[0]!.id));

    const [action] = await actionsFor(created.id);
    expect(action).toMatchObject({
      adminId: admin.id,
      type: 'market_create',
      targetType: 'market',
    });
    // jsonb payloads are JSON-safe: Coin amounts crossed as strings, never bigint.
    const after = (action!.payload as { after: Record<string, unknown> }).after;
    expect(after).toMatchObject({
      slug: 'rate-cut-2026',
      status: 'draft',
      lastPrice: null,
      tags: ['금리', '한국은행'],
    });
    for (const field of AMM_FIELDS) expect(after).not.toHaveProperty(field);
    expect(typeof after.volumeCoin).toBe('string');

    // Drafts are the admin's alone.
    expect((await get(`/api/v1/admin/markets/${created.id}`)).statusCode).toBe(200);
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/v1/markets/${created.id}` })).statusCode,
    ).toBe(404);
  });

  it('derives a slug from the title when none is given, or from a tag alone', async () => {
    const fromTitle = detail(await create({ title: '비트코인 10만 달러 돌파?' }));
    expect(fromTitle.slug).toMatch(/^비트코인-10만-달러-돌파-[a-z0-9]{4}$/);
    const fromTag = detail(await create({ title: '🚀🚀🚀' }));
    expect(fromTag.slug).toMatch(/^market-[a-z0-9]{4}$/);
    // Two markets with one title get two slugs.
    const twin = detail(await create({ title: '비트코인 10만 달러 돌파?' }));
    expect(twin.slug).not.toBe(fromTitle.slug);
  });

  it('refuses a taken, uuid-shaped or malformed slug naming the field; stores NFC', async () => {
    await market({ slug: 'taken-slug' });
    const taken = await create({ slug: 'taken-slug' });
    expect(taken.statusCode).toBe(400);
    expect(errorOf(taken).code).toBe('VALIDATION_ERROR');
    expect(detailPath(taken)).toEqual(['slug']);
    // Nothing of the refused create is left behind.
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);

    for (const slug of [randomUUID(), 'ab', 'Upper-Case', 'has space', 'a'.repeat(81)]) {
      const res = await create({ slug });
      expect({ slug, status: res.statusCode }).toEqual({ slug, status: 400 });
      expect(detailPath(res)).toEqual(['slug']);
    }

    const nfd = '한글-슬러그'.normalize('NFD');
    const created = detail(await create({ slug: nfd }));
    expect(created.slug).toBe('한글-슬러그');
    expect((await marketRow(created.id)).slug).toBe('한글-슬러그');
  });

  it('refuses a category id past the int4 range at the boundary, not with a 500', async () => {
    // categories.id is serial (int4). Without the schema cap the id reaches Postgres as an
    // out-of-range parameter (SQLSTATE 22003), which no handler recognises: malformed input
    // came back as 500 INTERNAL instead of the documented refusal (A-M3-18).
    const draft = detail(await create());
    for (const value of [INT4_MAX + 1, Number.MAX_SAFE_INTEGER]) {
      const created = await create({ categoryId: value });
      expect({ value, code: created.statusCode }).toEqual({ value, code: 400 });
      expect(errorOf(created).code).toBe('VALIDATION_ERROR');
      expect(detailPath(created)).toEqual(['categoryId']);

      const patched = await patch(`/api/v1/admin/markets/${draft.id}`, { categoryId: value });
      expect({ value, code: patched.statusCode }).toEqual({ value, code: 400 });
      expect(detailPath(patched)).toEqual(['categoryId']);
    }

    // The largest id the column can hold still reaches the lookup and gets the 404.
    const edge = await create({ categoryId: INT4_MAX });
    expect(edge.statusCode).toBe(404);
    expect(detailPath(edge)).toEqual(['categoryId']);
  });

  it('validates the category, the close time and the body; a draft may have blank rules', async () => {
    const unknown = await create({ categoryId: 999_999 });
    expect(unknown.statusCode).toBe(404);
    expect(detailPath(unknown)).toEqual(['categoryId']);

    const retired = await createCategory(t.db, { isActive: false });
    const inactive = await create({ categoryId: retired.id });
    expect(inactive.statusCode).toBe(400);
    expect(errorOf(inactive)).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'This category is disabled',
      details: [{ path: ['categoryId'], message: 'inactive' }],
    });

    const past = await create({ closeAt: new Date(Date.now() - 1_000).toISOString() });
    expect(past.statusCode).toBe(400);
    expect(detailPath(past)).toEqual(['closeAt']);

    for (const bad of [
      { title: '' },
      { imageUrl: 'javascript:alert(1)' },
      { closeAt: 'tomorrow' },
    ]) {
      const res = await create(bad);
      expect({ bad, status: res.statusCode }).toEqual({ bad, status: 400 });
    }
    // A NUL inside otherwise valid text is bad input naming the field, not a driver 500.
    const nul = await create({ title: `기준금리${NUL} 인하?` });
    expect(nul.statusCode).toBe(400);
    expect(errorOf(nul)).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ path: ['title'], message: 'must not contain NUL' }],
    });
    expect(await t.db.select().from(schema.markets)).toHaveLength(0);

    const blank = detail(await create({ rules: '   ' }));
    expect(blank).toMatchObject({ status: 'draft', rules: '   ' });
  });

  it('refuses a category no new market may be filed under, naming categoryId with the reason', async () => {
    // #17 (ADR-0093 decision 2 #172 item 1): hidden, under a hidden parent, or a top level that has
    // an active sub-category. Create and a category change alike; nothing is written.
    const retiredParent = await createCategory(t.db, { slug: 'retired', nameKo: '은퇴' });
    const underRetired = await createCategory(t.db, {
      slug: 'under-retired',
      nameKo: '은퇴 하위',
      parentId: retiredParent.id,
    });
    await t.db
      .update(schema.categories)
      .set({ isActive: false })
      .where(eq(schema.categories.id, retiredParent.id));
    const hidden = await createCategory(t.db, { slug: 'hidden', nameKo: '숨김', isActive: false });
    const top = await createCategory(t.db, { slug: 'top', nameKo: '상위' });
    const leaf = await createCategory(t.db, { slug: 'leaf', nameKo: '하위', parentId: top.id });
    const draft = detail(await create());
    const live = await market({ status: 'open' });
    for (const [categoryId, reason, message] of [
      [hidden.id, 'inactive', 'This category is disabled'],
      [underRetired.id, 'parent_inactive', 'This category is under a disabled category'],
      [
        top.id,
        'subcategories',
        'This category has sub-categories: file the market under one of them',
      ],
    ] as const) {
      for (const [what, res] of [
        ['create', await create({ categoryId })],
        ['draft', await patch(`/api/v1/admin/markets/${draft.id}`, { categoryId })],
        ['open', await patch(`/api/v1/admin/markets/${live.id}`, { categoryId })],
      ] as const) {
        expect({ what, reason, status: res.statusCode }).toEqual({ what, reason, status: 400 });
        expect(errorOf(res)).toMatchObject({
          code: 'VALIDATION_ERROR',
          message,
          details: [{ path: ['categoryId'], message: reason }],
        });
      }
    }
    expect(await t.db.select().from(schema.markets)).toHaveLength(2);
    expect((await marketRow(draft.id)).categoryId).toBe(category.id);
    expect((await marketRow(live.id)).categoryId).toBe(category.id);
    expect((await actionsFor(live.id)).map((row) => row.type)).toEqual([]);
    // A sub-category is where such a market goes.
    expect(detail(await create({ categoryId: leaf.id })).category).toEqual({
      slug: 'leaf',
      nameKo: '하위',
    });
  });

  it('names a past close time before the category on create, and the category first on a PATCH', async () => {
    // The category's rows are read FOR SHARE before the clock (clock.ts: the instant after every
    // lock), but each refusal is thrown where it always stood: create checks the close time
    // first, a PATCH the category change.
    const hidden = await createCategory(t.db, { slug: 'hidden', nameKo: '숨김', isActive: false });
    const past = new Date(Date.now() - 1_000).toISOString();
    const created = await create({ categoryId: hidden.id, closeAt: past });
    expect(created.statusCode).toBe(400);
    expect(detailPath(created)).toEqual(['closeAt']);
    const draft = detail(await create());
    const patched = await patch(`/api/v1/admin/markets/${draft.id}`, {
      categoryId: hidden.id,
      closeAt: past,
    });
    expect(patched.statusCode).toBe(400);
    expect(errorOf(patched).details).toEqual([{ path: ['categoryId'], message: 'inactive' }]);
    expect(await t.db.select().from(schema.markets)).toHaveLength(1);
  });

  it('keeps a category hidden after the market was filed: naming the current one again is no change', async () => {
    // #172 item 1: an existing market keeps its category when it is hidden later, so a PATCH that
    // sends the current categoryId back (the edit form sends the whole form) is not checked.
    const draft = detail(await create());
    const live = await market({ status: 'open' });
    await t.db
      .update(schema.categories)
      .set({ isActive: false })
      .where(eq(schema.categories.id, category.id));
    for (const id of [draft.id, live.id]) {
      const res = await patch(`/api/v1/admin/markets/${id}`, {
        categoryId: category.id,
        title: '카테고리를 그대로 둔 수정',
      });
      expect({ id, status: res.statusCode }).toEqual({ id, status: 200 });
      expect(detail(res)).toMatchObject({
        title: '카테고리를 그대로 둔 수정',
        category: { slug: 'economy' },
      });
      expect(detail(res).missingOpenItems).toContain('category');
    }
    // A new market cannot be filed there any more.
    const refused = await create();
    expect(refused.statusCode).toBe(400);
    expect(errorOf(refused).details).toEqual([{ path: ['categoryId'], message: 'inactive' }]);
  });

  // --- tags (#17) -------------------------------------------------------------------------
  it('stores the tags in the order sent; a name that exists in another case or spacing links that tag', async () => {
    // ADR-0093 decision 2 #172 item 2: one tag per name ignoring case and spaces, shared by every
    // category; the spelling it was first made with is the one every market shows.
    const first = detail(await create({ tags: ['AI', '반도체 산업', 'K-팝'] }));
    expect(first.tags).toEqual(['AI', '반도체 산업', 'K-팝']);
    const other = await createCategory(t.db, { slug: 'society', nameKo: '사회' });
    const second = detail(
      await create({ categoryId: other.id, tags: ['  반도체   산업 ', 'ai', '신규 태그'] }),
    );
    expect(second.tags).toEqual(['반도체 산업', 'AI', '신규 태그']);
    // The created event keeps the body as sent (normalised by the schema); the record keeps what
    // was stored.
    expect(second.events[0]!.payload).toMatchObject({ tags: ['반도체 산업', 'ai', '신규 태그'] });
    const [created] = await actionsFor(second.id);
    expect(created!.payload).toMatchObject({ after: { tags: ['반도체 산업', 'AI', '신규 태그'] } });
    const stored = await t.db
      .select({ name: schema.tags.name, nameKey: schema.tags.nameKey })
      .from(schema.tags);
    expect(stored.sort((x, y) => (x.name < y.name ? -1 : 1))).toEqual([
      { name: 'AI', nameKey: 'ai' },
      { name: 'K-팝', nameKey: 'k-팝' },
      { name: '반도체 산업', nameKey: '반도체 산업' },
      { name: '신규 태그', nameKey: '신규 태그' },
    ]);
    const links = await t.db
      .select({ position: schema.marketTags.position })
      .from(schema.marketTags)
      .where(eq(schema.marketTags.marketId, second.id))
      .orderBy(asc(schema.marketTags.position));
    expect(links.map((link) => link.position)).toEqual([1, 2, 3]);
    // Without tags a draft has none (the open-items check counts them missing).
    const bare = detail(await create({ tags: undefined }));
    expect(bare).toMatchObject({ tags: [], missingOpenItems: ['tags'] });
    // Two creates making the same new tags at once, in opposite orders: one row per tag.
    const [a, b] = await Promise.all([
      create({ tags: ['동시 태그 가', '동시 태그 나'] }),
      create({ tags: ['동시 태그 나', '동시 태그 가'] }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(detail(b).tags).toEqual(['동시 태그 나', '동시 태그 가']);
    const concurrent = await t.db
      .select()
      .from(schema.tags)
      .where(inArray(schema.tags.name, ['동시 태그 가', '동시 태그 나']));
    expect(concurrent).toHaveLength(2);
  });

  it('refuses duplicate, malformed or more than five tags naming the field, writing nothing', async () => {
    for (const [tags, path, message] of [
      [['AI', ' ai '], ['tags', 1], 'duplicate tag'],
      [['반도체 산업', '반도체  산업', '금리'], ['tags', 1], 'duplicate tag'],
      [['#AI'], ['tags', 0], undefined],
      [['a'.repeat(21)], ['tags', 0], undefined],
      [['   '], ['tags', 0], undefined],
      [['하나', '둘', '셋', '넷', '다섯', '여섯'], ['tags'], undefined],
    ] as const) {
      const res = await create({ tags });
      expect({ tags, status: res.statusCode }).toEqual({ tags, status: 400 });
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      expect(errorOf(res).details?.[0]).toMatchObject({ path, ...(message ? { message } : {}) });
    }
    expect(await t.db.select().from(schema.markets)).toHaveLength(0);
    expect(await t.db.select().from(schema.tags)).toHaveLength(0);
    // The edit refuses the same, before anything is written.
    const draft = detail(await create({ tags: ['금리'] }));
    const dup = await patch(`/api/v1/admin/markets/${draft.id}`, { tags: ['금리', '금리 '] });
    expect(dup.statusCode).toBe(400);
    expect(detailPath(dup)).toEqual(['tags', 1]);
    expect(detail(await get(`/api/v1/admin/markets/${draft.id}`)).tags).toEqual(['금리']);
    expect((await actionsFor(draft.id)).map((row) => row.type)).toEqual(['market_create']);
  });

  it('replaces the whole ordered set on an edit that sends tags, and keeps it on one that does not', async () => {
    const draft = detail(await create({ tags: ['금리', '한국은행'] }));
    const retitled = detail(await patch(`/api/v1/admin/markets/${draft.id}`, { title: '새 제목' }));
    expect(retitled.tags).toEqual(['금리', '한국은행']);
    const reordered = detail(
      await patch(`/api/v1/admin/markets/${draft.id}`, { tags: ['한국은행', '물가', '금리'] }),
    );
    expect(reordered.tags).toEqual(['한국은행', '물가', '금리']);
    const actions = await actionsFor(draft.id);
    expect(actions.at(-1)!.payload).toMatchObject({
      before: { tags: ['금리', '한국은행'] },
      after: { tags: ['한국은행', '물가', '금리'] },
    });
    // A draft may be edited down to none (it cannot open that way).
    const cleared = detail(await patch(`/api/v1/admin/markets/${draft.id}`, { tags: [] }));
    expect(cleared).toMatchObject({ tags: [], missingOpenItems: ['tags'] });
    expect(
      await t.db.select().from(schema.marketTags).where(eq(schema.marketTags.marketId, draft.id)),
    ).toEqual([]);
    // Tags another market uses stay; an unused one stays too (tags are never deleted).
    expect(await t.db.select().from(schema.tags)).toHaveLength(3);
    // Statuses other than draft and open refuse a tag edit naming status, like any other field.
    const closed = await market({ status: 'closed' });
    const refused = await patch(`/api/v1/admin/markets/${closed.id}`, { tags: ['금리'] });
    expect(refused.statusCode).toBe(400);
    expect(detailPath(refused)).toEqual(['status']);
  });

  it('logs a tag edit of an open market with its before and after, and republishes its status', async () => {
    // ADR-0093 decision 2 #172 item 14: category and tags may change after the open, recorded with
    // who, when, before and after (the `market_update` record); viewers refetch on the repeat.
    const row = await market({ status: 'open', tags: ['AI', '반도체'] });
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel, message) => received.push(message));
    await subscriber.subscribe(marketChannel(row.id));
    try {
      const res = await patch(`/api/v1/admin/markets/${row.id}`, { tags: ['반도체', '엔비디아'] });
      expect(res.statusCode).toBe(200);
      const edited = detail(res);
      expect(edited).toMatchObject({ status: 'open', tags: ['반도체', '엔비디아'] });
      await waitForMessages(received, 1, 'market:status of the tag edit');
      expect(JSON.parse(received[0]!)).toMatchObject({
        type: 'market:status',
        marketId: row.id,
        status: 'open',
        ts: edited.updatedAt,
      });
      const [action] = await actionsFor(row.id);
      expect(action).toMatchObject({ adminId: admin.id, type: 'market_update' });
      expect(action!.payload).toMatchObject({
        before: { tags: ['AI', '반도체'] },
        after: { tags: ['반도체', '엔비디아'] },
      });
      // The public detail shows the new set.
      const pub = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${row.id}` });
      expect(data<Market>(pub).tags).toEqual(['반도체', '엔비디아']);

      // The same tags in another case are no change: nothing rewritten, nothing published, the
      // stored spelling kept.
      const same = await patch(`/api/v1/admin/markets/${row.id}`, {
        tags: [' 반도체', '엔비디아'],
      });
      expect(detail(same).tags).toEqual(['반도체', '엔비디아']);
      const upper = await patch(`/api/v1/admin/markets/${row.id}`, { tags: ['반도체', 'ai'] });
      expect(detail(upper).tags).toEqual(['반도체', 'AI']);
      await waitForMessages(received, 2, 'market:status of the second tag edit');
      await sleep(100);
      expect(received).toHaveLength(2);
    } finally {
      await subscriber.quit();
    }
    // An open market keeps at least one: none is refused naming tags, before anything is written.
    const emptied = await patch(`/api/v1/admin/markets/${row.id}`, { tags: [] });
    expect(emptied.statusCode).toBe(400);
    expect(errorOf(emptied)).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Tags cannot be removed while the market is open',
      details: [{ path: ['tags'], message: 'required while open' }],
    });
    expect(detail(await get(`/api/v1/admin/markets/${row.id}`)).tags).toEqual(['반도체', 'AI']);
  });

  it('searches the admin list by title only, never by tag', async () => {
    // #17 choice 12: the 관련 시장 picker's `q` stays a title partial match (ADR-0068).
    const tagged = await market({ title: '코스피 3000 돌파?', tags: ['AI'] });
    const titled = await market({ title: 'AI 반도체 수출 증가?', tags: ['수출'] });
    const ids = async (q: string) =>
      data<MarketSummary[]>(await get(`/api/v1/admin/markets?q=${encodeURIComponent(q)}`)).map(
        (row) => row.id,
      );
    expect(await ids('AI')).toEqual([titled.id]);
    expect(await ids('코스피')).toEqual([tagged.id]);
    expect(await ids('수출')).toEqual([titled.id]);
    // Summaries carry no tags (the card has none).
    const [summary] = data<MarketSummary[]>(await get('/api/v1/admin/markets?q=AI'));
    expect(summary).not.toHaveProperty('tags');
  });

  // --- update ---------------------------------------------------------------------------
  it('edits a draft, logs a rules edit, and lets its slug and category change', async () => {
    const draft = detail(await create());
    const res = await patch(`/api/v1/admin/markets/${draft.id}`, {
      rules: '새 규칙: 한국은행 홈페이지 공지 기준.',
      description: '설명 추가',
    });
    expect(res.statusCode).toBe(200);
    const updated = detail(res);
    expect(updated).toMatchObject({
      lastPrice: null,
      rules: '새 규칙: 한국은행 홈페이지 공지 기준.',
      description: '설명 추가',
    });
    expect(updated.events.map((event) => event.type)).toEqual(['rules_edited', 'created']);
    expect(updated.events[0]!.payload).toEqual({
      before: draft.rules,
      after: '새 규칙: 한국은행 홈페이지 공지 기준.',
    });
    // A rules edit changes no status, so it names none (#174) and leaves the key alone.
    expect(updated.events[0]).toMatchObject({ fromStatus: null, toStatus: null });
    expect(updated.statusEventId).toBe(draft.statusEventId);

    const actions = await actionsFor(draft.id);
    expect(actions.map((action) => action.type)).toEqual(['market_create', 'market_update']);
    expect(actions[1]!.payload).toMatchObject({
      before: { rules: draft.rules, description: null },
      after: { rules: '새 규칙: 한국은행 홈페이지 공지 기준.', description: '설명 추가' },
    });

    // The same rules up to surrounding space are no rules edit.
    const again = await patch(`/api/v1/admin/markets/${draft.id}`, {
      rules: '새 규칙: 한국은행 홈페이지 공지 기준. ',
    });
    expect(again.statusCode).toBe(200);
    expect(detail(again).events.filter((event) => event.type === 'rules_edited')).toHaveLength(1);

    // Slug and category can change while draft; a taken slug is refused naming it.
    const other = await createCategory(t.db, { slug: 'society', nameKo: '사회' });
    const moved = await patch(`/api/v1/admin/markets/${draft.id}`, {
      slug: 'rate-cut-2027',
      categoryId: other.id,
    });
    expect(detail(moved)).toMatchObject({
      slug: 'rate-cut-2027',
      category: { slug: 'society', nameKo: '사회' },
    });
    await market({ slug: 'other-slug' });
    const collision = await patch(`/api/v1/admin/markets/${draft.id}`, { slug: 'other-slug' });
    expect(collision.statusCode).toBe(400);
    expect(detailPath(collision)).toEqual(['slug']);
    // A body of nothing but the removed AMM inputs is a body of nothing: they are not fields.
    for (const empty of [{}, { initialProbBp: 7_000, liquidityB: 2_000 }]) {
      const res = await patch(`/api/v1/admin/markets/${draft.id}`, empty);
      expect({ empty, status: res.statusCode }).toEqual({ empty, status: 400 });
    }
    const missing = await patch(`/api/v1/admin/markets/${randomUUID()}`, { title: 'x' });
    expect(missing.statusCode).toBe(404);
  });

  it('lets an open market change its text, close time and category, but not its slug', async () => {
    const row = await market({ status: 'open' });
    const ok = await patch(`/api/v1/admin/markets/${row.id}`, {
      title: '제목 수정',
      closeAt: future(),
      resolutionSource: null,
      imageUrl: 'https://example.com/cover.png',
    });
    expect(ok.statusCode).toBe(200);
    expect(detail(ok)).toMatchObject({
      title: '제목 수정',
      resolutionSource: null,
      imageUrl: 'https://example.com/cover.png',
      status: 'open',
    });

    const renamed = await patch(`/api/v1/admin/markets/${row.id}`, { slug: 'new-slug' });
    expect(renamed.statusCode).toBe(400);
    expect(errorOf(renamed)).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'slug cannot change while the market is open',
    });
    expect(detailPath(renamed)).toEqual(['slug']);
    // Refused before anything is written: one audit row, the successful edit's.
    expect((await actionsFor(row.id)).map((action) => action.type)).toEqual(['market_update']);
    expect((await marketRow(row.id)).slug).toBe(row.slug);

    const closed = await market({ status: 'closed' });
    const refused = await patch(`/api/v1/admin/markets/${closed.id}`, { title: '늦은 수정' });
    expect(refused.statusCode).toBe(400);
    expect(detailPath(refused)).toEqual(['status']);
    expect(errorOf(refused)).toMatchObject({ message: 'Market is closed' });
  });

  it('publishes the unchanged status after an edit that moves an open market, and only then', async () => {
    // The ONLY delivery a descriptive edit has: no event carries `closeAt`, and the web takes it
    // from a REST answer alone, so `update` republishes `market:status` and the client's handler
    // turns that into the refetch (A-M4-36). Three assertions on one subscription: an edit that
    // MOVED an open row publishes exactly one, a resave of the same text publishes none, and a
    // draft — which no public route shows — publishes none either.
    const row = await market({ status: 'open' });
    const draft = await market({ status: 'draft' });
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: [string, string][] = [];
    subscriber.on('message', (channel, message) => received.push([channel, message]));
    await subscriber.subscribe(marketChannel(row.id), marketChannel(draft.id));
    try {
      const extended = new Date(Date.now() + 30 * DAY_MS).toISOString();
      const res = await patch(`/api/v1/admin/markets/${row.id}`, { closeAt: extended });
      expect(res.statusCode).toBe(200);
      const edited = detail(res);
      expect(edited.closeAt).toBe(extended);
      await waitForMessages(received, 1, 'market:status of the close-time edit');
      await sleep(100);
      expect(received).toHaveLength(1);
      expect(received[0]![0]).toBe(marketChannel(row.id));
      // The status is deliberately the one the market already had, and `ts` is this edit's
      // post-lock database clock — the same instant the row and its audit entry carry.
      expect(JSON.parse(received[0]![1])).toMatchObject({
        type: 'market:status',
        marketId: row.id,
        status: 'open',
        ts: edited.updatedAt,
      });

      // A PATCH that writes the same text moves `updated_at` and the audit row and nothing on
      // the wire: the gate is the audit projection, not "the body was non-empty". A draft edit
      // publishes nothing either — there is no room anyone could have joined.
      const resaved = await patch(`/api/v1/admin/markets/${row.id}`, { title: row.title });
      expect(resaved.statusCode).toBe(200);
      const drafted = await patch(`/api/v1/admin/markets/${draft.id}`, { title: '초안 제목' });
      expect(drafted.statusCode).toBe(200);
      await sleep(100);
      expect(received).toHaveLength(1);
    } finally {
      await subscriber.quit();
    }
  });

  it('keeps an open market from being edited down to blank rules (RULES_REQUIRED)', async () => {
    // What open() required holds for as long as the market trades; a draft may still be
    // saved with blank rules (it cannot open that way).
    const row = await market({ status: 'open', rules: '한국은행 발표 기준.' });
    for (const rules of ['', '   ']) {
      const res = await patch(`/api/v1/admin/markets/${row.id}`, { rules });
      expect({ rules, status: res.statusCode }).toEqual({ rules, status: 422 });
      expect(errorOf(res).code).toBe('RULES_REQUIRED');
      expect(errorOf(res).message).toBe('Rules cannot be blank while the market is open');
      expect(detailPath(res)).toEqual(['rules']);
    }
    // Refused before anything is written, whatever else the body carries.
    const withTitle = await patch(`/api/v1/admin/markets/${row.id}`, {
      title: '새 제목',
      rules: '',
    });
    expect(withTitle.statusCode).toBe(422);
    expect((await marketRow(row.id)).title).toBe(row.title);
    expect((await marketRow(row.id)).rules).toBe('한국은행 발표 기준.');
    expect(await actionsFor(row.id)).toHaveLength(0);
    expect(detail(await get(`/api/v1/admin/markets/${row.id}`)).events).toHaveLength(0);

    const draft = await market({ status: 'draft', rules: '초안 규칙' });
    const blanked = await patch(`/api/v1/admin/markets/${draft.id}`, { rules: '' });
    expect(blanked.statusCode).toBe(200);
    expect(detail(blanked).rules).toBe('');
  });

  it('stamps every transition row with the instant the transition happened (ADR-0027)', async () => {
    // market_events.created_at used to fall back to the column default `now()`, which is the
    // transaction START — fixed before the transaction waits on the market lock. The event
    // log then sorted a transition below an edit that committed while it queued. Every row a
    // transition writes now carries the post-lock database clock, so the row, its payload and
    // the market column all name one instant.
    const draft = detail(await create());
    const opened = detail(await open(draft.id));
    const openEvent = (await eventsFor(draft.id)).find((event) => event.type === 'opened')!;
    expect(openEvent.createdAt.toISOString()).toBe(opened.openAt);
    expect((await marketRow(draft.id)).updatedAt.toISOString()).toBe(opened.openAt);
    const openAction = (await actionsFor(draft.id)).find((row) => row.type === 'market_open')!;
    expect(openAction.createdAt.toISOString()).toBe(opened.openAt);

    const closed = detail(await close(draft.id));
    const closeEvent = (await eventsFor(draft.id)).find((event) => event.type === 'closed')!;
    expect((closeEvent.payload as { closedAt: string }).closedAt).toBe(
      closeEvent.createdAt.toISOString(),
    );
    expect(closeEvent.createdAt.toISOString()).toBe(closed.updatedAt);
  });

  it('keeps a transition above an edit that commits while it waits on the market lock', async () => {
    // The close begins (its transaction-start `now()` is fixed) and queues on the market
    // lock; a rules PATCH, which takes only the market row, commits meanwhile. The close then
    // commits with the later instant and must be shown as the later event: the log is ordered
    // by market_events.id, which is drawn under the market row lock, so it is insert order.
    const row = await market({ status: 'open', rules: '원래 규칙' });
    const holder = await t.db.$client.connect();
    let pending: ReturnType<typeof close> | undefined;
    let released = false;
    try {
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [row.id]);
      pending = close(row.id);
      await waitForLockWaiter(holder, 'the close on the market lock');
      const edited = await patch(`/api/v1/admin/markets/${row.id}`, { rules: '고친 규칙' });
      expect(edited.statusCode).toBe(200);
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [row.id]);
      released = true;
      expect((await pending).statusCode).toBe(200);
    } finally {
      if (!released) await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
      await pending?.catch(() => undefined);
    }

    const events = await eventsFor(row.id);
    const closeEvent = events.find((event) => event.type === 'closed')!;
    const editEvent = events.find((event) => event.type === 'rules_edited')!;
    expect(closeEvent.id).toBeGreaterThan(editEvent.id);
    expect(closeEvent.createdAt.getTime()).toBeGreaterThanOrEqual(editEvent.createdAt.getTime());
    // What the admin screen renders, newest first.
    const shown = detail(await get(`/api/v1/admin/markets/${row.id}`));
    expect(shown.events.map((event) => event.type)).toEqual(['closed', 'rules_edited']);
  });

  // --- open / close ---------------------------------------------------------------------
  it('opens a draft: open_at, the "opened" event, an audit row and a publish, and no tick', async () => {
    const draft = detail(await create());
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel, message) => received.push(message));
    await subscriber.subscribe(marketChannel(draft.id));
    try {
      const res = await open(draft.id);
      expect(res.statusCode).toBe(200);
      const opened = detail(res);
      expect(opened.status).toBe('open');
      expect(opened.openAt).not.toBeNull();
      expect(opened.events.map((event) => event.type)).toEqual(['opened', 'created']);
      // Who, when, from and to (#174), on the detail and on the row alike.
      expect(opened.events[0]).toMatchObject({
        actorId: admin.id,
        fromStatus: 'draft',
        toStatus: 'open',
        createdAt: opened.openAt,
      });
      expect((await eventsFor(draft.id)).at(-1)).toMatchObject({
        type: 'opened',
        actorId: admin.id,
        fromStatus: 'draft',
        toStatus: 'open',
      });

      // Opening is not a price: the chart starts at the first fill (N02 §5).
      const ticks = await t.db
        .select()
        .from(schema.priceTicks)
        .where(eq(schema.priceTicks.marketId, draft.id));
      expect(ticks).toHaveLength(0);

      const actions = await actionsFor(draft.id);
      expect(actions.map((action) => action.type)).toEqual(['market_create', 'market_open']);
      expect(actions[1]!.payload).toMatchObject({
        before: { status: 'draft', openAt: null },
        after: { status: 'open', openAt: opened.openAt },
      });

      // Visible to the public now, still without a price or a chart point.
      const pub = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${draft.id}` });
      expect(pub.statusCode).toBe(200);
      expect(data<Market>(pub)).toMatchObject({ status: 'open', lastPrice: null, tradeCount: 0 });
      expect(data<Market>(pub)).not.toHaveProperty('pYesBp');
      const chart = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${draft.id}/ticks` });
      // `data` is a PriceSeries object since M4, not a bare array (ADR-0029).
      expect(data<PriceSeries>(chart)).toMatchObject({
        resolution: 'raw',
        bucketSeconds: 0,
        truncated: false,
        points: [],
      });

      // PLAN 8: `market:status` published after commit on the market's channel.
      await new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          if (received.length >= 1) return resolve();
          if (Date.now() - started > 5_000) return reject(new Error('market:status not received'));
          setTimeout(poll, 20);
        };
        poll();
      });
      expect(JSON.parse(received[0]!)).toMatchObject({
        type: 'market:status',
        marketId: draft.id,
        status: 'open',
        // The `opened` event's id: what a client orders this event by (A-M3-19).
        statusEventId: opened.events[0]!.id,
      });
      expect(opened.statusEventId).toBe(opened.events[0]!.id);

      // Twice: the second open finds an open market, which is a status error, not a no-op.
      const twice = await open(draft.id);
      expect(twice.statusCode).toBe(400);
      expect(errorOf(twice).code).toBe('VALIDATION_ERROR');
      expect(detailPath(twice)).toEqual(['status']);
      expect(await actionsFor(draft.id)).toHaveLength(2);
    } finally {
      await subscriber.quit();
    }
  });

  it('refuses to open a draft the open-items check finds wanting (OPEN_ITEMS_MISSING), naming every item in order', async () => {
    // #17: rules, a category a new market may be filed under, 1..5 tags — all named at once, in
    // OPEN_ITEMS order. Here: blank rules, a top-level category that got a sub-category after the
    // draft was filed, and no tags.
    const blank = detail(await create({ rules: '  \n ', tags: [] }));
    expect(blank.missingOpenItems).toEqual(['rules', 'tags']);
    const leaf = await createCategory(t.db, {
      slug: 'rates',
      nameKo: '금리',
      parentId: category.id,
    });
    const res = await open(blank.id);
    expect(res.statusCode).toBe(422);
    expect(errorOf(res)).toEqual({
      code: 'OPEN_ITEMS_MISSING',
      message: 'The market misses what it needs to open: rules, category, tags',
      details: [
        { path: ['rules'], message: 'required' },
        { path: ['category'], message: 'subcategories' },
        { path: ['tags'], message: 'required' },
      ],
    });
    // The detail reports the same, read without the open's locks.
    expect(detail(await get(`/api/v1/admin/markets/${blank.id}`)).missingOpenItems).toEqual([
      'rules',
      'category',
      'tags',
    ]);
    // Nothing written: still a draft, no event, no record, no tick.
    expect((await marketRow(blank.id)).status).toBe('draft');
    expect((await eventsFor(blank.id)).map((event) => event.type)).toEqual(['created']);
    expect((await actionsFor(blank.id)).map((row) => row.type)).toEqual(['market_create']);
    expect(await t.db.select().from(schema.priceTicks)).toHaveLength(0);

    // Each fixed in turn leaves the rest named: no RULES_REQUIRED on open any more.
    await patch(`/api/v1/admin/markets/${blank.id}`, { rules: '규칙 추가' });
    expect(errorOf(await open(blank.id)).details).toEqual([
      { path: ['category'], message: 'subcategories' },
      { path: ['tags'], message: 'required' },
    ]);
    await patch(`/api/v1/admin/markets/${blank.id}`, { categoryId: leaf.id });
    const tagless = await open(blank.id);
    expect(errorOf(tagless)).toMatchObject({
      code: 'OPEN_ITEMS_MISSING',
      details: [{ path: ['tags'], message: 'required' }],
    });
    await patch(`/api/v1/admin/markets/${blank.id}`, { tags: ['금리'] });
    const opened = await open(blank.id);
    expect(opened.statusCode).toBe(200);
    expect(detail(opened)).toMatchObject({ status: 'open', tags: ['금리'], missingOpenItems: [] });
    // The open's record carries the tags like every snapshot.
    const openAction = (await actionsFor(blank.id)).find((row) => row.type === 'market_open')!;
    expect(openAction.payload).toMatchObject({
      before: { tags: ['금리'] },
      after: { tags: ['금리'] },
    });

    // A hidden category, and a sub-category under a hidden parent, are missing the same way —
    // the reason as the message.
    const hidden = await createCategory(t.db, { slug: 'hidden', nameKo: '숨김' });
    const hiddenDraft = await market({ status: 'draft', categoryId: hidden.id });
    const orphanParent = await createCategory(t.db, { slug: 'retired-parent', nameKo: '은퇴' });
    const orphan = await createCategory(t.db, {
      slug: 'orphan',
      nameKo: '고아',
      parentId: orphanParent.id,
    });
    const orphanDraft = await market({ status: 'draft', categoryId: orphan.id });
    await t.db
      .update(schema.categories)
      .set({ isActive: false })
      .where(eq(schema.categories.id, hidden.id));
    await t.db
      .update(schema.categories)
      .set({ isActive: false })
      .where(eq(schema.categories.id, orphanParent.id));
    for (const [row, reason] of [
      [hiddenDraft, 'inactive'],
      [orphanDraft, 'parent_inactive'],
    ] as const) {
      const refused = await open(row.id);
      expect({ reason, status: refused.statusCode }).toEqual({ reason, status: 422 });
      expect(errorOf(refused).details).toEqual([{ path: ['category'], message: reason }]);
      expect((await marketRow(row.id)).status).toBe('draft');
      expect(detail(await get(`/api/v1/admin/markets/${row.id}`)).missingOpenItems).toEqual([
        'category',
      ]);
    }

    // What the market lacks comes before the past close time; with nothing missing, the close
    // time is what refuses it.
    const stale = await market({
      status: 'draft',
      closeAt: new Date(Date.now() - 1_000),
      tags: [],
    });
    const lacking = await open(stale.id);
    expect(lacking.statusCode).toBe(422);
    expect(errorOf(lacking).code).toBe('OPEN_ITEMS_MISSING');
    const staleTagged = await market({
      status: 'draft',
      categoryId: leaf.id,
      closeAt: new Date(Date.now() - 1_000),
    });
    const past = await open(staleTagged.id);
    expect(past.statusCode).toBe(400);
    expect(detailPath(past)).toEqual(['closeAt']);
    expect((await marketRow(staleTagged.id)).status).toBe('draft');

    expect((await open(randomUUID())).statusCode).toBe(404);
    expect((await open('not-a-uuid')).statusCode).toBe(400);
  });

  it('reports what the open-items check finds missing on the admin detail, for every status', async () => {
    const draft = detail(await create({ rules: '', tags: [] }));
    expect(draft.missingOpenItems).toEqual(['rules', 'tags']);
    expect(detail(await get(`/api/v1/admin/markets/${draft.id}`)).missingOpenItems).toEqual([
      'rules',
      'tags',
    ]);
    // An open market whose category was hidden after it was filed reports it too, as does one
    // written before tags existed; the public detail carries neither.
    const live = await market({ status: 'open', tags: [] });
    expect(detail(await get(`/api/v1/admin/markets/${live.id}`)).missingOpenItems).toEqual([
      'tags',
    ]);
    await t.db
      .update(schema.categories)
      .set({ isActive: false })
      .where(eq(schema.categories.id, category.id));
    expect(detail(await get(`/api/v1/admin/markets/${live.id}`)).missingOpenItems).toEqual([
      'category',
      'tags',
    ]);
    expect(detail(await get(`/api/v1/admin/markets/${draft.id}`)).missingOpenItems).toEqual([
      'rules',
      'category',
      'tags',
    ]);
    const pub = data<Market>(
      await t.app.inject({ method: 'GET', url: `/api/v1/markets/${live.id}` }),
    );
    expect(pub).not.toHaveProperty('missingOpenItems');
    // A top level whose only sub-category is hidden holds markets again.
    await t.db
      .update(schema.categories)
      .set({ isActive: true })
      .where(eq(schema.categories.id, category.id));
    await createCategory(t.db, {
      slug: 'hidden-leaf',
      nameKo: '숨은 하위',
      parentId: category.id,
      isActive: false,
    });
    expect(detail(await get(`/api/v1/admin/markets/${live.id}`)).missingOpenItems).toEqual([
      'tags',
    ]);
  });

  it('closes a market whose close time has already passed', async () => {
    // An open market past its close time whose close job has not run (A-M3-31): this button is
    // the operator's way out. `close` does not check the close time — only `open` and the edits
    // do — so it must work here.
    const row = await market({ status: 'open', closeAt: new Date(Date.now() - 60_000) });
    const res = await close(row.id);
    expect(res.statusCode).toBe(200);
    expect(detail(res).status).toBe('closed');
    expect((await marketRow(row.id)).status).toBe('closed');
  });

  it('closes an open market and answers MARKET_NOT_OPEN for anything else', async () => {
    const row = await market({ status: 'open' });
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel, message) => received.push(message));
    await subscriber.subscribe(marketChannel(row.id));
    let closed!: AdminMarket;
    try {
      const res = await close(row.id);
      expect(res.statusCode).toBe(200);
      closed = detail(res);
      // PLAN 8: exactly one `market:status` on the market's channel, after commit.
      await waitForMessages(received, 1, 'market:status of the close');
      await sleep(100);
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0]!)).toMatchObject({
        type: 'market:status',
        marketId: row.id,
        status: 'closed',
        statusEventId: closed.events[0]!.id,
      });
    } finally {
      await subscriber.quit();
    }
    expect(closed.status).toBe('closed');
    expect(closed.events.map((event) => event.type)).toEqual(['closed']);
    expect(closed.events[0]).toMatchObject({
      actorId: admin.id,
      fromStatus: 'open',
      toStatus: 'closed',
      createdAt: closed.updatedAt,
    });
    expect(await eventsFor(row.id)).toMatchObject([
      { type: 'closed', actorId: admin.id, fromStatus: 'open', toStatus: 'closed' },
    ]);
    expect(closed.statusEventId).toBe(closed.events[0]!.id);
    const actions = await actionsFor(row.id);
    expect(actions.map((action) => action.type)).toEqual(['market_close']);
    expect(actions[0]).toMatchObject({ adminId: admin.id, targetType: 'market' });
    expect(actions[0]!.payload).toMatchObject({
      before: { status: 'open' },
      after: { status: 'closed' },
    });

    const again = await close(row.id);
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe('MARKET_NOT_OPEN');

    // Every other status, PAUSED too: its early close is #114's, with another admin's approval.
    for (const status of ['draft', 'review', 'scheduled', 'paused', 'cancelled'] as const) {
      const other = await market({ status });
      const refused = await close(other.id);
      expect({ status, code: refused.statusCode }).toEqual({ status, code: 409 });
      expect(errorOf(refused).code).toBe('MARKET_NOT_OPEN');
      expect((await marketRow(other.id)).status).toBe(status);
      expect(await actionsFor(other.id)).toHaveLength(0);
      expect(await eventsFor(other.id)).toHaveLength(0);
    }
  });

  it('opens a draft only: any other status is refused naming status, with nothing written', async () => {
    // draft → open is the interim edge (#21 removes it); REVIEW → OPEN and the rest are not
    // edges at all, and SCHEDULED → OPEN is #21's timer, not this action (ADR-0093).
    for (const status of [
      'review',
      'scheduled',
      'paused',
      'closed',
      'provisional',
      'cancelled',
    ] as const) {
      const row = await market({ status, rules: '규칙' });
      const res = await open(row.id);
      expect({ status, code: res.statusCode }).toEqual({ status, code: 400 });
      expect(errorOf(res)).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: `Market is ${status}`,
      });
      expect(detailPath(res)).toEqual(['status']);
      expect(await marketRow(row.id)).toMatchObject({ status, statusEventId: null });
      expect(await eventsFor(row.id)).toHaveLength(0);
      expect(await actionsFor(row.id)).toHaveLength(0);
    }
  });

  it.each([
    ['open', 'draft', open],
    ['close', 'open', close],
  ] as const)(
    '%s waits for the market advisory lock before touching the row (PLAN 0.2)',
    async (_name, status, transition) => {
      // A session-level lock on the same key from another connection stands in for another
      // writer (a transition, a worker job) holding the transaction-level one. The row `FOR UPDATE`
      // alone would not show this: the fixture row is unlocked, so a transition that skipped
      // `lockMarket` would go straight through.
      const row = await market({ status });
      const holder = await t.db.$client.connect();
      let released = false;
      try {
        await holder.query('SELECT pg_advisory_lock(hashtext($1))', [row.id]);
        // light-my-request dispatches lazily: `.then` is what sends the request.
        const pending = transition(row.id).then((res) => res);
        await sleep(300);
        expect((await marketRow(row.id)).status).toBe(status);
        expect(await actionsFor(row.id)).toHaveLength(0);

        await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [row.id]);
        released = true;
        const res = await pending;
        expect(res.statusCode).toBe(200);
        expect((await marketRow(row.id)).status).not.toBe(status);
        expect(await actionsFor(row.id)).toHaveLength(1);
      } finally {
        if (!released) await holder.query('SELECT pg_advisory_unlock_all()');
        holder.release();
      }
    },
  );

  // --- list / detail --------------------------------------------------------------------
  it('lists every status including drafts and reviews, newest first, with a keyset cursor', async () => {
    const ids: string[] = [];
    const base = Date.now() - 60 * 60 * 1000;
    const rows: { id: string; createdAt: Date }[] = [];
    for (const [i, status] of (
      ['draft', 'review', 'closed', 'draft', 'cancelled'] as const
    ).entries()) {
      const row = await market({ status });
      ids.push(row.id);
      // Pairs share a created_at, so the id half of the keyset is what orders them.
      const createdAt = new Date(base + Math.floor(i / 2) * 1_000);
      await t.db.update(schema.markets).set({ createdAt }).where(eq(schema.markets.id, row.id));
      rows.push({ id: row.id, createdAt });
    }
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const expected = [...rows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || byId(b, a))
      .map((row) => row.id);

    const all = await get('/api/v1/admin/markets?limit=3');
    expect(all.statusCode).toBe(200);
    const first = all.json<ListPage>();
    expect(first.data).toHaveLength(3);
    expect(first.meta.nextCursor).toBeTypeOf('string');
    const second = get(
      `/api/v1/admin/markets?limit=3&cursor=${encodeURIComponent(first.meta.nextCursor!)}`,
    );
    const rest = (await second).json<ListPage>();
    expect(rest.data).toHaveLength(2);
    expect(rest.meta.nextCursor).toBeNull();
    const seen = [...first.data, ...rest.data].map((row) => row.id);
    expect(new Set(seen).size).toBe(5);
    // Exact order: created_at desc, id desc as the tiebreak (the public list's keyset).
    expect(seen).toEqual(expected);
    expect([...seen].sort()).toEqual([...ids].sort());

    const drafts = get('/api/v1/admin/markets?status=draft');
    expect((await drafts).json<ListPage>().data.map((row) => row.status)).toEqual([
      'draft',
      'draft',
    ]);
    const reviews = await get('/api/v1/admin/markets?status=review');
    expect(reviews.json<ListPage>().data.map((row) => row.id)).toEqual([ids[1]]);
    expect((await get('/api/v1/admin/markets?status=nope')).statusCode).toBe(400);
  });

  it('shows net collected Coin, open interest and the event log on the detail', async () => {
    const row = await market({ status: 'open', lastPrice: 55, tradeCount: 2 });
    const trader = (await createUser(t.db)).user.id;
    await createPosition(t.db, {
      userId: trader,
      marketId: row.id,
      outcome: 'YES',
      qty: 12,
      costBasisCoin: 600n,
    });
    await createPosition(t.db, {
      userId: trader,
      marketId: row.id,
      outcome: 'NO',
      qty: 5,
      costBasisCoin: 200n,
    });
    // Settled rows are not open interest.
    await createPosition(t.db, {
      userId: (await createUser(t.db)).user.id,
      marketId: row.id,
      outcome: 'YES',
      qty: 7,
      costBasisCoin: 300n,
      settled: true,
    });
    // Two fills of the trader's order against one resting order of another account
    // (`fills_counterparty_check` wants it named).
    const order = async (userId: string, type: 'market' | 'limit') => {
      const [inserted] = await t.db
        .insert(schema.orders)
        .values({
          userId,
          marketId: row.id,
          outcome: 'YES',
          side: 'buy',
          type,
          limitPrice: type === 'limit' ? 50 : null,
          qty: 12,
          filledQty: type === 'market' ? 12 : 0,
          status: type === 'market' ? 'filled' : 'open',
          idempotencyKey: randomUUID(),
        })
        .returning();
      return inserted!;
    };
    const resting = await order((await createUser(t.db)).user.id, 'limit');
    const taker = await order(trader, 'market');
    await t.db.insert(schema.fills).values([
      {
        marketId: row.id,
        orderId: taker.id,
        counterpartyType: 'order',
        counterpartyOrderId: resting.id,
        outcome: 'YES',
        side: 'buy',
        qty: 12,
        amountCoin: 600n,
        priceAvgBp: 5_000,
      },
      {
        marketId: row.id,
        orderId: taker.id,
        counterpartyType: 'order',
        counterpartyOrderId: resting.id,
        outcome: 'YES',
        side: 'sell',
        qty: 2,
        amountCoin: 110n,
        priceAvgBp: 5_500,
      },
    ]);
    await t.db.insert(schema.marketEvents).values([
      {
        marketId: row.id,
        type: 'created',
        actorId: admin.id,
        toStatus: 'draft',
        payload: { source: 'test' },
      },
      {
        marketId: row.id,
        type: 'opened',
        actorId: null,
        fromStatus: 'draft',
        toStatus: 'open',
        payload: null,
      },
    ]);

    const res = await get(`/api/v1/admin/markets/${row.id}`);
    expect(res.statusCode).toBe(200);
    const shown = detail(res);
    expect(shown).toMatchObject({
      id: row.id,
      lastPrice: 55,
      tradeCount: 2,
      createdBy: admin.id,
      netCollectedCoin: '490',
      openInterest: { yes: 12, no: 5 },
      settlementSteps: [],
    });
    for (const field of AMM_FIELDS) expect(shown).not.toHaveProperty(field);
    expect(
      shown.events.map((event) => [event.type, event.actorId, event.fromStatus, event.toStatus]),
    ).toEqual([
      ['opened', null, 'draft', 'open'],
      ['created', admin.id, null, 'draft'],
    ]);
    expect(shown.events[1]!.payload).toEqual({ source: 'test' });

    expect((await get(`/api/v1/admin/markets/${randomUUID()}`)).statusCode).toBe(404);
    expect((await get('/api/v1/admin/markets/nope')).statusCode).toBe(400);
  });

  // --- the admin on screen (ADR-0092) --------------------------------------------------
  /** A second admin, whose cookie a tab that switched accounts would carry. */
  async function anotherAdmin(): Promise<TestUser> {
    const other = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, other.id));
    await completeOnboarding(t.db, { userId: other.id });
    await t.app.get(AdminGuard).invalidate(other.id);
    return other;
  }

  it('refuses every write that names another admin than the cookie’s, before anything is written', async () => {
    const other = await anotherAdmin();
    const draft = await market({ status: 'draft', rules: '규칙' });
    const open = await market({ status: 'open', closeAt: new Date(Date.now() + DAY_MS) });
    // The screen still shows `admin` while the tab's cookie is `other`'s.
    const asShown = { expectedAccountId: admin.id };
    for (const [what, res] of [
      ['create', await post('/api/v1/admin/markets', { ...createBody(), ...asShown }, other)],
      [
        'update',
        await patch(`/api/v1/admin/markets/${draft.id}`, { title: '바뀜', ...asShown }, other),
      ],
      ['open', await post(`/api/v1/admin/markets/${draft.id}/open`, asShown, other)],
      ['close', await post(`/api/v1/admin/markets/${open.id}/close`, asShown, other)],
    ] as const) {
      expect({ what, status: res.statusCode }).toEqual({ what, status: 403 });
      expect(errorOf(res).code).toBe('FORBIDDEN');
      expect(detailPath(res)).toEqual(['expectedAccountId']);
    }
    // Nothing was written: no new market, the two as they were, no event, no record.
    expect(await t.db.select().from(schema.markets)).toHaveLength(2);
    expect(await marketRow(draft.id)).toMatchObject({ status: 'draft', title: draft.title });
    expect((await marketRow(open.id)).status).toBe('open');
    expect(await t.db.select().from(schema.marketEvents)).toEqual([]);
    expect(await t.db.select().from(schema.adminActions)).toEqual([]);
  });

  it('asks every write for the admin on screen, and takes the cookie’s own', async () => {
    const draft = await market({ status: 'draft', rules: '규칙' });
    const unnamed = (method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>) =>
      t.app.inject({ method, url, headers: { ...jsonHeaders, cookie: admin.cookie }, payload });
    for (const [what, res] of [
      ['create', await unnamed('POST', '/api/v1/admin/markets', createBody())],
      ['update', await unnamed('PATCH', `/api/v1/admin/markets/${draft.id}`, { title: 'x' })],
      ['open', await unnamed('POST', `/api/v1/admin/markets/${draft.id}/open`, {})],
      ['close', await unnamed('POST', `/api/v1/admin/markets/${draft.id}/close`, {})],
    ] as const) {
      expect({ what, status: res.statusCode }).toEqual({ what, status: 400 });
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      expect(detailPath(res)).toEqual(['expectedAccountId']);
    }
    // A tab from before the deploy sends the formerly bodyless transitions with no body at all: the
    // same 400, but the schema's own issue (no object) names no field — `details[0].path` is [].
    for (const action of ['open', 'close'] as const) {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/v1/admin/markets/${draft.id}/${action}`,
        headers: { origin: jsonHeaders.origin, cookie: admin.cookie },
      });
      expect({ action, status: res.statusCode }).toEqual({ action, status: 400 });
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      expect(detailPath(res)).toEqual([]);
    }
    expect((await marketRow(draft.id)).status).toBe('draft');
    expect(await t.db.select().from(schema.adminActions)).toEqual([]);
    // The account checked is never stored: the `created` event keeps the fields as sent.
    const created = detail(await create({ slug: 'named-admin' }));
    expect(created.events[0]!.payload).not.toHaveProperty('expectedAccountId');
    const [event] = await eventsFor(created.id);
    expect(event!.payload).not.toHaveProperty('expectedAccountId');
    expect((await patch(`/api/v1/admin/markets/${created.id}`, { rules: '규칙' })).statusCode).toBe(
      200,
    );
    expect((await open(created.id)).statusCode).toBe(200);
    expect((await close(created.id)).statusCode).toBe(200);
    expect((await actionsFor(created.id)).map((row) => [row.type, row.adminId])).toEqual([
      ['market_create', admin.id],
      ['market_update', admin.id],
      ['market_open', admin.id],
      ['market_close', admin.id],
    ]);
  });

  // --- guards ---------------------------------------------------------------------------
  it('is closed to members and anonymous callers, on reads and writes alike', async () => {
    const row = await market({ status: 'draft' });
    for (const [method, url, payload] of [
      ['GET', '/api/v1/admin/markets', undefined],
      ['GET', `/api/v1/admin/markets/${row.id}`, undefined],
      ['POST', '/api/v1/admin/markets', createBody()],
      ['PATCH', `/api/v1/admin/markets/${row.id}`, { title: 'x' }],
      ['POST', `/api/v1/admin/markets/${row.id}/open`, undefined],
      ['POST', `/api/v1/admin/markets/${row.id}/close`, undefined],
    ] as const) {
      const asMember = await t.app.inject({
        method,
        url,
        headers: { ...jsonHeaders, cookie: member.cookie },
        payload,
      });
      expect({ method, url, status: asMember.statusCode }).toEqual({ method, url, status: 403 });
      expect(errorOf(asMember).code).toBe('FORBIDDEN');

      const anonymous = await t.app.inject({ method, url, headers: jsonHeaders, payload });
      expect({ method, url, status: anonymous.statusCode }).toEqual({ method, url, status: 401 });
      expect(errorOf(anonymous).code).toBe('UNAUTHENTICATED');
    }
    expect((await marketRow(row.id)).status).toBe('draft');
    expect(await t.db.select().from(schema.markets)).toHaveLength(1);
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);
  });

  it('refuses a cookie-authenticated mutation whose Origin is not ours (CSRF)', async () => {
    const row = await market({ status: 'draft' });
    for (const origin of ['https://evil.example', 'null']) {
      const created = await t.app.inject({
        method: 'POST',
        url: '/api/v1/admin/markets',
        headers: { origin, 'content-type': 'application/json', cookie: admin.cookie },
        payload: createBody(),
      });
      expect({ origin, status: created.statusCode }).toEqual({ origin, status: 403 });
      expect(errorOf(created).code).toBe('FORBIDDEN');
      const opened = await t.app.inject({
        method: 'POST',
        url: `/api/v1/admin/markets/${row.id}/open`,
        headers: { origin, cookie: admin.cookie },
      });
      expect(opened.statusCode).toBe(403);
    }
    expect(await t.db.select().from(schema.markets)).toHaveLength(1);
    expect((await marketRow(row.id)).status).toBe('draft');
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);

    // No Origin at all (curl, a server) is not a browser and passes; reads are never checked.
    const curl = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/markets/${row.id}/open`,
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      payload: { expectedAccountId: admin.id },
    });
    expect(curl.statusCode).toBe(200);
    const read = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/markets',
      headers: { origin: 'https://evil.example', cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
  });
});
