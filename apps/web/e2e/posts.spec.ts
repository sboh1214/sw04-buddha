import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  closeMarket,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  logOut,
  meOf,
  signUp,
  test,
} from './helpers';

/**
 * 근거 글과 커뮤니티 (#46, ADR-0073; owner decisions in ADR-0069 decision 2, #45, and of
 * 2026-10-18): a member opens 글쓰기 from the community list, picks a market by its title, changes
 * it before sending without losing the draft, writes a formatted post with an image (a pasted link
 * the post would not keep is not shown as one), finds it in the community list through its search,
 * market filter and category controls, sees their current nickname on it, edits it ('수정됨') and
 * deletes it (gone from the list, its page 404). The picker offers a closed market too (#45-6). A
 * visitor reads the list and a post — on a closed market too, whose link still opens the market's
 * detail, and an admin's untitled post with its '운영자' mark — and is asked to sign in to write.
 * None of the community's screens is for search engines (noindex), and leaving a draft asks first —
 * a refusal keeps it, an answer of yes leaves (owner decisions 2026-10-19): a body without a title,
 * the edit screen (where an untouched body asks nothing, a click into it included), and Forward and
 * a jump back in a browser without the Navigation API too.
 * The allow-list, the image checks, the permissions and the paging are the API's and the shared
 * package's tests; this walks the screens.
 */

/** A 1×1 PNG, as a phone would never send but sharp reads like any other. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const card = (page: Page, postId: string) => page.getByTestId(`post-card-${postId}`);

/**
 * The page asks search engines not to index it (owner decision 2026-10-19): a robots meta that
 * says `noindex`, and none that says otherwise. Counted rather than read from one element: during
 * a client-side move between two such pages both pages' tags can be in the document for a moment.
 */
async function expectNotIndexed(page: Page): Promise<void> {
  await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
  await expect(page.locator('meta[name="robots"]:not([content*="noindex"])')).toHaveCount(0);
}

/** The post id of the post page the browser is on. */
function postIdOf(page: Page): string {
  const match = /\/community\/posts\/([0-9a-f-]{36})$/.exec(new URL(page.url()).pathname);
  if (match?.[1] === undefined) throw new Error(`not a post page: ${page.url()}`);
  return match[1];
}

/** Picks `market` in a MarketPicker (`picker` is its test id): its title searched, its row picked. */
async function pickMarket(page: Page, picker: string, market: { title: string }): Promise<void> {
  await page.getByTestId(`${picker}-input`).fill(market.title);
  await page.getByTestId(`${picker}-submit`).click();
  await page.getByRole('button', { name: `${market.title} ${copy.marketPickerPick}` }).click();
}

/** Pastes `html` into the editor as a browser does from another page (a paste event's HTML). */
async function pasteHtml(editor: Locator, html: string): Promise<void> {
  await editor.evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData('text/html', pasted);
    data.setData('text/plain', pasted.replace(/<[^>]*>/g, ''));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, html);
}

/**
 * A post straight at the API with the context's cookie, for a spec whose subject is reading it:
 * a paragraph of `text` (in italics, with a link), then the `after` blocks.
 */
async function postThroughApi(
  context: APIRequestContext,
  marketId: string,
  title: string | null,
  text: string,
  after: readonly unknown[] = [],
): Promise<string> {
  const me = await meOf(context);
  const res = await context.post('/api/v1/posts', {
    data: {
      marketId,
      title,
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text, marks: [{ type: 'italic' }] },
              {
                type: 'text',
                text: ' 출처',
                marks: [{ type: 'link', attrs: { href: 'https://example.com/source' } }],
              },
            ],
          },
          ...after,
        ],
      },
      expectedAccountId: me.id,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

