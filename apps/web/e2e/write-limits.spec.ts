import { type APIRequestContext } from '@playwright/test';
import type { AdminLinkFlag, WriteLimitedDetails } from '@buddha/shared';
import { copy } from '../src/copy';
import { formatKst } from '../src/lib/datetime';
import {
  adminAccount,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  logOut,
  meOf,
  signIn,
  signUp,
  test,
} from './helpers';

/**
 * 작성 빈도 제한과 반복 링크 탐지 (#187, ADR-0083; owner decisions in ADR-0069 decision 2 #45-15,
 * decision 4 #187 and decision 7).
 *
 * The limits: a member who wrote three posts in ten minutes sends a fourth from the write screen;
 * nothing is stored, and the screen says which limit it was and the time it can write again
 * («다시 쓸 수 있는 시각을 보인다») — in the screen's zone, from the server's wait — keeping the draft;
 * a comment, another limit, still goes through. Every window, the daily caps, deleted posts,
 * edits, uploads, the per-number count and the operators' exemption are the API's tests
 * (write-limits.test.ts); this walks the refusal on screen.
 *
 * The repeated links: a member puts one address — written three ways, with the host in capitals,
 * a trailing slash, tracking parameters and a fragment — into a post and two comments within the
 * day. All three are on the operators' review list under the address as the rules compared it,
 * for the same-person rule, and the post stays as it is. A member cannot read the list; an
 * operator opens it from the admin menu and reads each item, its author and its market. The rules'
 * edges, the many-people rule and the exceptions are the API's tests (link-review.test.ts).
 */

