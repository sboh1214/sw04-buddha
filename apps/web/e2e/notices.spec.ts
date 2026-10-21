import type { APIRequestContext, APIResponse, Locator, Page } from '@playwright/test';
import { type Me, NOTICE_PIN_LIMIT } from '@buddha/shared';
import { copy } from '../src/copy';
import { adminAccount, expect, freshEmail, freshTag, meOf, signIn, signUp, test } from './helpers';

/**
 * 운영 공지 (#138, ADR-0077; owner decisions in ADR-0069 decision 2 #45-8 and decision 4 #138): an
 * admin writes a notice on the admin screen with the posts' editor (a required title, formatting,
 * a link and an image), pins it, and every visitor sees it in the fixed area above the community
 * list — '공지', its title, '운영팀', never the operator — and opens its page, read-only. An edit
 * shows '수정됨'. At most NOTICE_PIN_LIMIT are pinned: the next pin is refused and nothing is
 * unpinned to make room; an unpinned notice leaves the area, stays on the admin screen and is
 * pinned again. A member reaches neither the screen nor its API.
 *
 * The owner's answers of 2026-10-21: only a pinned notice is public — never pinned or unpinned, its
 * page and its images answer like a missing one's, and pinned again they come back; the admin's
 * notice screen shows the operation records (who, when, what) and the earlier versions, each
 * readable whole; a save opened before another save is refused — whoever saved first, in one
 * neutral sentence, '그사이 공지가 고쳐졌습니다. 최신 내용을 불러와 주세요.' (the second answers) —
 * what was typed kept, the latest version a press away; and leaving the write or edit form with
 * something typed asks first, as a post's does — a refused save still has something to lose — while
 * a saved form asks nothing (no tab draft). The onboarding gate, which moves an admin as it moves
 * anyone, takes a notice's form away without asking and keeps nothing of it: today's behaviour, a
 * known limit put to the owner (ADR-0077 decision 8-20, 결과 4), pinned here until the answer.
 *
 * The pinned set is the service's, one for every spec: both projects share one database, and the
 * limit and the area's order are about every notice pinned there. So the pinning runs once, in the
 * desktop project, in order — the area is opened at 375px in a context of its own — and it starts
 * by unpinning whatever an earlier run left pinned. The audit rows, the history and the race are
 * the API's tests (notices.controller.test.ts); this walks the screens.
 */

const NOTICES = '/api/v1/admin/notices';

/** A 1×1 PNG, as posts.spec.ts uploads. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${response.url()} -> ${String(response.status())} ${body}`);
  }
  return (JSON.parse(body) as { data: T }).data;
}

async function expectError(response: APIResponse, status: number, code: string): Promise<void> {
  expect(response.status(), response.url()).toBe(status);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
}

/** A server error as the API's envelope says it (discussion.spec.ts's): the client retries it. */
const SERVER_ERROR = {
  status: 500,
  contentType: 'application/json',
  body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal error' } }),
};

/** A write refused as the server refuses an account with a step left (posts.spec.ts's). */
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

/**
 * `GET /me` in this page answering as the server would after a revision of the terms that changed
 * members' rights — the consent step is the account's next — while `on` (posts.spec.ts's
 * `asReconsent`, without its agreeing: nothing here agrees again, so the seed admin's consents are
 * untouched). No spec can bring about a re-consent for real: the consent versions are the build's.
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
  return state;
}

/** The storage keys of the post drafts kept in this tab (lib/post-drafts.ts's sessionStorage). */
function draftsInTab(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(sessionStorage).filter((key) => key.startsWith('buddha.postDraft:')),
  );
}

/** The browser's reads of the fixed area (`GET /notices`), and no other notice read. */
const isPinnedRead = (url: URL) => url.pathname === '/api/v1/notices';

/** Every pinned notice unpinned through the admin API: the area starts empty, whatever ran before. */
async function unpinAll(admin: APIRequestContext): Promise<void> {
  const pinned = await dataOf<{ id: string }[]>(await admin.get(`${NOTICES}?state=pinned`));
  for (const { id } of pinned) await dataOf(await admin.post(`${NOTICES}/${id}/unpin`));
}

/** A notice straight at the admin API, unpinned, for a step whose subject is not its writing. */
async function noticeThroughApi(admin: APIRequestContext, title: string): Promise<string> {
  const res = await admin.post(NOTICES, {
    data: {
      title,
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: `${title} 본문` }] }],
      },
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** A notice with one image, straight at the admin API, unpinned: its id and the image's. */
async function noticeWithImageThroughApi(
  admin: APIRequestContext,
  title: string,
): Promise<{ id: string; mediaId: string }> {
  const { id: accountId } = await meOf(admin);
  const uploaded = await admin.post(`/api/v1/media/images?expectedAccountId=${accountId}`, {
    data: PNG,
    headers: { 'content-type': 'image/png' },
  });
  const mediaId = (await dataOf<{ id: string }>(uploaded)).id;
  const res = await admin.post(NOTICES, {
    data: {
      title,
      body: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: `${title} 본문` }] },
          { type: 'image', attrs: { mediaId } },
        ],
      },
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return { id: ((await res.json()) as { data: { id: string } }).data.id, mediaId };
}

/** Whether an `<img>` has loaded its bytes. */
const loaded = (image: Locator) =>
  image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);

/** Pastes `html` into the editor as a browser does from another page (posts.spec.ts's helper). */
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

/** The notice id of the admin edit screen or the notice page the browser is on. */
function noticeIdOf(page: Page): string {
  const match = /\/notices\/([0-9a-f-]{36})$/.exec(new URL(page.url()).pathname);
  if (match?.[1] === undefined) throw new Error(`not a notice page: ${page.url()}`);
  return match[1];
}

const adminRow = (page: Page, id: string) => page.getByTestId(`admin-notice-${id}`);
const pinnedList = (page: Page) => page.getByTestId('admin-notices-pinned');
const unpinnedList = (page: Page) => page.getByTestId('admin-notices-unpinned');

