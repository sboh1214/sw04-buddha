import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { HiddenNotice } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  closeMarket,
  createOpenMarket,
  detailCopyTestId,
  expect,
  freshEmail,
  freshTag,
  logOut,
  meOf,
  signUp,
  test,
} from './helpers';

/**
 * 작성자별 글·댓글 (#51, ADR-0080; owner decisions in ADR-0069 decision 3 #37-14·#37-19, decision 4
 * #51 and decision 2 #45-5): what a member wrote is on MY '내 글' and on their public profile, on
 * two tabs — 글, and 댓글 with the 대댓글 — newest first; MY's summary previews both. Each item
 * leads to its post and to its market, an ended one too, and Back returns to the tab it was opened
 * from. A post or a comment the member deletes leaves MY, the profile and the counts (N04 §7's
 * second deletion check, #37-19), while a comment under a deleted post that keeps its place stays.
 * Anyone, signed in or not, goes from a byline — a post's or a 대댓글's — to the profile, to an item
 * there and on to its market (#51's acceptance criteria).
 *
 * A hidden item MY marks '숨김' with its reason and the way to 조치·신고 내역 (#186), and offers to
 * delete: one test hides a post and a
 * comment for real through #50's operator routes (ADR-0081) and deletes them from MY; another draws
 * the marks' every shape — a reason with and without the operator's explanation, and none — from
 * the API's own answers changed in the browser (`page.route`, as start-grant.spec.ts does: the rows
 * stay published, so its 삭제 goes through the real delete route and the lists after it are the
 * server's). A list longer than a page takes a smaller `limit` on the browser's requests, and MY's
 * summary is shown cutting the 글 list with a fourth, older row added to the server's answer the
 * same way — a member writes at most three posts in ten minutes (#187, ADR-0083 결정 4). The
 * exclusions on the profile against MY are the API's (authored.controller.test.ts,
 * private-data.test.ts). A restricted member's items staying listed is the API's too, the lists
 * reading no sanction: restrictions.controller.test.ts for a writing restriction (#185, ADR-0082),
 * #139 for an account restriction. Withdrawn accounts are tested nowhere yet: that state does not
 * exist, and #140 adds the withdrawn account's 404 (ADR-0080 결과 5).
 */

/**
 * A post straight at the API with the context's cookie: this spec's subject is its author. `null`
 * is a post with no title (#45-1); each line of `text` is a paragraph of its own.
 */
