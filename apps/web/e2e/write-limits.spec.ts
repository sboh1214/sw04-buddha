import { type APIRequestContext, type Request } from '@playwright/test';
import type { AdminLinkFlag, AdminLinkFlagGroup, WriteLimitedDetails } from '@buddha/shared';
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
 * a comment, another limit, still goes through. A member who edited ten times in ten minutes saves
 * an eleventh from the edit screen: refused the same way, with the time it can edit again, and the
 * form stays editable under it with 저장 — not the held form of a post taken from under it
 * (#46·#48·#50), the post not read again for it — and sent again is refused again (ADR-0083 결과 5
 * «다시 쌓기(2026-10-25)»). Every window, the daily caps, deleted posts, edits, uploads, the
 * per-number count and the operators' exemption are the API's tests (write-limits.test.ts); this
 * walks the refusal on screen.
 *
 * The repeated links: a member puts one address — written three ways, with the host in capitals,
 * a trailing slash, tracking parameters and a fragment — into a post and two comments within the
 * day. All three are on the operators' review list under the address as the rules compared it,
 * for the same-person rule, in one row of that address and rule (owner decision 2026-10-22), and
 * the post stays as it is. A member cannot read the list; an operator opens it from the admin
 * menu, opens the row to read each item, its author and its market, and marks the row '확인함'
 * with '조치함' and a note: it leaves the default list and shows under '확인함' with the mark. A
 * mark whose request never came back keeps the dialog with what was chosen and written; a row's
 * buttons are named after the row; once the marked row is gone the focus is on the list's pressed
 * button. A row another operator marked after the screen read it says, opened, that nothing is
 * left, and the list read again drops it. The rules' edges, the many-people rule, the exceptions,
 * the first 20 links and the mark's record are the API's tests (link-review.test.ts).
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

