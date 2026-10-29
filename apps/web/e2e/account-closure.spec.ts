import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { AccountClosureCheck, Me } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  E2E_PASSWORD,
  adminAccount,
  completeOnboardingThroughApi,
  createOpenMarket,
  expect,
  expectOnboardingClosureLink,
  freshEmail,
  freshTag,
  meOf,
  nextMeRead,
  openClosure,
  openSetPassword,
  setFirstPassword,
  signIn,
  signUp,
  swapCookieUnderScreen,
  switchAccountUnderScreen,
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
 *   #70); the operators find the closed account named '탈퇴한 사용자' and marked '탈퇴' with no Coin
 *   and no balance adjustment, its page — and its post's and comment's moderation pages, which
 *   still offer hiding them — offering no warning or restriction (the API refusing one,
 *   `closed`), the admin grant's search not finding it at all, and the waiting request rejected by
 *   the closure, reason '탈퇴', no admin named (owner decisions 2026-10-23 (2차) 1 and 5) — the
 *   screen having said what goes, that the 본인확인 record is kept for the retention period, what
 *   stays, and nothing of the start Coin, which was still waiting ((3차) 7 and 9);
 * - an account that has not finished its onboarding follows the small '탈퇴하기' link at the very
 *   bottom of its consent step to the screen — the gate leaves it alone, while MY 설정 stays gated
 *   and the screen's way back to it goes through the steps left — and closes itself (owner decisions
 *   2026-10-23 (2차) 3 and (4차) 1·2);
 * - a member facing a re-consent, whose write screen, post page and MY 설정 each kept what it was
 *   typing in the tab on the way to the step, closes the account from that step's '탈퇴하기': the
 *   tab keeps none of it, as after 로그아웃 (ADR-0086 7-20);
 * - an account whose start Coin was paid reads, right under what stays, that the same number gets
 *   no start Coin again ((3차) 9) — the check's answer rewritten in the browser, as this database
 *   pays none;
 * - a member under a writing restriction, and an admin, find the screen saying why it cannot close
 *   now — the restriction with its end and the way to 조치·신고 내역, the admin role until it is
 *   revoked — with the field and the button off, and the API refuses it as well; lifted, the
 *   member's screen offers the closure again;
 * - a tab whose account switched to another while it showed the screen closes nobody: the closure
 *   names the account the screen was drawn for and is refused — and when that refusal is what
 *   draws the screen again for the other account, the screen says why — and a screen whose
 *   `['me']` turned to another account before the session did starts again empty for that one and
 *   waits for its own check; a check that could not be read again never lets the closure go over
 *   the one read before (ADR-0091).
 *
 * Every rule's branch (the deletion and the kept set, the forfeiture's ledger, each refusal, the
 * locks, the database's own checks, the private-data guard) is the API's and the database's tests
 * (account-closure.controller.test.ts, schema.test.ts); the wording's is the web's unit tests
 * (lib/account-closure.test.ts, lib/restriction.test.ts). This database has no start amount, so no
 * start Coin is ever paid here (start-grant.spec.ts), and setting one would pay every other spec's
 * accounts meanwhile: which grant states set `startGrantReceived` is the API's tests', and the
 * screen is shown the paid state by a rewritten answer. Every restriction a test gives ends before
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

/**
 * `GET /me` in this page answering as the server would after a revision of the terms that changed
 * members' rights, while `on` (posts.spec.ts, comments.spec.ts and profile.spec.ts draw it the same
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
  return state;
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

/**
 * The storage keys of the drafts an onboarding step kept in this tab's sessionStorage — a post's,
 * a comment's and MY 설정's (lib/post-drafts.ts, lib/comment-drafts.ts, lib/profile-drafts.ts).
 */
