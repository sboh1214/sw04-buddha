import { crc32, deflateSync } from 'node:zlib';
import { type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test';
import type { Me } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  E2E_PASSWORD,
  agreeOnScreen,
  closeMarket,
  completeOnboardingThroughApi,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  logOut,
  meOf,
  membersSwitchingSessions,
  membersTurningInPlace,
  setFirstPassword,
  signIn,
  signUp,
  test,
  verificationLink,
} from './helpers';

/**
 * 근거 글과 커뮤니티 (#46, ADR-0073; owner decisions in ADR-0069 decision 2, #45, and of
 * 2026-10-18): a member opens 글쓰기 from the community list, picks a market by its title, changes
 * it before sending without losing the draft, writes a formatted post with an image (a pasted link
 * the post would not keep is not shown as one; the photo drawn from a small copy of it until the
 * post is saved, the post then serving it whole), finds it in the community list through its
 * search,
 * market filter and category controls, sees their current nickname on it, edits it ('수정됨') and
 * deletes it (gone from the list, its page 404). The picker offers a closed market too (#45-6). A
 * visitor reads the list and a post — on a closed market too, whose link still opens the market's
 * detail, and an admin's untitled post with its '운영자' mark — and is asked to sign in to write.
 * None of the community's screens is for search engines (noindex), and leaving a draft asks first —
 * a refusal keeps it, an answer of yes leaves (owner decisions 2026-10-19): a body without a title,
 * the edit screen (where an untouched body asks nothing, a click into it included), and Forward and
 * a jump back in a browser without the Navigation API too. An author facing a re-consent still
 * opens their post and deletes it, and its 수정 goes through the step first;
 * a draft the onboarding gate takes the writer away from is kept in the tab without asking and
 * comes back, formatting and image, once the step is done, the notice focused — on the edit
 * screen too, where discarding it always asks first (a dismissal keeps it all) and then puts the
 * saved post back (what was typed after the restore goes with it), says so in a toast — on screen,
 * and once to screen readers — and focuses the title; signing out from the step removes it (owner
 * decisions 2026-10-20). A new
 * account that signs up or signs in from a post page is not let stay on it with its steps left:
 * the gate takes it to its first step and the onboarding brings it back to the post (오너 결정
 * 2026-10-20 3차 답 1). No spec can bring about a re-consent for real (the consent versions are
 * the build's), so `GET /me` says it in the browser (`asReconsent`), as onboarding.spec.ts draws
 * it. An image upload refused for the onboarding takes the writer to the step as a refused send
 * does, saying nothing, and one refused as another account reads the session again — either way
 * the rest of the batch is not sent; one the API asks to send again later (a 429 of the upload
 * route — its memory, the uploads it receives — naming a wait of at most 10 seconds) stays
 * uploading — '이미지를 올리는 중' up, '이미지 n / 10장' as it was, the form's submit held — and
 * is sent again after that wait, twice at most, and only a third refusal is that file's failure
 * alone (owner decisions 2026-10-22 (2차) answer 3 and (3차)); a writer who leaves during such a
 * wait is asked first, and once gone the file is not sent again and nothing is said; images
 * picked while others upload count those too — and so does '이미지 n / 10장' — so a post never
 * takes more than ten, and an image refused or failed gives its place back (owner decisions
 * 2026-10-21); and an image the API asked to read again later (429) is drawn once it can be — a
 * post's and a card's — but asked for three times at most (ADR-0073 결과 5, Codex review of #219).
 * A post its author deletes in another tab turns its open page into the 404 once a read says it is
 * gone — a read that fails otherwise keeps the post — and its open edit screen too, once a save is
 * refused for it (ADR-0073 9-50); an image still uploading there then goes into the held body
 * after the selected line, the line as it was — one waiting out a 429 too, sent again — and the
 * files waiting their turn are not sent (오너 결정 2026-10-25 (2차), 9-53); a line selected in
 * the held body stays selected, without the image.
 * The allow-list, the image checks, the permissions and the paging are the API's and the shared
 * package's tests; this walks the screens.
 */

/** A 1×1 PNG, as a phone would never send but sharp reads like any other. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A PNG of one colour, `width`×`height`: larger than the editor's preview of an upload (640px on
 * the longer side), a few KB on the wire.
 */
function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  // Each row: filter 0 (none), then its pixels.
  const row = Buffer.alloc(1 + width * 3, 0x5a);
  row[0] = 0;
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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

/** `count` PNG files for the editor's picker, named from `first` on. */
const pngFiles = (count: number, first = 1) =>
  Array.from({ length: count }, (_, index) => ({
    name: `evidence-${String(first + index)}.png`,
    mimeType: 'image/png',
    buffer: PNG,
  }));

/** The toaster's region (components/ui/toaster.tsx — zag's toast group), mounted with the app. */
const toastsOf = (page: Page) => page.locator('body > [data-scope="toast"][data-part="group"]');

/** Long enough for a request the screen would send next (a batch's next upload) to have left. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 1_000));

/**
 * The editor made and taking keys: editable, and TipTap's `create` run (its root element keeps the
 * editor — for tests, TipTap says). A step that types into it at once and relies on the form
 * counting that as a change waits for this, not on how soon the editor shows its text.
 */
async function editorReady(editor: Locator): Promise<void> {
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect
    .poll(() =>
      editor.evaluate(
        (root) =>
          (root as HTMLElement & { editor?: { isInitialized?: boolean } }).editor?.isInitialized ===
          true,
      ),
    )
    .toBe(true);
}

