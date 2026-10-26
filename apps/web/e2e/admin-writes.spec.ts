import type {
  APIRequestContext,
  APIResponse,
  Browser,
  BrowserContext,
  Page,
} from '@playwright/test';
import type { AdminLinkFlagGroup, AdminMarket, Me, ReleaseSetting } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  accountIdOf,
  adminAccount,
  closeMarket,
  createDraftMarket,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  meOf,
  nextMeRead,
  secondAdminAccount,
  signIn,
  signUp,
  switchAccountUnderScreen,
  switchMeBeforeSession,
  test,
} from './helpers';

/**
 * ADR-0092 (ADR-0091 결과 5's admin writes, owner decision 2026-10-26 answer 6): every admin write
 * names the admin the screen was drawn for (`expectedAccountId`, `useOperatorId`) and the API
 * refuses another account's cookie before anything is read or written. In the render between the
 * session naming B and SessionCacheGuard's reset — held here by `switchAccountUnderScreen`: B's
 * cookie in the tab and the session read again, while `GET /me` still answers as A — A's screen is
 * drawn again from A's `Me`, and a press on it goes with B's cookie. Before this, the server took
 * it from the cookie alone and the write was B's: B opened the market, marked the link, published
 * the theme. Now it is refused as another account's (403 naming `expectedAccountId`), the screen
 * says `copy.sessionChanged`, and nothing is written. A is the first seed admin, B the second.
 */

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${response.url()} -> ${String(response.status())} ${body}`);
  }
  return (JSON.parse(body) as { data: T }).data;
}

/** The toast that says the session changed, the refusal of every admin write here. */
const sessionChangedToast = (page: Page) =>
  page.locator('[data-scope="toast"]').getByText(copy.sessionChanged);

/** A write the page sends to `/api/v1/admin/…`: method, path, query and body. */
interface AdminWrite {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

/** Records the admin writes the page sends from now on. */
function adminWrites(page: Page): AdminWrite[] {
  const writes: AdminWrite[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' || !url.pathname.startsWith('/api/v1/admin/')) return;
    const text = request.postData();
    writes.push({
      method: request.method(),
      path: url.pathname,
      query: url.search,
      body: text === null || text === '' ? null : (JSON.parse(text) as unknown),
    });
  });
  return writes;
}

/** The answer to the page's next admin write to `path` (`method`). */
function answerOf(page: Page, method: string, path: string): Promise<number> {
  return page
    .waitForResponse(
      (response) =>
        response.request().method() === method && new URL(response.url()).pathname === path,
    )
    .then((response) => response.status());
}

/**
 * The first seed admin (A) opens `path` in `page`; once `ready` says the screen is drawn, the
 * tab's cookie turns to the second seed admin's (B) under A's screen (`switchAccountUnderScreen`).
 * Answers A's account and a cleanup for the `finally`.
 */
async function underTheSecondAdmin(
  browser: Browser,
  page: Page,
  secondAdmin: APIRequestContext,
  path: string,
  ready: () => Promise<void>,
): Promise<{ a: Me; close: () => Promise<void> }> {
  const otherContext = await browser.newContext();
  const shownContext = await browser.newContext();
  const close = async () => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await otherContext.close();
    await shownContext.close();
  };
  try {
    const other = await otherContext.newPage();
    const b = await meOf(secondAdmin);
    await signIn(other, secondAdminAccount.email, secondAdminAccount.password);
    await signIn(page, adminAccount.email, adminAccount.password);
    const a = await meOf(page.request);
    expect(a.id).not.toBe(b.id);
    await page.goto(path);
    await ready();
    await shownContext.addCookies(await page.context().cookies());
    await switchAccountUnderScreen(page, shownContext.request, {
      id: b.id,
      cookies: await otherContext.cookies(),
    });
    return { a, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * A row of 반복 링크's default list: a member's post and two comments with one link (`same_account`,
 * three entries). Answers the link and a reader of the open groups that hold it.
 */
async function flaggedLink(
  browser: Browser,
  admin: APIRequestContext,
): Promise<{ url: string; openGroups: () => Promise<AdminLinkFlagGroup[]> }> {
  const market = await createOpenMarket(admin);
  const tag = freshTag();
  const url = `https://example.com/e2e-account/${tag}`;
  const memberContext = await browser.newContext();
  try {
    const member = await memberContext.newPage();
    await signUp(member, freshEmail());
    const memberId = (await meOf(member.request)).id;
    const linked = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '출처', marks: [{ type: 'link', attrs: { href: url } }] },
          ],
        },
      ],
    };
    const post = await dataOf<{ id: string }>(
      await member.request.post('/api/v1/posts', {
        data: {
          marketId: market.id,
          title: `링크 ${tag}`,
          body: linked,
          expectedAccountId: memberId,
        },
      }),
    );
    for (const word of ['참고', '다시']) {
      await dataOf(
        await member.request.post(`/api/v1/posts/${post.id}/comments`, {
          data: { parentId: null, body: `${word} ${url}`, expectedAccountId: memberId },
        }),
      );
    }
  } finally {
    await memberContext.close();
  }
  const openGroups = async () => {
    const groups: AdminLinkFlagGroup[] = [];
    let cursor: string | null = null;
    for (let read = 0; read < 10; read += 1) {
      const after: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const res = await admin.get(`/api/v1/admin/link-flags?status=open${after}`);
      const body = (await res.json()) as {
        data: AdminLinkFlagGroup[];
        meta: { nextCursor: string | null };
      };
      groups.push(...body.data.filter((group) => group.url === url));
      cursor = body.meta.nextCursor;
      if (cursor === null) break;
    }
    return groups;
  };
  expect((await openGroups()).map((group) => group.itemCount)).toEqual([3]);
  return { url, openGroups };
}

/** A new member's 접수 proposal, its question `prefix` and a fresh tag. Answers its id. */
async function submittedProposal(browser: Browser, prefix: string): Promise<string> {
  const memberContext = await browser.newContext();
  try {
    const member = await memberContext.newPage();
    await signUp(member, freshEmail());
    const deadline = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
    );
    const question = `${prefix} ${freshTag()}`;
    const proposal = await dataOf<{ id: string }>(
      await member.request.post('/api/v1/me/proposals', {
        data: {
          question,
          deadline,
          yesCondition: `${question} — 공식 발표가 있으면 YES`,
          expectedSources: '공식 보도자료',
          expectedAccountId: (await meOf(member.request)).id,
        },
      }),
    );
    return proposal.id;
  } finally {
    await memberContext.close();
  }
}

