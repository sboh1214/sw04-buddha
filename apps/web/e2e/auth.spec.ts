import { expect, test } from '@playwright/test';
import { copy } from '../src/copy';
import { freshEmail, logOut, signUp } from './helpers';

/**
 * M1 flow (PLAN 13 M1 AC 1): email signup -> logout -> login -> /my/settings shows the profile
 * that `GET /api/v1/me` returned. Each run uses a fresh email (and, since ADR-0070, a fresh
 * number for the 본인확인 step `signUp` goes through), so it is re-runnable against a persistent
 * local database. Skeleton: enabled in CI in M4 (PLAN 14).
 */
const password = 'passw0rd-e2e';

test.describe('signup -> login -> settings', () => {
  test('email signup, logout, login, /me visible in settings', async ({ page }) => {
    const email = freshEmail();
    await signUp(page, email);
    // Nav shows the balance chip once `GET /me` resolves: 0, since creating an account grants
    // nothing (#70, ADR-0071) — the sign-up trigger's 10,000 Coin is gone. The whole chip is
    // matched, label and amount: '0 Coin' alone is also inside '10,000 Coin' and could not fail.
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
    // Two accounts; the second one tries to take the first one's nickname.
    await signUp(page, freshEmail());
    await page.goto('/my/settings');
    // Wait for the seeded value: the input exists before `GET /me` resolves.
    await expect(page.getByTestId('nickname-input')).toHaveValue(/^user_/);
    const taken = await page.getByTestId('nickname-input').inputValue();
    await logOut(page);

    await signUp(page, freshEmail());
    await page.goto('/my/settings');
    await expect(page.getByTestId('nickname-input')).toHaveValue(/^user_/);
    await page.getByTestId('nickname-input').fill(taken);
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