/** `ms` of the page's own wait gone by, for what the screen shows in the middle of it. */
const partOf = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    // A photo larger than the editor's preview: drawn from a small copy of it, not from the file
    // itself, until the post is saved (Codex review of #219, round 2).
    await page
      .getByTestId('post-editor-file')
      .setInputFiles({ name: 'evidence.png', mimeType: 'image/png', buffer: solidPng(1200, 900) });
    await expect(editor.locator('img[data-media-id]')).toHaveCount(1);
    await expect(page.getByTestId('post-body-images')).toContainText('1 / 10');
    const preview = editor.locator('img[data-media-id]');
    await expect(preview).toHaveAttribute('src', /^data:image\/(webp|jpeg);base64,/);
    await expect
      .poll(() =>
        preview.evaluate((img: HTMLImageElement) =>
          img.complete ? [img.naturalWidth, img.naturalHeight] : null,
        ),
      )
      .toEqual([640, 480]);
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
    // The saved post serves the image the API stored: the photo at its own size.
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0)))
      .toBe(1200);
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

  test('재동의가 남은 작성자도 자기 글 화면을 열어 지우고, 그 화면의 수정은 남은 단계를 거쳐 수정 화면으로 간다', async ({
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

    // --- the post page opens for an account that finished once and faces a re-consent alone
    // (오너 결정 2026-10-20): not sent on, the author's own 수정 and 삭제 on it.
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

  test('근거 글 화면에서 가입하거나 로그인한 새 계정은 그 화면에 머물지 않고 남은 단계로 가며, 단계를 마치면 그 글로 돌아온다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const postId = await postThroughApi(admin, market.id, `가입 전에 읽던 글 ${tag}`, '읽던 근거');
    const postPage = `/community/posts/${postId}`;
    const viaStep = `/onboarding?next=${encodeURIComponent(postPage)}`;

    // --- a visitor on the post signs up from the header; the post rides along (#57-9).
    await page.goto(postPage);
    await expect(page.getByTestId('post-title')).toHaveText(`가입 전에 읽던 글 ${tag}`);
    await page.getByRole('link', { name: copy.signup }).first().click();
    await expect(page).toHaveURL(`/signup?next=${encodeURIComponent(postPage)}`);
    const email = freshEmail();
    await page.getByLabel(copy.email).fill(email);
    await page.getByRole('button', { name: copy.signupWithEmail }).click();
    await expect(page.getByTestId('signup-check-mail')).toBeVisible();
    await page.goto(await verificationLink(email));
    await expect(page).toHaveURL(`/set-password?next=${encodeURIComponent(postPage)}`);
    await setFirstPassword(page);
    // The post page, then the gate: the exemption is a re-consent's, not a new account's (오너 결정
    // 2026-10-20 3차 답 1) — the first step, carrying the post.
    await expect(page).toHaveURL(viaStep);
    await expect(page.getByTestId('consent-step')).toBeVisible();
    await expect(page.getByTestId('onboarding-return-reason')).toHaveCount(0);

    // --- left on the step, signed in again from the post with the steps still left: the same.
    await page.getByTestId('onboarding-logout').click();
    await expect(page).toHaveURL('/');
    await page.goto(postPage);
    await page.getByRole('link', { name: copy.login }).first().click();
    await expect(page).toHaveURL(`/login?next=${encodeURIComponent(postPage)}`);
    await page.getByLabel(copy.email).fill(email);
    await page.getByLabel(copy.password, { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: copy.loginWithEmail }).click();
    await expect(page).toHaveURL(viaStep);
    await expect(page.getByTestId('consent-step')).toBeVisible();
    // Not even after the consent: agreed once but never finished is not a re-consent.
    await agreeOnScreen(page);
    await page.goto(postPage);
    await expect(page).toHaveURL(viaStep);
    await expect(page.getByTestId('verification-step')).toBeVisible();

    // --- the steps done: the onboarding goes on to the post.
    await completeOnboardingThroughApi(page.request);
    await page.reload();
    await expect(page).toHaveURL(postPage);
    await expect(page.getByTestId('post-title')).toHaveText(`가입 전에 읽던 글 ${tag}`);
    await expect(page.getByTestId('onboarding-gate')).toHaveCount(0);
  });

  test('쓰던 글에서 온보딩 게이트가 남은 단계로 보내면 묻지 않고 이 탭에 두었다가, 단계를 마치고 돌아오면 서식과 이미지까지 되살린다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const accountId = (await meOf(page.request)).id;
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
    // The screen's item for the account that wrote it (ADR-0092 답 2).
    const keptKey = `buddha.postDraft:new:${market.id}@${accountId}`;
    expect(Object.keys(kept)).toEqual([keptKey]);
    expect(kept[keptKey]?.previews[mediaId ?? '']).toMatch(/^data:image\/(webp|jpeg);base64,/);

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

  test('수정 화면의 쓰던 글도 게이트를 지나 되살리고, 되살린 내용 버리기는 늘 먼저 물어 취소하면 그대로, 버리면 저장된 글로 돌아가 알리고 묻지 않고 떠난다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const accountId = (await meOf(page.request)).id;
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
    expect(Object.keys(await draftsInTab(page))).toEqual([
      `buddha.postDraft:edit:${postId}@${accountId}`,
    ]);

    // --- back on the edit screen once agreed: the edit taken back.
    await agreeAgain(page);
    await expect(page).toHaveURL(edit);
    await expect(page.getByTestId('post-draft-restored')).toBeVisible();
    await expect(title).toHaveValue('고치던 제목');
    await expect(editor).toContainText('고치던 근거');
    const discard = page.getByTestId('post-draft-discard');
    const dialog = page.getByTestId('post-draft-discard-dialog');
    // The sentence a discard says, wherever it is (a toast once discarded, nowhere before).
    const discarded = page.getByText(copy.postDraftDiscarded);
    // The toaster's region (components/ui/toaster.tsx — zag's toast group), mounted with the app.
    const toasts = page.locator('body > [data-scope="toast"][data-part="group"]');
    // Nothing typed since the restore: the discard still asks first (3차 답 3 — always, not only
    // once something was written after the restore), and dismissed it keeps the draft.
    await discard.click();
    await expect(dialog).toBeVisible();
    await expect(title).toHaveValue('고치던 제목');
    await expect(editor).toContainText('고치던 근거');
    await page.getByTestId('post-draft-discard-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(discard).toBeFocused();
    await expect(page.getByTestId('post-draft-restored')).toBeVisible();
    await expect(title).toHaveValue('고치던 제목');
    await expect(editor).toContainText('고치던 근거');
    await expect(discarded).toHaveCount(0);
    // Written on after the restore: the notice and its discard stay.
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 되살린 뒤 쓴 근거');
    await expect(editor).toContainText('되살린 뒤 쓴 근거');
    await expect(discard).toBeVisible();

    // --- the discard always asks first, in the app's own dialog (오너 결정 2026-10-20 3차 답 3):
    // what was typed after the restore goes too, and the dialog says so. Dismissed, the form is
    // as it was and the focus is back on the discard button.
    // The toaster's region is there before anything is discarded: a polite live region, a child of
    // <body>. Nothing has said the discard.
    await expect(toasts).toHaveAttribute('aria-live', 'polite');
    await expect(discarded).toHaveCount(0);
    await discard.click();
    await expect(dialog).toBeVisible();
    // The modal dialog hides the rest of the page from assistive tech (aria-hidden on the other
    // children of <body>, a frame after it opens) — the form is under it, the toaster's region is
    // not, so the toast a discard adds to it lands in a region that was exposed all along.
    const underHidden = (el: Element) => el.closest('[aria-hidden="true"], [inert]') !== null;
    await expect.poll(() => page.getByTestId('post-form').evaluate(underHidden)).toBe(true);
    expect(await toasts.evaluate(underHidden)).toBe(false);
    await expect(page.getByRole('alertdialog')).toHaveAccessibleName(copy.postDraftDiscard);
    await expect(page.getByRole('alertdialog')).toHaveAccessibleDescription(
      copy.postDraftDiscardQuestion,
    );
    // It opens on 취소: nothing is lost on Enter.
    await expect(page.getByTestId('post-draft-discard-cancel')).toBeFocused();
    await page.getByTestId('post-draft-discard-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(discard).toBeFocused();
    await expect(page.getByTestId('post-draft-restored')).toBeVisible();
    await expect(title).toHaveValue('고치던 제목');
    await expect(editor).toContainText('되살린 뒤 쓴 근거');
    await expect(discarded).toHaveCount(0);
    // Escape is a dismissal too, and so is a click outside the dialog.
    for (const dismiss of [
      () => page.keyboard.press('Escape'),
      () => page.mouse.click(4, 4),
    ] as const) {
      await discard.click();
      await expect(dialog).toBeVisible();
      // Visible is not yet listening (@zag-js 1.43): in the first frame after the dialog opens, its
      // focus trap moves the focus to 취소 and its Escape listener is attached right after; its
      // outside-pointer listener comes a frame and a timer later. A dismissal sent earlier is lost
      // and the dialog stays open. The frame and the timer awaited here come after those.
      await expect(page.getByTestId('post-draft-discard-cancel')).toBeFocused();
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve))),
      );
      await dismiss();
      await expect(dialog).toHaveCount(0);
      await expect(discard).toBeFocused();
      await expect(page.getByTestId('post-draft-restored')).toBeVisible();
      await expect(title).toHaveValue('고치던 제목');
      await expect(editor).toContainText('되살린 뒤 쓴 근거');
      await expect(discarded).toHaveCount(0);
    }

    // --- discarded on 버리기: the saved post again — what was typed after the restore goes too —
    // said in a toast (오너 결정 2026-10-20 3차 답 5: on screen too, and once to screen readers),
    // the focus on the redrawn title, not lost with the button; nothing to lose, so leaving asks
    // nothing.
    // The sentence is checked where it lands, the moment it does (an observer's callback runs
    // before the dialog's own close has undone its hiding): in the toaster's region, outside
    // anything hidden, and nowhere else in the document — the toaster says it, and nothing else.
    await page.evaluate((sentence) => {
      const landed: { exposed: boolean; inToaster: boolean; copies: number }[] = [];
      Object.assign(window, { discardedLanded: landed });
      const copies = () => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let count = 0;
        while (walker.nextNode()) {
          const text = walker.currentNode;
          if (text.parentElement?.closest('script, style') != null) continue;
          if (text.textContent?.includes(sentence)) count++;
        }
        return count;
      };
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            const el = node instanceof Element ? node : node.parentElement;
            if (el === null || !(node.textContent ?? '').includes(sentence)) continue;
            landed.push({
              exposed: el.closest('[aria-hidden="true"], [inert]') === null,
              inToaster:
                el.closest('[aria-live]')?.matches('[data-scope="toast"][data-part="group"]') ??
                false,
              copies: copies(),
            });
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }, copy.postDraftDiscarded);
    await discard.click();
    await page.getByTestId('post-draft-discard-confirm').click();
    // On screen: a completion toast like the app's others, named by the owner's sentence.
    const toast = toasts.getByRole('status').filter({ hasText: copy.postDraftDiscarded });
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAccessibleName(copy.postDraftDiscarded);
    await expect(toast).toHaveAttribute('data-type', 'success');
    await expect(discarded).toHaveCount(1);
    const landed = await page.evaluate(
      () =>
        (
          window as unknown as {
            discardedLanded: { exposed: boolean; inToaster: boolean; copies: number }[];
          }
        ).discardedLanded,
    );
    expect(landed.length).toBeGreaterThan(0);
    expect(landed).toEqual(
      Array.from(landed, () => ({ exposed: true, inToaster: true, copies: 1 })),
    );
    await expect(dialog).toHaveCount(0);
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
    const accountId = (await meOf(page.request)).id;
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
    expect(Object.keys(await draftsInTab(page))).toEqual([
      `buddha.postDraft:new:${market.id}@${accountId}`,
    ]);

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

  test('이미지 업로드가 온보딩 때문에 거절되면 보내기가 거절될 때처럼 알림 없이 남은 단계로 가고, 쓰던 글은 이 탭에 두며, 함께 고른 나머지는 보내지 않는다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const accountId = (await meOf(page.request)).id;
    const reconsent = await asReconsent(page);
    const write = `/community/write?market=${market.id}`;
    await page.goto(write);
    await page.getByTestId('post-title-input').fill('업로드 전에 쓰던 제목');
    // A revision asked for consent again while the screen was open: the upload is refused for it.
    let uploads = 0;
    await page.route('**/api/v1/media/images**', async (route) => {
      uploads += 1;
      reconsent.on = true;
      await route.fulfill(ONBOARDING_REFUSAL);
    });
    await page.getByTestId('post-editor-file').setInputFiles(pngFiles(3));
    // `/me` read again, the gate takes the account to its step — and the draft stays in the tab.
    await expect(page).toHaveURL(`/onboarding?next=${encodeURIComponent(write)}`);
    expect(Object.keys(await draftsInTab(page))).toEqual([
      `buddha.postDraft:new:${market.id}@${accountId}`,
    ]);
    // The refusal is about the account: the other two would be refused alike, so they never leave
    // (ADR-0073 decision 9-41). It says nothing, as a refused send does (owner decision
    // 2026-10-21): no toast followed the account to its step.
    await settle();
    expect(uploads).toBe(1);
    await expect(page.getByTestId('onboarding-return-reason')).toHaveText(
      copy.onboardingReconsentReason,
    );
    await expect(toastsOf(page).locator('[data-part="root"]')).toHaveCount(0);
    await expect(page.getByText(copy.errPostOnboarding)).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('이미지 업로드가 온보딩 때문에 거절됐는데 내 정보를 다시 읽지 못해 게이트가 데려가지 못하면, 보내기의 거절과 같은 문장을 한 번 알리고 양식과 쓰던 글은 그대로다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const write = `/community/write?market=${market.id}`;
    await page.goto(write);
    const editor = page.getByTestId('post-editor-content');
    await expect(editor).toBeVisible();
    await page.getByTestId('post-title-input').fill('업로드 전에 쓰던 제목');
    // The upload is refused for the onboarding, and `/me`, read again after it, is refused by the
    // address limit (a 4xx: not retried): `['me']` still names no step left, so the gate stays.
    let uploads = 0;
    let meReads = 0;
    await page.route('**/api/v1/media/images**', async (route) => {
      uploads += 1;
      await route.fulfill(ONBOARDING_REFUSAL);
    });
    await page.route('**/api/v1/me', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      meReads += 1;
      await route.fulfill({
        status: 429,
        headers: { 'retry-after': '30' },
        json: {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests',
            details: { retryAfterSeconds: 30 },
          },
        },
      });
    });
    await page.getByTestId('post-editor-file').setInputFiles(pngFiles(3));
    // Said once, as a refused send says it (owner decision 2026-10-21 answer 6) — and only
    // here: where the gate moves, nothing is said (the spec above).
    const toasts = toastsOf(page);
    await expect(toasts.getByText(copy.errPostOnboarding)).toHaveCount(1);
    await settle();
    expect(meReads).toBeGreaterThan(0);
    // The refusal is about the account: the other two never leave (ADR-0073 decision 9-41).
    expect(uploads).toBe(1);
    await expect(toasts.locator('[data-part="root"]')).toHaveCount(1);
    // The screen stays, the form with it — not '내 정보를 불러오지 못했습니다.' in its place — and
    // what was written: no image went in, and the count is back.
    await expect(page).toHaveURL(write);
    await expect(page.getByTestId('post-write-failed')).toHaveCount(0);
    await expect(page.getByTestId('post-title-input')).toHaveValue('업로드 전에 쓰던 제목');
    await expect(editor.locator('img[data-media-id]')).toHaveCount(0);
    await expect(page.getByTestId('post-body-images')).toContainText('0 / 10');
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('이미지를 올리는 동안 더 고른 이미지는 올리는 중인 것까지 세어 글마다 10장을 넘기지 않고, 이미지 수도 올리는 중인 것을 세며, 미리 거른 파일은 세지 않고, 묶음들은 한 번에 하나씩 올라간다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    await page.goto(`/community/write?market=${market.id}`);
    const editor = page.getByTestId('post-editor-content');
    await expect(editor).toBeVisible();
    // The uploads wait here until let go: the first batch is still on its way when the next comes.
    // The most waiting at once is what the page had in flight at once.
    const held: Route[] = [];
    let mostHeld = 0;
    await page.route('**/api/v1/media/images**', (route) => {
      held.push(route);
      mostHeld = Math.max(mostHeld, held.length);
    });
    const picker = page.getByTestId('post-editor-file');
    const images = page.getByTestId('post-body-images');
    const bodyErrors = page.getByTestId('post-body-errors');
    await picker.setInputFiles(pngFiles(6, 1));
    await expect.poll(() => held.length).toBe(1);
    // The count says the six on their way, none of them in the document yet (owner decision
    // 2026-10-21): the number the refusal below goes by.
    await expect(editor.locator('img[data-media-id]')).toHaveCount(0);
    await expect(images).toContainText('6 / 10');
    // Five more with six on their way would be eleven: refused, nothing of it sent.
    await picker.setInputFiles(pngFiles(5, 7));
    await expect(toastsOf(page).getByText(copy.errPostTooManyImages)).toBeVisible();
    await expect(images).toContainText('6 / 10');
    // Four fit beside them: ten, within the limit — nothing said under the counts. A file the
    // editor refuses before it leaves comes with them: said at once, never on its way, so not
    // counted (`takeImageBatch` — a slot for each of the five would have been eleven, refused).
    await picker.setInputFiles([
      ...pngFiles(4, 12),
      { name: 'notes.txt', mimeType: 'text/plain', buffer: PNG },
    ]);
    await expect(toastsOf(page).getByText(copy.errImageType)).toBeVisible();
    await expect(images).toContainText('10 / 10');
    await expect(bodyErrors.getByText(copy.errPostTooManyImages)).toHaveCount(0);
    // The second batch waits its turn behind the first: the page has one upload in flight, of the
    // account's three on the API (owner decision 2026-10-21 answer 4, ADR-0073 decision 9-41).
    expect(held).toHaveLength(1);
    // Let each go as it comes: the ten, never two at once.
    for (let sent = 0; sent < 10; sent += 1) {
      await expect.poll(() => held.length).toBeGreaterThan(0);
      await held.shift()!.continue();
    }
    await expect(page.getByTestId('post-editor-uploading')).toHaveCount(0);
    await expect(editor.locator('img[data-media-id]')).toHaveCount(10);
    await expect(images).toContainText('10 / 10');
    await expect(bodyErrors.getByText(copy.errPostTooManyImages)).toHaveCount(0);
    expect(mostHeld).toBe(1);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('API가 잠시 뒤에 다시 보내라고(429) 한 이미지는 올리는 중인 채 Retry-After만큼 기다려 다시 올리고, 두 번 거절된 뒤 세 번째에 받으면 알림 없이 들어간다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    await page.goto(`/community/write?market=${market.id}`);
    const editor = page.getByTestId('post-editor-content');
    await expect(editor).toBeVisible();
    // A title and a line of the body: with them, the upload is all that holds the form's submit.
    await page.getByTestId('post-title-input').fill('기다렸다 올린 이미지');
    await editor.click();
    await page.keyboard.type('다시 올린 근거');
    const submit = page.getByTestId('post-submit');
    await expect(submit).toBeEnabled();
    // The API's memory, then the uploads it receives, have no room for the moment (owner decisions
    // 2026-10-22 answer 3, 2026-10-21 answer 1 — the API's own refusals are its integration
    // tests'); the third send goes through. Each refusal names 3 seconds to wait — the editor
    // waits what `details.retryAfterSeconds` says, up to 10 — long enough to look inside the wait.
    const sentAt: number[] = [];
    await page.route('**/api/v1/media/images**', async (route) => {
      sentAt.push(Date.now());
      if (sentAt.length > 2) return route.continue();
      await route.fulfill({
        status: 429,
        headers: { 'retry-after': '3' },
        json: {
          error: {
            code: 'RATE_LIMITED',
            message:
              sentAt.length === 1
                ? 'The server is short of memory for uploads; send it again'
                : 'Too many uploads are being received; send it again',
            details: { retryAfterSeconds: 3 },
          },
        },
      });
    });
    const refusal = () =>
      page.waitForResponse(
        (response) => response.url().includes('/api/v1/media/images') && response.status() === 429,
      );
    const uploading = page.getByTestId('post-editor-uploading');
    const images = page.getByTestId('post-body-images');
    let refused = refusal();
    await page.getByTestId('post-editor-file').setInputFiles(pngFiles(1));
    // Refused once, then twice: a second into each wait — the next send two seconds off — the file
    // is still uploading (owner decision 2026-10-22 (2차) answer 3): the line up, the count as it
    // was, the form's submit held, nothing in the document. Read once rather than waited for: a
    // line gone during the wait would be back with the next send, and a waiting check would pass.
    for (const refusals of [1, 2]) {
      await refused;
      if (refusals === 1) refused = refusal();
      await partOf(1_000);
      expect(sentAt).toHaveLength(refusals);
      expect(await uploading.isVisible()).toBe(true);
      expect(await images.textContent()).toContain('1 / 10');
      expect(await submit.isDisabled()).toBe(true);
      expect(await editor.locator('img[data-media-id]').count()).toBe(0);
    }
    // The third send takes it: in the document, the uploading line gone, the submit free, no toast.
    await expect(editor.locator('img[data-media-id]')).toHaveCount(1);
    await expect(uploading).toHaveCount(0);
    await expect(submit).toBeEnabled();
    expect(sentAt).toHaveLength(3);
    // Each sent again only after the 3 seconds its refusal named.
    expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(2_950);
    expect(sentAt[2]! - sentAt[1]!).toBeGreaterThanOrEqual(2_950);
    await expect(images).toContainText('1 / 10');
    await expect(toastsOf(page).locator('[data-part="root"]')).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('세 번 모두 429로 거절된 이미지는 그 파일의 실패만 알리고, 함께 고른 나머지는 올라간다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    await page.goto(`/community/write?market=${market.id}`);
    const editor = page.getByTestId('post-editor-content');
    await expect(editor).toBeVisible();
    // The second file would take the API's uploads being received past their budget (owner
    // decision 2026-10-21: 64MiB per process) at each of its three sends: the first and the two
    // the editor sends again (owner decision 2026-10-22 (2차) answer 3). The files go one at a
    // time, so the second to the fourth requests are the second file's.
    let uploads = 0;
    await page.route('**/api/v1/media/images**', async (route) => {
      uploads += 1;
      if (uploads < 2 || uploads > 4) return route.continue();
      await route.fulfill({
        status: 429,
        headers: { 'retry-after': '1' },
        json: {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many uploads are being received; send it again',
            details: { retryAfterSeconds: 1 },
          },
        },
      });
    });
    await page.getByTestId('post-editor-file').setInputFiles(pngFiles(3));
    // That file's failure, said once; the batch goes on and the other two go in.
    await expect.poll(() => uploads, { timeout: 15_000 }).toBe(5);
    await expect(page.getByTestId('post-editor-uploading')).toHaveCount(0);
    await expect(editor.locator('img[data-media-id]')).toHaveCount(2);
    await expect(page.getByTestId('post-body-images')).toContainText('2 / 10');
    const toasts = toastsOf(page);
    await expect(toasts.getByText(copy.errImageUpload)).toHaveCount(1);
    await expect(toasts.locator('[data-part="root"]')).toHaveCount(1);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('429 뒤에 다시 보내기를 기다리는 이미지가 있으면 떠나기 전에 묻고, 떠난 뒤에는 그 이미지를 다시 보내지 않으며 아무것도 알리지 않는다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    await page.goto(`/community/write?market=${market.id}`);
    await expect(page.getByTestId('post-editor-content')).toBeVisible();
    // The first send is refused with a wait of 8 seconds — under the editor's 10, so it waits —
    // room for the writer to leave inside it; any send after it would go through.
    let uploads = 0;
    await page.route('**/api/v1/media/images**', async (route) => {
      uploads += 1;
      if (uploads > 1) return route.continue();
      await route.fulfill({
        status: 429,
        headers: { 'retry-after': '8' },
        json: {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many uploads are being received; send it again',
            details: { retryAfterSeconds: 8 },
          },
        },
      });
    });
    const asked: string[] = [];
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.accept();
    });
    const refused = page.waitForResponse(
      (response) => response.url().includes('/api/v1/media/images') && response.status() === 429,
    );
    await page.getByTestId('post-editor-file').setInputFiles(pngFiles(1));
    await refused;
    const refusedAt = Date.now();
    // In the wait the file is still uploading — something leaving would lose — so the header link
    // asks first (ADR-0073 decision 9-47); the writer leaves.
    await expect(page.getByTestId('post-editor-uploading')).toBeVisible();
    await page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link').click();
    await expect(page).toHaveURL('/');
    expect(asked).toEqual([`confirm: ${copy.postLeaveConfirm}`]);
    // Gone before the wait was over (else the editor would rightly have sent it again).
    expect(Date.now() - refusedAt).toBeLessThan(8_000);
    // Past the wait, and a second more: with the editor gone the file is not sent again, and
    // nothing is said on the screen the writer went to (`UploadAbandoned`, owner decision
    // 2026-10-22 (2차) answer 3).
    await partOf(refusedAt + 9_000 - Date.now());
    expect(uploads).toBe(1);
    await expect(toastsOf(page).locator('[data-part="root"]')).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('이미지 읽기가 잠시 뒤에 다시 받으라고(429) 하면 글의 이미지와 카드의 썸네일을 그 뒤에 다시 받아 그린다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const uploaded = await page.request.post(`/api/v1/media/images?expectedAccountId=${me.id}`, {
      headers: { 'content-type': 'image/png' },
      data: PNG,
    });
    expect(uploaded.status(), await uploaded.text()).toBe(201);
    const mediaId = ((await uploaded.json()) as { data: { id: string } }).data.id;
    const postId = await postThroughApi(page.request, market.id, `기다린 이미지 ${tag}`, tag, [
      { type: 'image', attrs: { mediaId } },
    ]);
    // The API's answer while the images it is sending hold its budget (ADR-0073 decision 9-36):
    // twice for each screen, then the image.
    let refusals = 0;
    await page.route(`**/api/v1/media/${mediaId}`, async (route) => {
      if (refusals >= 2) return route.fallback();
      refusals += 1;
      await route.fulfill({
        status: 429,
        headers: { 'retry-after': '1' },
        json: {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many images are being sent; read it again',
            details: { retryAfterSeconds: 1 },
          },
        },
      });
    });
    const drawn = (image: Locator) =>
      image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0);

    await page.goto(`/community/posts/${postId}`);
    const image = page.getByTestId('post-body').getByTestId('post-image');
    await expect.poll(() => drawn(image), { timeout: 15_000 }).toBe(true);
    expect(refusals).toBe(2);

    refusals = 0;
    await page.goto(`/community?q=${tag}`);
    const thumbnail = card(page, postId).getByTestId('post-card-thumbnail');
    await expect.poll(() => drawn(thumbnail), { timeout: 15_000 }).toBe(true);
    expect(refusals).toBe(2);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('다른 계정의 쿠키로 거절된 업로드는 세션을 다시 읽고 나머지를 보내지 않으며, 거절되거나 실패한 이미지의 자리는 모두 돌아온다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    await page.goto(`/community/write?market=${market.id}`);
    const editor = page.getByTestId('post-editor-content');
    await expect(editor).toBeVisible();
    const toasts = toastsOf(page);
    let answer: 'another account' | 'unreadable' | 'real' = 'another account';
    let uploads = 0;
    await page.route('**/api/v1/media/images**', async (route) => {
      uploads += 1;
      if (answer === 'real') return route.continue();
      await route.fulfill(
        answer === 'another account'
          ? {
              status: 403,
              json: {
                error: {
                  code: 'FORBIDDEN',
                  message: 'Not the signed-in account',
                  details: [{ path: ['expectedAccountId'], message: 'not the signed-in account' }],
                },
              },
            }
          : {
              status: 422,
              json: {
                error: {
                  code: 'IMAGE_NOT_ALLOWED',
                  message: 'Not an image this post takes',
                  details: { reason: 'unreadable' },
                },
              },
            },
      );
    });
    const picker = page.getByTestId('post-editor-file');

    // The cookie is another account's (signed in again in another tab): the session is read again,
    // as a refused send does (`postImageUploader`), and the rest of the batch stays home.
    const sessionRead = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/api/auth/get-session',
      { timeout: 10_000 },
    );
    await picker.setInputFiles(pngFiles(3));
    await sessionRead;
    await expect(toasts.getByText(copy.sessionChanged)).toHaveCount(1);
    await settle();
    expect(uploads).toBe(1);
    await expect(toasts.getByText(copy.sessionChanged)).toHaveCount(1);

    // Ten the API refuses, one by one, and one the editor refuses before it leaves.
    answer = 'unreadable';
    uploads = 0;
    await picker.setInputFiles(pngFiles(10, 4));
    await expect.poll(() => uploads).toBe(10);
    await expect(page.getByTestId('post-editor-uploading')).toHaveCount(0);
    await picker.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: PNG });
    await expect(toasts.getByText(copy.errImageType)).toBeVisible();
    expect(uploads).toBe(10);
    await expect(editor.locator('img[data-media-id]')).toHaveCount(0);

    // None of those holds a slot: ten real ones still fit.
    answer = 'real';
    await picker.setInputFiles(pngFiles(10, 14));
    await expect(page.getByTestId('post-editor-uploading')).toHaveCount(0);
    await expect(editor.locator('img[data-media-id]')).toHaveCount(10);
    await expect(page.getByTestId('post-body-images')).toContainText('10 / 10');
    await expect(toasts.getByText(copy.errPostTooManyImages)).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('이미지 읽기가 다시 받은 뒤에도 429면 이미지마다 세 번까지만 다시 받고 깨진 채 둔다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const uploaded = await page.request.post(`/api/v1/media/images?expectedAccountId=${me.id}`, {
      headers: { 'content-type': 'image/png' },
      data: PNG,
    });
    expect(uploaded.status(), await uploaded.text()).toBe(201);
    const mediaId = ((await uploaded.json()) as { data: { id: string } }).data.id;
    const postId = await postThroughApi(page.request, market.id, '끝내 기다린 이미지', freshTag(), [
      { type: 'image', attrs: { mediaId } },
    ]);
    // The element is refused every time; the recovering `fetch` gets the image. Routing turns the
    // browser's cache off, so each new element asks again — and is refused again.
    let recoveries = 0;
    await page.route(`**/api/v1/media/${mediaId}`, async (route) => {
      if (route.request().resourceType() !== 'image') {
        recoveries += 1;
        return route.fallback();
      }
      await route.fulfill({
        status: 429,
        headers: { 'retry-after': '1' },
        json: {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many images are being sent; read it again',
            details: { retryAfterSeconds: 1 },
          },
        },
      });
    });

    await page.goto(`/community/posts/${postId}`);
    const image = page.getByTestId('post-body').getByTestId('post-image');
    // The budget is the image's, spent across its failures (IMAGE_RETRY_ATTEMPTS, ADR-0073 9-39):
    // three recoveries, then it stays broken rather than asking for ever.
    await expect.poll(() => recoveries, { timeout: 15_000 }).toBe(3);
    await settle();
    await settle();
    expect(recoveries).toBe(3);
    expect(
      await image.evaluate(
        (element: HTMLImageElement) => element.complete && element.naturalWidth === 0,
      ),
    ).toBe(true);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('다른 탭에서 지운 글은 열어 둔 글 화면이 다시 읽을 때 404가 되고(잠깐 실패한 다시 읽기는 글을 그대로 둔다), 수정 화면은 그 글의 거절된 저장 뒤에 쓰던 제목·본문을 고칠 수 없게 남겨 떠날 때 묻고 닫기 뒤에야 404가 된다', async ({
    admin,
    page,
  }) => {
    // Codex review of #219, round 5 (ADR-0073 9-50): a read of a post deleted meanwhile answers
    // NOT_FOUND while the query keeps the post it read before, and the screens drew that post — a
    // deleted post's page, an edit screen whose every save is refused. The page's clock, so the
    // read on mount can be made older than `staleTime` (30 s, lib/query-client.ts) without waiting
    // for it; a refocus then reads the post again, as it does for a reader coming back to the tab.
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const tag = freshTag();
    const postId = await postThroughApi(page.request, market.id, `지워질 글 ${tag}`, '지워질 근거');
    const postPage = `/community/posts/${postId}`;
    await page.clock.install();
    await page.goto(postPage);
    await expect(page.getByTestId('post-title')).toHaveText(`지워질 글 ${tag}`);
    const refocus = async () => {
      await page.clock.fastForward('00:31');
      // TanStack's focus manager listens for `visibilitychange` on window (watchlist.spec.ts).
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    };

    // --- a read that fails otherwise — the API down for a moment, through the client's retries —
    // says nothing about the post: it stays.
    let refused = 0;
    const isRead = (url: URL) => url.pathname === `/api/v1/posts/${postId}`;
    await page.route(isRead, (route) => {
      refused += 1;
      return route.fulfill({
        status: 503,
        json: { error: { code: 'INTERNAL', message: 'Service unavailable' } },
      });
    });
    await refocus();
    await expect.poll(() => refused).toBe(3);
    await settle();
    await expect(page.getByTestId('post-title')).toHaveText(`지워질 글 ${tag}`);
    await expect(page.getByTestId('post-gone')).toHaveCount(0);
    await page.unroute(isRead);

    // --- its author deletes it in another tab: the next read is NOT_FOUND, and the open page is
    // the post's 404, as a reload says it.
    const other = await page.context().newPage();
    await other.goto(postPage);
    await other.getByTestId('post-delete').click();
    await other.getByTestId('post-delete-confirm').click();
    await expect(other).toHaveURL('/community');
    await other.close();
    await refocus();
    await expect(page.getByTestId('post-screen')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    await expect(page).toHaveURL(postPage);
    expect((await page.reload())?.status()).toBe(404);

    // --- the edit screen (오너 결정 2026-10-24, ADR-0073 9-52): its author deletes the post in
    // another tab while its title and body are being changed here. The save is refused
    // (NOT_FOUND) and reads the post again — gone — and the screen keeps what was written: the
    // title and the body read-only, to select and copy, under '없거나 삭제된 글입니다.', and 닫기
    // in place of 저장. Leaving asks first; the 404 comes with 닫기, as a reload says it.
    const editedId = await postThroughApi(page.request, market.id, `고칠 글 ${tag}`, '고칠 근거');
    const edit = `/community/posts/${editedId}/edit`;
    await page.goto(edit);
    const title = page.getByTestId('post-title-input');
    const editor = page.getByTestId('post-editor-content');
    await expect(editor).toContainText('고칠 근거');
    await title.fill(`고친 제목 ${tag}`);
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 덧붙인 근거');
    await expect(editor).toContainText('덧붙인 근거');
    const deleting = await page.context().newPage();
    await deleting.goto(`/community/posts/${editedId}`);
    await deleting.getByTestId('post-delete').click();
    await deleting.getByTestId('post-delete-confirm').click();
    await expect(deleting).toHaveURL('/community');
    await deleting.close();
    await page.getByTestId('post-submit').click();
    await expect(page.getByTestId('post-form-gone')).toHaveText(copy.errPostGone);
    await expect(title).toHaveValue(`고친 제목 ${tag}`);
    await expect(title).not.toBeEditable();
    await expect(editor).toContainText('고칠 근거');
    await expect(editor).toContainText('덧붙인 근거');
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await expect(editor).toHaveAttribute('aria-readonly', 'true');
    await expect(page.getByTestId('post-submit')).toHaveCount(0);
    // The sentence once: the refusal's own line under the form is not drawn as well.
    await expect(page.getByTestId('post-form-error')).toHaveCount(0);
    await expect(page.getByText(copy.errPostGone)).toHaveCount(1);
    // Selectable — and so copyable: the title's text, and the body's.
    await title.selectText();
    expect(
      await title.evaluate((input: HTMLInputElement) =>
        input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0),
      ),
    ).toBe(`고친 제목 ${tag}`);
    await editor.locator('p').first().click({ clickCount: 3 });
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain(
      '덧붙인 근거',
    );
    // Typing changes nothing.
    await page.keyboard.type('더');
    await expect(editor).not.toContainText('더');
    // No 404 while it is held.
    await settle();
    await expect(page.getByTestId('post-edit-screen')).toBeVisible();
    await expect(page.getByRole('heading', { name: '404' })).toHaveCount(0);

    // --- leaving asks, and staying keeps it all.
    const asked: string[] = [];
    page.once('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    await page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link').click();
    await expect.poll(() => asked).toEqual([`confirm: ${copy.postLeaveConfirm}`]);
    await expect(page).toHaveURL(edit);
    await expect(title).toHaveValue(`고친 제목 ${tag}`);
    await expect(editor).toContainText('덧붙인 근거');

    // --- 닫기: the 404, asking nothing (an unexpected dialog would be dismissed and keep us).
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    await page.getByTestId('post-form-close').click();
    await expect(page.getByTestId('post-edit-screen')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    await expect(page).toHaveURL(edit);
    expect(asked).toHaveLength(1);
    expect((await page.reload())?.status()).toBe(404);
  });

  test('수정 화면의 글이 다른 탭에서 지워지면, 다시 읽을 때 쓰던 제목·본문은 고칠 수 없게 남아 닫기 뒤에 404가 되고, 고친 것이 없는 화면은 곧바로 404가 된다', async ({
    admin,
    page,
  }) => {
    // 오너 결정 2026-10-24 (ADR-0073 9-52): the read that finds the post gone is a window's focus
    // here — no save — and the screen keeps what the form held then; one holding nothing of the
    // writer's is the 404 at once, as before. The page's clock makes the read older than
    // `staleTime` (30 s) without waiting, as above.
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const tag = freshTag();
    await page.clock.install();
    const refocus = async () => {
      await page.clock.fastForward('00:31');
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    };
    const deleteInAnotherTab = async (postId: string) => {
      const other = await page.context().newPage();
      await other.goto(`/community/posts/${postId}`);
      await other.getByTestId('post-delete').click();
      await other.getByTestId('post-delete-confirm').click();
      await expect(other).toHaveURL('/community');
      await other.close();
    };
    let saves = 0;
    await page.route(/\/api\/v1\/posts\/[^/]+$/, (route) => {
      if (route.request().method() === 'PUT') saves += 1;
      return route.continue();
    });

    // --- a line added to the body: kept, read-only, under the sentence — and nothing was sent.
    const keptId = await postThroughApi(page.request, market.id, `남길 글 ${tag}`, '남길 근거');
    const keptEdit = `/community/posts/${keptId}/edit`;
    await page.goto(keptEdit);
    const title = page.getByTestId('post-title-input');
    const editor = page.getByTestId('post-editor-content');
    await expect(editor).toContainText('남길 근거');
    // The body alone is changed here: what the form holds is that change, so the keys go to an
    // editor that is made (the form takes its baseline as the editor is mounted, before any key —
    // a key before TipTap's `create` once went into it).
    await editorReady(editor);
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 쓰던 근거');
    await expect(editor).toContainText('쓰던 근거');
    await deleteInAnotherTab(keptId);
    await refocus();
    await expect(page.getByTestId('post-form-gone')).toHaveText(copy.errPostGone);
    await expect(title).toHaveValue(`남길 글 ${tag}`);
    await expect(title).not.toBeEditable();
    await expect(editor).toContainText('쓰던 근거');
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await expect(page.getByTestId('post-form-close')).toBeVisible();
    await settle();
    await expect(page.getByRole('heading', { name: '404' })).toHaveCount(0);
    expect(saves).toBe(0);
    await page.getByTestId('post-form-close').click();
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    await expect(page).toHaveURL(keptEdit);

    // --- nothing changed: nothing of the writer's to keep, the 404 at once.
    const plainId = await postThroughApi(page.request, market.id, `그냥 둔 글 ${tag}`, '그냥 근거');
    const plainEdit = `/community/posts/${plainId}/edit`;
    await page.goto(plainEdit);
    await expect(title).toHaveValue(`그냥 둔 글 ${tag}`);
    await deleteInAnotherTab(plainId);
    await refocus();
    await expect(page.getByTestId('post-edit-screen')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    await expect(page).toHaveURL(plainEdit);
    await expect(page.getByTestId('post-form-gone')).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('수정 화면에서 이미지를 올리는 사이 글이 다른 탭에서 지워지면, 그 뒤에 올라온 이미지는 고칠 수 없게 남은 본문의 고른 줄 뒤에 들어가고(그 줄은 그대로) 기다리던 파일은 보내지 않는다', async ({
    admin,
    page,
  }) => {
    // 오너 결정 2026-10-25 (2차) «남긴 양식에 넣음» (ADR-0073 9-53): the held form's editor is
    // locked (9-52), which stops the writer but not an upload's own insert — one landing after the
    // post went put its image over the line selected when it was picked (Codex review of #219,
    // round 6). It goes in after that line now, and nothing more is sent. The upload waits here
    // until let go, past the read that finds the post gone (the page's clock and a focus, as
    // above).
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const tag = freshTag();
    await page.clock.install();
    const postId = await postThroughApi(page.request, market.id, `올리던 글 ${tag}`, '올리던 근거');
    const edit = `/community/posts/${postId}/edit`;
    const held: Route[] = [];
    let uploads = 0;
    await page.route('**/api/v1/media/images**', (route) => {
      uploads += 1;
      held.push(route);
    });
    await page.goto(edit);
    const editor = page.getByTestId('post-editor-content');
    await expect(editor).toContainText('올리던 근거 출처');
    // The line selected, then two images picked: the first goes up to take its place, the second
    // waits its turn.
    await editor.locator('p').first().click({ clickCount: 3 });
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain(
      '올리던 근거',
    );
    await page.getByTestId('post-editor-file').setInputFiles(pngFiles(2));
    await expect.poll(() => held.length).toBe(1);
    await expect(page.getByTestId('post-editor-uploading')).toBeVisible();

    // Deleted in another tab, and read again on a focus: an upload on its way is something to
    // keep (9-52), so the form stays, locked, under the sentence.
    const other = await page.context().newPage();
    await other.goto(`/community/posts/${postId}`);
    await other.getByTestId('post-delete').click();
    await other.getByTestId('post-delete-confirm').click();
    await expect(other).toHaveURL('/community');
    await other.close();
    await page.clock.fastForward('00:31');
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByTestId('post-form-gone')).toHaveText(copy.errPostGone);
    await expect(editor).toHaveAttribute('contenteditable', 'false');

    // The upload lands: its image goes in after the selected line, drawn from its preview — the
    // line is still there, as it was, to copy — and the file waiting its turn is never sent.
    // Nothing is said: no file failed.
    await held.shift()!.continue();
    await expect(page.getByTestId('post-editor-uploading')).toHaveCount(0);
    await settle();
    await expect(editor.locator('img')).toHaveCount(1);
    await expect(editor.locator('img')).toHaveAttribute('src', /^data:image\//);
    // The line, the image, and the empty line the editor keeps after a body ending in an image.
    expect(
      await editor.evaluate((root) =>
        Array.from(root.children, (child) =>
          child.tagName === 'IMG' ? '[image]' : (child.textContent ?? ''),
        ),
      ),
    ).toEqual(['올리던 근거 출처', '[image]', '']);
    await expect(editor.locator('p em')).toHaveText('올리던 근거');
    await expect(editor.locator('p a')).toHaveText('출처');
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    // The selection left where it was.
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain(
      '올리던 근거',
    );
    await expect(page.getByTestId('post-body-images')).toContainText('1 / 10');
    expect(uploads).toBe(1);
    await expect(toastsOf(page).getByText(copy.errImageUpload)).toHaveCount(0);
    await expect(page.getByTestId('post-title-input')).toHaveValue(`올리던 글 ${tag}`);
    // Held with the image it took, under the sentence, until 닫기.
    await expect(page.getByTestId('post-form-gone')).toHaveText(copy.errPostGone);
    await page.getByTestId('post-form-close').click();
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    await expect(page).toHaveURL(edit);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('수정 화면에서 429 뒤 다시 올리기를 기다리던 이미지는 그사이 글이 다른 탭에서 지워져도 다시 올라가 남은 본문에 들어가고, 고칠 수 없는 본문에서 세 번 눌러 고른 줄은 그 이미지를 고르지 않는다', async ({
    admin,
    page,
  }) => {
    // 오너 결정 2026-10-25 (2차) «남긴 양식에 넣음» (ADR-0073 9-53): a file waiting out a 429 is
    // the upload on its way — '올리는 중' kept (owner decision 2026-10-22 (2차) answer 3) — so a
    // form held meanwhile still sends it again and takes its image; it was given up, saying
    // nothing, the form held for it alone holding nothing of the writer's. And the browser's
    // triple click in the held editor (9-52) selects through to the next line's start: the image
    // going in after the line moved the selection's end past it, over the image.
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    const tag = freshTag();
    await page.clock.install();
    const postId = await postThroughApi(
      page.request,
      market.id,
      `기다리던 글 ${tag}`,
      '기다리던 근거',
      [{ type: 'paragraph', content: [{ type: 'text', text: '둘째 줄' }] }],
    );
    const edit = `/community/posts/${postId}/edit`;
    const held: Route[] = [];
    let uploads = 0;
    await page.route('**/api/v1/media/images**', (route) => {
      uploads += 1;
      held.push(route);
    });
    await page.goto(edit);
    const editor = page.getByTestId('post-editor-content');
    await expect(editor).toContainText('둘째 줄');
    // Two images picked: the first goes up, the second waits its turn.
    await page.getByTestId('post-editor-file').setInputFiles(pngFiles(2));
    await expect.poll(() => held.length).toBe(1);
    const uploading = page.getByTestId('post-editor-uploading');
    await expect(uploading).toBeVisible();

    // Deleted in another tab, and read again on a focus while the first send is out: the form
    // stays, locked, under the sentence (an upload on its way is something to keep, 9-52).
    const other = await page.context().newPage();
    await other.goto(`/community/posts/${postId}`);
    await other.getByTestId('post-delete').click();
    await other.getByTestId('post-delete-confirm').click();
    await expect(other).toHaveURL('/community');
    await other.close();
    await page.clock.fastForward('00:31');
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByTestId('post-form-gone')).toHaveText(copy.errPostGone);
    await expect(editor).toHaveAttribute('contenteditable', 'false');

    // The send comes back refused for the moment: the API busy, to be sent again in 2 seconds.
    await held.shift()!.fulfill({
      status: 429,
      headers: { 'retry-after': '2' },
      json: {
        error: {
          code: 'RATE_LIMITED',
          message: 'The server is short of memory for uploads; send it again',
          details: { retryAfterSeconds: 2 },
        },
      },
    });
    // The first line selected in the held editor, as the browser selects it there: through to
    // the next line's start.
    await editor.locator('p').first().click({ clickCount: 3 });
    expect(
      await editor.evaluate((root) => {
        const { selection } = (
          root as HTMLElement & {
            editor: {
              state: {
                selection: { $to: { parentOffset: number; parent: { textContent: string } } };
              };
            };
          }
        ).editor.state;
        return { offset: selection.$to.parentOffset, line: selection.$to.parent.textContent };
      }),
    ).toEqual({ offset: 0, line: '둘째 줄' });
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain(
      '기다리던 근거 출처',
    );

    // The wait out, the file is sent again, still uploading; it lands: its image goes in after
    // the selected line, and the file waiting its turn is never sent. Nothing is said.
    await page.clock.fastForward('00:02');
    await expect.poll(() => held.length).toBe(1);
    expect(uploads).toBe(2);
    await expect(uploading).toBeVisible();
    await held.shift()!.continue();
    await expect(uploading).toHaveCount(0);
    await settle();
    await expect(editor.locator('img')).toHaveCount(1);
    await expect(editor.locator('img')).toHaveAttribute('src', /^data:image\//);
    expect(
      await editor.evaluate((root) =>
        Array.from(root.children, (child) =>
          child.tagName === 'IMG' ? '[image]' : (child.textContent ?? ''),
        ),
      ),
    ).toEqual(['기다리던 근거 출처', '[image]', '둘째 줄']);
    // The line still selected, and the image not: the page's selection is the line's.
    expect(
      await editor.evaluate((root) => {
        const selection = window.getSelection();
        const image = root.querySelector('img');
        return {
          text: selection?.toString() ?? '',
          image:
            selection !== null &&
            selection.rangeCount > 0 &&
            image !== null &&
            selection.getRangeAt(0).intersectsNode(image),
        };
      }),
    ).toEqual({ text: '기다리던 근거 출처', image: false });
    await expect(page.getByTestId('post-body-images')).toContainText('1 / 10');
    expect(uploads).toBe(2);
    await expect(toastsOf(page).locator('[data-part="root"]')).toHaveCount(0);
    // Held with the image it took, under the sentence, until 닫기.
    await expect(page.getByTestId('post-form-gone')).toHaveText(copy.errPostGone);
    await page.getByTestId('post-form-close').click();
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    await expect(page).toHaveURL(edit);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('커뮤니티 목록의 더 보기가 실패하면 카드를 남기고 그 위에 알리며, 다시 누르면 나머지가 온다', async ({
    admin,
    page,
  }) => {
    // Owner decision 2026-10-20 7 (ADR-0075): every 더 보기 list says its 더 보기 failed, above the
    // button, which asks again — the 토론 has its own walk in discussion.spec.ts; this is the
    // second list, the community list narrowed to one market so its pages are this test's posts.
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const titles = Array.from(
      { length: 21 },
      (_, i) => `더 보기 ${tag} #${String(i + 1).padStart(2, '0')}`,
    );
    for (const title of titles) await postThroughApi(admin, market.id, title, tag);
    const newestFirst = [...titles].reverse();

    await page.goto(`/community?market=${market.id}`);
    // Hydrated (the header's 로그인 shows only then), so 더 보기 has its handler.
    await expect(page.locator('header').getByRole('link', { name: copy.login })).toBeVisible();
    const list = page.getByTestId('community-posts');
    const headings = list.getByRole('heading', { level: 3 });
    await expect(headings).toHaveText(newestFirst.slice(0, 20));

    // The next page refused through the client's retries (a 5xx is asked twice more).
    const isNextPage = (url: URL) =>
      url.pathname === '/api/v1/posts' && url.searchParams.has('cursor');
    await page.route(isNextPage, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal error' } }),
      }),
    );
    const more = page.getByTestId('community-more');
    await more.click();
    const failed = page.getByTestId('community-more-failed');
    await expect(failed).toHaveText(copy.errUnknown);
    await expect(failed).toHaveAttribute('role', 'alert');
    await expect(
      list.locator('[data-testid="community-more-failed"] + [data-testid="community-more"]'),
    ).toHaveCount(1);
    await expect(headings).toHaveText(newestFirst.slice(0, 20));
    await expect(page.getByTestId('community-error')).toHaveCount(0);
    await expect(page.getByTestId('community-refresh-failed')).toHaveCount(0);
    await expect(more).toBeEnabled();

    // Readable again: 더 보기 brings the 21st, and the notice and the button go.
    await page.unroute(isNextPage);
    await more.click();
    await expect(headings).toHaveText(newestFirst);
    await expect(failed).toHaveCount(0);
    await expect(more).toHaveCount(0);
  });
});

/** The post writes `page` sends from now on — a post, an edit, an image — as `METHOD path`. */
function postWritesOf(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === 'GET') return;
    if (pathname.startsWith('/api/v1/posts') || pathname.startsWith('/api/v1/media')) {
      writes.push(`${request.method()} ${pathname}`);
    }
  });
  return writes;
}

test.describe('탭의 세션이 아직 앞 계정을 말하는데 `GET /me`가 다른 회원으로 답하는 글쓰기·수정 (ADR-0092 오너 결정 2026-10-26 17:21 답 3)', () => {
  // `['me']` turns from A to B in place, before the session does (ADR-0090 결정 4-2 — a
  // window-focus refetch of `GET /me` answered with B's cookie while better-auth's session still
  // says A), so SessionCacheGuard resets nothing. The write and edit forms are drawn for the account
  // on screen (`key`), so B never gets A's form — what A typed, its button on, sent as B with B's
  // cookie. The owner's «이 PR에서 함께, 적던 것은 A의 초안으로»: A's form, going, keeps what A typed
  // in this tab as A's draft for the hour, as the onboarding gate's move keeps it (ADR-0073 9-38) —
  // one item per screen and account, which B's form neither reads nor replaces — and A, on screen
  // again, takes it back with the restore notice. Nothing asks: no leave of the page.

  test('글쓰기에서 앞 계정이 쓰던 글은 다른 회원에게 빈 양식으로 다시 그려지고 아무것도 보내지 않으며, 이 탭에 앞 계정의 것으로 두었다가 그 계정이 돌아오면 되살린다', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const asked: string[] = [];
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    const titleInput = page.getByTestId('post-title-input');
    const editor = page.getByTestId('post-editor-content');
    const restored = page.getByTestId('post-draft-restored');
    const draftKeys = async () => Object.keys(await draftsInTab(page)).sort();
    const { a, b, open, toB, toA, close } = await membersTurningInPlace(browser, page);
    try {
      await open(`/community/write?market=${market.id}`);
      await expect(page.getByTestId('post-write-market-title')).toHaveText(market.title);
      await expect(titleInput).toBeEditable();
      await editorReady(editor);
      const tag = freshTag();
      const title = `앞 계정이 쓰던 제목 ${tag}`;
      await titleInput.fill(title);
      await editor.click();
      await page.keyboard.type(`앞 계정이 쓰던 근거 ${tag}`);
      const writes = postWritesOf(page);

      // --- B on screen: B's own form, empty and on, under the same market; A's kept as A's.
      await toB();
      await expect(titleInput).toHaveValue('');
      await expect(editor).not.toContainText(tag);
      await expect(restored).toHaveCount(0);
      await expect(titleInput).toBeEditable();
      await expect(page.getByTestId('post-write-market-title')).toHaveText(market.title);
      await expect.poll(draftKeys).toEqual([`buddha.postDraft:new:${market.id}@${a.id}`]);
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);
      // B types too: B's own, beside A's.
      await titleInput.fill(`다른 회원이 쓰던 제목 ${tag}`);

      // --- A on screen again: A's text taken back, said so; B's kept as B's.
      await toA();
      await expect(restored).toContainText(copy.postDraftRestored);
      await expect(titleInput).toHaveValue(title);
      await expect(editor).toContainText(`앞 계정이 쓰던 근거 ${tag}`);
      await expect.poll(draftKeys).toEqual([`buddha.postDraft:new:${market.id}@${b.id}`]);
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);
    } finally {
      await close();
    }
  });

  test('수정 화면에서 앞 계정이 고치던 것은 다른 회원에게는 남의 글이라는 문장뿐이고 아무것도 보내지 않으며, 앞 계정이 돌아오면 되살린다', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const asked: string[] = [];
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    const titleInput = page.getByTestId('post-title-input');
    const editor = page.getByTestId('post-editor-content');
    const restored = page.getByTestId('post-draft-restored');
    const { a, open, toB, toA, close } = await membersTurningInPlace(browser, page);
    try {
      const tag = freshTag();
      const postId = await postThroughApi(page.request, market.id, `저장된 제목 ${tag}`, tag);
      await open(`/community/posts/${postId}/edit`);
      await expect(titleInput).toHaveValue(`저장된 제목 ${tag}`);
      await editorReady(editor);
      const typed = `앞 계정이 고치던 제목 ${tag}`;
      await titleInput.fill(typed);
      const writes = postWritesOf(page);

      // --- B on screen: not B's post — the sentence in the form's place, nothing of A's.
      await toB();
      await expect(page.getByTestId('post-edit-not-yours')).toBeVisible();
      await expect(titleInput).toHaveCount(0);
      await expect(page.getByText(typed)).toHaveCount(0);
      await expect
        .poll(async () => Object.keys(await draftsInTab(page)))
        .toEqual([`buddha.postDraft:edit:${postId}@${a.id}`]);
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);

      // --- A again: taken back.
      await toA();
      await expect(restored).toContainText(copy.postDraftRestored);
      await expect(titleInput).toHaveValue(typed);
      await expect(editor).toContainText(tag);
      await expect.poll(async () => Object.keys(await draftsInTab(page))).toEqual([]);
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);
    } finally {
      await close();
    }
  });
});