/** A new member, signed up in a browser context of its own: its account and address. */
async function freshMember(browser: Browser): Promise<{ id: string; email: string }> {
  const memberContext = await browser.newContext();
  try {
    const member = await memberContext.newPage();
    const email = freshEmail();
    await signUp(member, email);
    return { id: (await meOf(member.request)).id, email };
  } finally {
    await memberContext.close();
  }
}

/** `member`'s available Coin, as the admin's user list reads it. */
async function availableCoinOf(
  admin: APIRequestContext,
  member: { id: string; email: string },
): Promise<string> {
  const users = await dataOf<{ id: string; balance: { availableCoin: string } }[]>(
    await admin.get(`/api/v1/admin/users?q=${encodeURIComponent(member.email)}`),
  );
  const row = users.find((user) => user.id === member.id);
  expect(row, member.email).toBeDefined();
  return row!.balance.availableCoin;
}

/** 사용자: searches `member`'s address and answers its card once its 조정 can be pressed. */
async function memberCard(page: Page, member: { id: string; email: string }) {
  await page.getByTestId('admin-user-search').fill(member.email);
  await page.getByTestId('admin-user-search').press('Enter');
  const card = page.getByTestId(`admin-user-${member.id}`);
  await expect(card.getByTestId('adjust-submit')).toBeEnabled();
  return card;
}

/** The row of 반복 링크's default list that holds `url`, read on through 더 보기 until it shows. */
async function linkFlagRow(page: Page, url: string) {
  const row = page.locator(`[data-testid="admin-link-flag-group"][data-url="${url}"]`);
  await expect(page.getByTestId('admin-link-flag-group').first()).toBeVisible();
  for (let more = 0; more < 10 && (await row.count()) === 0; more += 1) {
    await page.getByTestId('admin-link-flags-more').click();
  }
  return row;
}

