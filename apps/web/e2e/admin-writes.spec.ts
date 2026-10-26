import type { APIRequestContext, APIResponse, Browser, Page } from '@playwright/test';
import type { AdminLinkFlagGroup, AdminMarket, Me, ReleaseSetting } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  accountIdOf,
  adminAccount,
  createDraftMarket,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  meOf,
  secondAdminAccount,
  signIn,
  signUp,
  switchAccountUnderScreen,
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
    // A member's post and two comments with one link: a row of the default list.
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

    const row = page.locator(`[data-testid="admin-link-flag-group"][data-url="${url}"]`);
    const { a, close } = await underTheSecondAdmin(
      browser,
      page,
      secondAdmin,
      '/admin/moderation/link-flags',
      () => expect(page.getByTestId('admin-link-flag-group').first()).toBeVisible(),
    );
    try {
      await expect(page.getByTestId('admin-link-flag-group').first()).toBeVisible();
      for (let more = 0; more < 10 && (await row.count()) === 0; more += 1) {
        await page.getByTestId('admin-link-flags-more').click();
      }
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
    const memberContext = await browser.newContext();
    let proposalId = '';
    try {
      const member = await memberContext.newPage();
      await signUp(member, freshEmail());
      const deadline = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
      );
      const question = `E2E 관리자 확인 ${freshTag()}`;
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
      proposalId = proposal.id;
    } finally {
      await memberContext.close();
    }
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
});
