import { type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test';
import type { Me } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  meOf,
  membersSwitchingSessions,
  membersTurningInPlace,
  signUp,
  test,
} from './helpers';

/**
 * 댓글·대댓글 (#48, ADR-0074; owner decisions in ADR-0069 decision 2, #45-2·3·4·5): a member
 * writes a 댓글 under a post (its address a link, a `javascript:` one not, its line break kept, no
 * probability asked), answers it and answers the answer — both land under the same 댓글, oldest
 * first, the focus back on the 답글 that opened the box — edits it in place ('수정됨', the focus
 * back on 수정), and sees the count on the post and on its community card. Deleting the 댓글 says
 * so and leaves '삭제된 글입니다' with its 대댓글 and no author, and it takes no new 대댓글; deleting a
 * 대댓글 removes it; deleting the post leaves its placeholder with every comment still readable and
 * no box to write in (N04 §6), and once its last comment is deleted the open page is its 404. An
 * admin's comment carries '운영자' and offers the member 답글 only. A visitor reads the comments,
 * which the browser reads (the server's HTML holds none), a long address wrapping inside a phone's
 * width, and is asked to sign in, coming back to the post. A 댓글 with more than 50 대댓글 shows
 * the first 50 and '답글 더 보기', and a 답글 written there reads the rest first and stands last;
 * an edit of a 답글 past the first 50 kept through a re-consent step comes back into its box, the
 * page reading on through that thread alone (오너 결정 2026-10-21) — and a read on that fails shows
 * the text apart with why until a read — 답글 더 보기, a new 답글's read on — brings its 답글 and
 * opens its edit with it (오너 결정 2026-10-22 (2차)·(3차)), unless 답글 더 보기 pressed meanwhile let
 * the box take it; past five unread reply pages a new 답글
 * stands last of those held until '답글 더 보기' brings it into place — a read of the pages meanwhile
 * puts it back there, reading nothing for it, an edit open on it staying, as a new 댓글 written on
 * the first page of a post of 125 stays at the end of the list through a read of the pages, its
 * 답글 box open, until 더 보기 brings it into place before those written after it (오너 결정
 * 2026-10-24) — and a read of the pages
 * reads a thread on five reply pages at most, the requests counted (오너 결정 2026-10-21 (2차)) —
 * and 30 in all, the threads at the top first, those past them back to their first 50 behind
 * '답글 더 보기' (오너 결정 2026-10-23);
 * the read on for such an edit reads no further than the 300 a read of the pages keeps, nothing at
 * all when the thread holds them already — one on the fifth page opens its box, one past them is
 * shown apart with why; 답글 더 보기 bringing its 답글 past them opens no box either, the text under
 * it saying it could not be reopened, and a read of the pages bringing it within them (an earlier
 * 답글 deleted) opens its edit with the text, nothing of it left once that box is let go; no box
 * opens past them when the read again on the way back is cancelled before it lands (the same
 * words under it), and a 답글 read hidden keeps the text apart with why, read out — as does one
 * deleted once its thread is read to the end (오너 결정 2026-10-22, (2차), (3차)). Leaving
 * a new 댓글, a 답글 or an edit with text asks first (staying keeps it, an empty box asks
 * nothing); an account facing a re-consent still deletes its
 * own comment on the post page, while 답글, 수정 and 올리기 take it to the step — every box's text
 * kept in the tab and put back into its box once the step is done, an open box's 올리기·저장
 * sending nothing; and a 답글 or an edit refused because its comment was deleted meanwhile, or a new
 * 댓글 because the post was, leaves its text and why where the box stood until it is closed — the
 * focus there only from a box that held it, the reason an alert otherwise, and through a re-consent
 * step too — while every other box stays open (owner decisions 2026-10-20). A box with text and no
 * write that a read takes away keeps its text with why its place takes it no more — for an account
 * facing a re-consent too, and the focus in the box's own 취소 dialog going to it; 취소 on a 답글
 * or an edit with text asks first, in the app's own dialog, a restored box too; a failed later read
 * of `GET /me` leaves the new 댓글's box as it is; and a post gone from every view while a refused
 * text is on screen keeps its page — '없거나 삭제된 글입니다.' and the texts, through a later read
 * failing — until the last is closed, then its 404 (owner decisions 2026-10-21). An edit screen
 * whose post is deleted in another tab with a comment under it — its read now the placeholder, not
 * NOT_FOUND — keeps the title and the body written in it, read-only, until 닫기, then shows the
 * placeholder a reload draws (오너 결정 2026-10-24, ADR-0073 9-52; ADR-0074 7-35) — an image on its
 * way as the post went going in after the line selected, the file after it never sent (오너 결정
 * 2026-10-25 (2차), ADR-0073 9-53). The depth rule, the placeholders' rules, the counts, the
 * permissions and the link safety are the API's and the shared package's tests; this walks the
 * screens.
 */

/**
 * `GET /me` in this page answering as the server would after a revision of the terms that changed
 * members' rights, while `on`; agreeing on the step turns it off (posts.spec.ts draws it the same
 * way — no spec can bring about a re-consent for real).
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

/** The consent step of a re-consent, agreed on screen. */
async function agreeAgain(page: Page): Promise<void> {
  await expect(page.getByTestId('onboarding-return-reason')).toHaveText(
    copy.onboardingReconsentReason,
  );
  await page.getByTestId('consent-all').click();
  await page.getByTestId('consent-submit').click();
}

/** A write refused as the server refuses an account with a step left. */
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

/** A write refused for a frequency limit (#187's, as the server will answer it). */
const RATE_LIMIT_REFUSAL = {
  status: 429,
  json: { error: { code: 'RATE_LIMITED', message: 'Too many requests', details: {} } },
};

/** The comment drafts kept in this tab's sessionStorage (lib/comment-drafts.ts), by key: text. */
function commentDraftsInTab(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.keys(sessionStorage)
        .filter((key) => key.startsWith('buddha.commentDraft:'))
        .map((key) => [
          key,
          (JSON.parse(sessionStorage.getItem(key) ?? '{}') as { text: string }).text,
        ]),
    ),
  );
}

/** One comment draft as this tab keeps it (`key`): its text and, for an edit, its thread. */
function commentDraftInTab(
  page: Page,
  key: string,
): Promise<{ text?: string; threadId?: string } | null> {
  return page.evaluate((storageKey) => {
    const stored = sessionStorage.getItem(storageKey);
    return stored === null ? null : (JSON.parse(stored) as { text?: string; threadId?: string });
  }, key);
}

/** Records each dialog the page opens and answers it with the next of `answers` (no: dismissed). */
function dialogs(page: Page): { asked: string[]; answers: boolean[] } {
  const asked: string[] = [];
  const answers: boolean[] = [];
  page.on('dialog', (dialog) => {
    asked.push(`${dialog.type()}: ${dialog.message()}`);
    void (answers.shift() === true ? dialog.accept() : dialog.dismiss());
  });
  return { asked, answers };
}

/**
 * Dismisses an open dialog the way `dismiss` does (Escape, a click outside it), as a person would —
 * sent again while the dialog is still open and not yet on its way out. Ark UI's dismissable layer
 * starts listening only a moment after the dialog shows (zag-js defers it: `whenNode`, then a frame
 * and a task in `trackInteractOutside`), so a press sent as soon as the dialog is visible can land
 * before it listens and leave the dialog open for good — measured on the 답글 box's dialog opened
 * again after an Escape: missed 12 times in 20 sent at once, none in 20 sent a second later. Not a
 * fault of the page (a person's press that early hits the backdrop, and the next one closes it).
 * Once the dialog is going (`data-state="closed"`) or gone nothing more is sent, so no stray click
 * moves the focus the test checks next.
 */
