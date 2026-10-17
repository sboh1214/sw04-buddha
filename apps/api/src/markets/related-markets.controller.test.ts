/**
 * 관련 시장 (#65, ADR-0068) against the docker `test` profile: an admin links and unlinks two
 * markets (`/admin/markets/:id/related`), and a detail lists its related markets in public
 * (`GET /markets/:id/related`). Owner decisions under test (ADR-0061 decision 1, item 19; decision
 * 3, the #65 rows): two-way; open, closed, resolved and settled shown, voided and draft not; the
 * home's 추천 order; no cap; any status may be linked; actor and time recorded, and only for a
 * change; admins only; and a link touches neither market. And ADR-0068's of 2026-10-17: the
 * admin's list names who linked each market by nickname. Skips when TEST_* are unset.
 */
import { clockTimestamp, schema } from '@buddha/db';
import { createCategory, createFill, createMarket, createMarketLink } from '@buddha/db/test';
import { type AdminRelatedMarket, type MarketSummary, relatedMarketPair } from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { RelatedMarketsService } from './related-markets.service.js';

const ORIGIN = 'http://localhost:3000';
const jsonHeaders = { origin: ORIGIN, 'content-type': 'application/json' };
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type ListPage = { data: MarketSummary[]; meta: { nextCursor: string | null } };
type Market = Awaited<ReturnType<typeof createMarket>>;
type ErrorBody = {
  error: { code: string; message: string; details?: { path: (string | number)[] }[] };
};