test.describe('근거 글', () => {
  test('회원이 시장을 정해 서식과 이미지가 있는 글을 쓰고, 목록에서 찾고, 고치면 수정됨이 붙고, 지우면 사라진다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const other = await createOpenMarket(admin, { topLevelCategory: 1 });
    const tag = freshTag();
    await signUp(page, freshEmail());
    const me = await meOf(page.request);

    // --- write: 글쓰기 on the community list, the market picked by its title (#45-1). The wrong
    // one first, changed below before sending.
    await page.goto('/community');
    await page.getByTestId('community-write').click();
    await expect(page).toHaveURL('/community/write');
    await expectNotIndexed(page);
    await pickMarket(page, 'post-write-market-picker', other);
    await expect(page).toHaveURL(`/community/write?market=${other.id}`);
    await expect(page.getByTestId('post-write-market-title')).toHaveText(other.title);
    await page.getByTestId('post-title-input').fill(`근거 ${tag}`);
    const editor = page.getByTestId('post-editor-content');
    await editor.click();
    await page.getByTestId('post-editor-bold').click();
    await page.keyboard.type('굵은 근거');
    await page.getByTestId('post-editor-bold').click();
    await page.keyboard.type(' 보통 글자 ');
    // A colour, picked before typing as a writer would: one of the six names, drawn as
    // `data-color` (#45-3). The select takes the focus; the editor takes it back.
    await page.getByTestId('post-editor-color').selectOption('red');
    await expect(editor).toBeFocused();
    await page.keyboard.type('빨간 글자');
    await page.getByTestId('post-editor-color').selectOption('');
    await expect(editor).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.type(`확인 코드 ${tag}`);
    // HTML pasted from another page or app: only a link the saved post keeps shows as a link —
    // a relative address and a bare host are pasted as their text.
    await page.keyboard.press('Enter');
    await pasteHtml(
      editor,
      '<a href="/about">상대 주소</a> · <a href="example.com">맨 주소</a> · ' +
        '<a href="https://example.com/kept">남는 링크</a>',
    );
    await expect(editor.locator('a')).toHaveCount(1);
    await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com/kept');
    await expect(editor).toContainText('상대 주소 · 맨 주소 · 남는 링크');
    await page
      .getByTestId('post-editor-file')
      .setInputFiles({ name: 'evidence.png', mimeType: 'image/png', buffer: PNG });
    await expect(editor.locator('img[data-media-id]')).toHaveCount(1);
    await expect(page.getByTestId('post-body-images')).toContainText('1 / 10');
    // No probability, position or order is asked for (N05 §2).
    await expect(page.getByTestId('post-form').locator('input[type="range"]')).toHaveCount(0);
    // The body is described by its counts and the live region its limit messages appear in.
    await expect(editor).toHaveAttribute(
      'aria-describedby',
      'post-body-length post-body-images post-body-errors',
    );
    await expect(page.getByTestId('post-body-errors')).toHaveAttribute('role', 'status');
    // A link the post would not keep is not put in, and the field says why.
    await page.getByTestId('post-editor-link').click();
    await page.getByTestId('post-editor-link-input').fill('https://bank.example@evil.example');
    await page.getByTestId('post-editor-link-apply').click();
    await expect(page.getByTestId('post-editor-link-invalid')).toHaveText(copy.editorLinkInvalid);
    await expect(editor.locator('a')).toHaveCount(1);
    await page.getByTestId('post-editor-link').click();

    // --- the market changed before sending: picked again in place, the draft kept — title,
    // formatted text and the uploaded image (#45-4: it cannot change once sent).
    await page.getByTestId('post-write-market-change').click();
    await pickMarket(page, 'post-write-market-repick', market);
    await expect(page).toHaveURL(`/community/write?market=${market.id}`);
    await expect(page.getByTestId('post-write-market-title')).toHaveText(market.title);
    await expect(page.getByTestId('post-title-input')).toHaveValue(`근거 ${tag}`);
    await expect(editor.locator('strong')).toHaveText('굵은 근거');
    await expect(editor.locator('img[data-media-id]')).toHaveCount(1);
    await page.getByTestId('post-submit').click();

    // --- the post page.
    await expect(page).toHaveURL(/\/community\/posts\/[0-9a-f-]{36}$/);
    const postId = postIdOf(page);
    await expect(page.getByTestId('post-title')).toHaveText(`근거 ${tag}`);
    const body = page.getByTestId('post-body');
    await expect(body.locator('strong')).toHaveText('굵은 근거');
    await expect(body.locator('[data-color="red"]')).toHaveText('빨간 글자');
    await expect(body).toContainText(`확인 코드 ${tag}`);
    const image = body.getByTestId('post-image');
    await expect(image).toHaveAttribute('src', /^\/api\/v1\/media\/[0-9a-f-]{36}$/);
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    await expect(body.getByRole('link', { name: '남는 링크' })).toHaveAttribute(
      'href',
      'https://example.com/kept',
    );
    await expect(body.locator('a', { hasText: '상대 주소' })).toHaveCount(0);
    await expect(body).toContainText('상대 주소 · 맨 주소');
    await expect(page.getByTestId('post-edited')).toHaveCount(0);
    // The byline: the author's current nickname (#37-3), no '운영자' for a member (#45-9).
    await expect(page.getByTestId('post-author-name')).toHaveText(me.profile.nickname);
    await expect(page.getByTestId('post-author-admin')).toHaveCount(0);
    await expect(page.getByTestId('post-market-link')).toHaveAttribute(
      'href',
      `/markets/${market.slug}`,
    );

    // --- the community list: by search (title and text), by market, by category.
    await page.goto('/community');
    await page.getByTestId('community-search-input').fill(tag);
    await page.getByTestId('community-search-submit').click();
    await expect(page).toHaveURL(`/community?q=${tag}`);
    await expect(card(page, postId)).toBeVisible();
    await expect(card(page, postId).getByTestId('post-card-market')).toHaveText(market.title);
    await expect(card(page, postId).getByTestId('post-card-excerpt')).toContainText('굵은 근거');
    await expect(card(page, postId).getByTestId('post-card-thumbnail')).toBeVisible();
    await expect(card(page, postId).getByTestId('post-author-name')).toHaveText(
      me.profile.nickname,
    );
    // The market filter: picked by its title in the list's own picker, then cleared.
    await page.goto('/community');
    await page.getByTestId('community-market-pick').click();
    await pickMarket(page, 'community-market-picker', market);
    await expect(page).toHaveURL(`/community?market=${market.id}`);
    await expect(page.getByTestId('community-market-filter')).toContainText(market.title);
    await expect(card(page, postId)).toBeVisible();
    await page.getByTestId('community-market-clear').click();
    await expect(page).toHaveURL('/community');
    await expect(page.getByTestId('community-market-filter')).toHaveCount(0);
    await page.goto(`/community?market=${other.id}`);
    await expect(page.getByTestId('community-empty')).toHaveText(copy.communityEmptyFiltered);
    // The category select, within a search: the market's top-level category finds it, another
    // one does not.
    await page.goto(`/community?q=${tag}`);
    await page.getByTestId('community-category').selectOption(market.categorySlug);
    await expect(page).toHaveURL(new RegExp(`[?&]category=${market.categorySlug}(&|$)`));
    await expect(page).toHaveURL(new RegExp(`[?&]q=${tag}(&|$)`));
    await expect(card(page, postId)).toBeVisible();
    await page.getByTestId('community-category').selectOption(other.categorySlug);
    await expect(page).toHaveURL(new RegExp(`[?&]category=${other.categorySlug}(&|$)`));
    await expect(page.getByTestId('community-empty')).toBeVisible();
    // The card opens the post.
    await page.goto(`/community?q=${tag}`);
    await card(page, postId).getByTestId('post-card-link').click();
    await expect(page).toHaveURL(`/community/posts/${postId}`);

    // --- edit: the title and the body, never the market; '수정됨' (#45-4).
    await page.getByTestId('post-edit').click();
    await expect(page).toHaveURL(`/community/posts/${postId}/edit`);
    await expectNotIndexed(page);
    await expect(page.getByTestId('post-edit-market')).toHaveText(market.title);
    await expect(page.getByTestId('post-editor-content')).toContainText('굵은 근거');
    await page.getByTestId('post-title-input').fill(`고친 근거 ${tag}`);
    await page.getByTestId('post-submit').click();
    await expect(page).toHaveURL(`/community/posts/${postId}`);
    await expect(page.getByTestId('post-title')).toHaveText(`고친 근거 ${tag}`);
    await expect(page.getByTestId('post-edited')).toHaveText(copy.postEdited);
    await page.goto(`/community?q=${tag}`);
    await expect(card(page, postId).getByTestId('post-edited')).toBeVisible();

    // --- delete: asked first, then gone from the list, and its page is a 404 (#45-5: nothing
    // hangs under it before comments exist).
    await page.goto(`/community/posts/${postId}`);
    await page.getByTestId('post-delete').click();
    await page.getByTestId('post-delete-confirm').click();
    await expect(page).toHaveURL('/community');
    await page.goto(`/community?q=${tag}`);
    await expect(page.getByTestId('community-empty')).toBeVisible();
    const gone = await page.goto(`/community/posts/${postId}`);
    expect(gone?.status()).toBe(404);
  });

  test('로그인하지 않은 방문자는 목록과 글을 읽고(마감된 시장의 글도), 시장 링크로 상세에 가고, 글쓰기에서는 로그인 안내를 받는다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await closeMarket(admin, market.id);
    const tag = freshTag();
    await signUp(page, freshEmail());
    // A closed market takes a post too (#45-6: every public status), and the picker offers it.
    await page.goto('/community');
    await page.getByTestId('community-write').click();
    await pickMarket(page, 'post-write-market-picker', market);
    await expect(page).toHaveURL(`/community/write?market=${market.id}`);
    await expect(page.getByTestId('post-write-market-title')).toHaveText(market.title);
    const postId = await postThroughApi(page.request, market.id, `마감 뒤 근거 ${tag}`, tag);
    // An admin's post, without a title: '운영자' on it (#45-9).
    const adminPostId = await postThroughApi(admin, market.id, null, `${tag} 운영`);
    // The author sees 수정 and 삭제 on their own post.
    await page.goto(`/community/posts/${postId}`);
    await expect(page.getByTestId('post-author-actions')).toBeVisible();
    await logOut(page);

    await page.goto(`/community?q=${tag}`);
    // Neither the list nor a post page is for search engines (owner decision 2026-10-19).
    await expectNotIndexed(page);
    await expect(card(page, postId)).toBeVisible();
    await expect(card(page, postId).getByTestId('post-author-admin')).toHaveCount(0);
    // The admin's card: '운영자', and its first line as the heading a screen reader lists.
    const adminCard = card(page, adminPostId);
    await expect(adminCard.getByTestId('post-author-admin')).toHaveText(copy.postAuthorAdmin);
    await expect(adminCard.getByRole('heading', { name: `${tag} 운영 출처` })).toHaveCount(1);
    await page.goto(`/community/posts/${adminPostId}`);
    await expect(page.getByTestId('post-author-admin')).toHaveText(copy.postAuthorAdmin);
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: `${tag} 운영 출처` })).toHaveCount(1);
    await page.goto(`/community?q=${tag}`);
    await card(page, postId).getByTestId('post-card-link').click();
    await expect(page).toHaveURL(`/community/posts/${postId}`);
    await expectNotIndexed(page);
    await expect(page.getByTestId('post-title')).toHaveText(`마감 뒤 근거 ${tag}`);
    await expect(page.getByTestId('post-body').locator('em')).toHaveText(tag);
    const link = page.getByTestId('post-body').getByRole('link', { name: '출처' });
    await expect(link).toHaveAttribute('href', 'https://example.com/source');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(page.getByTestId('post-author-actions')).toHaveCount(0);

    // The market's link opens its detail although it is closed (#46's acceptance criteria).
    await page.getByTestId('post-market-link').click();
    await expect(page).toHaveURL(`/markets/${market.slug}`);
    await expect(page.getByRole('heading', { level: 2, name: market.title })).toBeVisible();

    // 글쓰기 asks a visitor to sign in, and comes back to the same market.
    await page.goto('/community');
    await page.getByTestId('community-write').click();
    await expect(page).toHaveURL('/community/write');
    await expect(page.getByTestId('post-write-signed-out')).toBeVisible();
    await page.goto(`/community/write?market=${market.id}`);
    await expect(page.getByTestId('post-write-login')).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent(`/community/write?market=${market.id}`)}`,
    );
    await expect(page.getByTestId('post-editor')).toHaveCount(0);
  });

  test('쓰던 글을 두고 머리의 링크나 뒤로 가기로 떠나면 먼저 묻고, 머무르면 글이 그대로이고, 나가면 떠난다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    // Into the write screen within the app, so Back is the app's own (`popstate`), not another
    // document's (`beforeunload`, the browser's dialog).
    await page.goto('/community');
    await page.getByTestId('community-write').click();
    await pickMarket(page, 'post-write-market-picker', market);
    const write = `/community/write?market=${market.id}`;
    await expect(page).toHaveURL(write);
    const asked: string[] = [];
    const answer = (accept: boolean) => {
      page.once('dialog', (dialog) => {
        asked.push(`${dialog.type()}: ${dialog.message()}`);
        void (accept ? dialog.accept() : dialog.dismiss());
      });
    };
    const question = `confirm: ${copy.postLeaveConfirm}`;
    // The wordmark in the header, a Next.js link on every screen and both widths.
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');

    // --- a draft: a title and a line of the body.
    await page.getByTestId('post-title-input').fill('떠나기 전 제목');
    const editor = page.getByTestId('post-editor-content');
    await editor.click();
    await page.keyboard.type('쓰던 근거');

    // --- the header link, refused: still here, the draft as it was.
    answer(false);
    await home.click();
    await expect.poll(() => asked).toEqual([question]);
    await expect(page).toHaveURL(write);
    await expect(page.getByTestId('post-title-input')).toHaveValue('떠나기 전 제목');
    await expect(editor).toContainText('쓰던 근거');

    // --- Back, refused: the address returns to the screen and the draft stays.
    answer(false);
    await page.evaluate(() => {
      window.history.back();
    });
    await expect.poll(() => asked).toEqual([question, question]);
    await expect(page).toHaveURL(write);
    await expect(page.getByTestId('post-title-input')).toHaveValue('떠나기 전 제목');
    await expect(editor).toContainText('쓰던 근거');

    // --- Back, allowed: the router takes the step it was held from — the community list.
    answer(true);
    await page.evaluate(() => {
      window.history.back();
    });
    await expect(page).toHaveURL('/community');
    await expect(page.getByTestId('community-write')).toBeVisible();
    expect(asked).toEqual([question, question, question]);

    // --- a draft again, and the header link allowed: gone to the home screen.
    await page.getByTestId('community-write').click();
    await pickMarket(page, 'post-write-market-picker', market);
    await expect(page).toHaveURL(write);
    await page.getByTestId('post-title-input').fill('다시 쓴 제목');
    answer(true);
    await home.click();
    await expect(page).toHaveURL('/');
    expect(asked).toEqual([question, question, question, question]);

    // --- an empty screen asks nothing (an unexpected dialog would be dismissed and keep us).
    await page.goto(write);
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    await expect(page.getByTestId('post-title-input')).toBeVisible();
    await home.click();
    await expect(page).toHaveURL('/');
    expect(asked).toHaveLength(4);
  });

  test('제목 없이 본문만 쓴 글과 수정 화면도 떠나기 전에 묻고, 고치지 않은 수정 화면은 본문을 눌러도 묻지 않는다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    // Every dialog is recorded and answered from `answers` — dismissed when none was expected, which
    // keeps the page where it is and fails the address the step expects.
    const asked: string[] = [];
    const answers: boolean[] = [];
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void (answers.shift() === true ? dialog.accept() : dialog.dismiss());
    });
    const question = `confirm: ${copy.postLeaveConfirm}`;
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');
    const editor = page.getByTestId('post-editor-content');

    // --- the write screen, the body only (the title is optional, #45-1): the body alone asks.
    const write = `/community/write?market=${market.id}`;
    await page.goto(write);
    await editor.click();
    await page.keyboard.type('제목 없는 근거');
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([question]);
    await expect(page).toHaveURL(write);
    await expect(editor).toContainText('제목 없는 근거');
    await expect(page.getByTestId('post-title-input')).toHaveValue('');
    answers.push(true);
    await home.click();
    await expect(page).toHaveURL('/');

    // --- the edit screen of a post whose body ends in a heading — a body the API took from
    // elsewhere; the editor adds an empty paragraph after it on its first transaction, a focus too.
    const postId = await postThroughApi(page.request, market.id, '고칠 글', '고칠 근거', [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '맺음' }] },
    ]);
    const edit = `/community/posts/${postId}/edit`;
    await page.goto(edit);
    await expect(editor).toContainText('맺음');
    // Into the body and out, nothing typed: nothing to lose, nothing asked.
    await editor.click();
    await home.click();
    await expect(page).toHaveURL('/');
    expect(asked).toEqual([question, question]);

    // --- the edit screen with the body changed: asks, and a refusal keeps the change.
    await page.goto(edit);
    await editor.click();
    await page.keyboard.type('더한 근거');
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([question, question, question]);
    await expect(page).toHaveURL(edit);
    await expect(editor).toContainText('더한 근거');
  });

  test('Navigation API가 없는 브라우저에서도 앞으로 가기와 여러 칸 뒤로 가기를 묻고, 머무르면 주소가 쓰기 화면으로 돌아온다', async ({
    admin,
    page,
  }) => {
    // A browser without the Navigation API (older Safari and Firefox): the guard
    // measures a move by the numbers it writes into the entries' state.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'navigation', { value: undefined, configurable: true });
    });
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const asked: string[] = [];
    const answers: boolean[] = [];
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void (answers.shift() === true ? dialog.accept() : dialog.dismiss());
    });
    const question = `confirm: ${copy.postLeaveConfirm}`;
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');
    const title = page.getByTestId('post-title-input');
    const traverse = (delta: number) =>
      page.evaluate((by) => {
        window.history.go(by);
      }, delta);

    // Three entries of one document — the list, a search, the write screen — and one ahead of it.
    await page.goto('/community');
    expect(
      await page.evaluate(() => (window as { navigation?: unknown }).navigation),
    ).toBeUndefined();
    const tag = freshTag();
    await page.getByTestId('community-search-input').fill(tag);
    await page.getByTestId('community-search-submit').click();
    await expect(page).toHaveURL(`/community?q=${tag}`);
    await page.getByTestId('community-write').click();
    await pickMarket(page, 'post-write-market-picker', market);
    const write = `/community/write?market=${market.id}`;
    await expect(page).toHaveURL(write);
    await home.click();
    await expect(page).toHaveURL('/');
    await traverse(-1);
    await expect(page).toHaveURL(write);
    await title.fill('떠나기 전 제목');

    // Forward, refused: back to the write screen — not further forward, where nothing is.
    answers.push(false);
    await traverse(1);
    await expect.poll(() => asked).toEqual([question]);
    await expect(page).toHaveURL(write);
    await expect(title).toHaveValue('떠나기 전 제목');
    // Two back at once, refused: forward by two.
    answers.push(false);
    await traverse(-2);
    await expect.poll(() => asked).toEqual([question, question]);
    await expect(page).toHaveURL(write);
    await expect(title).toHaveValue('떠나기 전 제목');
    // Back, allowed: the router takes it to the search.
    answers.push(true);
    await traverse(-1);
    await expect(page).toHaveURL(`/community?q=${tag}`);
    await expect(page.getByTestId('community-write')).toBeVisible();
    expect(asked).toEqual([question, question, question]);
  });
});