async function dismissDialog(dialog: Locator, dismiss: () => Promise<void>): Promise<void> {
  await expect(async () => {
    const state = await dialog.evaluateAll(
      (found) => found[0]?.getAttribute('data-state') ?? 'gone',
    );
    if (state === 'open') await dismiss();
    await expect(dialog).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** A post straight at the API with the context's cookie: this spec's subject is its comments. */
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

/** A 1×1 PNG for the edit screen's picker, as posts.spec.ts sends. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** The comment `id` as the thread draws it. */
const commentOf = (page: Page, id: string) => page.getByTestId(`comment-${id}`);

/** The toasts saying '쓰던 내용을 되살렸습니다.' in the toaster's region (a polite live region). */
const restoredToasts = (page: Page) =>
  page
    .locator('body > [data-scope="toast"][data-part="group"]')
    .getByRole('status')
    .filter({ hasText: copy.commentDraftRestored });

/** The id of the comment `article` drawn (its test id is `comment-<id>`). */
async function idOf(article: Locator): Promise<string> {
  const testId = await article.getAttribute('data-testid');
  const match = /^comment-([0-9a-f-]{36})$/.exec(testId ?? '');
  if (match?.[1] === undefined) throw new Error(`not a comment: ${String(testId)}`);
  return match[1];
}

test.describe('댓글·대댓글', () => {
  test('회원이 댓글을 달고 답글에 답해도 같은 댓글 아래로 가며, 고치면 수정됨, 지운 댓글과 지운 글은 자리표시로 남아 댓글이 읽힌다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const postId = await postThroughApi(page.request, market.id, `댓글 받을 글 ${tag}`, tag);
    // An admin's 댓글, the oldest: '운영자' on it (#45-9).
    const adminCommentId = await commentThroughApi(admin, postId, null, `운영자의 댓글 ${tag}`);

    await page.goto(`/community/posts/${postId}`);
    const heading = page.getByTestId('comments-heading');
    await expect(heading).toHaveText(`${copy.commentsHeading} 1`);
    const adminComment = commentOf(page, adminCommentId);
    await expect(adminComment.getByTestId('comment-body')).toHaveText(`운영자의 댓글 ${tag}`);
    await expect(adminComment.getByTestId('post-author-admin')).toHaveText(copy.postAuthorAdmin);
    // Another account's comment: 답글, never 수정 or 삭제.
    await expect(adminComment.getByTestId('comment-reply')).toBeVisible();
    await expect(adminComment.getByTestId('comment-edit')).toHaveCount(0);
    await expect(adminComment.getByTestId('comment-delete')).toHaveCount(0);

    // --- a 댓글: plain text, an http(s) address as a link, a `javascript:` one as text, the line
    // break kept (#45-3). Nothing asks for a probability, a position or an order (N05 §2).
    const composer = page.getByTestId('comment-composer');
    const input = composer.getByTestId('comment-input');
    const submit = composer.getByTestId('comment-submit');
    await expect(composer.locator('input')).toHaveCount(0);
    await expect(submit).toBeDisabled();
    // Past the limit, counted as the server counts, the send stays off and the box says why.
    await input.fill('가'.repeat(1_001));
    await expect(composer.getByTestId('comment-length')).toHaveText('1,001 / 1,000자');
    await expect(composer.getByTestId('comment-limit')).toHaveText(copy.errCommentBodyTooLong);
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(submit).toBeDisabled();
    const text = `근거 ${tag}\n출처 https://example.com/news?id=1 참고. javascript:alert(1)`;
    await input.fill(text);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(input).toHaveValue('');
    await expect(heading).toHaveText(`${copy.commentsHeading} 2`);
    const mine = page.locator('article[data-testid^="comment-"]', { hasText: `근거 ${tag}` });
    const mineId = await idOf(mine);
    const body = mine.getByTestId('comment-body');
    const link = body.getByRole('link', { name: 'https://example.com/news?id=1' });
    await expect(link).toHaveAttribute('href', 'https://example.com/news?id=1');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(body.locator('a')).toHaveCount(1);
    await expect(body).toContainText('참고. javascript:alert(1)');
    expect(await body.evaluate((element) => (element as HTMLElement).innerText)).toContain(
      `근거 ${tag}\n출처`,
    );
    await expect(mine.getByTestId('post-author-name')).toHaveText(me.profile.nickname);
    await expect(mine.getByTestId('post-author-admin')).toHaveCount(0);

    // --- 대댓글 (#45-2): 답글 opens the thread's box; an answer to a 대댓글 is another 대댓글 of the
    // same 댓글, after it — never a third layer.
    const thread = page.getByTestId(`comment-thread-${mineId}`);
    const replies = thread.getByTestId('comment-replies').locator('article');
    const replyBox = thread.getByTestId('reply-composer');
    // Closing the box puts the focus back on the 답글 that opened it (WCAG 2.4.3).
    await mine.getByTestId('comment-reply').click();
    await expect(replyBox.getByTestId('comment-input')).toBeFocused();
    await replyBox.getByTestId('comment-cancel').click();
    await expect(replyBox).toHaveCount(0);
    await expect(mine.getByTestId('comment-reply')).toBeFocused();
    await mine.getByTestId('comment-reply').click();
    await expect(replyBox.getByTestId('comment-input')).toBeFocused();
    await replyBox.getByTestId('comment-input').fill(`첫 답글 ${tag}`);
    await replyBox.getByTestId('comment-submit').click();
    await expect(replyBox).toHaveCount(0);
    await expect(replies).toHaveCount(1);
    await expect(mine.getByTestId('comment-reply')).toBeFocused();
    await replies.first().getByTestId('comment-reply').click();
    await expect(replyBox.getByTestId('comment-input')).toBeFocused();
    await replyBox.getByTestId('comment-input').fill(`답글의 답글 ${tag}`);
    await replyBox.getByTestId('comment-submit').click();
    await expect(replies).toHaveCount(2);
    await expect(replies.first().getByTestId('comment-reply')).toBeFocused();
    await expect(replies.nth(1).getByTestId('comment-body')).toHaveText(`답글의 답글 ${tag}`);
    await expect(thread.getByTestId('comment-replies').getByTestId('comment-replies')).toHaveCount(
      0,
    );
    await expect(heading).toHaveText(`${copy.commentsHeading} 4`);

    // As the server orders them (#45-2: 작성 순, oldest first), read again.
    await page.reload();
    const threads = page.getByTestId('comments-list').locator(':scope > li');
    await expect(threads).toHaveCount(2);
    await expect(threads.nth(0)).toHaveAttribute('data-testid', `comment-thread-${adminCommentId}`);
    await expect(threads.nth(1)).toHaveAttribute('data-testid', `comment-thread-${mineId}`);
    await expect(replies.nth(0).getByTestId('comment-body')).toHaveText(`첫 답글 ${tag}`);
    await expect(replies.nth(1).getByTestId('comment-body')).toHaveText(`답글의 답글 ${tag}`);
    const secondReplyId = await idOf(replies.nth(1));

    // --- edit in place (#45-4): the text only, '수정됨'.
    const own = commentOf(page, mineId);
    await expect(own.getByTestId('post-edited')).toHaveCount(0);
    await own.getByTestId('comment-edit').click();
    const editBox = own.getByTestId('comment-edit-form').getByTestId('comment-input');
    await expect(editBox).toBeFocused();
    await expect(editBox).toHaveValue(text);
    await editBox.fill(`고친 근거 ${tag}`);
    await own.getByTestId('comment-submit').click();
    await expect(own.getByTestId('comment-body')).toHaveText(`고친 근거 ${tag}`);
    await expect(own.getByTestId('post-edited')).toHaveText(copy.postEdited);
    await expect(own.getByTestId('comment-edit')).toBeFocused();

    // --- the count on the post's card (#45-7).
    await page.goto(`/community?q=${tag}`);
    await expect(
      page.getByTestId(`post-card-${postId}`).getByTestId('post-card-comments'),
    ).toHaveText(`${copy.commentsHeading} 4`);

    // --- delete the 댓글 its 대댓글 hang under (#45-5): '삭제된 글입니다', its author hidden, its
    // 대댓글 kept, and no new 대댓글 under it.
    await page.goto(`/community/posts/${postId}`);
    await own.getByTestId('comment-delete').click();
    await page.getByTestId('comment-delete-confirm').click();
    // Said, though the comment it was asked from is a placeholder by the time the answer lands.
    await expect(page.getByText(copy.commentDeletedToast)).toBeVisible();
    await expect(page.getByTestId('comment-delete-dialog')).toHaveCount(0);
    await expect(own).toHaveAttribute('data-state', 'deleted');
    await expect(own.getByTestId('comment-placeholder')).toHaveText(copy.commentDeletedPlaceholder);
    await expect(own).not.toContainText(me.profile.nickname);
    await expect(replies).toHaveCount(2);
    await expect(thread.getByTestId('comment-reply')).toHaveCount(0);
    await expect(heading).toHaveText(`${copy.commentsHeading} 3`);
    await page.reload();
    await expect(own.getByTestId('comment-placeholder')).toHaveText(copy.commentDeletedPlaceholder);
    await expect(replies).toHaveCount(2);

    // A 대댓글 with nothing under it leaves the thread.
    await commentOf(page, secondReplyId).getByTestId('comment-delete').click();
    await page.getByTestId('comment-delete-confirm').click();
    await expect(commentOf(page, secondReplyId)).toHaveCount(0);
    await expect(replies).toHaveCount(1);
    await expect(heading).toHaveText(`${copy.commentsHeading} 2`);

    // --- delete the post: comments hang under it, so its address stays as '삭제된 글입니다' and
    // every comment is still read there (N04 §6); it takes no new comment.
    await page.getByTestId('post-delete').click();
    await page.getByTestId('post-delete-confirm').click();
    await expect(page).toHaveURL('/community');
    const kept = await page.goto(`/community/posts/${postId}`);
    expect(kept?.status()).toBe(200);
    await expect(page.getByTestId('post-deleted')).toContainText(copy.postDeletedPlaceholder);
    await expect(adminComment.getByTestId('comment-body')).toHaveText(`운영자의 댓글 ${tag}`);
    await expect(replies.first().getByTestId('comment-body')).toHaveText(`첫 답글 ${tag}`);
    await expect(heading).toHaveText(`${copy.commentsHeading} 2`);
    await expect(page.getByTestId('comments-closed')).toHaveText(copy.commentClosedPostDeleted);
    await expect(page.getByTestId('comment-composer')).toHaveCount(0);
    await expect(page.getByTestId('comment-reply')).toHaveCount(0);
  });

  test('로그인하지 않은 방문자는 브라우저가 불러온 댓글과 대댓글을 읽고(서버가 그린 HTML에는 없다), 쓰기 대신 이 글로 돌아오는 로그인 안내를 받는다', async ({
    admin,
    page,
    request,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const postId = await postThroughApi(admin, market.id, `방문자가 읽는 글 ${tag}`, tag);
    const top = await commentThroughApi(admin, postId, null, `읽는 댓글 ${tag}`);
    const reply = await commentThroughApi(admin, postId, top, `읽는 답글 ${tag}`);
    // An address with no place to break, still a link (under 2,048 characters).
    const longAddress = `https://example.com/${'a'.repeat(400)}`;
    const long = await commentThroughApi(admin, postId, null, `긴 주소 ${longAddress}`);

    // The comments are the browser's to read (오너 결정 2026-10-21): the server's HTML holds the
    // post and the count, and no word of a comment — not in the markup, not in the seeded state.
    const html = await (await request.get(`/community/posts/${postId}`)).text();
    expect(html).toContain(`방문자가 읽는 글 ${tag}`);
    expect(html).toContain('data-testid="comments-heading"');
    // Under it, the wait — named for a screen reader too (busy, '불러오는 중' it reads).
    const loading = /<div[^>]*data-testid="comments-loading"[^>]*>/.exec(html)?.[0];
    expect(loading).toContain('aria-busy="true"');
    expect(html).toContain(copy.loading);
    expect(html).not.toContain(`읽는 댓글 ${tag}`);
    expect(html).not.toContain(`읽는 답글 ${tag}`);
    expect(html).not.toContain(longAddress);

    await page.goto(`/community/posts/${postId}`);
    await expect(page.getByTestId('comments-heading')).toHaveText(`${copy.commentsHeading} 3`);
    await expect(commentOf(page, top).getByTestId('comment-body')).toHaveText(`읽는 댓글 ${tag}`);
    await expect(page.getByTestId('comments-loading')).toHaveCount(0);
    // The long address wraps (`overflow-wrap: anywhere`): it stays inside the comment's own box
    // (a phone zooms out to fit what runs off, so the box is measured, not only the page).
    const longBody = commentOf(page, long).getByTestId('comment-body');
    await expect(longBody.getByRole('link', { name: longAddress })).toHaveAttribute(
      'href',
      longAddress,
    );
    expect(await longBody.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expect(
      page.getByTestId(`comment-thread-${top}`).getByTestId(`comment-${reply}`),
    ).toContainText(`읽는 답글 ${tag}`);
    await expect(page.getByTestId('comment-signed-out')).toContainText(copy.commentSignedOut);
    await expect(page.getByTestId('comment-login')).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent(`/community/posts/${postId}`)}`,
    );
    await expect(page.getByTestId('comment-composer')).toHaveCount(0);
    await expect(page.getByTestId('comment-reply')).toHaveCount(0);
    await expect(page.getByTestId('comment-edit')).toHaveCount(0);
    await expect(page.getByTestId('comment-delete')).toHaveCount(0);
  });

  test('답글이 50개를 넘는 댓글은 처음 50개와 답글 더 보기를 보이고, 새 답글은 남은 답글을 읽은 뒤 맨 끝에 온다', async ({
    admin,
    page,
  }) => {
    // 오너 결정 2026-10-21 (ADR-0074): each 댓글 shows its first 50 대댓글, oldest first, and
    // '답글 더 보기' reads 50 more at a time.
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const postId = await postThroughApi(page.request, market.id, `답글 많은 글 ${tag}`, tag);
    const top = await commentThroughApi(admin, postId, null, `답글 많은 댓글 ${tag}`);
    for (let index = 1; index <= 52; index += 1) {
      await commentThroughApi(admin, postId, top, `답글 ${String(index)} ${tag}`);
    }
    const bodies = (count: number) =>
      Array.from({ length: count }, (_, index) => `답글 ${String(index + 1)} ${tag}`);

    await page.goto(`/community/posts/${postId}`);
    const heading = page.getByTestId('comments-heading');
    await expect(heading).toHaveText(`${copy.commentsHeading} 53`);
    const thread = page.getByTestId(`comment-thread-${top}`);
    const shown = thread
      .getByTestId('comment-replies')
      .locator('article')
      .getByTestId('comment-body');
    const more = thread.getByTestId('comment-replies-more');
    await expect(shown).toHaveText(bodies(50));
    await expect(more).toHaveText(copy.commentRepliesMore);
    await more.click();
    await expect(shown).toHaveText(bodies(52));
    await expect(more).toHaveCount(0);

    // Read again: 50 and the button. A 답글 written now, with two still unread, reads them first
    // and stands last, oldest first as the server keeps them.
    await page.reload();
    await expect(shown).toHaveText(bodies(50));
    await commentOf(page, top).getByTestId('comment-reply').click();
    const replyBox = thread.getByTestId('reply-composer');
    await replyBox.getByTestId('comment-input').fill(`새 답글 ${tag}`);
    await replyBox.getByTestId('comment-submit').click();
    await expect(replyBox).toHaveCount(0);
    await expect(shown).toHaveText([...bodies(52), `새 답글 ${tag}`]);
    await expect(more).toHaveCount(0);
    await expect(heading).toHaveText(`${copy.commentsHeading} 54`);
    await page.reload();
    await expect(shown).toHaveText(bodies(50));
    await more.click();
    await expect(shown).toHaveText([...bodies(52), `새 답글 ${tag}`]);
  });

  test('지운 글 아래의 마지막 댓글을 지우면 열려 있던 글 화면은 그 글의 404가 된다', async ({
    admin,
    page,
  }) => {
    // The post stays as '삭제된 글입니다' only while a comment hangs under it (#45-5): once the
    // last one is deleted it is gone, and the open page says so rather than keeping the
    // placeholder with a count and a list that no longer agree.
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const postId = await postThroughApi(page.request, market.id, `지울 글 ${tag}`, tag);
    const last = await commentThroughApi(page.request, postId, null, `마지막 댓글 ${tag}`);
    const deletion = await page.request.post(`/api/v1/posts/${postId}/delete`, {
      data: { expectedAccountId: me.id },
    });
    expect(deletion.status(), await deletion.text()).toBe(200);

    await page.goto(`/community/posts/${postId}`);
    await expect(page.getByTestId('post-deleted')).toContainText(copy.postDeletedPlaceholder);
    await expect(page.getByTestId('comments-heading')).toHaveText(`${copy.commentsHeading} 1`);
    await commentOf(page, last).getByTestId('comment-delete').click();
    await page.getByTestId('comment-delete-confirm').click();
    await expect(page.getByText(copy.commentDeletedToast)).toBeVisible();
    await expect(page.getByTestId('post-screen')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    // As a reload says it.
    const gone = await page.reload();
    expect(gone?.status()).toBe(404);
  });
  test('쓰던 댓글·답글·수정을 두고 머리의 링크로 떠나거나 답글·수정 상자를 취소하면 먼저 묻고, 머무르면 글자가 그대로이며, 빈 상자는 묻지 않는다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const postId = await postThroughApi(page.request, market.id, `떠나기 전 글 ${tag}`, tag);
    const own = await commentThroughApi(page.request, postId, null, `내 댓글 ${tag}`);
    const postPage = `/community/posts/${postId}`;
    await page.goto(postPage);
    const { asked, answers } = dialogs(page);
    const question = `confirm: ${copy.postLeaveConfirm}`;
    // The wordmark in the header, a Next.js link on every screen and both widths.
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');

    // --- the new 댓글's box (오너 결정 2026-10-20 답 1): refused, still here with the text.
    const newInput = page.getByTestId('comment-composer').getByTestId('comment-input');
    await newInput.fill(`쓰던 댓글 ${tag}`);
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([question]);
    await expect(page).toHaveURL(postPage);
    await expect(newInput).toHaveValue(`쓰던 댓글 ${tag}`);
    await newInput.fill('   ');

    // --- a 답글's box.
    const ownComment = commentOf(page, own);
    await ownComment.getByTestId('comment-reply').click();
    const replyBox = page.getByTestId(`comment-thread-${own}`).getByTestId('reply-composer');
    await replyBox.getByTestId('comment-input').fill(`쓰던 답글 ${tag}`);
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([question, question]);
    await expect(page).toHaveURL(postPage);
    await expect(replyBox.getByTestId('comment-input')).toHaveValue(`쓰던 답글 ${tag}`);
    // 취소 with the text asks first, in the app's own dialog (오너 결정 2026-10-21 답 3) — opening
    // on its 취소, so nothing is lost on Enter. Dismissed (취소, Escape, a click outside), the box is
    // as it was and the focus back on its 취소.
    const cancel = replyBox.getByTestId('comment-cancel');
    const discardDialog = page.getByTestId('comment-discard-dialog');
    await cancel.click();
    await expect(discardDialog).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveAccessibleName(copy.commentDiscardTitle);
    await expect(page.getByRole('alertdialog')).toHaveAccessibleDescription(
      copy.commentDiscardQuestion,
    );
    await expect(page.getByTestId('comment-discard-cancel')).toBeFocused();
    await page.getByTestId('comment-discard-cancel').click();
    await expect(discardDialog).toHaveCount(0);
    await expect(cancel).toBeFocused();
    await expect(replyBox.getByTestId('comment-input')).toHaveValue(`쓰던 답글 ${tag}`);
    for (const dismiss of [
      () => page.keyboard.press('Escape'),
      () => page.mouse.click(4, 4),
    ] as const) {
      await cancel.click();
      await expect(discardDialog).toBeVisible();
      await dismissDialog(discardDialog, dismiss);
      await expect(cancel).toBeFocused();
      await expect(replyBox.getByTestId('comment-input')).toHaveValue(`쓰던 답글 ${tag}`);
    }
    // 버리기: the box closes holding nothing, the focus back on the 답글 that opened it.
    await cancel.click();
    await page.getByTestId('comment-discard-confirm').click();
    await expect(discardDialog).toHaveCount(0);
    await expect(replyBox).toHaveCount(0);
    await expect(ownComment.getByTestId('comment-reply')).toBeFocused();
    await expect(page.getByTestId('comment-held')).toHaveCount(0);

    // --- an edit: asks once the text differs from the comment.
    await ownComment.getByTestId('comment-edit').click();
    const editInput = ownComment.getByTestId('comment-edit-form').getByTestId('comment-input');
    await editInput.fill(`고치던 댓글 ${tag}`);
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([question, question, question]);
    await expect(editInput).toHaveValue(`고치던 댓글 ${tag}`);

    // --- answered yes: gone to the home screen.
    answers.push(true);
    await home.click();
    await expect(page).toHaveURL('/');
    expect(asked).toEqual([question, question, question, question]);

    // --- boxes holding nothing to lose ask nothing: a 답글 empty or blank, an edit as the comment
    // stands (an unexpected dialog would be dismissed and keep us) — on leaving, nor on 취소.
    await page.goto(postPage);
    await ownComment.getByTestId('comment-reply').click();
    await expect(replyBox.getByTestId('comment-input')).toBeFocused();
    await replyBox.getByTestId('comment-input').fill('   ');
    await replyBox.getByTestId('comment-cancel').click();
    await expect(replyBox).toHaveCount(0);
    await expect(discardDialog).toHaveCount(0);
    await ownComment.getByTestId('comment-reply').click();
    await replyBox.getByTestId('comment-input').fill('  \n ');
    await home.click();
    await expect(page).toHaveURL('/');
    await page.goto(postPage);
    await ownComment.getByTestId('comment-edit').click();
    await expect(editInput).toHaveValue(`내 댓글 ${tag}`);
    const editForm = ownComment.getByTestId('comment-edit-form');
    await editForm.getByTestId('comment-cancel').click();
    await expect(editForm).toHaveCount(0);
    await expect(discardDialog).toHaveCount(0);
    await expect(ownComment.getByTestId('comment-edit')).toBeFocused();
    // An edit changed asks on 취소 too; 버리기 leaves the comment as it stands, the focus on 수정.
    await ownComment.getByTestId('comment-edit').click();
    await editInput.fill(`버릴 수정 ${tag}`);
    await editForm.getByTestId('comment-cancel').click();
    await expect(page.getByRole('alertdialog')).toHaveAccessibleName(copy.commentDiscardTitle);
    await page.getByTestId('comment-discard-confirm').click();
    await expect(editForm).toHaveCount(0);
    await expect(ownComment.getByTestId('comment-body')).toHaveText(`내 댓글 ${tag}`);
    await expect(ownComment.getByTestId('comment-edit')).toBeFocused();
    await ownComment.getByTestId('comment-edit').click();
    await home.click();
    await expect(page).toHaveURL('/');
    expect(asked).toHaveLength(4);
  });

  test('재동의가 남은 계정은 글 화면에서 자기 댓글을 지우고, 답글·수정·올리기는 남은 단계로 가며, 쓰던 댓글·답글·수정은 단계를 마치고 돌아오면 그 상자에 되살아난다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    // The drafts are kept under each box's item for the account that wrote it (ADR-0092 답 3).
    const accountId = (await meOf(page.request)).id;
    const postId = await postThroughApi(page.request, market.id, `재동의 글 ${tag}`, tag);
    const adminMe = await meOf(admin);
    const theirs = await commentThroughApi(admin, postId, null, `운영자의 댓글 ${tag}`);
    // Deleted by its author while the reader is on the step: the 답글 to it has no box to go back to.
    const doomed = await commentThroughApi(admin, postId, null, `곧 지워질 댓글 ${tag}`);
    const editable = await commentThroughApi(page.request, postId, null, `고칠 댓글 ${tag}`);
    const deletable = await commentThroughApi(page.request, postId, null, `지울 댓글 ${tag}`);
    const postPage = `/community/posts/${postId}`;
    const viaStep = `/onboarding?next=${encodeURIComponent(postPage)}`;
    const reconsent = await asReconsent(page);
    const { asked } = dialogs(page);

    // --- boxes with text: a new 댓글, two 답글 and an edit.
    await page.goto(postPage);
    const composer = page.getByTestId('comment-composer');
    await composer.getByTestId('comment-input').fill(`새 댓글 ${tag}\n둘째 줄`);
    await commentOf(page, doomed).getByTestId('comment-reply').click();
    await page
      .getByTestId(`comment-thread-${doomed}`)
      .getByTestId('reply-composer')
      .getByTestId('comment-input')
      .fill(`갈 곳 없는 답글 ${tag}`);
    await commentOf(page, theirs).getByTestId('comment-reply').click();
    const replyBox = page.getByTestId(`comment-thread-${theirs}`).getByTestId('reply-composer');
    await replyBox.getByTestId('comment-input').fill(`답글 ${tag}`);
    await commentOf(page, editable).getByTestId('comment-edit').click();
    const editForm = commentOf(page, editable).getByTestId('comment-edit-form');
    await editForm.getByTestId('comment-input').fill(`고친 댓글 ${tag}`);
    // And a 답글 under the writer's own 댓글, which it deletes below with the step known.
    await commentOf(page, deletable).getByTestId('comment-reply').click();
    await page
      .getByTestId(`comment-thread-${deletable}`)
      .getByTestId('reply-composer')
      .getByTestId('comment-input')
      .fill(`지울 댓글에 쓰던 답글 ${tag}`);

    // --- the 댓글 refused for the onboarding: a revision asked for the consent again meanwhile.
    // The page is the gate's exception for a re-consent, so it stays — every box with its text.
    await page.route(`**/api/v1/posts/${postId}/comments`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      reconsent.on = true;
      await route.fulfill(ONBOARDING_REFUSAL);
    });
    await composer.getByTestId('comment-submit').click();
    await expect(composer.getByTestId('comment-error')).toHaveText(copy.errPostOnboarding);
    await expect(page).toHaveURL(postPage);
    await expect(replyBox.getByTestId('comment-input')).toHaveValue(`답글 ${tag}`);
    await expect(editForm.getByTestId('comment-input')).toHaveValue(`고친 댓글 ${tag}`);

    // --- deleting one's own comment needs a session alone (오너 결정 2026-10-19·20).
    await commentOf(page, deletable).getByTestId('comment-delete').click();
    await page.getByTestId('comment-delete-confirm').click();
    await expect(page.getByText(copy.commentDeletedToast)).toBeVisible();
    await expect(commentOf(page, deletable)).toHaveCount(0);
    await expect(page).toHaveURL(postPage);
    // The 답글 open under it went with it, in place — the page staying (7-23): with the step left,
    // its text is shown with why its place takes it no more, as anyone's (오너 결정 2026-10-21 답 2),
    // not put away in the tab; why is read out as an alert (the focus was in 삭제's dialog).
    const held = page.getByTestId('comment-held');
    await expect(held).toHaveCount(1);
    await expect(held.getByRole('alert')).toHaveText(copy.errCommentParentGone);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(`지울 댓글에 쓰던 답글 ${tag}`);
    expect(await commentDraftsInTab(page)).toEqual({});
    // Closed, it is gone for good: not back after the step.
    await held.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(0);

    // --- 올리기 now goes to the step (오너 결정 2026-10-20 답 3), asking nothing: every box's text
    // is kept in this tab on the way (답 2).
    await composer.getByTestId('comment-submit').click();
    await expect(page).toHaveURL(viaStep);
    await expect(page.getByTestId('consent-step')).toBeVisible();
    expect(asked).toEqual([]);
    const prefix = `buddha.commentDraft:${postId}`;
    expect(await commentDraftsInTab(page)).toEqual({
      [`${prefix}:comment@${accountId}`]: `새 댓글 ${tag}\n둘째 줄`,
      [`${prefix}:reply:${doomed}@${accountId}`]: `갈 곳 없는 답글 ${tag}`,
      [`${prefix}:reply:${theirs}@${accountId}`]: `답글 ${tag}`,
      [`${prefix}:edit:${editable}@${accountId}`]: `고친 댓글 ${tag}`,
    });
    const doomedGone = await admin.post(`/api/v1/comments/${doomed}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(doomedGone.status(), await doomedGone.text()).toBe(200);

    // --- the step done: back on the post, each box open with its text, and said so.
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await expect(composer.getByTestId('comment-input')).toHaveValue(`새 댓글 ${tag}\n둘째 줄`);
    await expect(composer.getByTestId('comment-draft-restored')).toHaveText(
      copy.commentDraftRestored,
    );
    await expect(replyBox.getByTestId('comment-input')).toHaveValue(`답글 ${tag}`);
    await expect(replyBox.getByTestId('comment-draft-restored')).toBeVisible();
    await expect(editForm.getByTestId('comment-input')).toHaveValue(`고친 댓글 ${tag}`);
    await expect(editForm.getByTestId('comment-draft-restored')).toBeVisible();
    // Said once in a toast too — the toaster's region (a polite live region) reads it out.
    const toasts = page.locator('body > [data-scope="toast"][data-part="group"]');
    await expect(toasts).toHaveAttribute('aria-live', 'polite');
    await expect(
      toasts.getByRole('status').filter({ hasText: copy.commentDraftRestored }),
    ).toHaveCount(1);
    // Taken back, they are the boxes' again — gone from the tab.
    expect(await commentDraftsInTab(page)).toEqual({});
    // The 답글 whose 댓글 went meanwhile is shown apart with why — read out as an alert, the focus
    // left where it was and the page where it was: no box on this page held it (ADR-0074 7-25).
    await expect(held).toHaveCount(1);
    await expect(held.getByRole('alert')).toHaveText(copy.errCommentParentGone);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(`갈 곳 없는 답글 ${tag}`);
    await expect(held).not.toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await held.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(0);

    // --- 취소 on a restored box asks first too (오너 결정 2026-10-21 답 3); kept, it is sent below.
    await replyBox.getByTestId('comment-cancel').click();
    await expect(page.getByRole('alertdialog')).toHaveAccessibleName(copy.commentDiscardTitle);
    await page.getByTestId('comment-discard-cancel').click();
    await expect(page.getByTestId('comment-discard-dialog')).toHaveCount(0);
    await expect(replyBox.getByTestId('comment-input')).toHaveValue(`답글 ${tag}`);
    await expect(replyBox.getByTestId('comment-cancel')).toBeFocused();

    // --- sent: each where it was written.
    await page.unroute(`**/api/v1/posts/${postId}/comments`);
    await replyBox.getByTestId('comment-submit').click();
    await expect(replyBox).toHaveCount(0);
    await expect(
      page.getByTestId(`comment-thread-${theirs}`).getByTestId('comment-replies'),
    ).toContainText(`답글 ${tag}`);
    // No 답글 opened the restored box: the focus goes to the 댓글's own (WCAG 2.4.3).
    await expect(commentOf(page, theirs).getByTestId('comment-reply')).toBeFocused();
    await editForm.getByTestId('comment-submit').click();
    await expect(commentOf(page, editable).getByTestId('comment-body')).toHaveText(
      `고친 댓글 ${tag}`,
    );
    await composer.getByTestId('comment-submit').click();
    await expect(composer.getByTestId('comment-input')).toHaveValue('');
    await expect(composer.getByTestId('comment-draft-restored')).toHaveCount(0);
    await expect(
      page.locator('article[data-testid^="comment-"]', { hasText: `새 댓글 ${tag}` }),
    ).toHaveCount(1);
    expect(asked).toEqual([]);

    // --- with the consent asked for again, 답글 and 수정 go to the step too, and come back here.
    reconsent.on = true;
    await page.reload();
    await commentOf(page, theirs).getByTestId('comment-reply').click();
    await expect(page).toHaveURL(viaStep);
    await page.goto(postPage);
    await commentOf(page, editable).getByTestId('comment-edit').click();
    await expect(page).toHaveURL(viaStep);
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await expect(page.getByTestId('comment-edit-form')).toHaveCount(0);
    expect(asked).toEqual([]);

    // --- boxes opened before the step was known: their 저장 and 올리기 go to it too, sending
    // nothing and keeping the text (답 2·3).
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT') writes.push(`PUT ${new URL(request.url()).pathname}`);
      if (request.method() === 'POST' && request.url().endsWith(`/posts/${postId}/comments`)) {
        const parentId = (request.postDataJSON() as { parentId?: string | null }).parentId;
        if (parentId) writes.push(`POST reply ${parentId}`);
      }
    });
    await commentOf(page, editable).getByTestId('comment-edit').click();
    await editForm.getByTestId('comment-input').fill(`다시 고친 댓글 ${tag}`);
    await commentOf(page, theirs).getByTestId('comment-reply').click();
    await replyBox.getByTestId('comment-input').fill(`다시 쓴 답글 ${tag}`);
    await page.route(`**/api/v1/posts/${postId}/comments`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      reconsent.on = true;
      await route.fulfill(ONBOARDING_REFUSAL);
    });
    // The page learns of the step from a refused 댓글, as above.
    await composer.getByTestId('comment-input').fill(`또 쓴 댓글 ${tag}`);
    await composer.getByTestId('comment-submit').click();
    await expect(composer.getByTestId('comment-error')).toHaveText(copy.errPostOnboarding);
    await editForm.getByTestId('comment-submit').click();
    await expect(page).toHaveURL(viaStep);
    await expect
      .poll(() => commentDraftsInTab(page))
      .toEqual({
        [`${prefix}:comment@${accountId}`]: `또 쓴 댓글 ${tag}`,
        [`${prefix}:reply:${theirs}@${accountId}`]: `다시 쓴 답글 ${tag}`,
        [`${prefix}:edit:${editable}@${accountId}`]: `다시 고친 댓글 ${tag}`,
      });
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await expect(editForm.getByTestId('comment-input')).toHaveValue(`다시 고친 댓글 ${tag}`);
    await expect(replyBox.getByTestId('comment-input')).toHaveValue(`다시 쓴 답글 ${tag}`);
    await composer.getByTestId('comment-submit').click();
    await expect(composer.getByTestId('comment-error')).toHaveText(copy.errPostOnboarding);
    await replyBox.getByTestId('comment-submit').click();
    await expect(page).toHaveURL(viaStep);
    await expect
      .poll(() => commentDraftsInTab(page))
      .toMatchObject({
        [`${prefix}:reply:${theirs}@${accountId}`]: `다시 쓴 답글 ${tag}`,
      });
    expect(writes).toEqual([]);
    expect(asked).toEqual([]);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('재동의 단계를 지나 돌아오면 처음 50개 밖의 답글에 쓰던 수정은 그 스레드의 남은 답글을 읽어 그 상자에 되살아나고, 그 읽기가 실패하면 그 글자가 읽기 실패의 까닭과 함께 따로 보이다가 답글 더 보기나 새 답글의 이어 읽기가 그 답글을 읽어 오면 그 수정 상자로 가며, 그사이 답글 더 보기로 상자가 먼저 가져갔으면 따로 보이지 않는다', async ({
    admin,
    page,
  }) => {
    // 오너 결정 2026-10-21 (ADR-0074 다섯째 표 답 1): a draft on a reply page not read yet still
    // comes back. The edit's draft is kept with its thread, and the page read afresh after the
    // step — the 51st 답글 not among the first 50 — reads on through that thread alone to find it.
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    // The drafts are kept under each box's item for the account that wrote it (ADR-0092 답 3).
    const accountId = (await meOf(page.request)).id;
    const postId = await postThroughApi(page.request, market.id, `먼 답글의 글 ${tag}`, tag);
    const top = await commentThroughApi(admin, postId, null, `답글 많은 댓글 ${tag}`);
    for (let index = 1; index <= 50; index += 1) {
      await commentThroughApi(admin, postId, top, `답글 ${String(index)} ${tag}`);
    }
    const mine = await commentThroughApi(page.request, postId, top, `내 답글 ${tag}`);
    const postPage = `/community/posts/${postId}`;
    const viaStep = `/onboarding?next=${encodeURIComponent(postPage)}`;
    const reconsent = await asReconsent(page);
    const { asked } = dialogs(page);
    const thread = page.getByTestId(`comment-thread-${top}`);
    const more = thread.getByTestId('comment-replies-more');
    const moreFailed = thread.getByTestId('comment-replies-more-failed');
    const editForm = commentOf(page, mine).getByTestId('comment-edit-form');
    const held = page.getByTestId('comment-held');
    const editPath = `/api/v1/comments/${mine}`;
    const refuseEdit = async (route: Route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      reconsent.on = true;
      await route.fulfill(ONBOARDING_REFUSAL);
    };

    /**
     * The 51st 답글 (the reader's) opened by 답글 더 보기 and edited, its 저장 refused for a consent
     * asked again and then going to that step; at the step, the tab starts afresh (a reload —
     * nothing of the thread held when it comes back). Without it, the comments this tab held are
     * still in its cache (going to the step and back are client navigations, and a query no screen
     * watches stays five minutes): the read again on the way back would read the thread on as far
     * as the screen had it, and the 51st would be there before any read on (ADR-0074 7-28).
     */
    const editThroughStep = async (text: string) => {
      await page.goto(postPage);
      await more.click();
      await commentOf(page, mine).getByTestId('comment-edit').click();
      await editForm.getByTestId('comment-input').fill(text);
      await page.route(`**${editPath}`, refuseEdit);
      await editForm.getByTestId('comment-submit').click();
      await expect(editForm.getByTestId('comment-error')).toHaveText(copy.errPostOnboarding);
      await editForm.getByTestId('comment-submit').click();
      await expect(page).toHaveURL(viaStep);
      await expect(page.getByTestId('consent-step')).toBeVisible();
      // Kept with the thread it is in: the 댓글's, not its own.
      await expect
        .poll(() =>
          commentDraftInTab(page, `buddha.commentDraft:${postId}:edit:${mine}@${accountId}`),
        )
        .toMatchObject({ text, threadId: top });
      await page.reload();
      await expect(page.getByTestId('consent-step')).toBeVisible();
      await page.unroute(`**${editPath}`, refuseEdit);
    };

    // --- back from the step: the page holds the first 50, reads the thread on, and opens the edit.
    await editThroughStep(`고친 먼 답글 ${tag}`);
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await expect(editForm.getByTestId('comment-input')).toHaveValue(`고친 먼 답글 ${tag}`);
    await expect(editForm.getByTestId('comment-draft-restored')).toHaveText(
      copy.commentDraftRestored,
    );
    await expect(held).toHaveCount(0);
    await expect(more).toHaveCount(0);
    expect(await commentDraftsInTab(page)).toEqual({});
    await editForm.getByTestId('comment-submit').click();
    await expect(commentOf(page, mine).getByTestId('comment-body')).toHaveText(
      `고친 먼 답글 ${tag}`,
    );

    // --- the read on fails (오너 결정 2026-10-21 (2차) 답 2): the draft is shown apart with the read's
    // failure as why — at the end of its thread, its 답글 not read — until its 답글 is read.
    await editThroughStep(`또 고친 먼 답글 ${tag}`);
    const replies = (url: URL) => url.pathname === `/api/v1/comments/${top}/replies`;
    await page.route(replies, (route) => route.abort('failed'));
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    // Why, read out: the toast said the text was restored, and no box can take it yet.
    await expect(thread.getByTestId('comment-held')).toHaveCount(1);
    await expect(held.getByRole('alert')).toHaveText(copy.errNetwork);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(`또 고친 먼 답글 ${tag}`);
    await expect(moreFailed).toHaveCount(0);
    await expect(editForm).toHaveCount(0);
    expect(await commentDraftsInTab(page)).toEqual({});
    // 답글 더 보기 reads the rest: its edit opens with the text, as a draft taken back opens — said
    // under it and once in a toast — and the text apart is gone (오너 결정 2026-10-22 (2차) 답 2 —
    // before, the text moved under its 답글 with the same reason and no box opened). Saved, the 답글
    // says it. The toast of the restore after the step goes first (the pointer off the toaster,
    // which holds its toasts while hovered), so the one counted is the press's.
    await page.unroute(replies);
    await page.mouse.move(0, 0);
    await expect(restoredToasts(page)).toHaveCount(0, { timeout: 15_000 });
    await more.click();
    await expect(more).toHaveCount(0);
    await expect(editForm.getByTestId('comment-input')).toHaveValue(`또 고친 먼 답글 ${tag}`);
    await expect(editForm.getByTestId('comment-draft-restored')).toHaveText(
      copy.commentDraftRestored,
    );
    await expect(restoredToasts(page)).toHaveCount(1);
    await expect(held).toHaveCount(0);
    await editForm.getByTestId('comment-submit').click();
    await expect(editForm).toHaveCount(0);
    await expect(commentOf(page, mine).getByTestId('comment-body')).toHaveText(
      `또 고친 먼 답글 ${tag}`,
    );

    // --- the box takes the draft first: 답글 더 보기 pressed while the page's own read on is on its
    // way reads the 51st 답글 and the edit opens with the draft; that read failing after shows
    // nothing apart — the text is in its box, not twice (오너 결정 2026-10-21 (2차) 답 2: only what still
    // waits as the read fails).
    const third = `세 번째로 고친 먼 답글 ${tag}`;
    await editThroughStep(third);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heard!: () => void;
    const pageReadSent = new Promise<void>((resolve) => {
      heard = resolve;
    });
    let replyReads = 0;
    await page.route(replies, async (route) => {
      replyReads += 1;
      if (replyReads > 1) return route.fallback();
      heard();
      await released;
      await route.abort('failed');
    });
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await pageReadSent;
    await more.click();
    await expect(editForm.getByTestId('comment-input')).toHaveValue(third);
    await expect.poll(() => commentDraftsInTab(page)).toEqual({});
    const pageReadFailed = page.waitForEvent('requestfailed', (request) =>
      replies(new URL(request.url())),
    );
    release();
    await pageReadFailed;
    // The page hears the failure (its catch, then a render) well within this before it is looked at.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
    await expect(held).toHaveCount(0);
    await expect(moreFailed).toHaveCount(0);
    await expect(editForm.getByTestId('comment-input')).toHaveValue(third);
    await page.unroute(replies);
    await editForm.getByTestId('comment-submit').click();
    await expect(commentOf(page, mine).getByTestId('comment-body')).toHaveText(third);

    // --- a new 답글's read on brings it (오너 결정 2026-10-22 (3차) 답 1 — any read, not only 답글 더
    // 보기): the read on for the draft fails again and the text is shown apart; the reader writes a
    // 답글 in that thread, whose read of the thread's unread 답글 brings the 51st onto the screen — its
    // edit opens with the text, as a draft taken back opens, and the text apart is gone.
    const fourth = `네 번째로 고친 먼 답글 ${tag}`;
    await editThroughStep(fourth);
    await page.route(replies, (route) => route.abort('failed'));
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await expect(held).toHaveCount(1);
    await expect(held.getByRole('alert')).toHaveText(copy.errNetwork);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(fourth);
    await expect(editForm).toHaveCount(0);
    await page.unroute(replies);
    await commentOf(page, top).getByTestId('comment-reply').click();
    const replyBox = thread.getByTestId('reply-composer');
    await replyBox.getByTestId('comment-input').fill(`새 답글 ${tag}`);
    await replyBox.getByTestId('comment-submit').click();
    await expect(replyBox).toHaveCount(0);
    await expect(more).toHaveCount(0);
    await expect(editForm.getByTestId('comment-input')).toHaveValue(fourth);
    await expect(editForm.getByTestId('comment-draft-restored')).toHaveText(
      copy.commentDraftRestored,
    );
    await expect(held).toHaveCount(0);
    await editForm.getByTestId('comment-submit').click();
    await expect(editForm).toHaveCount(0);
    await expect(commentOf(page, mine).getByTestId('comment-body')).toHaveText(fourth);
    expect(asked).toEqual([]);
  });

  test('답글이 많은 스레드의 이어 읽기는 다섯 페이지까지다: 새 답글은 읽은 답글 끝에 오고 답글 더 보기가 제자리로, 다시 읽기는 처음 50개와 250개까지만, 재동의 단계를 지나 되살린 수정을 찾는 읽기도 그 300개까지라(이미 쥐었으면 읽지 않고, 돌아올 때의 다시 읽기가 닿지 않아도 300개 밖의 상자는 열지 않고 그 답글 아래 다시 열지 못했다는 까닭과 함께 둔다) 다섯째 페이지의 답글은 그 상자가 열리고 그 밖의 것은 그 글자를 까닭과 함께 따로 보이며, 답글 더 보기가 그 답글을 300개 밖으로 읽어 오면 그 아래 다시 열지 못했다는 까닭과 함께, 숨긴 답글이면 그 까닭과, 지운 답글이면 스레드 끝까지 읽은 뒤 없다는 까닭과 함께 남고, 앞선 답글이 지워져 다시 읽기가 그 답글을 300개 안으로 데려오면 그 수정 상자가 그 글자로 열리되, 그 수정 상자를 이미 열어 두었으면 앞선 제 답글을 지워 그 답글이 300개 안으로 와도 그 상자는 제 글자를 지키고 따로 보이던 글자도 남으며 되살렸다는 알림은 없다', async ({
    admin,
    page,
  }) => {
    // 오너 결정 2026-10-21 (2차) 답 1 (ADR-0074): a new 답글's read of its thread's unread 답글,
    // and a read of the pages reading a thread on as far as the screen had it, ask for five reply
    // pages at most — the requests each makes stay bounded however large the thread; and so does
    // the read on for an edit draft taken back after a re-consent step, which never reads past the
    // 300 a read of the pages keeps (오너 결정 2026-10-22 답 5, (2차) 답 1) — and a text it shows
    // apart opens in its edit once a read brings its 답글 within those 300, and stays apart under it
    // with the owner's words when a read brings it past them (오너 결정 2026-10-22 (2차) 답 2, (3차)
    // 답 1·3) — but an edit open there already keeps what it has, the text stays apart, and nothing
    // says it was restored (ADR-0074 7-30 (f)).
    test.slow();
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    // The drafts are kept under each box's item for the account that wrote it (ADR-0092 답 3).
    const accountId = (await meOf(page.request)).id;
    // The reader writes more 댓글·답글 here than one person may in a minute (#187: 5 a minute,
    // WRITE_LIMITED with nothing written, ADR-0083 결정 4): each waits, when it must, until the
    // oldest of the reader's last five has left the minute — counted from when it was sent, a
    // second spare. The bulk is the admin's, which no limit counts.
    const written: number[] = [];
    const paced = async () => {
      const fifthLast = written.at(-5);
      if (fifthLast === undefined) return;
      const wait = fifthLast + 61_000 - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
    };
    const wrote = () => written.push(Date.now());
    const postId = await postThroughApi(page.request, market.id, `아주 긴 스레드 ${tag}`, tag);
    const top = await commentThroughApi(admin, postId, null, `답글 아주 많은 댓글 ${tag}`);
    // 50 shown, 250 the five pages read, and 60 more past them; written ten at a time (their order
    // within ten is the server's, which this test does not read) — but the 300th, the last of the
    // fifth page read on, the 301st, the first past it, and the 302nd are the reader's own, written
    // on their own between the 299 before them and the 58 after.
    const total = 50 + 250 + 60;
    const fifthPageLast = 50 + 250;
    const replies = async (from: number, to: number) => {
      for (let start = from; start <= to; start += 10) {
        await Promise.all(
          Array.from({ length: Math.min(10, to - start + 1) }, (_, index) =>
            commentThroughApi(admin, postId, top, `답글 ${String(start + index)} ${tag}`),
          ),
        );
      }
    };
    await replies(1, fifthPageLast - 1);
    await paced();
    const onFifthPage = await commentThroughApi(
      page.request,
      postId,
      top,
      `내 ${String(fifthPageLast)}번째 답글 ${tag}`,
    );
    wrote();
    const justPastBody = `내 ${String(fifthPageLast + 1)}번째 답글 ${tag}`;
    await paced();
    const justPast = await commentThroughApi(page.request, postId, top, justPastBody);
    wrote();
    await paced();
    const nextPast = await commentThroughApi(
      page.request,
      postId,
      top,
      `내 ${String(fifthPageLast + 2)}번째 답글 ${tag}`,
    );
    wrote();
    await replies(fifthPageLast + 3, total);
    const replyRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === `/api/v1/comments/${top}/replies`) {
        replyRequests.push(request.url());
      }
    });
    const postPage = `/community/posts/${postId}`;
    await page.goto(postPage);
    const thread = page.getByTestId(`comment-thread-${top}`);
    const shown = thread.getByTestId('comment-replies').locator('article');
    const more = thread.getByTestId('comment-replies-more');
    await expect(shown).toHaveCount(50);

    // A 답글 now: five pages read, the end not reached — it stands last of the 50 held.
    await commentOf(page, top).getByTestId('comment-reply').click();
    const replyBox = thread.getByTestId('reply-composer');
    await replyBox.getByTestId('comment-input').fill(`새 답글 ${tag}`);
    await paced();
    await replyBox.getByTestId('comment-submit').click();
    wrote();
    await expect(replyBox).toHaveCount(0);
    await expect(shown).toHaveCount(51);
    await expect(shown.last().getByTestId('comment-body')).toHaveText(`새 답글 ${tag}`);
    await expect(more).toBeVisible();
    expect(replyRequests).toHaveLength(5);
    const mine = await idOf(shown.last());

    // A read of the pages — a new 댓글's — puts it back last of the 50, reading no reply page for
    // it, and the 수정 box open on it stays (오너 결정 2026-10-24: 대댓글도 같은 규칙).
    await commentOf(page, mine).getByTestId('comment-edit').click();
    const mineEdit = commentOf(page, mine).getByTestId('comment-edit-form');
    await expect(mineEdit.getByTestId('comment-input')).toHaveValue(`새 답글 ${tag}`);
    replyRequests.length = 0;
    const firstBox = page.getByTestId('comment-composer');
    await firstBox.getByTestId('comment-input').fill(`다시 읽게 쓴 댓글 ${tag}`);
    await paced();
    await firstBox.getByTestId('comment-submit').click();
    wrote();
    await expect(
      page.getByTestId('comments-list').getByText(`다시 읽게 쓴 댓글 ${tag}`),
    ).toBeVisible();
    await expect(shown).toHaveCount(51);
    expect(await idOf(shown.last())).toBe(mine);
    await expect(mineEdit).toBeVisible();
    expect(replyRequests).toHaveLength(0);
    await mineEdit.getByTestId('comment-cancel').click();
    await expect(mineEdit).toHaveCount(0);

    // 답글 더 보기 to the end brings it into its place, after every older one.
    replyRequests.length = 0;
    for (let pages = 0; pages < 7; pages += 1) {
      await expect(more).toBeEnabled();
      await more.click();
      await expect(shown).toHaveCount(Math.min(51 + 50 * (pages + 1), total + 1));
    }
    await expect(more).toHaveCount(0);
    await expect(shown.last().getByTestId('comment-body')).toHaveText(`새 답글 ${tag}`);
    expect(replyRequests).toHaveLength(7);

    // A read of the pages now — a new 댓글's — reads the thread on five pages, not seven: the
    // first 50 and 250 more, the rest behind 답글 더 보기 again.
    replyRequests.length = 0;
    const box = page.getByTestId('comment-composer');
    await box.getByTestId('comment-input').fill(`새 댓글 ${tag}`);
    await paced();
    await box.getByTestId('comment-submit').click();
    wrote();
    await expect(page.getByTestId('comments-list').getByText(`새 댓글 ${tag}`)).toBeVisible();
    await expect(shown).toHaveCount(300);
    await expect(more).toBeVisible();
    expect(replyRequests).toHaveLength(5);
    const ownTop = await idOf(
      page
        .getByTestId('comments-list')
        .locator('article')
        .filter({ hasText: `새 댓글 ${tag}` }),
    );

    const reconsent = await asReconsent(page);
    const { asked } = dialogs(page);
    /**
     * An edit of the reader's 답글 `id`, refused for a consent asked again and kept through that
     * step. With `reload`, the tab starts afresh at the step: back on the post, nothing of the
     * thread is held and the read on starts from its first 50. Without it, the comments this tab
     * held are still in its cache (a client navigation within five minutes) and the read again on
     * the way back reads the thread on as far as the screen had it, up to 300 — where the read on
     * for the draft reads nothing more (오너 결정 2026-10-22 (2차) 답 1, ADR-0074 7-28).
     */
    const editThroughStep = async (id: string, text: string, { reload = true } = {}) => {
      const form = commentOf(page, id).getByTestId('comment-edit-form');
      await commentOf(page, id).getByTestId('comment-edit').click();
      await form.getByTestId('comment-input').fill(text);
      const editPath = `**/api/v1/comments/${id}`;
      const refuseEdit = async (route: Route) => {
        if (route.request().method() !== 'PUT') return route.fallback();
        reconsent.on = true;
        await route.fulfill(ONBOARDING_REFUSAL);
      };
      await page.route(editPath, refuseEdit);
      await form.getByTestId('comment-submit').click();
      await expect(form.getByTestId('comment-error')).toHaveText(copy.errPostOnboarding);
      await form.getByTestId('comment-submit').click();
      await expect(page).toHaveURL(`/onboarding?next=${encodeURIComponent(postPage)}`);
      await expect(page.getByTestId('consent-step')).toBeVisible();
      await expect
        .poll(() =>
          commentDraftInTab(page, `buddha.commentDraft:${postId}:edit:${id}@${accountId}`),
        )
        .toMatchObject({ text, threadId: top });
      if (reload) {
        await page.reload();
        await expect(page.getByTestId('consent-step')).toBeVisible();
      }
      await page.unroute(editPath, refuseEdit);
      return form;
    };

    // An edit of the reader's 300th 답글 — on the fifth unread reply page: back on the post, the
    // page reads the thread on five reply pages and finds it on the fifth, so its box opens with
    // the draft and nothing is shown apart (오너 결정 2026-10-22 답 5 — judged once that read is
    // over, by the thread it brought).
    const fifthText = `고친 ${String(fifthPageLast)}번째 답글 ${tag}`;
    const fifthForm = await editThroughStep(onFifthPage, fifthText);
    replyRequests.length = 0;
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    const held = thread.getByTestId('comment-held');
    await expect(fifthForm.getByTestId('comment-input')).toHaveValue(fifthText);
    await expect(fifthForm.getByTestId('comment-draft-restored')).toHaveText(
      copy.commentDraftRestored,
    );
    expect(replyRequests).toHaveLength(5);
    await expect(shown).toHaveCount(300);
    expect(await commentDraftsInTab(page)).toEqual({});
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
    await expect(held).toHaveCount(0);
    expect(replyRequests).toHaveLength(5);
    await fifthForm.getByTestId('comment-submit').click();
    await expect(commentOf(page, onFifthPage).getByTestId('comment-body')).toHaveText(fifthText);

    // An edit of the reader's 답글 — the 361st — kept through that step the same way: the page
    // reads the thread on to look for it up to the 300 a read of the pages keeps — five reply pages
    // from its first 50 — no further (오너 결정 2026-10-22 답 5, (2차) 답 1), and shows the text
    // apart — at the end of its thread, with the owner's words (답 3) — until it is closed.
    await more.click();
    await expect(shown).toHaveCount(350);
    await more.click();
    await expect(more).toHaveCount(0);
    const text = `고친 아주 먼 답글 ${tag}`;
    const editForm = await editThroughStep(mine, text);
    replyRequests.length = 0;
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await expect(held).toHaveCount(1);
    await expect(held.getByRole('alert')).toHaveText(copy.errCommentEditNotRead);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(text);
    await expect(editForm).toHaveCount(0);
    // The five pages it read stay, as 답글 더 보기 leaves them; the rest is behind it.
    await expect(shown).toHaveCount(300);
    await expect(more).toBeVisible();
    expect(replyRequests).toHaveLength(5);
    expect(await commentDraftsInTab(page)).toEqual({});
    // Nothing more is read for it, and it stays until it is closed.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
    expect(replyRequests).toHaveLength(5);
    await expect(held).toHaveCount(1);
    // 답글 더 보기 to its 답글 — past the 300: no box opens there, for the next read of the pages
    // would take it away again; the text moves under it with the owner's words, read out as new
    // (오너 결정 2026-10-22 (3차) 답 1·3 — under (2차) 답 2 that box opened, and went with the next
    // read of the pages).
    const heldUnderMine = thread
      .getByTestId('comment-replies')
      .getByRole('listitem')
      .filter({ has: commentOf(page, mine) })
      .getByTestId('comment-held');
    await more.click();
    await expect(shown).toHaveCount(350);
    await expect(held).toHaveCount(1);
    await expect(editForm).toHaveCount(0);
    await more.click();
    await expect(more).toHaveCount(0);
    await expect(heldUnderMine).toHaveCount(1);
    await expect(heldUnderMine.getByRole('alert')).toHaveText(copy.errCommentEditNotReopened);
    await expect(heldUnderMine.getByTestId('comment-held-text')).toHaveValue(text);
    await expect(editForm).toHaveCount(0);
    // The reader opens the edit and puts the text in; the text apart, closed, is gone.
    await commentOf(page, mine).getByTestId('comment-edit').click();
    await editForm.getByTestId('comment-input').fill(text);
    await editForm.getByTestId('comment-submit').click();
    await expect(editForm).toHaveCount(0);
    await expect(commentOf(page, mine).getByTestId('comment-body')).toHaveText(text);
    await heldUnderMine.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(0);

    // Again, this time without starting afresh: the thread held all 361 in this tab, and the read
    // again on the way back brings it to its first 50 and 250 more — 300 already, so the read on for
    // the draft reads nothing more and shows the text apart at once (오너 결정 2026-10-22 (2차) 답 1;
    // before, it read five pages more past them, opened the box on the 361st, and the next read of
    // the pages took that box away again).
    const again = `다시 고친 아주 먼 답글 ${tag}`;
    await editThroughStep(mine, again, { reload: false });
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await expect(held).toHaveCount(1);
    await expect(held.getByRole('alert')).toHaveText(copy.errCommentEditNotRead);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(again);
    await expect(editForm).toHaveCount(0);
    await expect(shown).toHaveCount(300);
    const readOnTheWayBack = replyRequests.length;
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
    // Nothing read past the 300: the pages a read on reads stay, so the thread would hold more.
    expect(replyRequests).toHaveLength(readOnTheWayBack);
    await expect(shown).toHaveCount(300);
    await expect(editForm).toHaveCount(0);
    expect(await commentDraftsInTab(page)).toEqual({});
    // 답글 더 보기 to its 답글, past the 300 again: under it, with the owner's words, no box (3차
    // 답 1·3). Closed, nothing of it is left.
    await more.click();
    await expect(shown).toHaveCount(350);
    await more.click();
    await expect(more).toHaveCount(0);
    await expect(heldUnderMine.getByRole('alert')).toHaveText(copy.errCommentEditNotReopened);
    await expect(heldUnderMine.getByTestId('comment-held-text')).toHaveValue(again);
    await expect(editForm).toHaveCount(0);
    await heldUnderMine.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(0);
    await expect(commentOf(page, mine).getByTestId('comment-body')).toHaveText(text);
    expect(asked).toEqual([]);

    // Once more without starting afresh — the thread at 361 in this tab — but the read again on the
    // way back is held up, and a write cancels it before it lands: the drafts are placed against the
    // pages as the step left them all the same, and the 361st's edit does not open there, past the
    // 300 the next read that lands keeps; its text is shown apart under it with the owner's words
    // (오너 결정 2026-10-22 (2차) 답 1, ADR-0074 7-28 — before, that box opened, and the next read of
    // the pages took it away again, its text apart) — '고치던 답글을 다시 열지 못했습니다. 쓰던 내용을
    // 여기 남겨 둡니다.' (3차 답 3: the 답글 is on screen, so '…아직 불러오지 않은 답글' would not hold).
    const third = `세 번째로 고친 아주 먼 답글 ${tag}`;
    await editThroughStep(mine, third, { reload: false });
    let releasePageReads!: () => void;
    const pageReadsHeld = new Promise<void>((resolve) => {
      releasePageReads = resolve;
    });
    let pageReads = 0;
    const commentPages = (url: URL) => url.pathname === `/api/v1/posts/${postId}/comments`;
    await page.route(commentPages, async (route) => {
      // The pages only: a new comment is a POST to the same path.
      if (route.request().method() !== 'GET') return route.fallback();
      pageReads += 1;
      await pageReadsHeld;
      // Cancelled meanwhile, the request is gone: nothing to let through.
      await route.continue().catch(() => undefined);
    });
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    // The drafts are back (said in a toast) and the read again for them is on its way.
    await expect(restoredToasts(page)).not.toHaveCount(0);
    await expect.poll(() => pageReads).toBeGreaterThan(0);
    await expect(editForm).toHaveCount(0);
    await expect(held).toHaveCount(0);
    // A 답글 to the reader's own 댓글 — nothing unread in its thread, so its write reads no page —
    // lands while that read is on its way, and cancels it (`writePages`).
    await commentOf(page, ownTop).getByTestId('comment-reply').click();
    const ownReplyBox = page.getByTestId(`comment-thread-${ownTop}`).getByTestId('reply-composer');
    await ownReplyBox.getByTestId('comment-input').fill(`내 댓글의 답글 ${tag}`);
    await paced();
    await ownReplyBox.getByTestId('comment-submit').click();
    wrote();
    await expect(ownReplyBox).toHaveCount(0);
    await expect(heldUnderMine).toHaveCount(1);
    await expect(heldUnderMine.getByRole('alert')).toHaveText(copy.errCommentEditNotReopened);
    await expect(heldUnderMine.getByTestId('comment-held-text')).toHaveValue(third);
    await expect(editForm).toHaveCount(0);
    await expect(shown).toHaveCount(total + 1);
    expect(await commentDraftsInTab(page)).toEqual({});
    releasePageReads();
    await page.unroute(commentPages);

    // A read of the pages that lands — a new 댓글's — takes the thread back to 300: the text goes to
    // the thread's end with what it said. 답글 더 보기 then reads the 361st hidden — an operator hid
    // it meanwhile (no hiding before #50: its page is rewritten) — so its edit does not open, and
    // the text stays, under its placeholder now, with why, read out as new; leaving asks first
    // (오너 결정 2026-10-22 (2차) 답 2: «아니면 그 글자를 맞는 까닭과 함께 따로 둔다»).
    await box.getByTestId('comment-input').fill(`또 새 댓글 ${tag}`);
    await paced();
    await box.getByTestId('comment-submit').click();
    wrote();
    await expect(page.getByTestId('comments-list').getByText(`또 새 댓글 ${tag}`)).toBeVisible();
    await expect(shown).toHaveCount(300);
    await expect(heldUnderMine).toHaveCount(0);
    await expect(held).toHaveCount(1);
    await expect(held.getByTestId('comment-held-reason')).toHaveText(
      copy.errCommentEditNotReopened,
    );
    await more.click();
    await expect(shown).toHaveCount(350);
    const repliesOfTop = (url: URL) => url.pathname === `/api/v1/comments/${top}/replies`;
    await page.route(repliesOfTop, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { data: { id: string }[] };
      body.data = body.data.map((reply) =>
        reply.id === mine ? { state: 'hidden', id: mine } : reply,
      );
      await route.fulfill({ response, json: body });
    });
    await more.click();
    await expect(more).toHaveCount(0);
    await expect(commentOf(page, mine)).toHaveAttribute('data-state', 'hidden');
    await expect(heldUnderMine).toHaveCount(1);
    await expect(heldUnderMine.getByRole('alert')).toHaveText(copy.errCommentNotEditable);
    await expect(heldUnderMine.getByTestId('comment-held-text')).toHaveValue(third);
    await expect(page.getByTestId('comment-edit-form')).toHaveCount(0);
    await page.unroute(repliesOfTop);

    // The 361st deleted meanwhile — by its writer, elsewhere: a deleted 답글 is in no page — and a
    // read of the pages that lands (another new 댓글's) takes the thread back to 300: the text goes
    // to the thread's end with what it said, not read out again. 답글 더 보기 to the thread's end
    // then finds nothing of it: the text says it is gone, read out as new where it stands — it did
    // not move (오너 결정 2026-10-22 (2차) 답 2: «맞는 까닭», ADR-0074 7-30 — before, it kept saying
    // why the 답글 was not editable, or that it was not read yet). Leaving asks first while it is
    // shown; closed, leaving asks nothing.
    const me = await meOf(page.request);
    const deleted = await page.request.post(`/api/v1/comments/${mine}/delete`, {
      data: { expectedAccountId: me.id },
    });
    expect(deleted.status(), await deleted.text()).toBe(200);
    await box.getByTestId('comment-input').fill(`셋째 새 댓글 ${tag}`);
    await paced();
    await box.getByTestId('comment-submit').click();
    wrote();
    await expect(page.getByTestId('comments-list').getByText(`셋째 새 댓글 ${tag}`)).toBeVisible();
    await expect(shown).toHaveCount(300);
    await expect(heldUnderMine).toHaveCount(0);
    await expect(held).toHaveCount(1);
    await expect(held.getByTestId('comment-held-reason')).toHaveText(copy.errCommentNotEditable);
    await expect(held.getByRole('alert')).toHaveCount(0);
    await more.click();
    await expect(shown).toHaveCount(350);
    await more.click();
    await expect(more).toHaveCount(0);
    await expect(shown).toHaveCount(total);
    await expect(held.getByRole('alert')).toHaveText(copy.errCommentGone);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(third);
    await expect(page.getByTestId('comment-edit-form')).toHaveCount(0);
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');
    await home.click();
    await expect.poll(() => asked).toEqual([`confirm: ${copy.postLeaveConfirm}`]);
    await expect(held).toHaveCount(1);
    await held.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(0);
    await home.click();
    await expect(page).toHaveURL('/');
    expect(asked).toHaveLength(1);

    // A read of the pages brings a held edit's 답글 within the 300 (오너 결정 2026-10-22 (3차) 답 1):
    // the reader's 301st, opened by 답글 더 보기 past the 300 and edited — the next read of the
    // pages (a new 댓글's) takes the thread back to its 300 and the box with it, its text shown
    // apart at the thread's end as one not among those read (7-30). An earlier 답글 deleted
    // meanwhile, the next read of the pages — another new 댓글's, no 답글 더 보기 — ends with the
    // 301st as the 300th: its edit opens with the text, as a draft taken back opens, and the text
    // apart is gone. 취소 asks first, as for any restored box, and 버리기 leaves nothing. (No
    // re-consent step here: the consent bucket counts five answers a minute an account
    // (`RATE_LIMIT_BUCKETS.consent`), and a step here, after this test's four, was refused 429.)
    await page.goto(postPage);
    for (let count = 100; count <= 350; count += 50) {
      await more.click();
      await expect(shown).toHaveCount(count);
    }
    const pastForm = commentOf(page, justPast).getByTestId('comment-edit-form');
    const pastText = `고친 301번째 답글 ${tag}`;
    await commentOf(page, justPast).getByTestId('comment-edit').click();
    await pastForm.getByTestId('comment-input').fill(pastText);
    await box.getByTestId('comment-input').fill(`넷째 새 댓글 ${tag}`);
    await paced();
    await box.getByTestId('comment-submit').click();
    wrote();
    await expect(page.getByTestId('comments-list').getByText(`넷째 새 댓글 ${tag}`)).toBeVisible();
    await expect(shown).toHaveCount(300);
    await expect(pastForm).toHaveCount(0);
    await expect(commentOf(page, justPast)).toHaveCount(0);
    await expect(held).toHaveCount(1);
    await expect(held.getByTestId('comment-held-reason')).toHaveText(copy.errCommentEditNotRead);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(pastText);
    const firstReply = await idOf(shown.first());
    const adminMe = await meOf(admin);
    const removed = await admin.post(`/api/v1/comments/${firstReply}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(removed.status(), await removed.text()).toBe(200);
    await box.getByTestId('comment-input').fill(`다섯째 새 댓글 ${tag}`);
    await paced();
    await box.getByTestId('comment-submit').click();
    wrote();
    await expect(
      page.getByTestId('comments-list').getByText(`다섯째 새 댓글 ${tag}`),
    ).toBeVisible();
    await expect(commentOf(page, firstReply)).toHaveCount(0);
    await expect(shown).toHaveCount(300);
    await expect(pastForm.getByTestId('comment-input')).toHaveValue(pastText);
    await expect(pastForm.getByTestId('comment-draft-restored')).toHaveText(
      copy.commentDraftRestored,
    );
    await expect(held).toHaveCount(0);
    await pastForm.getByTestId('comment-cancel').click();
    await page.getByTestId('comment-discard-confirm').click();
    await expect(pastForm).toHaveCount(0);
    await expect(commentOf(page, justPast).getByTestId('comment-body')).toHaveText(justPastBody);
    await expect(held).toHaveCount(0);

    // The reader's 302nd, now the first past the 300, the same way — but its edit open when it moves
    // within them. Opened by 답글 더 보기 and edited, the next read of the pages (a new 댓글's) takes
    // the box away and its text apart to the thread's end; 답글 더 보기 brings it back past the 300,
    // the text under it with the owner's words; the reader opens its 수정 — as that text invites —
    // and types in it. The reader then deletes their own 301st, earlier in the thread: nothing is
    // read (`withoutComment`), and the 302nd is the 300th. Its edit keeps what the reader typed, the
    // text apart stays under it, and nothing says it was restored (ADR-0074 7-30 (f) — the toast
    // '쓰던 내용을 되살렸습니다.' said so before, the box keeping its own).
    await more.click();
    await expect(shown).toHaveCount(350);
    const nextForm = commentOf(page, nextPast).getByTestId('comment-edit-form');
    const nextText = `고친 ${String(fifthPageLast + 2)}번째 답글 ${tag}`;
    await commentOf(page, nextPast).getByTestId('comment-edit').click();
    await nextForm.getByTestId('comment-input').fill(nextText);
    await box.getByTestId('comment-input').fill(`여섯째 새 댓글 ${tag}`);
    await paced();
    await box.getByTestId('comment-submit').click();
    wrote();
    await expect(
      page.getByTestId('comments-list').getByText(`여섯째 새 댓글 ${tag}`),
    ).toBeVisible();
    await expect(shown).toHaveCount(300);
    await expect(nextForm).toHaveCount(0);
    await expect(held).toHaveCount(1);
    await expect(held.getByTestId('comment-held-reason')).toHaveText(copy.errCommentEditNotRead);
    const heldUnderNext = thread
      .getByTestId('comment-replies')
      .getByRole('listitem')
      .filter({ has: commentOf(page, nextPast) })
      .getByTestId('comment-held');
    await more.click();
    await expect(shown).toHaveCount(350);
    await expect(heldUnderNext.getByRole('alert')).toHaveText(copy.errCommentEditNotReopened);
    await expect(heldUnderNext.getByTestId('comment-held-text')).toHaveValue(nextText);
    await expect(nextForm).toHaveCount(0);
    const typed = `손으로 ${nextText}`;
    await commentOf(page, nextPast).getByTestId('comment-edit').click();
    await nextForm.getByTestId('comment-input').fill(typed);
    // The toast of the box restored above goes first (the pointer off the toaster, which holds its
    // toasts while hovered), so none is left to be mistaken for one this deletion raises.
    await page.mouse.move(0, 0);
    await expect(restoredToasts(page)).toHaveCount(0, { timeout: 15_000 });
    await commentOf(page, justPast).getByTestId('comment-delete').click();
    await page.getByTestId('comment-delete-confirm').click();
    await expect(commentOf(page, justPast)).toHaveCount(0);
    await expect(shown).toHaveCount(349);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
    // Counted once, not waited for: a toast raised would still be there, and a wait could see it go.
    expect(await restoredToasts(page).count()).toBe(0);
    await expect(nextForm.getByTestId('comment-input')).toHaveValue(typed);
    await expect(nextForm.getByTestId('comment-draft-restored')).toHaveCount(0);
    await expect(heldUnderNext).toHaveCount(1);
    await expect(heldUnderNext.getByTestId('comment-held-text')).toHaveValue(nextText);
    // 취소 asks (the text changed); 버리기 closes the box, and the text apart stays until closed.
    await nextForm.getByTestId('comment-cancel').click();
    await page.getByTestId('comment-discard-confirm').click();
    await expect(nextForm).toHaveCount(0);
    await expect(heldUnderNext).toHaveCount(1);
    await heldUnderNext.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(0);
    expect(asked).toHaveLength(1);
  });

  test('답글을 연 스레드가 많으면 다시 읽기 한 번은 답글 페이지를 모두 합쳐 30번까지 읽는다: 위의 스레드부터 다섯 페이지씩, 그 밖의 스레드는 처음 50개와 답글 더 보기로 돌아오고, 다음 다시 읽기도 그 30번이다', async ({
    admin,
    page,
  }) => {
    // 오너 결정 2026-10-23 (ADR-0074 7-28): five reply pages a thread as before, and 30 in all for
    // one read of the pages, the threads at the top first — six threads opened to their 300 spend
    // them, and the seventh, opened to its 100, comes back to its first 50 behind 답글 더 보기.
    // Before it, one read of a page of threads opened past 300 asked for five reply pages each — 20
    // such threads, 100 requests, past the reader's address limit (Codex review on PR #220).
    test.slow();
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const postId = await postThroughApi(page.request, market.id, `답글을 연 스레드 ${tag}`, tag);
    const sizes = [300, 300, 300, 300, 300, 300, 100];
    const tops: string[] = [];
    for (let index = 0; index < sizes.length; index += 1) {
      tops.push(await commentThroughApi(admin, postId, null, `스레드 ${String(index + 1)} ${tag}`));
    }
    // The 답글 straight at the API, the threads side by side and ten at a time in each (their order
    // is the server's, which this test does not read).
    const { id: adminId } = await meOf(admin);
    await Promise.all(
      tops.map(async (top, index) => {
        const size = sizes[index]!;
        for (let start = 1; start <= size; start += 10) {
          await Promise.all(
            Array.from({ length: Math.min(10, size - start + 1) }, async (_, offset) => {
              const res = await admin.post(`/api/v1/posts/${postId}/comments`, {
                data: {
                  parentId: top,
                  body: `답글 ${String(start + offset)} ${tag}`,
                  expectedAccountId: adminId,
                },
              });
              expect(res.status(), await res.text()).toBe(201);
            }),
          );
        }
      }),
    );
    const replyRequests: string[] = [];
    page.on('request', (request) => {
      if (/^\/api\/v1\/comments\/[0-9a-f-]{36}\/replies$/.test(new URL(request.url()).pathname)) {
        replyRequests.push(request.url());
      }
    });
    await page.goto(`/community/posts/${postId}`);
    const shownIn = (top: string) =>
      page.getByTestId(`comment-thread-${top}`).getByTestId('comment-replies').locator('article');
    const moreIn = (top: string) =>
      page.getByTestId(`comment-thread-${top}`).getByTestId('comment-replies-more');
    // Every thread opened to its end with 답글 더 보기: five presses each for the six, one for the
    // seventh.
    for (const [index, top] of tops.entries()) {
      const size = sizes[index]!;
      await expect(shownIn(top)).toHaveCount(50);
      for (let shown = 50; shown < size; shown += 50) {
        await expect(moreIn(top)).toBeEnabled();
        await moreIn(top).click();
        await expect(shownIn(top)).toHaveCount(Math.min(shown + 50, size));
      }
      await expect(moreIn(top)).toHaveCount(0);
    }
    expect(replyRequests).toHaveLength(6 * 5 + 1);

    // A read of the pages — a new 댓글's: the six threads at the top read on to their 300, five
    // reply pages each, 30 in all; nothing is left for the seventh, back to its first 50.
    const box = page.getByTestId('comment-composer');
    // The write's read draws the thread again — some 1,900 comments, each with its 신고 (#50,
    // ADR-0081): alone, from the answer to the post read again, about 3.2 s against 2.5 s without
    // them, and with the e2e workers side by side past the default 15 seconds (ADR-0081 결과 5,
    // 다시 쌓기(2026-10-24) (7)).
    const readAgain = async (text: string) => {
      replyRequests.length = 0;
      await box.getByTestId('comment-input').fill(text);
      await box.getByTestId('comment-submit').click();
      await expect(page.getByTestId('comments-list').getByText(text)).toBeVisible({
        timeout: 45_000,
      });
    };
    await readAgain(`새 댓글 ${tag}`);
    await expect(shownIn(tops[6]!)).toHaveCount(50);
    await expect(moreIn(tops[6]!)).toBeVisible();
    for (const top of tops.slice(0, 6)) {
      await expect(shownIn(top)).toHaveCount(300);
      await expect(moreIn(top)).toHaveCount(0);
    }
    expect(replyRequests).toHaveLength(30);

    // 답글 더 보기 opens it again; the next read of the pages has its own 30, the same way.
    replyRequests.length = 0;
    await moreIn(tops[6]!).click();
    await expect(shownIn(tops[6]!)).toHaveCount(100);
    await expect(moreIn(tops[6]!)).toHaveCount(0);
    expect(replyRequests).toHaveLength(1);
    await readAgain(`또 새 댓글 ${tag}`);
    await expect(shownIn(tops[6]!)).toHaveCount(50);
    await expect(moreIn(tops[6]!)).toBeVisible();
    await expect(shownIn(tops[5]!)).toHaveCount(300);
    expect(replyRequests).toHaveLength(30);
  });

  test('긴 글의 첫 페이지에서 쓴 새 댓글이 다섯 페이지 안에서 제자리에 닿지 못하면 열린 목록의 끝에 서고, 목록을 다시 읽어도 요청을 늘리지 않고 그 끝에 다시 서며 그 위에 열어 둔 답글 상자도 남고, 더 보기가 그 댓글이 든 페이지를 가져오면 그 뒤에 쓰인 댓글 앞의 제자리로 간다', async ({
    admin,
    page,
  }) => {
    // 오너 결정 2026-10-24 (ADR-0074 결정 1의 열두째 표 답 1): «제자리가 읽힐 때까지 끝에 남김:
    // 다시 읽을 때마다 그 댓글을 열린 목록의 끝에 다시 넣고 그 위의 상자도 남김(요청은 늘지 않음)».
    test.slow();
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const adminMe = await meOf(admin);
    const postId = await postThroughApi(admin, market.id, `댓글 아주 많은 글 ${tag}`, tag);
    // 125 댓글 before the reader's: seven pages of 20, and the five pages a new 댓글's read reads
    // (COMMENT_READ_ON_PAGES) end at the 100th. Written ten at a time (their order within ten is
    // the server's, which this test does not read).
    const older = 125;
    for (let start = 1; start <= older; start += 10) {
      await Promise.all(
        Array.from({ length: Math.min(10, older - start + 1) }, (_, index) =>
          commentThroughApi(admin, postId, null, `앞선 댓글 ${String(start + index)} ${tag}`),
        ),
      );
    }
    // The comment pages asked for, and those still on their way.
    const pageRequests: string[] = [];
    let pagesInFlight = 0;
    const isPageRead = (request: { method: () => string; url: () => string }) =>
      request.method() === 'GET' &&
      new URL(request.url()).pathname === `/api/v1/posts/${postId}/comments`;
    page.on('request', (request) => {
      if (!isPageRead(request)) return;
      pageRequests.push(request.url());
      pagesInFlight += 1;
    });
    const pageReadOver = (request: { method: () => string; url: () => string }) => {
      if (isPageRead(request)) pagesInFlight -= 1;
    };
    page.on('requestfinished', pageReadOver);
    page.on('requestfailed', pageReadOver);
    await page.goto(`/community/posts/${postId}`);
    const threads = page.getByTestId('comments-list').locator(':scope > li');
    const more = page.getByTestId('comments-more');
    const threadIds = () =>
      threads.evaluateAll((items) =>
        items.map((item) =>
          (item.getAttribute('data-testid') ?? '').replace(/^comment-thread-/, ''),
        ),
      );
    await expect(threads).toHaveCount(20);
    await expect(more).toBeVisible();

    // The reader's 댓글 from the first page: the page read again and four after it, its place on
    // none of them — it stands at the end of the 20, and 더 보기 is still there. Counted from once
    // the first page's reads are over (React's strict mode in the dev server mounts the section
    // twice, and the first page is asked for twice).
    await expect.poll(() => pagesInFlight).toBe(0);
    pageRequests.length = 0;
    const composer = page.getByTestId('comment-composer');
    await composer.getByTestId('comment-input').fill(`내 새 댓글 ${tag}`);
    await composer.getByTestId('comment-submit').click();
    await expect(composer.getByTestId('comment-input')).toHaveValue('');
    await expect(threads).toHaveCount(21);
    await expect(threads.last().getByTestId('comment-body').first()).toHaveText(
      `내 새 댓글 ${tag}`,
    );
    const mine = (await threadIds()).at(-1)!;
    expect(pageRequests).toHaveLength(5);
    await expect(more).toBeVisible();
    // A 답글 box open on it, with text.
    await commentOf(page, mine).getByTestId('comment-reply').click();
    const mineBox = page.getByTestId(`comment-thread-${mine}`).getByTestId('reply-composer');
    await mineBox.getByTestId('comment-input').fill(`내 댓글에 쓰던 답글 ${tag}`);

    // A read of the pages: a 답글 refused because its 댓글 on the first page was deleted meanwhile
    // reads the post and its comments again — the one page held, and nothing for the reader's.
    const first = (await threadIds())[0]!;
    await commentOf(page, first).getByTestId('comment-reply').click();
    const firstBox = page.getByTestId(`comment-thread-${first}`).getByTestId('reply-composer');
    await firstBox.getByTestId('comment-input').fill(`지워진 댓글에 단 답글 ${tag}`);
    const gone = await admin.post(`/api/v1/comments/${first}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(gone.status(), await gone.text()).toBe(200);
    pageRequests.length = 0;
    await firstBox.getByTestId('comment-submit').click();
    await expect(page.getByTestId(`comment-thread-${first}`)).toHaveCount(0);
    await expect(page.getByTestId('comment-held')).toHaveCount(1);
    await expect(page.getByTestId('comment-held-reason')).toHaveText(copy.errCommentParentGone);
    await expect.poll(() => pageRequests.length).toBe(1);
    // The reader's 댓글 is back at the end of the page read again, its 답글 box as it was.
    await expect(threads).toHaveCount(21);
    expect((await threadIds()).at(-1)).toBe(mine);
    await expect(mineBox.getByTestId('comment-input')).toHaveValue(`내 댓글에 쓰던 답글 ${tag}`);

    // Others write after it. 더 보기 brings 20 older 댓글 a press, the reader's still at the end,
    // until the page that holds it: there it stands in its place, before those written after it,
    // drawn once — its box still open.
    const later = [
      await commentThroughApi(admin, postId, null, `나중 댓글 1 ${tag}`),
      await commentThroughApi(admin, postId, null, `나중 댓글 2 ${tag}`),
    ];
    for (let pages = 2; pages <= 6; pages += 1) {
      await more.click();
      await expect(threads).toHaveCount(20 * pages + 1);
      expect((await threadIds()).at(-1)).toBe(mine);
    }
    await more.click();
    await expect(threads).toHaveCount(older - 1 + 1 + later.length);
    await expect(more).toHaveCount(0);
    const ids = await threadIds();
    expect(ids.slice(-3)).toEqual([mine, ...later]);
    expect(ids.filter((id) => id === mine)).toHaveLength(1);
    await expect(mineBox.getByTestId('comment-input')).toHaveValue(`내 댓글에 쓰던 답글 ${tag}`);
  });

  test('쓰는 사이 그 댓글이 지워져 답글과 수정이 거절되면 상자가 사라져도 거절의 까닭과 쓰던 글자가 닫을 때까지 남는다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    // The drafts are kept under each box's item for the account that wrote it (ADR-0092 답 3).
    const accountId = (await meOf(page.request)).id;
    const me = await meOf(page.request);
    const adminMe = await meOf(admin);
    const postId = await postThroughApi(page.request, market.id, `거절될 글 ${tag}`, tag);
    const theirs = await commentThroughApi(admin, postId, null, `곧 지워질 댓글 ${tag}`);
    const mine = await commentThroughApi(page.request, postId, null, `곧 지울 내 댓글 ${tag}`);
    const other = await commentThroughApi(admin, postId, null, `또 지워질 댓글 ${tag}`);
    const kept = await commentThroughApi(admin, postId, null, `남는 댓글 ${tag}`);
    const postPage = `/community/posts/${postId}`;
    await page.goto(postPage);
    const { asked, answers } = dialogs(page);
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');
    const held = page.getByTestId('comment-held');

    // --- a 답글 to a 댓글 its author deletes meanwhile: with nothing under it, it leaves the view,
    // and the thread read again holds neither it nor the box (오너 결정 2026-10-20 답 4).
    await commentOf(page, theirs).getByTestId('comment-reply').click();
    const replyBox = page.getByTestId(`comment-thread-${theirs}`).getByTestId('reply-composer');
    await replyBox.getByTestId('comment-input').fill(`보내지 못한 답글 ${tag}\n둘째 줄`);
    const gone = await admin.post(`/api/v1/comments/${theirs}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(gone.status(), await gone.text()).toBe(200);
    await replyBox.getByTestId('comment-submit').click();
    await expect(page.getByTestId(`comment-thread-${theirs}`)).toHaveCount(0);
    await expect(held).toHaveCount(1);
    await expect(held.getByTestId('comment-held-reason')).toHaveText(copy.errCommentParentGone);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(
      `보내지 못한 답글 ${tag}\n둘째 줄`,
    );
    // The focus the box held comes here, named by why (and so not an alert besides).
    await expect(held).toBeFocused();
    await expect(held).toHaveAccessibleName(copy.errCommentParentGone);
    await expect(held.getByRole('alert')).toHaveCount(0);

    // --- an edit of a comment deleted meanwhile (another tab of the same account).
    await commentOf(page, mine).getByTestId('comment-edit').click();
    const editForm = commentOf(page, mine).getByTestId('comment-edit-form');
    await editForm.getByTestId('comment-input').fill(`보내지 못한 수정 ${tag}`);
    const deleted = await page.request.post(`/api/v1/comments/${mine}/delete`, {
      data: { expectedAccountId: me.id },
    });
    expect(deleted.status(), await deleted.text()).toBe(200);
    await editForm.getByTestId('comment-submit').click();
    await expect(commentOf(page, mine)).toHaveCount(0);
    await expect(held).toHaveCount(2);
    await expect(held.nth(1).getByTestId('comment-held-reason')).toHaveText(copy.errCommentGone);
    await expect(held.nth(1).getByTestId('comment-held-text')).toHaveValue(
      `보내지 못한 수정 ${tag}`,
    );

    // --- a 답글 whose box goes while the reader is in another box: the text stays, the focus
    // where the reader put it, and why is read out as an alert.
    await commentOf(page, other).getByTestId('comment-reply').click();
    const otherBox = page.getByTestId(`comment-thread-${other}`).getByTestId('reply-composer');
    await otherBox.getByTestId('comment-input').fill(`딴 상자에 있던 답글 ${tag}`);
    const otherGone = await admin.post(`/api/v1/comments/${other}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(otherGone.status(), await otherGone.text()).toBe(200);
    let release = () => {};
    const sending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/v1/posts/${postId}/comments`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await sending;
      await route.continue();
    });
    await otherBox.getByTestId('comment-submit').click();
    await expect(otherBox.getByTestId('comment-input')).toBeDisabled();
    const newInput = page.getByTestId('comment-composer').getByTestId('comment-input');
    await newInput.focus();
    release();
    await expect(held).toHaveCount(3);
    await expect(held.nth(2).getByRole('alert')).toHaveText(copy.errCommentParentGone);
    await expect(held.nth(2).getByTestId('comment-held-text')).toHaveValue(
      `딴 상자에 있던 답글 ${tag}`,
    );
    await expect(newInput).toBeFocused();
    await page.unroute(`**/api/v1/posts/${postId}/comments`);

    // --- a refusal that leaves the box where it is (a limit): 취소 — asked first, its text changed
    // (오너 결정 2026-10-21 답 3) — and 버리기 close it holding nothing.
    await page.route(`**/api/v1/posts/${postId}/comments`, (route) =>
      route.request().method() === 'POST' ? route.fulfill(RATE_LIMIT_REFUSAL) : route.fallback(),
    );
    await commentOf(page, kept).getByTestId('comment-reply').click();
    const keptBox = page.getByTestId(`comment-thread-${kept}`).getByTestId('reply-composer');
    await keptBox.getByTestId('comment-input').fill(`한도에 걸린 답글 ${tag}`);
    await keptBox.getByTestId('comment-submit').click();
    await expect(keptBox.getByTestId('comment-error')).toBeVisible();
    await keptBox.getByTestId('comment-cancel').click();
    await page.getByTestId('comment-discard-confirm').click();
    await expect(keptBox).toHaveCount(0);
    await expect(held).toHaveCount(3);
    await page.unroute(`**/api/v1/posts/${postId}/comments`);

    // --- a re-consent asked for meanwhile, learnt from a refused 댓글: 답글 goes to the step, asking
    // nothing, and the texts shown apart go with the boxes' texts into the tab, each as the draft
    // of the box it stood for (답 2·4) — and are shown apart again, with why, once the step is done.
    const reconsent = await asReconsent(page);
    await page.route(`**/api/v1/posts/${postId}/comments`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      reconsent.on = true;
      await route.fulfill(ONBOARDING_REFUSAL);
    });
    await newInput.fill(`단계 앞의 댓글 ${tag}`);
    const composer = page.getByTestId('comment-composer');
    await composer.getByTestId('comment-submit').click();
    await expect(composer.getByTestId('comment-error')).toHaveText(copy.errPostOnboarding);
    await commentOf(page, kept).getByTestId('comment-reply').click();
    await expect(page).toHaveURL(`/onboarding?next=${encodeURIComponent(postPage)}`);
    const prefix = `buddha.commentDraft:${postId}`;
    await expect
      .poll(() => commentDraftsInTab(page))
      .toEqual({
        [`${prefix}:comment@${accountId}`]: `단계 앞의 댓글 ${tag}`,
        [`${prefix}:reply:${theirs}@${accountId}`]: `보내지 못한 답글 ${tag}\n둘째 줄`,
        [`${prefix}:edit:${mine}@${accountId}`]: `보내지 못한 수정 ${tag}`,
        [`${prefix}:reply:${other}@${accountId}`]: `딴 상자에 있던 답글 ${tag}`,
      });
    await page.unroute(`**/api/v1/posts/${postId}/comments`);
    await agreeAgain(page);
    await expect(page).toHaveURL(postPage);
    await expect(newInput).toHaveValue(`단계 앞의 댓글 ${tag}`);
    await expect(held).toHaveCount(3);
    // Their boxes cannot open: each is apart with why, read out as an alert (no box here held it).
    await expect(held.getByRole('alert')).toHaveCount(3);
    const shown = await held.evaluateAll((texts) =>
      texts.map((text) => [
        text.querySelector('[data-testid="comment-held-reason"]')?.textContent,
        text.querySelector('textarea')?.value,
      ]),
    );
    expect(shown.map((pair) => pair.join(' | ')).sort()).toEqual(
      [
        `${copy.errCommentParentGone} | 보내지 못한 답글 ${tag}\n둘째 줄`,
        `${copy.errCommentGone} | 보내지 못한 수정 ${tag}`,
        `${copy.errCommentParentGone} | 딴 상자에 있던 답글 ${tag}`,
      ].sort(),
    );
    expect(await commentDraftsInTab(page)).toEqual({});
    expect(asked).toEqual([]);
    await newInput.fill('');

    // --- leaving while they are shown asks first; staying keeps them.
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([`confirm: ${copy.postLeaveConfirm}`]);
    await expect(held).toHaveCount(3);

    // --- closed, they are gone — the focus on the comments' heading — and leaving asks nothing.
    await held.nth(0).getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(2);
    await expect(page.getByTestId('comments-heading')).toBeFocused();
    await held.nth(0).getByTestId('comment-held-close').click();
    await held.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(0);
    await home.click();
    await expect(page).toHaveURL('/');
    expect(asked).toHaveLength(1);
  });

  test('쓰는 사이 글이 지워져 새 댓글이 거절되면 목록 아래에 까닭과 글자가 남고, 열어 둔 수정 상자는 그대로 저장된다', async ({
    admin,
    page,
  }) => {
    // The post turns into its placeholder under the open page — read again after the refusal —
    // and the comment section stays the same one: the refused 댓글's text is kept (오너 결정
    // 2026-10-20 답 4) and the edit open beside it too, an author editing under a deleted post (7-6).
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const adminMe = await meOf(admin);
    const postId = await postThroughApi(admin, market.id, `곧 지워질 글 ${tag}`, tag);
    const mine = await commentThroughApi(page.request, postId, null, `내 댓글 ${tag}`);
    await page.goto(`/community/posts/${postId}`);
    const section = await page.getByTestId('post-comments').elementHandle();
    const held = page.getByTestId('comment-held');

    const composer = page.getByTestId('comment-composer');
    await composer.getByTestId('comment-input').fill(`보내지 못한 댓글 ${tag}\n둘째 줄`);
    await commentOf(page, mine).getByTestId('comment-edit').click();
    const editForm = commentOf(page, mine).getByTestId('comment-edit-form');
    await editForm.getByTestId('comment-input').fill(`고친 댓글 ${tag}`);

    // Its author deletes the post meanwhile: a comment hangs under it, so it is '삭제된 글입니다'.
    const deletion = await admin.post(`/api/v1/posts/${postId}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(deletion.status(), await deletion.text()).toBe(200);
    await composer.getByTestId('comment-submit').click();
    await expect(page.getByTestId('post-deleted')).toContainText(copy.postDeletedPlaceholder);
    await expect(page.getByTestId('comments-closed')).toHaveText(copy.commentClosedPostDeleted);
    await expect(composer).toHaveCount(0);
    await expect(held).toHaveCount(1);
    await expect(held.getByTestId('comment-held-reason')).toHaveText(copy.commentClosedPostDeleted);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(
      `보내지 못한 댓글 ${tag}\n둘째 줄`,
    );
    await expect(held).toBeFocused();
    // Not drawn afresh: the section the page had.
    expect(await section?.evaluate((element) => element.isConnected)).toBe(true);

    // The open edit, still open with its text, saves.
    await expect(editForm.getByTestId('comment-input')).toHaveValue(`고친 댓글 ${tag}`);
    await editForm.getByTestId('comment-submit').click();
    await expect(commentOf(page, mine).getByTestId('comment-body')).toHaveText(`고친 댓글 ${tag}`);
    await expect(commentOf(page, mine).getByTestId('post-edited')).toHaveText(copy.postEdited);

    await held.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(0);
  });

  test('보내지 않은 상자가 다시 읽기로 사라지면 그 자리가 받지 않는 까닭과 쓰던 글자가 닫을 때까지 남는다', async ({
    admin,
    page,
  }) => {
    // 오너 결정 2026-10-21 답 2: a box with text and no write, gone because its place changed under
    // it — the writer's own 댓글 deleted under an open 답글, another's 댓글 and the writer's own
    // comment deleted elsewhere and the thread read again after a new 댓글, the post deleted and
    // read again after a deletion — keeps its text with why, as a refused write's does (2026-10-20
    // 답 4).
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const adminMe = await meOf(admin);
    const postId = await postThroughApi(admin, market.id, `다시 읽힐 글 ${tag}`, tag);
    const mine = await commentThroughApi(page.request, postId, null, `곧 지울 내 댓글 ${tag}`);
    const theirs = await commentThroughApi(admin, postId, null, `곧 지워질 댓글 ${tag}`);
    const edited = await commentThroughApi(
      page.request,
      postId,
      null,
      `딴 탭에서 지울 댓글 ${tag}`,
    );
    const spare = await commentThroughApi(page.request, postId, null, `나중에 지울 댓글 ${tag}`);
    const postPage = `/community/posts/${postId}`;
    await page.goto(postPage);
    const { asked, answers } = dialogs(page);
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');
    const held = page.getByTestId('comment-held');
    const shownHeld = async () =>
      (
        await held.evaluateAll((texts) =>
          texts.map((text) =>
            [
              text.querySelector('[data-testid="comment-held-reason"]')?.textContent,
              text.querySelector('textarea')?.value,
            ].join(' | '),
          ),
        )
      ).sort();

    // --- a 답글 under the writer's own 댓글, which the writer deletes: with nothing under it, the
    // 댓글 leaves the view and the box with it. The focus was in the dialog, not the box: why is
    // read out as an alert.
    await commentOf(page, mine).getByTestId('comment-reply').click();
    const mineBox = page.getByTestId(`comment-thread-${mine}`).getByTestId('reply-composer');
    await mineBox.getByTestId('comment-input').fill(`내 댓글에 쓰던 답글 ${tag}\n둘째 줄`);
    await commentOf(page, mine).getByTestId('comment-delete').click();
    await page.getByTestId('comment-delete-confirm').click();
    await expect(page.getByText(copy.commentDeletedToast)).toBeVisible();
    await expect(page.getByTestId(`comment-thread-${mine}`)).toHaveCount(0);
    await expect(held).toHaveCount(1);
    await expect(held.getByRole('alert')).toHaveText(copy.errCommentParentGone);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(
      `내 댓글에 쓰던 답글 ${tag}\n둘째 줄`,
    );
    await expect(held).not.toBeFocused();

    // --- a 답글 to another's 댓글 and an edit of the writer's own, each deleted elsewhere: the
    // thread read again after a new 댓글 (its page read on to the end, ADR-0074 7-14) holds
    // neither.
    await commentOf(page, theirs).getByTestId('comment-reply').click();
    const theirBox = page.getByTestId(`comment-thread-${theirs}`).getByTestId('reply-composer');
    await theirBox.getByTestId('comment-input').fill(`남의 댓글에 쓰던 답글 ${tag}`);
    await commentOf(page, edited).getByTestId('comment-edit').click();
    const editForm = commentOf(page, edited).getByTestId('comment-edit-form');
    await editForm.getByTestId('comment-input').fill(`고치던 댓글 ${tag}`);
    const theirsGone = await admin.post(`/api/v1/comments/${theirs}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(theirsGone.status(), await theirsGone.text()).toBe(200);
    const editedGone = await page.request.post(`/api/v1/comments/${edited}/delete`, {
      data: { expectedAccountId: me.id },
    });
    expect(editedGone.status(), await editedGone.text()).toBe(200);
    const composer = page.getByTestId('comment-composer');
    const newInput = composer.getByTestId('comment-input');
    await newInput.fill(`새 댓글 ${tag}`);
    await composer.getByTestId('comment-submit').click();
    await expect(newInput).toHaveValue('');
    await expect(page.getByTestId(`comment-thread-${theirs}`)).toHaveCount(0);
    await expect(commentOf(page, edited)).toHaveCount(0);
    await expect(held).toHaveCount(3);
    expect(await shownHeld()).toEqual(
      [
        `${copy.errCommentParentGone} | 내 댓글에 쓰던 답글 ${tag}\n둘째 줄`,
        `${copy.errCommentParentGone} | 남의 댓글에 쓰던 답글 ${tag}`,
        `${copy.errCommentGone} | 고치던 댓글 ${tag}`,
      ].sort(),
    );
    // None of those boxes held the focus as it went: each reason is an alert.
    await expect(held.getByRole('alert')).toHaveCount(3);

    // --- the new 댓글's box, the post deleted meanwhile (comments hang under it: '삭제된 글입니다')
    // and read again after the writer deletes a comment.
    await newInput.fill(`닫힌 글에 쓰던 댓글 ${tag}`);
    const postGone = await admin.post(`/api/v1/posts/${postId}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(postGone.status(), await postGone.text()).toBe(200);
    await commentOf(page, spare).getByTestId('comment-delete').click();
    await page.getByTestId('comment-delete-confirm').click();
    await expect(page.getByTestId('post-deleted')).toContainText(copy.postDeletedPlaceholder);
    await expect(page.getByTestId('comments-closed')).toHaveText(copy.commentClosedPostDeleted);
    await expect(composer).toHaveCount(0);
    await expect(held).toHaveCount(4);
    expect(await shownHeld()).toContain(
      `${copy.commentClosedPostDeleted} | 닫힌 글에 쓰던 댓글 ${tag}`,
    );

    // --- leaving while they are shown asks first; closed, they are gone and leaving asks nothing.
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([`confirm: ${copy.postLeaveConfirm}`]);
    await expect(held).toHaveCount(4);
    for (const left of [3, 2, 1, 0]) {
      await held.first().getByTestId('comment-held-close').click();
      await expect(held).toHaveCount(left);
    }
    await home.click();
    await expect(page).toHaveURL('/');
    expect(asked).toHaveLength(1);
  });

  test('다시 읽기가 상자를 거두거나 실패해도 쓰던 글자는 남는다: 취소의 확인 창이 열린 채 거둔 상자는 초점을 남긴 글자로 넘기고, 내 정보를 다시 읽지 못해도 새 댓글 상자는 그대로다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const adminMe = await meOf(admin);
    const postId = await postThroughApi(admin, market.id, `다시 읽기의 글 ${tag}`, tag);
    const theirs = await commentThroughApi(admin, postId, null, `곧 지워질 댓글 ${tag}`);
    await page.goto(`/community/posts/${postId}`);
    const held = page.getByTestId('comment-held');
    const composer = page.getByTestId('comment-composer');
    const newInput = composer.getByTestId('comment-input');
    const comments = `**/api/v1/posts/${postId}/comments`;

    // --- a 답글 whose 취소 is asking (its dialog, in a portal, has the focus) when a read takes the
    // box away — the 댓글 deleted elsewhere, its thread read again after a new 댓글 lands (7-14):
    // the dialog goes with the box, and the focus the box held — in its own dialog — goes to the
    // text it left, named by why (ADR-0074 7-25), not to the page's start.
    await commentOf(page, theirs).getByTestId('comment-reply').click();
    const replyBox = page.getByTestId(`comment-thread-${theirs}`).getByTestId('reply-composer');
    await replyBox.getByTestId('comment-input').fill(`창이 열린 채 거둔 답글 ${tag}`);
    let release = () => {};
    const sending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(comments, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await sending;
      await route.continue();
    });
    await newInput.fill(`새 댓글 ${tag}`);
    await composer.getByTestId('comment-submit').click();
    await expect(newInput).toBeDisabled();
    await replyBox.getByTestId('comment-cancel').click();
    await expect(page.getByTestId('comment-discard-cancel')).toBeFocused();
    const gone = await admin.post(`/api/v1/comments/${theirs}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(gone.status(), await gone.text()).toBe(200);
    release();
    await expect(page.getByTestId(`comment-thread-${theirs}`)).toHaveCount(0);
    await expect(page.getByTestId('comment-discard-dialog')).toHaveCount(0);
    await expect(held).toHaveCount(1);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(
      `창이 열린 채 거둔 답글 ${tag}`,
    );
    await expect(held).toBeFocused();
    await expect(held).toHaveAccessibleName(copy.errCommentParentGone);
    await expect(held.getByRole('alert')).toHaveCount(0);
    await page.unroute(comments);
    await held.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(0);
    await expect(page.getByTestId('comments-heading')).toBeFocused();

    // --- `GET /me` read again and failing (after its retries) while the account it named is
    // still held: the new 댓글's box stays with its text, as the 답글 and 수정 boxes do — it does
    // not turn into '내 정보를 불러오지 못했습니다.' and come back empty (2026-10-21 답 2). A refusal
    // for the onboarding is what reads it again here.
    let meReads = 0;
    await page.route('**/api/v1/me', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      meReads += 1;
      await route.fulfill({
        status: 503,
        json: { error: { code: 'INTERNAL', message: 'unavailable' } },
      });
    });
    await page.route(comments, (route) =>
      route.request().method() === 'POST' ? route.fulfill(ONBOARDING_REFUSAL) : route.fallback(),
    );
    await newInput.fill(`내 정보를 다시 읽지 못한 댓글 ${tag}\n둘째 줄`);
    await composer.getByTestId('comment-submit').click();
    await expect.poll(() => meReads).toBeGreaterThanOrEqual(3);
    // The refusal is said once its side effects — the read of `GET /me` — are done.
    await expect(composer.getByTestId('comment-error')).toHaveText(copy.errPostOnboarding);
    await expect(page.getByTestId('comment-composer-failed')).toHaveCount(0);
    await expect(newInput).toHaveValue(`내 정보를 다시 읽지 못한 댓글 ${tag}\n둘째 줄`);
    await expect(held).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('쓰는 사이 글이 모든 화면에서 빠지면 거절된 쓰기와 쓰던 글자를 닫을 때까지 404를 미루고, 모두 닫으면 404가 된다', async ({
    admin,
    page,
  }) => {
    // 오너 결정 2026-10-21 답 1: a write refused because the post is gone (NOT_FOUND) — no
    // comment under it, so it left every view — holds off the page's 404 while its text is on
    // screen: '없거나 삭제된 글입니다.' in place of the post, the texts with why, leaving asking
    // first; once the last is closed, the 404, as a reload says it.
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const adminMe = await meOf(admin);
    const { asked, answers } = dialogs(page);
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');
    const held = page.getByTestId('comment-held');
    const composer = page.getByTestId('comment-composer');

    // --- the first 댓글 of a post its author deletes meanwhile.
    const first = await postThroughApi(admin, market.id, `곧 사라질 글 ${tag}`, tag);
    await page.goto(`/community/posts/${first}`);
    await composer.getByTestId('comment-input').fill(`첫 댓글 ${tag}\n둘째 줄`);
    const firstGone = await admin.post(`/api/v1/posts/${first}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(firstGone.status(), await firstGone.text()).toBe(200);
    await composer.getByTestId('comment-submit').click();
    await expect(page.getByTestId('post-gone')).toContainText(copy.postNotFound);
    await expect(held).toHaveCount(1);
    await expect(held.getByTestId('comment-held-reason')).toHaveText(copy.errPostGone);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(`첫 댓글 ${tag}\n둘째 줄`);
    // The box held the focus as it went: it comes here, named by why.
    await expect(held).toBeFocused();
    await expect(held).toHaveAccessibleName(copy.errPostGone);
    await expect(page.getByTestId('post-market')).toHaveCount(0);
    await expect(page.getByTestId('comments-heading')).toHaveCount(0);
    await expect(composer).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '404' })).toHaveCount(0);
    await expect(page).toHaveURL(`/community/posts/${first}`);
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([`confirm: ${copy.postLeaveConfirm}`]);
    await expect(held).toHaveCount(1);
    // Gone for good: a later read of the post failing otherwise (5xx, after its retries — a refocus,
    // the query still stale from the refusal's read) does not bring back the post, its market or
    // its boxes over the text.
    let failedReads = 0;
    const postRead = `**/api/v1/posts/${first}`;
    await page.route(postRead, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      failedReads += 1;
      await route.fulfill({
        status: 503,
        json: { error: { code: 'INTERNAL', message: 'unavailable' } },
      });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => failedReads).toBeGreaterThanOrEqual(3);
    // Two frames: the last failure has been written to the query and drawn.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await expect(page.getByTestId('post-gone')).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expect(page.getByTestId('post-market')).toHaveCount(0);
    await expect(page.getByTestId('comments-heading')).toHaveCount(0);
    await expect(composer).toHaveCount(0);
    await expect(held).toHaveCount(1);
    await expect(held.getByTestId('comment-held-reason')).toHaveText(copy.errPostGone);
    await page.unroute(postRead);
    await held.getByTestId('comment-held-close').click();
    await expect(page.getByTestId('post-screen')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    expect((await page.reload())?.status()).toBe(404);

    // --- a 답글 to the last comment under a post deleted meanwhile, and a new 댓글 beside it with no
    // write: both held with why until closed, then the 404.
    const second = await postThroughApi(admin, market.id, `댓글 하나의 글 ${tag}`, tag);
    const last = await commentThroughApi(admin, second, null, `마지막 댓글 ${tag}`);
    await page.goto(`/community/posts/${second}`);
    await composer.getByTestId('comment-input').fill(`옆에 쓰던 댓글 ${tag}`);
    await commentOf(page, last).getByTestId('comment-reply').click();
    const replyBox = page.getByTestId(`comment-thread-${last}`).getByTestId('reply-composer');
    await replyBox.getByTestId('comment-input').fill(`마지막 댓글에 쓰던 답글 ${tag}`);
    for (const path of [`/api/v1/posts/${second}/delete`, `/api/v1/comments/${last}/delete`]) {
      const res = await admin.post(path, { data: { expectedAccountId: adminMe.id } });
      expect(res.status(), await res.text()).toBe(200);
    }
    await replyBox.getByTestId('comment-submit').click();
    await expect(page.getByTestId('post-gone')).toContainText(copy.postNotFound);
    await expect(held).toHaveCount(2);
    await expect(held.getByTestId('comment-held-reason')).toHaveText([
      copy.errPostGone,
      copy.errPostGone,
    ]);
    const values = await held
      .getByTestId('comment-held-text')
      .evaluateAll((texts) => texts.map((text) => (text as HTMLTextAreaElement).value).sort());
    expect(values).toEqual([`마지막 댓글에 쓰던 답글 ${tag}`, `옆에 쓰던 댓글 ${tag}`].sort());
    // The refused 답글's box held the focus: its text has it now; the other is read out as an alert.
    const focused = page.locator('[data-testid="comment-held"]:focus');
    await expect(focused).toHaveCount(1);
    await expect(focused.getByTestId('comment-held-text')).toHaveValue(
      `마지막 댓글에 쓰던 답글 ${tag}`,
    );
    await expect(held.getByRole('alert')).toHaveCount(1);
    // One closed: the other stays and the page with it, the focus on what the page says — named
    // by it, so that is what is read out.
    await focused.getByTestId('comment-held-close').click();
    await expect(held).toHaveCount(1);
    await expect(page.getByTestId('post-gone')).toBeFocused();
    await expect(page.getByTestId('post-gone')).toHaveAccessibleName(copy.postNotFound);
    await expect(page.getByRole('heading', { name: '404' })).toHaveCount(0);
    await held.getByTestId('comment-held-close').click();
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();

    // --- an account facing a re-consent (the page is the gate's exception, 7-23) deletes its own
    // last comment under a post deleted meanwhile, its new 댓글's box holding text: the box goes
    // with the post, in place — its text shown with why, not put away in the tab for a post now
    // gone — and the 404 waits until it is closed (2026-10-21 답 1·2).
    const third = await postThroughApi(admin, market.id, `재동의 계정의 글 ${tag}`, tag);
    const own = await commentThroughApi(page.request, third, null, `내 마지막 댓글 ${tag}`);
    const reconsent = await asReconsent(page);
    reconsent.on = true;
    await page.goto(`/community/posts/${third}`);
    await composer.getByTestId('comment-input').fill(`재동의 중에 쓰던 댓글 ${tag}`);
    const thirdGone = await admin.post(`/api/v1/posts/${third}/delete`, {
      data: { expectedAccountId: adminMe.id },
    });
    expect(thirdGone.status(), await thirdGone.text()).toBe(200);
    await commentOf(page, own).getByTestId('comment-delete').click();
    await page.getByTestId('comment-delete-confirm').click();
    await expect(page.getByTestId('post-gone')).toContainText(copy.postNotFound);
    await expect(held).toHaveCount(1);
    await expect(held.getByRole('alert')).toHaveText(copy.errPostGone);
    await expect(held.getByTestId('comment-held-text')).toHaveValue(`재동의 중에 쓰던 댓글 ${tag}`);
    expect(await commentDraftsInTab(page)).toEqual({});
    await expect(page.getByRole('heading', { name: '404' })).toHaveCount(0);
    await held.getByTestId('comment-held-close').click();
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    expect(asked).toHaveLength(1);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('댓글이 달린 글을 다른 탭에서 지우면 열어 둔 수정 화면은 거절된 저장이나 다시 읽기 뒤에 쓰던 제목·본문을 고칠 수 없게 남기고, 닫기 뒤에는 새로 고침처럼 삭제된 글의 자리표시이며, 고친 것이 없는 화면은 곧바로 그 자리표시다', async ({
    admin,
    page,
  }) => {
    // 오너 결정 2026-10-24 (ADR-0073 9-52) for a post with comments under it (#48, ADR-0074
    // 7-35): deleted, it stays at its address as '삭제된 글입니다' and a read of it answers that
    // placeholder, not NOT_FOUND — the save is refused as NOT_FOUND all the same. The edit screen
    // dropped the form with what was written in it for '삭제된 글입니다.'; it keeps it now, as for
    // a post gone from every view (posts.spec.ts's twentieth and twenty-first), and once it is
    // closed it is what a reload draws: the placeholder. The page's clock makes a read older than
    // `staleTime` (30 s) without waiting, as posts.spec.ts does.
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const { asked, answers } = dialogs(page);
    await page.clock.install();
    const refocus = async () => {
      await page.clock.fastForward('00:31');
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 1_000));
    /** A post of this account's with a 댓글 under it, and its edit screen. */
    const postWithComment = async (title: string) => {
      const id = await postThroughApi(page.request, market.id, title, `${title}의 근거`);
      const comment = await commentThroughApi(page.request, id, null, `${title}의 댓글`);
      return { id, comment, edit: `/community/posts/${id}/edit` };
    };
    /** Its author deletes it on its page in another tab: it stays as its placeholder. */
    const deleteInAnotherTab = async (id: string) => {
      const other = await page.context().newPage();
      await other.goto(`/community/posts/${id}`);
      await other.getByTestId('post-delete').click();
      await other.getByTestId('post-delete-confirm').click();
      await expect(other).toHaveURL('/community');
      const read = await other.request.get(`/api/v1/posts/${id}`);
      expect(read.status()).toBe(200);
      expect(((await read.json()) as { data: { state: string } }).data.state).toBe('deleted');
      await other.close();
    };
    let saves = 0;
    await page.route(/\/api\/v1\/posts\/[^/]+$/, (route) => {
      if (route.request().method() === 'PUT') saves += 1;
      return route.continue();
    });
    const title = page.getByTestId('post-title-input');
    const editor = page.getByTestId('post-editor-content');
    const unavailable = page.getByTestId('post-edit-unavailable');
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');

    // --- the title and the body changed, the post deleted in another tab, 저장: refused
    // (NOT_FOUND), the read again answers the placeholder, and the form stays with what was
    // written, read-only, under '없거나 삭제된 글입니다.', 닫기 in place of 저장.
    const saved = await postWithComment(`저장할 글 ${tag}`);
    await page.goto(saved.edit);
    await expect(editor).toContainText(`저장할 글 ${tag}의 근거`);
    await title.fill(`고친 제목 ${tag}`);
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 덧붙인 근거');
    await expect(editor).toContainText('덧붙인 근거');
    await deleteInAnotherTab(saved.id);
    await page.getByTestId('post-submit').click();
    await expect(page.getByTestId('post-form-gone')).toHaveText(copy.errPostGone);
    expect(saves).toBe(1);
    await expect(title).toHaveValue(`고친 제목 ${tag}`);
    await expect(title).not.toBeEditable();
    await expect(editor).toContainText('덧붙인 근거');
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await expect(page.getByTestId('post-submit')).toHaveCount(0);
    await expect(page.getByTestId('post-form-close')).toBeVisible();
    await expect(page.getByTestId('post-edit-market')).toHaveText(market.title);
    await expect(page.getByTestId('post-form-error')).toHaveCount(0);
    await settle();
    await expect(unavailable).toHaveCount(0);
    await expect(title).toHaveValue(`고친 제목 ${tag}`);
    // Leaving asks, and staying keeps it all.
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([`confirm: ${copy.postLeaveConfirm}`]);
    await expect(page).toHaveURL(saved.edit);
    await expect(title).toHaveValue(`고친 제목 ${tag}`);
    await expect(editor).toContainText('덧붙인 근거');
    // 닫기: asking nothing, the placeholder a reload draws — '삭제된 글입니다.', not the 404.
    await page.getByTestId('post-form-close').click();
    await expect(unavailable).toHaveText(copy.postDeletedPlaceholder);
    await expect(page.getByTestId('post-form-gone')).toHaveCount(0);
    await expect(title).toHaveCount(0);
    await expect(page.getByTestId('post-edit-gone')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '404' })).toHaveCount(0);
    await expect(page).toHaveURL(saved.edit);
    expect(asked).toHaveLength(1);
    expect((await page.reload())?.status()).toBe(200);
    await expect(unavailable).toHaveText(copy.postDeletedPlaceholder);

    // --- a line added to the body, the post deleted in another tab, and a focus reads it again:
    // kept the same way — nothing was sent — and 닫기 is the placeholder.
    const focused = await postWithComment(`포커스로 읽을 글 ${tag}`);
    await page.goto(focused.edit);
    await expect(editor).toContainText(`포커스로 읽을 글 ${tag}의 근거`);
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 쓰던 근거');
    await expect(editor).toContainText('쓰던 근거');
    await deleteInAnotherTab(focused.id);
    await refocus();
    await expect(page.getByTestId('post-form-gone')).toHaveText(copy.errPostGone);
    await expect(title).toHaveValue(`포커스로 읽을 글 ${tag}`);
    await expect(title).not.toBeEditable();
    await expect(editor).toContainText('쓰던 근거');
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await settle();
    await expect(unavailable).toHaveCount(0);
    expect(saves).toBe(1);
    await page.getByTestId('post-form-close').click();
    await expect(unavailable).toHaveText(copy.postDeletedPlaceholder);
    await expect(page).toHaveURL(focused.edit);

    // --- nothing changed: nothing of the writer's to keep, the placeholder at once — and once its
    // last comment is deleted too, the post leaves every view and the open screen is its 404.
    const plain = await postWithComment(`그냥 둔 글 ${tag}`);
    await page.goto(plain.edit);
    await expect(title).toHaveValue(`그냥 둔 글 ${tag}`);
    await deleteInAnotherTab(plain.id);
    await refocus();
    await expect(unavailable).toHaveText(copy.postDeletedPlaceholder);
    await expect(title).toHaveCount(0);
    await expect(page.getByTestId('post-form-gone')).toHaveCount(0);
    await expect(page).toHaveURL(plain.edit);
    const me = await meOf(page.request);
    const last = await page.request.post(`/api/v1/comments/${plain.comment}/delete`, {
      data: { expectedAccountId: me.id },
    });
    expect(last.status(), await last.text()).toBe(200);
    await refocus();
    await expect(page.getByTestId('post-edit-screen')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    await expect(page).toHaveURL(plain.edit);
    expect(asked).toHaveLength(1);
    expect(saves).toBe(1);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('댓글이 달린 글이 수정 화면에서 이미지를 올리는 사이 다른 탭에서 지워지면, 그 뒤에 올라온 이미지는 고칠 수 없게 남은 본문의 고른 줄 뒤에 들어가고(그 줄은 그대로) 기다리던 파일은 보내지 않으며, 닫기 뒤에는 자리표시다', async ({
    admin,
    page,
  }) => {
    // 오너 결정 2026-10-25 (2차) «남긴 양식에 넣음» (ADR-0073 9-53) on the form held for a post
    // deleted with a comment under it (ADR-0074 7-35) — its read the placeholder, not NOT_FOUND:
    // the same form, held read-only by the same `gone`, so an upload on its way as the post goes
    // lands after the selected line, and the file waiting its turn is never sent (posts.spec.ts's
    // twenty-second, for a post gone from every view). The upload waits until let go, past the
    // read that finds the placeholder (the page's clock and a focus, as above).
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    await page.clock.install();
    const postId = await postThroughApi(page.request, market.id, `올리던 글 ${tag}`, '올리던 근거');
    await commentThroughApi(page.request, postId, null, `올리던 글의 댓글 ${tag}`);
    const edit = `/community/posts/${postId}/edit`;
    const held: Route[] = [];
    let uploads = 0;
    await page.route('**/api/v1/media/images**', (route) => {
      uploads += 1;
      held.push(route);
    });
    await page.goto(edit);
    const editor = page.getByTestId('post-editor-content');
    await expect(editor).toContainText('올리던 근거');
    // The line selected, then two images picked: the first goes up, the second waits its turn.
    await editor.locator('p').first().click({ clickCount: 3 });
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain(
      '올리던 근거',
    );
    await page.getByTestId('post-editor-file').setInputFiles(
      [1, 2].map((n) => ({
        name: `evidence-${String(n)}.png`,
        mimeType: 'image/png',
        buffer: PNG,
      })),
    );
    await expect.poll(() => held.length).toBe(1);
    await expect(page.getByTestId('post-editor-uploading')).toBeVisible();

    // Deleted in another tab — it stays as its placeholder — and read again on a focus: the upload
    // on its way is something to keep (ADR-0073 9-52), so the form stays, locked, under the
    // sentence.
    const other = await page.context().newPage();
    await other.goto(`/community/posts/${postId}`);
    await other.getByTestId('post-delete').click();
    await other.getByTestId('post-delete-confirm').click();
    await expect(other).toHaveURL('/community');
    const read = await other.request.get(`/api/v1/posts/${postId}`);
    expect(((await read.json()) as { data: { state: string } }).data.state).toBe('deleted');
    await other.close();
    await page.clock.fastForward('00:31');
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByTestId('post-form-gone')).toHaveText(copy.errPostGone);
    await expect(editor).toHaveAttribute('contenteditable', 'false');

    // The upload lands: its image goes in after the selected line, which stays as it was, selected
    // to copy — and the file waiting its turn is never sent.
    await held.shift()!.continue();
    await expect(page.getByTestId('post-editor-uploading')).toHaveCount(0);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await expect(editor.locator('img')).toHaveCount(1);
    // The line, the image, and the empty line the editor keeps after a body ending in an image.
    expect(
      await editor.evaluate((root) =>
        Array.from(root.children, (child) =>
          child.tagName === 'IMG' ? '[image]' : (child.textContent ?? ''),
        ),
      ),
    ).toEqual(['올리던 근거', '[image]', '']);
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain(
      '올리던 근거',
    );
    await expect(page.getByTestId('post-body-images')).toContainText('1 / 10');
    expect(uploads).toBe(1);
    await expect(page.getByTestId('post-edit-unavailable')).toHaveCount(0);
    // Held with the image it took until 닫기 — then the placeholder a reload draws.
    await page.getByTestId('post-form-close').click();
    await expect(page.getByTestId('post-edit-unavailable')).toHaveText(copy.postDeletedPlaceholder);
    await expect(page.getByRole('heading', { name: '404' })).toHaveCount(0);
    await expect(page).toHaveURL(edit);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
});