test.describe('운영 공지 (#138)', () => {
  test.describe('고정과 해제', () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(
      ({ isMobile }) => isMobile,
      'the pinned set is shared: pinning runs once, on desktop',
    );

    test('관리자가 공지를 쓰고 고정하면 커뮤니티 목록 위에 보이고, 고치면 수정됨이 붙고, 넷째 고정은 거절되며, 해제한 공지는 빠졌다가 다시 고정된다', async ({
      admin,
      page,
      browser,
      request,
    }) => {
      const tag = freshTag();
      const nickname = (await meOf(admin)).profile.nickname;
      await unpinAll(admin);
      const visitorContext = await browser.newContext();
      const phoneContext = await browser.newContext({
        viewport: { width: 375, height: 812 },
        isMobile: true,
      });
      // The server's HTML alone: what a visitor gets before (or without) any script.
      const noScriptContext = await browser.newContext({ javaScriptEnabled: false });
      try {
        const visitor = await visitorContext.newPage();

        // --- the admin edit screen at no notice: an unknown id, and a segment that is not a uuid.
        await signIn(page, adminAccount.email, adminAccount.password);
        for (const address of [
          '/admin/notices/00000000-0000-4000-8000-000000000000',
          '/admin/notices/not-a-uuid',
        ]) {
          await page.goto(address);
          await expect(page.getByTestId('admin-notice-not-found')).toHaveText(
            copy.adminNoticeNotFound,
          );
          await expect(page.getByTestId('admin-notice-edit')).toHaveCount(0);
        }

        // --- the admin screen, from the admin menu: nothing pinned yet.
        await page.goto('/admin/markets');
        await page
          .getByTestId('admin-nav')
          .getByRole('link', { name: copy.adminNotices, exact: true })
          .click();
        await expect(page).toHaveURL('/admin/notices');
        await expect(pinnedList(page).getByTestId('admin-notices-pinned-empty')).toHaveText(
          copy.adminNoticesPinnedEmpty,
        );
        await expect(page.getByTestId('admin-notices-pinned-count')).toHaveText(
          `0 / ${String(NOTICE_PIN_LIMIT)}`,
        );

        // --- 공지 쓰기: the posts' editor, with a required title (#138 «제목 필수»).
        await page.getByTestId('admin-notice-write').click();
        await expect(page).toHaveURL('/admin/notices/new');
        const editor = page.getByTestId('post-editor-content');
        await editor.click();
        await page.getByTestId('post-editor-bold').click();
        await page.keyboard.type('점검 시간');
        await page.getByTestId('post-editor-bold').click();
        await page.keyboard.type(` 안내 ${tag}`);
        await page.keyboard.press('Enter');
        await pasteHtml(editor, '<a href="https://example.com/notice">자세한 안내</a>');
        await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com/notice');
        await page
          .getByTestId('post-editor-file')
          .setInputFiles({ name: 'notice.png', mimeType: 'image/png', buffer: PNG });
        await expect(editor.locator('img[data-media-id]')).toHaveCount(1);
        const mediaId = (await editor.locator('img[data-media-id]').getAttribute('data-media-id'))!;
        const publicImage = `/api/v1/media/${mediaId}`;
        // The upload done (it holds the send too), only the missing title holds it now.
        await expect(page.getByTestId('post-editor-uploading')).toHaveCount(0);
        // No title, no send: the field is required, labelled as a notice's — exactly, not the
        // post's '제목 (선택)', whose text holds the notice's (and so does the editor's 제목 select).
        const titleInput = page.getByTestId('post-title-input');
        await expect(titleInput).toHaveJSProperty('required', true);
        const titleLabel = page.getByTestId('post-form').locator('label').first();
        await expect(titleLabel).toHaveText(copy.noticeWriteTitleLabel);
        expect(await titleLabel.getAttribute('for')).toBe(await titleInput.getAttribute('id'));
        await expect(page.getByTestId('post-form').getByText(copy.postWriteTitleLabel)).toHaveCount(
          0,
        );
        await expect(page.getByTestId('post-submit')).toBeDisabled();
        await titleInput.fill('   ');
        await expect(page.getByTestId('post-submit')).toBeDisabled(); // a blank title is none
        const title = `서버 점검 ${tag}`;
        await titleInput.fill(title);
        await expect(page.getByTestId('post-submit')).toBeEnabled();
        await titleInput.fill('');
        await expect(page.getByTestId('post-submit')).toBeDisabled();
        await titleInput.fill(title);
        await page.getByTestId('post-submit').click();
        await expect(page.getByText(copy.adminNoticeCreated)).toBeVisible();
        await expect(page).toHaveURL('/admin/notices');

        // Written unpinned: in the unpinned list, its title the way to its screen, with 고정.
        const titleLink = unpinnedList(page).getByRole('link', { name: title, exact: true });
        await expect(titleLink).toHaveAttribute('href', /^\/admin\/notices\/[0-9a-f-]{36}$/);
        const first = (await titleLink.getAttribute('href'))!.split('/').pop()!;
        await expect(adminRow(page, first).getByTestId('admin-notice-pin')).toBeVisible();
        await visitor.goto('/community');
        await expect(visitor.getByTestId('community-notices')).toHaveCount(0);
        // Not pinned, not public (owner decision 2026-10-21): its page and its image are missing,
        // and its row offers no public page.
        expect((await visitor.goto(`/community/notices/${first}`))?.status()).toBe(404);
        expect((await request.get(publicImage)).status()).toBe(404);
        await expect(adminRow(page, first).getByTestId('admin-notice-view')).toHaveCount(0);

        // --- 고정: it moves to the pinned list, and the fixed area shows it to everyone.
        await adminRow(page, first).getByTestId('admin-notice-pin').click();
        await expect(page.getByText(copy.adminNoticePinnedToast)).toBeVisible();
        await expect(pinnedList(page).getByTestId(`admin-notice-${first}`)).toBeVisible();
        await expect(unpinnedList(page).getByTestId(`admin-notice-${first}`)).toHaveCount(0);
        await expect(page.getByTestId('admin-notices-pinned-count')).toHaveText(
          `1 / ${String(NOTICE_PIN_LIMIT)}`,
        );

        // The community list's HTML holds the area itself, drawn by the server — not only the
        // notices in the page's data, which hold the title too: without a script, the row is there.
        const noScript = await noScriptContext.newPage();
        await noScript.goto('/community');
        await expect(
          noScript
            .getByTestId('community-notices')
            .getByTestId(`community-notice-${first}`)
            .getByTestId('community-notice-title'),
        ).toHaveText(title);
        await visitor.goto('/community');
        const area = visitor.getByTestId('community-notices');
        await expect(area).toHaveAttribute('aria-label', copy.noticesLabel);
        const row = area.getByTestId(`community-notice-${first}`);
        await expect(row.getByTestId('community-notice-title')).toHaveText(title);
        await expect(row).toContainText(copy.noticeBadge);
        await expect(row.getByTestId('notice-author')).toHaveText(copy.noticeAuthor);
        await expect(row.getByTestId('notice-edited')).toHaveCount(0);
        await expect(area).not.toContainText(nickname);
        await expect(area).not.toContainText(copy.postAuthorAdmin);
        // Above the list and its controls, apart from the posts.
        await expect(visitor.getByTestId('community-posts').getByText(title)).toHaveCount(0);
        const areaBox = await area.boundingBox();
        const searchBox = await visitor.getByTestId('community-search-input').boundingBox();
        expect(areaBox!.y).toBeLessThan(searchBox!.y);
        // On a filtered list too: the area is fixed, never one of the results.
        await visitor.goto(`/community?q=${freshTag()}`);
        await expect(visitor.getByTestId('community-empty')).toBeVisible();
        await expect(visitor.getByTestId(`community-notice-${first}`)).toBeVisible();

        // A refresh that fails keeps the rows, with no failure over them (ADR-0077 decision 8-10).
        // The page's clock, so the seeded read can be made older than `staleTime` (30 s) without
        // waiting, and a refocus reads the area again (discussion.spec.ts's way).
        const watcher = await visitorContext.newPage();
        await watcher.clock.install();
        await watcher.goto('/community');
        const watched = watcher.getByTestId('community-notices');
        await expect(watched.getByTestId(`community-notice-${first}`)).toBeVisible();
        let refused = 0;
        await watcher.route(isPinnedRead, (route) => {
          refused += 1;
          return route.fulfill(SERVER_ERROR);
        });
        await watcher.clock.fastForward('00:31');
        await watcher.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
        // Marked once the refresh has failed through the client's retries: the rows stayed.
        await expect(watched).toHaveAttribute('data-refresh-failed', 'true');
        expect(refused).toBeGreaterThan(0);
        await expect(watched.getByTestId(`community-notice-${first}`)).toBeVisible();
        await expect(watcher.getByTestId('community-notices-error')).toHaveCount(0);
        await watcher.close();

        // At 375px the row fits the screen: one line of title, no sideways scroll.
        const phone = await phoneContext.newPage();
        await phone.goto('/community');
        await expect(phone.getByTestId(`community-notice-${first}`)).toBeVisible();
        expect(
          await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);

        // --- the notice page: read-only, '운영팀', the body as a post's.
        await visitor.goto('/community');
        await visitor.getByTestId(`community-notice-${first}`).getByRole('link').click();
        await expect(visitor).toHaveURL(`/community/notices/${first}`);
        await expect(visitor.getByTestId('notice-badge')).toHaveText(copy.noticeBadge);
        await expect(visitor.getByRole('heading', { level: 2, name: title })).toBeVisible();
        await expect(visitor.getByTestId('notice-author')).toHaveText(copy.noticeAuthor);
        await expect(visitor.getByTestId('notice-edited')).toHaveCount(0);
        const body = visitor.getByTestId('post-body');
        await expect(body.locator('strong')).toHaveText('점검 시간');
        await expect(body).toContainText(`안내 ${tag}`);
        const link = body.getByRole('link', { name: '자세한 안내' });
        await expect(link).toHaveAttribute('href', 'https://example.com/notice');
        await expect(link).toHaveAttribute('rel', /noopener/);
        const image = body.getByTestId('post-image');
        await expect(image).toHaveAttribute('src', publicImage);
        await expect.poll(() => loaded(image)).toBe(true);
        // No comment, like or report (#45-8), and no operator anywhere on it.
        await expect(visitor.getByTestId('comments-heading')).toHaveCount(0);
        await expect(visitor.getByTestId('post-author-actions')).toHaveCount(0);
        await expect(visitor.getByTestId('notice-screen')).not.toContainText(nickname);
        // Not indexed: a robots meta that says `noindex` and none that says otherwise — counted, as
        // posts.spec.ts does, since the move from the community list (itself `noindex` since #46's
        // follow-up) can leave that page's tag beside this one's — and the page's own tag in its
        // server HTML.
        await expect(
          visitor.locator('meta[name="robots"][content*="noindex"]').first(),
        ).toBeAttached();
        await expect(visitor.locator('meta[name="robots"]:not([content*="noindex"])')).toHaveCount(
          0,
        );
        const noticeHtml = await (await request.get(`/community/notices/${first}`)).text();
        expect(noticeHtml).toMatch(/<meta name="robots" content="noindex"\s*\/?>/);
        expect(noticeHtml).not.toContain(nickname);
        await visitor.getByTestId('notice-back').click();
        await expect(visitor).toHaveURL('/community');

        // --- an edit, from the title on the admin screen: '수정됨' everywhere it is drawn.
        await adminRow(page, first).getByTestId('admin-notice-title').click();
        await expect(page).toHaveURL(`/admin/notices/${first}`);
        await expect(page.getByTestId('admin-notice-state')).toHaveText(
          copy.adminNoticeStatePinned,
        );
        await expect(titleInput).toHaveValue(title);
        // The editor draws the notice's image through the admin route (pinned or not, it is there).
        const editorImage = page.getByTestId('post-editor-content').locator('img[data-media-id]');
        await expect(editorImage).toHaveAttribute(
          'src',
          `/api/v1/admin/notices/${first}/images/${mediaId}`,
        );
        await expect.poll(() => loaded(editorImage)).toBe(true);
        // The same content changes nothing, and says so.
        await expect(page.getByTestId('post-editor-content')).toBeVisible();
        await page.getByTestId('post-submit').click();
        await expect(page.getByText(copy.adminNoticeUnchanged)).toBeVisible();
        const edited = `${title} (변경)`;
        await titleInput.fill(edited);
        await page.getByTestId('post-submit').click();
        await expect(page.getByText(copy.adminNoticeSaved)).toBeVisible();
        await visitor.goto(`/community/notices/${first}`);
        await expect(visitor.getByTestId('notice-title')).toHaveText(edited);
        await expect(visitor.getByTestId('notice-edited')).toHaveText(copy.postEdited);
        await expect(visitor.getByTestId('post-body').getByTestId('post-image')).toHaveCount(1);
        await visitor.goto('/community');
        await expect(
          visitor.getByTestId(`community-notice-${first}`).getByTestId('notice-edited'),
        ).toHaveText(copy.postEdited);

        // --- the limit: two more pinned fill the area; the fourth is refused, nothing unpinned.
        const second = await noticeThroughApi(admin, `둘째 공지 ${tag}`);
        const third = await noticeThroughApi(admin, `셋째 공지 ${tag}`);
        const fourth = await noticeThroughApi(admin, `넷째 공지 ${tag}`);
        await dataOf(await admin.post(`${NOTICES}/${second}/pin`));
        await dataOf(await admin.post(`${NOTICES}/${third}/pin`));
        await page.goto('/admin/notices');
        await expect(page.getByTestId('admin-notices-pinned-count')).toHaveText(
          `${String(NOTICE_PIN_LIMIT)} / ${String(NOTICE_PIN_LIMIT)}`,
        );
        await adminRow(page, fourth).getByTestId('admin-notice-pin').click();
        await expect(page.getByText(copy.errNoticePinLimit)).toBeVisible();
        await expect(unpinnedList(page).getByTestId(`admin-notice-${fourth}`)).toBeVisible();
        await expect(pinnedList(page).getByTestId('admin-notice-title')).toHaveCount(
          NOTICE_PIN_LIMIT,
        );
        await expect(pinnedList(page).getByTestId(`admin-notice-${first}`)).toBeVisible();
        await expectError(
          await admin.post(`${NOTICES}/${fourth}/pin`),
          409,
          'NOTICE_PIN_LIMIT_REACHED',
        );
        // The area: the latest pinned first, the first still there.
        await visitor.goto('/community');
        await expect(
          visitor.getByTestId('community-notices').getByTestId('community-notice-title'),
        ).toHaveText([`셋째 공지 ${tag}`, `둘째 공지 ${tag}`, edited]);

        // --- 고정 해제: out of the area and out of the public, kept on the admin screen.
        await pinnedList(page)
          .getByTestId(`admin-notice-${first}`)
          .getByTestId('admin-notice-unpin')
          .click();
        await expect(page.getByText(copy.adminNoticeUnpinnedToast)).toBeVisible();
        await expect(unpinnedList(page).getByTestId(`admin-notice-${first}`)).toBeVisible();
        await expect(page.getByTestId('admin-notices-pinned-count')).toHaveText(
          `2 / ${String(NOTICE_PIN_LIMIT)}`,
        );
        await visitor.goto('/community');
        await expect(
          visitor.getByTestId('community-notices').getByTestId('community-notice-title'),
        ).toHaveText([`셋째 공지 ${tag}`, `둘째 공지 ${tag}`]);
        // Its page and image are missing now (owner decision 2026-10-21); its row has no 공지 보기.
        expect((await visitor.goto(`/community/notices/${first}`))?.status()).toBe(404);
        expect((await request.get(publicImage)).status()).toBe(404);
        await expect(adminRow(page, first).getByTestId('admin-notice-view')).toHaveCount(0);

        // A slot is free: the fourth pins now, on top; the first is pinned again from its screen.
        await adminRow(page, fourth).getByTestId('admin-notice-pin').click();
        await expect(pinnedList(page).getByTestId(`admin-notice-${fourth}`)).toBeVisible();
        await page.goto(`/admin/notices/${first}`);
        await expect(page.getByTestId('admin-notice-state')).toHaveText(
          copy.adminNoticeStateUnpinned,
        );
        await page.getByTestId('admin-notice-pin').click();
        await expect(page.getByText(copy.errNoticePinLimit)).toBeVisible();
        await dataOf(await admin.post(`${NOTICES}/${second}/unpin`));
        await page.getByTestId('admin-notice-pin').click();
        await expect(page.getByTestId('admin-notice-state')).toHaveText(
          copy.adminNoticeStatePinned,
        );
        expect(noticeIdOf(page)).toBe(first);
        await visitor.goto('/community');
        await expect(
          visitor.getByTestId('community-notices').getByTestId('community-notice-title'),
        ).toHaveText([edited, `넷째 공지 ${tag}`, `셋째 공지 ${tag}`]);
        // Pinned again, public again: its page and its image.
        expect((await visitor.goto(`/community/notices/${first}`))?.status()).toBe(200);
        await expect(visitor.getByTestId('notice-title')).toHaveText(edited);
        await expect.poll(() => loaded(visitor.getByTestId('post-image'))).toBe(true);

        // --- the operation records and the earlier version on its screen (2026-10-21): who did
        // what and when, newest first — the refused pin and the save of the same content left
        // none — and the version the edit replaced, readable whole.
        await page.reload();
        const records = page.getByTestId('admin-notice-actions');
        await expect(records.getByTestId('admin-notice-action-type')).toHaveText([
          copy.adminNoticeActionPin,
          copy.adminNoticeActionUnpin,
          copy.adminNoticeActionUpdate,
          copy.adminNoticeActionPin,
          copy.adminNoticeActionCreate,
        ]);
        await expect(records.getByTestId('admin-notice-action-actor')).toHaveText(
          Array.from({ length: 5 }, () => nickname),
        );
        const versions = page.getByTestId('admin-notice-revisions');
        await expect(versions.getByTestId('admin-notice-revision-title')).toHaveText([title]);
        await expect(versions.getByTestId('admin-notice-revision-written')).toContainText(nickname);
        await expect(versions.getByTestId('admin-notice-revision-replaced')).toContainText(
          nickname,
        );
        // The edit's record and the version both open the version it replaced, read-only.
        const fromRecord = await records
          .getByTestId('admin-notice-action-revision')
          .getAttribute('href');
        await versions.getByTestId('admin-notice-revision-title').click();
        await expect(page).toHaveURL(fromRecord!);
        await expect(page.getByTestId('admin-notice-revision-heading')).toHaveText(title);
        const old = page.getByTestId('admin-notice-revision').getByTestId('post-body');
        await expect(old).toContainText(`안내 ${tag}`);
        await expect(old.getByTestId('post-image')).toHaveAttribute(
          'src',
          `/api/v1/admin/notices/${first}/images/${mediaId}`,
        );
        await expect.poll(() => loaded(old.getByTestId('post-image'))).toBe(true);
        await expect(page.getByTestId('post-form')).toHaveCount(0);
        await page.getByTestId('admin-notice-revision-back').click();
        await expect(page).toHaveURL(`/admin/notices/${first}`);
      } finally {
        await visitorContext.close();
        await phoneContext.close();
        await noScriptContext.close();
        await unpinAll(admin);
      }
    });
  });

  test('관리자가 아닌 계정은 공지 화면과 API에 닿지 못하고, 고정하지 않은 공지는 주소로도 이미지로도 읽히지 않는다', async ({
    admin,
    page,
    request,
  }) => {
    const tag = freshTag();
    const { id, mediaId } = await noticeWithImageThroughApi(admin, `고정하지 않은 공지 ${tag}`);

    // Signed out: the admin gate sends the visitor to sign in, and the API asks for a session.
    await page.goto('/admin/notices');
    await page.waitForURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('next')).toBe('/admin/notices');
    await expectError(await request.post(NOTICES, { data: {} }), 401, 'UNAUTHENTICATED');

    // A notice no one pinned is not public (owner decision 2026-10-21): its page, its API and its
    // image answer as an unknown notice's do. The admin screens still read it, image and all.
    expect((await page.goto(`/community/notices/${id}`))?.status()).toBe(404);
    await expectError(await request.get(`/api/v1/notices/${id}`), 404, 'NOT_FOUND');
    expect((await request.get(`/api/v1/media/${mediaId}`)).status()).toBe(404);
    expect((await admin.get(`${NOTICES}/${id}/images/${mediaId}`)).status()).toBe(200);
    const missing = await page.goto('/community/notices/00000000-0000-4000-8000-000000000000');
    expect(missing?.status()).toBe(404);
    expect((await page.goto('/community/notices/not-a-notice'))?.status()).toBe(404);

    // A member: the admin layout sends it home, and the API refuses every notice read and write.
    await signUp(page, freshEmail());
    await page.goto('/admin/notices');
    await expect(page).toHaveURL('/');
    await expect(page.getByTestId('admin-notices')).toHaveCount(0);
    await page.goto('/admin/notices/new');
    await expect(page).toHaveURL('/');
    await page.goto(`/admin/notices/${id}/revisions/1`);
    await expect(page).toHaveURL('/');
    await expectError(await page.request.get(`${NOTICES}?state=pinned`), 403, 'FORBIDDEN');
    for (const path of ['actions', 'revisions', 'revisions/1', `images/${mediaId}`]) {
      await expectError(await page.request.get(`${NOTICES}/${id}/${path}`), 403, 'FORBIDDEN');
    }
    await expectError(
      await page.request.post(NOTICES, {
        data: { title: '회원의 공지', body: { type: 'doc', content: [] } },
      }),
      403,
      'FORBIDDEN',
    );
    await expectError(
      await page.request.put(`${NOTICES}/${id}`, {
        data: {
          title: '회원이 고친 공지',
          body: { type: 'doc', content: [] },
          expectedEditedAt: null,
        },
      }),
      403,
      'FORBIDDEN',
    );
    await expectError(await page.request.post(`${NOTICES}/${id}/pin`), 403, 'FORBIDDEN');
    await expectError(await page.request.post(`${NOTICES}/${id}/unpin`), 403, 'FORBIDDEN');
    // Nothing changed: still unpinned and as written.
    const after = await dataOf<{ title: string; pinnedAt: string | null }>(
      await admin.get(`${NOTICES}/${id}`),
    );
    expect(after).toMatchObject({ title: `고정하지 않은 공지 ${tag}`, pinnedAt: null });
  });

  test('다른 운영자가 먼저 고친 공지의 저장은 막히고 쓰던 내용은 남으며, 최신 내용을 불러와 다시 저장한다', async ({
    admin,
    secondAdmin,
    page,
  }) => {
    // Owner decisions 2026-10-21: «동시 수정 → 연 뒤 다른 운영자가 고쳤으면 저장을 막고 … 쓰던 내용은
    // 화면에 남김», in a neutral sentence whoever saved first (the second answers). Never pinned: the
    // pinned set is not touched.
    const tag = freshTag();
    // One question, and one only: the header link pressed with the refusal on screen — a refused
    // save moves nothing, so what was typed is still to lose. 최신 내용 불러오기 opens the form again
    // in place and asks nothing (ADR-0077 decision 8-20). Every question is recorded, and
    // dismissed — the page stays.
    const asked: string[] = [];
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    const id = await noticeThroughApi(admin, `동시 수정 공지 ${tag}`);
    const mine = (await meOf(admin)).profile.nickname;
    const theirs = (await meOf(secondAdmin)).profile.nickname;

    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto(`/admin/notices/${id}`);
    const titleInput = page.getByTestId('post-title-input');
    await expect(titleInput).toHaveValue(`동시 수정 공지 ${tag}`);
    await expect(page.getByTestId('admin-notice-revisions-empty')).toHaveText(
      copy.adminNoticeRevisionsEmpty,
    );
    // Not pinned: no public page to open from here.
    await expect(page.getByTestId('admin-notice-view')).toHaveCount(0);
    const typed = `내가 고친 제목 ${tag}`;
    await titleInput.fill(typed);

    // Meanwhile the other admin saves, from the version this screen opened — a body with a
    // heading, which its earlier version's screen draws under the version's title.
    const theirTitle = `다른 운영자가 고친 제목 ${tag}`;
    const theirHeading = `다른 운영자의 소제목 ${tag}`;
    await dataOf(
      await secondAdmin.put(`${NOTICES}/${id}`, {
        data: {
          title: theirTitle,
          body: {
            type: 'doc',
            content: [
              {
                type: 'heading',
                attrs: { level: 1 },
                content: [{ type: 'text', text: theirHeading }],
              },
              { type: 'paragraph', content: [{ type: 'text', text: '다른 본문' }] },
            ],
          },
          expectedEditedAt: null,
        },
      }),
    );

    // This save is refused in the owner's neutral sentence, naming nobody; what was typed stays.
    await page.getByTestId('post-submit').click();
    const refusal = page.getByTestId('post-form-error');
    await expect(refusal).toContainText(copy.errNoticeEditConflict);
    await expect(refusal).toContainText(copy.adminNoticeEditConflictHint);
    await expect(refusal).not.toContainText(theirs);
    await expect(titleInput).toHaveValue(typed);
    // Left with the refusal on screen, the form asks first: the refused save did not make what was
    // typed the form's start. Dismissed, the screen, the title and the refusal all stay.
    const question = `confirm: ${copy.postLeaveConfirm}`;
    await page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link').click();
    await expect.poll(() => asked).toEqual([question]);
    await expect(page).toHaveURL(`/admin/notices/${id}`);
    await expect(titleInput).toHaveValue(typed);
    await expect(refusal).toContainText(copy.errNoticeEditConflict);
    // The screen read the notice again: the other admin's edit is in its records, and the state
    // card says '수정됨' — the screen's notice is the other admin's version now.
    const records = page.getByTestId('admin-notice-actions');
    await expect(records.getByTestId('admin-notice-action-type')).toHaveText([
      copy.adminNoticeActionUpdate,
      copy.adminNoticeActionCreate,
    ]);
    await expect(records.getByTestId('admin-notice-action-actor')).toHaveText([theirs, mine]);
    await expect(page.getByTestId('admin-notice-pin-card')).toContainText(copy.postEdited);
    // Saved again without 최신 내용 불러오기, it is refused again: the form still saves against the
    // version it opened, not the one the screen read since — or this would write over the other
    // admin's edit with a draft never made from it.
    await page.getByTestId('post-submit').click();
    await expect(refusal).toContainText(copy.errNoticeEditConflict);
    await expect(titleInput).toHaveValue(typed);
    expect((await dataOf<{ title: string }>(await admin.get(`${NOTICES}/${id}`))).title).toBe(
      theirTitle,
    );
    // The API refuses it the same way, with the version the notice is at now.
    await expectError(
      await admin.put(`${NOTICES}/${id}`, {
        data: {
          title: typed,
          body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
          },
          expectedEditedAt: null,
        },
      }),
      409,
      'NOTICE_EDIT_CONFLICT',
    );

    // 최신 내용 불러오기 that cannot read the notice says so once, in a toast, and leaves the form
    // as it was — the draft and the refusal. The screen's own refresh warning is the other notice
    // on screen, and the toast does not repeat it.
    const noticeRead = (url: URL) => url.pathname === `/api/v1/admin/notices/${id}`;
    await page.route(noticeRead, (route) =>
      route.request().method() === 'GET' ? route.fulfill(SERVER_ERROR) : route.fallback(),
    );
    await page.getByTestId('admin-notice-reload').click();
    await expect(page.getByText(copy.errUnknown)).toHaveCount(1);
    await expect(page.getByText(copy.adminNoticeRefreshFailed)).toHaveCount(1);
    await expect(titleInput).toHaveValue(typed);
    await expect(refusal).toContainText(copy.errNoticeEditConflict);
    await page.unroute(noticeRead);

    // 최신 내용 불러오기: the form opens again on the other admin's version, the focus on its
    // title (the press's button went with the old form), and saves from it.
    await page.getByTestId('admin-notice-reload').click();
    await expect(titleInput).toHaveValue(theirTitle);
    await expect(titleInput).toBeFocused();
    await expect(page.getByTestId('post-form-error')).toHaveCount(0);
    // Dropping what was typed for the latest version asked nothing: the hint said so beforehand.
    expect(asked).toEqual([question]);
    await titleInput.fill(typed);
    await page.getByTestId('post-submit').click();
    await expect(page.getByText(copy.adminNoticeSaved)).toBeVisible();
    // Two earlier versions now, the newest first: the other admin's and the first.
    const versions = page.getByTestId('admin-notice-revisions');
    await expect(versions.getByTestId('admin-notice-revision-title')).toHaveText([
      theirTitle,
      `동시 수정 공지 ${tag}`,
    ]);
    expect((await dataOf<{ title: string }>(await admin.get(`${NOTICES}/${id}`))).title).toBe(
      typed,
    );

    // Saved again from the same form, it goes through: the form now holds the version its last
    // save made, not the one it opened on.
    const typedAgain = `${typed} 다시`;
    await titleInput.fill(typedAgain);
    await page.getByTestId('post-submit').click();
    await expect
      .poll(
        async () => (await dataOf<{ title: string }>(await admin.get(`${NOTICES}/${id}`))).title,
      )
      .toBe(typedAgain);
    await expect(page.getByTestId('post-form-error')).toHaveCount(0);
    await expect(versions.getByTestId('admin-notice-revision-title')).toHaveText([
      typed,
      theirTitle,
      `동시 수정 공지 ${tag}`,
    ]);
    // Each edit's record names its version by the record's time as well, for a list of links.
    const editRows = records
      .locator('[data-testid^="admin-notice-action-"]')
      .filter({ has: page.getByTestId('admin-notice-action-revision') });
    await expect(editRows).toHaveCount(3);
    for (const row of await editRows.all()) {
      const time = await row.getByTestId('admin-notice-action-time').textContent();
      await expect(row.getByTestId('admin-notice-action-revision')).toHaveAccessibleName(
        `${time ?? ''} ${copy.adminNoticeActionRevision}`,
      );
    }

    // The other admin's version, on its own screen: its heading sits under the version's title
    // (an h3 under the admin layout's h2), not beside it.
    await versions.getByTestId('admin-notice-revision-title').nth(1).click();
    const version = page.getByTestId('admin-notice-revision');
    await expect(page.getByTestId('admin-notice-revision-heading')).toHaveText(theirTitle);
    await expect(version.getByRole('heading', { level: 3 })).toHaveText([theirTitle]);
    await expect(version.getByRole('heading', { level: 4 })).toHaveText([theirHeading]);
    // Left after its last save, the form had nothing to lose: no question on the way.
    expect(asked).toEqual([question]);
  });

  test('다른 운영자가 저장한 뒤 다시 연 수정 화면은 그 판으로 열리고, 저장은 막히지 않는다', async ({
    admin,
    secondAdmin,
    page,
  }) => {
    // The owner's rule blocks a save made after the screen opened (2026-10-21 7, «연 뒤»). The
    // screen keeps the notice it read when it is left; opened again — through the list, in the
    // same browser, before that copy is 30 s old — it must not open the form on that copy, older
    // than the other admin's save, and then refuse the first save. Never pinned.
    const tag = freshTag();
    const first = `다시 연 공지 ${tag}`;
    const id = await noticeThroughApi(admin, first);

    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto(`/admin/notices/${id}`);
    const titleInput = page.getByTestId('post-title-input');
    await expect(titleInput).toHaveValue(first);
    await page.getByTestId('admin-notice-back').click();
    await expect(page).toHaveURL('/admin/notices');

    // The other admin saves while this screen is closed.
    const theirTitle = `다른 운영자가 고친 제목 ${tag}`;
    await dataOf(
      await secondAdmin.put(`${NOTICES}/${id}`, {
        data: {
          title: theirTitle,
          body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '다른 본문' }] }],
          },
          expectedEditedAt: null,
        },
      }),
    );

    // Opened again from the list (no page load): the form is the other admin's version.
    await adminRow(page, id).getByTestId('admin-notice-title').click();
    await expect(page).toHaveURL(`/admin/notices/${id}`);
    await expect(titleInput).toHaveValue(theirTitle);
    await expect(page.getByTestId('admin-notice-pin-card')).toContainText(copy.postEdited);
    // And saves from it, refused by no one.
    const mine = `다시 연 화면에서 고친 제목 ${tag}`;
    await titleInput.fill(mine);
    await page.getByTestId('post-submit').click();
    await expect(page.getByText(copy.adminNoticeSaved)).toBeVisible();
    await expect(page.getByTestId('post-form-error')).toHaveCount(0);
    expect((await dataOf<{ title: string }>(await admin.get(`${NOTICES}/${id}`))).title).toBe(mine);
  });

  test('쓰던 공지를 두고 머리의 링크로 떠나면 먼저 묻고, 탭에 남기지 않으며, 저장한 뒤에는 묻지 않는다', async ({
    admin,
    page,
  }) => {
    // Owner decision 2026-10-21 8: «공지 쓰기·수정 화면 → 떠날 때 묻기만(탭 보관 없음)» — the posts'
    // question (#46, '쓰던 내용이 사라집니다. 나갈까요?'). Never pinned: the pinned set is not touched.
    const tag = freshTag();
    // Every dialog is recorded and answered from `answers` — dismissed when none was expected, which
    // keeps the page where it is and fails the address the step expects.
    const asked: string[] = [];
    const answers: boolean[] = [];
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void (answers.shift() === true ? dialog.accept() : dialog.dismiss());
    });
    const question = `confirm: ${copy.postLeaveConfirm}`;
    // The wordmark in the header, a Next.js link on every screen and both widths.
    const home = page.getByRole('heading', { level: 1, name: copy.appName }).getByRole('link');
    const titleInput = page.getByTestId('post-title-input');
    const editor = page.getByTestId('post-editor-content');
    await signIn(page, adminAccount.email, adminAccount.password);

    // --- 공지 쓰기 with a title typed: the header link asks; refused, the screen and title stay.
    await page.goto('/admin/notices/new');
    const leaving = `떠나기 전 공지 ${tag}`;
    await titleInput.fill(leaving);
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([question]);
    await expect(page).toHaveURL('/admin/notices/new');
    await expect(titleInput).toHaveValue(leaving);
    // Allowed, it leaves, and keeps nothing: the screen opens empty again, nothing taken back.
    answers.push(true);
    await home.click();
    await expect(page).toHaveURL('/');
    await page.goto('/admin/notices/new');
    await expect(editor).toBeVisible();
    await expect(titleInput).toHaveValue('');
    await expect(page.getByTestId('post-draft-restored')).toHaveCount(0);
    // Sent, it moves to the list without asking: the form holds still from the send on.
    const written = `떠나기 시험 공지 ${tag}`;
    await titleInput.fill(written);
    await editor.click();
    await page.keyboard.type('쓴 본문');
    await page.getByTestId('post-submit').click();
    await expect(page).toHaveURL('/admin/notices');
    expect(asked).toEqual([question, question]);

    // --- its edit screen, untouched — into the body and out: nothing to lose, nothing asked.
    await unpinnedList(page).getByRole('link', { name: written, exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/notices\/[0-9a-f-]{36}$/);
    const id = noticeIdOf(page);
    const edit = `/admin/notices/${id}`;
    await expect(titleInput).toHaveValue(written);
    await editor.click();
    await home.click();
    await expect(page).toHaveURL('/');
    expect(asked).toHaveLength(2);

    // --- the title and the body changed: asks; refused, what was typed stays.
    await page.goto(edit);
    await expect(titleInput).toHaveValue(written);
    const edited = `고친 떠나기 시험 공지 ${tag}`;
    await titleInput.fill(edited);
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 더한 본문');
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toEqual([question, question, question]);
    await expect(page).toHaveURL(edit);
    await expect(titleInput).toHaveValue(edited);
    await expect(editor).toContainText('더한 본문');

    // --- saved: the screen stays on the form, and what it holds is the notice now — leaving asks
    // nothing until something changes again.
    await page.getByTestId('post-submit').click();
    await expect(page.getByText(copy.adminNoticeSaved)).toBeVisible();
    const saved = await dataOf<{ title: string; body: unknown; editedAt: string | null }>(
      await admin.get(`${NOTICES}/${id}`),
    );
    expect(saved.title).toBe(edited);
    expect(JSON.stringify(saved.body)).toContain('더한 본문');
    // Changed again after the save, it asks again; refused, the change stays.
    await titleInput.fill(`${edited} 또`);
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toHaveLength(4);
    await expect(page).toHaveURL(edit);
    await expect(titleInput).toHaveValue(`${edited} 또`);
    // The notice saved meanwhile from elsewhere — the same admin, as from another tab — this save
    // is refused, and a refusal after a save that landed moves nothing either: leaving still asks.
    await dataOf(
      await admin.put(`${NOTICES}/${id}`, {
        data: {
          title: `${edited} 다른 탭`,
          body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '다른 탭의 본문' }] }],
          },
          expectedEditedAt: saved.editedAt,
        },
      }),
    );
    await page.getByTestId('post-submit').click();
    await expect(page.getByTestId('post-form-error')).toContainText(copy.errNoticeEditConflict);
    answers.push(false);
    await home.click();
    await expect.poll(() => asked).toHaveLength(5);
    await expect(page).toHaveURL(edit);
    await expect(titleInput).toHaveValue(`${edited} 또`);
    // Back to what this form saved — the title, and the body its save took — there is nothing of
    // its own to lose.
    await titleInput.fill(edited);
    await home.click();
    await expect(page).toHaveURL('/');
    expect(asked).toEqual([question, question, question, question, question]);
  });

  test('쓰던 공지에서 온보딩 게이트가 남은 단계로 보내면 묻지 않고 탭에도 남기지 않아, 쓰던 내용이 사라진다', async ({
    admin,
    page,
  }) => {
    // ADR-0077 decision 8-20: /admin is gated like every screen (lib/onboarding.ts), and a notice's
    // form keeps no draft in the tab (owner decision 2026-10-21 8). So a re-consent that turns up
    // while an admin writes — here, a send refused with ONBOARDING_REQUIRED, which reads `['me']`
    // again — takes the admin to the step without a question, and what was typed is gone. That is
    // today's behaviour and a known limit (결과 5), put to the owner (결과 4): pinned until the
    // answer. A notice form given a draft key would keep its draft here, and fail this. Never
    // pinned; the re-consent is this browser's `GET /me` alone.
    const tag = freshTag();
    const asked: string[] = [];
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    const titleInput = page.getByTestId('post-title-input');
    const editor = page.getByTestId('post-editor-content');
    await signIn(page, adminAccount.email, adminAccount.password);
    const reconsent = await asReconsent(page);

    // --- 공지 쓰기, a title and a body typed: the send is refused for the onboarding.
    const write = '/admin/notices/new';
    const isCreate = (url: URL) => url.pathname === NOTICES;
    await page.route(isCreate, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      reconsent.on = true;
      await route.fulfill(ONBOARDING_REFUSAL);
    });
    await page.goto(write);
    await titleInput.fill(`사라질 공지 ${tag}`);
    await editor.click();
    await page.keyboard.type('사라질 본문');
    await page.getByTestId('post-submit').click();
    // The gate takes the admin to the step, asking nothing, and nothing is kept in the tab.
    await expect(page).toHaveURL(`/onboarding?next=${encodeURIComponent(write)}`);
    await expect(page.getByTestId('consent-step')).toBeVisible();
    expect(asked).toEqual([]);
    expect(await draftsInTab(page)).toEqual([]);
    // With the step gone, the screen opens empty again: nothing to take back.
    reconsent.on = false;
    await page.unroute(isCreate);
    await page.goto(write);
    await expect(editor).toBeVisible();
    await expect(titleInput).toHaveValue('');
    await expect(editor).not.toContainText('사라질 본문');
    await expect(page.getByTestId('post-draft-restored')).toHaveCount(0);

    // --- a notice's edit screen, its title changed: the same.
    const title = `게이트 앞의 공지 ${tag}`;
    const id = await noticeThroughApi(admin, title);
    const edit = `/admin/notices/${id}`;
    const isUpdate = (url: URL) => url.pathname === `${NOTICES}/${id}`;
    await page.route(isUpdate, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      reconsent.on = true;
      await route.fulfill(ONBOARDING_REFUSAL);
    });
    await page.goto(edit);
    await expect(titleInput).toHaveValue(title);
    await titleInput.fill(`사라질 제목 ${tag}`);
    await page.getByTestId('post-submit').click();
    await expect(page).toHaveURL(`/onboarding?next=${encodeURIComponent(edit)}`);
    await expect(page.getByTestId('consent-step')).toBeVisible();
    expect(asked).toEqual([]);
    expect(await draftsInTab(page)).toEqual([]);
    reconsent.on = false;
    await page.unroute(isUpdate);
    await page.goto(edit);
    await expect(titleInput).toHaveValue(title);
    await expect(page.getByTestId('post-draft-restored')).toHaveCount(0);
    expect((await dataOf<{ title: string }>(await admin.get(`${NOTICES}/${id}`))).title).toBe(
      title,
    );
    expect(asked).toEqual([]);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
});