/** An edit of the context's own post straight at the API: the title and a one-line body. */
async function editThroughApi(
  context: APIRequestContext,
  postId: string,
  title: string,
  text: string,
): Promise<void> {
  const me = await meOf(context);
  const res = await context.put(`/api/v1/posts/${postId}`, {
    data: {
      title,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
      expectedAccountId: me.id,
    },
  });
  expect(res.status(), await res.text()).toBe(200);
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

/** A group's entries for `url` and the same-person rule, read page by page as an operator. */
async function flagsFor(admin: APIRequestContext, url: string): Promise<AdminLinkFlag[]> {
  const found: AdminLinkFlag[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const after: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const res = await admin.get(
      `/api/v1/admin/link-flags/items?url=${encodeURIComponent(url)}&reason=same_account${after}`,
    );
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as {
      data: AdminLinkFlag[];
      meta: { nextCursor: string | null };
    };
    found.push(...body.data);
    cursor = body.meta.nextCursor;
    if (cursor === null) break;
  }
  return found;
}

/** The rows of one part of the review list for `url`, read page by page as an operator. */
async function groupsFor(
  admin: APIRequestContext,
  url: string,
  status: 'open' | 'reviewed',
): Promise<AdminLinkFlagGroup[]> {
  const found: AdminLinkFlagGroup[] = [];
  let cursor: string | null = null;
  // Newest first: this test's row is on the first pages, whatever other runs add meanwhile. Ten
  // pages is far more than enough, and bounds the loop.
  for (let page = 0; page < 10; page += 1) {
    const after: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const res = await admin.get(`/api/v1/admin/link-flags?status=${status}${after}`);
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as {
      data: AdminLinkFlagGroup[];
      meta: { nextCursor: string | null };
    };
    found.push(...body.data.filter((group) => group.url === url));
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

  test('10분에 열 번 고친 회원이 수정 화면에서 열한째를 저장하면 그 한도와 다시 고칠 수 있는 시각이 양식 아래에 보이고, 양식은 고칠 수 있는 그대로 남아 다시 보내도 같은 거절이며 그 거절로 글을 다시 읽지 않는다', async ({
    admin,
    page,
    request,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const postId = await postThroughApi(page.request, market.id, `고칠 글 ${tag}`, tag);
    // Ten edits that change the post: the edits of ten minutes (posts' and comments' together) are
    // all taken.
    for (let edit = 1; edit <= 10; edit += 1) {
      await editThroughApi(page.request, postId, `고친 글 ${edit} ${tag}`, `${tag} 고침 ${edit}`);
    }

    // The eleventh, from the edit screen.
    await page.goto(`/community/posts/${postId}/edit`);
    const title = page.getByTestId('post-title-input');
    const body = page.getByTestId('post-editor-content');
    await expect(title).toHaveValue(`고친 글 10 ${tag}`);
    await title.fill(`열한째 ${tag}`);
    // The post's reads and the saves from here: a refusal that took the post from under the form
    // would read it again (POST_NOT_EDITABLE, NOT_FOUND — hooks/use-posts.ts).
    const postReads: string[] = [];
    const saves: string[] = [];
    const countPostRequest = (sent: Request) => {
      if (new URL(sent.url()).pathname !== `/api/v1/posts/${postId}`) return;
      if (sent.method() === 'GET') postReads.push(sent.url());
      if (sent.method() === 'PUT') saves.push(sent.url());
    };
    page.on('request', countPostRequest);
    const saved = () =>
      page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          new URL(response.url()).pathname === `/api/v1/posts/${postId}`,
      );
    const sent = saved();
    const before = Date.now();
    await page.getByTestId('post-submit').click();
    const response = await sent;
    const after = Date.now();
    expect(response.status()).toBe(429);
    const { error } = (await response.json()) as {
      error: { code: string; details: WriteLimitedDetails };
    };
    expect(error.code).toBe('WRITE_LIMITED');
    expect(error.details.reason).toBe('edits_10m');
    expect(error.details.limit).toBe(10);
    expect(error.details.retryAfterSeconds % 60).toBe(0);
    expect(error.details.retryAfterSeconds).toBeGreaterThanOrEqual(60);
    expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(600);

    // Under the form: which limit, and the time it can edit again — no way to 조치·신고 내역, as it
    // is not a restriction.
    const refusal = page.getByTestId('post-form-error');
    await expect(refusal).toBeVisible();
    const shown = ((await refusal.textContent()) ?? '').trim();
    const expected = [before, after].map(
      (at) =>
        `${copy.errWriteLimitEdits10m} ${retryText(at, error.details.retryAfterSeconds)}${copy.writeLimitRetryEdit}`,
    );
    expect(expected).toContain(shown);
    await expect(refusal.getByTestId('restricted-moderation-link')).toHaveCount(0);

    // Not the post taken from under the form (the held form of #46·#48·#50 — ADR-0073 9-52,
    // ADR-0074 7-35, ADR-0081 7-29): the server counted the edit once it found the post there to
    // edit, so the form stays editable under the refusal with 저장 — no held notice, no 닫기.
    await expect(page.getByTestId('post-form-gone')).toHaveCount(0);
    await expect(page.getByTestId('post-form-close')).toHaveCount(0);
    await expect(page.getByTestId('post-edit-unavailable')).toHaveCount(0);
    await expect(title).toBeEditable();
    await expect(title).toHaveValue(`열한째 ${tag}`);
    await expect(body).toHaveAttribute('contenteditable', 'true');
    await expect(page.getByTestId('post-submit')).toBeEnabled();

    // Typed on and sent again, it is refused the same way.
    await title.fill(`열한째 다시 ${tag}`);
    await body.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 덧붙임');
    await expect(body).toContainText('덧붙임');
    const sentAgain = saved();
    await page.getByTestId('post-submit').click();
    expect((await sentAgain).status()).toBe(429);
    await expect(refusal).toContainText(copy.errWriteLimitEdits10m);
    await expect(refusal).toContainText(copy.writeLimitRetryEdit);
    await page.waitForTimeout(1_000);
    expect(saves).toHaveLength(2);
    expect(postReads).toEqual([]);
    page.off('request', countPostRequest);
    await expect(page.getByTestId('post-form-gone')).toHaveCount(0);
    await expect(title).toBeEditable();
    await expect(title).toHaveValue(`열한째 다시 ${tag}`);
    await expect(body).toHaveAttribute('contenteditable', 'true');
    await expect(page).toHaveURL(`/community/posts/${postId}/edit`);

    // Nothing was stored: the post is as the tenth edit left it.
    const read = await request.get(`/api/v1/posts/${postId}`);
    expect(read.status()).toBe(200);
    expect(((await read.json()) as { data: { title: string } }).data.title).toBe(
      `고친 글 10 ${tag}`,
    );

    // The message wraps inside a phone's width.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
});

test.describe('반복 링크 검토 목록 (#187)', () => {
  test('한 회원이 같은 주소를 하루에 글 하나와 댓글 둘에 쓰면 셋 모두 견준 주소로 운영자 검토 목록의 한 줄에 오르고 글은 그대로이며, 회원은 목록을 볼 수 없고 운영자는 메뉴에서 열어 각 항목을 보고 조치함으로 확인하면 기본 목록에서 빠져 확인함에 보인다', async ({
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

    // The third use put all three on the list, for the same-person rule, once each — one row of
    // the address and the rule, with three entries (owner decision 2026-10-22).
    const groups = await groupsFor(admin, url, 'open');
    expect(groups.map((group) => [group.reason, group.itemCount, group.review])).toEqual([
      ['same_account', 3, null],
    ]);
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

    // A member cannot read the list, nor mark it.
    expect((await page.request.get('/api/v1/admin/link-flags')).status()).toBe(403);
    expect(
      (
        await page.request.post('/api/v1/admin/link-flags/reviews', {
          data: {
            url,
            reason: 'same_account',
            outcome: 'no_issue',
            through: groups[0]!.latestFlaggedAt,
          },
        })
      ).status(),
    ).toBe(403);
    await page.goto('/admin/moderation/link-flags');
    await expect(page).toHaveURL('/');
    await expect(page.getByTestId('admin-link-flags')).toHaveCount(0);

    // An operator opens it in the 신고·조치 area (#50): the admin menu leads to the area, whose row
    // of links leads on to the list (ADR-0083 7-12). The menu has no entry of its own for it.
    await logOut(page);
    await signIn(page, adminAccount.email, adminAccount.password);
    const operator = await meOf(page.request);
    await page.goto('/admin/markets');
    await expect(
      page.getByTestId('admin-nav').getByRole('link', { name: copy.adminLinkFlags, exact: true }),
    ).toHaveCount(0);
    await page
      .getByTestId('admin-nav')
      .getByRole('link', { name: copy.adminModeration, exact: true })
      .click();
    await page
      .getByTestId('moderation-nav')
      .getByRole('link', { name: copy.adminLinkFlags, exact: true })
      .click();
    await expect(page).toHaveURL('/admin/moderation/link-flags');
    await expect(
      page.getByTestId('moderation-nav').getByRole('link', { name: copy.adminLinkFlags }),
    ).toHaveAttribute('aria-current', 'page');
    const screen = page.getByTestId('admin-link-flags');
    await expect(screen).toContainText(copy.adminLinkFlagsIntro);
    await expect(page.getByTestId('admin-link-flags-open')).toHaveAttribute('aria-pressed', 'true');

    /**
     * The row of this test's address in the part on screen, once that part has loaded (it holds
     * this test's row at least), 더 보기 until it is drawn.
     */
    const rowOf = async () => {
      const row = page.locator(`[data-testid="admin-link-flag-group"][data-url="${url}"]`);
      await expect(page.getByTestId('admin-link-flag-group').first()).toBeVisible();
      for (let more = 0; more < 10 && (await row.count()) === 0; more += 1) {
        await page.getByTestId('admin-link-flags-more').click();
      }
      return row;
    };
    const row = await rowOf();
    await expect(row).toBeVisible();
    await expect(row.getByTestId('admin-link-flag-url')).toHaveText(url);
    await expect(row.getByTestId('admin-link-flag-reason')).toHaveText(
      copy.adminLinkFlagSameAccount,
    );
    await expect(row.getByTestId('admin-link-flag-count')).toHaveText(
      `${copy.adminLinkFlagItems} 3${copy.adminLinkFlagItemsUnit}`,
    );
    await expect(row.getByTestId('admin-link-flag-latest')).toHaveText(
      `${copy.adminLinkFlagLatest} ${formatKst(groups[0]!.latestFlaggedAt)}`,
    );

    // Its buttons are named after the row, as every row has the same two; the toggle points at the
    // entries it opens.
    const toggle = row.getByTestId('admin-link-flag-toggle');
    await expect(toggle).toHaveAccessibleName(
      `${copy.adminLinkFlagSameAccount} ${url} ${copy.adminLinkFlagShowItems}`,
    );
    await expect(row.getByTestId('admin-link-flag-review-open')).toHaveAccessibleName(
      `${copy.adminLinkFlagSameAccount} ${url} ${copy.adminLinkFlagReview}`,
    );
    await expect(toggle).not.toHaveAttribute('aria-controls');

    // The row opens to its entries.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAccessibleName(
      `${copy.adminLinkFlagSameAccount} ${url} ${copy.adminLinkFlagHideItems}`,
    );
    const region = row.getByTestId('admin-link-flag-items');
    await expect(toggle).toHaveAttribute('aria-controls', (await region.getAttribute('id'))!);
    for (const flag of flags) {
      const entry = row.getByTestId(`admin-link-flag-${flag.id}`);
      await expect(entry).toBeVisible();
      await expect(entry).toContainText(
        flag.target.kind === 'post' ? copy.adminLinkFlagPost : copy.adminLinkFlagComment,
      );
      // Each item leads to its moderation page (#50), where it is acted on — the post's or the
      // comment's own — and its author to theirs.
      await expect(entry.getByTestId('admin-link-flag-item')).toHaveAttribute(
        'href',
        flag.target.kind === 'post'
          ? `/admin/moderation/posts/${postId}`
          : `/admin/moderation/comments/${flag.target.commentId!}`,
      );
      await expect(entry.getByTestId('admin-link-flag-author')).toHaveText(me.profile.nickname);
      await expect(entry.getByTestId('admin-link-flag-author')).toHaveAttribute(
        'href',
        `/admin/moderation/users/${encodeURIComponent(flag.target.author.userId)}`,
      );
      await expect(entry.getByTestId('admin-link-flag-market')).toHaveText(market.title);
      await expect(entry.getByTestId('admin-link-flag-market')).toHaveAttribute(
        'href',
        `/admin/markets/${market.id}`,
      );
      // Written as it is: nothing edited, deleted or hidden.
      await expect(entry.getByTestId('admin-link-flag-states')).toHaveCount(0);
    }
    const postEntry = row.getByTestId(
      `admin-link-flag-${flags.find((flag) => flag.target.kind === 'post')!.id}`,
    );
    await expect(postEntry.getByTestId('admin-link-flag-item')).toHaveText(title);

    // The list wraps inside a phone's width.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    // 확인함: what came of it is required; a note is optional.
    await row.getByTestId('admin-link-flag-review-open').click();
    const dialog = page.getByTestId('admin-link-flag-review-dialog');
    await expect(dialog).toContainText(copy.adminLinkFlagReviewBody);
    await expect(dialog).toContainText(url);
    await expect(page.getByTestId('admin-link-flag-review-confirm')).toBeDisabled();
    await page.getByTestId('admin-link-flag-outcome-actioned').click();
    const note = `숨김 요청 ${tag}`;
    await page.getByTestId('admin-link-flag-review-note').fill(note);
    // A request that never comes back decided nothing: the dialog stays with what was chosen and
    // written, to send again.
    await page.route('**/api/v1/admin/link-flags/reviews', (route) => route.abort(), { times: 1 });
    await page.getByTestId('admin-link-flag-review-confirm').click();
    await expect(page.getByText(copy.errUnknown)).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('admin-link-flag-review-note')).toHaveValue(note);
    await expect(page.getByTestId('admin-link-flag-review-confirm')).toBeEnabled();
    expect(await groupsFor(admin, url, 'reviewed')).toEqual([]);
    await page.getByTestId('admin-link-flag-review-confirm').click();
    await expect(page.getByText(copy.adminLinkFlagReviewDone)).toBeVisible();
    await expect(dialog).toHaveCount(0);

    // Out of the default list, recorded with the operator, and under '확인함'. The row and its
    // button gone, the focus is on the list's pressed button, not lost to the page.
    await expect(
      page.locator(`[data-testid="admin-link-flag-group"][data-url="${url}"]`),
    ).toHaveCount(0);
    await expect(page.getByTestId('admin-link-flags-open')).toBeFocused();
    expect(await groupsFor(admin, url, 'open')).toEqual([]);
    const reviewed = await groupsFor(admin, url, 'reviewed');
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toMatchObject({
      reason: 'same_account',
      itemCount: 3,
      review: { outcome: 'actioned', note, admin: { userId: operator.id } },
    });
    await page.getByTestId('admin-link-flags-reviewed').click();
    await expect(page.getByTestId('admin-link-flags-reviewed')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The reviewed part, not the default one still on screen: its rows carry their mark.
    await expect(page.getByTestId('admin-link-flag-outcome').first()).toBeVisible();
    const done = await rowOf();
    await expect(done.getByTestId('admin-link-flag-outcome')).toHaveText(
      `${copy.adminLinkFlagsReviewed} · ${copy.adminLinkFlagActioned}`,
    );
    await expect(done.getByTestId('admin-link-flag-reviewed-by')).toContainText(
      operator.profile.nickname,
    );
    await expect(done.getByTestId('admin-link-flag-note')).toHaveText(note);
    await expect(done.getByTestId('admin-link-flag-review-open')).toHaveCount(0);
    // '조치함' leads to the actions it records (#50's action log).
    await expect(done.getByTestId('admin-link-flag-actions')).toHaveAttribute(
      'href',
      '/admin/moderation/actions',
    );
    await done.getByTestId('admin-link-flag-toggle').click();
    for (const flag of flags) {
      await expect(done.getByTestId(`admin-link-flag-${flag.id}`)).toBeVisible();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    // From the list to the post's moderation page (#50), where it reads as it was written and
    // the actions are at hand.
    await done
      .getByTestId(`admin-link-flag-${flags.find((flag) => flag.target.kind === 'post')!.id}`)
      .getByTestId('admin-link-flag-item')
      .click();
    await expect(page).toHaveURL(`/admin/moderation/posts/${postId}`);
    await expect(page.getByTestId('moderation-post-title')).toHaveText(title);
    await expect(page.getByTestId('moderation-hide')).toBeVisible();
  });

  test('운영자가 목록을 연 뒤 다른 운영자가 그 줄을 표시하면, 그 줄을 펼칠 때 남은 항목이 없다고 말하고 목록을 다시 읽어 그 줄이 빠진다', async ({
    admin,
    secondAdmin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const url = `https://example.com/e2e-links/${tag}/gone`;
    const postId = await postThroughApi(page.request, market.id, `줄 ${tag}`, tag, url);
    await commentThroughApi(page.request, postId, `참고 ${url}`);
    await commentThroughApi(page.request, postId, `다시 ${url}`);

    await logOut(page);
    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto('/admin/moderation/link-flags');
    const row = page.locator(`[data-testid="admin-link-flag-group"][data-url="${url}"]`);
    await expect(page.getByTestId('admin-link-flag-group').first()).toBeVisible();
    for (let more = 0; more < 10 && (await row.count()) === 0; more += 1) {
      await page.getByTestId('admin-link-flags-more').click();
    }
    await expect(row).toBeVisible();

    // Another operator marks the row while this screen shows it.
    const [group] = await groupsFor(admin, url, 'open');
    const marked = await secondAdmin.post('/api/v1/admin/link-flags/reviews', {
      data: { url, reason: 'same_account', outcome: 'no_issue', through: group!.latestFlaggedAt },
    });
    expect(marked.status(), await marked.text()).toBe(201);

    // Opened, the row has nothing left: it says so, and the list read again drops it. The list's
    // answer is held until the words are read, so they cannot pass unseen.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/v1\/admin\/link-flags\?/, async (route) => {
      await held;
      await route.continue();
    });
    await row.getByTestId('admin-link-flag-toggle').click();
    await expect(row.getByTestId('admin-link-flag-items-empty')).toHaveText(
      copy.adminLinkFlagItemsGone,
    );
    release();
    await expect(row).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
});
