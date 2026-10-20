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
 * What no screen can make yet is drawn from the API's own answers changed in the browser
 * (`page.route`, as start-grant.spec.ts does): a hidden item, which MY marks '숨김' (the hiding
 * comes with #50), and a list longer than a page, which takes a smaller `limit` on the browser's
 * requests. The exclusions on the profile against MY are the API's (authored.controller.test.ts,
 * private-data.test.ts). Restricted members and withdrawn accounts are tested nowhere yet: neither
 * state exists and the lists read neither, so #185/#139 add the test that a restricted member's
 * items stay listed and #140 the withdrawn account's 404 (ADR-0080 결과 5).
 */

/** A post straight at the API with the context's cookie: this spec's subject is its author. */
async function postThroughApi(
  context: APIRequestContext,
  marketId: string,
  title: string,
  text: string,
): Promise<string> {
  const me = await meOf(context);
  const res = await context.post('/api/v1/posts', {
    data: {
      marketId,
      title,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
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
      ended.rules,
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

  test('MY 요약은 글과 댓글을 최신 셋씩 이름 붙은 목록으로 보이고 더 보기가 없으며, 내 글 탭과 프로필의 두 탭은 더 보기로 다음 페이지를 이어 모두 보인다', async ({
    admin,
    page,
  }) => {
    const tag = freshTag();
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const profileUrl = `/u/${me.profile.publicId}`;
    // Four posts and four comments, one after another, so each is newer than the one before it:
    // three 댓글 under the first post and a 대댓글 under the first 댓글.
    const posts: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
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
    // the way on — each list named by its label.
    await page.goto('/my');
    const preview = page.getByTestId('my-preview-posts');
    const previewPosts = preview.getByTestId('my-preview-posts-list');
    const previewComments = preview.getByTestId('my-preview-comments-list');
    await expectPosts(previewPosts, newestPosts.slice(0, 3));
    await expectComments(previewComments, newestComments.slice(0, 3));
    await expect(preview.getByTestId('my-preview-posts-list-more')).toHaveCount(0);
    await expect(preview.getByTestId('my-preview-comments-list-more')).toHaveCount(0);
    await expect(previewPosts.getByRole('list')).toHaveAccessibleName(copy.authoredTabPosts);
    await expect(previewComments.getByRole('list')).toHaveAccessibleName(copy.authoredTabComments);
    // The tab: all four, one page of them.
    await preview.getByRole('link', { name: `${copy.myPosts} ${copy.myViewAll}` }).click();
    await expect(page).toHaveURL('/my/posts');
    await expectPosts(page.getByTestId('my-posts-list'), newestPosts);
    await expect(page.getByTestId('my-posts-list-more')).toHaveCount(0);

    // --- two to a page from here on (the browser's reads get `limit=2`): each list shows its first
    // page, 더 보기 brings the next after it, newest first still, and goes away on the last page.
    await page.route(isAuthoredListRead, (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set('limit', '2');
      return route.continue({ url: url.toString() });
    });
    const pagesThrough = async (
      list: Locator,
      more: Locator,
      expectRows: (list: Locator, ids: string[]) => Promise<void>,
      ids: string[],
    ) => {
      await expectRows(list, ids.slice(0, 2));
      await more.click();
      await expectRows(list, ids);
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

  test('운영자가 숨긴 글·댓글은 MY 내 글과 그 요약에서 카드 위에 숨김을, 사유가 있으면 그 사유도 보이고, 숨기지 않은 것에는 아무것도 없다', async ({
    admin,
    page,
  }) => {
    const tag = freshTag();
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const [olderPost, middlePost, newestPost] = [
      await postThroughApi(page.request, market.id, `글 1 ${tag}`, tag),
      await postThroughApi(page.request, market.id, `글 2 ${tag}`, tag),
      await postThroughApi(page.request, market.id, `글 3 ${tag}`, tag),
    ];
    const [olderComment, middleComment, newestComment] = [
      await commentThroughApi(page.request, olderPost, null, `댓글 1 ${tag}`),
      await commentThroughApi(page.request, olderPost, null, `댓글 2 ${tag}`),
      await commentThroughApi(page.request, olderPost, null, `댓글 3 ${tag}`),
    ];

    // Nothing hides an item before #50, so MY's own answers are changed in the browser: of each
    // list, one item hidden with a reason, one hidden without (as every hiding is until #50 records
    // one), one not hidden.
    const reason = '스팸';
    const hiding = new Map<string, HiddenNotice>([
      [newestPost, { reason }],
      [middlePost, { reason: null }],
      [middleComment, { reason }],
      [newestComment, { reason: null }],
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

    /** The marks one list draws: '숨김' over the two hidden cards, the reason over one of them. */
    const expectMarks = async (
      list: Locator,
      card: (id: string) => string,
      withReason: string,
      withoutReason: string,
      shown: string,
    ) => {
      const marked = itemOf(list, card(withReason));
      await expect(marked.getByTestId('authored-hidden')).toContainText(copy.authoredHidden);
      await expect(marked.getByTestId('authored-hidden-reason')).toHaveText(
        `${copy.authoredHiddenReason}: ${reason}`,
      );
      // Above the card, so it is read before the card's link.
      await expect(marked.locator('[data-testid="authored-hidden"] + article')).toHaveCount(1);
      const bare = itemOf(list, card(withoutReason));
      await expect(bare.getByTestId('authored-hidden')).toHaveText(copy.authoredHidden);
      await expect(bare.getByTestId('authored-hidden-reason')).toHaveCount(0);
      await expect(itemOf(list, card(shown)).getByTestId('authored-hidden')).toHaveCount(0);
      await expect(list.getByTestId('authored-hidden')).toHaveCount(2);
      await expect(list.getByTestId('authored-hidden-reason')).toHaveCount(1);
    };
    const postCard = (id: string) => `post-card-${id}`;
    const commentCard = (id: string) => `authored-comment-${id}`;

    await page.goto('/my/posts');
    const myPosts = page.getByTestId('my-posts-list');
    await expectPosts(myPosts, [newestPost, middlePost, olderPost]);
    await expectMarks(myPosts, postCard, newestPost, middlePost, olderPost);
    await page.getByTestId('my-authored-tab-comments').click();
    const myComments = page.getByTestId('my-comments-list');
    await expectComments(myComments, [newestComment, middleComment, olderComment]);
    await expectMarks(myComments, commentCard, middleComment, newestComment, olderComment);

    // The summary's preview draws the same rows with the same marks.
    await page.goto('/my');
    const previewPosts = page.getByTestId('my-preview-posts-list');
    await expectPosts(previewPosts, [newestPost, middlePost, olderPost]);
    await expectMarks(previewPosts, postCard, newestPost, middlePost, olderPost);
    const previewComments = page.getByTestId('my-preview-comments-list');
    await expectComments(previewComments, [newestComment, middleComment, olderComment]);
    await expectMarks(previewComments, commentCard, middleComment, newestComment, olderComment);
    await page.unroute(isMyListRead);
  });
});
