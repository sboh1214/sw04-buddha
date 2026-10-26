import { type Browser, type Page, type Response, expect, test } from '@playwright/test';
import type { Me } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  E2E_PASSWORD,
  freshEmail,
  freshTag,
  logOut,
  mailMessageIds,
  meOf,
  signUp,
  switchAccountUnderScreen,
} from './helpers';

/**
 * M1 flow (PLAN 13 M1 AC 1): email signup -> logout -> login -> /my/settings shows the profile
 * that `GET /api/v1/me` returned. Each run uses a fresh email (and, since ADR-0070, a fresh
 * number for the 본인확인 step of the onboarding `signUp` goes through, #58), so it is re-runnable
 * against a persistent local database. Skeleton: enabled in CI in M4 (PLAN 14).
 */
const password = 'passw0rd-e2e';

test.describe('signup -> login -> settings', () => {
  test('email signup, logout, login, /me visible in settings', async ({ page }) => {
    const email = freshEmail();
    await signUp(page, email);
    // Nav shows the balance chip once `GET /me` resolves: 0, since creating an account grants
    // nothing and the start Coin the onboarding records waits for its amount (#70, ADR-0071) — the
    // sign-up trigger's 10,000 Coin is gone. The whole chip is matched, label and amount: '0 Coin'
    // alone is also inside '10,000 Coin' and could not fail.
    await expect(page.getByTestId('balance-chip')).toHaveText(
      new RegExp(`^${copy.balance}\\s*0 Coin$`),
    );

    await logOut(page);

    // --- protected route redirects to login with `next`
    await page.goto('/my/settings');
    // MY's session gate redirects with the path percent-encoded (`myLoginPath`); how much of a
    // server redirect's query string stays encoded is the framework's business, so accept both.
    await expect(page).toHaveURL(/\/login\?next=(%2F|\/)my(%2F|\/)settings/);

    // --- login
    await page.getByLabel(copy.email).fill(email);
    await page.getByLabel(copy.password, { exact: true }).fill(password);
    await page.getByRole('button', { name: copy.loginWithEmail }).click();
    await expect(page).toHaveURL('/my/settings');

    // --- /me rendered: email, auto-generated nickname (user_XXXX), credential linked
    await expect(page.getByTestId('account-email')).toContainText(email);
    await expect(page.getByTestId('nickname-input')).toHaveValue(/^user_/);
    await expect(page.getByTestId('unlink-credential')).toBeDisabled();
  });

  test('duplicate nickname -> field error (AC 4)', async ({ page }) => {
    // Two accounts; the second one tries to take the first one's nickname — in another case, which
    // is the same nickname since #58 (ADR-0069 decision 1 #57-6). The first sets one of its own at
    // the onboarding's nickname step: an auto nickname (`user_…`) is not one anybody may type.
    const taken = `Dup${freshTag().slice(-8)}`;
    await signUp(page, freshEmail(), undefined, { nickname: taken });
    await page.goto('/my/settings');
    // Wait for the seeded value: the input exists before `GET /me` resolves.
    await expect(page.getByTestId('nickname-input')).toHaveValue(taken);
    await logOut(page);

    await signUp(page, freshEmail());
    await page.goto('/my/settings');
    await expect(page.getByTestId('nickname-input')).toHaveValue(/^user_/);
    await page.getByTestId('nickname-input').fill(taken.toLowerCase());
    // Scoped: the 본인확인 card has its own '저장' button.
    await page.getByTestId('settings-profile').getByRole('button', { name: copy.save }).click();
    await expect(page.getByText(copy.errNicknameTaken)).toBeVisible();
  });

  test('logged-in visitor is redirected away from /login', async ({ page }) => {
    await signUp(page, freshEmail());
    await page.goto('/login');
    await expect(page).toHaveURL('/');
  });
});