test.describe('탭의 세션이 먼저 다른 회원을 말하는 글쓰기·수정 — 정순서 (ADR-0092 결정 10, 오너 결정 2026-10-26 21:00 답 1 «정순서에서도 A의 초안으로»)', () => {
  // The forward order: another window signs in as B and this tab reads its session again, so the
  // session names B first and SessionCacheGuard's reset empties `['me']` — `WriteGate` puts its
  // placeholder in place of A's form in that very render, then `GET /me` answers as B and B's own
  // form is drawn. Before this, A's text went with the reset. Now A's form, going, hears from the
  // guard that the session names B, and keeps what A typed in this tab as A's draft for the hour, as
  // when `['me']` turns first (17:21 답 3): B's form reads none of it, nothing is sent as B, and A,
  // with the session back, takes it back with the restore notice — also when `GET /me` names A
  // again before the session does, and the session's reset then takes away the form just drawn for
  // A with that text in it (8-36). A link's leave keeps nothing, as ever (ADR-0073).

  test('글쓰기에서 앞 계정이 쓰던 글은 세션이 다른 회원으로 바뀌면 빈 양식으로 다시 그려지고 아무것도 보내지 않으며, 앞 계정의 것으로 두었다가 세션이 돌아오면 되살리고, 링크로 떠나는 것은 그대로 묻고 아무것도 두지 않는다', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const asked: string[] = [];
    const answers: boolean[] = [];
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void (answers.shift() === true ? dialog.accept() : dialog.dismiss());
    });
    const titleInput = page.getByTestId('post-title-input');
    const editor = page.getByTestId('post-editor-content');
    const restored = page.getByTestId('post-draft-restored');
    const draftKeys = async () => Object.keys(await draftsInTab(page)).sort();
    const write = `/community/write?market=${market.id}`;
    const { a, open, toB, toA, close } = await membersSwitchingSessions(browser, page);
    try {
      await open(write);
      await expect(page.getByTestId('post-write-market-title')).toHaveText(market.title);
      await expect(titleInput).toBeEditable();
      await editorReady(editor);
      const tag = freshTag();
      const title = `앞 계정이 쓰던 제목 ${tag}`;
      await titleInput.fill(title);
      await editor.click();
      await page.keyboard.type(`앞 계정이 쓰던 근거 ${tag}`);
      const writes = postWritesOf(page);

      // --- the session says B first: B's own form, empty and on, under the same market; A's kept
      // as A's.
      await toB();
      await expect(page.getByTestId('post-write-market-title')).toHaveText(market.title);
      await expect(titleInput).toBeEditable();
      await expect(titleInput).toHaveValue('');
      await expect(editor).not.toContainText(tag);
      await expect(restored).toHaveCount(0);
      await expect.poll(draftKeys).toEqual([`buddha.postDraft:new:${market.id}@${a.id}`]);
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);

      // --- the session says A again: A's text taken back, said so; nothing of B's kept (B typed
      // nothing).
      await toA();
      await expect(restored).toContainText(copy.postDraftRestored);
      await expect(titleInput).toHaveValue(title);
      await expect(editor).toContainText(`앞 계정이 쓰던 근거 ${tag}`);
      await expect.poll(draftKeys).toEqual([]);
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);

      // --- a link's leave, as ever: asked first, and once left nothing is kept — the screen opened
      // again is empty.
      const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');
      answers.push(true);
      await home.click();
      await expect(page).toHaveURL('/');
      expect(asked).toEqual([`confirm: ${copy.postLeaveConfirm}`]);
      expect(await draftKeys()).toEqual([]);
      await page.goto(write);
      await expect(titleInput).toBeEditable();
      await expect(titleInput).toHaveValue('');
      await expect(restored).toHaveCount(0);
      expect(writes).toEqual([]);
    } finally {
      await close();
    }
  });

  test('수정 화면에서 앞 계정이 고치던 것은 세션이 다른 회원으로 바뀌면 남의 글이라는 문장뿐이고 아무것도 보내지 않으며, 세션이 돌아오면 되살린다', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const asked: string[] = [];
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    const titleInput = page.getByTestId('post-title-input');
    const editor = page.getByTestId('post-editor-content');
    const restored = page.getByTestId('post-draft-restored');
    const { a, open, toB, toA, close } = await membersSwitchingSessions(browser, page);
    try {
      const tag = freshTag();
      const postId = await postThroughApi(page.request, market.id, `저장된 제목 ${tag}`, tag);
      await open(`/community/posts/${postId}/edit`);
      await expect(titleInput).toHaveValue(`저장된 제목 ${tag}`);
      await editorReady(editor);
      const typed = `앞 계정이 고치던 제목 ${tag}`;
      await titleInput.fill(typed);
      const writes = postWritesOf(page);

      // --- the session says B first: not B's post — the sentence in the form's place.
      await toB();
      await expect(page.getByTestId('post-edit-not-yours')).toBeVisible();
      await expect(titleInput).toHaveCount(0);
      await expect(page.getByText(typed)).toHaveCount(0);
      await expect
        .poll(async () => Object.keys(await draftsInTab(page)))
        .toEqual([`buddha.postDraft:edit:${postId}@${a.id}`]);
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);

      // --- A again: taken back; the post as it was saved.
      await toA();
      await expect(restored).toContainText(copy.postDraftRestored);
      await expect(titleInput).toHaveValue(typed);
      await expect(editor).toContainText(tag);
      await expect.poll(async () => Object.keys(await draftsInTab(page))).toEqual([]);
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);
    } finally {
      await close();
    }
  });

  test('글쓰기에서 세션이 다른 회원으로 바뀐 뒤 앞 계정이 돌아올 때 `GET /me`가 세션보다 먼저 앞 계정을 말해도, 되살린 글은 세션의 되돌리기 뒤에도 양식에 남는다 (ADR-0092 8-36)', async ({
    admin,
    browser,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const asked: string[] = [];
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    const titleInput = page.getByTestId('post-title-input');
    const editor = page.getByTestId('post-editor-content');
    const restored = page.getByTestId('post-draft-restored');
    const draftKeys = async () => Object.keys(await draftsInTab(page)).sort();
    const { a, open, toB, toAMeFirst, close } = await membersSwitchingSessions(browser, page);
    try {
      await open(`/community/write?market=${market.id}`);
      await expect(titleInput).toBeEditable();
      await editorReady(editor);
      const tag = freshTag();
      const title = `앞 계정이 쓰던 제목 ${tag}`;
      await titleInput.fill(title);
      await editor.click();
      await page.keyboard.type(`앞 계정이 쓰던 근거 ${tag}`);
      const writes = postWritesOf(page);

      // --- the session says B first: A's text kept as A's.
      await toB();
      await expect(titleInput).toBeEditable();
      await expect(titleInput).toHaveValue('');
      await expect.poll(draftKeys).toEqual([`buddha.postDraft:new:${market.id}@${a.id}`]);

      // --- A back, `GET /me` answering before the session: A's form, A's text taken back out of
      // the tab — then the session says A, and its reset takes that form away and draws it again.
      await toAMeFirst(async () => {
        await expect(restored).toContainText(copy.postDraftRestored);
        await expect(titleInput).toHaveValue(title);
        await expect.poll(draftKeys).toEqual([]);
      });
      await expect(restored).toContainText(copy.postDraftRestored);
      await expect(titleInput).toHaveValue(title);
      await expect(editor).toContainText(`앞 계정이 쓰던 근거 ${tag}`);
      await expect.poll(draftKeys).toEqual([]);
      expect(writes).toEqual([]);
      expect(asked).toEqual([]);
    } finally {
      await close();
    }
  });
});
