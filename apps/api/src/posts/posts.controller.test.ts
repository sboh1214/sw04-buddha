/**
 * 근거 글 (#46, ADR-0073; ADR-0069 decision 2 #45) against the docker `test` profile: the
 * community list, a post page and the author's writes. Pinned: anyone reads, only an account that
 * finished the onboarding writes or edits, and any signed-in author deletes their own post (owner
 * decision 2026-10-19); a post is on one market in any public status; the body is
 * normalised (no markup, links http(s) only, images the author's own uploads); the author is named
 * by public id, current nickname and 운영자 mark, never the account id; edits keep the operators'
 * history and show as edited; deletion and hiding follow #45-5; writing never touches a balance,
 * an order or a position. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createCategory,
  createComment,
  createMarket,
  createMedia,
  createPost,
  createUser,
} from '@buddha/db/test';
import {
  POST_BODY_MAX_LENGTH,
  postDeletionSchema,
  postDocumentInputSchema,
  postExcerpt,
  postImageNotUsableMessage,
  postSchema,
  postSummarySchema,
  type Post,
  type PostSummary,
  type PublishedPost,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';
import { PostsService, postAuthorOf, publicStateOf } from './posts.service.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

type ListPage = { data: PostSummary[]; meta: { nextCursor: string | null } };
type DiscussionPage = {
  data: PostSummary[];
  meta: { nextCursor: string | null; total: number };
};

const doc = (...paragraphs: string[]) => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

describe('the public face of a post (static)', () => {
  it('names the author by public id, nickname, image and the 운영자 mark, never more', () => {
    expect(
      postAuthorOf({ publicId: 'abcdefgh23', nickname: '예측가', role: 'admin', imageId: null }),
    ).toEqual({
      kind: 'member',
      publicId: 'abcdefgh23',
      nickname: '예측가',
      imageUrl: null,
      isAdmin: true,
    });
    expect(
      postAuthorOf({ publicId: 'abcdefgh23', nickname: 'x', role: 'user', imageId: null }),
    ).toMatchObject({ isAdmin: false });
    // The profile image (#141) as its address, read through the API like a post's image.
    const imageId = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';
    expect(
      postAuthorOf({ publicId: 'abcdefgh23', nickname: 'x', role: 'user', imageId }),
    ).toMatchObject({ imageUrl: `/api/v1/media/${imageId}` });
  });

  it('shows a deleted post as a placeholder only while comments not deleted hang under it (#45-5)', () => {
    const at = new Date();
    expect(publicStateOf({ deletedAt: null, hiddenAt: null }, false)).toBe('published');
    expect(publicStateOf({ deletedAt: at, hiddenAt: null }, false)).toBe('gone');
    expect(publicStateOf({ deletedAt: at, hiddenAt: null }, true)).toBe('deleted');
    expect(publicStateOf({ deletedAt: null, hiddenAt: at }, false)).toBe('hidden');
    // The author's deletion comes first.
    expect(publicStateOf({ deletedAt: at, hiddenAt: at }, true)).toBe('deleted');
    expect(publicStateOf({ deletedAt: at, hiddenAt: at }, false)).toBe('gone');
  });
});

describe.skipIf(!hasTestInfra)('/api/v1/posts (integration)', () => {
  let t: TestApp;
  let author: TestUser;
  let other: TestUser;
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
    await completeOnboarding(t.db, { userId: author.id });
    await completeOnboarding(t.db, { userId: other.id });
    market = await createMarket(t.db, { title: '기준금리 인하' });
  });

  const send = (method: 'POST' | 'PUT', url: string, payload: unknown, who: TestUser | null) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
        ...(who ? { cookie: who.cookie } : {}),
      },
      payload: JSON.stringify(payload),
    });

  const write = (body: Record<string, unknown> = {}, who: TestUser | null = author) =>
    send(
      'POST',
      '/posts',
      { marketId: market.id, body: doc('근거입니다'), expectedAccountId: who?.id ?? 'x', ...body },
      who,
    );
  const written = async (body: Record<string, unknown> = {}, who: TestUser = author) => {
    const res = await write(body, who);
    expect(res.statusCode, res.body).toBe(201);
    return postSchema.parse(res.json<{ data: unknown }>().data) as PublishedPost;
  };
  const edit = (postId: string, body: Record<string, unknown>, who: TestUser = author) =>
    send('PUT', `/posts/${postId}`, { expectedAccountId: who.id, ...body }, who);
  const remove = (postId: string, who: TestUser = author) =>
    send('POST', `/posts/${postId}/delete`, { expectedAccountId: who.id }, who);

  const page = async (query = '', cookie?: string): Promise<ListPage> => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/posts${query === '' ? '' : `?${query}`}`,
      headers: cookie ? { cookie } : {},
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<ListPage>();
    for (const row of body.data) postSummarySchema.parse(row);
    return body;
  };
  const listed = async (query = '') => (await page(query)).data.map((row) => row.id);
  const show = (postId: string, cookie?: string) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1/posts/${postId}`,
      headers: cookie ? { cookie } : {},
    });
  const shown = async (postId: string): Promise<Post> => {
    const res = await show(postId);
    expect(res.statusCode, res.body).toBe(200);
    return postSchema.parse(res.json<{ data: unknown }>().data);
  };

  /** An upload of `who`'s, as `POST /media/images` leaves it. */
  const upload = (who: TestUser = author) => createMedia(t.db, { ownerId: who.id });

  // ---- writing --------------------------------------------------------------------------------

  it('writes a post on a market and shows it to everyone, the author by public face only', async () => {
    const post = await written({ title: '  금리 전망  ', body: doc('첫 줄', '둘째 줄') });
    expect(post).toMatchObject({
      state: 'published',
      title: '금리 전망',
      body: doc('첫 줄', '둘째 줄'),
      market: {
        id: market.id,
        slug: market.slug,
        title: '기준금리 인하',
        status: 'open',
        category: { slug: expect.any(String) as unknown },
      },
      editedAt: null,
    });
    const [profile] = await t.db
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, author.id));
    expect(post.author).toEqual({
      kind: 'member',
      publicId: profile!.publicId,
      nickname: profile!.nickname,
      imageUrl: null,
      isAdmin: false,
    });
    // Anonymous, another account and the author read the same post; the account id is in none.
    for (const cookie of [undefined, other.cookie, author.cookie]) {
      const res = await show(post.id, cookie);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(author.id);
      expect(res.body).not.toContain(author.email);
    }
    const [row] = await t.db.select().from(schema.posts);
    expect(row).toMatchObject({ authorId: author.id, bodyText: '첫 줄\n둘째 줄', imageIds: [] });
  });

  it('writes on a market in every public status, never a draft or an unknown one', async () => {
    for (const status of ['closed', 'resolved', 'settled', 'voided'] as const) {
      const ended = await createMarket(t.db, { status });
      const res = await write({ marketId: ended.id });
      expect({ status, code: res.statusCode }).toEqual({ status, code: 201 });
    }
    const draft = await createMarket(t.db, { status: 'draft' });
    for (const marketId of [draft.id, '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60']) {
      const res = await write({ marketId });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: { details: unknown } }>().error.details).toEqual([
        { path: ['marketId'], message: 'no such market' },
      ]);
    }
    expect(await t.db.select().from(schema.posts)).toHaveLength(4);
  });

  it('is open to a signed-in account that finished the onboarding, naming itself', async () => {
    expect((await write({}, null)).statusCode).toBe(401);
    const newcomer = await signUpTestUser(t);
    const early = await write({}, newcomer);
    expect(early.statusCode).toBe(409);
    expect(early.json<{ error: { code: string } }>().error.code).toBe('ONBOARDING_REQUIRED');
    const misnamed = await write({ expectedAccountId: other.id });
    expect(misnamed.statusCode).toBe(403);
    expect(await t.db.select().from(schema.posts)).toEqual([]);
  });

  it('keeps the allowed formatting and removes the rest, markup never parsed', async () => {
    const post = await written({
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '<script>alert(1)</script>',
                marks: [
                  { type: 'link', attrs: { href: 'javascript:alert(1)' } },
                  { type: 'bold' },
                  { type: 'textStyle', attrs: { color: 'expression(alert(1))' } },
                ],
              },
              {
                type: 'text',
                text: '출처',
                marks: [{ type: 'link', attrs: { href: 'https://example.com/report' } }],
              },
            ],
          },
          { type: 'iframe', attrs: { src: 'https://evil.example' } },
          { type: 'image', attrs: { src: 'https://evil.example/x.png' } },
        ],
      },
    });
    expect(post.body).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '<script>alert(1)</script>', marks: [{ type: 'bold' }] },
            {
              type: 'text',
              text: '출처',
              marks: [{ type: 'link', attrs: { href: 'https://example.com/report' } }],
            },
          ],
        },
      ],
    });
  });

  it('refuses a body over the limits and a title over 100 characters, writing nothing', async () => {
    const long = await write({ body: doc('가'.repeat(POST_BODY_MAX_LENGTH + 1)) });
    expect(long.statusCode).toBe(400);
    expect(
      long.json<{ error: { details: { path: unknown[] }[] } }>().error.details[0]?.path,
    ).toEqual(['body']);
    expect((await write({ body: doc('   ') })).statusCode).toBe(400);
    expect((await write({ body: '<p>html</p>' })).statusCode).toBe(400);
    expect((await write({ title: '가'.repeat(101) })).statusCode).toBe(400);
    expect((await write({ body: doc('가'.repeat(POST_BODY_MAX_LENGTH)) })).statusCode).toBe(201);
    expect(await t.db.select().from(schema.posts)).toHaveLength(1);
  });

  it('takes the author’s own uploads only, each by one post, and attaches them', async () => {
    const mine = await upload();
    const theirs = await upload(other);
    const image = (mediaId: string) => ({ type: 'image', attrs: { mediaId } });
    const withImages = (...ids: string[]) => ({
      ...doc('사진'),
      content: [...doc('사진').content, ...ids.map(image)],
    });
    const refused = await write({ body: withImages(theirs.id) });
    expect(refused.statusCode).toBe(400);
    // The message the web reads the image from (`postBodyRefusalOf`), naming it.
    expect(refused.json<{ error: { details: unknown } }>().error.details).toEqual([
      { path: ['body'], message: postImageNotUsableMessage(theirs.id) },
    ]);
    const unknown = await write({ body: withImages('0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60') });
    expect(unknown.statusCode).toBe(400);

    const post = await written({ body: withImages(mine.id, mine.id) });
    expect(await t.db.select().from(schema.postImages)).toEqual([
      { postId: post.id, mediaId: mine.id, createdAt: expect.any(Date) as unknown },
    ]);
    const [attached] = await t.db
      .select()
      .from(schema.mediaObjects)
      .where(eq(schema.mediaObjects.id, mine.id));
    expect(attached?.attachedAt).toBeInstanceOf(Date);
    // Another post, the same author's too, uploads its own.
    const again = await write({ body: withImages(mine.id) });
    expect(again.statusCode).toBe(400);
    // The card's thumbnail is the first image.
    const [card] = (await page()).data;
    expect(card?.thumbnailUrl).toBe(`/api/v1/media/${mine.id}`);
  });

  // ---- one upload, two writes at once ----------------------------------------------------------

  const withImage = (mediaId: string) => ({
    type: 'doc',
    content: [...doc('사진').content, { type: 'image', attrs: { mediaId } }],
  });

  /**
   * Another write of the author's that has taken `mediaId` for `postId` and not committed yet —
   * what PostsService.create holds between its claim and its commit: the upload locked, the
   * post's image recorded. Runs `whileHeld` (which starts the write under test and returns it)
   * once that write waits on the lock, then commits, and answers that write's response.
   */
  async function racingTheClaim<T>(
    mediaId: string,
    postId: string,
    whileHeld: () => Promise<T>,
  ): Promise<T> {
    const holder = await t.db.$client.connect();
    let pending: Promise<T> | undefined;
    let committed = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM media_objects WHERE id = $1 FOR UPDATE', [mediaId]);
      await holder.query('INSERT INTO post_images (post_id, media_id) VALUES ($1, $2)', [
        postId,
        mediaId,
      ]);
      await holder.query('UPDATE posts SET image_ids = ARRAY[$1]::uuid[] WHERE id = $2', [
        mediaId,
        postId,
      ]);
      await holder.query('UPDATE media_objects SET attached_at = now() WHERE id = $1', [mediaId]);
      pending = whileHeld();
      await waitForLockWaiter(holder, 'the write on the upload another write holds');
      await holder.query('COMMIT');
      committed = true;
      return await pending;
    } finally {
      if (!committed) await holder.query('ROLLBACK');
      holder.release();
      await pending?.catch(() => undefined);
    }
  }

  it('refuses an upload another write took while this one waited for it (READ COMMITTED)', async () => {
    const mine = await upload();
    const first = await createPost(t.db, { marketId: market.id, authorId: author.id });
    // A new post, sent while another post's write holds the same upload: it waits, then must see
    // the claim that write committed — not the image as free, from before it waited.
    const res = await racingTheClaim(mine.id, first.id, () => write({ body: withImage(mine.id) }));
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ error: { details: unknown } }>().error.details).toEqual([
      { path: ['body'], message: postImageNotUsableMessage(mine.id) },
    ]);
    expect(await t.db.select().from(schema.postImages)).toEqual([
      { postId: first.id, mediaId: mine.id, createdAt: expect.any(Date) as unknown },
    ]);
    expect((await t.db.select().from(schema.posts)).map((row) => row.id)).toEqual([first.id]);
  });

  it('refuses it to an edit racing another write the same way, changing nothing', async () => {
    const mine = await upload();
    const first = await createPost(t.db, { marketId: market.id, authorId: author.id });
    const second = await written({ title: '두 번째' });
    const res = await racingTheClaim(mine.id, first.id, () =>
      edit(second.id, { title: '두 번째', body: withImage(mine.id) }),
    );
    expect(res.statusCode, res.body).toBe(400);
    const [row] = await t.db.select().from(schema.posts).where(eq(schema.posts.id, second.id));
    expect(row).toMatchObject({ imageIds: [], editedAt: null });
    expect(await t.db.select().from(schema.postRevisions)).toEqual([]);
    expect(
      (await t.db.select().from(schema.postImages)).map((link) => [link.postId, link.mediaId]),
    ).toEqual([[first.id, mine.id]]);
  });

  it('lets one of two posts sent at once with one upload have it, never both', async () => {
    const mine = await upload();
    const answers = await Promise.all([
      write({ body: withImage(mine.id) }),
      write({ body: withImage(mine.id) }),
    ]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([201, 400]);
    const links = await t.db.select().from(schema.postImages);
    const posts = await t.db.select().from(schema.posts);
    expect(posts).toHaveLength(1);
    expect(links.map((link) => [link.postId, link.mediaId])).toEqual([[posts[0]!.id, mine.id]]);
  });

  it('stores a lone surrogate as U+FFFD instead of failing the write (jsonb refuses it)', async () => {
    // JSON.stringify writes the lone half as `\ud800`; the API's JSON.parse makes it a lone
    // surrogate again, which jsonb refuses (22P02) — a 500 before the sanitiser replaced it.
    const post = await written({ title: 'a\ud800b', body: doc('c\udc00d') });
    expect(post).toMatchObject({ title: 'a\uFFFDb', body: doc('c\uFFFDd') });
    const [row] = await t.db.select().from(schema.posts);
    expect(row).toMatchObject({ title: 'a\uFFFDb', bodyText: 'c\uFFFDd' });
    // The same title and body sent again are the same post: no revision.
    expect((await edit(post.id, { title: 'a\ud800b', body: doc('c\udc00d') })).statusCode).toBe(
      200,
    );
    expect(await t.db.select().from(schema.postRevisions)).toEqual([]);
  });

  it('writes without touching a balance, an order or a position (N05 §2)', async () => {
    const before = await Promise.all([
      t.db.select().from(schema.balances).orderBy(asc(schema.balances.userId)),
      t.db.select().from(schema.ledgerEntries),
      t.db.select().from(schema.orders),
      t.db.select().from(schema.positions),
    ]);
    const post = await written();
    await edit(post.id, { title: '고침', body: doc('고친 근거') });
    await remove(post.id);
    expect(
      await Promise.all([
        t.db.select().from(schema.balances).orderBy(asc(schema.balances.userId)),
        t.db.select().from(schema.ledgerEntries),
        t.db.select().from(schema.orders),
        t.db.select().from(schema.positions),
      ]),
    ).toEqual(before);
  });

  // ---- the list --------------------------------------------------------------------------------

  it('lists every market’s posts newest first, a page at a time, never deleted or hidden ones', async () => {
    const other_market = await createMarket(t.db);
    const base = Date.now() - 60_000;
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const post = await createPost(t.db, {
        marketId: i % 2 === 0 ? market.id : other_market.id,
        authorId: author.id,
        createdAt: new Date(base + i * 1_000),
      });
      ids.push(post.id);
    }
    await createPost(t.db, { marketId: market.id, authorId: author.id, deletedAt: new Date() });
    await createPost(t.db, { marketId: market.id, authorId: author.id, hiddenAt: new Date() });
    const newestFirst = [...ids].reverse();
    expect(await listed()).toEqual(newestFirst);

    const first = await page('limit=2');
    expect(first.data.map((row) => row.id)).toEqual(newestFirst.slice(0, 2));
    const second = await page(`limit=2&cursor=${encodeURIComponent(first.meta.nextCursor!)}`);
    expect(second.data.map((row) => row.id)).toEqual(newestFirst.slice(2, 4));
    const third = await page(`limit=2&cursor=${encodeURIComponent(second.meta.nextCursor!)}`);
    expect(third.data.map((row) => row.id)).toEqual(newestFirst.slice(4));
    expect(third.meta.nextCursor).toBeNull();
    // A cursor that does not decode serves the first page.
    expect((await page('limit=2&cursor=nonsense')).data.map((row) => row.id)).toEqual(
      newestFirst.slice(0, 2),
    );
    expect(await listed(`marketId=${other_market.id}`)).toEqual([ids[3], ids[1]]);
  });

  it('gives a full last page no cursor, so 더 보기 never loads an empty page', async () => {
    const base = Date.now() - 60_000;
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const post = await createPost(t.db, {
        marketId: market.id,
        authorId: author.id,
        createdAt: new Date(base + i * 1_000),
      });
      ids.unshift(post.id);
    }
    // A full page with more after it has a cursor; the full page that ends the list has none.
    const first = await page('limit=2');
    expect(first.data.map((row) => row.id)).toEqual(ids.slice(0, 2));
    expect(first.meta.nextCursor).not.toBeNull();
    const second = await page(`limit=2&cursor=${encodeURIComponent(first.meta.nextCursor!)}`);
    expect(second.data.map((row) => row.id)).toEqual(ids.slice(2));
    expect(second.meta.nextCursor).toBeNull();
  });

  it('filters by category on either level and searches title and text, case-insensitively', async () => {
    const parent = await createCategory(t.db, { slug: 'economy-x', nameKo: '경제' });
    const child = await createCategory(t.db, {
      slug: 'rates-x',
      nameKo: '금리',
      parentId: parent.id,
    });
    const elsewhere = await createCategory(t.db, { slug: 'science-x', nameKo: '과학' });
    const inChild = await createMarket(t.db, { categoryId: child.id });
    const inElsewhere = await createMarket(t.db, { categoryId: elsewhere.id });
    const a = await createPost(t.db, {
      marketId: inChild.id,
      authorId: author.id,
      title: 'Fed 전망',
      text: '근거 하나',
    });
    const b = await createPost(t.db, {
      marketId: inElsewhere.id,
      authorId: author.id,
      text: '반감기 이후 HASHRATE는 오른다',
    });
    expect(await listed('category=economy-x')).toEqual([a.id]);
    expect(await listed('category=rates-x')).toEqual([a.id]);
    expect(await listed('category=science-x')).toEqual([b.id]);
    expect(await listed('category=nothing')).toEqual([]);
    expect(await listed('q=fed')).toEqual([a.id]);
    expect(await listed(`q=${encodeURIComponent('hashrate는')}`)).toEqual([b.id]);
    expect(await listed(`q=${encodeURIComponent('근거')}`)).toEqual([a.id]);
    // `%` and `_` are literal characters, not wildcards.
    expect(await listed('q=%25')).toEqual([]);
    expect(await listed(`q=${encodeURIComponent('반감기')}&category=economy-x`)).toEqual([]);
  });

  it('draws a card: title, two lines of text, the author, the market, the time', async () => {
    await createUser(t.db);
    await written({ title: null, body: doc('', '  첫 줄 ', '둘째 줄', '셋째 줄') });
    const [card] = (await page()).data;
    expect(card).toMatchObject({
      title: null,
      excerpt: '첫 줄\n둘째 줄\n셋째 줄',
      thumbnailUrl: null,
      author: { kind: 'member', isAdmin: false },
      market: { id: market.id, title: '기준금리 인하' },
      editedAt: null,
    });
  });

  it('previews the first lines with text however many blank lines come before and between them', async () => {
    // Text the API takes: blank lines are text inside a code block, and only the whole body must
    // not be blank — 2,200 characters of blank lines (U+3000 too, which trim also removes) before
    // the first line and between it and the next, past what a list reads of a body.
    const blankLines = (line: string) => ({
      type: 'codeBlock',
      content: [{ type: 'text', text: line.repeat(1_100) }],
    });
    const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    const post = await written({
      title: null,
      body: {
        type: 'doc',
        content: [
          blankLines(' \n'),
          paragraph('  첫 줄 '),
          blankLines('　\n'),
          paragraph('둘째 줄'),
        ],
      },
    });
    const [row] = await t.db
      .select({ bodyText: schema.posts.bodyText })
      .from(schema.posts)
      .where(eq(schema.posts.id, post.id));
    expect(row?.bodyText.length).toBeGreaterThan(4_000);
    const [card] = (await page()).data;
    expect(card?.excerpt).toBe('첫 줄\n둘째 줄');
    expect(card?.excerpt).toBe(postExcerpt(row?.bodyText ?? ''));

    // A run of blanks inside a line, from before the excerpt's end to past what a list reads: the
    // cut of the start the list reads ends in it, and the card is still the whole text's excerpt.
    const spaced = await written({
      title: null,
      body: { type: 'doc', content: [paragraph(`a${' '.repeat(700)}b`), paragraph('둘째 줄')] },
    });
    const [spacedRow] = await t.db
      .select({ bodyText: schema.posts.bodyText })
      .from(schema.posts)
      .where(eq(schema.posts.id, spaced.id));
    expect(spacedRow?.bodyText).toContain(' '.repeat(700));
    const [spacedCard] = (await page()).data;
    expect(spacedCard?.id).toBe(spaced.id);
    expect(spacedCard?.excerpt).toBe('a');
    expect(spacedCard?.excerpt).toBe(postExcerpt(spacedRow?.bodyText ?? ''));
  });

  it('shows the author’s current nickname on old posts and 운영자 on an admin’s', async () => {
    const post = await written();
    await t.db
      .update(schema.profiles)
      .set({ nickname: 'renamed_now', role: 'admin' })
      .where(eq(schema.profiles.userId, author.id));
    const now = (await shown(post.id)) as PublishedPost;
    expect(now.author).toMatchObject({ nickname: 'renamed_now', isAdmin: true });
    expect((await page()).data[0]?.author).toMatchObject({
      nickname: 'renamed_now',
      isAdmin: true,
    });
  });

  // ---- a post page -----------------------------------------------------------------------------

  it('shows a hidden post as a placeholder with its market only, and a deleted one as gone', async () => {
    const hidden = await createPost(t.db, {
      marketId: market.id,
      authorId: author.id,
      title: '숨긴 글',
      hiddenAt: new Date(),
    });
    const res = await show(hidden.id);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: unknown }>().data).toEqual({
      state: 'hidden',
      id: hidden.id,
      market: expect.objectContaining({ id: market.id }) as unknown,
      commentCount: 0,
    });
    expect(res.body).not.toContain('숨긴 글');
    const deleted = await createPost(t.db, {
      marketId: market.id,
      authorId: author.id,
      deletedAt: new Date(),
    });
    expect((await show(deleted.id)).statusCode).toBe(404);
    expect((await show('0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60')).statusCode).toBe(404);
    expect((await show('nope')).statusCode).toBe(400);
  });

  // ---- editing ---------------------------------------------------------------------------------

  it('edits title and body, never the market, keeps the earlier version and shows 수정됨', async () => {
    const post = await written({ title: '처음', body: doc('처음 본문') });
    const elsewhere = await createMarket(t.db);
    const res = await edit(post.id, {
      title: '고친 제목',
      body: doc('고친 본문'),
      marketId: elsewhere.id,
    });
    expect(res.statusCode, res.body).toBe(200);
    const edited = postSchema.parse(res.json<{ data: unknown }>().data) as PublishedPost;
    expect(edited).toMatchObject({
      title: '고친 제목',
      body: doc('고친 본문'),
      market: { id: market.id },
      editedAt: expect.any(String) as unknown,
    });
    const revisions = await t.db.select().from(schema.postRevisions);
    expect(revisions).toEqual([
      expect.objectContaining({
        postId: post.id,
        title: '처음',
        body: doc('처음 본문'),
        bodyText: '처음 본문',
        imageIds: [],
        writtenAt: new Date(post.createdAt),
      }),
    ]);
    // Sending what the post already says changes nothing: no revision, the same edit time.
    const same = await edit(post.id, { title: '고친 제목', body: doc('고친 본문') });
    expect(same.statusCode).toBe(200);
    expect(same.json<{ data: PublishedPost }>().data.editedAt).toBe(edited.editedAt);
    expect(await t.db.select().from(schema.postRevisions)).toHaveLength(1);
    // A second edit records the version the first one wrote, from its time.
    await edit(post.id, { title: null, body: doc('세 번째') });
    const second = await t.db
      .select()
      .from(schema.postRevisions)
      .orderBy(asc(schema.postRevisions.id));
    expect(second[1]).toMatchObject({ title: '고친 제목', writtenAt: new Date(edited.editedAt!) });
    expect(((await shown(post.id)) as PublishedPost).title).toBeNull();
  });

  it('lets only the author edit, never a deleted post, and a hidden one not at all', async () => {
    const post = await written();
    const theirs = await edit(post.id, { title: 'B', body: doc('B') }, other);
    expect(theirs.statusCode).toBe(403);
    expect(theirs.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    const misnamed = await send(
      'PUT',
      `/posts/${post.id}`,
      { title: 'B', body: doc('B'), expectedAccountId: other.id },
      author,
    );
    expect(misnamed.statusCode).toBe(403);
    await t.db
      .update(schema.posts)
      .set({ hiddenAt: new Date() })
      .where(eq(schema.posts.id, post.id));
    const hidden = await edit(post.id, { title: 'x', body: doc('x') });
    expect(hidden.statusCode).toBe(409);
    expect(hidden.json()).toEqual({
      error: {
        code: 'POST_NOT_EDITABLE',
        message: expect.any(String) as unknown,
        details: { reason: 'hidden' },
      },
    });
    await t.db
      .update(schema.posts)
      .set({ hiddenAt: null, deletedAt: new Date() })
      .where(eq(schema.posts.id, post.id));
    expect((await edit(post.id, { title: 'x', body: doc('x') })).statusCode).toBe(404);
    expect(await t.db.select().from(schema.postRevisions)).toEqual([]);
  });

  it('keeps an image an edit took out attached, for the history, and takes in a new one', async () => {
    const first = await upload();
    const second = await upload();
    const image = (mediaId: string) => ({ type: 'image', attrs: { mediaId } });
    const post = await written({
      body: { type: 'doc', content: [...doc('사진').content, image(first.id)] },
    });
    const res = await edit(post.id, {
      title: null,
      body: { type: 'doc', content: [...doc('사진').content, image(second.id)] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await t.db.select().from(schema.posts);
    expect(row?.imageIds).toEqual([second.id]);
    expect(
      (await t.db.select().from(schema.postImages)).map((link) => link.mediaId).sort(),
    ).toEqual([first.id, second.id].sort());
    const [revision] = await t.db.select().from(schema.postRevisions);
    expect(revision?.imageIds).toEqual([first.id]);
    // Putting the first back is the same post's image: allowed.
    const back = await edit(post.id, {
      title: null,
      body: { type: 'doc', content: [...doc('사진').content, image(first.id)] },
    });
    expect(back.statusCode).toBe(200);
  });

  // ---- deleting --------------------------------------------------------------------------------

  it('lets only the author delete, a hidden post too, gone from every view and kept for operators', async () => {
    const post = await written({ title: '지울 글' });
    expect((await remove(post.id, other)).statusCode).toBe(403);
    const misnamed = await send(
      'POST',
      `/posts/${post.id}/delete`,
      { expectedAccountId: other.id },
      author,
    );
    expect(misnamed.statusCode).toBe(403);
    const res = await remove(post.id);
    expect(res.statusCode).toBe(200);
    expect(postDeletionSchema.parse(res.json<{ data: unknown }>().data)).toEqual({
      id: post.id,
      placeholder: false,
    });
    expect(await listed()).toEqual([]);
    expect((await show(post.id)).statusCode).toBe(404);
    expect((await remove(post.id)).statusCode).toBe(404);
    // The original stays for operators (#45-5), with its time.
    const [row] = await t.db.select().from(schema.posts);
    expect(row).toMatchObject({ title: '지울 글', deletedAt: expect.any(Date) as unknown });

    const hidden = await written();
    await t.db
      .update(schema.posts)
      .set({ hiddenAt: new Date() })
      .where(eq(schema.posts.id, hidden.id));
    expect((await remove(hidden.id)).statusCode).toBe(200);
    expect((await show(hidden.id)).statusCode).toBe(404);
  });

  it('refuses the writes of an account that has not finished the onboarding', async () => {
    const post = await written();
    const newcomer = await signUpTestUser(t);
    const res = await edit(post.id, { title: null, body: doc('x') }, newcomer);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ONBOARDING_REQUIRED');
    // Deleting asks for no onboarding, so another account's post is refused as not its own.
    expect((await remove(post.id, newcomer)).statusCode).toBe(403);
    const [row] = await t.db.select().from(schema.posts).where(eq(schema.posts.id, post.id));
    expect(row?.deletedAt).toBeNull();
  });

  it('lets an author delete their own post signed in alone, whatever their onboarding (owner decision 2026-10-19)', async () => {
    // An author whose onboarding is not done — here an account that never finished it; the same
    // holds for one a consent revision asks again (#57-5) — may not write or edit, and still
    // deletes what they wrote (#45-12 leaves deleting open under a 작성 제한 too).
    const newcomer = await signUpTestUser(t);
    const own = await createPost(t.db, {
      marketId: market.id,
      authorId: newcomer.id,
      text: '내 글',
    });
    const refused = await edit(own.id, { title: null, body: doc('고침') }, newcomer);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('ONBOARDING_REQUIRED');
    // Signed out is still refused, and nothing is deleted.
    const anonymous = await send(
      'POST',
      `/posts/${own.id}/delete`,
      { expectedAccountId: newcomer.id },
      null,
    );
    expect(anonymous.statusCode).toBe(401);
    const res = await remove(own.id, newcomer);
    expect(res.statusCode, res.body).toBe(200);
    expect(postDeletionSchema.parse(res.json<{ data: unknown }>().data)).toEqual({
      id: own.id,
      placeholder: false,
    });
    const [row] = await t.db.select().from(schema.posts).where(eq(schema.posts.id, own.id));
    expect(row).toMatchObject({ bodyText: '내 글', deletedAt: expect.any(Date) as unknown });
    expect((await show(own.id)).statusCode).toBe(404);
  });

  it('checks the onboarding again inside the write itself, past the guard (#57-8)', async () => {
    // OnboardedGuard answers every request above before the service; this is the check that
    // holds the onboarding to the commit (a consent a revision asks for again between the guard
    // and the write) and where #185 and #187 plug in: PostsService.checkWriter.
    const posts = t.app.get(PostsService);
    const newcomer = await signUpTestUser(t);
    const content = { title: '제목', body: postDocumentInputSchema.parse(doc('근거')) };
    const refusal = { code: 'ONBOARDING_REQUIRED', status: 409 };
    await expect(posts.create(newcomer.id, market.id, content)).rejects.toMatchObject(refusal);
    expect(await t.db.select().from(schema.posts)).toEqual([]);
    // An edit of the newcomer's own post (another account's would be FORBIDDEN first).
    const own = await createPost(t.db, {
      marketId: market.id,
      authorId: newcomer.id,
      text: '처음',
    });
    await expect(posts.update(newcomer.id, own.id, content)).rejects.toMatchObject(refusal);
    const [row] = await t.db.select().from(schema.posts).where(eq(schema.posts.id, own.id));
    expect(row).toMatchObject({ title: null, bodyText: '처음', editedAt: null });
    expect(await t.db.select().from(schema.postRevisions)).toEqual([]);
  });

  // ---- a market's 토론 (#47) -------------------------------------------------------------------

  const discussionAt = (marketId: string, query = '', cookie?: string) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1/markets/${marketId}/posts${query === '' ? '' : `?${query}`}`,
      headers: cookie ? { cookie } : {},
    });
  const discussion = async (marketId: string, query = '', cookie?: string) => {
    const res = await discussionAt(marketId, query, cookie);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<DiscussionPage>();
    for (const row of body.data) postSummarySchema.parse(row);
    return body;
  };

  it('lists the market’s posts as the community list’s cards, every one by 더 보기, and counts them', async () => {
    const elsewhere = await createMarket(t.db);
    const base = Date.now() - 600_000;
    const ids: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const post = await createPost(t.db, {
        marketId: market.id,
        authorId: i % 2 === 0 ? author.id : other.id,
        createdAt: new Date(base + i * 1_000),
      });
      ids.unshift(post.id);
    }
    // Neither another market's post, nor a deleted or a hidden one: not a card, not counted. A
    // deleted post with a comment under it stays out of the list too (ADR-0074 decision 1).
    await createPost(t.db, { marketId: elsewhere.id, authorId: author.id });
    await createPost(t.db, { marketId: market.id, authorId: author.id, deletedAt: new Date() });
    await createPost(t.db, { marketId: market.id, authorId: author.id, hiddenAt: new Date() });
    const answered = await createPost(t.db, {
      marketId: market.id,
      authorId: author.id,
      deletedAt: new Date(),
    });
    await createComment(t.db, { postId: answered.id, authorId: other.id });

    // 20 a page by default (ADR-0069 decision 4: «20개씩 더 불러옴»), newest first, and the
    // whole list's count on every page, signed in or not (N02 §2).
    const first = await discussion(market.id);
    expect(first.data.map((row) => row.id)).toEqual(ids.slice(0, 20));
    expect(first.meta.total).toBe(21);
    expect(first.meta.nextCursor).not.toBeNull();
    const second = await discussion(
      market.id,
      `cursor=${encodeURIComponent(first.meta.nextCursor!)}`,
      other.cookie,
    );
    expect(second.data.map((row) => row.id)).toEqual(ids.slice(20));
    expect(second.meta).toEqual({ nextCursor: null, total: 21 });
    // The very cards of `GET /posts?marketId=`, page for page.
    expect(first.data).toEqual((await page(`marketId=${market.id}`)).data);
    // A cursor that does not decode serves the first page; a smaller limit pages the same list.
    expect((await discussion(market.id, 'cursor=nonsense')).data).toEqual(first.data);
    const two = await discussion(market.id, 'limit=2');
    expect(two.data.map((row) => row.id)).toEqual(ids.slice(0, 2));
    expect(two.meta.total).toBe(21);
    // The other market's discussion holds its own post alone.
    const theirs = await discussion(elsewhere.id);
    expect(theirs.data).toHaveLength(1);
    expect(theirs.meta).toEqual({ nextCursor: null, total: 1 });
  });

  it('is read on a market in every public status, empty with 0, and NOT_FOUND for a draft or unknown one', async () => {
    // N05 §3: an ended market's discussion is read as it was; #45-6 takes posts on all of them.
    for (const status of ['open', 'closed', 'resolved', 'settled', 'voided'] as const) {
      const at = await createMarket(t.db, { status });
      expect(await discussion(at.id), status).toEqual({
        data: [],
        meta: { nextCursor: null, total: 0 },
      });
      const post = await createPost(t.db, { marketId: at.id, authorId: author.id });
      const body = await discussion(at.id);
      expect(
        { status, ids: body.data.map((row) => row.id), total: body.meta.total },
        status,
      ).toEqual({ status, ids: [post.id], total: 1 });
      expect(body.data[0]?.market).toMatchObject({ id: at.id, status });
    }
    const draft = await createMarket(t.db, { status: 'draft' });
    for (const marketId of [draft.id, '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60']) {
      const res = await discussionAt(marketId);
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
    }
    // A sub-resource of a market takes its uuid, never the slug.
    expect((await discussionAt(market.slug)).statusCode).toBe(400);
    expect((await discussionAt(market.id, 'limit=0')).statusCode).toBe(400);
  });

  it('names the author by the public face only and carries nothing of the author’s trading', async () => {
    await written({ title: '토론 글' });
    const res = await discussionAt(market.id);
    const [card] = res.json<DiscussionPage>().data;
    const [profile] = await t.db
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, author.id));
    expect(card?.author).toEqual({
      kind: 'member',
      publicId: profile!.publicId,
      nickname: profile!.nickname,
      imageUrl: null,
      isAdmin: false,
    });
    expect(res.body).not.toContain(author.id);
    expect(res.body).not.toContain(author.email);
  });

  it('counts and lists from one snapshot, even when a post commits while the cards wait', async () => {
    const seen = await createPost(t.db, { marketId: market.id, authorId: author.id });
    // Another connection writes a post on the market and, before committing, takes the profiles
    // table, which the cards join (the count reads posts alone): the read counts, then waits on
    // the cards. Committed while it waits, the post is in neither — the snapshot of the read's
    // first statement. Under READ COMMITTED the cards would read anew after the wait and hold a
    // post the count missed.
    const holder = await t.db.$client.connect();
    let pending: ReturnType<typeof discussionAt> | undefined;
    let committed = false;
    try {
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO posts (market_id, author_id, body, body_text)
           VALUES ($1, $2, '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"늦은 글"}]}]}'::jsonb, '늦은 글')`,
        [market.id, other.id],
      );
      await holder.query('LOCK TABLE profiles IN ACCESS EXCLUSIVE MODE');
      pending = discussionAt(market.id);
      await waitForLockWaiter(holder, 'the discussion read waiting on the profiles table');
      await holder.query('COMMIT');
      committed = true;
      const res = await pending;
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<DiscussionPage>();
      expect({ ids: body.data.map((row) => row.id), total: body.meta.total }).toEqual({
        ids: [seen.id],
        total: 1,
      });
    } finally {
      if (!committed) await holder.query('ROLLBACK');
      holder.release();
      await pending?.catch(() => undefined);
    }
    // The next read has both.
    expect((await discussion(market.id)).meta.total).toBe(2);
  });
});