test.describe('탭의 계정이 바뀌는 틈의 관리자 쓰기 (ADR-0092)', () => {
  test('시장 상세의 공개는 그 화면의 관리자를 대어 거절되고, 시장은 초안 그대로다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const draft = await createDraftMarket(admin);
    const { a, close } = await underTheSecondAdmin(
      browser,
      page,
      secondAdmin,
      `/admin/markets/${draft.id}`,
      () => expect(page.getByTestId('market-open')).toBeEnabled(),
    );
    try {
      const writes = adminWrites(page);
      const path = `/api/v1/admin/markets/${draft.id}/open`;
      const answered = answerOf(page, 'POST', path);
      await page.getByTestId('market-open').click();
      expect(await answered).toBe(403);
      await expect(sessionChangedToast(page)).toBeVisible();
      expect(writes).toEqual([
        { method: 'POST', path, query: '', body: { expectedAccountId: a.id } },
      ]);
      // Nobody opened it: still a draft, with no `opened` event.
      const market = await dataOf<AdminMarket>(
        await admin.get(`/api/v1/admin/markets/${draft.id}`),
      );
      expect(market.status).toBe('draft');
      expect(market.events.map((event) => event.type)).toEqual(['created']);
    } finally {
      await close();
    }
  });

  test('시장 상세의 마감은 확인 창에서 그 화면의 관리자를 대어 거절되고 창이 닫히며, 시장은 열린 그대로다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const market = await createOpenMarket(admin);
    const { a, close } = await underTheSecondAdmin(
      browser,
      page,
      secondAdmin,
      `/admin/markets/${market.id}`,
      () => expect(page.getByTestId('market-close')).toBeVisible(),
    );
    try {
      const writes = adminWrites(page);
      await page.getByTestId('market-close').click();
      const path = `/api/v1/admin/markets/${market.id}/close`;
      const answered = answerOf(page, 'POST', path);
      await page.getByTestId('market-close-confirm').click();
      expect(await answered).toBe(403);
      await expect(sessionChangedToast(page)).toBeVisible();
      await expect(page.getByTestId('market-close-confirm')).toHaveCount(0);
      expect(writes).toEqual([
        { method: 'POST', path, query: '', body: { expectedAccountId: a.id } },
      ]);
      expect(
        (await dataOf<AdminMarket>(await admin.get(`/api/v1/admin/markets/${market.id}`))).status,
      ).toBe('open');
    } finally {
      await close();
    }
  });

  test('시장 만들기는 그 화면의 관리자를 대어 거절되고, 그 제목의 시장은 없다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const { a, close } = await underTheSecondAdmin(
      browser,
      page,
      secondAdmin,
      '/admin/markets',
      () => expect(page.getByTestId('market-create')).toBeEnabled(),
    );
    try {
      const title = `E2E 다른 관리자 ${freshTag()}`;
      await page.getByTestId('market-title').fill(title);
      await page.getByTestId('market-rules').fill('자동화 테스트의 규칙');
      const category = page.getByTestId('market-category');
      const choices = await category
        .locator('option:not([disabled])')
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value).filter(Boolean),
        );
      await category.selectOption(choices[0]!);
      await page.getByTestId('market-close-at').fill('2099-12-31T12:00');
      const writes = adminWrites(page);
      const answered = answerOf(page, 'POST', '/api/v1/admin/markets');
      await page.getByTestId('market-create').click();
      expect(await answered).toBe(403);
      await expect(sessionChangedToast(page)).toBeVisible();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        method: 'POST',
        path: '/api/v1/admin/markets',
        body: { title, expectedAccountId: a.id },
      });
      // Still on the form, and no market of that title, by either admin.
      await expect(page).toHaveURL('/admin/markets');
      const found = await dataOf<{ title: string }[]>(
        await admin.get(`/api/v1/admin/markets?q=${encodeURIComponent(title)}`),
      );
      expect(found).toEqual([]);
    } finally {
      await close();
    }
  });

  test('관련 시장 연결은 그 화면의 관리자를 대어 거절되고, 두 시장은 이어지지 않는다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const group = freshTag();
    const first = await createOpenMarket(admin, { group });
    const second = await createOpenMarket(admin, { group });
    const panel = page.getByTestId('admin-related-markets');
    const { a, close } = await underTheSecondAdmin(
      browser,
      page,
      secondAdmin,
      `/admin/markets/${first.id}`,
      () => expect(panel.getByTestId('admin-related-empty')).toBeVisible(),
    );
    try {
      await panel.getByTestId('admin-related-search-input').fill(group);
      await panel.getByTestId('admin-related-search-submit').click();
      const link = panel.getByTestId(`admin-related-link-${second.id}`);
      await expect(link).toBeEnabled();
      const writes = adminWrites(page);
      const path = `/api/v1/admin/markets/${first.id}/related`;
      const answered = answerOf(page, 'POST', path);
      await link.click();
      expect(await answered).toBe(403);
      await expect(sessionChangedToast(page)).toBeVisible();
      expect(writes).toEqual([
        {
          method: 'POST',
          path,
          query: '',
          body: { marketId: second.id, expectedAccountId: a.id },
        },
      ]);
      expect(await dataOf<unknown[]>(await admin.get(path))).toEqual([]);
    } finally {
      await close();
    }
  });

  test('테마 공개는 그 화면의 관리자를 대어 거절되고, 테마는 공개되지 않은 그대로다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const tag = freshTag();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    const theme = await dataOf<{ id: string }>(
      await admin.post('/api/v1/admin/themes', {
        data: {
          slug: `e2e-theme-account-${tag}`,
          name: `E2E 관리자 테마 ${tag}`,
          intro: `다른 관리자 ${tag}`,
          startDate: today,
          endDate: today,
          expectedAccountId: await accountIdOf(admin),
        },
      }),
    );
    const market = await createOpenMarket(admin);
    await dataOf(
      await admin.post(`/api/v1/admin/themes/${theme.id}/markets`, {
        data: { marketId: market.id, expectedAccountId: await accountIdOf(admin) },
      }),
    );
    const { a, close } = await underTheSecondAdmin(
      browser,
      page,
      secondAdmin,
      `/admin/themes/${theme.id}`,
      () => expect(page.getByTestId('theme-publish')).toBeEnabled(),
    );
    try {
      const writes = adminWrites(page);
      const path = `/api/v1/admin/themes/${theme.id}/publish`;
      const answered = answerOf(page, 'POST', path);
      await page.getByTestId('theme-publish').click();
      expect(await answered).toBe(403);
      await expect(sessionChangedToast(page)).toBeVisible();
      expect(writes).toEqual([
        { method: 'POST', path, query: '', body: { expectedAccountId: a.id } },
      ]);
      const now = await dataOf<{ publishedAt: string | null }>(
        await admin.get(`/api/v1/admin/themes/${theme.id}`),
      );
      expect(now.publishedAt).toBeNull();
    } finally {
      await close();
    }
  });

  test('반복 링크의 확인함은 그 화면의 관리자를 대어 거절되고 창이 닫히며, 그 줄은 기본 목록에 남는다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const { url, openGroups } = await flaggedLink(browser, admin);
    const { a, close } = await underTheSecondAdmin(
      browser,
      page,
      secondAdmin,
      '/admin/moderation/link-flags',
      () => expect(page.getByTestId('admin-link-flag-group').first()).toBeVisible(),
    );
    try {
      const row = await linkFlagRow(page, url);
      await row.getByTestId('admin-link-flag-review-open').click();
      const dialog = page.getByTestId('admin-link-flag-review-dialog');
      await dialog.getByTestId('admin-link-flag-outcome-no_issue').click();
      const writes = adminWrites(page);
      const path = '/api/v1/admin/link-flags/reviews';
      const answered = answerOf(page, 'POST', path);
      await dialog.getByTestId('admin-link-flag-review-confirm').click();
      expect(await answered).toBe(403);
      await expect(sessionChangedToast(page)).toBeVisible();
      await expect(dialog).toHaveCount(0);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        path,
        body: { url, reason: 'same_account', outcome: 'no_issue', expectedAccountId: a.id },
      });
      // Nobody marked it: the row is still on the default list with its three entries.
      expect(
        (await openGroups()).map((group) => [group.reason, group.itemCount, group.review]),
      ).toEqual([['same_account', 3, null]]);
    } finally {
      await close();
    }
  });

  test('운영 공지 쓰기는 그 화면의 관리자를 대어 거절되어 양식 위에 그 까닭이 보이고, 그 제목의 공지는 없다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const { a, close } = await underTheSecondAdmin(
      browser,
      page,
      secondAdmin,
      '/admin/notices/new',
      () => expect(page.getByTestId('post-title-input')).toBeVisible(),
    );
    try {
      // The reset drew A's form again, empty; what A types now goes with B's cookie.
      const title = `다른 관리자의 공지 ${freshTag()}`;
      await page.getByTestId('post-title-input').fill(title);
      await page.getByTestId('post-editor-content').click();
      await page.keyboard.type('점검 안내');
      const writes = adminWrites(page);
      const answered = answerOf(page, 'POST', '/api/v1/admin/notices');
      await page.getByTestId('post-submit').click();
      expect(await answered).toBe(403);
      await expect(page.getByTestId('post-form-error')).toHaveText(copy.sessionChanged);
      await expect(page).toHaveURL('/admin/notices/new');
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        path: '/api/v1/admin/notices',
        body: { title, expectedAccountId: a.id },
      });
      const unpinned = await dataOf<{ title: string }[]>(
        await admin.get('/api/v1/admin/notices?state=unpinned'),
      );
      expect(unpinned.map((notice) => notice.title)).not.toContain(title);
    } finally {
      await close();
    }
  });

  test('운영 공지의 고정은 그 화면의 관리자를 대어 거절되고, 공지는 고정되지 않은 그대로다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const tag = freshTag();
    const notice = await dataOf<{ id: string }>(
      await admin.post('/api/v1/admin/notices', {
        data: {
          title: `고정할 공지 ${tag}`,
          body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: `본문 ${tag}` }] }],
          },
          expectedAccountId: await accountIdOf(admin),
        },
      }),
    );
    const pinnedAt = async () =>
      (
        await dataOf<{ pinnedAt: string | null }>(
          await admin.get(`/api/v1/admin/notices/${notice.id}`),
        )
      ).pinnedAt;
    const { a, close } = await underTheSecondAdmin(
      browser,
      page,
      secondAdmin,
      `/admin/notices/${notice.id}`,
      () => expect(page.getByTestId('admin-notice-pin')).toBeEnabled(),
    );
    try {
      const writes = adminWrites(page);
      const path = `/api/v1/admin/notices/${notice.id}/pin`;
      const answered = answerOf(page, 'POST', path);
      await page.getByTestId('admin-notice-pin').click();
      expect(await answered).toBe(403);
      await expect(sessionChangedToast(page)).toBeVisible();
      expect(writes).toEqual([
        { method: 'POST', path, query: '', body: { expectedAccountId: a.id } },
      ]);
      expect(await pinnedAt()).toBeNull();
    } finally {
      await close();
      // Never left pinned for the notices spec's fixed area, whatever happened above.
      if ((await pinnedAt()) !== null) {
        await admin.post(`/api/v1/admin/notices/${notice.id}/unpin`, {
          data: { expectedAccountId: await accountIdOf(admin) },
        });
      }
    }
  });

  test('시장 제안의 검토 시작은 그 화면의 관리자를 대어 거절되고, 제안은 접수 그대로다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const proposalId = await submittedProposal(browser, 'E2E 관리자 확인');
    const statusNow = async () =>
      (await dataOf<{ status: string }>(await admin.get(`/api/v1/admin/proposals/${proposalId}`)))
        .status;
    const { a, close } = await underTheSecondAdmin(
      browser,
      page,
      secondAdmin,
      `/admin/proposals/${proposalId}`,
      () => expect(page.getByTestId('admin-proposal-review')).toBeEnabled(),
    );
    try {
      const writes = adminWrites(page);
      const path = `/api/v1/admin/proposals/${proposalId}/review`;
      const answered = answerOf(page, 'POST', path);
      await page.getByTestId('admin-proposal-review').click();
      expect(await answered).toBe(403);
      await expect(sessionChangedToast(page)).toBeVisible();
      expect(writes).toEqual([
        { method: 'POST', path, query: '', body: { expectedAccountId: a.id } },
      ]);
      expect(await statusNow()).toBe('submitted');
    } finally {
      await close();
    }
  });

  test('출시 설정의 변경은 그 화면의 관리자를 대어 거절되고 창이 닫히며, 항목은 그대로다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    // A retention period, moved to a status the worker never applies (only 승인됨 deletes,
    // ADR-0087): were it taken, nothing would act on it — and it is put back below.
    const key = 'retention.market_proposals';
    const itemNow = async () =>
      (await dataOf<ReleaseSetting[]>(await admin.get('/api/v1/admin/release-settings'))).find(
        (item) => item.key === key,
      )!;
    const before = await itemNow();
    const target = before.status === 'proposal' ? 'undecided' : 'proposal';
    const { a, close } = await underTheSecondAdmin(
      browser,
      page,
      secondAdmin,
      '/admin/settings',
      () => expect(page.getByTestId(`release-setting-edit-${key}`)).toBeVisible(),
    );
    try {
      await page.getByTestId(`release-setting-edit-${key}`).click();
      const dialog = page.getByTestId('release-setting-dialog');
      await dialog.getByTestId(`release-setting-status-${target}`).click();
      if (target === 'proposal')
        await dialog.getByTestId('release-setting-value-input').fill('1095');
      const reason = `e2e 다른 관리자 ${freshTag()}`;
      await dialog.getByTestId('release-setting-reason').fill(reason);
      const writes = adminWrites(page);
      const path = `/api/v1/admin/release-settings/${key}`;
      const answered = answerOf(page, 'PATCH', path);
      await dialog.getByTestId('release-setting-submit').click();
      expect(await answered).toBe(403);
      await expect(sessionChangedToast(page)).toBeVisible();
      await expect(dialog).toHaveCount(0);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        method: 'PATCH',
        path,
        body: { status: target, reason, expectedAccountId: a.id },
      });
      const after = await itemNow();
      expect({ status: after.status, value: after.value, updatedAt: after.updatedAt }).toEqual({
        status: before.status,
        value: before.value,
        updatedAt: before.updatedAt,
      });
    } finally {
      await close();
      // Put back, whatever happened above.
      const now = await itemNow();
      if (now.status !== before.status || now.value !== before.value) {
        await admin.patch(`/api/v1/admin/release-settings/${key}`, {
          data: {
            status: before.status,
            ...(before.status === 'undecided' ? {} : { value: before.value }),
            reason: 'e2e 되돌림',
            expectedAccountId: await accountIdOf(admin),
          },
        });
      }
    }
  });

  test('쿠폰 발급은 주소로 연 화면에서 그 화면의 관리자를 대어 거절되고, 그 코드의 쿠폰은 없다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const { a, close } = await underTheSecondAdmin(
      browser,
      page,
      secondAdmin,
      '/admin/coupons',
      () => expect(page.getByTestId('coupon-create')).toBeEnabled(),
    );
    try {
      const code = `E2E-${freshTag().toUpperCase()}`;
      await page.getByTestId('coupon-code-input').fill(code);
      await page.getByTestId('coupon-amount').fill('500');
      const writes = adminWrites(page);
      const answered = answerOf(page, 'POST', '/api/v1/admin/coupons');
      await page.getByTestId('coupon-create').click();
      expect(await answered).toBe(403);
      await expect(sessionChangedToast(page)).toBeVisible();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ body: { code, expectedAccountId: a.id } });
      const coupons = await dataOf<{ code: string }[]>(await admin.get('/api/v1/admin/coupons'));
      expect(coupons.map((coupon) => coupon.code)).not.toContain(code);
    } finally {
      await close();
    }
  });

  test('쿠폰 발급 양식에 적던 것은 세션이 다른 관리자를 말해 되돌리는 사이 비어 다시 그려져, `GET /me`가 그 관리자로 답한 뒤에도 남지 않는다 (8-18)', async ({
    browser,
    page,
    secondAdmin,
  }) => {
    // The session's own order with nothing held: B's cookie in the tab, the session read again, and
    // `GET /me` read again by SessionCacheGuard's reset with B's cookie — the screen is B's then.
    // The reset takes no form away (`resetQueries`), so a form not drawn for its admin keeps what A
    // typed, its button on once `GET /me` answers, and a press names B with B's cookie: taken as
    // B's write. The server's 403 refuses a press only before the reset, while the screen is still
    // A's (the tests above). Only the form's key passing through '' — the admin unknown during the
    // reset — drops A's text.
    const otherContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      const b = await meOf(secondAdmin);
      await signIn(other, secondAdminAccount.email, secondAdminAccount.password);
      await signIn(page, adminAccount.email, adminAccount.password);
      await page.goto('/admin/coupons');
      await expect(page.getByTestId('coupon-create')).toBeEnabled();
      const code = page.getByTestId('coupon-code-input');
      const amount = page.getByTestId('coupon-amount');
      await code.fill(`E2E-${freshTag().toUpperCase()}`);
      await amount.fill('500');
      const writes = adminWrites(page);

      const sessionRead = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/auth/get-session',
      );
      const meRead = nextMeRead(page);
      await page.context().clearCookies();
      await page.context().addCookies(await otherContext.cookies());
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      const session = (await (await sessionRead).json()) as { user?: { id?: string } } | null;
      expect(session?.user?.id).toBe(b.id);
      const drawn = (await (await meRead).json()) as { data: Me };
      expect(drawn.data.id).toBe(b.id);

      await expect(code).toHaveValue('');
      await expect(amount).toHaveValue('');
      await expect(code).toBeEnabled();
      expect(writes).toEqual([]);
    } finally {
      await otherContext.close();
    }
  });

  test('충전 상품 추가는 주소로 연 화면에서 그 화면의 관리자를 대어 거절되고, 상품은 늘지 않는다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const list = async () =>
      dataOf<{ id: string; amountCoin: string; priceKrw: number }[]>(
        await admin.get('/api/v1/admin/charge-packages'),
      );
    const before = (await list()).map((pack) => pack.id);
    /**
     * A package this test could have made: the one it types, not there before. The rest of the list
     * is not this test's — payment.spec adds its own package on a database with none on sale, and
     * the two may run at once (`fullyParallel`) — so it is neither compared nor deleted.
     */
    const typedHere = async () =>
      (await list()).filter(
        (pack) => pack.amountCoin === '7000' && pack.priceKrw === 6900 && !before.includes(pack.id),
      );
    const { a, close } = await underTheSecondAdmin(
      browser,
      page,
      secondAdmin,
      '/admin/charge-packages',
      () => expect(page.getByTestId('package-create')).toBeEnabled(),
    );
    try {
      await page.getByTestId('package-amount').fill('7000');
      await page.getByTestId('package-price').fill('6900');
      const writes = adminWrites(page);
      const answered = answerOf(page, 'POST', '/api/v1/admin/charge-packages');
      await page.getByTestId('package-create').click();
      expect(await answered).toBe(403);
      await expect(sessionChangedToast(page)).toBeVisible();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        body: { amountCoin: '7000', priceKrw: 6900, expectedAccountId: a.id },
      });
      expect(await typedHere()).toEqual([]);
    } finally {
      await close();
      // Never left on sale, whatever happened above.
      for (const pack of await typedHere()) {
        await admin.delete(
          `/api/v1/admin/charge-packages/${pack.id}?expectedAccountId=${await accountIdOf(admin)}`,
        );
      }
    }
  });

  test('잔고 조정은 그 화면의 관리자를 대어 거절되고, 회원의 잔고는 그대로다 (Q-PG-8 ①)', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    // Owner decision 2026-10-26 17:21 answer 4 «이 PR에서 더함»: the adjustment Q-PG-8 ① held back
    // names the admin on screen too. Before, B's cookie moved the member's Coin and the audit row
    // named B. (The refund, its pair, is closed while paid Coin is off — ADR-0049 — so no screen
    // offers it here; the API suite drives it with sales open.)
    const member = await freshMember(browser);
    const before = await availableCoinOf(admin, member);
    let card = page.getByTestId(`admin-user-${member.id}`);
    const { a, close } = await underTheSecondAdmin(
      browser,
      page,
      secondAdmin,
      '/admin/users',
      async () => {
        card = await memberCard(page, member);
      },
    );
    try {
      // Drawn again after the guard's reset, for A.
      await expect(card.getByTestId('adjust-submit')).toBeEnabled();
      const memo = `E2E 화면의 관리자 ${freshTag()}`;
      await card.getByTestId('adjust-amount').fill('1234');
      await card.getByTestId('adjust-memo').fill(memo);
      const writes = adminWrites(page);
      const path = `/api/v1/admin/users/${member.id}/balance-adjust`;
      const answered = answerOf(page, 'POST', path);
      await card.getByTestId('adjust-submit').click();
      expect(await answered).toBe(403);
      await expect(sessionChangedToast(page)).toBeVisible();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        path,
        body: { amountCoin: '1234', memo, expectedAccountId: a.id },
      });
      expect(await availableCoinOf(admin, member)).toBe(before);
    } finally {
      await close();
    }
  });
});