function draftsInTab(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter((key) => /^buddha\.[a-zA-Z]+Draft:/.test(key))
      .sort(),
  );
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
      data: { amountCoin: '1234', memo: `탈퇴 시험 ${tag}`, expectedAccountId: adminMe.id },
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
    // What goes, the 본인확인 record right under it, and what stays (owner decision 2026-10-23 (3차)
    // 7). The start Coin waits in this database, so nothing is said of it: the closure cancels it
    // and the number may receive it again (owner decision 2026-10-23 (3차) 9).
    await expect(page.getByTestId('closure-deleted')).toHaveText(copy.closureDeleted);
    await expect(page.getByTestId('closure-phone-records')).toHaveText(copy.closurePhoneRecords);
    await expect(page.getByTestId('closure-kept')).toHaveText(copy.closureKept);
    await expect(page.getByTestId('closure-start-grant')).toHaveCount(0);
    // Nothing proposed, so nothing of proposals (#77, owner decision 2026-10-24 — proposals.spec.ts
    // shows the line to an account with one waiting).
    await expect(page.getByTestId('closure-proposals')).toHaveCount(0);
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
    // 사용자' and marked '탈퇴', no Coin, no adjustment, no new action; left out of the admin
    // grant's search; the waiting request closed by the closure (owner decision 2026-10-23 (2차)
    // 1 and 5).
    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto('/admin/users');
      await adminPage.getByTestId('admin-user-search').fill(`closed_${member.id}`);
      await adminPage.getByTestId('admin-user-search').press('Enter');
      const user = adminPage.getByTestId(`admin-user-${member.id}`);
      await expect(user).toContainText(copy.postAuthorFormer);
      await expect(user.getByTestId('admin-closed-badge')).toHaveText(copy.adminClosedBadge);
      await expect(user).not.toContainText(email);
      await expect(user.getByTestId('admin-user-balance')).toHaveText('0 Coin');
      await expect(user.getByTestId('admin-user-closed')).toHaveText(copy.adminAdjustClosed);
      await expect(user.getByTestId('adjust-submit')).toHaveCount(0);
      // The member's page: named and marked as on the list, no warning or restriction offered,
      // and the server refuses one all the same.
      await user.getByTestId('admin-user-moderation').click();
      await expect(adminPage).toHaveURL(`/admin/moderation/users/${member.id}`);
      await expect(adminPage.getByTestId('moderation-user-nickname')).toHaveText(
        copy.postAuthorFormer,
      );
      await expect(adminPage.getByTestId('admin-closed-badge')).toHaveText(copy.adminClosedBadge);
      const actionBar = adminPage.getByTestId('moderation-action-bar');
      await expect(actionBar.getByTestId('moderation-closed')).toHaveText(copy.errModerationClosed);
      for (const button of [
        'moderation-warn',
        'moderation-restrict',
        'moderation-account-restrict',
      ]) {
        await expect(actionBar.getByTestId(button)).toHaveCount(0);
      }
      const warned = await admin.post(`/api/v1/admin/moderation/users/${member.id}/warn`, {
        data: { reason: 'spam', note: null, subject: null, expectedAccountId: adminMe.id },
      });
      expect(warned.status(), await warned.text()).toBe(409);
      expect(
        ((await warned.json()) as { error: { code: string; details: unknown } }).error,
      ).toMatchObject({ code: 'MODERATION_NOT_ALLOWED', details: { reason: 'closed' } });
      // The closed member's post and comment pages: the item stays public, so hiding it is still
      // offered, while its author takes no new action — the same sentence in place of the three
      // buttons (ADR-0086 7-29).
      for (const itemPage of [
        `/admin/moderation/posts/${postId}`,
        `/admin/moderation/comments/${commentId}`,
      ]) {
        await adminPage.goto(itemPage);
        const itemBar = adminPage.getByTestId('moderation-action-bar');
        await expect(itemBar.getByTestId('moderation-closed'), itemPage).toHaveText(
          copy.errModerationClosed,
        );
        await expect(itemBar.getByTestId('moderation-hide'), itemPage).toBeVisible();
        for (const button of [
          'moderation-warn',
          'moderation-restrict',
          'moderation-account-restrict',
        ]) {
          await expect(itemBar.getByTestId(button), `${itemPage} ${button}`).toHaveCount(0);
        }
      }
      // The admin grant's search lists open accounts only: the closed one is not found at all.
      await adminPage.goto('/admin/admins');
      const grant = adminPage.getByTestId('admin-grant');
      await grant.getByTestId('admin-grant-search').fill(`closed_${member.id}`);
      await grant.getByTestId('admin-grant-search-submit').click();
      await expect(grant).toContainText(copy.adminNoUsers);
      await expect(grant.getByTestId('admin-grant-candidate')).toHaveCount(0);

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

  test("온보딩을 마치지 않은 계정도 온보딩 단계 맨 아래의 '탈퇴하기'로 탈퇴 화면을 열어 탈퇴하고, MY의 다른 화면은 그대로 온보딩으로 보낸다", async ({
    page,
  }) => {
    // Signed up and signed in, with every onboarding step left (the consent first).
    await openSetPassword(page, freshEmail());
    await setFirstPassword(page);
    await expect(page).toHaveURL('/onboarding');
    await expect(page.getByTestId('consent-step')).toBeVisible();
    const fresh = await meOf(page.request);
    expect(fresh.onboarding.nextStep).toBe('consent');

    // MY 설정 stays behind the gate…
    await page.goto('/my/settings');
    await expect(page).toHaveURL(/^[^?]*\/onboarding/);
    await expect(page.getByTestId('consent-step')).toBeVisible();

    // …and the 탈퇴 screen does not (owner decision 2026-10-23 (2차) 3): the consent step's small
    // '탈퇴하기' at the very bottom, under 로그아웃, goes there ((4차) 1)…
    await expectOnboardingClosureLink(page);
    await openClosure(page, () => page.getByTestId('onboarding-closure').click());
    // …whose way back to MY 설정 goes through the steps left, as built ((4차) 2) — and on the
    // step, the link again.
    await page.getByTestId('closure-back').click();
    await expect(page).toHaveURL(`/onboarding?next=${encodeURIComponent('/my/settings')}`);
    await expect(page.getByTestId('consent-step')).toBeVisible();
    await openClosure(page, () => page.getByTestId('onboarding-closure').click());

    // The check, read: no Coin, nothing refusing, nothing said of a start Coin never asked for.
    await expect(page.getByTestId('closure-coin')).toHaveText('0 Coin');
    await expect(page.getByTestId('closure-blocked')).toHaveCount(0);
    await expect(page.getByTestId('closure-start-grant')).toHaveCount(0);
    await page.getByTestId('closure-confirmation').fill('탈퇴');
    await expect(page).toHaveURL('/my/settings/closure');
    await expect(page.getByTestId('onboarding-gate')).toHaveCount(0);

    const answer = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/me/closure',
    );
    await page.getByTestId('closure-submit').click();
    const closed = await answer;
    expect(closed.status(), await closed.text()).toBe(200);
    await expect(page).toHaveURL('/');
    await expect(page.getByText(copy.closureDone).first()).toBeVisible();
    expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  });

  test("온보딩 단계로 가며 이 탭에 둔 쓰던 글·댓글·소개는 그 단계의 '탈퇴하기'로 탈퇴하면 로그아웃처럼 모두 지워진다", async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const accountId = (await meOf(page.request)).id;
    const postId = await postThroughApi(page.request, market.id, `탈퇴 전의 글 ${tag}`, tag);
    const reconsent = await asReconsent(page);
    const write = `/community/write?market=${market.id}`;
    const postPage = `/community/posts/${postId}`;
    const settings = '/my/settings';
    const viaStep = (next: string) => `/onboarding?next=${encodeURIComponent(next)}`;

    // --- a post draft, kept by the gate when its write is refused for the onboarding (a revision
    // asked for the consent again meanwhile — posts.spec.ts).
    await page.goto(write);
    await page.getByTestId('post-title-input').fill(`탈퇴 전에 쓰던 제목 ${tag}`);
    await page.getByTestId('post-editor-content').click();
    await page.keyboard.type(`탈퇴 전에 쓰던 근거 ${tag}`);
    await page.route('**/api/v1/posts', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      reconsent.on = true;
      await route.fulfill(ONBOARDING_REFUSAL);
    });
    await page.getByTestId('post-submit').click();
    await expect(page).toHaveURL(viaStep(write));
    await expect(page.getByTestId('consent-step')).toBeVisible();

    // --- a 댓글: the post page stays open to a re-consent, and its 올리기 goes to the step with
    // the box's text kept (comments.spec.ts).
    await page.goto(postPage);
    await expect(page).toHaveURL(postPage);
    const composer = page.getByTestId('comment-composer');
    await composer.getByTestId('comment-input').fill(`탈퇴 전에 쓰던 댓글 ${tag}`);
    await composer.getByTestId('comment-submit').click();
    await expect(page).toHaveURL(viaStep(postPage));
    await expect(page.getByTestId('consent-step')).toBeVisible();

    // --- a new 소개: MY 설정 stays open to a re-consent too, and its 저장 goes to the step with the
    // 소개 kept (profile.spec.ts).
    const meRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/me' && response.request().method() === 'GET',
    );
    await page.goto(settings);
    await meRead;
    await expect(page).toHaveURL(settings);
    const bioCard = page.getByTestId('settings-bio');
    await bioCard.getByTestId('bio-input').fill(`탈퇴 전에 쓰던 소개 ${tag}`);
    await bioCard.getByTestId('bio-save').click();
    await expect(page).toHaveURL(viaStep(settings));
    const kept = [
      `buddha.commentDraft:${postId}:comment@${accountId}`,
      `buddha.postDraft:new:${market.id}@${accountId}`,
      'buddha.profileDraft:bio',
    ];
    expect(await draftsInTab(page)).toEqual(kept);

    // --- the step's '탈퇴하기' to the screen — the drafts still kept there — and the closure: they
    // go with the account, as on 로그아웃 (ADR-0086 7-20).
    await expectOnboardingClosureLink(page);
    await openClosure(page, () => page.getByTestId('onboarding-closure').click());
    expect(await draftsInTab(page)).toEqual(kept);
    await page.getByTestId('closure-confirmation').fill('탈퇴');
    const answer = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/me/closure',
    );
    await page.getByTestId('closure-submit').click();
    const closed = await answer;
    expect(closed.status(), await closed.text()).toBe(200);
    await expect(page).toHaveURL('/');
    await expect(page.getByText(copy.closureDone).first()).toBeVisible();
    expect(await draftsInTab(page)).toEqual([]);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('시작 Coin이 지급된 계정의 확인 화면은 남는 것의 줄 바로 아래에 같은 번호로는 시작 Coin을 다시 받지 못한다고 말한다', async ({
    page,
  }) => {
    await signUp(page, freshEmail());
    // This database pays no start Coin (start-grant.spec.ts), and an amount set for this test
    // would pay every other spec's accounts meanwhile: the check's answer is rewritten in this
    // browser alone to say the account's start Coin was paid, as start-grant.spec.ts rewrites
    // `GET /me`. The closure itself is never sent; the API's tests cover each grant state.
    await page.route('**/api/v1/me/closure', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const body = (await response.json()) as { data: AccountClosureCheck };
      body.data.startGrantReceived = true;
      await route.fulfill({ response, json: body });
    });

    // Owner decision 2026-10-23 (3차) 9: the line, for an account whose start Coin was paid, under
    // what stays and above the irreversibility (ADR-0086 7-33).
    await openClosure(page);
    await expect(page.getByTestId('closure-start-grant')).toHaveText(copy.closureStartGrant);
    const lines = page.getByTestId('closure-deleted').locator('xpath=../*');
    expect(
      await lines.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid'))),
    ).toEqual(['closure-deleted', 'closure-phone-records', 'closure-kept', 'closure-start-grant']);
    const line = await page.getByTestId('closure-start-grant').boundingBox();
    const irreversible = await page.getByTestId('closure-irreversible').boundingBox();
    expect(irreversible!.y).toBeGreaterThan(line!.y);
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

  /** Records every `POST /me/closure` body the page sends. */
  function closureWrites(page: Page): unknown[] {
    const writes: unknown[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/me/closure') {
        writes.push(request.postDataJSON());
      }
    });
    return writes;
  }

  test("탭의 계정이 다른 회원으로 바뀐 뒤 앞 계정의 탈퇴 화면이 남아 있으면 '탈퇴'는 그 화면의 계정을 대어 거절되고, 어느 계정도 닫히지 않는다", async ({
    browser,
    page,
  }) => {
    // ADR-0091 (ADR-0090 결과 5's remaining writes): in the render between the session naming B
    // and SessionCacheGuard's reset the screen still shows A's Coin and refusals while the session
    // already says B, and a closure naming the session's account would be taken with B's cookie —
    // B closed on the '탈퇴' typed on A's screen, at once and for good. The screen names the account
    // of the `Me` it was drawn from, so the server refuses it as another account's. That render is
    // held here: B's cookie in this tab and the session read again, while `GET /me` and the check
    // still answer as A (`switchAccountUnderScreen`) — B, a member nothing keeps from closing,
    // would have been closed.
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      const b = await meOf(other.request);
      await signUp(page, freshEmail());
      const a = await meOf(page.request);
      await openClosure(page);
      await shownContext.addCookies(await page.context().cookies());
      await switchAccountUnderScreen(
        page,
        shownContext.request,
        { id: b.id, cookies: await otherContext.cookies() },
        (request) =>
          request.method() === 'GET' && new URL(request.url()).pathname === '/api/v1/me/closure',
      );

      const writes = closureWrites(page);
      // A's screen, drawn again from A's `Me` and A's check after the guard's reset.
      await expect(page.getByTestId('closure-coin')).toBeVisible();
      await page.getByTestId('closure-confirmation').fill('탈퇴');
      const answered = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/v1/me/closure',
      );
      await page.getByTestId('closure-submit').click();
      expect((await answered).status()).toBe(403);
      await expect(page.getByTestId('closure-error')).toHaveText(copy.sessionChanged);
      await expect(page).toHaveURL('/my/settings/closure');

      expect(writes).toEqual([{ confirmation: '탈퇴', expectedAccountId: a.id }]);
      // Neither closed: both still answer `GET /me` as themselves.
      expect((await meOf(other.request)).id).toBe(b.id);
      expect((await meOf(shownContext.request)).id).toBe(a.id);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await otherContext.close();
      await shownContext.close();
    }
  });

  test("탭의 세션이 아직 앞 계정을 말하는데 탈퇴 화면의 `GET /me`가 다른 회원으로 답하면 화면은 그 회원의 것으로 비어 다시 그려지고, 그 회원의 확인을 읽기 전에는 '탈퇴'를 받지 않는다", async ({
    browser,
    page,
  }) => {
    // ADR-0091 (ADR-0090 결정 4-2's order): `['me']` turns from A to B in place, before the
    // session does, so SessionCacheGuard resets nothing — a window-focus refetch of `GET /me`
    // answered with B's cookie while better-auth's session still says A. Unkeyed, the screen kept
    // the '탈퇴' typed on A's screen with the button on, and the next press named B — the `Me` now
    // drawn — with B's cookie: B closed. Keyed by account, it starts again empty for B; and since
    // the check names no owner, it is kept under the account too: B's screen waits for B's own
    // check, drawing nothing of A's meanwhile. Held as in phone-verification.spec.ts:
    // better-auth's answers come from A's jar, B's cookie is put in the tab, and the page's clock
    // makes `['me']` older than its `staleTime` (30 s); B's check is held until the end.
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      const b = await meOf(other.request);
      await signUp(page, freshEmail());
      const a = await meOf(page.request);
      await page.clock.install();
      await openClosure(page);
      const confirmation = page.getByTestId('closure-confirmation');
      const submit = page.getByTestId('closure-submit');
      await confirmation.fill('탈퇴');
      await expect(submit).toBeEnabled();

      // The tab's session keeps saying A — its body only: a cookie A's answer set would put A
      // back in the tab.
      await shownContext.addCookies(await page.context().cookies());
      await page.route(
        (url) => url.pathname === '/api/auth/get-session',
        async (route) => {
          const answer = await shownContext.request.get(route.request().url());
          await route.fulfill({ status: answer.status(), json: (await answer.json()) as unknown });
        },
      );
      // B's check, held: what the screen holds until it answers is A's.
      let releaseCheck: () => void = () => undefined;
      const checkReleased = new Promise<void>((resolve) => {
        releaseCheck = resolve;
      });
      let checkHeld = false;
      await page.route(
        (url) => url.pathname === '/api/v1/me/closure',
        async (route) => {
          if (route.request().method() !== 'GET') return route.fallback();
          checkHeld = true;
          await checkReleased;
          await route.fallback();
        },
      );
      const writes = closureWrites(page);
      await page.context().clearCookies();
      await page.context().addCookies(await otherContext.cookies());
      const meRead = nextMeRead(page);
      await page.clock.fastForward('00:31');
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
      const drawn = (await (await meRead).json()) as { data: { id: string } };
      expect(drawn.data.id).toBe(b.id);

      // B's screen waits for B's own check: nothing of A's — the Coin, the '탈퇴' typed, the
      // button — is drawn under B's `Me`.
      await expect.poll(() => checkHeld).toBe(true);
      await expect(page.getByTestId('account-closure')).toBeVisible();
      await expect(page.getByTestId('closure-coin')).toHaveCount(0);
      await expect(confirmation).toHaveCount(0);
      await expect(submit).toHaveCount(0);
      const checkRead = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === '/api/v1/me/closure',
      );
      releaseCheck();
      expect((await checkRead).status()).toBe(200);
      // B's screen, empty: the '탈퇴' typed on A's is gone, and the button waits for it again.
      await expect(page.getByTestId('closure-coin')).toBeVisible();
      await expect(confirmation).toHaveValue('');
      await expect(submit).toBeDisabled();
      await confirmation.fill('탈퇴');
      await expect(submit).toBeEnabled();

      expect(writes).toEqual([]);
      expect((await meOf(other.request)).id).toBe(b.id);
      expect((await meOf(shownContext.request)).id).toBe(a.id);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await otherContext.close();
      await shownContext.close();
    }
  });
  test("탭의 세션이 아직 앞 계정을 말하는 채 '탈퇴'가 다른 회원의 쿠키로 가면 거절되고, 화면이 그 회원의 것으로 다시 그려진 뒤에도 거절의 까닭이 그 자리에 남는다", async ({
    browser,
    page,
  }) => {
    // ADR-0091, the order two windows side by side take (SessionCacheGuard's header: no
    // `visibilitychange`, so nothing in this tab reads the session again): B's cookie is in the tab
    // while its session and `['me']` still say A. The press names A, the server refuses it as
    // another account's, and the refusal's own session read is the first to say B — the guard's
    // reset then takes `['me']` back to waiting, and the screen is drawn again, empty, for B. The
    // refusal is kept above the keyed screen, so B's screen says why it started again; kept in
    // the screen it went with A's, and a member who took the press for a glitch could type
    // '탈퇴' again — on B's screen, closing B.
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      const b = await meOf(other.request);
      await signUp(page, freshEmail());
      const a = await meOf(page.request);
      await shownContext.addCookies(await page.context().cookies());
      await openClosure(page);
      const confirmation = page.getByTestId('closure-confirmation');
      const submit = page.getByTestId('closure-submit');
      await confirmation.fill('탈퇴');
      await expect(submit).toBeEnabled();

      const writes = closureWrites(page);
      await swapCookieUnderScreen(page, await otherContext.cookies());
      const answered = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/v1/me/closure',
      );
      const meRead = nextMeRead(page);
      await submit.click();
      expect((await answered).status()).toBe(403);
      // The guard's reset, and `GET /me` read again: B's screen.
      const drawn = (await (await meRead).json()) as { data: { id: string } };
      expect(drawn.data.id).toBe(b.id);
      await expect(page.getByTestId('closure-coin')).toBeVisible();
      await expect(confirmation).toHaveValue('');
      await expect(page.getByTestId('closure-error')).toHaveText(copy.sessionChanged);
      await expect(submit).toBeDisabled();
      await expect(page).toHaveURL('/my/settings/closure');

      expect(writes).toEqual([{ confirmation: '탈퇴', expectedAccountId: a.id }]);
      expect((await meOf(other.request)).id).toBe(b.id);
      expect((await meOf(shownContext.request)).id).toBe(a.id);
    } finally {
      await otherContext.close();
      await shownContext.close();
    }
  });

  test("탈퇴 화면을 다시 열 때 확인을 다시 읽지 못하면 앞서 읽은 Coin과 막는 것으로 '탈퇴'를 받지 않고, 다시 읽은 뒤에 받는다", async ({
    page,
  }) => {
    // ADR-0091: the button waits for a check read since the screen was drawn. TanStack's
    // `isFetchedAfterMount` also counts a read that FAILED since then, over the check held from
    // before — so alone it let the closure go over an amount that could not be read again. The
    // screen opened again by its links (one tab: the check read first stays in the cache), its
    // read failing every time, says so with 다시 시도 instead of the amount held.
    await signUp(page, freshEmail());
    await openClosure(page);
    await page.getByTestId('closure-back').click();
    await expect(page).toHaveURL('/my/settings');

    let failures = 0;
    const isCheck = (url: URL) => url.pathname === '/api/v1/me/closure';
    await page.route(isCheck, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      failures += 1;
      await route.fulfill({
        status: 503,
        json: { error: { code: 'INTERNAL', message: 'unavailable' } },
      });
    });
    const writes = closureWrites(page);
    await page.getByTestId('settings-closure-open').click();
    await expect(page).toHaveURL('/my/settings/closure');
    // The read and its two retries (1 s, 2 s) have failed.
    await expect.poll(() => failures, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    const failed = page.getByTestId('closure-check-failed');
    await expect(failed).toContainText(copy.closureCheckFailed);
    await expect(page.getByTestId('closure-coin')).toHaveCount(0);
    await expect(page.getByTestId('closure-submit')).toHaveCount(0);

    // Read again: the screen, and the button once '탈퇴' is typed.
    await page.unroute(isCheck);
    await failed.getByRole('button', { name: copy.retry }).click();
    await expect(page.getByTestId('closure-coin')).toBeVisible();
    await page.getByTestId('closure-confirmation').fill('탈퇴');
    await expect(page.getByTestId('closure-submit')).toBeEnabled();
    expect(writes).toEqual([]);
  });
});
