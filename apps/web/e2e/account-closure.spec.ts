import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Me } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  E2E_PASSWORD,
  adminAccount,
  completeOnboardingThroughApi,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  meOf,
  openSetPassword,
  setFirstPassword,
  signIn,
  signUp,
  test,
} from './helpers';

/**
 * 탈퇴 (#140, ADR-0086; owner decisions in ADR-0069 decision 1 #57-15…#57-18, decision 3
 * #37-15…#37-17, decision 4 #140 rows and of 2026-10-23 — a request waiting for approval does not
 * keep a closure from going ahead, and is closed by it), walked on the screens — the brief's «sign
 * up, write a post, withdraw, author shows '탈퇴한 사용자', sign in fails, sign up again with the same
 * email works»:
 *
 * - a member with Coin, a post and a comment, about whom an operator's account restriction request
 *   waits, opens 탈퇴 from MY 설정's last card: the screen shows the Coin left and that it is
 *   forfeited, that it cannot be undone, and keeps the button off until '탈퇴' is typed; closed, the
 *   browser is home and signed out; the post and the comment are bylined '탈퇴한 사용자' with no
 *   profile link — on the post page and its community card — and the profile's address is a 404
 *   like an account that never was; the old email and password sign nobody in, and the same email
 *   and number sign up again at once — the number free again, its start Coin waiting as for any
 *   (the closed account's own was still waiting and was cancelled, owner decision 2026-10-18 on
 *   #70); the operators find the closed account named '탈퇴한 사용자' with no Coin and no balance
 *   adjustment, and the waiting request rejected by the closure, reason '탈퇴', no admin named;
 * - a member under a writing restriction, and an admin, find the screen saying why it cannot close
 *   now — the restriction with its end and the way to 조치·신고 내역, the admin role until it is
 *   revoked — with the field and the button off, and the API refuses it as well; lifted, the
 *   member's screen offers the closure again.
 *
 * Every rule's branch (the deletion and the kept set, the forfeiture's ledger, each refusal, the
 * locks, the database's own checks, the private-data guard) is the API's and the database's tests
 * (account-closure.controller.test.ts, schema.test.ts); the wording's is the web's unit tests
 * (lib/account-closure.test.ts, lib/restriction.test.ts). Every restriction a test gives ends before
 * it does.
 */

/** A post straight at the API with the context's cookie. */
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