/**
 * An unpublished theme of today with one visible notice, made through the admin API as the first
 * seed admin. Answers its id, its name and the notice's id.
 */
async function themeWithNotice(
  admin: APIRequestContext,
  label: string,
): Promise<{ id: string; name: string; noticeId: string }> {
  const tag = freshTag();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const by = await accountIdOf(admin);
  const name = `E2E ${label} 테마 ${tag}`;
  const theme = await dataOf<{ id: string }>(
    await admin.post('/api/v1/admin/themes', {
      data: {
        slug: `e2e-theme-${tag}`,
        name,
        intro: `${label} ${tag}`,
        startDate: today,
        endDate: today,
        expectedAccountId: by,
      },
    }),
  );
  const withNotice = await dataOf<{ notices: { id: string }[] }>(
    await admin.post(`/api/v1/admin/themes/${theme.id}/notices`, {
      data: { title: `공지 ${tag}`, body: '보이는 공지', expectedAccountId: by },
    }),
  );
  return { id: theme.id, name, noticeId: withNotice.notices[0]!.id };
}

/**
 * Holds every `GET /me` the page sends from now until `release` is called; `asked` resolves once
 * the first one is sent (search.spec.ts's). Armed before the page is opened, that is its first
 * read: the page has hydrated and nothing on it knows the admin on screen yet.
 */