test.describe('MY 설정의 better-auth 쓰기는 그 화면의 계정을 댄다 (ADR-0092)', () => {
  // In the render between the tab's session naming B and SessionCacheGuard's reset, MY 설정 is
  // still A's while the cookie is already B's, and the cards that write through better-auth —
  // whose own bodies name no account — did it to B: B's password changed and B's other sessions
  // ended (the current password typed for A is B's too, as here), a confirmation mailed to B's
  // address naming the address typed for A, the provider A picked linked to B. Each card now
  // names the account of its `Me`, and the API's hook refuses another before anything is done.
  // The render is held as onboarding.spec.ts holds it: B's cookie in this tab and the session
  // read again, while `GET /me` still answers as A (`switchAccountUnderScreen`).

  interface Switched {
    a: Me;
    aEmail: string;
    bEmail: string;
    /** A page of B's own window, signed in as B. */
    other: Page;
    close: () => Promise<void>;
  }

  /** A on MY 설정, B's cookie in A's tab, the screen still A's. */
  async function aOnScreenWithBsCookie(browser: Browser, page: Page): Promise<Switched> {
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    const close = async () => {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await otherContext.close();
      await shownContext.close();
    };
    try {
      const other = await otherContext.newPage();
      const bEmail = freshEmail();
      await signUp(other, bEmail);
      const b = await meOf(other.request);
      const aEmail = freshEmail();
      await signUp(page, aEmail);
      const a = await meOf(page.request);
      await page.goto('/my/settings');
      await expect(page.getByTestId('account-email')).toContainText(aEmail);
      await shownContext.addCookies(await page.context().cookies());
      await switchAccountUnderScreen(page, shownContext.request, {
        id: b.id,
        cookies: await otherContext.cookies(),
      });
      // A's screen, drawn again from A's `Me` after the guard's reset.
      await expect(page.getByTestId('account-email')).toContainText(aEmail);
      return { a, aEmail, bEmail, other, close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  /** The answer to the next request the page sends to `/api/auth<path>`. */
  const authAnswer = (page: Page, path: string): Promise<Response> =>
    page.waitForResponse((response) => new URL(response.url()).pathname === `/api/auth${path}`);

  /** Whether `email` still signs in with `password` (a fresh jar: no cookie, no Origin). */
  async function signsInWith(browser: Browser, email: string, password: string): Promise<boolean> {
    const probe = await browser.newContext();
    try {
      const answer = await probe.request.post('/api/auth/sign-in/email', {
        data: { email, password },
      });
      return answer.ok();
    } finally {
      await probe.close();
    }
  }

  const sessionChangedToast = (page: Page) =>
    page.locator('[data-scope="toast"]').getByText(copy.sessionChanged);

  test('탭의 계정이 다른 회원으로 바뀐 뒤 앞 계정의 MY 설정에서 비밀번호를 바꾸면 그 화면의 계정을 대어 거절되고, 어느 계정의 비밀번호도 바뀌지 않는다', async ({
    browser,
    page,
  }) => {
    const switched = await aOnScreenWithBsCookie(browser, page);
    try {
      const card = page.getByTestId('settings-password');
      const changed = 'changed-passw0rd-e2e';
      await card.getByLabel(copy.currentPassword, { exact: true }).fill(E2E_PASSWORD);
      await card.getByLabel(copy.newPassword, { exact: true }).fill(changed);
      await card.getByLabel(copy.newPasswordConfirm, { exact: true }).fill(changed);
      const answered = authAnswer(page, '/change-password');
      await card.getByRole('button', { name: copy.settingsPassword }).click();
      const answer = await answered;

      expect(answer.status()).toBe(403);
      expect(answer.request().postDataJSON()).toEqual({
        currentPassword: E2E_PASSWORD,
        newPassword: changed,
        revokeOtherSessions: true,
        expectedAccountId: switched.a.id,
      });
      await expect(sessionChangedToast(page)).toBeVisible();
      // Neither account's password changed: both still sign in with the one they had.
      expect(await signsInWith(browser, switched.bEmail, E2E_PASSWORD)).toBe(true);
      expect(await signsInWith(browser, switched.aEmail, E2E_PASSWORD)).toBe(true);
    } finally {
      await switched.close();
    }
  });

  test('탭의 계정이 다른 회원으로 바뀐 뒤 앞 계정의 MY 설정에서 이메일을 바꾸면 그 화면의 계정을 대어 거절되고, 아무에게도 메일이 가지 않는다', async ({
    browser,
    page,
  }) => {
    const switched = await aOnScreenWithBsCookie(browser, page);
    try {
      const typed = freshEmail();
      const mailedB = await mailMessageIds(switched.bEmail);
      await page.getByTestId('new-email-input').fill(typed);
      const answered = authAnswer(page, '/change-email');
      await page.getByTestId('change-email').click();
      const answer = await answered;

      expect(answer.status()).toBe(403);
      expect(answer.request().postDataJSON()).toEqual({
        newEmail: typed,
        callbackURL: '/my/settings',
        expectedAccountId: switched.a.id,
      });
      await expect(sessionChangedToast(page)).toBeVisible();
      // No confirmation to B's address, nothing to the address typed for A.
      expect(await mailMessageIds(switched.bEmail)).toEqual(mailedB);
      expect(await mailMessageIds(typed)).toEqual([]);
    } finally {
      await switched.close();
    }
  });

  test('탭의 계정이 다른 회원으로 바뀐 뒤 앞 계정의 MY 설정에서 소셜 로그인을 연결하면 그 화면의 계정을 대어 거절되고, 다른 회원의 로그인 수단은 그대로다', async ({
    browser,
    page,
  }) => {
    const switched = await aOnScreenWithBsCookie(browser, page);
    try {
      const answered = authAnswer(page, '/link-social');
      await page.getByTestId('link-google').click();
      const answer = await answered;

      expect(answer.status()).toBe(403);
      expect(answer.request().postDataJSON()).toMatchObject({
        provider: 'google',
        expectedAccountId: switched.a.id,
      });
      await expect(sessionChangedToast(page)).toBeVisible();
      await expect(page).toHaveURL('/my/settings');
      // B still has the one login method it had.
      const listed = (await (
        await switched.other.request.get('/api/auth/list-accounts')
      ).json()) as { providerId: string }[];
      expect(listed.map((account) => account.providerId)).toEqual(['credential']);
    } finally {
      await switched.close();
    }
  });
});
