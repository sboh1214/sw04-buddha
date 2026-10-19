import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { copy } from '../src/copy';
import { createOpenMarket, expect, freshEmail, freshTag, meOf, signUp, test } from './helpers';

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
 * which the server put in the HTML, a long address wrapping inside a phone's width, and is asked
 * to sign in, coming back to the post. The depth rule, the placeholders' rules, the counts, the
 * permissions and the link safety are the API's and the shared package's tests; this walks the
 * screens.
 */

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

/** The comment `id` as the thread draws it. */
const commentOf = (page: Page, id: string) => page.getByTestId(`comment-${id}`);

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

  test('로그인하지 않은 방문자는 댓글과 대댓글을 읽고(서버가 그린 HTML에도 있다), 쓰기 대신 이 글로 돌아오는 로그인 안내를 받는다', async ({
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

    // The first page is the server's: the HTML holds the comments before any script runs.
    const html = await (await request.get(`/community/posts/${postId}`)).text();
    expect(html).toContain(`읽는 댓글 ${tag}`);
    expect(html).toContain(`읽는 답글 ${tag}`);

    await page.goto(`/community/posts/${postId}`);
    await expect(page.getByTestId('comments-heading')).toHaveText(`${copy.commentsHeading} 3`);
    await expect(commentOf(page, top).getByTestId('comment-body')).toHaveText(`읽는 댓글 ${tag}`);
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
});
