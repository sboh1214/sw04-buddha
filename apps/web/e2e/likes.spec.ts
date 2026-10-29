import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Me } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  closeMarket,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  meOf,
  signUp,
  switchAccountUnderScreen,
  switchMeBeforeSession,
  test,
} from './helpers';

/**
 * 좋아요 (#49, ADR-0076; owner decisions in ADR-0069 decision 4, the #49 rows): a member likes a
 * 근거 글 — their own — a 댓글 and a 대댓글 and takes the likes back, the toggle pressed and the
 * count moving by one at each press; the page read again shows the same counts (the post's in the
 * server's HTML, the comments' as the browser reads them, ADR-0074) and the member's own presses;
 * the post's community card carries the count. A post of an ended market still takes likes; a
 * deleted post's placeholder has no count and no button, while the comments under it keep theirs. A
 * 대댓글 past its thread's first 50, which '답글 더 보기' brings (#48), carries its count and
 * button too, and a like in the thread keeps that button. A visitor reads the counts and a press
 * goes straight to the login page, coming back to the post (owner decision 2026-10-20), the button
 * keeping the keyboard focus as the session answers. For both, the page hydrates without a
 * mismatch. A member facing a re-consent, whom the post page keeps, sees its toggles, and a press
 * of the post's or a comment's goes to the remaining step, coming back to the post, and sends
 * nothing (owner decision 2026-10-20, answer 1); the toggles wait for `GET /me` (ADR-0091), and a
 * press the server refuses for a re-consent `GET /me` had not said yet goes there then, with no
 * toast — the toast only when `GET /me` cannot be read again (2026-10-21). When the member's own
 * likes cannot be read — or `GET /me` could not be, so whose they are is unknown (ADR-0091) — the
 * counts stay, the buttons cannot be pressed, and one line on the page says why (owner decision
 * 2026-10-20). A tab whose account switched to another while it showed the post likes nothing for
 * either: a press names the account the toggles were drawn for and is refused; and toggles whose
 * `['me']` turned to another account before the session did draw that account's own likes, read
 * afresh, before they can be pressed (ADR-0091). The once-per-person rule, the refusals, the
 * onboarding and the concurrency are the API's tests
 * (likes.controller.test.ts), and so is that a like moves no Coin and writes no ledger entry (a
 * balance read here could move under a start Coin the worker pays meanwhile); this walks the
 * screens.
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

/**
 * `GET /me` in this page answering as the server would after a revision of the terms that changed
 * members' rights, while `on`; agreeing on the step turns it off (posts.spec.ts and comments.spec.ts
 * draw it the same way — no spec can bring about a re-consent for real).
 */
async function asReconsent(page: Page): Promise<{ on: boolean }> {
  const state = { on: false };
  await page.route('**/api/v1/me', async (route) => {
    if (route.request().method() !== 'GET' || !state.on) return route.fallback();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = (await response.json()) as { data: Me };
    const { onboarding } = body.data;
    body.data.onboarding = {
      ...onboarding,
      consent: false,
      completed: false,
      nextStep: 'consent',
      consents: onboarding.consents.map((answer) =>
        answer.item === 'terms' ? { ...answer, version: 'draft-1999-01-01' } : answer,
      ),
    };
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/v1/me/consents', async (route) => {
    const response = await route.fetch();
    state.on = false;
    await route.fulfill({ response });
  });
  return state;
}

/**
 * A like refused as the server refuses an account with a step left (`OnboardedGuard`): no spec can
 * bring about a re-consent for real, so the refusal is drawn (comments.spec.ts does the same).
 */
const ONBOARDING_REFUSAL = {
  status: 409,
  json: {
    error: {
      code: 'ONBOARDING_REQUIRED',
      message: 'The onboarding is not done',
      details: { steps: ['consent'] },
    },
  },
};

/** The consent step of a re-consent, agreed on screen. */
async function agreeAgain(page: Page): Promise<void> {
  await expect(page.getByTestId('onboarding-return-reason')).toHaveText(
    copy.onboardingReconsentReason,
  );
  await page.getByTestId('consent-all').click();
  await page.getByTestId('consent-submit').click();
}

/** What the context's account liked on the post (`GET /me/likes/posts/:postId`). */
async function likedBy(
  context: APIRequestContext,
  postId: string,
): Promise<{ postLiked: boolean; likedCommentIds: string[] }> {
  const response = await context.get(`/api/v1/me/likes/posts/${postId}`);
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { data: { postLiked: boolean; likedCommentIds: string[] } })
    .data;
}

