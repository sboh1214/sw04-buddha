import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  closeMarket,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  meOf,
  signUp,
  test,
} from './helpers';

/**
 * 좋아요 (#49, ADR-0076; owner decisions in ADR-0069 decision 4, the #49 rows): a member likes a
 * 근거 글 — their own — a 댓글 and a 대댓글 and takes the likes back, the toggle pressed and the count
 * moving by one at each press; the page read again shows the same counts (in the server's HTML)
 * and the member's own presses; the post's community card carries the count. A post of an ended
 * market still takes likes; a deleted post's placeholder has no count and no button, while the
 * comments under it keep theirs. A visitor reads the counts and a press goes straight to the login
 * page, coming back to the post (owner decision 2026-10-20), the button keeping the keyboard focus
 * as the session answers. For both, the page hydrates without a mismatch. When the member's own
 * likes cannot be read, the counts stay, the buttons cannot be pressed, and one line on the page
 * says why (owner decision 2026-10-20). The once-per-person rule, the refusals, the
 * onboarding and the concurrency are the API's tests (likes.controller.test.ts), and so is that a
 * like moves no Coin and writes no ledger entry (a balance read here could move under a start Coin
 * the worker pays meanwhile); this walks the screens.
 */

/** A post straight at the API with the context's cookie: this spec's subject is its likes. */
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

/** Somebody else's like, straight at the API with the context's cookie (`posts` or `comments`). */
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

/**
 * React's hydration complaints in the browser's console from now on: the count is drawn by the
 * server and the reader's state only in the browser, so the first client render must draw what
 * the server did (`likeButtonView`'s pending rung) or React says so here.
 */
function hydrationErrors(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydrat/i.test(message.text())) seen.push(message.text());
  });
  return seen;
}

/** The comment `id`'s like toggle, as the thread draws it. */
const commentLike = (page: Page, id: string) =>
  page.getByTestId(`comment-${id}`).getByTestId('comment-like');

/** '좋아요 N' as the toggle and the card write it. */
const likes = (count: number) => `${copy.likeToggle} ${String(count)}`;

/**
 * A toggle once the reader's own state is known and no press of it is on the wire (`aria-busy`
 * gone): its count and whether it is pressed. After a press that is the server's answer, not only
 * the optimistic move — and the write has landed before the next step reads the page again.
 */
async function expectToggle(toggle: Locator, count: number, pressed: boolean): Promise<void> {
  await expect(toggle).not.toHaveAttribute('aria-busy');
  await expect(toggle).toHaveAttribute('aria-pressed', String(pressed));
  await expect(toggle).toHaveText(likes(count));
}