describe.skipIf(!hasTestInfra)('related markets (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let member: TestUser;
  let category: { id: number };

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
    // The guard caches roles for 60 s (PLAN 10.5); the promotion above happened behind it.
    await t.app.get(AdminGuard).invalidate(admin.id);
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
  });

  const market = (input: Parameters<typeof createMarket>[1] = {}) =>
    createMarket(t.db, { createdBy: admin.id, categoryId: category.id, ...input });

  const get = (url: string, cookie?: string) =>
    t.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  const link = (id: string, marketId: string, cookie = admin.cookie) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/markets/${id}/related`,
      headers: { ...jsonHeaders, cookie },
      payload: { marketId },
    });
  const unlink = (id: string, relatedId: string, cookie = admin.cookie) =>
    t.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/markets/${id}/related/${relatedId}`,
      headers: { origin: ORIGIN, cookie },
    });

  const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
  const errorOf = (res: { json: <U>() => U }) => res.json<ErrorBody>().error;

  /** The public section's ids, first page. */
  async function shown(id: string): Promise<string[]> {
    const res = await get(`/api/v1/markets/${id}/related`);
    expect(res.statusCode).toBe(200);
    return res.json<ListPage>().data.map((row) => row.id);
  }
  /** The admin's list's ids. */
  async function adminLinks(id: string): Promise<string[]> {
    const res = await get(`/api/v1/admin/markets/${id}/related`, admin.cookie);
    expect(res.statusCode).toBe(200);
    return data<AdminRelatedMarket[]>(res).map((row) => row.id);
  }
  async function nicknameOf(userId: string) {
    const [row] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId));
    return row!.nickname;
  }
  async function actions() {
    return t.db
      .select()
      .from(schema.adminActions)
      .where(inArray(schema.adminActions.type, ['market_link', 'market_unlink']))
      .orderBy(asc(schema.adminActions.createdAt));
  }
  async function links() {
    return t.db.select().from(schema.marketLinks);
  }
  /**
   * Two new markets, the smaller id first: ids are random, so a test that unlinks from a given end
   * of the stored pair has to know which end that is — an unlink matching the raw ids rather than
   * the pair would otherwise be caught from one end only, about half the runs.
   */
  async function sortedPair(): Promise<[Market, Market]> {
    const one = await market();
    const two = await market();
    return one.id < two.id ? [one, two] : [two, one];
  }

  /** Follows `meta.nextCursor` to the end: every id in page order. */
  async function walk(url: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(cursor ? `${url}&cursor=${encodeURIComponent(cursor)}` : url);
      expect(res.statusCode).toBe(200);
      const page = res.json<ListPage>();
      ids.push(...page.data.map((row) => row.id));
      cursor = page.meta.nextCursor;
      pages += 1;
      if (pages > 50) throw new Error(`cursor never ended for ${url}`);
    } while (cursor);
    return ids;
  }

  it('links two-way: B on A’s detail and A on B’s, one row and one audit row with both ids', async () => {
    const a = await market();
    const b = await market();
    expect(await shown(a.id)).toEqual([]);

    const res = await link(a.id, b.id);
    expect(res.statusCode).toBe(200);
    // The answer is A's links as they now stand: B, with who linked it and when.
    const [row] = data<AdminRelatedMarket[]>(res);
    expect(row).toMatchObject({
      id: b.id,
      title: b.title,
      status: 'open',
      linkedBy: { id: admin.id, nickname: await nicknameOf(admin.id) },
    });

    expect(await shown(a.id)).toEqual([b.id]);
    expect(await shown(b.id)).toEqual([a.id]);
    expect(await adminLinks(b.id)).toEqual([a.id]);
    // The public item is the list row every card draws, and nothing about who linked it.
    const [item] = (await get(`/api/v1/markets/${a.id}/related`)).json<ListPage>().data;
    const listRow = (await get('/api/v1/markets')).json<ListPage>().data.find((r) => r.id === b.id);
    expect(item).toEqual(listRow);
    expect(item).not.toHaveProperty('linkedBy');
    expect(item).not.toHaveProperty('linkedAt');

    // One unordered pair, stored once; the actor and the instant, nothing more (no reason).
    const stored = await links();
    expect(stored).toEqual([
      expect.objectContaining({ ...relatedMarketPair(a.id, b.id), createdBy: admin.id }),
    ]);
    const audit = await actions();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      adminId: admin.id,
      type: 'market_link',
      targetType: 'market',
      targetId: a.id,
      payload: { marketId: a.id, relatedMarketId: b.id },
    });
    // One clock reading: the row and its record carry one instant. That they commit together is
    // the rollback test's ('together or not at all') — equal instants would hold either way.
    expect(audit[0]!.createdAt.getTime()).toBe(stored[0]!.createdAt.getTime());
    expect(row!.linkedAt).toBe(stored[0]!.createdAt.toISOString());
  });

  it('is idempotent both ways, and records only what changed the links', async () => {
    // `a` is the pair's smaller id and `b` its larger, so each end's unlink below is pinned.
    const [a, b] = await sortedPair();
    expect((await link(a.id, b.id)).statusCode).toBe(200);
    // Again, and from the other side: the same pair, so nothing is written.
    for (const [from, to] of [
      [a.id, b.id],
      [b.id, a.id],
      [a.id.toUpperCase(), b.id.toUpperCase()],
    ] as const) {
      const again = await link(from, to);
      expect(again.statusCode).toBe(200);
      expect(data<AdminRelatedMarket[]>(again)).toHaveLength(1);
    }
    expect(await links()).toHaveLength(1);
    expect((await actions()).map((row) => row.type)).toEqual(['market_link']);

    // Unlinked from the other side — the larger id's: the pair is gone for both, with one record.
    const res = await unlink(b.id, a.id);
    expect(res.statusCode).toBe(200);
    expect(data<AdminRelatedMarket[]>(res)).toEqual([]);
    expect(await shown(a.id)).toEqual([]);
    expect(await shown(b.id)).toEqual([]);
    expect(await links()).toHaveLength(0);
    // Again: nothing to unlink, nothing recorded.
    expect((await unlink(a.id, b.id)).statusCode).toBe(200);
    expect((await unlink(b.id, a.id)).statusCode).toBe(200);
    const audit = await actions();
    expect(audit.map((row) => row.type)).toEqual(['market_link', 'market_unlink']);
    expect(audit[1]).toMatchObject({
      adminId: admin.id,
      targetId: b.id,
      payload: { marketId: b.id, relatedMarketId: a.id },
    });

    // Linked again: a new row and a new record.
    expect((await link(b.id, a.id)).statusCode).toBe(200);
    expect(await shown(a.id)).toEqual([b.id]);
    expect((await actions()).map((row) => row.type)).toEqual([
      'market_link',
      'market_unlink',
      'market_link',
    ]);

    // …and unlinked from the smaller id's end this time: gone the same way, one more record.
    const fromLow = await unlink(a.id, b.id);
    expect(fromLow.statusCode).toBe(200);
    expect(data<AdminRelatedMarket[]>(fromLow)).toEqual([]);
    expect(await links()).toEqual([]);
    expect(await shown(b.id)).toEqual([]);
    const after = await actions();
    expect(after.map((row) => row.type)).toEqual([
      'market_link',
      'market_unlink',
      'market_link',
      'market_unlink',
    ]);
    expect(after[3]).toMatchObject({
      targetId: a.id,
      payload: { marketId: a.id, relatedMarketId: b.id },
    });
  });

  it('records one link when two admins link the same pair at once, and one unlink likewise', async () => {
    const a = await market();
    const b = await market();
    const answers = await Promise.all([link(a.id, b.id), link(b.id, a.id), link(a.id, b.id)]);
    expect(answers.map((res) => res.statusCode)).toEqual([200, 200, 200]);
    expect(await links()).toHaveLength(1);
    expect((await actions()).map((row) => row.type)).toEqual(['market_link']);

    // The second and third DELETE wait on the first's row lock and then find nothing to delete.
    const unlinks = await Promise.all([unlink(a.id, b.id), unlink(b.id, a.id), unlink(a.id, b.id)]);
    expect(unlinks.map((res) => res.statusCode)).toEqual([200, 200, 200]);
    expect(await links()).toEqual([]);
    expect((await actions()).map((row) => row.type)).toEqual(['market_link', 'market_unlink']);
  });

  it('commits a link or an unlink and its record together or not at all', async () => {
    // The record is written, then the transaction fails: nothing of it may remain — no link
    // without its record, no record of a change that never committed (AUDITED's rule,
    // admin-audit.test.ts). Review on #65: the equal instants above held whether or not the two
    // writes shared a transaction, so a link written on the pool, or a record written after the
    // transaction returned, passed every test.
    // The service's private `audit`, reached through the container's instance — the one the
    // controller calls.
    const service = t.app.get<
      RelatedMarketsService,
      { audit: (...args: unknown[]) => Promise<void> }
    >(RelatedMarketsService);
    const original = service.audit.bind(service);
    const failAfterRecord = () =>
      vi.spyOn(service, 'audit').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('injected failure');
      });
    const [a, b] = await sortedPair();

    const linking = failAfterRecord();
    const failedLink = await link(a.id, b.id);
    linking.mockRestore();
    expect(failedLink.statusCode).toBe(500);
    expect(errorOf(failedLink).code).toBe('INTERNAL');
    expect(await links()).toEqual([]);
    expect(await actions()).toEqual([]);
    expect(await shown(a.id)).toEqual([]);

    expect((await link(a.id, b.id)).statusCode).toBe(200);
    const unlinking = failAfterRecord();
    const failedUnlink = await unlink(b.id, a.id);
    unlinking.mockRestore();
    expect(failedUnlink.statusCode).toBe(500);
    expect(await links()).toHaveLength(1);
    expect((await actions()).map((row) => row.type)).toEqual(['market_link']);
    expect(await shown(a.id)).toEqual([b.id]);
    expect(await shown(b.id)).toEqual([a.id]);
  });

  it('refuses a market related to itself and unknown markets, naming the field that sent them', async () => {
    const a = await market();
    const self = await link(a.id, a.id);
    expect(self.statusCode).toBe(400);
    expect(errorOf(self)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(errorOf(self).details?.[0]?.path).toEqual(['marketId']);
    expect(errorOf(await link(a.id, a.id.toUpperCase())).code).toBe('VALIDATION_ERROR');
    // An unlink has no body: the other market is the path's `relatedMarketId`, and its refusals
    // name that, never a `marketId` the request does not have.
    const selfUnlink = await unlink(a.id, a.id);
    expect(selfUnlink.statusCode).toBe(400);
    expect(errorOf(selfUnlink)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(errorOf(selfUnlink).details?.[0]?.path).toEqual(['relatedMarketId']);

    // The body's market unknown: NOT_FOUND naming the field; the path's: a plain NOT_FOUND.
    const unknown = randomUUID();
    const other = await link(a.id, unknown);
    expect(other.statusCode).toBe(404);
    expect(errorOf(other).details?.[0]?.path).toEqual(['marketId']);
    const path = await link(unknown, a.id);
    expect(path.statusCode).toBe(404);
    expect(errorOf(path).details).toBeUndefined();
    const unknownUnlink = await unlink(a.id, unknown);
    expect(unknownUnlink.statusCode).toBe(404);
    expect(errorOf(unknownUnlink).details?.[0]?.path).toEqual(['relatedMarketId']);
    const pathUnlink = await unlink(unknown, a.id);
    expect(pathUnlink.statusCode).toBe(404);
    expect(errorOf(pathUnlink).details).toBeUndefined();
    expect((await get(`/api/v1/admin/markets/${unknown}/related`, admin.cookie)).statusCode).toBe(
      404,
    );
    // Malformed: bad input, not a 500.
    expect((await link(a.id, 'nope')).statusCode).toBe(400);
    expect((await link('nope', a.id)).statusCode).toBe(400);
    expect((await unlink(a.id, 'nope')).statusCode).toBe(400);

    expect(await links()).toHaveLength(0);
    expect(await actions()).toHaveLength(0);
  });

  it('links in any status; the detail shows open, closed, resolved and settled, never voided or drafts', async () => {
    const hub = await market();
    const byStatus = {
      open: await market(),
      closed: await market({ status: 'closed' }),
      resolved: await market({ status: 'resolved', resolvedResult: 'YES', resolvedAt: new Date() }),
      settled: await market({
        status: 'settled',
        resolvedResult: 'NO',
        resolvedAt: new Date(),
        settledAt: new Date(),
      }),
      voided: await market({ status: 'voided' }),
      draft: await market({ status: 'draft' }),
    };
    // Every status may be linked, a draft and a voided market included (ADR-0061 decision 3, #65).
    for (const linked of Object.values(byStatus)) {
      expect((await link(hub.id, linked.id)).statusCode).toBe(200);
    }
    const visible = [byStatus.open, byStatus.closed, byStatus.resolved, byStatus.settled];
    expect((await shown(hub.id)).sort()).toEqual(visible.map((row) => row.id).sort());
    // The admin keeps every link, with its status.
    const admins = data<AdminRelatedMarket[]>(
      await get(`/api/v1/admin/markets/${hub.id}/related`, admin.cookie),
    );
    expect(admins.map((row) => row.status).sort()).toEqual(
      ['closed', 'draft', 'open', 'resolved', 'settled', 'voided'].sort(),
    );

    // Seen from the other end, a hidden market lists the hub but has no public detail of its own:
    // a draft is NOT_FOUND like the detail, a voided market lists what it is linked to.
    expect(await shown(byStatus.closed.id)).toEqual([hub.id]);
    expect(await shown(byStatus.voided.id)).toEqual([hub.id]);
    expect((await get(`/api/v1/markets/${byStatus.draft.id}/related`)).statusCode).toBe(404);
    // A hub that is itself hidden shows nowhere: a voided hub is not on its partner's detail.
    const voidedHub = await market({ status: 'voided' });
    await link(voidedHub.id, byStatus.open.id);
    expect(await shown(byStatus.open.id)).toEqual([hub.id]);
  });

  it('answers NOT_FOUND for a draft or an unknown market, and 400 for a malformed id', async () => {
    const draft = await market({ status: 'draft' });
    const open = await market();
    await createMarketLink(t.db, { marketId: draft.id, relatedMarketId: open.id });
    for (const id of [draft.id, randomUUID()]) {
      const res = await get(`/api/v1/markets/${id}/related`);
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe('NOT_FOUND');
    }
    expect((await get('/api/v1/markets/not-a-uuid/related')).statusCode).toBe(400);
    // The slug is the detail's address, not this route's.
    expect((await get(`/api/v1/markets/${open.slug}/related`)).statusCode).toBe(400);
  });

  it('orders by 추천 — 24-hour volume, then the latest opening — and pages with no cap', async () => {
    const hub = await market();
    const now = (await clockTimestamp(t.db)).getTime();
    const fill = (marketId: string, amountCoin: bigint, ageMs: number) =>
      createFill(t.db, { marketId, amountCoin, createdAt: new Date(now - ageMs) });
    // The day's volume first: an old fill counts for nothing, however large.
    const busy = await market({ openAt: new Date(now - 3 * DAY_MS) });
    await fill(busy.id, 900n, HOUR_MS);
    const old = await market({ openAt: new Date(now - 3 * DAY_MS), volumeCoin: 50_000n });
    await fill(old.id, 50_000n, 2 * DAY_MS);
    const ended = await market({ status: 'closed', openAt: new Date(now - 3 * DAY_MS) });
    await fill(ended.id, 400n, HOUR_MS);
    // No fill in the window: by the actual open time, latest first.
    const later = await market({ openAt: new Date(now - HOUR_MS) });
    const earlier = await market({ openAt: new Date(now - 2 * HOUR_MS) });
    for (const linked of [old, earlier, ended, later, busy]) {
      await createMarketLink(t.db, { marketId: linked.id, relatedMarketId: hub.id });
    }
    const expected = [busy.id, ended.id, later.id, earlier.id, old.id];
    expect(await shown(hub.id)).toEqual(expected);
    // The same order the home and the search use (`marketOrder`), page by page on its cursor.
    expect(await walk(`/api/v1/markets/${hub.id}/related?limit=2`)).toEqual(expected);
    const search = (await get('/api/v1/markets?status=all&sort=recommended')).json<ListPage>();
    expect(search.data.map((row) => row.id).filter((id) => expected.includes(id))).toEqual(
      expected,
    );
    // A cursor of another shape serves the first page, not a 500.
    const foreign = await get(`/api/v1/markets/${hub.id}/related?cursor=1_${randomUUID()}`);
    expect(foreign.json<ListPage>().data.map((row) => row.id)).toEqual(expected);
  });

  it('lists every link with no cap: 25 related markets over two pages of the default 20', async () => {
    const hub = await market();
    const linked: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const row = await market();
      await createMarketLink(t.db, { marketId: hub.id, relatedMarketId: row.id });
      linked.push(row.id);
    }
    const first = (await get(`/api/v1/markets/${hub.id}/related`)).json<ListPage>();
    expect(first.data).toHaveLength(20);
    expect(first.meta.nextCursor).toBeTypeOf('string');
    expect((await walk(`/api/v1/markets/${hub.id}/related?limit=20`)).sort()).toEqual(
      linked.sort(),
    );
    expect(await adminLinks(hub.id)).toHaveLength(25);
  });

  it('lists the admin’s links latest first, and finds markets to link by title', async () => {
    const hub = await market();
    const base = (await clockTimestamp(t.db)).getTime() - HOUR_MS;
    const first = await market({ title: '서울 첫눈 관측 Snow' });
    const second = await market({ title: '부산 첫눈 관측', status: 'draft' });
    // Not linked; the one title with a literal '%'.
    const percent = await market({ title: '적설 100% 관측' });
    await createMarketLink(t.db, {
      marketId: hub.id,
      relatedMarketId: first.id,
      createdBy: admin.id,
      createdAt: new Date(base),
    });
    await createMarketLink(t.db, {
      marketId: second.id,
      relatedMarketId: hub.id,
      createdBy: admin.id,
      createdAt: new Date(base + 1_000),
    });
    const rows = data<AdminRelatedMarket[]>(
      await get(`/api/v1/admin/markets/${hub.id}/related`, admin.cookie),
    );
    expect(rows.map((row) => [row.id, row.linkedAt])).toEqual([
      [second.id, new Date(base + 1_000).toISOString()],
      [first.id, new Date(base).toISOString()],
    ]);

    // The picker's search: a title's part, any status, drafts too, case-insensitive, wildcards
    // literal.
    const search = async (q: string) =>
      (await get(`/api/v1/admin/markets?q=${encodeURIComponent(q)}`, admin.cookie))
        .json<ListPage>()
        .data.map((row) => row.id);
    expect((await search('첫눈')).sort()).toEqual([first.id, second.id].sort());
    expect(await search('SNOW')).toEqual([first.id]);
    expect(await search('%')).toEqual([percent.id]);
    expect(await search('_')).toEqual([]);
    expect((await get('/api/v1/admin/markets?q=', admin.cookie)).statusCode).toBe(400);
  });

  it('names who linked each market by id and current nickname (owner decision 2026-10-17)', async () => {
    const other = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, other.id));
    await t.app.get(AdminGuard).invalidate(other.id);
    const hub = await market();
    const a = await market();
    const b = await market();
    expect((await link(hub.id, a.id)).statusCode).toBe(200);
    // Linked by the other admin, from the other end: the hub's list still names that admin.
    expect((await link(b.id, hub.id, other.cookie)).statusCode).toBe(200);
    const linkers = async () =>
      new Map(
        data<AdminRelatedMarket[]>(
          await get(`/api/v1/admin/markets/${hub.id}/related`, admin.cookie),
        ).map((row) => [row.id, row.linkedBy]),
      );
    expect(await linkers()).toEqual(
      new Map([
        [a.id, { id: admin.id, nickname: await nicknameOf(admin.id) }],
        [b.id, { id: other.id, nickname: await nicknameOf(other.id) }],
      ]),
    );

    // The link keeps the id; the nickname is the account's current one, read with the list.
    const renamed = `renamed_${randomUUID().slice(0, 8)}`;
    await t.db
      .update(schema.profiles)
      .set({ nickname: renamed })
      .where(eq(schema.profiles.userId, other.id));
    expect((await linkers()).get(b.id)).toEqual({ id: other.id, nickname: renamed });
    // The public list still says nothing of who linked it.
    const [item] = (await get(`/api/v1/markets/${hub.id}/related`)).json<ListPage>().data;
    expect(item).not.toHaveProperty('linkedBy');
  });

  it('touches neither market: no row, rule, status or statistic moves', async () => {
    const a = await market({ lastPrice: 61, tradeCount: 3, volumeCoin: 700n });
    const b = await market({ status: 'closed' });
    const row = async (id: string) =>
      (await t.db.select().from(schema.markets).where(eq(schema.markets.id, id)))[0];
    const before = [await row(a.id), await row(b.id)];
    const events = async () => t.db.select().from(schema.marketEvents);
    expect((await link(a.id, b.id)).statusCode).toBe(200);
    expect(await links()).toHaveLength(1);
    expect([await row(a.id), await row(b.id)]).toEqual(before);
    expect((await unlink(a.id, b.id)).statusCode).toBe(200);
    // The link itself is gone — the only thing either request changed.
    expect(await links()).toEqual([]);
    expect([await row(a.id), await row(b.id)]).toEqual(before);
    expect(await events()).toEqual([]);
  });

  it('is the admin’s alone: members and visitors are refused, and a foreign Origin too', async () => {
    const a = await market();
    const b = await market();
    for (const [method, url, payload] of [
      ['GET', `/api/v1/admin/markets/${a.id}/related`, undefined],
      ['POST', `/api/v1/admin/markets/${a.id}/related`, { marketId: b.id }],
      ['DELETE', `/api/v1/admin/markets/${a.id}/related/${b.id}`, undefined],
    ] as const) {
      const headers = payload === undefined ? { origin: ORIGIN } : jsonHeaders;
      const asMember = await t.app.inject({
        method,
        url,
        headers: { ...headers, cookie: member.cookie },
        payload,
      });
      expect({ method, status: asMember.statusCode }).toEqual({ method, status: 403 });
      const anonymous = await t.app.inject({ method, url, headers, payload });
      expect({ method, status: anonymous.statusCode }).toEqual({ method, status: 401 });
    }
    for (const origin of ['https://evil.example', 'null']) {
      const linked = await t.app.inject({
        method: 'POST',
        url: `/api/v1/admin/markets/${a.id}/related`,
        headers: { origin, 'content-type': 'application/json', cookie: admin.cookie },
        payload: { marketId: b.id },
      });
      expect({ origin, status: linked.statusCode }).toEqual({ origin, status: 403 });
    }
    expect(await links()).toHaveLength(0);
    expect(await actions()).toHaveLength(0);

    // Linked, the foreign Origin cannot unlink either; the public read needs no session at all.
    await link(a.id, b.id);
    const unlinked = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/markets/${a.id}/related/${b.id}`,
      headers: { origin: 'https://evil.example', cookie: admin.cookie },
    });
    expect(unlinked.statusCode).toBe(403);
    expect(await links()).toHaveLength(1);
    expect(await shown(a.id)).toEqual([b.id]);
  });
});