/** Records every like write the page sends (`PUT …/like`): its path and body. */
function likeWrites(page: Page): { path: string; body: unknown }[] {
  const writes: { path: string; body: unknown }[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'PUT' && path.endsWith('/like')) {
      writes.push({ path, body: request.postDataJSON() });
    }
  });
  return writes;
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

    // As the server keeps them, read again: the post's count in the HTML for everyone — the
    // comments, and their counts, the browser reads (오너 결정 2026-10-21, ADR-0074) — and the
    // presses the member's own once the browser knows who reads.
    const html = await (await request.get(`/community/posts/${postId}`)).text();
    expect(html).toContain(likes(2));
    expect(html).not.toContain(`운영자의 댓글 ${tag}`);
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

  test('답글이 50개를 넘는 댓글에 좋아요를 눌러도 답글 더 보기가 남고, 답글 더 보기가 읽어 온 답글에도 수와 단추가 있어 누르면 하나 오르며, 다시 열어 읽어 와도 자기가 누른 것으로 보인다', async ({
    admin,
    page,
  }) => {
    // #48 (오너 결정 2026-10-21, ADR-0074): a 댓글 shows its first 50 대댓글 and '답글 더 보기'
    // reads the rest; the like counts ride on every page of the thread (ADR-0076).
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const postId = await postThroughApi(page.request, market.id, `답글 많은 글 ${tag}`, tag);
    const top = await commentThroughApi(admin, postId, null, `답글 많은 댓글 ${tag}`);
    // A later 댓글 with nothing behind a button, which a like elsewhere must not give one.
    const other = await commentThroughApi(admin, postId, null, `답글 없는 댓글 ${tag}`);
    let last = '';
    for (let index = 1; index <= 51; index += 1) {
      last = await commentThroughApi(admin, postId, top, `답글 ${String(index)} ${tag}`);
    }
    // Somebody else liked the 51st 답글, the one past the first page.
    await likeThroughApi(admin, 'comments', last);

    await page.goto(`/community/posts/${postId}`);
    const thread = page.getByTestId(`comment-thread-${top}`);
    const more = thread.getByTestId('comment-replies-more');
    await expect(more).toHaveText(copy.commentRepliesMore);
    await expect(page.getByTestId(`comment-${last}`)).toHaveCount(0);
    // A like on the 댓글 writes its count into the thread and keeps the rest behind the button.
    await expectToggle(commentLike(page, top), 0, false);
    await commentLike(page, top).click();
    await expectToggle(commentLike(page, top), 1, true);
    await expect(more).toHaveText(copy.commentRepliesMore);
    await expect(
      page.getByTestId(`comment-thread-${other}`).getByTestId('comment-replies-more'),
    ).toHaveCount(0);

    // '답글 더 보기' brings the 51st with its count and its button, which a press moves by one.
    await more.click();
    await expect(more).toHaveCount(0);
    await expectToggle(commentLike(page, last), 1, false);
    await commentLike(page, last).click();
    await expectToggle(commentLike(page, last), 2, true);

    // Read again: the first 50 and the button; brought again, it is the reader's own.
    await page.reload();
    await expectToggle(commentLike(page, top), 1, true);
    await expect(page.getByTestId(`comment-${last}`)).toHaveCount(0);
    await more.click();
    await expectToggle(commentLike(page, last), 2, true);
  });

  test('자기 댓글의 좋아요를 보내는 동안 수정을 열었다 닫아 단추가 다시 그려져도 기다리고, 좋아요의 답이 온 뒤에야 취소를 보낸다', async ({
    admin,
    page,
  }) => {
    // PR #222 Codex 2차 리뷰 (ADR-0076 7-30): 수정 takes the comment's actions away and 취소
    // draws them anew — a new like button, whose own `useMutation` starts idle while the like is
    // still on the wire. It waits on every press of its target instead, so a press sends nothing
    // until the like has settled.
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const postId = await postThroughApi(admin, market.id, `다시 그려지는 단추의 글 ${tag}`, tag);
    const mine = await commentThroughApi(page.request, postId, null, `내 댓글 ${tag}`);
    // The states the presses of the comment sent, the first held on the wire until let go.
    const sent: boolean[] = [];
    let letGo: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    await page.route(`**/api/v1/comments/${mine}/like`, async (route) => {
      sent.push((route.request().postDataJSON() as { liked: boolean }).liked);
      if (sent.length === 1) await held;
      await route.fallback();
    });

    await page.goto(`/community/posts/${postId}`);
    const item = page.getByTestId(`comment-${mine}`);
    const toggle = commentLike(page, mine);
    await expectToggle(toggle, 0, false);
    await toggle.click();
    // On the wire: pressed, one more, and busy.
    await expect(toggle).toHaveAttribute('aria-busy', 'true');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveText(likes(1));
    await expect.poll(() => sent).toEqual([true]);

    // 수정 opened — the actions, the like button among them, are gone — and closed unchanged.
    await item.getByTestId('comment-edit').click();
    await expect(item.getByTestId('comment-edit-form')).toBeVisible();
    await expect(toggle).toHaveCount(0);
    await item.getByTestId('comment-edit-form').getByTestId('comment-cancel').click();
    await expect(item.getByTestId('comment-edit-form')).toHaveCount(0);
    // Drawn anew, the button still waits for the like, and a press of it sends nothing.
    await expect(toggle).toHaveAttribute('aria-busy', 'true');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveText(likes(1));
    await toggle.click();

    // The like lands: pressed at its count — not taken back by the press made while it waited.
    letGo();
    await expectToggle(toggle, 1, true);
    expect(sent).toEqual([true]);
    // Pressed now, it takes the like back.
    await toggle.click();
    await expectToggle(toggle, 0, false);
    expect(sent).toEqual([true, false]);
    await page.reload();
    await expectToggle(toggle, 0, false);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
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

    // The post's count is the server's: in the HTML before any script runs. The comment's comes
    // with the comments, which the browser reads (오너 결정 2026-10-21, ADR-0074).
    const html = await (await request.get(`/community/posts/${postId}`)).text();
    expect(html).toContain(likes(1));
    expect(html).not.toContain(`방문자가 보는 댓글 ${tag}`);

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

  test('재동의가 남은 회원이 글 화면에서 글이나 댓글의 좋아요를 누르면 보내지 않고 남은 단계로 가고, 마치면 이 글로 돌아온다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const postId = await postThroughApi(admin, market.id, `재동의 중에 보는 글 ${tag}`, tag);
    const comment = await commentThroughApi(admin, postId, null, `운영자의 댓글 ${tag}`);
    await likeThroughApi(admin, 'posts', postId);
    const postPage = `/community/posts/${postId}`;
    const viaStep = `/onboarding?next=${encodeURIComponent(postPage)}`;
    let presses = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/like')) presses += 1;
    });
    const reconsent = await asReconsent(page);
    const postLike = page.getByTestId('post-like');
    /** The browser's read of `GET /me`, which says the step is left — a press waits for it. */
    const meRead = () =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/me' &&
          response.request().method() === 'GET',
      );

    // --- the post page stays open for the re-consent (ADR-0073), and its likes are read with the
    // session alone: the toggles as for any member.
    reconsent.on = true;
    let read = meRead();
    await page.goto(postPage);
    await read;
    await expect(page).toHaveURL(postPage);
    await expectToggle(postLike, 1, false);
    await expectToggle(commentLike(page, comment), 0, false);

    // --- the post's 좋아요: the step, nothing sent; once agreed, back on the post, nothing counted.
    await postLike.click();
    await expect(page).toHaveURL(viaStep);
    expect(presses).toBe(0);
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await expectToggle(postLike, 1, false);

    // --- a comment's 좋아요 goes the same way.
    reconsent.on = true;
    read = meRead();
    await page.reload();
    await read;
    await expectToggle(commentLike(page, comment), 0, false);
    await commentLike(page, comment).click();
    await expect(page).toHaveURL(viaStep);
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await expectToggle(commentLike(page, comment), 0, false);
    expect(presses).toBe(0);

    // --- with nothing left, a press likes as it always does.
    await commentLike(page, comment).click();
    await expectToggle(commentLike(page, comment), 1, true);
    expect(presses).toBe(1);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('좋아요는 GET /me의 답을 기다려 서고(끝내 읽지 못하면 내 좋아요를 못 읽었다고 말한다), 연 뒤에 재동의가 생겨 서버가 거절하면 알림 없이 남은 단계로 가며, 내 정보를 다시 읽지 못할 때만 알린다', async ({
    admin,
    page,
  }) => {
    // The toggles draw the likes of the account the page shows and name it (ADR-0091), so they
    // stand only once `GET /me` has answered — a step left is known at the press from then on
    // (ADR-0076 7-25 had them stand before it, a press sent and refused). A re-consent `GET /me`
    // had not said yet — a revision published while the page is open — is still refused by the
    // server: `['me']` is read again, and the press goes where it would have gone — the step, with
    // no toast — and the toast says why only when `['me']` cannot be read again (owner decisions
    // 2026-10-20 answer 1 and 2026-10-21).
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const postId = await postThroughApi(admin, market.id, `재동의 전에 누르는 글 ${tag}`, tag);
    const postPage = `/community/posts/${postId}`;
    const viaStep = `/onboarding?next=${encodeURIComponent(postPage)}`;
    const postLike = page.getByTestId('post-like');
    const refused = page.getByText(copy.errPostOnboarding);
    let presses = 0;
    /** Called as the press is refused. */
    let refusing: () => void = () => undefined;
    await page.route(`**/api/v1/posts/${postId}/like`, async (route) => {
      presses += 1;
      refusing();
      await route.fulfill(ONBOARDING_REFUSAL);
    });

    // --- `GET /me` failing, every read and its retries: whose likes they would be is unknown, so
    // none can be read — the rung of likes that could not be read: the count, a button that cannot
    // be pressed, and the page's line saying why (owner decision 2026-10-20, answer 10), rather
    // than the pending rung for good — and a press sends nothing.
    let meFailures = 0;
    await page.route('**/api/v1/me', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      meFailures += 1;
      await route.fulfill({
        status: 503,
        json: { error: { code: 'INTERNAL', message: 'unavailable' } },
      });
    });
    await page.goto(postPage);
    // The first read and its two retries (1 s, 2 s) have failed.
    await expect.poll(() => meFailures, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    await expect(postLike).toHaveAttribute('data-view', 'unavailable');
    await expect(postLike).toHaveAttribute('aria-disabled', 'true');
    await expect(postLike).toHaveText(likes(0));
    await expect(page.getByTestId('likes-unreadable')).toHaveText(copy.likeMineUnavailable);
    // By keyboard: Playwright's click would wait for an aria-disabled button to be enabled.
    await postLike.focus();
    await page.keyboard.press('Enter');
    await expect(postLike).toHaveAttribute('data-view', 'unavailable');
    await expect(page).toHaveURL(postPage);
    expect(presses).toBe(0);
    await expect(refused).toHaveCount(0);
    await page.unroute('**/api/v1/me');

    // --- `GET /me` naming no step at first, a re-consent by the time the press is refused: the
    // press goes to the step with no toast, and agreeing comes back to the post, nothing counted.
    const reconsent = await asReconsent(page);
    refusing = () => {
      reconsent.on = true;
    };
    await page.goto(postPage);
    await expectToggle(postLike, 0, false);
    await postLike.click();
    await expect(page).toHaveURL(viaStep);
    expect(presses).toBe(1);
    await expect(refused).toHaveCount(0);
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await expectToggle(postLike, 0, false);
    await expect(refused).toHaveCount(0);

    // --- `GET /me` failing once the press is refused: with no step to go to, the toast says why;
    // the page stays.
    let meDown = false;
    refusing = () => {
      meDown = true;
    };
    await page.route('**/api/v1/me', async (route) => {
      if (!meDown || route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({
        status: 503,
        json: { error: { code: 'INTERNAL', message: 'unavailable' } },
      });
    });
    await postLike.click();
    await expect(refused).toBeVisible();
    await expect(page).toHaveURL(postPage);
    await expectToggle(postLike, 0, false);
    expect(presses).toBe(2);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('탭의 계정이 다른 회원으로 바뀐 뒤 앞 계정의 글 화면이 남아 있으면 좋아요는 그 화면의 계정을 대어 거절되고, 어느 계정의 좋아요도 바뀌지 않는다', async ({
    admin,
    browser,
    page,
  }) => {
    // ADR-0091 (ADR-0090 결과 5's remaining writes): in the render between the session naming B
    // and SessionCacheGuard's reset the toggles still show A's likes while the session already
    // says B, and a press naming the session's account would be taken with B's cookie — B's like
    // set to the opposite of A's. The toggles name the account of the `Me` the page was drawn from
    // (the one its post and comment writes name), so the server refuses it as another account's.
    // That render is held here: B's cookie in this tab and the session read again, while `GET /me`
    // and the member's likes still answer as A (`switchAccountUnderScreen`).
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const postId = await postThroughApi(admin, market.id, `탭이 바뀌는 글 ${tag}`, tag);
    const comment = await commentThroughApi(admin, postId, null, `운영자의 댓글 ${tag}`);
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      const b = await meOf(other.request);
      await signUp(page, freshEmail());
      const a = await meOf(page.request);
      await page.goto(`/community/posts/${postId}`);
      const postLike = page.getByTestId('post-like');
      await expectToggle(postLike, 0, false);
      await expectToggle(commentLike(page, comment), 0, false);
      await shownContext.addCookies(await page.context().cookies());
      await switchAccountUnderScreen(
        page,
        shownContext.request,
        { id: b.id, cookies: await otherContext.cookies() },
        (request) =>
          request.method() === 'GET' &&
          new URL(request.url()).pathname === `/api/v1/me/likes/posts/${postId}`,
      );

      const writes = likeWrites(page);
      const toast = page.locator('[data-scope="toast"]').getByText(copy.sessionChanged);
      const answerOf = (path: string) =>
        page.waitForResponse(
          (response) =>
            response.request().method() === 'PUT' && new URL(response.url()).pathname === path,
        );
      // A's toggles, drawn again from A's `Me` and A's likes after the guard's reset.
      await expectToggle(postLike, 0, false);
      let answered = answerOf(`/api/v1/posts/${postId}/like`);
      await postLike.click();
      expect((await answered).status()).toBe(403);
      await expect(toast).toBeVisible();
      await expectToggle(postLike, 0, false);
      answered = answerOf(`/api/v1/comments/${comment}/like`);
      await commentLike(page, comment).click();
      expect((await answered).status()).toBe(403);
      await expectToggle(commentLike(page, comment), 0, false);

      expect(writes).toEqual([
        {
          path: `/api/v1/posts/${postId}/like`,
          body: { liked: true, expectedAccountId: a.id },
        },
        {
          path: `/api/v1/comments/${comment}/like`,
          body: { liked: true, expectedAccountId: a.id },
        },
      ]);
      // Nothing liked, by B or by A.
      const none = { postLiked: false, likedCommentIds: [] };
      expect(await likedBy(other.request, postId)).toEqual(none);
      expect(await likedBy(shownContext.request, postId)).toEqual(none);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await otherContext.close();
      await shownContext.close();
    }
  });

  test('탭의 세션이 아직 앞 계정을 말하는데 글 화면의 `GET /me`가 다른 회원으로 답하면 좋아요는 그 회원의 것을 읽을 때까지 기다리고, 앞 계정의 상태로 누르지 않는다', async ({
    admin,
    browser,
    page,
  }) => {
    // ADR-0091 (ADR-0090 결정 4-2's order): `['me']` turns from A to B in place, before the
    // session does, so SessionCacheGuard resets nothing — a window-focus refetch of `GET /me`
    // answered with B's cookie while better-auth's session still says A. The likes' answer names
    // no owner: kept under one key for every account, the toggles went on showing A's likes under
    // B's `Me`, and a press named B and sent A's opposite with B's cookie — B, who likes the post,
    // unliking it. Kept under the account on screen, they are B's own likes, read afresh: the
    // pending rung until they answer (held here), where a press sends nothing, then B's.
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const postId = await postThroughApi(admin, market.id, `계정이 바뀌는 글 ${tag}`, tag);
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      const b = await meOf(other.request);
      await likeThroughApi(other.request, 'posts', postId);
      await signUp(page, freshEmail());
      await page.clock.install();
      await page.goto(`/community/posts/${postId}`);
      const postLike = page.getByTestId('post-like');
      await expectToggle(postLike, 1, false);

      // The member's likes from here on, held until released.
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(
        (url) => url.pathname === `/api/v1/me/likes/posts/${postId}`,
        async (route) => {
          await released;
          await route.fallback();
        },
      );
      const writes = likeWrites(page);
      await switchMeBeforeSession(page, shownContext, {
        id: b.id,
        cookies: await otherContext.cookies(),
      });

      // B's likes not read yet: the count, on the pending rung, and a press sends nothing.
      await expect(postLike).toHaveAttribute('data-view', 'pending');
      await postLike.click();
      release();
      // B's own like.
      await expectToggle(postLike, 1, true);

      expect(writes).toEqual([]);
      expect((await likedBy(other.request, postId)).postLiked).toBe(true);
      expect((await likedBy(shownContext.request, postId)).postLiked).toBe(false);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await otherContext.close();
      await shownContext.close();
    }
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