/** A 댓글 straight at the API with the context's cookie. */
async function commentThroughApi(
  context: APIRequestContext,
  postId: string,
  body: string,
): Promise<string> {
  const me = await meOf(context);
  const res = await context.post(`/api/v1/posts/${postId}/comments`, {
    data: { parentId: null, body, expectedAccountId: me.id },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/**
 * Opens the closure screen and waits until its read (`GET /me/closure`, in the browser once the
 * session is known) has answered: before it, the button is off for no reason the test means.
 */
async function openClosure(page: Page): Promise<void> {
  const read = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/api/v1/me/closure',
  );
  await page.goto('/my/settings/closure');
  const response = await read;
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.getByTestId('closure-coin')).toBeVisible();
}

/**
 * Shows `entry` on 계정 제한 요청's 결정함: requests decided by other runs and specs stand there
 * too (the latest first), so 더 보기 is followed until it shows.
 */
async function showInDecided(page: Page, entry: Locator): Promise<void> {
  const more = page.getByTestId('admin-account-requests-more');
  for (let pages = 0; pages < 50; pages += 1) {
    await expect(more.or(entry).first()).toBeVisible();
    if (await entry.isVisible()) return;
    await more.click();
    await expect(
      page.locator('[data-testid="admin-account-requests-more"][data-loading]'),
    ).toHaveCount(0);
  }
  await expect(entry).toBeVisible();
}

test.describe('탈퇴', () => {
  test("회원이 MY 설정에서 탈퇴를 열면 남은 Coin의 소멸과 되돌릴 수 없음을 보고 '탈퇴'를 입력해 곧바로 닫히며, 글·댓글의 작성자는 프로필 링크 없이 '탈퇴한 사용자'이고 프로필 주소는 404이며, 옛 이메일로는 로그인할 수 없고 같은 이메일과 번호로 곧바로 다시 가입하며, 운영자에게는 기다리던 계정 제한 요청이 탈퇴로 닫혀 보인다", async ({
    admin,
    page,
    browser,
  }) => {
    const tag = freshTag();
    const market = await createOpenMarket(admin);
    const email = freshEmail();
    const phone = await signUp(page, email);
    const member: Me = await meOf(page.request);
    const adminMe = await meOf(admin);

    // Coin to forfeit: the start Coin waits in this database (start-grant.spec.ts), so an
    // operator's adjustment gives the member some.
    const adjusted = await admin.post(`/api/v1/admin/users/${member.id}/balance-adjust`, {
      data: { amountCoin: '1234', memo: `탈퇴 시험 ${tag}` },
    });
    expect(adjusted.status(), await adjusted.text()).toBe(200);
    const postId = await postThroughApi(page.request, market.id, `탈퇴할 글 ${tag}`, `본문 ${tag}`);
    const commentId = await commentThroughApi(page.request, postId, `탈퇴할 댓글 ${tag}`);
    // An operator's account restriction request about the member, waiting for another admin: it
    // keeps nothing from the closure (owner decision 2026-10-23).
    const asked = await admin.post(
      `/api/v1/admin/moderation/users/${member.id}/account-restriction`,
      {
        data: {
          reason: 'spam',
          note: `같은 광고를 되풀이했습니다 ${tag}`,
          days: 1,
          subject: null,
          expectedAccountId: adminMe.id,
        },
      },
    );
    expect(asked.status(), await asked.text()).toBe(200);
    const requestId = ((await asked.json()) as { data: { id: string } }).data.id;

    // --- MY 설정's last card leads to the confirmation screen, under 설정.
    await page.goto('/my/settings');
    const card = page.getByTestId('settings-closure');
    await expect(card).toContainText(copy.closureHint);
    const read = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/me/closure',
    );
    await card.getByTestId('settings-closure-open').click();
    await expect(page).toHaveURL('/my/settings/closure');
    expect((await read).status()).toBe(200);
    await expect(page.getByTestId('my-tab-settings')).toHaveAttribute('aria-current', 'page');

    // --- one screen: the Coin left and its forfeiture, the irreversibility, nothing refusing it
    // (decision 4 #140 «마지막 확인»).
    await expect(page.getByTestId('closure-coin')).toHaveText('1,234 Coin');
    await expect(page.getByTestId('closure-forfeit')).toHaveText(copy.closureForfeit);
    await expect(page.getByTestId('closure-irreversible')).toHaveText(copy.closureIrreversible);
    await expect(page.getByTestId('closure-kept')).toHaveText(copy.closureKept);
    await expect(page.getByTestId('closure-blocked')).toHaveCount(0);
    const submit = page.getByTestId('closure-submit');
    const confirmation = page.getByTestId('closure-confirmation');
    await expect(submit).toBeDisabled();
    await confirmation.fill('탈퇴합니다');
    await expect(submit).toBeDisabled();
    await confirmation.fill('탈퇴');
    await expect(submit).toBeEnabled();

    // --- closed at once: home, signed out, the toast.
    const answer = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/me/closure',
    );
    await submit.click();
    const closed = await answer;
    expect(closed.status(), await closed.text()).toBe(200);
    expect(((await closed.json()) as { data: { forfeitedCoin: string } }).data.forfeitedCoin).toBe(
      '1234',
    );
    await expect(page).toHaveURL('/');
    await expect(page.getByText(copy.closureDone).first()).toBeVisible();
    await expect(page.getByRole('link', { name: copy.login })).toBeVisible();
    expect((await page.request.get('/api/v1/me')).status()).toBe(401);

    // --- the post and the comment stay, bylined '탈퇴한 사용자' with no profile link (#37-16,
    // #37-17), on the post page and on its community card.
    await page.goto(`/community/posts/${postId}`);
    const screen = page.getByTestId('post-screen');
    await expect(screen).toContainText(`본문 ${tag}`);
    await expect(screen).toContainText(`탈퇴할 댓글 ${tag}`);
    await expect(screen.getByTestId('post-author-name').first()).toHaveText(copy.postAuthorFormer);
    await expect(
      page.getByTestId(`comment-${commentId}`).getByTestId('post-author-name').first(),
    ).toHaveText(copy.postAuthorFormer);
    await expect(screen.getByTestId('post-author-link')).toHaveCount(0);
    await expect(screen).not.toContainText(member.profile.nickname);
    await page.goto(`/community?q=${tag}`);
    const postCard = page.getByTestId(`post-card-${postId}`);
    await expect(postCard.getByTestId('post-author-name')).toHaveText(copy.postAuthorFormer);
    await expect(postCard.getByTestId('post-author-link')).toHaveCount(0);

    // --- the profile's address answers as for an account that never was (#37-16).
    const profile = await page.goto(`/u/${member.profile.publicId}`);
    expect(profile?.status()).toBe(404);
    expect((await page.request.get(`/api/v1/profiles/${member.profile.publicId}`)).status()).toBe(
      404,
    );

    // --- the old email and password sign nobody in (#57-18: the sign-in methods are gone).
    await page.goto('/login');
    await page.getByLabel(copy.email).fill(email);
    await page.getByLabel(copy.password, { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: copy.loginWithEmail }).click();
    await expect(page.getByRole('alert').filter({ hasText: copy.loginFailed })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    // --- the same email and number sign up again at once (#57-17): another account, verified
    // with the number the closure freed, whose start Coin waits for its amount as any does here.
    await openSetPassword(page, email);
    await setFirstPassword(page);
    await expect(page).toHaveURL('/onboarding');
    const { me: again } = await completeOnboardingThroughApi(page.request, { phone });
    expect(again.id).not.toBe(member.id);
    expect(again.email).toBe(email);
    expect(again.profile.publicId).not.toBe(member.profile.publicId);
    expect(again.startGrant?.status).toBe('pending');
    expect(again.balance.availableCoin).toBe('0');

    // --- the operators: the closed account under its placeholder address, named '탈퇴한
    // 사용자', no Coin, no adjustment; the waiting request closed by the closure.
    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto('/admin/users');
      await adminPage.getByTestId('admin-user-search').fill(`closed_${member.id}`);
      await adminPage.getByTestId('admin-user-search').press('Enter');
      const user = adminPage.getByTestId(`admin-user-${member.id}`);
      await expect(user).toContainText(copy.postAuthorFormer);
      await expect(user).not.toContainText(email);
      await expect(user.getByTestId('admin-user-balance')).toHaveText('0 Coin');
      await expect(user.getByTestId('admin-user-closed')).toHaveText(copy.adminAdjustClosed);
      await expect(user.getByTestId('adjust-submit')).toHaveCount(0);
      // The admin grant's search: the closed account offers no 부여 and says why (ADR-0086 7-19).
      await adminPage.goto('/admin/admins');
      const grant = adminPage.getByTestId('admin-grant');
      await grant.getByTestId('admin-grant-search').fill(`closed_${member.id}`);
      await grant.getByTestId('admin-grant-search-submit').click();
      const candidate = grant.getByTestId('admin-grant-candidate');
      await expect(candidate).toContainText(copy.postAuthorFormer);
      await expect(candidate.getByTestId('admin-grant-closed')).toHaveText(copy.adminGrantClosed);
      await expect(candidate.getByTestId('admin-grant-open')).toHaveCount(0);

      await adminPage.goto('/admin/moderation/account-restriction-requests?status=decided');
      const entry = adminPage.getByTestId(`account-request-${requestId}`);
      await showInDecided(adminPage, entry);
      await expect(entry.getByTestId('account-request-status')).toHaveText(
        copy.approvalStatusRejected,
      );
      await expect(entry.getByTestId('account-request-closed-by-closure')).toContainText(
        copy.adminAccountRequestClosedByClosure,
      );
      await expect(entry.getByTestId('account-request-decided')).toHaveCount(0);
      await expect(entry).toContainText(`${copy.adminAccountRequestDecisionReason}탈퇴`);
      await expect(entry).toContainText(copy.postAuthorFormer);
    } finally {
      await adminContext.close();
    }
  });

  test('작성 제한 중인 회원과 관리자는 탈퇴 화면에서 지금 탈퇴할 수 없는 까닭을 보고 탈퇴하지 못하며, 제한이 풀리면 회원은 다시 탈퇴할 수 있다', async ({
    admin,
    page,
    browser,
  }) => {
    const tag = freshTag();
    await signUp(page, freshEmail());
    const member = await meOf(page.request);
    const adminMe = await meOf(admin);

    // A 1-day writing restriction (#185): it keeps the closure closed until it ends or is lifted
    // (decision 4 #140 «제재 중 탈퇴»).
    const restricted = await admin.post(
      `/api/v1/admin/moderation/users/${member.id}/writing-restriction`,
      {
        data: { reason: 'spam', note: null, days: 1, subject: null, expectedAccountId: adminMe.id },
      },
    );
    expect(restricted.status(), await restricted.text()).toBe(200);
    const restriction = ((await restricted.json()) as { data: { id: string } }).data;

    await openClosure(page);
    const blocked = page.getByTestId('closure-blocked');
    await expect(blocked).toContainText(copy.closureBlocked);
    await expect(blocked.getByTestId('closure-blocker')).toHaveCount(1);
    await expect(blocked.getByTestId('closure-blocker')).toContainText(
      `${copy.errRestrictedClosure}(`,
    );
    await expect(blocked.getByTestId('restricted-moderation-link')).toHaveAttribute(
      'href',
      '/my/moderation',
    );
    await expect(page.getByTestId('closure-confirmation')).toBeDisabled();
    await expect(page.getByTestId('closure-submit')).toBeDisabled();
    // The server refuses it whatever the screen does.
    const refused = await page.request.post('/api/v1/me/closure', {
      data: { confirmation: '탈퇴', expectedAccountId: member.id },
    });
    expect(refused.status(), await refused.text()).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('RESTRICTED');

    // --- an admin: closed only once the role is revoked (#57-17).
    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await openClosure(adminPage);
      const adminBlocked = adminPage.getByTestId('closure-blocked');
      await expect(adminBlocked.getByTestId('closure-blocker')).toHaveText([
        copy.closureRefusalAdmin,
      ]);
      await expect(adminPage.getByTestId('closure-confirmation')).toBeDisabled();
      await expect(adminPage.getByTestId('closure-submit')).toBeDisabled();
    } finally {
      await adminContext.close();
    }

    // --- lifted: the member's screen offers the closure again (not taken here).
    const lifted = await admin.post(`/api/v1/admin/moderation/actions/${restriction.id}/lift`, {
      data: { reason: `시험을 마칩니다 ${tag}`, expectedAccountId: adminMe.id },
    });
    expect(lifted.status(), await lifted.text()).toBe(200);
    await openClosure(page);
    await expect(page.getByTestId('closure-blocked')).toHaveCount(0);
    await page.getByTestId('closure-confirmation').fill('탈퇴');
    await expect(page.getByTestId('closure-submit')).toBeEnabled();
  });
});