/** A post straight at the API with the context's cookie: `href`, when given, is a link in it. */
async function postThroughApi(
  context: APIRequestContext,
  marketId: string,
  title: string,
  text: string,
  href?: string,
): Promise<string> {
  const me = await meOf(context);
  const content: unknown[] = [{ type: 'text', text }];
  if (href !== undefined) {
    content.push({ type: 'text', text: ' 출처', marks: [{ type: 'link', attrs: { href } }] });
  }
  const res = await context.post('/api/v1/posts', {
    data: {
      marketId,
      title,
      body: { type: 'doc', content: [{ type: 'paragraph', content }] },
      expectedAccountId: me.id,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** A 댓글 straight at the API with the context's cookie. */
async function commentThroughApi(
  context: APIRequestContext,
  postId: string,
  body: string,
): Promise<string> {
  const me = await meOf(context);
  const res = await context.post(`/api/v1/posts/${postId}/comments`, {
    data: { parentId: null, body, expectedAccountId: me.id },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** The instant the screen names, as `writeRetryAt` counts it: the wait from `at`, minute up. */
function retryText(at: number, retryAfterSeconds: number): string {
  const instant = at + retryAfterSeconds * 1_000;
  return formatKst(new Date(Math.ceil(instant / 60_000) * 60_000).toISOString());
}

/** Every entry of the review list for `url`, read page by page as an operator. */
async function flagsFor(admin: APIRequestContext, url: string): Promise<AdminLinkFlag[]> {
  const found: AdminLinkFlag[] = [];
  let cursor: string | null = null;
  // The list is newest first: this test's entries are on the first pages, whatever other runs
  // add meanwhile. Ten pages is far more than enough, and bounds the loop.
  for (let page = 0; page < 10; page += 1) {
    const query: string = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    const res = await admin.get(`/api/v1/admin/link-flags${query}`);
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as {
      data: AdminLinkFlag[];
      meta: { nextCursor: string | null };
    };
    found.push(...body.data.filter((flag) => flag.url === url));
    cursor = body.meta.nextCursor;
    if (cursor === null) break;
  }
  return found;
}

test.describe('작성 빈도 제한 (#187)', () => {
  test('10분에 근거 글 셋을 쓴 회원이 넷째를 보내면 저장되지 않고 어느 한도인지와 다시 쓸 수 있는 시각이 보이며, 쓰던 글은 그대로이고 댓글은 쓸 수 있다', async ({
    admin,
    page,
    request,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const first = await postThroughApi(page.request, market.id, `첫째 ${tag}`, tag);
    await postThroughApi(page.request, market.id, `둘째 ${tag}`, tag);
    await postThroughApi(page.request, market.id, `셋째 ${tag}`, tag);

    // The fourth, from the write screen: the server refuses it whatever sent it (#187 «화면에서만
    // 막지 않고 작성 처리에서 막는다»), and the screen says why.
    await page.goto(`/community/write?market=${market.id}`);
    await page.getByTestId('post-title-input').fill(`넷째 ${tag}`);
    await page.getByTestId('post-editor-content').click();
    await page.keyboard.type('넷째 근거');
    const sent = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/posts' &&
        response.request().method() === 'POST',
    );
    const before = Date.now();
    await page.getByTestId('post-submit').click();
    const response = await sent;
    const after = Date.now();
    expect(response.status()).toBe(429);
    const { error } = (await response.json()) as {
      error: { code: string; details: WriteLimitedDetails };
    };
    expect(error.code).toBe('WRITE_LIMITED');
    expect(error.details.reason).toBe('posts_10m');
    expect(error.details.limit).toBe(3);
    // The wait is whole minutes (never another account's write time to the second) and at most
    // the window: the first of the three left it no later than ten minutes from now.
    expect(error.details.retryAfterSeconds % 60).toBe(0);
    expect(error.details.retryAfterSeconds).toBeGreaterThanOrEqual(60);
    expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(600);

    // Which limit, and the time it can write again: the browser's clock when the answer came,
    // plus the wait, rounded up to the minute, in the screen's zone (the browser's: Seoul here).
    const refusal = page.getByTestId('post-form-error');
    await expect(refusal).toBeVisible();
    const shown = ((await refusal.textContent()) ?? '').trim();
    const expected = [before, after].map(
      (at) =>
        `${copy.errWriteLimitPosts10m} ${retryText(at, error.details.retryAfterSeconds)}${copy.writeLimitRetryWrite}`,
    );
    expect(expected).toContain(shown);

    // Nothing was stored, and the draft is still on screen to send later.
    await expect(page).toHaveURL(`/community/write?market=${market.id}`);
    await expect(page.getByTestId('post-title-input')).toHaveValue(`넷째 ${tag}`);
    await expect(page.getByTestId('post-editor-content')).toContainText('넷째 근거');
    const listed = await request.get(`/api/v1/posts?marketId=${market.id}`);
    expect(listed.status()).toBe(200);
    const posts = ((await listed.json()) as { data: { title: string | null }[] }).data;
    expect(posts.map((post) => post.title).sort()).toEqual(
      [`둘째 ${tag}`, `셋째 ${tag}`, `첫째 ${tag}`].sort(),
    );

    // The message wraps inside a phone's width.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    // A comment is another limit (5 a minute): it goes through.
    await commentThroughApi(page.request, first, `댓글은 됩니다 ${tag}`);
  });
});

test.describe('반복 링크 검토 목록 (#187)', () => {
  test('한 회원이 같은 주소를 하루에 글 하나와 댓글 둘에 쓰면 셋 모두 견준 주소로 운영자 검토 목록에 오르고 글은 그대로이며, 회원은 목록을 볼 수 없고 운영자는 메뉴에서 열어 각 항목을 본다', async ({
    admin,
    page,
    request,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const me = await meOf(page.request);

    // One address, three spellings the rules hold the same (decision 4 #187, decision 7): the host
    // in capitals, a trailing slash, tracking parameters, a fragment. The path keeps its case.
    const url = `https://example.com/e2e-links/${tag}/Report`;
    const title = `반복 링크 ${tag}`;
    const postId = await postThroughApi(
      page.request,
      market.id,
      title,
      `근거 ${tag}`,
      `https://Example.COM/e2e-links/${tag}/Report/?utm_source=e2e&fbclid=x`,
    );
    const firstComment = await commentThroughApi(
      page.request,
      postId,
      `참고 ${tag} https://example.com/e2e-links/${tag}/Report`,
    );
    const secondComment = await commentThroughApi(
      page.request,
      postId,
      `다시 ${tag} https://EXAMPLE.com/e2e-links/${tag}/Report#top`,
    );

    // The third use put all three on the list, for the same-person rule, once each.
    const flags = await flagsFor(admin, url);
    expect(flags).toHaveLength(3);
    for (const flag of flags) expect(flag.reason).toBe('same_account');
    expect(
      flags.map((flag) => flag.target.commentId ?? `post:${flag.target.postId}`).sort(),
    ).toEqual([firstComment, secondComment, `post:${postId}`].sort());
    for (const flag of flags) {
      expect(flag.target.postId).toBe(postId);
      expect(flag.target.author.publicId).toBe(me.profile.publicId);
      expect(flag.target.market.id).toBe(market.id);
    }

    // Nothing is refused or hidden: the post reads as it was written («글은 그대로 보임»).
    const read = await request.get(`/api/v1/posts/${postId}`);
    expect(read.status()).toBe(200);
    expect(((await read.json()) as { data: { state: string } }).data.state).toBe('published');

    // A member cannot read the list.
    const refused = await page.request.get('/api/v1/admin/link-flags');
    expect(refused.status()).toBe(403);
    await page.goto('/admin/link-flags');
    await expect(page).toHaveURL('/');
    await expect(page.getByTestId('admin-link-flags')).toHaveCount(0);

    // An operator opens it from the admin menu.
    await logOut(page);
    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto('/admin/markets');
    await page
      .getByTestId('admin-nav')
      .getByRole('link', { name: copy.adminLinkFlags, exact: true })
      .click();
    await expect(page).toHaveURL('/admin/link-flags');
    const screen = page.getByTestId('admin-link-flags');
    await expect(screen).toContainText(copy.adminLinkFlagsIntro);

    for (const flag of flags) {
      const entry = page.getByTestId(`admin-link-flag-${flag.id}`);
      // Newest first: other runs may have added entries since; 더 보기 until it is drawn.
      for (let more = 0; more < 10 && (await entry.count()) === 0; more += 1) {
        await page.getByTestId('admin-link-flags-more').click();
      }
      await expect(entry).toBeVisible();
      await expect(entry.getByTestId('admin-link-flag-url')).toHaveText(url);
      await expect(entry.getByTestId('admin-link-flag-reason')).toHaveText(
        copy.adminLinkFlagSameAccount,
      );
      await expect(entry).toContainText(
        flag.target.kind === 'post' ? copy.adminLinkFlagPost : copy.adminLinkFlagComment,
      );
      await expect(entry.getByTestId('admin-link-flag-item')).toHaveAttribute(
        'href',
        `/community/posts/${postId}`,
      );
      await expect(entry.getByTestId('admin-link-flag-author')).toHaveText(me.profile.nickname);
      await expect(entry.getByTestId('admin-link-flag-author')).toHaveAttribute(
        'href',
        `/u/${me.profile.publicId}`,
      );
      await expect(entry.getByTestId('admin-link-flag-market')).toHaveText(market.title);
      await expect(entry.getByTestId('admin-link-flag-market')).toHaveAttribute(
        'href',
        `/admin/markets/${market.id}`,
      );
      // Written as it is: nothing edited, deleted or hidden.
      await expect(entry.getByTestId('admin-link-flag-states')).toHaveCount(0);
    }
    const postEntry = page.getByTestId(
      `admin-link-flag-${flags.find((flag) => flag.target.kind === 'post')!.id}`,
    );
    await expect(postEntry.getByTestId('admin-link-flag-item')).toHaveText(title);

    // The list is read-only and wraps inside a phone's width.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    // From the list to the post, which reads as it was written.
    await postEntry.getByTestId('admin-link-flag-item').click();
    await expect(page).toHaveURL(`/community/posts/${postId}`);
    await expect(page.getByTestId('post-title')).toHaveText(title);
  });
});
