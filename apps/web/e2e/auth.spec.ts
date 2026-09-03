import { expect, test, type Page } from '@playwright/test';
import { copy } from '../src/copy';

/**
 * M1 flow (PLAN 13 M1 AC 1): email signup -> logout -> login -> /settings shows the profile
 * that `GET /api/v1/me` returned. Each run uses a fresh email so it is re-runnable against a
 * persistent local database. Skeleton: enabled in CI in M4 (PLAN 14).
 */
const password = 'passw0rd-e2e';

function freshEmail() {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@buddha.local`;
}

async function signUp(page: Page, email: string) {
  await page.goto('/signup');
  await page.getByLabel(copy.email).fill(email);
  await page.getByLabel(copy.password, { exact: true }).fill(password);
  await page.getByLabel(copy.passwordConfirm).fill(password);
  await page.getByRole('button', { name: copy.signupWithEmail }).click();
  await expect(page).toHaveURL('/');
}

async function logOut(page: Page) {
  await page.getByRole('button', { name: copy.profileMenu }).click();
  await page.getByRole('menuitem', { name: copy.logout }).click();
  await expect(page.getByRole('link', { name: copy.login })).toBeVisible();
}

test.describe('signup -> login -> settings', () => {
  test('email signup, logout, login, /me visible in settings', async ({ page }) => {
    const email = freshEmail();
    await signUp(page, email);
    // Nav shows the balance chip once `GET /me` resolves (balance 0P for a new user).
    await expect(page.getByTestId('balance-chip')).toContainText('0P');

    await logOut(page);

    // --- protected route redirects to login with `next`
    await page.goto('/settings');
    // settings/page.tsx redirects with the raw path (`?next=/settings`); a client-side link
    // would percent-encode it, so accept both spellings.
    await expect(page).toHaveURL(/\/login\?next=(%2F|\/)settings/);

    // --- login
    await page.getByLabel(copy.email).fill(email);
    await page.getByLabel(copy.password, { exact: true }).fill(password);
    await page.getByRole('button', { name: copy.loginWithEmail }).click();
    await expect(page).toHaveURL('/settings');

    // --- /me rendered: email, auto-generated nickname (예측가_XXXX), credential linked
    await expect(page.getByTestId('settings-email')).toContainText(email);
    await expect(page.getByTestId('nickname-input')).toHaveValue(/^예측가_/);
    await expect(page.getByTestId('unlink-credential')).toBeDisabled();
  });

  test('duplicate nickname -> field error (AC 4)', async ({ page }) => {
    // Two accounts; the second one tries to take the first one's nickname.
    await signUp(page, freshEmail());
    await page.goto('/settings');
    // Wait for the seeded value: the input exists before `GET /me` resolves.
    await expect(page.getByTestId('nickname-input')).toHaveValue(/^예측가_/);
    const taken = await page.getByTestId('nickname-input').inputValue();
    await logOut(page);

    await signUp(page, freshEmail());
    await page.goto('/settings');
    await expect(page.getByTestId('nickname-input')).toHaveValue(/^예측가_/);
    await page.getByTestId('nickname-input').fill(taken);
    await page.getByRole('button', { name: copy.save }).click();
    await expect(page.getByText(copy.errNicknameTaken)).toBeVisible();
  });

  test('logged-in visitor is redirected away from /login', async ({ page }) => {
    await signUp(page, freshEmail());
    await page.goto('/login');
    await expect(page).toHaveURL('/');
  });
});