test.describe('탭의 세션이 아직 앞 계정을 말하는데 `GET /me`가 다른 회원으로 답하는 글 화면의 댓글 상자 (ADR-0092 오너 결정 2026-10-26 17:21 답 3)', () => {
  // `['me']` turns from A to B in place, before the session does (ADR-0090 결정 4-2), so
  // SessionCacheGuard resets nothing. The comment boxes are drawn for the account on screen — the
  // threads by the boxes' turn, the new 댓글's box by the account — so B never gets a box A opened,
  // nor A's text in one, its 올리기·저장 sent as B with B's cookie. The owner's «이 PR에서 함께,
  // 적던 것은 A의 초안으로»: each of A's boxes, going, keeps what A typed in this tab as A's draft of
  // that box (ADR-0074 7-32 — one item per box and account, which B's page neither reads nor
  // replaces), and A, on the post page again, gets each back in its box, said once in a toast and
  // under each box.

  test('앞 계정이 쓰던 새 댓글·답글·수정은 다른 회원에게 빈 상자와 닫힌 답글·수정으로 다시 그려지고 아무것도 보내지 않으며, 이 탭에 앞 계정의 것으로 두었다가 그 계정이 돌아오면 그 상자들에 되살린다', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const { asked } = dialogs(page);
    const { a, b, open, toB, toA, close } = await membersTurningInPlace(browser, page);
    try {
      const postId = await postThroughApi(admin, market.id, `계정이 바뀌는 글 ${tag}`, tag);
      const theirs = await commentThroughApi(admin, postId, null, `운영자의 댓글 ${tag}`);
      const mine = await commentThroughApi(page.request, postId, null, `앞 계정의 댓글 ${tag}`);
      const composer = page.getByTestId('comment-composer');
      const replyBox = page.getByTestId(`comment-thread-${theirs}`).getByTestId('reply-composer');
      const editForm = commentOf(page, mine).getByTestId('comment-edit-form');
      await open(`/community/posts/${postId}`);

      // --- A's three boxes, each with text.
      await composer.getByTestId('comment-input').fill(`앞 계정의 새 댓글 ${tag}`);
      await commentOf(page, theirs).getByTestId('comment-reply').click();
      await replyBox.getByTestId('comment-input').fill(`앞 계정의 답글 ${tag}`);
      await commentOf(page, mine).getByTestId('comment-edit').click();
      await editForm.getByTestId('comment-input').fill(`앞 계정이 고친 댓글 ${tag}`);
      const writes: string[] = [];
      page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (request.method() === 'GET') return;
        if (pathname.startsWith('/api/v1/posts/') || pathname.startsWith('/api/v1/comments/')) {
          writes.push(`${request.method()} ${pathname}`);
        }
      });

      // --- B on screen: B's empty box, no 답글 or 수정 open, nothing held apart; A's kept as A's.
      await toB();
      await expect(composer.getByTestId('comment-input')).toHaveValue('');
      await expect(composer.getByTestId('comment-draft-restored')).toHaveCount(0);
      await expect(replyBox).toHaveCount(0);
      await expect(editForm).toHaveCount(0);
      await expect(commentOf(page, mine)).toContainText(`앞 계정의 댓글 ${tag}`);
      // B is not the author: no 수정 on A's comment.
      await expect(commentOf(page, mine).getByTestId('comment-edit')).toHaveCount(0);
      await expect(page.getByTestId('comment-held')).toHaveCount(0);
      const prefix = `buddha.commentDraft:${postId}`;
      await expect
        .poll(() => commentDraftsInTab(page))
        .toEqual({
          [`${prefix}:comment@${a.id}`]: `앞 계정의 새 댓글 ${tag}`,
          [`${prefix}:reply:${theirs}@${a.id}`]: `앞 계정의 답글 ${tag}`,
          [`${prefix}:edit:${mine}@${a.id}`]: `앞 계정이 고친 댓글 ${tag}`,
        });
      await expect(restoredToasts(page)).toHaveCount(0);
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);
      // B types too: B's own, beside A's.
      await composer.getByTestId('comment-input').fill(`다른 회원의 새 댓글 ${tag}`);

      // --- A on the page again: each box open with A's text, said under it and once in a toast;
      // B's kept as B's.
      await toA();
      await expect(composer.getByTestId('comment-input')).toHaveValue(`앞 계정의 새 댓글 ${tag}`);
      await expect(composer.getByTestId('comment-draft-restored')).toHaveText(
        copy.commentDraftRestored,
      );
      await expect(replyBox.getByTestId('comment-input')).toHaveValue(`앞 계정의 답글 ${tag}`);
      await expect(replyBox.getByTestId('comment-draft-restored')).toBeVisible();
      await expect(editForm.getByTestId('comment-input')).toHaveValue(`앞 계정이 고친 댓글 ${tag}`);
      await expect(editForm.getByTestId('comment-draft-restored')).toBeVisible();
      await expect(restoredToasts(page)).toHaveCount(1);
      await expect
        .poll(() => commentDraftsInTab(page))
        .toEqual({ [`${prefix}:comment@${b.id}`]: `다른 회원의 새 댓글 ${tag}` });
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);
    } finally {
      await close();
    }
  });

  test('다른 회원에게 첫 온보딩 단계가 남아 게이트가 그 자리에서 글 화면을 거두어도, 앞 계정이 따로 보던 글자는 이 탭에 앞 계정의 것으로 두었다가 그 계정이 돌아오면 까닭과 함께 다시 보인다 (ADR-0092 8-26)', async ({
    admin,
    browser,
    page,
  }) => {
    // B has its first onboarding step left, and the post page is exempt for a re-consent alone: the
    // gate puts its placeholder in place of the page in the very render `['me']` turns to B, so the
    // comment section goes without ever being drawn for B — what it showed apart from any box is
    // kept as A's as it goes (`keepSectionTextsAsItGoes`), as the boxes keep theirs.
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const { asked } = dialogs(page);
    const { a, open, toB, toA, close } = await membersTurningInPlace(browser, page, {
      bStepLeft: true,
    });
    try {
      const postId = await postThroughApi(admin, market.id, `단계가 남은 회원의 글 ${tag}`, tag);
      const mine = await commentThroughApi(page.request, postId, null, `곧 지울 댓글 ${tag}`);
      const postPage = `/community/posts/${postId}`;
      await open(postPage);
      const held = page.getByTestId('comment-held');

      // --- A's 답글 under A's own 댓글, which A deletes: with nothing under it the 댓글 leaves the
      // view and the box with it — its text held apart, with why.
      await commentOf(page, mine).getByTestId('comment-reply').click();
      const box = page.getByTestId(`comment-thread-${mine}`).getByTestId('reply-composer');
      const text = `앞 계정이 따로 보던 답글 ${tag}\n둘째 줄`;
      await box.getByTestId('comment-input').fill(text);
      await commentOf(page, mine).getByTestId('comment-delete').click();
      await page.getByTestId('comment-delete-confirm').click();
      await expect(page.getByText(copy.commentDeletedToast)).toBeVisible();
      await expect(page.getByTestId(`comment-thread-${mine}`)).toHaveCount(0);
      await expect(held).toHaveCount(1);
      await expect(held.getByTestId('comment-held-reason')).toHaveText(copy.errCommentParentGone);
      await expect(held.getByTestId('comment-held-text')).toHaveValue(text);
      expect(await commentDraftsInTab(page)).toEqual({});
      const writes: string[] = [];
      page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (request.method() === 'GET') return;
        if (pathname.startsWith('/api/v1/posts/') || pathname.startsWith('/api/v1/comments/')) {
          writes.push(`${request.method()} ${pathname}`);
        }
      });

      // --- B on screen: the gate takes the page away and on to B's step; A's text is A's draft of
      // the box it stood for, which B's page never reads.
      await toB();
      await expect(page).toHaveURL(`/onboarding?next=${encodeURIComponent(postPage)}`);
      await expect(page.getByTestId('consent-step')).toBeVisible();
      const prefix = `buddha.commentDraft:${postId}`;
      await expect
        .poll(() => commentDraftsInTab(page))
        .toEqual({ [`${prefix}:reply:${mine}@${a.id}`]: text });
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);

      // --- A again: the stepper sends A, with nothing left, back to the post page, which takes the
      // draft back — its 댓글 gone, it is held apart with why, said once.
      await toA();
      await expect(page).toHaveURL(postPage);
      await expect(held).toHaveCount(1);
      await expect(held.getByTestId('comment-held-reason')).toHaveText(copy.errCommentParentGone);
      await expect(held.getByTestId('comment-held-text')).toHaveValue(text);
      await expect(restoredToasts(page)).toHaveCount(1);
      await expect.poll(() => commentDraftsInTab(page)).toEqual({});
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);
    } finally {
      await close();
    }
  });
});

