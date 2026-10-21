/**
 * 반복 링크 탐지 (#187, ADR-0083; ADR-0069 decision 2 #45-15, decision 4 #187 rows, decision 7)
 * against the docker `test` profile, through the routes that write and the admin review list.
 * Pinned: the same person's link in a third post or comment within 24 hours, or a third person's,
 * puts the items on the review list — never refusing or hiding them; links compared normalised
 * (case of the host, trailing slash, tracking parameters); the window's edges, for both rules;
 * items deleted or hidden since counted as the uses they were; the market's official sources and
 * an operator's writes left out; an edit that puts a link in counted, one that keeps it not (a
 * post's or a comment's); a body with thousands of links taking a bounded number of locks, and a
 * write refused or changing nothing taking none; the list's entries with each item's own author,
 * newest first a page at a time, admins only. Earlier uses are recorded straight into `link_uses`
 * at the times a case needs. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createLinkFlag,
  createLinkUse,
  createMarket,
  createPost,
  randomPhoneHash,
} from '@buddha/db/test';
import { adminLinkFlagSchema, type AdminLinkFlag } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { PhoneHasher } from '../identity/phone-hash.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';
import { LINK_LOCK_BUCKETS } from './link-review.service.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const LINK = 'https://news.example/articles/42';

/** A post body with `href` behind a link mark, as the editor's link button makes one. */
const linkedDoc = (href: string, text = '근거 기사') => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }],
    },
  ],
});
const plainDoc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe.skipIf(!hasTestInfra)('repeated links (integration, #187)', () => {
  let t: TestApp;
  let author: TestUser;
  let other: TestUser;
  let third: TestUser;
  let market: Awaited<ReturnType<typeof createMarket>>;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    author = await signUpTestUser(t);
    other = await signUpTestUser(t);
    third = await signUpTestUser(t);
    for (const who of [author, other, third]) await completeOnboarding(t.db, { userId: who.id });
    market = await createMarket(t.db, {
      title: '기준금리 인하',
      resolutionSource: '한국은행 보도자료 https://www.bok.or.kr',
    });
  });

  const send = (method: 'POST' | 'PUT', url: string, payload: object, who: TestUser) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/json', cookie: who.cookie },
      payload: JSON.stringify({ expectedAccountId: who.id, ...payload }),
    });
  const created = (res: { statusCode: number; body: string; json: <T>() => T }) => {
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ data: { id: string } }>().data;
  };
  const writePost = async (body: object, who: TestUser = author, marketId = market.id) =>
    created(await send('POST', '/posts', { marketId, body }, who));
  const writeComment = async (postId: string, body: string, who: TestUser = author) =>
    created(await send('POST', `/posts/${postId}/comments`, { body }, who));

  /** The review list's rows as `reason post-or-comment-id`, sorted. */
  const flags = async () =>
    (await t.db.select().from(schema.linkFlags))
      .map((row) => `${row.reason} ${row.url} ${row.postId ?? row.commentId!}`)
      .sort();
  const flagsOf = (reason: string, url: string, ids: readonly string[]) =>
    ids.map((id) => `${reason} ${url} ${id}`).sort();
  const uses = async () => (await t.db.select().from(schema.linkUses)).length;

  const hashOf = async (who: TestUser) => {
    const [row] = await t.db
      .select({ phone: schema.phoneVerifications.phone })
      .from(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, who.id));
    return t.app.get(PhoneHasher).hash(row!.phone);
  };

  const makeAdmin = async (who: TestUser) => {
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, who.id));
    await t.app.get(AdminGuard).invalidate(who.id);
  };
  /** A fourth account, onboarded and an operator, to read the review list with. */
  const anAdmin = async () => {
    const admin = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: admin.id });
    await makeAdmin(admin);
    return admin;
  };

  type ListPage = { data: AdminLinkFlag[]; meta: { nextCursor: string | null } };
  const readList = (query: string, who: TestUser) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1/admin/link-flags${query}`,
      headers: { cookie: who.cookie },
    });
  /** Every entry of the review list, a page of `limit` at a time, in the order the pages give. */
  const readAll = async (who: TestUser, limit = 20) => {
    const entries: AdminLinkFlag[] = [];
    let cursor: string | null = null;
    do {
      const query: string =
        cursor === null
          ? `?limit=${limit}`
          : `?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
      const res = await readList(query, who);
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<ListPage>();
      entries.push(...page.data.map((entry) => adminLinkFlagSchema.parse(entry)));
      cursor = page.meta.nextCursor;
    } while (cursor !== null);
    return entries;
  };
  const publicFace = async (who: TestUser) => {
    const [profile] = await t.db
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, who.id));
    return { userId: who.id, publicId: profile!.publicId, nickname: profile!.nickname };
  };

  // ---- the same person ---------------------------------------------------------------------------

  it('flags the same person’s link in a third post or comment within 24 hours, compared normalised', async () => {
    const first = await writePost(linkedDoc(LINK));
    // The same link, spelled another way: the host's case, a trailing slash, tracking parameters.
    const second = await writeComment(
      first.id,
      '여기도 https://NEWS.example/articles/42/?utm_source=x&fbclid=y 참고',
    );
    expect(await flags()).toEqual([]);
    const third_ = await writeComment(first.id, `다시 ${LINK}#본문`);
    expect(await flags()).toEqual(flagsOf('same_account', LINK, [first.id, second.id, third_.id]));
    // Neither refused nor hidden: the post and the comments read as ever.
    const page = await t.app.inject({ method: 'GET', url: `/api/v1/posts/${first.id}` });
    expect(page.json<{ data: { state: string } }>().data.state).toBe('published');
    const thread = await t.app.inject({
      method: 'GET',
      url: `/api/v1/posts/${first.id}/comments`,
    });
    expect(
      thread
        .json<{ data: { comment: { state: string } }[] }>()
        .data.map((row) => row.comment.state),
    ).toEqual(['published', 'published']);
    // A fourth joins the three; the three stay as they were put there.
    const fourth = await writePost(plainDoc(`또 ${LINK}`));
    expect(await flags()).toEqual(
      flagsOf('same_account', LINK, [first.id, second.id, third_.id, fourth.id]),
    );
  });

  it('counts posts and comments, not uses: one item taking a link again is one', async () => {
    const post = await writePost(linkedDoc(LINK));
    // Out and in again by edits: three uses of one post.
    expect(
      (await send('PUT', `/posts/${post.id}`, { body: plainDoc('없음') }, author)).statusCode,
    ).toBe(200);
    expect(
      (await send('PUT', `/posts/${post.id}`, { body: linkedDoc(LINK) }, author)).statusCode,
    ).toBe(200);
    expect(await uses()).toBe(2);
    await writeComment(post.id, LINK);
    expect(await flags()).toEqual([]);
  });

  it('looks 24 hours back: a use just older is out of the window, one just younger is in', async () => {
    const hash = await hashOf(author);
    const old = await createPost(t.db, { marketId: market.id, authorId: author.id });
    const older = await createPost(t.db, { marketId: market.id, authorId: author.id });
    await createLinkUse(t.db, {
      url: LINK,
      phoneHash: hash,
      postId: old.id,
      usedAt: new Date(Date.now() - 24 * HOUR_MS - MINUTE_MS),
    });
    await createLinkUse(t.db, {
      url: LINK,
      phoneHash: hash,
      postId: older.id,
      usedAt: new Date(Date.now() - 24 * HOUR_MS - 2 * MINUTE_MS),
    });
    await writePost(linkedDoc(LINK));
    expect(await flags()).toEqual([]);
    // Two within the day now (one 23h59m old) with the new one: three.
    const recent = await createPost(t.db, { marketId: market.id, authorId: author.id });
    await createLinkUse(t.db, {
      url: LINK,
      phoneHash: hash,
      postId: recent.id,
      usedAt: new Date(Date.now() - 24 * HOUR_MS + MINUTE_MS),
    });
    const latest = await writePost(linkedDoc(LINK));
    const flagged = (await flags()).map((row) => row.split(' ')[2]);
    expect(flagged).toHaveLength(3);
    expect(flagged).toEqual(expect.arrayContaining([recent.id, latest.id]));
    expect(flagged).not.toContain(old.id);
    expect(flagged).not.toContain(older.id);
  });

  // ---- different people ----------------------------------------------------------------------------

  it('flags a link three people put in within 24 hours, each person once', async () => {
    const a = await writePost(linkedDoc(LINK));
    const a2 = await writeComment(a.id, LINK);
    const b = await writeComment(a.id, `${LINK}/`, other);
    // Two people, three items: neither rule yet (the author's two are under three).
    expect(await flags()).toEqual([]);
    const c = await writePost(linkedDoc(`${LINK}?gclid=1`), third);
    expect(await flags()).toEqual(flagsOf('many_accounts', LINK, [a.id, a2.id, b.id, c.id]));
  });

  it('counts people within 24 hours: uses just older neither make the third nor go on the list', async () => {
    const day = 24 * HOUR_MS;
    // Two other people's uses of the link a minute out of the window.
    const stale: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const post = await createPost(t.db, { marketId: market.id, authorId: other.id });
      await createLinkUse(t.db, {
        url: LINK,
        phoneHash: randomPhoneHash(),
        postId: post.id,
        usedAt: new Date(Date.now() - day - MINUTE_MS),
      });
      stale.push(post.id);
    }
    const mine = await writePost(linkedDoc(LINK));
    // One person within the day: no rule.
    expect(await flags()).toEqual([]);
    // Another person's a minute inside it, then `other`: three people within the day.
    const recent = await createPost(t.db, { marketId: market.id, authorId: third.id });
    await createLinkUse(t.db, {
      url: LINK,
      phoneHash: randomPhoneHash(),
      postId: recent.id,
      usedAt: new Date(Date.now() - day + MINUTE_MS),
    });
    const theirs = await writePost(linkedDoc(LINK), other);
    expect(await flags()).toEqual(flagsOf('many_accounts', LINK, [mine.id, recent.id, theirs.id]));
  });

  it('counts the person, not the account: an earlier account on the same number is the same person', async () => {
    const hash = await hashOf(author);
    const elsewhere = await createPost(t.db, { marketId: market.id, authorId: other.id });
    // A use under the author's number by an account that withdrew (its hash is all that is left).
    await createLinkUse(t.db, { url: LINK, phoneHash: hash, postId: elsewhere.id });
    await writePost(linkedDoc(LINK));
    await writePost(linkedDoc(LINK), other);
    // Two people, not three; and the author's number has two items, not three.
    expect(await flags()).toEqual([]);
    // Its third item is the same person's third.
    const third_ = await writePost(linkedDoc(LINK));
    expect((await flags()).filter((row) => row.startsWith('same_account'))).toHaveLength(3);
    expect(await flags()).toContain(`same_account ${LINK} ${third_.id}`);
  });

  it('counts items deleted or hidden since as the uses they were (ADR-0083 7-19)', async () => {
    const first = await writePost(linkedDoc(LINK));
    expect((await send('POST', `/posts/${first.id}/delete`, {}, author)).statusCode).toBe(200);
    const second = await writePost(linkedDoc(LINK));
    await t.db
      .update(schema.posts)
      .set({ hiddenAt: new Date() })
      .where(eq(schema.posts.id, second.id));
    // The third: the author's deleted post and the post an operator hid are the first two.
    const third_ = await writePost(linkedDoc(LINK));
    expect(await flags()).toEqual(flagsOf('same_account', LINK, [first.id, second.id, third_.id]));
  });

  // ---- exceptions ----------------------------------------------------------------------------------

  it('leaves out the market’s official sources and the pages under them', async () => {
    for (const href of [
      'https://www.bok.or.kr',
      'https://www.bok.or.kr/portal/bbs/view.do?id=1',
      'https://WWW.bok.or.kr/portal/?utm_source=x',
    ]) {
      const post = await writePost(linkedDoc(href));
      // A comment's market is its post's.
      await writeComment(post.id, `출처 ${href}`, other);
    }
    expect(await uses()).toBe(0);
    expect(await flags()).toEqual([]);
    // Another market's source is not this market's: on a market without it, it counts.
    const elsewhere = await createMarket(t.db, { resolutionSource: '통계청' });
    for (let index = 0; index < 3; index += 1) {
      await writePost(linkedDoc('https://www.bok.or.kr/x'), third, elsewhere.id);
    }
    expect(await flags()).toHaveLength(3);
  });

  it('leaves out an operator’s writes, which count toward nobody’s rule either', async () => {
    await makeAdmin(third);
    for (let index = 0; index < 3; index += 1) await writePost(linkedDoc(LINK), third);
    expect(await uses()).toBe(0);
    await writePost(linkedDoc(LINK));
    await writePost(linkedDoc(LINK), other);
    // Two members and an operator: not three people.
    expect(await flags()).toEqual([]);
  });

  // ---- edits -----------------------------------------------------------------------------------------

  it('counts a link an edit puts in, never one the item had', async () => {
    const post = await writePost(linkedDoc(LINK));
    const comment = await writeComment(post.id, '링크 없음');
    const plain = await writePost(plainDoc('링크 없음'));
    expect(await uses()).toBe(1);
    // An edit that keeps the link adds no use.
    expect(
      (await send('PUT', `/posts/${post.id}`, { title: '제목', body: linkedDoc(LINK) }, author))
        .statusCode,
    ).toBe(200);
    expect(await uses()).toBe(1);
    // Edits that put it in: a comment's, then a post's — the third item.
    expect(
      (await send('PUT', `/comments/${comment.id}`, { body: `고침 ${LINK}` }, author)).statusCode,
    ).toBe(200);
    expect(await flags()).toEqual([]);
    expect(
      (await send('PUT', `/posts/${plain.id}`, { body: linkedDoc(`${LINK}/`) }, author)).statusCode,
    ).toBe(200);
    expect(await flags()).toEqual(flagsOf('same_account', LINK, [post.id, comment.id, plain.id]));
  });

  it('does not count again a link a comment keeps through an edit, however it is spelled', async () => {
    const post = await writePost(plainDoc('링크 없는 글'));
    const comment = await writeComment(post.id, `원래 ${LINK}`);
    expect(await uses()).toBe(1);
    expect(
      (
        await send(
          'PUT',
          `/comments/${comment.id}`,
          { body: `고친 댓글 ${LINK}/?utm_source=x` },
          author,
        )
      ).statusCode,
    ).toBe(200);
    expect(await uses()).toBe(1);
  });

  // ---- many links ------------------------------------------------------------------------------------

  it('takes a bounded number of locks for thousands of links, and none for a write that takes no link', async () => {
    // A link on every character: 2,500 distinct links in a post (about 3,000 fit its 256 KiB).
    const many = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: Array.from({ length: 2_500 }, (_, index) => ({
            type: 'text',
            text: 'a',
            marks: [{ type: 'link', attrs: { href: `https://many.example/${index}` } }],
          })),
        },
      ],
    };
    const draft = await createMarket(t.db, { status: 'draft' });
    const others = await writePost(plainDoc('남의 글'), other);
    /**
     * Another connection holding the links' last lock in an open transaction: a write of these
     * links takes their locks in key order, so it waits there with the others taken.
     */
    const holdLastLock = async () => {
      const holder = await t.db.$client.connect();
      let held = true;
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext('buddha:link'), $1::int)`, [
        LINK_LOCK_BUCKETS - 1,
      ]);
      const release = async () => {
        if (!held) return;
        held = false;
        await holder.query('ROLLBACK');
        holder.release();
      };
      return { holder, release };
    };

    let lock = await holdLastLock();
    try {
      // Refused writes answer at once: they never reach the links' locks.
      expect((await send('PUT', `/posts/${others.id}`, { body: many }, author)).statusCode).toBe(
        403,
      );
      expect(
        (await send('POST', '/posts', { marketId: draft.id, body: many }, author)).statusCode,
      ).toBe(404);
      // The post waits on the held lock, having taken the ones before it — fewer than the bound.
      const write = send('POST', '/posts', { marketId: market.id, body: many }, author);
      await waitForLockWaiter(lock.holder, 'the post with many links, on the links’ last lock');
      const { rows } = await lock.holder.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()
            AND classid = hashtext('buddha:link')::oid AND objsubid = 2`,
      );
      expect(rows[0]!.n).toBeGreaterThan(0);
      expect(rows[0]!.n).toBeLessThan(LINK_LOCK_BUCKETS);
      await lock.release();
      created(await write);
    } finally {
      await lock.release();
    }
    expect(await uses()).toBe(2_500);
    const [post] = await t.db
      .select({ id: schema.posts.id })
      .from(schema.posts)
      .where(eq(schema.posts.authorId, author.id));

    lock = await holdLastLock();
    try {
      // An edit that changes nothing, and one that changes the title only, put in no link.
      expect((await send('PUT', `/posts/${post!.id}`, { body: many }, author)).statusCode).toBe(
        200,
      );
      expect(
        (await send('PUT', `/posts/${post!.id}`, { title: '제목', body: many }, author)).statusCode,
      ).toBe(200);
      // Nor does a post the limits refuse: the third in 10 minutes passes, the fourth is refused.
      created(await send('POST', '/posts', { marketId: market.id, body: plainDoc('둘') }, author));
      created(await send('POST', '/posts', { marketId: market.id, body: plainDoc('셋') }, author));
      expect(
        (await send('POST', '/posts', { marketId: market.id, body: many }, author)).statusCode,
      ).toBe(429);
    } finally {
      await lock.release();
    }
    expect(await uses()).toBe(2_500);
  });

  // ---- the review list ---------------------------------------------------------------------------------

  it('lists the flagged items for admins, with why and the item as it is now, a page at a time', async () => {
    const admin = await anAdmin();
    const post = await writePost(linkedDoc(LINK));
    const comment = await writeComment(post.id, `댓글 ${LINK}`);
    const last = await writeComment(post.id, `또 ${LINK}`);
    await t.db
      .update(schema.postComments)
      .set({ hiddenAt: new Date() })
      .where(eq(schema.postComments.id, comment.id));

    const read = readList;
    expect((await read('', author)).statusCode).toBe(403);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/v1/admin/link-flags' })).statusCode,
    ).toBe(401);

    const res = await read('', admin);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<ListPage>();
    const entries = body.data.map((entry) => adminLinkFlagSchema.parse(entry));
    expect(entries).toHaveLength(3);
    expect(body.meta.nextCursor).toBeNull();
    const byTarget = new Map(
      entries.map((entry) => [entry.target.commentId ?? entry.target.postId, entry]),
    );
    expect(byTarget.get(post.id)).toMatchObject({
      url: LINK,
      reason: 'same_account',
      target: {
        kind: 'post',
        postId: post.id,
        commentId: null,
        excerpt: '근거 기사',
        deletedAt: null,
        hiddenAt: null,
        author: await publicFace(author),
        market: { id: market.id, slug: market.slug, title: market.title },
      },
    });
    expect(byTarget.get(comment.id)).toMatchObject({
      target: {
        kind: 'comment',
        postId: post.id,
        commentId: comment.id,
        excerpt: `댓글 ${LINK}`,
        hiddenAt: expect.any(String) as unknown,
      },
    });
    expect(byTarget.get(last.id)?.target.kind).toBe('comment');

    // A page at a time, in the same order.
    const firstPage = await read('?limit=2', admin);
    const one = firstPage.json<ListPage>();
    expect(one.data).toHaveLength(2);
    expect(one.meta.nextCursor).not.toBeNull();
    const next = await read(`?limit=2&cursor=${encodeURIComponent(one.meta.nextCursor!)}`, admin);
    const two = next.json<ListPage>();
    expect(two.data).toHaveLength(1);
    expect(two.meta.nextCursor).toBeNull();
    expect([...one.data, ...two.data].map((entry) => entry.id)).toEqual(
      entries.map((entry) => entry.id),
    );
  });

  it('names each flagged item’s own author: a comment under another member’s post is its writer’s', async () => {
    const admin = await anAdmin();
    const post = await writePost(linkedDoc(LINK));
    const comment = await writeComment(post.id, LINK, other);
    const elsewhere = await writePost(linkedDoc(LINK), third);
    const entries = await readAll(admin);
    expect(entries.map((entry) => entry.reason)).toEqual([
      'many_accounts',
      'many_accounts',
      'many_accounts',
    ]);
    const authorOf = (id: string) =>
      entries.find((entry) => (entry.target.commentId ?? entry.target.postId) === id)?.target
        .author;
    expect(authorOf(comment.id)).toEqual(await publicFace(other));
    expect(authorOf(post.id)).toEqual(await publicFace(author));
    expect(authorOf(elsewhere.id)).toEqual(await publicFace(third));
  });

  it('lists newest first by when the item went on the list, and pages through it in that order', async () => {
    const admin = await anAdmin();
    const items = [];
    for (let index = 0; index < 4; index += 1) {
      items.push(await createPost(t.db, { marketId: market.id, authorId: author.id }));
    }
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
    // Written out of order; the last two at one instant, which the id orders.
    const written = [
      await createLinkFlag(t.db, {
        url: LINK,
        reason: 'same_account',
        postId: items[0]!.id,
        flaggedAt: hoursAgo(2),
      }),
      await createLinkFlag(t.db, {
        url: LINK,
        reason: 'same_account',
        postId: items[1]!.id,
        flaggedAt: hoursAgo(3),
      }),
      await createLinkFlag(t.db, {
        url: LINK,
        reason: 'same_account',
        postId: items[2]!.id,
        flaggedAt: hoursAgo(1),
      }),
    ];
    const tied = hoursAgo(1);
    written.push(
      await createLinkFlag(t.db, {
        url: LINK,
        reason: 'many_accounts',
        postId: items[2]!.id,
        flaggedAt: tied,
      }),
      await createLinkFlag(t.db, {
        url: LINK,
        reason: 'many_accounts',
        postId: items[3]!.id,
        flaggedAt: tied,
      }),
    );
    const newestFirst = [...written]
      .sort(
        (a, b) =>
          b.flaggedAt.getTime() - a.flaggedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .map((row) => row.id);
    expect(newestFirst[newestFirst.length - 1]).toBe(written[1]!.id);
    // The first page holds the newest; a page of one at a time gives each entry once, in order.
    const first = (await readList('?limit=1', admin)).json<ListPage>();
    expect(first.data.map((entry) => entry.id)).toEqual([newestFirst[0]]);
    expect((await readAll(admin, 1)).map((entry) => entry.id)).toEqual(newestFirst);
    expect((await readAll(admin)).map((entry) => entry.id)).toEqual(newestFirst);
  });
});