async function holdMeReads(page: Page): Promise<{ asked: Promise<unknown>; release: () => void }> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const isMeRead = (url: URL) => url.pathname === '/api/v1/me';
  await page.route(isMeRead, async (route) => {
    if (route.request().method() === 'GET') await released;
    await route.fallback();
  });
  const asked = page.waitForRequest(
    (request) => request.method() === 'GET' && isMeRead(new URL(request.url())),
  );
  return { asked, release };
}

/**
 * The reverse order (ADR-0090 결정 4-2): the first seed admin (A) opens `path` with the page's
 * clock installed; once `ready` says the screen is drawn the spec opens or types what it holds,
 * and `toB` turns `['me']` to the second seed admin (B) in place, before the session does
 * (`switchMeBeforeSession` — a window-focus refetch of `GET /me` answered with B's cookie while
 * better-auth's session still says A), so SessionCacheGuard resets nothing. `toA`, after `toB`,
 * turns it back the same way: A's cookie in the tab again and `GET /me` read on the next focus —
 * the session said A throughout. Answers both admins, `toB`, `toA` and a cleanup for the
 * `finally`.
 */
async function aThenBInPlace(
  browser: Browser,
  page: Page,
  secondAdmin: APIRequestContext,
  path: string,
  ready: () => Promise<void>,
): Promise<{
  a: Me;
  b: Me;
  toB: () => Promise<void>;
  toA: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const otherContext: BrowserContext = await browser.newContext();
  const shownContext: BrowserContext = await browser.newContext();
  const close = async () => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await otherContext.close();
    await shownContext.close();
  };
  try {
    const other = await otherContext.newPage();
    const b = await meOf(secondAdmin);
    await signIn(other, secondAdminAccount.email, secondAdminAccount.password);
    await signIn(page, adminAccount.email, adminAccount.password);
    const a = await meOf(page.request);
    expect(a.id).not.toBe(b.id);
    const aCookies = await page.context().cookies();
    await page.clock.install();
    await page.goto(path);
    await ready();
    const toB = async () =>
      switchMeBeforeSession(page, shownContext, {
        id: b.id,
        cookies: await otherContext.cookies(),
      });
    const toA = async () => {
      await page.context().clearCookies();
      await page.context().addCookies(aCookies);
      const meRead = nextMeRead(page);
      await page.clock.fastForward('00:31');
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
      const drawn = (await (await meRead).json()) as { data: Me };
      expect(drawn.data.id).toBe(a.id);
    };
    return { a, b, toB, toA, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test.describe('탭의 세션이 아직 앞 관리자를 말하는데 `GET /me`가 다른 관리자로 답하는 관리자 화면 (ADR-0092 오너 결정 2026-10-26 17:21 답 1)', () => {
  // `['me']` turns from A to B in place, before the session does, so SessionCacheGuard resets
  // nothing, and the screen's writes now name B — the admin drawn — with B's cookie: the server's
  // check (ADR-0092) takes them. What A opened or typed on the screen would go with them: the
  // judgement A picked and the note A wrote, the reason A gave a setting, A's mark of a link, the
  // market, theme, notice, rejection, memo, coupon or package A typed. The owner's «적용함»: an open
  // dialog is held for the admin who opened it and closes (`useHeldForOperator`, ADR-0091 결정
  // 3·5-5), and a form on the screen is drawn again for each admin, empty (`key`). One of each per
  // area here; the rest are pinned in the sources (lib/admin-writes.test.ts).

  test('시장 만들기 양식에 앞 관리자가 적던 것은 다른 관리자의 것으로 비어 다시 그려지고, 아무것도 보내지 않는다', async ({
    browser,
    page,
    secondAdmin,
  }) => {
    const { toB, close } = await aThenBInPlace(browser, page, secondAdmin, '/admin/markets', () =>
      expect(page.getByTestId('market-create')).toBeEnabled(),
    );
    try {
      const title = page.getByTestId('market-title');
      const rules = page.getByTestId('market-rules');
      await title.fill(`E2E 앞 관리자가 적던 시장 ${freshTag()}`);
      await rules.fill('앞 관리자가 적던 규칙');
      const writes = adminWrites(page);

      await toB();
      // B's form: empty, and on — B is known.
      await expect(title).toHaveValue('');
      await expect(rules).toHaveValue('');
      await expect(title).toBeEnabled();
      expect(writes).toEqual([]);
    } finally {
      await close();
    }
  });

  test('시장 상세에서 앞 관리자가 열어 결과를 고르고 메모를 적은 판정 창은 닫히고, 시장은 판정을 기다리는 그대로다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const market = await createOpenMarket(admin);
    await closeMarket(admin, market.id);
    const { toB, close } = await aThenBInPlace(
      browser,
      page,
      secondAdmin,
      `/admin/markets/${market.id}`,
      () => expect(page.getByTestId('market-resolve')).toBeEnabled(),
    );
    try {
      await page.getByTestId('market-resolve').click();
      await page.getByTestId('market-resolve-yes').click();
      const note = page.getByTestId('market-resolve-note');
      await note.fill('앞 관리자가 적던 판정 메모');
      const writes = adminWrites(page);

      await toB();
      await expect(note).toHaveCount(0);
      await expect(page.getByTestId('market-resolve-confirm')).toHaveCount(0);
      await expect(page.getByTestId('market-resolve')).toBeEnabled();
      expect(writes).toEqual([]);
      expect(
        (await dataOf<AdminMarket>(await admin.get(`/api/v1/admin/markets/${market.id}`))).status,
      ).toBe('closed');
    } finally {
      await close();
    }
  });

  test('테마 상세에서 앞 관리자가 고치던 이름과 쓰던 공지는 다른 관리자의 것으로 다시 그려지고, 열어 둔 공지 숨기기 창은 닫힌다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const { id: themeId, name, noticeId } = await themeWithNotice(admin, '반대 순서');
    const { toB, close } = await aThenBInPlace(
      browser,
      page,
      secondAdmin,
      `/admin/themes/${themeId}`,
      () => expect(page.getByTestId(`admin-theme-notice-hide-${noticeId}`)).toBeEnabled(),
    );
    try {
      const nameInput = page.getByTestId('theme-name-input');
      await expect(nameInput).toHaveValue(name);
      await nameInput.fill(`앞 관리자가 고치던 이름 ${freshTag()}`);
      const noticeTitle = page.getByTestId('theme-notice-new-title');
      const noticeBody = page.getByTestId('theme-notice-new-body');
      await noticeTitle.fill('앞 관리자가 쓰던 공지');
      await noticeBody.fill('앞 관리자가 쓰던 본문');
      await page.getByTestId(`admin-theme-notice-hide-${noticeId}`).click();
      const hide = page.getByTestId('admin-theme-notice-hide-confirm');
      await expect(hide).toBeVisible();
      const writes = adminWrites(page);

      await toB();
      await expect(hide).toHaveCount(0);
      // B's forms: the theme's own name, and an empty notice — both on.
      await expect(nameInput).toHaveValue(name);
      await expect(noticeTitle).toHaveValue('');
      await expect(noticeBody).toHaveValue('');
      await expect(noticeTitle).toBeEnabled();
      expect(writes).toEqual([]);
      const now = await dataOf<{ name: string; notices: { hiddenAt: string | null }[] }>(
        await admin.get(`/api/v1/admin/themes/${themeId}`),
      );
      expect(now.name).toBe(name);
      expect(now.notices.map((notice) => notice.hiddenAt)).toEqual([null]);
    } finally {
      await close();
    }
  });

  test('시장 제안에서 앞 관리자가 적던 반려와 내부 메모는 다른 관리자의 것으로 비어 다시 그려지고, 열어 둔 반려 확인 창은 닫힌다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const proposalId = await submittedProposal(browser, 'E2E 반대 순서 제안');
    await dataOf(
      await admin.post(`/api/v1/admin/proposals/${proposalId}/review`, {
        data: { expectedAccountId: await accountIdOf(admin) },
      }),
    );
    const { toB, close } = await aThenBInPlace(
      browser,
      page,
      secondAdmin,
      `/admin/proposals/${proposalId}`,
      () => expect(page.getByTestId('admin-proposal-reject-submit')).toBeEnabled(),
    );
    try {
      const memo = page.getByTestId('admin-proposal-internal-memo-input');
      await memo.fill('앞 관리자가 적던 내부 메모');
      const reason = page.getByTestId('admin-proposal-reject-reason');
      const explanation = page.getByTestId('admin-proposal-reject-explanation');
      await reason.selectOption('ambiguous_criteria');
      await explanation.fill('앞 관리자가 적던 반려 설명');
      await page.getByTestId('admin-proposal-reject-submit').click();
      const confirm = page.getByTestId('admin-proposal-reject-confirm');
      await expect(confirm).toBeVisible();
      const writes = adminWrites(page);

      await toB();
      await expect(confirm).toHaveCount(0);
      await expect(explanation).toHaveValue('');
      await expect(reason).toHaveValue('');
      await expect(memo).toHaveValue('');
      await expect(explanation).toBeEnabled();
      expect(writes).toEqual([]);
      const now = await dataOf<{ status: string; internalMemo: string | null }>(
        await admin.get(`/api/v1/admin/proposals/${proposalId}`),
      );
      expect({ status: now.status, internalMemo: now.internalMemo }).toEqual({
        status: 'reviewing',
        internalMemo: null,
      });
    } finally {
      await close();
    }
  });

  test('출시 설정에서 앞 관리자가 열어 상태를 고르고 사유를 적은 변경 창은 닫히고, 항목은 그대로다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const key = 'retention.market_proposals';
    const itemNow = async () =>
      (await dataOf<ReleaseSetting[]>(await admin.get('/api/v1/admin/release-settings'))).find(
        (item) => item.key === key,
      )!;
    const before = await itemNow();
    const target = before.status === 'proposal' ? 'undecided' : 'proposal';
    const { toB, close } = await aThenBInPlace(browser, page, secondAdmin, '/admin/settings', () =>
      expect(page.getByTestId(`release-setting-edit-${key}`)).toBeEnabled(),
    );
    try {
      await page.getByTestId(`release-setting-edit-${key}`).click();
      const dialog = page.getByTestId('release-setting-dialog');
      await dialog.getByTestId(`release-setting-status-${target}`).click();
      if (target === 'proposal')
        await dialog.getByTestId('release-setting-value-input').fill('1095');
      await dialog.getByTestId('release-setting-reason').fill('앞 관리자가 적던 사유');
      const writes = adminWrites(page);

      await toB();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId(`release-setting-edit-${key}`)).toBeEnabled();
      expect(writes).toEqual([]);
      const after = await itemNow();
      expect({ status: after.status, value: after.value, updatedAt: after.updatedAt }).toEqual({
        status: before.status,
        value: before.value,
        updatedAt: before.updatedAt,
      });
    } finally {
      await close();
    }
  });

  test('반복 링크에서 앞 관리자가 열어 결과를 고르고 메모를 적은 확인함 창은 닫히고, 그 줄은 기본 목록에 남는다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const { url, openGroups } = await flaggedLink(browser, admin);
    const { toB, close } = await aThenBInPlace(
      browser,
      page,
      secondAdmin,
      '/admin/moderation/link-flags',
      () => expect(page.getByTestId('admin-link-flag-group').first()).toBeVisible(),
    );
    try {
      const row = await linkFlagRow(page, url);
      await row.getByTestId('admin-link-flag-review-open').click();
      const dialog = page.getByTestId('admin-link-flag-review-dialog');
      await dialog.getByTestId('admin-link-flag-outcome-no_issue').click();
      await dialog.getByTestId('admin-link-flag-review-note').fill('앞 관리자가 적던 메모');
      const writes = adminWrites(page);

      await toB();
      await expect(dialog).toHaveCount(0);
      await expect(row.getByTestId('admin-link-flag-review-open')).toBeEnabled();
      expect(writes).toEqual([]);
      expect(
        (await openGroups()).map((group) => [group.reason, group.itemCount, group.review]),
      ).toEqual([['same_account', 3, null]]);
    } finally {
      await close();
    }
  });

  test('쿠폰 발급 양식에 앞 관리자가 적던 것은 다른 관리자의 것으로 비어 다시 그려지고, 아무것도 보내지 않는다', async ({
    browser,
    page,
    secondAdmin,
  }) => {
    const { toB, close } = await aThenBInPlace(browser, page, secondAdmin, '/admin/coupons', () =>
      expect(page.getByTestId('coupon-create')).toBeEnabled(),
    );
    try {
      const code = page.getByTestId('coupon-code-input');
      const amount = page.getByTestId('coupon-amount');
      await code.fill(`E2E-${freshTag().toUpperCase()}`);
      await amount.fill('500');
      const writes = adminWrites(page);

      await toB();
      await expect(code).toHaveValue('');
      await expect(amount).toHaveValue('');
      await expect(code).toBeEnabled();
      expect(writes).toEqual([]);
    } finally {
      await close();
    }
  });

  test('충전 상품 추가 양식에 앞 관리자가 적던 것은 다른 관리자의 것으로 비어 다시 그려지고, 아무것도 보내지 않는다', async ({
    browser,
    page,
    secondAdmin,
  }) => {
    const { toB, close } = await aThenBInPlace(
      browser,
      page,
      secondAdmin,
      '/admin/charge-packages',
      () => expect(page.getByTestId('package-create')).toBeEnabled(),
    );
    try {
      const amount = page.getByTestId('package-amount');
      const price = page.getByTestId('package-price');
      await amount.fill('7000');
      await price.fill('6900');
      const writes = adminWrites(page);

      await toB();
      await expect(amount).toHaveValue('');
      await expect(price).toHaveValue('');
      await expect(amount).toBeEnabled();
      expect(writes).toEqual([]);
    } finally {
      await close();
    }
  });

  test('잔고 조정 양식에 앞 관리자가 적던 것은 다른 관리자의 것으로 비어 다시 그려지고, 아무것도 보내지 않는다 (Q-PG-8 ①)', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const member = await freshMember(browser);
    const before = await availableCoinOf(admin, member);
    let card = page.getByTestId(`admin-user-${member.id}`);
    const { toB, close } = await aThenBInPlace(
      browser,
      page,
      secondAdmin,
      '/admin/users',
      async () => {
        card = await memberCard(page, member);
      },
    );
    try {
      const amount = card.getByTestId('adjust-amount');
      const memo = card.getByTestId('adjust-memo');
      await amount.fill('1234');
      await memo.fill('앞 관리자가 적던 조정 사유');
      const writes = adminWrites(page);

      await toB();
      // B's form: empty, and on — B is known.
      await expect(amount).toHaveValue('');
      await expect(memo).toHaveValue('');
      await expect(amount).toBeEnabled();
      expect(writes).toEqual([]);
      expect(await availableCoinOf(admin, member)).toBe(before);
    } finally {
      await close();
    }
  });

  test('`GET /me`가 답하기 전에는 관리자 화면의 양식 칸도 창을 여는 단추도 꺼져 있다가, 그 답의 관리자에게 켜진다', async ({
    page,
    admin,
  }) => {
    // Nothing is typed or opened for nobody: the first answer draws each form again for the admin
    // it names (`key`), so a field on before it would lose what was typed then — or hand it to
    // whichever admin `GET /me` names first, as a pick made then would be (`operatorHold`).
    const { id: themeId, name, noticeId } = await themeWithNotice(admin, '답 전');
    await signIn(page, adminAccount.email, adminAccount.password);
    const { asked, release } = await holdMeReads(page);
    try {
      await page.goto(`/admin/themes/${themeId}`);
      await asked;
      const nameInput = page.getByTestId('theme-name-input');
      const noticeTitle = page.getByTestId('theme-notice-new-title');
      const hide = page.getByTestId(`admin-theme-notice-hide-${noticeId}`);
      await expect(nameInput).toHaveValue(name);
      await expect(nameInput).toBeDisabled();
      await expect(noticeTitle).toBeDisabled();
      await expect(hide).toBeDisabled();

      release();
      await expect(nameInput).toBeEnabled();
      await expect(noticeTitle).toBeEnabled();
      await expect(hide).toBeEnabled();
      // Typed now, it stays: the admin on screen is known and stays the same.
      await noticeTitle.fill('답 뒤에 쓰는 공지');
      await expect(nameInput).toHaveValue(name);
      await expect(noticeTitle).toHaveValue('답 뒤에 쓰는 공지');
    } finally {
      release();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  });
});