test.describe('좋아요', () => {
  test('회원이 자기 글과 댓글·답글에 좋아요를 누르고 취소하면 수가 하나씩 바뀌고, 다시 열어도 자기가 누른 것으로 보이며, 카드에도 수가 보이고, 종료된 시장의 글도 받고, 지운 글의 자리표시에는 없다', async ({
    admin,
    page,
    request,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    // The member's own post, the admin's 댓글 under it and the member's 대댓글 under that.
    const postId = await postThroughApi(page.request, market.id, `좋아요 받을 글 ${tag}`, tag);
    const adminComment = await commentThroughApi(admin, postId, null, `운영자의 댓글 ${tag}`);
    const reply = await commentThroughApi(page.request, postId, adminComment, `내 답글 ${tag}`);
    // Somebody else liked the post already: the count is everybody's, the toggle the reader's.
    await likeThroughApi(admin, 'posts', postId);

    const hydration = hydrationErrors(page);
    await page.goto(`/community/posts/${postId}`);
    const postLike = page.getByTestId('post-like');
    await expectToggle(postLike, 1, false);
    await expectToggle(commentLike(page, adminComment), 0, false);
    await expectToggle(commentLike(page, reply), 0, false);

    // --- like: one's own post too (#49), a 댓글 and a 대댓글 — one more each, pressed.
    await postLike.click();
    await expectToggle(postLike, 2, true);
    await commentLike(page, adminComment).click();
    await expectToggle(commentLike(page, adminComment), 1, true);
    await commentLike(page, reply).click();
    await expectToggle(commentLike(page, reply), 1, true);
    // The keyboard's toggle stays where it was pressed (never disabled while on the wire).
    await expect(commentLike(page, reply)).toBeFocused();

    // As the server keeps them, read again: the counts in the HTML for everyone, the presses the
    // member's own once the browser knows who reads.
    const html = await (await request.get(`/community/posts/${postId}`)).text();
    expect(html).toContain(likes(2));
    await page.reload();
    await expectToggle(postLike, 2, true);
    await expectToggle(commentLike(page, adminComment), 1, true);
    await expectToggle(commentLike(page, reply), 1, true);
    expect(hydration).toEqual([]);

    // --- take back: one fewer each, unpressed.
    await postLike.click();
    await expectToggle(postLike, 1, false);
    await commentLike(page, reply).click();
    await expectToggle(commentLike(page, reply), 0, false);
    await page.reload();
    await expectToggle(postLike, 1, false);
    await expectToggle(commentLike(page, reply), 0, false);

    // --- the card carries the count beside the comment count (#45-7).
    await page.goto(`/community?q=${tag}`);
    const card = page.getByTestId(`post-card-${postId}`);
    await expect(card.getByTestId('post-card-likes')).toHaveText(likes(1));
    await expect(card.getByTestId('post-card-comments')).toHaveText(`${copy.commentsHeading} 2`);

    // --- an ended market's post still takes likes (#49).
    await closeMarket(admin, market.id);
    await page.goto(`/community/posts/${postId}`);
    await expectToggle(postLike, 1, false);
    await postLike.click();
    await expectToggle(postLike, 2, true);
    // As the server took it (the press shows its state before the answer): read again.
    await page.reload();
    await expectToggle(postLike, 2, true);

    // --- deleted with comments under it: the placeholder shows no count and no 좋아요; the
    // comments under it are read in full, with theirs.
    await page.getByTestId('post-delete').click();
    await page.getByTestId('post-delete-confirm').click();
    await expect(page).toHaveURL('/community');
    await page.goto(`/community/posts/${postId}`);
    await expect(page.getByTestId('post-deleted')).toContainText(copy.postDeletedPlaceholder);
    await expect(page.getByTestId('post-like')).toHaveCount(0);
    await expect(page.getByTestId('post-screen')).not.toContainText(likes(2));
    await expectToggle(commentLike(page, adminComment), 1, true);
  });

  test('로그인하지 않은 방문자는 좋아요 수를 읽고, 누르면 곧바로 이 글로 돌아오는 로그인 화면으로 간다', async ({
    admin,
    page,
    request,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const postId = await postThroughApi(admin, market.id, `방문자가 보는 글 ${tag}`, tag);
    const comment = await commentThroughApi(admin, postId, null, `방문자가 보는 댓글 ${tag}`);
    await likeThroughApi(admin, 'posts', postId);
    await likeThroughApi(admin, 'comments', comment);
    const login = `/login?next=${encodeURIComponent(`/community/posts/${postId}`)}`;

    // The counts are the server's: in the HTML before any script runs.
    const html = await (await request.get(`/community/posts/${postId}`)).text();
    expect(html).toContain(likes(1));

    const hydration = hydrationErrors(page);
    // The session held back: the button is the pending rung the server drew, and the focus a
    // visitor puts on it stays when it turns into the signed-out one (the same element).
    let releaseSession: () => void = () => undefined;
    const sessionHeld = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    const isSessionRead = (url: URL) => url.pathname === '/api/auth/get-session';
    await page.route(isSessionRead, async (route) => {
      await sessionHeld;
      await route.continue().catch(() => undefined); // the tab may have dropped it meanwhile
    });
    await page.goto(`/community/posts/${postId}`);
    const postLike = page.getByTestId('post-like');
    await expect(postLike).toHaveAttribute('data-view', 'pending');
    await postLike.focus();
    releaseSession();
    await page.unroute(isSessionRead);
    // Not a toggle for a visitor, and no popup: a button that goes to the login page.
    await expect(postLike).toHaveAttribute('data-view', 'signed-out');
    await expect(postLike).toBeFocused();
    await expect(postLike).not.toHaveAttribute('aria-pressed');
    await expect(postLike).not.toHaveAttribute('aria-haspopup');
    await expect(postLike).not.toHaveAttribute('aria-expanded');
    await expect(postLike).toHaveText(likes(1));
    expect(hydration).toEqual([]);
    // Owner decision 2026-10-20 (answer 8): straight to the login page, which comes back here —
    // the watch button's way — with nothing counted.
    await postLike.click();
    await expect(page).toHaveURL(login);
    await page.goBack();
    await expect(postLike).toHaveText(likes(1));

    // A comment's 좋아요 goes the same way.
    const like = commentLike(page, comment);
    await expect(like).toHaveAttribute('data-view', 'signed-out');
    await expect(like).toHaveText(likes(1));
    await like.click();
    await expect(page).toHaveURL(login);

    // And the card's count, for everyone.
    await page.goto(`/community?q=${tag}`);
    await expect(page.getByTestId(`post-card-${postId}`).getByTestId('post-card-likes')).toHaveText(
      likes(1),
    );
  });

  test('내가 누른 좋아요를 불러오지 못하면 수는 보이고 단추는 눌리지 않으며, 까닭이 화면에 한 번 글로 보인다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const postId = await postThroughApi(page.request, market.id, `못 읽는 글 ${tag}`, tag);
    const comment = await commentThroughApi(admin, postId, null, `운영자의 댓글 ${tag}`);
    const reply = await commentThroughApi(admin, postId, comment, `운영자의 답글 ${tag}`);
    await likeThroughApi(admin, 'posts', postId);

    // The member's own likes cannot be read (each read, and its retries, fails) — answered only
    // once `release` is called, so the page can be seen before the line appears.
    const isMyLikesRead = (url: URL) => url.pathname.startsWith('/api/v1/me/likes/');
    let release = () => {};
    const failMyLikesOnRelease = async () => {
      await page.unroute(isMyLikesRead);
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(isMyLikesRead, async (route) => {
        await released;
        await route.fulfill({
          status: 503,
          json: { error: { code: 'INTERNAL', message: 'unavailable' } },
        });
      });
    };
    /**
     * Opens the post, its member's likes held unanswered, and finds the page's status region for
     * the line `within` the post's reactions or its comments: on the page and empty, so that the
     * line written into it later is announced (a status that appears with its text inside often
     * is not, ADR-0076 7-21). Then the reads fail, and the line appears in that very element.
     */
    const expectLineWrittenIntoItsRegion = async (within: Locator) => {
      await failMyLikesOnRelease();
      const asked = page.waitForRequest((request) => isMyLikesRead(new URL(request.url())));
      await page.goto(`/community/posts/${postId}`);
      const region = within.getByTestId('likes-unreadable-status');
      await asked; // the browser's session answered, and the page is hydrated
      await expect(region).toHaveAttribute('role', 'status');
      await expect(region).toBeEmpty();
      await expect(page.getByTestId('likes-unreadable-status')).toHaveCount(1);
      const before = await region.elementHandle();
      release();
      const line = within.getByTestId('likes-unreadable');
      await expect(line).toHaveText(copy.likeMineUnavailable);
      expect(await line.evaluate((el, held) => el.parentElement === held, before)).toBe(true);
    };
    let presses = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/like')) presses += 1;
    });
    const postLike = page.getByTestId('post-like');
    const notice = page.getByTestId('likes-unreadable');
    await expectLineWrittenIntoItsRegion(page.getByTestId('post-reactions'));
    // Owner decision 2026-10-20 (answer 10): the counts stay and cannot be pressed, and the
    // reason is a line of text on the screen — one for the page, beside the post's 좋아요 — which
    // every button names as its description.
    await expect(notice).toHaveText(copy.likeMineUnavailable);
    await expect(notice).toBeVisible();
    await expect(notice).toHaveCount(1);
    await expect(page.getByTestId('post-reactions').getByTestId('likes-unreadable')).toBeVisible();
    for (const button of [postLike, commentLike(page, comment), commentLike(page, reply)]) {
      await expect(button).toHaveAttribute('data-view', 'unavailable');
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).toHaveAccessibleDescription(copy.likeMineUnavailable);
    }
    await expect(postLike).toHaveText(likes(1));
    // A press sends nothing (by keyboard: the button is focusable, and Playwright's click would
    // wait for an aria-disabled button to be enabled).
    for (const button of [postLike, commentLike(page, comment)]) {
      await button.focus();
      await expect(button).toBeFocused();
      await page.keyboard.press('Enter');
    }
    await expect(postLike).toHaveText(likes(1));
    await expect(commentLike(page, comment)).toHaveText(likes(0));
    expect(presses).toBe(0);
    // Inside a phone's width, with no sideways scroll.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    // Deleted with comments under it: the post's 좋아요 is gone, so the line stands above the
    // comments that still take one.
    await page.getByTestId('post-delete').click();
    await page.getByTestId('post-delete-confirm').click();
    await expect(page).toHaveURL('/community');
    await expectLineWrittenIntoItsRegion(page.getByTestId('post-comments'));
    await expect(page.getByTestId('post-deleted')).toBeVisible();
    await expect(page.getByTestId('post-like')).toHaveCount(0);
    await expect(notice).toHaveCount(1);
    await expect(commentLike(page, comment)).toHaveAccessibleDescription(copy.likeMineUnavailable);

    // Readable again: the line goes and the toggles come back.
    await page.unroute(isMyLikesRead);
    await page.reload();
    await expectToggle(commentLike(page, comment), 0, false);
    await expect(notice).toHaveCount(0);
    // The region stays, empty, and names nothing: no button points at it.
    await expect(page.getByTestId('likes-unreadable-status')).toBeEmpty();
    await expect(commentLike(page, comment)).not.toHaveAttribute('aria-describedby');
    expect(presses).toBe(0);
  });
});