async function postThroughApi(
  context: APIRequestContext,
  marketId: string,
  title: string | null,
  text: string,
): Promise<string> {
  const me = await meOf(context);
  const res = await context.post('/api/v1/posts', {
    data: {
      marketId,
      title,
      body: {
        type: 'doc',
        content: text
          .split('\n')
          .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
      },
      expectedAccountId: me.id,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** A comment straight at the API with the context's cookie: a 댓글, or a 대댓글 under `parentId`. */
async function commentThroughApi(
  context: APIRequestContext,
  postId: string,
  parentId: string | null,
  body: string,
): Promise<string> {
  const me = await meOf(context);
  const res = await context.post(`/api/v1/posts/${postId}/comments`, {
    data: { parentId, body, expectedAccountId: me.id },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** A like straight at the API with the context's cookie (`posts` or `comments`). */
async function likeThroughApi(
  context: APIRequestContext,
  target: 'posts' | 'comments',
  id: string,
): Promise<void> {
  const me = await meOf(context);
  const res = await context.put(`/api/v1/${target}/${id}/like`, {
    data: { liked: true, expectedAccountId: me.id },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** The post ids a list's cards stand for, top to bottom (`post-card-<id>` on each `article`). */
async function postIdsIn(list: Locator): Promise<string[]> {
  const ids = await list
    .locator('article[data-testid^="post-card-"]')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-testid') ?? ''));
  return ids.map((id) => id.replace('post-card-', ''));
}

/** The comment ids a list's cards stand for, top to bottom (`authored-comment-<id>`). */
async function commentIdsIn(list: Locator): Promise<string[]> {
  const ids = await list
    .locator('article[data-testid^="authored-comment-"]')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-testid') ?? ''));
  return ids.map((id) => id.replace('authored-comment-', ''));
}

/** Expects a list to hold exactly these posts, in this order (it may still be loading). */
async function expectPosts(list: Locator, ids: string[]): Promise<void> {
  await expect.poll(() => postIdsIn(list)).toEqual(ids);
}

async function expectComments(list: Locator, ids: string[]): Promise<void> {
  await expect.poll(() => commentIdsIn(list)).toEqual(ids);
}

/** The list item that holds the card with this test id (`post-card-<id>`, `authored-comment-<id>`). */
function itemOf(list: Locator, cardTestId: string): Locator {
  return list.getByRole('listitem').filter({ has: list.page().getByTestId(cardTestId) });
}

/**
 * The browser's reads of the four lists (`GET /me/posts`, `/me/comments`,
 * `/profiles/:publicId/posts`, `/comments`) by their exact path — never `/me/likes/posts/…` or the
 * profile itself — whatever their query.
 */
function isAuthoredListRead(url: URL): boolean {
  return /^\/api\/v1\/(me|profiles\/[^/]+)\/(posts|comments)$/.test(url.pathname);
}

/** A server error as the API's envelope says it (discussion.spec.ts's): the client retries it twice. */
const SERVER_ERROR = {
  status: 500,
  contentType: 'application/json',
  body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal error' } }),
};

/** React's hydration complaints in the browser's console from now on (profile.spec.ts's). */
function hydrationErrors(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydrat/i.test(message.text())) seen.push(message.text());
  });
  return seen;
}

/** The profile's three counts, as profile.spec.ts reads them. */
async function expectCounts(page: Page, posts: number, comments: number): Promise<void> {
  await expect(page.getByTestId('profile-count-posts')).toHaveText(
    `${copy.profilePostCount}${String(posts)}`,
  );
  await expect(page.getByTestId('profile-count-comments')).toHaveText(
    `${copy.profileCommentCount}${String(comments)}`,
  );
}

test.describe('작성자별 글·댓글', () => {
  test('회원이 쓴 글과 댓글·답글이 MY 내 글(요약 포함)과 공개 프로필의 두 탭에 최신순으로 보이고, 항목에서 글과 시장(마감된 시장도)으로 가며 뒤로 가기는 그 탭으로 돌아오고, 지우면 MY·프로필·수에서 빠진다', async ({
    admin,
    page,
  }) => {
    const tag = freshTag();
    const open = await createOpenMarket(admin);
    const ended = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const profileUrl = `/u/${me.profile.publicId}`;

    // The older post on a market that then closes, the newer one on an open market; the member's
    // 댓글 under the older one and the member's 대댓글 under the admin's 댓글 on the newer one.
    const older = await postThroughApi(page.request, ended.id, `마감 시장의 글 ${tag}`, tag);
    const newer = await postThroughApi(page.request, open.id, `열린 시장의 글 ${tag}`, tag);
    const ownComment = await commentThroughApi(page.request, older, null, `내 댓글 ${tag}`);
    const adminComment = await commentThroughApi(admin, newer, null, `운영자의 댓글 ${tag}`);
    const reply = await commentThroughApi(page.request, newer, adminComment, `내 답글 ${tag}`);
    await closeMarket(admin, ended.id);
    await likeThroughApi(admin, 'posts', older);
    await likeThroughApi(admin, 'comments', reply);

    // --- MY's summary: the newest posts and the newest comments, each with the tab beyond.
    await page.goto('/my');
    const preview = page.getByTestId('my-preview-posts');
    await expectPosts(preview.getByTestId('my-preview-posts-list'), [newer, older]);
    await expectComments(preview.getByTestId('my-preview-comments-list'), [reply, ownComment]);
    await preview.getByRole('link', { name: `${copy.myPosts} ${copy.myViewAll}` }).click();
    await expect(page).toHaveURL('/my/posts');

    // --- MY '내 글': 글 first, newest first, the closed market's post with its status.
    const myPosts = page.getByTestId('my-posts-list');
    await expect(page.getByTestId('my-authored-tab-posts')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectPosts(myPosts, [newer, older]);
    const olderCard = myPosts.getByTestId(`post-card-${older}`);
    await expect(olderCard.getByTestId('post-card-market')).toHaveText(ended.title);
    await expect(olderCard).toContainText(copy.marketStatusClosed);
    await expect(olderCard.getByTestId('post-card-likes')).toHaveText(`${copy.likeToggle} 1`);
    await expect(myPosts.getByTestId('authored-hidden')).toHaveCount(0);

    // 댓글: the 대댓글 is a 답글 and names the post it sits under; the address keeps the tab.
    await page.getByTestId('my-authored-tab-comments').click();
    await expect(page).toHaveURL('/my/posts?tab=comments');
    const myComments = page.getByTestId('my-comments-list');
    await expectComments(myComments, [reply, ownComment]);
    const replyCard = myComments.getByTestId(`authored-comment-${reply}`);
    await expect(replyCard.getByTestId('authored-comment-kind')).toHaveText(copy.authoredReplyKind);
    await expect(replyCard.getByTestId('authored-comment-post')).toHaveText(
      `열린 시장의 글 ${tag}`,
    );
    await expect(replyCard.getByTestId('authored-comment-body')).toHaveText(`내 답글 ${tag}`);
    await expect(replyCard.getByTestId('authored-comment-likes')).toHaveText(
      `${copy.likeToggle} 1`,
    );
    // The card's link is named by what it opens — the kind and the post — never by the comment's
    // text, which may run to 1,000 characters and sits beside the link as plain text.
    await expect(replyCard.getByTestId('authored-comment-link')).toHaveAccessibleName(
      new RegExp(`^${copy.authoredReplyKind}\\s*열린 시장의 글 ${tag}$`),
    );
    await expect(
      replyCard.getByTestId('authored-comment-link').getByTestId('authored-comment-body'),
    ).toHaveCount(0);
    const ownCard = myComments.getByTestId(`authored-comment-${ownComment}`);
    await expect(ownCard.getByTestId('authored-comment-kind')).toHaveText(copy.authoredCommentKind);

    // The card opens its post, and Back lands on the 댓글 tab it was opened from.
    await ownCard.getByTestId('authored-comment-link').click();
    await expect(page).toHaveURL(`/community/posts/${older}`);
    await expect(page.getByTestId(`comment-${ownComment}`)).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL('/my/posts?tab=comments');
    await expect(page.getByTestId('my-authored-tab-comments')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Its market line opens the market, closed as it is (N05 §3: its rules stay readable).
    await myComments
      .getByTestId(`authored-comment-${ownComment}`)
      .getByTestId('authored-comment-market')
      .click();
    await expect(page).toHaveURL(`/markets/${ended.slug}`);
    await expect(page.getByRole('heading', { level: 2, name: ended.title })).toBeVisible();
    await expect(page.getByTestId(detailCopyTestId(page, 'market-rules'))).toContainText(
      ended.yesCondition,
    );

    // --- the own public profile: the same items on the same two tabs, which the counts count.
    await page.goto(profileUrl);
    await expectCounts(page, 2, 2);
    const profilePosts = page.getByTestId('profile-posts-list');
    await expectPosts(profilePosts, [newer, older]);

    // --- deleted from its page, opened from the profile: the newer post keeps its place (comments
    // hang under it), so the 대댓글 under it stays — its post named by the placeholder — and the
    // post leaves every list. Back brings the profile as Next kept it for history, the counts drawn
    // before the deletion; the page draws itself again (ADR-0080 7-16), so the counts and the
    // list, read again too, agree.
    await profilePosts.getByTestId(`post-card-${newer}`).getByTestId('post-card-link').click();
    await expect(page).toHaveURL(`/community/posts/${newer}`);
    await page.getByTestId('post-delete').click();
    // The warning that it is never undone is the dialog's description, read with its title.
    await expect(page.getByRole('alertdialog')).toHaveAccessibleDescription(copy.postDeleteBody);
    await page.getByTestId('post-delete-confirm').click();
    await expect(page).toHaveURL('/community');
    await page.goBack();
    await expect(page).toHaveURL(profileUrl);
    await expectCounts(page, 1, 2);
    await expectPosts(profilePosts, [older]);
    // And the 댓글 under the older post, with nothing under it, opened from the 댓글 tab: gone from
    // its thread, and from the tab and its count on the way Back.
    await page.getByTestId('profile-authored-tab-comments').click();
    await expect(page).toHaveURL(`${profileUrl}?tab=comments`);
    const profileComments = page.getByTestId('profile-comments-list');
    await expectComments(profileComments, [reply, ownComment]);
    await profileComments
      .getByTestId(`authored-comment-${ownComment}`)
      .getByTestId('authored-comment-link')
      .click();
    await expect(page).toHaveURL(`/community/posts/${older}`);
    await page.getByTestId(`comment-${ownComment}`).getByTestId('comment-delete').click();
    await expect(page.getByRole('alertdialog')).toHaveAccessibleDescription(copy.commentDeleteBody);
    await page.getByTestId('comment-delete-confirm').click();
    await expect(page.getByText(copy.commentDeletedToast)).toBeVisible();
    await expect(page.getByTestId(`comment-${ownComment}`)).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(`${profileUrl}?tab=comments`);
    await expectCounts(page, 1, 1);
    await expectComments(profileComments, [reply]);

    await page.goto('/my/posts');
    await expectPosts(page.getByTestId('my-posts-list'), [older]);
    await page.getByTestId('my-authored-tab-comments').click();
    await expectComments(page.getByTestId('my-comments-list'), [reply]);
    const kept = page.getByTestId('my-comments-list').getByTestId(`authored-comment-${reply}`);
    await expect(kept.getByTestId('authored-comment-post')).toHaveText(copy.postDeletedPlaceholder);
    await expect(kept.getByTestId('authored-comment-post')).toHaveAttribute(
      'data-state',
      'deleted',
    );
    await page.goto('/my');
    await expectPosts(page.getByTestId('my-preview-posts-list'), [older]);
    await expectComments(page.getByTestId('my-preview-comments-list'), [reply]);

    // --- a visitor reads the same profile: the deletions there too, the counts with them.
    await logOut(page);
    const hydration = hydrationErrors(page);
    await page.goto(profileUrl);
    await expectCounts(page, 1, 1);
    await expectPosts(page.getByTestId('profile-posts-list'), [older]);
    await page.getByTestId('profile-authored-tab-comments').click();
    await expectComments(page.getByTestId('profile-comments-list'), [reply]);
    await expect(page.getByTestId('authored-hidden')).toHaveCount(0);
    // Opened at the 댓글 tab's address, the server draws that tab picked, and the browser agrees.
    await page.goto(`${profileUrl}?tab=comments`);
    await expect(page.getByTestId('profile-authored-tab-comments')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectComments(page.getByTestId('profile-comments-list'), [reply]);
    // The lists are read in the browser: the server's HTML holds none of their items.
    const html = await (await page.request.get(`${profileUrl}?tab=comments`)).text();
    expect(html).not.toContain(`내 답글 ${tag}`);
    expect(hydration).toEqual([]);
  });

  test('누구나 작성자 표기(글·답글)에서 공개 프로필로, 프로필의 글·댓글에서 그 글과 시장으로 끝까지 간다', async ({
    admin,
    page,
  }) => {
    const tag = freshTag();
    const first = await createOpenMarket(admin);
    const second = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const profileUrl = `/u/${me.profile.publicId}`;
    // The member's post on one market; on the other, the admin's post and 댓글 and the member's
    // 대댓글 under it — the chain from a 답글 (#48's '답글' is a 댓글 or a 대댓글, ADR-0069).
    const post = await postThroughApi(page.request, first.id, `근거 ${tag}`, tag);
    const adminPost = await postThroughApi(admin, second.id, `운영자 글 ${tag}`, tag);
    const adminComment = await commentThroughApi(admin, adminPost, null, `운영자 댓글 ${tag}`);
    const reply = await commentThroughApi(page.request, adminPost, adminComment, `답글 ${tag}`);
    await closeMarket(admin, second.id);
    await logOut(page);

    // --- from the post's byline: the profile, its 글 tab, the post's market.
    await page.goto(`/community/posts/${post}`);
    await page.getByTestId('post-screen').getByTestId('post-author-link').first().click();
    await expect(page).toHaveURL(profileUrl);
    const posts = page.getByTestId('profile-posts-list');
    await expectPosts(posts, [post]);
    await posts.getByTestId(`post-card-${post}`).getByTestId('post-card-market').click();
    await expect(page).toHaveURL(`/markets/${first.slug}`);
    await expect(page.getByRole('heading', { level: 2, name: first.title })).toBeVisible();
    // And the card itself opens the post.
    await page.goBack();
    await expect(page).toHaveURL(profileUrl);
    await posts.getByTestId(`post-card-${post}`).getByTestId('post-card-link').click();
    await expect(page).toHaveURL(`/community/posts/${post}`);

    // --- from the 대댓글's byline: the profile, its 댓글 tab, the 대댓글's post and market.
    await page.goto(`/community/posts/${adminPost}`);
    await page.getByTestId(`comment-${reply}`).getByTestId('post-author-link').click();
    await expect(page).toHaveURL(profileUrl);
    await page.getByTestId('profile-authored-tab-comments').click();
    const comments = page.getByTestId('profile-comments-list');
    await expectComments(comments, [reply]);
    const card = comments.getByTestId(`authored-comment-${reply}`);
    await expect(card.getByTestId('authored-comment-post')).toHaveText(`운영자 글 ${tag}`);
    await card.getByTestId('authored-comment-market').click();
    await expect(page).toHaveURL(`/markets/${second.slug}`);
    await expect(page.getByRole('heading', { level: 2, name: second.title })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(`${profileUrl}?tab=comments`);
    await comments
      .getByTestId(`authored-comment-${reply}`)
      .getByTestId('authored-comment-link')
      .click();
    await expect(page).toHaveURL(`/community/posts/${adminPost}`);
    await expect(page.getByTestId(`comment-${reply}`).getByTestId('comment-body')).toHaveText(
      `답글 ${tag}`,
    );
  });

  test('MY 요약은 글과 댓글을 최신 셋씩 이름 붙은 목록으로 보이고 더 보기가 없으며, 내 글 탭과 프로필의 두 탭은 더 보기로 다음 페이지를 이어 모두 보이고, 실패한 더 보기는 단추 위에 까닭을 말하고 다시 누르면 잇는다', async ({
    admin,
    page,
  }) => {
    const tag = freshTag();
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const profileUrl = `/u/${me.profile.publicId}`;
    // Three posts and four comments, one after another, so each is newer than the one before it:
    // three 댓글 under the first post and a 대댓글 under the first 댓글. Three posts, not four: a
    // member writes at most three in ten minutes (#187, WRITE_LIMITED, ADR-0083 결정 4), so the
    // summary is shown cutting the 글 list to three below with a fourth row the browser adds.
    const posts: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      posts.push(await postThroughApi(page.request, market.id, `글 ${String(i)} ${tag}`, tag));
    }
    const [firstPost] = posts as [string];
    const comments: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      comments.push(await commentThroughApi(page.request, firstPost, null, `댓글 ${String(i)}`));
    }
    const [firstComment] = comments as [string];
    comments.push(await commentThroughApi(page.request, firstPost, firstComment, `답글 ${tag}`));
    const newestPosts = [...posts].reverse();
    const newestComments = [...comments].reverse();

    // --- MY's summary: the newest three of each (MY_PREVIEW_ROWS) and no 더 보기 — 전체 보기 is
    // the way on — each list named by its label. The 글 list's read answers a fourth, older row
    // than the server has — the oldest post again under an id of its own — as a fourth post
    // written ten minutes on would be: the summary leaves it out, as it leaves out the oldest 댓글.
    const isMyPostsFirstRead = (url: URL) =>
      url.pathname === '/api/v1/me/posts' && !url.searchParams.has('cursor');
    const olderThanAll = crypto.randomUUID();
    let answeredWithFour = 0;
    await page.route(isMyPostsFirstRead, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { data: { id: string; createdAt: string }[] };
      const oldest = body.data.at(-1);
      if (oldest !== undefined) {
        const createdAt = new Date(new Date(oldest.createdAt).getTime() - 60_000).toISOString();
        body.data.push({ ...oldest, id: olderThanAll, createdAt });
      }
      if (body.data.length === 4) answeredWithFour += 1;
      await route.fulfill({ response, json: body });
    });
    await page.goto('/my');
    const preview = page.getByTestId('my-preview-posts');
    const previewPosts = preview.getByTestId('my-preview-posts-list');
    const previewComments = preview.getByTestId('my-preview-comments-list');
    await expectPosts(previewPosts, newestPosts.slice(0, 3));
    expect(answeredWithFour).toBeGreaterThan(0);
    await expect(previewPosts.getByTestId(`post-card-${olderThanAll}`)).toHaveCount(0);
    await expectComments(previewComments, newestComments.slice(0, 3));
    await expect(preview.getByTestId('my-preview-posts-list-more')).toHaveCount(0);
    await expect(preview.getByTestId('my-preview-comments-list-more')).toHaveCount(0);
    await expect(previewPosts.getByRole('list')).toHaveAccessibleName(copy.authoredTabPosts);
    await expect(previewComments.getByRole('list')).toHaveAccessibleName(copy.authoredTabComments);
    // The tab: all three, one page of them — read again, the summary's first page (the added row
    // in it) being the tab's too for the cache's 30 seconds.
    await page.unroute(isMyPostsFirstRead);
    await preview.getByRole('link', { name: `${copy.myPosts} ${copy.myViewAll}` }).click();
    await expect(page).toHaveURL('/my/posts');
    await page.reload();
    await expectPosts(page.getByTestId('my-posts-list'), newestPosts);
    await expect(page.getByTestId('my-posts-list-more')).toHaveCount(0);

    // --- two to a page from here on (the browser's reads get `limit=2`): each list shows its first
    // page, 더 보기 brings the next after it, newest first still, and goes away on the last page.
    // A 더 보기 that fails first — the next page refused through the client's retries — keeps the
    // first page, says so right above the button with the first read's words (a server error:
    // '문제가 발생했습니다…') and leaves 더 보기 to ask again (owner decision 2026-10-20 7, as
    // discussion.spec.ts's); asked again, the next page comes and the notice goes with the button.
    await page.route(isAuthoredListRead, (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set('limit', '2');
      return route.continue({ url: url.toString() });
    });
    const isNextPage = (url: URL) => isAuthoredListRead(url) && url.searchParams.has('cursor');
    const pagesThrough = async (
      list: Locator,
      more: Locator,
      expectRows: (list: Locator, ids: string[]) => Promise<void>,
      ids: string[],
    ) => {
      await expectRows(list, ids.slice(0, 2));
      const moreTestId = (await more.getAttribute('data-testid')) ?? '';
      const moreFailed = page.getByTestId(`${moreTestId}-failed`);
      await expect(moreFailed).toHaveCount(0);
      await page.route(isNextPage, (route) => route.fulfill(SERVER_ERROR));
      await more.click();
      await expect(moreFailed).toHaveText(copy.errUnknown);
      await expect(moreFailed).toHaveAttribute('role', 'alert');
      await expect(
        page.locator(`[data-testid="${moreTestId}-failed"] + [data-testid="${moreTestId}"]`),
      ).toHaveCount(1);
      await expectRows(list, ids.slice(0, 2));
      await expect(more).toBeEnabled();
      await page.unroute(isNextPage);
      await more.click();
      await expectRows(list, ids);
      await expect(moreFailed).toHaveCount(0);
      await expect(more).toHaveCount(0);
    };
    await page.goto('/my/posts');
    await pagesThrough(
      page.getByTestId('my-posts-list'),
      page.getByTestId('my-posts-list-more'),
      expectPosts,
      newestPosts,
    );
    await page.getByTestId('my-authored-tab-comments').click();
    await pagesThrough(
      page.getByTestId('my-comments-list'),
      page.getByTestId('my-comments-list-more'),
      expectComments,
      newestComments,
    );
    await page.goto(profileUrl);
    await pagesThrough(
      page.getByTestId('profile-posts-list'),
      page.getByTestId('profile-posts-list-more'),
      expectPosts,
      newestPosts,
    );
    await page.getByTestId('profile-authored-tab-comments').click();
    await pagesThrough(
      page.getByTestId('profile-comments-list'),
      page.getByTestId('profile-comments-list-more'),
      expectComments,
      newestComments,
    );
    await page.unroute(isAuthoredListRead);
  });

  test('운영자가 숨긴 글·댓글은 MY 내 글과 그 요약에서 카드 위에 숨김을, 사유가 있으면 그 신고 사유와 운영자 설명도 보이며, 그 줄 옆의 삭제는 확인한 뒤 지워 목록과 수에서 뺀다', async ({
    admin,
    page,
  }) => {
    const tag = freshTag();
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    // The middle post has no title and the middle comment two lines: what names them is the first.
    // The comment's first line is longer than the 300 characters a name keeps to (a comment can be
    // 1,000 on one line, #45-3) and holds a web address with nowhere to break.
    const longLine = `댓글 2 ${tag} https://example.com/${'a'.repeat(400)}`;
    const [olderPost, middlePost, newestPost] = [
      await postThroughApi(page.request, market.id, `글 1 ${tag}`, tag),
      await postThroughApi(page.request, market.id, null, `글 2 ${tag}\n둘째 줄 ${tag}`),
      await postThroughApi(page.request, market.id, `글 3 ${tag}`, tag),
    ];
    const [olderComment, middleComment, newestComment] = [
      await commentThroughApi(page.request, olderPost, null, `댓글 1 ${tag}`),
      await commentThroughApi(page.request, olderPost, null, `${longLine}\n둘째 줄 ${tag}`),
      await commentThroughApi(page.request, olderPost, null, `댓글 3 ${tag}`),
    ];

    // Nothing hides an item before #50, so MY's own answers are changed in the browser: of each
    // list, one item hidden with a reason — a report reason and, for the post, the operator's
    // explanation (owner decision 2026-10-22) — one hidden without (as every hiding is until #50
    // records one), one not hidden. The rows stay published in the database, so the 삭제 below
    // goes through the real delete routes and the lists read after it are the server's.
    const note = '같은 링크를 반복해 올렸습니다.';
    const hiding = new Map<string, HiddenNotice>([
      [newestPost, { reason: { code: 'spam', note } }],
      [middlePost, { reason: null }],
      [middleComment, { reason: { code: 'off_topic', note: null } }],
      [newestComment, { reason: null }],
    ]);
    // Each 삭제 says which item it deletes, in its dialog and in its accessible name (owner decision
    // 2026-10-22, 3rd; ADR-0080 7-19): a post by its title — or its first line, having none — and
    // a comment by its own first line, at most its first 300 characters (a card's preview's cut,
    // POST_EXCERPT_MAX_LENGTH; all of these are one UTF-16 unit and one character each), and a
    // '…' after a line so cut (owner decision 2026-10-22, 4th) — the long comment's alone.
    const itemName = new Map<string, string>([
      [newestPost, `글 3 ${tag}`],
      [middlePost, `글 2 ${tag}`],
      [middleComment, `${longLine.slice(0, 300)}…`],
      [newestComment, `댓글 3 ${tag}`],
    ]);
    const deleteName = new Map<string, string>([
      [newestPost, `글 3 ${tag} ${copy.postDelete}`],
      [middlePost, `글 2 ${tag} ${copy.postDelete}`],
      [middleComment, `${longLine.slice(0, 300)}… ${copy.commentDelete}`],
      [newestComment, `댓글 3 ${tag} ${copy.commentDelete}`],
    ]);
    const isMyListRead = (url: URL) =>
      url.pathname === '/api/v1/me/posts' || url.pathname === '/api/v1/me/comments';
    await page.route(isMyListRead, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        data: { id: string; hidden: HiddenNotice | null }[];
      };
      for (const item of body.data) item.hidden = hiding.get(item.id) ?? item.hidden;
      await route.fulfill({ response, json: body });
    });

    /**
     * The marks one list draws: '숨김' over the two hidden cards with 삭제 beside it, the reason
     * (and the note, when there is one) over one of them, and under both the way to 조치·신고 내역
     * (#186, owner decision 2026-10-22 답 9 — a link, no deadline); nothing over the third. The two
     * 삭제 read '삭제' and are named apart, each by its item.
     */
    const expectMarks = async (
      list: Locator,
      card: (id: string) => string,
      withReason: { id: string; reason: string; note: string | null },
      withoutReason: string,
      shown: string,
      deleteWord: string,
    ) => {
      const marked = itemOf(list, card(withReason.id));
      await expect(marked.getByTestId('authored-hidden')).toContainText(copy.authoredHidden);
      await expect(marked.getByTestId('authored-hidden-reason')).toHaveText(
        `${copy.authoredHiddenReason}: ${withReason.reason}`,
      );
      if (withReason.note === null) {
        await expect(marked.getByTestId('authored-hidden-note')).toHaveCount(0);
      } else {
        await expect(marked.getByTestId('authored-hidden-note')).toHaveText(
          `${copy.authoredHiddenNote}: ${withReason.note}`,
        );
      }
      // Above the card, so it is read before the card's link; 삭제 beside the mark, not in it.
      await expect(marked.locator('[data-testid="authored-hidden-line"] + article')).toHaveCount(1);
      await expect(
        marked.locator('[data-testid="authored-hidden"] + [data-testid="authored-hidden-delete"]'),
      ).toHaveText(deleteWord);
      await expect(marked.getByTestId('authored-hidden-delete')).toHaveAccessibleName(
        deleteName.get(withReason.id) ?? '',
      );
      for (const item of [marked, itemOf(list, card(withoutReason))]) {
        const link = item.getByTestId('authored-hidden').getByTestId('authored-hidden-moderation');
        await expect(link).toHaveText(copy.myModerationOpen);
        await expect(link).toHaveAttribute('href', '/my/moderation');
        await expect(item.getByTestId('authored-hidden')).not.toContainText(
          copy.moderationAppealDeadline,
        );
      }
      const bare = itemOf(list, card(withoutReason));
      await expect(bare.getByTestId('authored-hidden')).toHaveText(
        `${copy.authoredHidden}${copy.myModerationOpen}`,
      );
      await expect(bare.getByTestId('authored-hidden-reason')).toHaveCount(0);
      await expect(bare.getByTestId('authored-hidden-note')).toHaveCount(0);
      await expect(bare.getByTestId('authored-hidden-delete')).toHaveText(deleteWord);
      await expect(bare.getByTestId('authored-hidden-delete')).toHaveAccessibleName(
        deleteName.get(withoutReason) ?? '',
      );
      const plain = itemOf(list, card(shown));
      await expect(plain.getByTestId('authored-hidden-line')).toHaveCount(0);
      await expect(plain.getByTestId('authored-hidden-delete')).toHaveCount(0);
      await expect(list.getByTestId('authored-hidden')).toHaveCount(2);
      await expect(list.getByTestId('authored-hidden-delete')).toHaveCount(2);
      await expect(list.getByTestId('authored-hidden-reason')).toHaveCount(1);
      await expect(list.getByTestId('authored-hidden-moderation')).toHaveCount(2);
    };
    const postCard = (id: string) => `post-card-${id}`;
    const commentCard = (id: string) => `authored-comment-${id}`;
    const spam = { id: newestPost, reason: copy.reportReasonSpam, note };
    const offTopic = { id: middleComment, reason: copy.reportReasonOffTopic, note: null };

    // 삭제 sends the account the screen shows, so it waits for `GET /me` (ADR-0080 7-22): with
    // that answer held back, the list and its 삭제 are drawn, and 삭제 cannot be pressed yet.
    let answerMe = () => {};
    const meHeld = new Promise<void>((resolve) => {
      answerMe = resolve;
    });
    const isMeRead = (url: URL) => url.pathname === '/api/v1/me';
    await page.route(isMeRead, async (route) => {
      await meHeld;
      await route.continue();
    });
    await page.goto('/my/posts');
    const myPosts = page.getByTestId('my-posts-list');
    await expectPosts(myPosts, [newestPost, middlePost, olderPost]);
    const hiddenDeletes = myPosts.getByTestId('authored-hidden-delete');
    await expect(hiddenDeletes).toHaveCount(2);
    for (const button of await hiddenDeletes.all()) await expect(button).toBeDisabled();
    answerMe();
    for (const button of await hiddenDeletes.all()) await expect(button).toBeEnabled();
    await page.unroute(isMeRead);
    await expectMarks(myPosts, postCard, spam, middlePost, olderPost, copy.postDelete);
    await page.getByTestId('my-authored-tab-comments').click();
    const myComments = page.getByTestId('my-comments-list');
    await expectComments(myComments, [newestComment, middleComment, olderComment]);
    await expectMarks(
      myComments,
      commentCard,
      offTopic,
      newestComment,
      olderComment,
      copy.commentDelete,
    );

    // The summary's preview draws the same rows with the same marks and the same 삭제.
    await page.goto('/my');
    const previewPosts = page.getByTestId('my-preview-posts-list');
    await expectPosts(previewPosts, [newestPost, middlePost, olderPost]);
    await expectMarks(previewPosts, postCard, spam, middlePost, olderPost, copy.postDelete);
    const previewComments = page.getByTestId('my-preview-comments-list');
    await expectComments(previewComments, [newestComment, middleComment, olderComment]);
    await expectMarks(
      previewComments,
      commentCard,
      offTopic,
      newestComment,
      olderComment,
      copy.commentDelete,
    );

    // 삭제 on a hidden post (owner decision 2026-10-22): the post page's own confirm dialog and
    // words. Cancelled, nothing is sent and the post stays.
    await page.goto('/my/posts');
    await expectPosts(myPosts, [newestPost, middlePost, olderPost]);
    const deletes: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/delete')) {
        deletes.push(new URL(request.url()).pathname);
      }
    });
    const hiddenPostItem = itemOf(myPosts, postCard(middlePost));
    await hiddenPostItem.getByTestId('authored-hidden-delete').click();
    const dialog = page.getByTestId('authored-hidden-delete-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(dialog).toContainText(copy.postDeleteTitle);
    await expect(dialog).toContainText(copy.postDeleteBody);
    /**
     * The dialog says which item, on a line of its own between its title and the warning (owner
     * decision 2026-10-22, 3rd): this post has no title, so its first line and not the rest of
     * its text. A screen reader hears the item with the title, as the dialog's name, and the
     * warning alone as its description — never the member's words running on into the warning
     * (ADR-0080 7-19).
     *
     * And the line stays in the dialog at either width: it breaks within itself (nothing wider
     * than it, a long address included), it keeps to three lines — the long comment's line is
     * more and is cut to them, so this sees the cut — and the dialog stays on the screen. The
     * page's own width cannot tell: the dialog sits in a fixed positioner, which adds nothing to
     * the document's scroll width.
     */
    const expectItemSaid = async (id: string, title: string, warning: string) => {
      const line = dialog.getByTestId('authored-hidden-delete-item');
      await expect(line).toHaveText(itemName.get(id) ?? '');
      await expect(
        dialog.locator(
          '[data-testid="authored-hidden-delete-item"] + [data-testid="authored-hidden-delete-description"]',
        ),
      ).toHaveText(warning);
      await expect(page.getByRole('alertdialog')).toHaveAccessibleName(
        `${title} ${itemName.get(id) ?? ''}`,
      );
      await expect(page.getByRole('alertdialog')).toHaveAccessibleDescription(warning);
      await expect(dialog).not.toContainText(`둘째 줄 ${tag}`);
      const fit = await line.evaluate((element) => {
        const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
        return {
          lineHeight,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          breaksWithin: element.scrollWidth <= element.clientWidth,
          threeLinesAtMost: element.clientHeight <= 3 * lineHeight + 1,
          cut: element.scrollHeight > element.clientHeight + 1,
        };
      });
      expect(fit).toMatchObject({
        breaksWithin: true,
        threeLinesAtMost: true,
        cut: id === middleComment,
      });
      const box = await dialog.boundingBox();
      const viewport = page.viewportSize();
      expect(box).not.toBeNull();
      expect(viewport).not.toBeNull();
      if (box !== null && viewport !== null) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
    };
    await expectItemSaid(middlePost, copy.postDeleteTitle, copy.postDeleteBody);
    await page.getByTestId('authored-hidden-delete-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expectPosts(myPosts, [newestPost, middlePost, olderPost]);
    expect(deletes).toEqual([]);

    // Confirmed: the author's own delete route, a toast, and the post leaves the list.
    await hiddenPostItem.getByTestId('authored-hidden-delete').click();
    const deletedPost = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/posts/${middlePost}/delete`,
    );
    await page.getByTestId('authored-hidden-delete-confirm').click();
    expect((await deletedPost).status()).toBe(200);
    await expect(page.getByText(copy.postDeletedToast)).toBeVisible();
    await expectPosts(myPosts, [newestPost, olderPost]);
    await expect(dialog).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    // The same on the 댓글 tab, with the comment area's words. The comment's post is opened from
    // its card first and left with Back, so the browser holds that post's thread: the deletion
    // marks it stale (the post the comment sits under, not the comment's own id), or Forward —
    // which brings the page back as it was drawn, without asking the server — would show the
    // deleted comment still.
    await page.getByTestId('my-authored-tab-comments').click();
    await expectComments(myComments, [newestComment, middleComment, olderComment]);
    await itemOf(myComments, commentCard(newestComment))
      .getByTestId('authored-comment-link')
      .click();
    await expect(page).toHaveURL(`/community/posts/${olderPost}`);
    const thread = page.getByTestId('post-comments');
    await expect(thread.getByTestId(`comment-${newestComment}`)).toContainText(`댓글 3 ${tag}`);
    await page.goBack();
    await expect(page).toHaveURL(/\/my\/posts\?tab=comments$/);
    await expectComments(myComments, [newestComment, middleComment, olderComment]);
    await itemOf(myComments, commentCard(newestComment))
      .getByTestId('authored-hidden-delete')
      .click();
    await expect(dialog).toContainText(copy.commentDeleteTitle);
    await expect(dialog).toContainText(copy.commentDeleteBody);
    await expectItemSaid(newestComment, copy.commentDeleteTitle, copy.commentDeleteBody);
    const deletedComment = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/comments/${newestComment}/delete`,
    );
    await page.getByTestId('authored-hidden-delete-confirm').click();
    expect((await deletedComment).status()).toBe(200);
    await expect(page.getByText(copy.commentDeletedToast)).toBeVisible();
    await expectComments(myComments, [middleComment, olderComment]);
    expect(deletes).toEqual([
      `/api/v1/posts/${middlePost}/delete`,
      `/api/v1/comments/${newestComment}/delete`,
    ]);
    await page.goForward();
    await expect(page).toHaveURL(`/community/posts/${olderPost}`);
    await expect(thread.getByTestId(`comment-${middleComment}`)).toContainText(`댓글 2 ${tag}`);
    await expect(thread).not.toContainText(`댓글 3 ${tag}`);
    await page.goBack();
    await expect(page).toHaveURL(/\/my\/posts\?tab=comments$/);

    // Deleted meanwhile — from another tab, say — the server refuses (404): the toast is the
    // comment area's sentence for a comment that is gone, not the post page's, and MY's lists,
    // read again, drop the item. A post the same, with the post page's sentence.
    const me = await meOf(page.request);
    const elsewhere = async (path: string) => {
      const res = await page.request.post(path, { data: { expectedAccountId: me.id } });
      expect(res.status(), await res.text()).toBe(200);
    };
    const refusal = (path: string) =>
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' && new URL(response.url()).pathname === path,
      );
    await expectComments(myComments, [middleComment, olderComment]);
    await elsewhere(`/api/v1/comments/${middleComment}/delete`);
    await itemOf(myComments, commentCard(middleComment))
      .getByTestId('authored-hidden-delete')
      .click();
    await expectItemSaid(middleComment, copy.commentDeleteTitle, copy.commentDeleteBody); // its first line's first 300 and '…'
    const refusedComment = refusal(`/api/v1/comments/${middleComment}/delete`);
    await page.getByTestId('authored-hidden-delete-confirm').click();
    expect((await refusedComment).status()).toBe(404);
    await expect(page.getByText(copy.errCommentGone)).toBeVisible();
    await expect(page.getByText(copy.errPostGone)).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    await expectComments(myComments, [olderComment]);

    await page.getByTestId('my-authored-tab-posts').click();
    await expectPosts(myPosts, [newestPost, olderPost]);
    await elsewhere(`/api/v1/posts/${newestPost}/delete`);
    await itemOf(myPosts, postCard(newestPost)).getByTestId('authored-hidden-delete').click();
    await expectItemSaid(newestPost, copy.postDeleteTitle, copy.postDeleteBody); // its title
    const refusedPost = refusal(`/api/v1/posts/${newestPost}/delete`);
    await page.getByTestId('authored-hidden-delete-confirm').click();
    expect((await refusedPost).status()).toBe(404);
    await expect(page.getByText(copy.errPostGone)).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expectPosts(myPosts, [olderPost]);
    expect(deletes).toEqual([
      `/api/v1/posts/${middlePost}/delete`,
      `/api/v1/comments/${newestComment}/delete`,
      `/api/v1/comments/${middleComment}/delete`,
      `/api/v1/posts/${newestPost}/delete`,
    ]);

    // Gone from the summary's preview, and from the counts and tabs of the member's profile.
    await page.goto('/my');
    await expectPosts(previewPosts, [olderPost]);
    await expectComments(previewComments, [olderComment]);
    await page.unroute(isMyListRead);
    await page.getByTestId('my-view-profile').click();
    await expectCounts(page, 1, 1);
    await expectPosts(page.getByTestId('profile-posts-list'), [olderPost]);
  });

  test('운영자가 정말로 숨긴 글·댓글은 MY 내 글에 숨김과 그 조치의 사유·운영자 설명으로 보이고, 그 줄 옆의 삭제로 지우면 목록에서 빠진다(#51이 #50에 남긴 시험)', async ({
    admin,
    page,
  }) => {
    const tag = freshTag();
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const postId = await postThroughApi(page.request, market.id, `숨겨질 글 ${tag}`, tag);
    const keptPost = await postThroughApi(page.request, market.id, `남는 글 ${tag}`, tag);
    const commentId = await commentThroughApi(page.request, keptPost, null, `숨겨질 댓글 ${tag}`);

    // An operator hides the post and the comment through #50's routes, each with a report reason
    // and, for the post, the explanation the author reads (owner decision 2026-10-22).
    const operator = await meOf(admin);
    const note = `같은 링크를 반복했습니다 ${tag}`;
    const hidePost = await admin.post(`/api/v1/admin/moderation/posts/${postId}/hide`, {
      data: { reason: 'spam', note, expectedAccountId: operator.id },
    });
    expect(hidePost.status(), await hidePost.text()).toBe(200);
    const hideComment = await admin.post(`/api/v1/admin/moderation/comments/${commentId}/hide`, {
      data: { reason: 'off_topic', note: null, expectedAccountId: operator.id },
    });
    expect(hideComment.status(), await hideComment.text()).toBe(200);

    const myPosts = page.getByTestId('my-posts-list');
    const myComments = page.getByTestId('my-comments-list');
    await page.goto('/my/posts');
    await expectPosts(myPosts, [keptPost, postId]);
    const hiddenPost = itemOf(myPosts, `post-card-${postId}`);
    await expect(hiddenPost.getByTestId('authored-hidden')).toContainText(copy.authoredHidden);
    await expect(hiddenPost.getByTestId('authored-hidden-reason')).toHaveText(
      `${copy.authoredHiddenReason}: ${copy.reportReasonSpam}`,
    );
    await expect(hiddenPost.getByTestId('authored-hidden-note')).toHaveText(
      `${copy.authoredHiddenNote}: ${note}`,
    );
    await expect(
      itemOf(myPosts, `post-card-${keptPost}`).getByTestId('authored-hidden'),
    ).toHaveCount(0);

    // The public sees the placeholder only.
    const publicPost = await page.request.get(`/api/v1/posts/${postId}`);
    expect(((await publicPost.json()) as { data: { state: string } }).data.state).toBe('hidden');

    // 삭제 beside the line, named by the post it deletes (#51's dialog, ADR-0080 7-19): the author's
    // delete route takes the hidden post, which leaves MY.
    const deletePost = hiddenPost.getByTestId('authored-hidden-delete');
    await expect(deletePost).toHaveAccessibleName(`숨겨질 글 ${tag} ${copy.postDelete}`);
    await deletePost.click();
    await expect(
      page.getByTestId('authored-hidden-delete-dialog').getByTestId('authored-hidden-delete-item'),
    ).toHaveText(`숨겨질 글 ${tag}`);
    const deletedPost = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/posts/${postId}/delete`,
    );
    await page.getByTestId('authored-hidden-delete-confirm').click();
    expect((await deletedPost).status()).toBe(200);
    await expect(page.getByText(copy.postDeletedToast)).toBeVisible();
    await expectPosts(myPosts, [keptPost]);
    // Nothing hung under it, so it is gone from every view.
    expect((await page.request.get(`/api/v1/posts/${postId}`)).status()).toBe(404);

    // The comment the same, on the 댓글 tab, with its reason and no explanation.
    await page.getByTestId('my-authored-tab-comments').click();
    await expectComments(myComments, [commentId]);
    const hiddenComment = itemOf(myComments, `authored-comment-${commentId}`);
    await expect(hiddenComment.getByTestId('authored-hidden-reason')).toHaveText(
      `${copy.authoredHiddenReason}: ${copy.reportReasonOffTopic}`,
    );
    await expect(hiddenComment.getByTestId('authored-hidden-note')).toHaveCount(0);
    const deleteComment = hiddenComment.getByTestId('authored-hidden-delete');
    await expect(deleteComment).toHaveAccessibleName(`숨겨질 댓글 ${tag} ${copy.commentDelete}`);
    await deleteComment.click();
    await expect(
      page.getByTestId('authored-hidden-delete-dialog').getByTestId('authored-hidden-delete-item'),
    ).toHaveText(`숨겨질 댓글 ${tag}`);
    const deletedComment = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/comments/${commentId}/delete`,
    );
    await page.getByTestId('authored-hidden-delete-confirm').click();
    expect((await deletedComment).status()).toBe(200);
    await expect(page.getByText(copy.commentDeletedToast)).toBeVisible();
    await expect(page.getByText(copy.authoredCommentsEmpty)).toBeVisible();
    await expectComments(myComments, []);
  });
});
