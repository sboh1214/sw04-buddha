/**
 * 반복 링크 탐지 (#187, ADR-0083; ADR-0069 decision 2 #45-15, decision 4 #187 rows, decision 7)
 * against the docker `test` profile, through the routes that write and the admin review list.
 * Pinned: the same person's link in a third post or comment within 24 hours, or a third person's,
 * puts the items on the review list — never refusing or hiding them, and every item the same
 * person's rule counts even when an operator's change of the number brought it to three; links
 * compared normalised (case of the host, trailing slash, tracking parameters); the window's edges,
 * for both rules;
 * items deleted or hidden since counted as the uses they were; the market's official sources and
 * an operator's writes left out; an edit that puts a link in counted, one that keeps it not (a
 * post's or a comment's); the first 20 links of an item in body order looked at, and an edit that
 * brings one into them counting it (owner decision 2026-10-22); a body with thousands of links
 * taking no more locks than the links it records, and a write refused or changing nothing taking
 * none; the review list grouped by link and rule, newest group first, a group's entries with each
 * item's own author a page at a time, admins only; and the mark '확인함' (owner decision
 * 2026-10-22) — its admin_actions record, a blank note none, the reviewed list, entries after
 * `through` and a fourth use left on the default list, two operators at once marking once (the
 * second waiting on the first's entries and finding none left). Earlier uses and entries are
 * recorded straight into `link_uses` and `link_flags` at the times a case needs. Skips when
 * TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  changePhoneAsOperator,
  completeOnboarding,
  createLinkFlag,
  createLinkUse,
  createMarket,
  createPost,
  randomPhone,
  randomPhoneHash,
} from '@buddha/db/test';
import {
  LINK_CHECK_MAX,
  adminLinkFlagGroupSchema,
  adminLinkFlagSchema,
  type AdminLinkFlag,
  type AdminLinkFlagGroup,
} from '@buddha/shared';
import { eq, sql } from 'drizzle-orm';
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

  type Page<T> = { data: T[]; meta: { nextCursor: string | null } };
  const readList = (query: string, who: TestUser) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1/admin/link-flags${query}`,
      headers: { cookie: who.cookie },
    });
  /** Every group of one part of the review list, a page of `limit` at a time, in page order. */
  const readGroups = async (
    who: TestUser,
    status: 'open' | 'reviewed' = 'open',
    limit = 20,
  ): Promise<AdminLinkFlagGroup[]> => {
    const groups: AdminLinkFlagGroup[] = [];
    let cursor: string | null = null;
    do {
      const after: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const res = await readList(`?status=${status}&limit=${limit}${after}`, who);
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<Page<unknown>>();
      groups.push(...page.data.map((group) => adminLinkFlagGroupSchema.parse(group)));
      cursor = page.meta.nextCursor;
    } while (cursor !== null);
    return groups;
  };
  const readItems = (url: string, reason: string, query: string, who: TestUser) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1/admin/link-flags/items?url=${encodeURIComponent(url)}&reason=${reason}${query}`,
      headers: { cookie: who.cookie },
    });
  /** Every entry of one group, a page of `limit` at a time, in page order. */
  const readAllItems = async (
    who: TestUser,
    url: string,
    reason: string,
    limit = 20,
    reviewId?: string,
  ): Promise<AdminLinkFlag[]> => {
    const entries: AdminLinkFlag[] = [];
    let cursor: string | null = null;
    do {
      const review = reviewId === undefined ? '' : `&reviewId=${reviewId}`;
      const after: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const res = await readItems(url, reason, `&limit=${limit}${review}${after}`, who);
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<Page<unknown>>();
      entries.push(...page.data.map((entry) => adminLinkFlagSchema.parse(entry)));
      cursor = page.meta.nextCursor;
    } while (cursor !== null);
    return entries;
  };
  /** An operator's mark '확인함' on `group`, as the screen sends it (`through` its latest time). */
  const markGroup = (group: AdminLinkFlagGroup, body: Record<string, unknown>, who: TestUser) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/link-flags/reviews',
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/json', cookie: who.cookie },
      payload: JSON.stringify({
        url: group.url,
        reason: group.reason,
        through: group.latestFlaggedAt,
        ...body,
      }),
    });
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

  it('flags every item of the same person’s link once an operator’s change of the number has brought the count to three without a write (ADR-0083 7-10)', async () => {
    const hasher = t.app.get(PhoneHasher);
    // The new number holds a use already, left by an account that withdrew from it.
    const newPhone = randomPhone();
    const left = await createPost(t.db, { marketId: market.id, authorId: other.id });
    await createLinkUse(t.db, { url: LINK, phoneHash: hasher.hash(newPhone), postId: left.id });
    // Two of the author's under the old number: two items, two people — no rule.
    const post = await writePost(linkedDoc(LINK));
    const comment = await writeComment(post.id, `댓글 ${LINK}`);
    expect(await flags()).toEqual([]);
    // docs/OPERATIONS.md's change moves the old number's day onto the new one: three items there
    // now, which no write counted.
    await changePhoneAsOperator(t.db, {
      userId: author.id,
      phone: newPhone,
      hash: (digits) => hasher.hash(digits),
    });
    expect(await flags()).toEqual([]);
    // The author's next use of the link puts every item the rule counts on the list, not only its
    // own (owner decision 2026-10-22 answer 1).
    const next = await writeComment(post.id, `또 ${LINK}`);
    expect(await flags()).toEqual(
      flagsOf('same_account', LINK, [left.id, post.id, comment.id, next.id]),
    );
    // And the one after that adds itself; the four stay as they were put there.
    const after = await writePost(plainDoc(`다시 ${LINK}`));
    expect(await flags()).toEqual(
      flagsOf('same_account', LINK, [left.id, post.id, comment.id, next.id, after.id]),
    );
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

  // ---- many links (owner decision 2026-10-22: the first 20 in body order) --------------------------

  /** A post body with one link mark per character, `count` links in all, `many.example/0` first. */
  const manyLinks = (count: number, host = 'many.example') => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: Array.from({ length: count }, (_, index) => ({
          type: 'text',
          text: 'a',
          marks: [{ type: 'link', attrs: { href: `https://${host}/${index}` } }],
        })),
      },
    ],
  });
  /** The links recorded, sorted. */
  const usedLinks = async () =>
    (await t.db.select({ url: schema.linkUses.url }).from(schema.linkUses))
      .map((row) => row.url)
      .sort();
  const firstOf = (count: number, host = 'many.example') =>
    Array.from({ length: count }, (_, index) => `https://${host}/${index}`).sort();

  it('looks at the first 20 links of a post or a comment in body order, and refuses neither for the rest', async () => {
    expect(LINK_CHECK_MAX).toBe(20);
    // 25 links in a post: the first 20 are recorded, the last 5 not — and the post is written.
    const post = await writePost(manyLinks(25));
    expect(await usedLinks()).toEqual(firstOf(20));
    // In body order, a written address and a link mark alike: 20 others before this one.
    const late = await writePost(
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '앞의 주소들' }] },
          ...manyLinks(20, 'early.example').content,
          { type: 'paragraph', content: [{ type: 'text', text: `늦은 ${LINK}` }] },
        ],
      },
      other,
    );
    expect((await usedLinks()).filter((url) => url === LINK)).toEqual([]);
    // A comment's 21st address is not looked at either.
    const comment = await writeComment(
      post.id,
      Array.from({ length: 21 }, (_, index) => `https://c.example/${index}`).join(' '),
    );
    const commentUses = (await t.db.select().from(schema.linkUses)).filter(
      (row) => row.commentId === comment.id,
    );
    expect(commentUses.map((row) => row.url).sort()).toEqual(firstOf(20, 'c.example'));
    // The same link counted once among the 20: two of one address take one place.
    const twice = await writePost(
      plainDoc(
        [
          LINK,
          LINK,
          ...Array.from({ length: 20 }, (_, index) => `https://d.example/${index}`),
        ].join(' '),
      ),
      third,
    );
    const twiceUses = (await t.db.select().from(schema.linkUses)).filter(
      (row) => row.postId === twice.id,
    );
    expect(twiceUses.map((row) => row.url).sort()).toEqual(
      [LINK, ...Array.from({ length: 19 }, (_, index) => `https://d.example/${index}`)].sort(),
    );
    expect(late.id).toBeDefined();
  });

  it('counts a link an edit brings into the first 20 as one it puts in', async () => {
    // The 21st link is not looked at; an edit that drops the first brings it into the 20.
    const post = await writePost(manyLinks(21));
    expect(await usedLinks()).toEqual(firstOf(20));
    const edited = manyLinks(21);
    edited.content[0]!.content.shift();
    expect((await send('PUT', `/posts/${post.id}`, { body: edited }, author)).statusCode).toBe(200);
    expect((await usedLinks()).filter((url) => url === 'https://many.example/20')).toEqual([
      'https://many.example/20',
    ]);
    // The links it kept among the first 20 are not counted again.
    expect(await usedLinks()).toHaveLength(21);
  });

  it('takes no more locks than the links it records, and none for a write that takes no link', async () => {
    // 2,500 distinct links in a post (about 3,000 fit its 256 KiB): 20 are recorded.
    const many = manyLinks(2_500);
    const draft = await createMarket(t.db, { status: 'draft' });
    const others = await writePost(plainDoc('남의 글'), other);
    /** The last bucket of the first 20 links, which a write takes last (key order). */
    const { rows: last } = await t.db.execute<{ key: number }>(sql`
      SELECT max(hashtext(link) & ${LINK_LOCK_BUCKETS - 1}::int)::int AS key
      FROM unnest(${sql.param(firstOf(20))}::text[]) AS link`);
    const lastKey = last[0]!.key;
    /**
     * Another connection holding that lock in an open transaction: a write of these links takes
     * their locks in key order, so it waits there with the others taken.
     */
    const holdLastLock = async () => {
      const holder = await t.db.$client.connect();
      let held = true;
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext('buddha:link'), $1::int)`, [
        lastKey,
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
      // The post waits on the held lock, having taken the ones before it — fewer than its 20.
      const write = send('POST', '/posts', { marketId: market.id, body: many }, author);
      await waitForLockWaiter(lock.holder, 'the post with many links, on its links’ last lock');
      const { rows } = await lock.holder.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()
            AND classid = hashtext('buddha:link')::oid AND objsubid = 2`,
      );
      expect(rows[0]!.n).toBeGreaterThan(0);
      expect(rows[0]!.n).toBeLessThan(LINK_CHECK_MAX);
      await lock.release();
      created(await write);
    } finally {
      await lock.release();
    }
    expect(await usedLinks()).toEqual(firstOf(20));
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
    expect(await usedLinks()).toEqual(firstOf(20));
  });

  it('puts a comment on the list while an operator hides it, the post’s comment count held by the comment that names it: neither waits for the other (#48’s counter, ADR-0083 7-13)', async () => {
    // The author's two comments with the link under another member's post; a third under the same
    // post meets `same_account` and puts all three on the list. Its insert moved the post's comment
    // count first (#48's trigger, post_comment_counts — the row held to its commit).
    const admin = await anAdmin();
    const post = await writePost(plainDoc('남의 글'), other);
    const first = await writeComment(post.id, `첫 ${LINK}`);
    const second = await writeComment(post.id, `둘 ${LINK}`);
    const { rows } = await t.db.execute<{ key: number }>(
      sql`SELECT (hashtext(${LINK}) & ${LINK_LOCK_BUCKETS - 1}::int)::int AS key`,
    );
    // Another connection holds the link's lock: the third comment waits there, its row written.
    const holder = await t.db.$client.connect();
    let held = true;
    const release = async () => {
      if (!held) return;
      held = false;
      await holder.query('ROLLBACK');
      holder.release();
    };
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext('buddha:link'), $1::int)`, [
        rows[0]!.key,
      ]);
      const third = send('POST', `/posts/${post.id}/comments`, { body: `셋 ${LINK}` }, author);
      await waitForLockWaiter(holder, 'the third comment, on the link’s lock');
      // An operator hides the first: it takes the comment's row, and its hidden_at moves the same
      // post's count, which the third comment holds — it waits for that comment's commit.
      const hiding = send(
        'POST',
        `/admin/moderation/comments/${first.id}/hide`,
        { reason: 'spam' },
        admin,
      );
      await waitForLockWaiter(holder, 'the hiding, on the post’s comment count', 2);
      // The third comment goes on and names the first on the list: the foreign-key check of that
      // insert (FOR KEY SHARE) on the row the hiding holds. While the hiding held it FOR UPDATE,
      // each waited for the other (40P01) and one of the two answered 500.
      await release();
      const [written, hidden] = await Promise.all([third, hiding]);
      const comment = created(written);
      expect(hidden.statusCode, hidden.body).toBe(200);
      expect(await flags()).toEqual(
        flagsOf('same_account', LINK, [first.id, second.id, comment.id]),
      );
      const [counted] = await t.db
        .select({ count: schema.postCommentCounts.count })
        .from(schema.postCommentCounts)
        .where(eq(schema.postCommentCounts.postId, post.id));
      expect(counted?.count).toBe(2);
    } finally {
      await release();
    }
  });

  // ---- the review list (owner decision 2026-10-22: grouped, marked '확인함') -------------------------

  it('groups the entries by link and rule for admins, newest group first, each group’s entries a page at a time', async () => {
    const admin = await anAdmin();
    const post = await writePost(linkedDoc(LINK));
    const comment = await writeComment(post.id, `댓글 ${LINK}`);
    const last = await writeComment(post.id, `또 ${LINK}`);
    await t.db
      .update(schema.postComments)
      .set({ hiddenAt: new Date() })
      .where(eq(schema.postComments.id, comment.id));

    expect((await readList('', author)).statusCode).toBe(403);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/v1/admin/link-flags' })).statusCode,
    ).toBe(401);
    expect((await readItems(LINK, 'same_account', '', author)).statusCode).toBe(403);

    // One row for the link and rule: three entries, the latest time.
    const groups = await readGroups(admin);
    expect(groups).toEqual([
      {
        url: LINK,
        reason: 'same_account',
        itemCount: 3,
        latestFlaggedAt: expect.any(String) as unknown,
        review: null,
      },
    ]);
    const flagged = await t.db.select().from(schema.linkFlags);
    expect(groups[0]!.latestFlaggedAt).toBe(
      new Date(Math.max(...flagged.map((row) => row.flaggedAt.getTime()))).toISOString(),
    );

    // Its entries, each with why and the item as it is now.
    const entries = await readAllItems(admin, LINK, 'same_account');
    expect(entries).toHaveLength(3);
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
    // A page at a time, in the same order; another rule or link is another group.
    expect((await readAllItems(admin, LINK, 'same_account', 1)).map((e) => e.id)).toEqual(
      entries.map((entry) => entry.id),
    );
    expect(await readAllItems(admin, LINK, 'many_accounts')).toEqual([]);
    expect(await readAllItems(admin, `${LINK}/x`, 'same_account')).toEqual([]);
  });

  it('names each flagged item’s own author: a comment under another member’s post is its writer’s', async () => {
    const admin = await anAdmin();
    const post = await writePost(linkedDoc(LINK));
    const comment = await writeComment(post.id, LINK, other);
    const elsewhere = await writePost(linkedDoc(LINK), third);
    expect((await readGroups(admin)).map((group) => [group.reason, group.itemCount])).toEqual([
      ['many_accounts', 3],
    ]);
    const entries = await readAllItems(admin, LINK, 'many_accounts');
    const authorOf = (id: string) =>
      entries.find((entry) => (entry.target.commentId ?? entry.target.postId) === id)?.target
        .author;
    expect(authorOf(comment.id)).toEqual(await publicFace(other));
    expect(authorOf(post.id)).toEqual(await publicFace(author));
    expect(authorOf(elsewhere.id)).toEqual(await publicFace(third));
  });

  it('orders the groups by their latest entry and a group’s entries newest first, paging through both', async () => {
    const admin = await anAdmin();
    const items = [];
    for (let index = 0; index < 4; index += 1) {
      items.push(await createPost(t.db, { marketId: market.id, authorId: author.id }));
    }
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
    const other1 = 'https://b.example/1';
    const other2 = 'https://c.example/2';
    // Three groups: LINK·same_account (latest 1h ago), other1·same_account (2h), and LINK's
    // many_accounts with two entries at one instant (3h), which the id orders.
    const written = [
      await createLinkFlag(t.db, {
        url: LINK,
        reason: 'same_account',
        postId: items[0]!.id,
        flaggedAt: hoursAgo(5),
      }),
      await createLinkFlag(t.db, {
        url: LINK,
        reason: 'same_account',
        postId: items[1]!.id,
        flaggedAt: hoursAgo(1),
      }),
      await createLinkFlag(t.db, {
        url: other1,
        reason: 'same_account',
        postId: items[2]!.id,
        flaggedAt: hoursAgo(2),
      }),
    ];
    const tied = hoursAgo(3);
    const tiedRows = [
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
    ];
    // A fourth group whose latest is as old as the tied ones: the group's newest entry's id
    // orders the two.
    const sameTime = await createLinkFlag(t.db, {
      url: other2,
      reason: 'many_accounts',
      postId: items[0]!.id,
      flaggedAt: tied,
    });
    const headOfTied = [...tiedRows].sort((a, b) => (a.id < b.id ? 1 : -1))[0]!;
    const tiedGroups = [
      { key: `${LINK} many_accounts`, id: headOfTied.id },
      { key: `${other2} many_accounts`, id: sameTime.id },
    ]
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .map((group) => group.key);
    const expected = [`${LINK} same_account`, `${other1} same_account`, ...tiedGroups];
    const keyOf = (group: AdminLinkFlagGroup) => `${group.url} ${group.reason}`;
    expect((await readGroups(admin)).map(keyOf)).toEqual(expected);
    expect((await readGroups(admin, 'open', 1)).map(keyOf)).toEqual(expected);
    expect((await readGroups(admin)).map((group) => group.itemCount)).toEqual(
      expected.map((key) =>
        key === `${LINK} same_account` || key.startsWith(`${LINK} m`) ? 2 : 1,
      ),
    );
    // A group's entries, newest first a page of one at a time.
    expect((await readAllItems(admin, LINK, 'same_account', 1)).map((e) => e.id)).toEqual([
      written[1]!.id,
      written[0]!.id,
    ]);
    expect((await readAllItems(admin, LINK, 'many_accounts', 1)).map((e) => e.id)).toEqual(
      [...tiedRows].sort((a, b) => (a.id < b.id ? 1 : -1)).map((row) => row.id),
    );
  });

  it('marks a group ‘확인함’ with what came of it, recorded, and moves it to the reviewed list', async () => {
    const admin = await anAdmin();
    const post = await writePost(linkedDoc(LINK));
    await writeComment(post.id, LINK);
    await writeComment(post.id, LINK);
    const [group] = await readGroups(admin);
    // Members cannot mark; nor can an empty or unknown outcome, or too long a note, be sent.
    expect((await markGroup(group!, { outcome: 'no_issue' }, author)).statusCode).toBe(403);
    for (const bad of [
      { outcome: 'resolved' },
      { outcome: 'no_issue', note: 'x'.repeat(501) },
      { outcome: 'no_issue', through: 'yesterday' },
    ]) {
      expect((await markGroup(group!, bad, admin)).statusCode).toBe(400);
    }
    expect(await t.db.select().from(schema.adminActions)).toEqual([]);

    const res = await markGroup(group!, { outcome: 'actioned', note: '  숨김 처리함  ' }, admin);
    expect(res.statusCode, res.body).toBe(201);
    const marked = adminLinkFlagGroupSchema.parse(res.json<{ data: unknown }>().data);
    const adminFace = await publicFace(admin);
    expect(marked).toEqual({
      url: LINK,
      reason: 'same_account',
      itemCount: 3,
      latestFlaggedAt: group!.latestFlaggedAt,
      review: {
        id: expect.any(String) as unknown,
        outcome: 'actioned',
        note: '숨김 처리함',
        reviewedAt: expect.any(String) as unknown,
        admin: { userId: admin.id, nickname: adminFace.nickname },
      },
    });
    // The record: who, when, the link, the rule, what came of it, the note, how many.
    const [action] = await t.db.select().from(schema.adminActions);
    expect(action).toMatchObject({
      id: marked.review!.id,
      adminId: admin.id,
      type: 'link_flag_review',
      targetType: 'link',
      targetId: LINK,
      payload: {
        reason: 'same_account',
        outcome: 'actioned',
        note: '숨김 처리함',
        itemCount: 3,
        through: group!.latestFlaggedAt,
      },
    });
    expect(action!.createdAt.toISOString()).toBe(marked.review!.reviewedAt);
    expect((await t.db.select().from(schema.linkFlags)).map((row) => row.reviewActionId)).toEqual([
      action!.id,
      action!.id,
      action!.id,
    ]);
    // Out of the default list, in the reviewed one with its entries; the post is as it was.
    expect(await readGroups(admin)).toEqual([]);
    expect(await readAllItems(admin, LINK, 'same_account')).toEqual([]);
    expect(await readGroups(admin, 'reviewed')).toEqual([marked]);
    expect(await readAllItems(admin, LINK, 'same_account', 20, marked.review!.id)).toHaveLength(3);
    const page = await t.app.inject({ method: 'GET', url: `/api/v1/posts/${post.id}` });
    expect(page.json<{ data: { state: string } }>().data.state).toBe('published');
    // Marked again: nothing left to mark, nothing written.
    expect((await markGroup(group!, { outcome: 'no_issue' }, admin)).statusCode).toBe(404);
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(1);

    // A fourth use joins the link and rule as a new, unmarked entry: back on the default list, by
    // itself; the mark keeps its three.
    const fourth = await writePost(plainDoc(`또 ${LINK}`));
    const [again] = await readGroups(admin);
    expect(again).toMatchObject({ url: LINK, reason: 'same_account', itemCount: 1, review: null });
    expect((await readAllItems(admin, LINK, 'same_account')).map((e) => e.target.postId)).toEqual([
      fourth.id,
    ]);
    const second = await markGroup(again!, { outcome: 'no_issue' }, admin);
    expect(second.statusCode, second.body).toBe(201);
    expect(
      adminLinkFlagGroupSchema.parse(second.json<{ data: unknown }>().data).review,
    ).toMatchObject({
      outcome: 'no_issue',
      note: null,
    });
    // The reviewed list: one row per mark, the newest first.
    expect(
      (await readGroups(admin, 'reviewed')).map((row) => [row.review!.outcome, row.itemCount]),
    ).toEqual([
      ['no_issue', 1],
      ['actioned', 3],
    ]);
    expect((await readGroups(admin, 'reviewed', 1)).map((row) => row.itemCount)).toEqual([1, 3]);
  });

  it('marks only the entries the operator saw: one put on the list after `through` stays on the default list', async () => {
    const admin = await anAdmin();
    const posts = [];
    for (let index = 0; index < 3; index += 1) {
      posts.push(await createPost(t.db, { marketId: market.id, authorId: author.id }));
    }
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MINUTE_MS);
    await createLinkFlag(t.db, {
      url: LINK,
      reason: 'same_account',
      postId: posts[0]!.id,
      flaggedAt: at(10),
    });
    await createLinkFlag(t.db, {
      url: LINK,
      reason: 'same_account',
      postId: posts[1]!.id,
      flaggedAt: at(5),
    });
    const [seen] = await readGroups(admin);
    expect(seen!.itemCount).toBe(2);
    // Another entry arrives while the operator reads.
    const late = await createLinkFlag(t.db, {
      url: LINK,
      reason: 'same_account',
      postId: posts[2]!.id,
      flaggedAt: at(1),
    });
    const res = await markGroup(seen!, { outcome: 'no_issue' }, admin);
    expect(res.statusCode, res.body).toBe(201);
    expect(adminLinkFlagGroupSchema.parse(res.json<{ data: unknown }>().data).itemCount).toBe(2);
    expect(await readGroups(admin)).toEqual([
      {
        url: LINK,
        reason: 'same_account',
        itemCount: 1,
        latestFlaggedAt: late.flaggedAt.toISOString(),
        review: null,
      },
    ]);
  });

  it('takes a blank note as none: neither the answer, the record nor the reviewed list carries one', async () => {
    const admin = await anAdmin();
    const post = await writePost(linkedDoc(LINK));
    await writeComment(post.id, LINK);
    await writeComment(post.id, LINK);
    const [group] = await readGroups(admin);
    const res = await markGroup(group!, { outcome: 'no_issue', note: ' \n  ' }, admin);
    expect(res.statusCode, res.body).toBe(201);
    expect(adminLinkFlagGroupSchema.parse(res.json<{ data: unknown }>().data).review?.note).toBe(
      null,
    );
    const [action] = await t.db.select().from(schema.adminActions);
    expect(action!.payload).toMatchObject({ outcome: 'no_issue', note: null });
    expect((await readGroups(admin, 'reviewed')).map((row) => row.review?.note)).toEqual([null]);
  });

  it('marks a group once when two operators mark it at once: the second waits for the first and finds nothing left', async () => {
    const admin = await anAdmin();
    const second = await anAdmin();
    const post = await writePost(linkedDoc(LINK));
    await writeComment(post.id, LINK);
    await writeComment(post.id, LINK);
    const [group] = await readGroups(admin);
    // The first operator's mark, held open on another connection: its record written and the
    // group's entries naming it, not yet committed — so it holds their row locks.
    const holder = await t.db.$client.connect();
    let answer: ReturnType<typeof markGroup> | undefined;
    let first: string;
    try {
      await holder.query('BEGIN');
      const { rows } = await holder.query<{ id: string }>(
        `INSERT INTO admin_actions (admin_id, type, target_type, target_id, payload)
           VALUES ($1, 'link_flag_review', 'link', $2, $3::jsonb) RETURNING id`,
        [
          admin.id,
          LINK,
          JSON.stringify({
            reason: 'same_account',
            outcome: 'no_issue',
            note: null,
            itemCount: 3,
            through: group!.latestFlaggedAt,
          }),
        ],
      );
      first = rows[0]!.id;
      await holder.query(
        `UPDATE link_flags SET review_action_id = $1
           WHERE url = $2 AND reason = 'same_account' AND review_action_id IS NULL`,
        [first, LINK],
      );
      // The second mark waits for them in its FOR UPDATE, then reads the entries again: none is
      // left unmarked. (Without FOR UPDATE it would wait in its UPDATE instead and meet the
      // entries' mark-once trigger: a 500.)
      answer = markGroup(group!, { outcome: 'actioned' }, second);
      await waitForLockWaiter(holder, 'the second mark, on the group’s entries');
      await holder.query('COMMIT');
    } catch (error) {
      await holder.query('ROLLBACK');
      throw error;
    } finally {
      holder.release();
    }
    const res = await answer;
    expect(res.statusCode, res.body).toBe(404);
    expect((await t.db.select().from(schema.adminActions)).map((row) => row.id)).toEqual([first]);
    expect((await t.db.select().from(schema.linkFlags)).map((row) => row.reviewActionId)).toEqual([
      first,
      first,
      first,
    ]);
  });

  it('marks a group once when two operators send their marks together', async () => {
    const admin = await anAdmin();
    const second = await anAdmin();
    const post = await writePost(linkedDoc(LINK));
    await writeComment(post.id, LINK);
    await writeComment(post.id, LINK);
    const [group] = await readGroups(admin);
    const answers = await Promise.all([
      markGroup(group!, { outcome: 'no_issue' }, admin),
      markGroup(group!, { outcome: 'actioned' }, second),
    ]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([201, 404]);
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(1);
    expect(
      new Set((await t.db.select().from(schema.linkFlags)).map((row) => row.reviewActionId)).size,
    ).toBe(1);
  });
});