test.describe('탭의 세션이 먼저 다른 회원을 말하는 글 화면의 댓글 상자 — 정순서 (ADR-0092 결정 10, 오너 결정 2026-10-26 21:00 답 1 «정순서에서도 A의 초안으로»)', () => {
  // The forward order: the session names B first and SessionCacheGuard's reset empties `['me']`
  // and the comments — A's new 댓글 box gives way to its placeholder and A's 답글 and 수정 boxes go
  // with the threads, in that very render — then `GET /me` answers as B. Before this, A's texts went
  // with the reset (nobody on screen, nothing kept, nothing held for B). Now each box, going, hears
  // from the guard that the session names B, and keeps what A typed as A's draft of that box, as when
  // `['me']` turns first (17:21 답 3): B's page reads none of it, nothing is sent as B, and A, with
  // the session back, gets each back in its box, said once — also when `GET /me` names A again
  // before the session does, and the session's reset then takes away the boxes just drawn for A
  // with those texts in them (8-36). A link's leave keeps nothing, as ever.

  test('앞 계정이 쓰던 새 댓글·답글·수정은 세션이 다른 회원으로 바뀌면 빈 상자와 닫힌 답글·수정으로 다시 그려지고 아무것도 보내지 않으며, 앞 계정의 것으로 두었다가 세션이 돌아오면 그 상자들에 되살리고, 링크로 떠나는 것은 그대로 묻고 아무것도 두지 않는다', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const { asked, answers } = dialogs(page);
    const { a, open, toB, toA, close } = await membersSwitchingSessions(browser, page);
    try {
      const postId = await postThroughApi(admin, market.id, `세션이 바뀌는 글 ${tag}`, tag);
      const theirs = await commentThroughApi(admin, postId, null, `운영자의 댓글 ${tag}`);
      const mine = await commentThroughApi(page.request, postId, null, `앞 계정의 댓글 ${tag}`);
      const composer = page.getByTestId('comment-composer');
      const replyBox = page.getByTestId(`comment-thread-${theirs}`).getByTestId('reply-composer');
      const editForm = commentOf(page, mine).getByTestId('comment-edit-form');
      await open(`/community/posts/${postId}`);

      // --- A's three boxes, each with text.
      await composer.getByTestId('comment-input').fill(`앞 계정의 새 댓글 ${tag}`);
      await commentOf(page, theirs).getByTestId('comment-reply').click();
      await replyBox.getByTestId('comment-input').fill(`앞 계정의 답글 ${tag}`);
      await commentOf(page, mine).getByTestId('comment-edit').click();
      await editForm.getByTestId('comment-input').fill(`앞 계정이 고친 댓글 ${tag}`);
      const writes: string[] = [];
      page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (request.method() === 'GET') return;
        if (pathname.startsWith('/api/v1/posts/') || pathname.startsWith('/api/v1/comments/')) {
          writes.push(`${request.method()} ${pathname}`);
        }
      });

      // --- the session says B first: B's empty box, no 답글 or 수정 open, nothing held apart; A's
      // kept as A's.
      await toB();
      await expect(composer.getByTestId('comment-input')).toBeEditable();
      await expect(composer.getByTestId('comment-input')).toHaveValue('');
      await expect(composer.getByTestId('comment-draft-restored')).toHaveCount(0);
      await expect(commentOf(page, mine)).toContainText(`앞 계정의 댓글 ${tag}`);
      await expect(replyBox).toHaveCount(0);
      await expect(editForm).toHaveCount(0);
      // B is not the author: no 수정 on A's comment.
      await expect(commentOf(page, mine).getByTestId('comment-edit')).toHaveCount(0);
      await expect(page.getByTestId('comment-held')).toHaveCount(0);
      const prefix = `buddha.commentDraft:${postId}`;
      await expect
        .poll(() => commentDraftsInTab(page))
        .toEqual({
          [`${prefix}:comment@${a.id}`]: `앞 계정의 새 댓글 ${tag}`,
          [`${prefix}:reply:${theirs}@${a.id}`]: `앞 계정의 답글 ${tag}`,
          [`${prefix}:edit:${mine}@${a.id}`]: `앞 계정이 고친 댓글 ${tag}`,
        });
      await expect(restoredToasts(page)).toHaveCount(0);
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);

      // --- the session says A again: each box open with A's text, said under it and once in a
      // toast; the tab holds nothing more (B typed nothing).
      await toA();
      await expect(composer.getByTestId('comment-input')).toHaveValue(`앞 계정의 새 댓글 ${tag}`);
      await expect(composer.getByTestId('comment-draft-restored')).toHaveText(
        copy.commentDraftRestored,
      );
      await expect(replyBox.getByTestId('comment-input')).toHaveValue(`앞 계정의 답글 ${tag}`);
      await expect(replyBox.getByTestId('comment-draft-restored')).toBeVisible();
      await expect(editForm.getByTestId('comment-input')).toHaveValue(`앞 계정이 고친 댓글 ${tag}`);
      await expect(editForm.getByTestId('comment-draft-restored')).toBeVisible();
      await expect(restoredToasts(page)).toHaveCount(1);
      await expect.poll(() => commentDraftsInTab(page)).toEqual({});
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);

      // --- a link's leave, as ever: asked first, and once left nothing is kept.
      const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');
      answers.push(true);
      await home.click();
      await expect(page).toHaveURL('/');
      expect(asked).toEqual([`confirm: ${copy.postLeaveConfirm}`]);
      expect(await commentDraftsInTab(page)).toEqual({});
      expect(writes).toEqual([]);
    } finally {
      await close();
    }
  });

  test('세션이 다른 회원으로 바뀐 뒤 앞 계정이 돌아올 때 `GET /me`가 세션보다 먼저 앞 계정을 말해도, 되살린 새 댓글·답글·수정은 세션의 되돌리기 뒤에도 그 상자들에 남고 알림은 한 번이다 (ADR-0092 8-36)', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const { asked } = dialogs(page);
    const { a, open, toB, toAMeFirst, close } = await membersSwitchingSessions(browser, page);
    try {
      const postId = await postThroughApi(admin, market.id, `세션이 따라잡는 글 ${tag}`, tag);
      const theirs = await commentThroughApi(admin, postId, null, `운영자의 댓글 ${tag}`);
      const mine = await commentThroughApi(page.request, postId, null, `앞 계정의 댓글 ${tag}`);
      const composer = page.getByTestId('comment-composer');
      const replyBox = page.getByTestId(`comment-thread-${theirs}`).getByTestId('reply-composer');
      const editForm = commentOf(page, mine).getByTestId('comment-edit-form');
      await open(`/community/posts/${postId}`);

      // --- A's three boxes, each with text.
      await composer.getByTestId('comment-input').fill(`앞 계정의 새 댓글 ${tag}`);
      await commentOf(page, theirs).getByTestId('comment-reply').click();
      await replyBox.getByTestId('comment-input').fill(`앞 계정의 답글 ${tag}`);
      await commentOf(page, mine).getByTestId('comment-edit').click();
      await editForm.getByTestId('comment-input').fill(`앞 계정이 고친 댓글 ${tag}`);
      const writes: string[] = [];
      page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (request.method() === 'GET') return;
        if (pathname.startsWith('/api/v1/posts/') || pathname.startsWith('/api/v1/comments/')) {
          writes.push(`${request.method()} ${pathname}`);
        }
      });

      // --- the session says B first: A's kept as A's.
      await toB();
      await expect(composer.getByTestId('comment-input')).toHaveValue('');
      await expect(replyBox).toHaveCount(0);
      await expect(editForm).toHaveCount(0);
      const prefix = `buddha.commentDraft:${postId}`;
      const keptForA = {
        [`${prefix}:comment@${a.id}`]: `앞 계정의 새 댓글 ${tag}`,
        [`${prefix}:reply:${theirs}@${a.id}`]: `앞 계정의 답글 ${tag}`,
        [`${prefix}:edit:${mine}@${a.id}`]: `앞 계정이 고친 댓글 ${tag}`,
      };
      await expect.poll(() => commentDraftsInTab(page)).toEqual(keptForA);

      // --- A back, `GET /me` answering before the session: A's boxes, A's texts taken back out of
      // the tab — then the session says A, and its reset takes the boxes away and draws them again.
      const textsInBoxes = async () => {
        await expect(composer.getByTestId('comment-input')).toHaveValue(`앞 계정의 새 댓글 ${tag}`);
        await expect(composer.getByTestId('comment-draft-restored')).toHaveText(
          copy.commentDraftRestored,
        );
        await expect(replyBox.getByTestId('comment-input')).toHaveValue(`앞 계정의 답글 ${tag}`);
        await expect(replyBox.getByTestId('comment-draft-restored')).toBeVisible();
        await expect(editForm.getByTestId('comment-input')).toHaveValue(
          `앞 계정이 고친 댓글 ${tag}`,
        );
        await expect(editForm.getByTestId('comment-draft-restored')).toBeVisible();
        await expect.poll(() => commentDraftsInTab(page)).toEqual({});
      };
      await toAMeFirst(textsInBoxes);
      await textsInBoxes();
      // Taken back twice — in place, then after the reset — and said once.
      await expect(restoredToasts(page)).toHaveCount(1);
      await expect(page.getByTestId('comment-held')).toHaveCount(0);
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);
    } finally {
      await close();
    }
  });
});