/** The storage keys of the post drafts kept in this tab (lib/post-drafts.ts's sessionStorage). */
function draftsInTab(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith('buddha.postDraft:'))
      .sort(),
  );
}

test.describe('탭의 세션이 아직 앞 관리자를 말하는데 `GET /me`가 다른 관리자로 답하는 공지 양식 (ADR-0092 오너 결정 2026-10-26 17:21 답 2)', () => {
  // `['me']` turns from A to B in place, before the session does: the notice forms are drawn for
  // the admin on screen (`key`), so B never gets A's form — what A typed, its button on, sent as B
  // with B's cookie. The owner's «A의 것으로 1시간 보관»: A's form, going, keeps what A typed in
  // this tab as A's draft for the hour, as the onboarding gate's move keeps it (ADR-0077 decision
  // 8-20) — one item per screen and admin, which B's form neither reads nor replaces — and A, on
  // screen again, takes it back with the restore notice. Nothing asks: no leave of the page.

  test('공지 쓰기에서 앞 관리자가 쓰던 공지는 다른 관리자에게 빈 양식으로 다시 그려지고 아무것도 보내지 않으며, 이 탭에 앞 관리자의 것으로 두었다가 그 관리자가 돌아오면 되살린다', async ({
    browser,
    page,
    secondAdmin,
  }) => {
    const asked: string[] = [];
    page.on('dialog', (dialog) => {
      asked.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    const titleInput = page.getByTestId('post-title-input');
    const editor = page.getByTestId('post-editor-content');
    const restored = page.getByTestId('post-draft-restored');
    const { a, b, toB, toA, close } = await aThenBInPlace(
      browser,
      page,
      secondAdmin,
      '/admin/notices/new',
      () => expect(titleInput).toBeEditable(),
    );
    try {
      const tag = freshTag();
      const title = `앞 관리자가 쓰던 공지 ${tag}`;
      await titleInput.fill(title);
      await editor.click();
      await page.keyboard.type(`앞 관리자가 쓰던 안내 ${tag}`);
      const writes = adminWrites(page);
      const uploads: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/api/v1/media/')) {
          if (request.method() !== 'GET') uploads.push(request.url());
        }
      });

      // --- B on screen: B's own form, empty and on; A's text kept in this tab as A's.
      await toB();
      await expect(titleInput).toHaveValue('');
      await expect(editor).not.toContainText(tag);
      await expect(restored).toHaveCount(0);
      await expect(titleInput).toBeEditable();
      await expect.poll(() => draftsInTab(page)).toEqual([`buddha.postDraft:notice-new@${a.id}`]);
      expect(writes).toEqual([]);
      expect(uploads).toEqual([]);
      expect(asked).toEqual([]);
      // B types too: B's own, beside A's.
      await titleInput.fill(`다른 관리자가 쓰던 공지 ${tag}`);

      // --- A on screen again: A's text taken back, said so; B's kept as B's.
      await toA();
      await expect(restored).toContainText(copy.postDraftRestored);
      await expect(titleInput).toHaveValue(title);
      await expect(editor).toContainText(`앞 관리자가 쓰던 안내 ${tag}`);
      await expect.poll(() => draftsInTab(page)).toEqual([`buddha.postDraft:notice-new@${b.id}`]);
      expect(writes).toEqual([]);
      expect(uploads).toEqual([]);
      expect(asked).toEqual([]);
    } finally {
      await close();
    }
  });

  test('공지 수정에서 앞 관리자가 고치던 것은 다른 관리자에게 공지 그대로 다시 그려지고, 앞 관리자가 돌아오면 그 판과 함께 되살린다', async ({
    browser,
    page,
    admin,
    secondAdmin,
  }) => {
    const tag = freshTag();
    const original = `E2E 반대 순서 공지 ${tag}`;
    const notice = await dataOf<{ id: string }>(
      await admin.post('/api/v1/admin/notices', {
        data: {
          expectedAccountId: await accountIdOf(admin),
          title: original,
          body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '저장된 안내' }] }],
          },
        },
      }),
    );
    const titleInput = page.getByTestId('post-title-input');
    const editor = page.getByTestId('post-editor-content');
    const restored = page.getByTestId('post-draft-restored');
    const { a, toB, toA, close } = await aThenBInPlace(
      browser,
      page,
      secondAdmin,
      `/admin/notices/${notice.id}`,
      async () => {
        await expect(titleInput).toHaveValue(original);
        await expect(titleInput).toBeEditable();
      },
    );
    try {
      const typed = `앞 관리자가 고치던 제목 ${tag}`;
      await titleInput.fill(typed);
      const writes = adminWrites(page);

      // --- B on screen: the notice as saved, nothing of A's; A's kept with the version it was
      // typed on (never edited — null).
      await toB();
      await expect(titleInput).toHaveValue(original);
      await expect(editor).toContainText('저장된 안내');
      await expect(restored).toHaveCount(0);
      const key = `buddha.postDraft:notice-edit:${notice.id}@${a.id}`;
      await expect.poll(() => draftsInTab(page)).toEqual([key]);
      const kept = await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key);
      expect(JSON.parse(kept ?? '{}')).toMatchObject({
        accountId: a.id,
        title: typed,
        opened: null,
      });
      expect(writes).toEqual([]);

      // --- A again: taken back.
      await toA();
      await expect(restored).toContainText(copy.postDraftRestored);
      await expect(titleInput).toHaveValue(typed);
      await expect.poll(() => draftsInTab(page)).toEqual([]);
      expect(writes).toEqual([]);
      expect(
        (await dataOf<{ title: string }>(await admin.get(`/api/v1/admin/notices/${notice.id}`)))
          .title,
      ).toBe(original);
    } finally {
      await close();
    }
  });
});
