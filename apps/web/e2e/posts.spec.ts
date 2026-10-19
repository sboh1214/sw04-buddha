import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Me } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  E2E_PASSWORD,
  closeMarket,
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
 * a jump back in a browser without the Navigation API too. An author with an onboarding step left
 * — a re-consent — still opens their post and deletes it, and its 수정 goes through the step first;
 * a draft the onboarding gate takes the writer away from is kept in the tab without asking and
 * comes back, formatting and image, once the step is done, the notice focused — on the edit
 * screen too, where discarding it puts the saved post back (what was typed after the restore goes
 * with it, ADR-0073 결과 4의 2) and focuses the title; signing out from the step removes it (owner
 * decisions 2026-10-20). No spec can bring about a
 * re-consent for real (the consent versions are the build's), so `GET /me` says it in the browser
 * (`asReconsent`), as onboarding.spec.ts draws it.
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

/**
 * `GET /me` in this page answering as the server would after a revision of the terms that changed
 * members' rights (오너 결정 2026-10-19 (2차) 1): the terms agreement no longer stands, so the
 * consent step is the account's next — while `on`. Agreeing on that step turns it off, as the
 * server's own answer then says nothing is left. The account itself has finished its onboarding,
 * so the server takes its writes; what this shows is the screens' side (onboarding.spec.ts draws
 * the re-consent the same way).
 */
async function asReconsent(page: Page): Promise<{ on: boolean }> {
  const state = { on: false };
  await page.route('**/api/v1/me', async (route) => {
    if (route.request().method() !== 'GET' || !state.on) return route.fallback();
    const response = await route.fetch();
    // Signed out (a spec that signs out with it on): a 401, no account to draw it for.
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

/** The consent step of a re-consent, agreed on screen: 전체 동의, then 동의하고 계속하기. */
async function agreeAgain(page: Page): Promise<void> {
  await expect(page.getByTestId('onboarding-return-reason')).toHaveText(
    copy.onboardingReconsentReason,
  );
  await page.getByTestId('consent-all').click();
  await page.getByTestId('consent-submit').click();
}

/** A write refused as the server refuses an account with a step left (409 ONBOARDING_REQUIRED). */
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

/** The post drafts kept in this tab's sessionStorage (lib/post-drafts.ts), by storage key. */
function draftsInTab(page: Page): Promise<Record<string, { previews: Record<string, string> }>> {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.keys(sessionStorage)
        .filter((key) => key.startsWith('buddha.postDraft:'))
        .map((key) => [
          key,
          JSON.parse(sessionStorage.getItem(key) ?? '{}') as { previews: Record<string, string> },
        ]),
    ),
  );
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

  test('온보딩 단계가 남은 작성자(재동의)도 자기 글 화면을 열어 지우고, 그 화면의 수정은 남은 단계를 거쳐 수정 화면으로 간다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const tag = freshTag();
    const postId = await postThroughApi(page.request, market.id, `지울 글 ${tag}`, '지울 근거');
    const postPage = `/community/posts/${postId}`;
    const edit = `${postPage}/edit`;
    const viaStep = `/onboarding?next=${encodeURIComponent(edit)}`;
    const reconsent = await asReconsent(page);

    // --- the post page opens for an account with a step left (오너 결정 2026-10-20): not sent
    // on, the author's own 수정 and 삭제 on it.
    reconsent.on = true;
    await page.goto(postPage);
    await expect(page.getByTestId('post-title')).toHaveText(`지울 글 ${tag}`);
    await expect(page.getByTestId('post-delete')).toBeVisible();
    await expect(page).toHaveURL(postPage);
    // 수정 is the remaining step, which comes back to the edit screen.
    await expect(page.getByTestId('post-edit')).toHaveAttribute('href', viaStep);
    // Everything else stays gated: the edit screen and the community list send it on.
    await page.goto(edit);
    await expect(page).toHaveURL(viaStep);
    await page.goto('/community');
    await expect(page).toHaveURL(`/onboarding?next=${encodeURIComponent('/community')}`);

    // --- 수정: the step, then the edit screen.
    await page.goto(postPage);
    await page.getByTestId('post-edit').click();
    await expect(page).toHaveURL(viaStep);
    await agreeAgain(page);
    await expect(page).toHaveURL(edit);
    await expect(page.getByTestId('post-form')).toBeVisible();

    // --- the consent asked for again: 삭제 with a session alone (오너 결정 2026-10-19 답 2).
    reconsent.on = true;
    await page.goto(postPage);
    await expect(page.getByTestId('post-delete')).toBeVisible();
    await expect(page).toHaveURL(postPage);
    await page.getByTestId('post-delete').click();
    await page.getByTestId('post-delete-confirm').click();
    // Gone; the community list it then goes to is gated, so the step comes first.
    await expect(page).toHaveURL(`/onboarding?next=${encodeURIComponent('/community')}`);
    expect((await page.request.get(`/api/v1/posts/${postId}`)).status()).toBe(404);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('쓰던 글에서 온보딩 게이트가 남은 단계로 보내면 묻지 않고 이 탭에 두었다가, 단계를 마치고 돌아오면 서식과 이미지까지 되살린다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const tag = freshTag();
    const asked: string[] = [];
    const answers: boolean[] = [];
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void (answers.shift() === true ? dialog.accept() : dialog.dismiss());
    });
    const question = `confirm: ${copy.postLeaveConfirm}`;
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');
    const reconsent = await asReconsent(page);
    const write = `/community/write?market=${market.id}`;

    // --- a draft: a title, formatted text and an image.
    await page.goto(write);
    await page.getByTestId('post-title-input').fill(`되살릴 제목 ${tag}`);
    const editor = page.getByTestId('post-editor-content');
    await editor.click();
    await page.getByTestId('post-editor-bold').click();
    await page.keyboard.type('굵은 근거');
    await page.getByTestId('post-editor-bold').click();
    await page.keyboard.type(' 이어 쓴 근거');
    await page
      .getByTestId('post-editor-file')
      .setInputFiles({ name: 'evidence.png', mimeType: 'image/png', buffer: PNG });
    await expect(editor.locator('img[data-media-id]')).toHaveCount(1);
    const mediaId = await editor.locator('img[data-media-id]').getAttribute('data-media-id');
    expect(mediaId).toMatch(/^[0-9a-f-]{36}$/);

    // --- the write refused for the onboarding: a revision asked for the consent again meanwhile.
    await page.route('**/api/v1/posts', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      reconsent.on = true;
      await route.fulfill(ONBOARDING_REFUSAL);
    });
    await page.getByTestId('post-submit').click();
    // The gate takes the account to its step and asks nothing: the draft is kept in this tab.
    await expect(page).toHaveURL(`/onboarding?next=${encodeURIComponent(write)}`);
    await expect(page.getByTestId('consent-step')).toBeVisible();
    expect(asked).toEqual([]);
    const kept = await draftsInTab(page);
    expect(Object.keys(kept)).toEqual([`buddha.postDraft:new:${market.id}`]);
    expect(kept[`buddha.postDraft:new:${market.id}`]?.previews[mediaId ?? '']).toMatch(
      /^data:image\/(webp|jpeg);base64,/,
    );

    // --- the step done: back on the write screen, the draft taken back and said so.
    await agreeAgain(page);
    await expect(page).toHaveURL(write);
    const notice = page.getByTestId('post-draft-restored');
    await expect(notice).toContainText(copy.postDraftRestored);
    // Focused, so a screen reader says it (it appears with its text in it), named by its sentence.
    await expect(notice).toBeFocused();
    await expect(notice).toHaveAccessibleName(copy.postDraftRestored);
    await expect(page.getByTestId('post-title-input')).toHaveValue(`되살릴 제목 ${tag}`);
    await expect(editor.locator('strong')).toHaveText('굵은 근거');
    await expect(editor).toContainText('이어 쓴 근거');
    // The upload is not served before a post shows it: drawn from the preview the draft kept.
    const image = editor.locator(`img[data-media-id="${mediaId ?? ''}"]`);
    await expect(image).toHaveAttribute('src', /^data:image\//);
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    // Taken back, it is the form's again — gone from the storage, and guarded like any draft.
    expect(await draftsInTab(page)).toEqual({});
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([question]);
    await expect(page).toHaveURL(write);

    // --- sent: the post holds it all, and nothing is kept.
    await page.unroute('**/api/v1/posts');
    await page.getByTestId('post-submit').click();
    await expect(page).toHaveURL(/\/community\/posts\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('post-title')).toHaveText(`되살릴 제목 ${tag}`);
    const body = page.getByTestId('post-body');
    await expect(body.locator('strong')).toHaveText('굵은 근거');
    await expect(body.getByTestId('post-image')).toHaveAttribute(
      'src',
      `/api/v1/media/${mediaId ?? ''}`,
    );
    expect(await draftsInTab(page)).toEqual({});
    expect(asked).toEqual([question]);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('수정 화면의 쓰던 글도 게이트를 지나 되살리고, 되살린 내용을 버리면 저장된 글로 돌아가 묻지 않고 떠난다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const postId = await postThroughApi(page.request, market.id, '저장된 제목', '저장된 근거');
    const edit = `/community/posts/${postId}/edit`;
    const asked: string[] = [];
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');
    const reconsent = await asReconsent(page);
    const title = page.getByTestId('post-title-input');
    const editor = page.getByTestId('post-editor-content');

    // --- an edit under way, its save refused for the onboarding.
    await page.goto(edit);
    await expect(editor).toContainText('저장된 근거');
    await title.fill('고치던 제목');
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 고치던 근거');
    await page.route(`**/api/v1/posts/${postId}`, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      reconsent.on = true;
      await route.fulfill(ONBOARDING_REFUSAL);
    });
    await page.getByTestId('post-submit').click();
    await expect(page).toHaveURL(`/onboarding?next=${encodeURIComponent(edit)}`);
    expect(asked).toEqual([]);
    expect(Object.keys(await draftsInTab(page))).toEqual([`buddha.postDraft:edit:${postId}`]);

    // --- back on the edit screen once agreed: the edit taken back.
    await agreeAgain(page);
    await expect(page).toHaveURL(edit);
    await expect(page.getByTestId('post-draft-restored')).toBeVisible();
    await expect(title).toHaveValue('고치던 제목');
    await expect(editor).toContainText('고치던 근거');
    // Written on after the restore: the notice and its discard stay.
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 되살린 뒤 쓴 근거');
    await expect(editor).toContainText('되살린 뒤 쓴 근거');
    await expect(page.getByTestId('post-draft-discard')).toBeVisible();

    // --- discarded: the saved post again — what was typed after the restore goes too, without
    // asking (as built, ADR-0073 결과 4의 2 asks the owner) — nothing to lose, so leaving asks
    // nothing; the focus is on the redrawn title, not lost with the button.
    await page.getByTestId('post-draft-discard').click();
    await expect(page.getByTestId('post-draft-restored')).toHaveCount(0);
    await expect(title).toHaveValue('저장된 제목');
    await expect(title).toBeFocused();
    await expect(editor).toContainText('저장된 근거');
    await expect(editor).not.toContainText('고치던 근거');
    await expect(editor).not.toContainText('되살린 뒤 쓴 근거');
    expect(asked).toEqual([]);
    expect(await draftsInTab(page)).toEqual({});
    await home.click();
    await expect(page).toHaveURL('/');
    expect(asked).toEqual([]);
    // Nothing was saved.
    const saved = (await (await page.request.get(`/api/v1/posts/${postId}`)).json()) as {
      data: { title: string | null; editedAt: string | null };
    };
    expect(saved.data).toMatchObject({ title: '저장된 제목', editedAt: null });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('게이트가 이 탭에 둔 쓰던 글은 단계에서 로그아웃하면 지워져, 같은 계정이 다시 로그인해도 되살아나지 않는다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const email = freshEmail();
    await signUp(page, email);
    const reconsent = await asReconsent(page);
    const write = `/community/write?market=${market.id}`;

    // --- a draft, kept by the gate when its write is refused for the onboarding.
    await page.goto(write);
    await page.getByTestId('post-title-input').fill('로그아웃 전에 쓰던 제목');
    await page.getByTestId('post-editor-content').click();
    await page.keyboard.type('로그아웃 전에 쓰던 근거');
    await page.route('**/api/v1/posts', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      reconsent.on = true;
      await route.fulfill(ONBOARDING_REFUSAL);
    });
    await page.getByTestId('post-submit').click();
    await expect(page).toHaveURL(`/onboarding?next=${encodeURIComponent(write)}`);
    expect(Object.keys(await draftsInTab(page))).toEqual([`buddha.postDraft:new:${market.id}`]);

    // --- 로그아웃 on the step: the tab's kept drafts go with the session (useSignOut).
    await page.getByTestId('onboarding-logout').click();
    await expect(page).toHaveURL('/');
    expect(await draftsInTab(page)).toEqual({});

    // --- the same account back in this tab, nothing left: the write screen is a fresh one.
    reconsent.on = false;
    await signIn(page, email, E2E_PASSWORD);
    await page.goto(write);
    await expect(page.getByTestId('post-form')).toBeVisible();
    await expect(page.getByTestId('post-draft-restored')).toHaveCount(0);
    await expect(page.getByTestId('post-title-input')).toHaveValue('');
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
});
