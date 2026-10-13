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

/** Mailpit HTTP API (docker compose). Override with MAILPIT_URL. */
const mailpit = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

interface MailpitSearch {
  messages: Array<{ ID: string }>;
}
interface MailpitMessage {
  Text: string;
}

/** The verify-email link of the newest Mailpit message addressed to `email`. */
async function verificationLink(email: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const query = encodeURIComponent(`to:${email}`);
    const search = (await (
      await fetch(`${mailpit}/api/v1/search?query=${query}`)
    ).json()) as MailpitSearch;
    const newest = search.messages[0];
    if (newest) {
      const message = (await (
        await fetch(`${mailpit}/api/v1/message/${newest.ID}`)
      ).json()) as MailpitMessage;
      const match = /https?:\/\/\S+\/verify-email\?\S+/.exec(message.Text);
      if (match) return match[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no verification mail for ${email}`);
}

/**
 * Sign-up (ADR-0024): the form takes the email only, the link in the mail signs the user in
 * and lands on /set-password, where the first password is chosen — together with the real
 * name and mobile number (ADR-0043), so the account never meets the onboarding gate.
 */
async function signUp(page: Page, email: string) {
  await page.goto('/signup');
  await page.getByLabel(copy.email).fill(email);
  await page.getByRole('button', { name: copy.signupWithEmail }).click();
  await expect(page.getByTestId('signup-check-mail')).toBeVisible();

  await page.goto(await verificationLink(email));
  await expect(page).toHaveURL('/set-password');
  await page.getByTestId('new-password').fill(password);
  await page.getByTestId('new-password-confirm').fill(password);
  // ADR-0043: the same step takes the real name and mobile number (helpers.ts E2E_CONTACT).
  await page.getByTestId('contact-real-name').fill('테스트회원');
  await page.getByTestId('contact-phone').fill('010-1234-5678');
  await page.getByRole('button', { name: copy.setPasswordSubmit }).click();
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
    // Nav shows the balance chip once `GET /me` resolves: the sign-up bonus (the `user` insert
    // trigger). Not '0 Coin' — "10,000 Coin" contains that too, so such a check could never fail.
    await expect(page.getByTestId('balance-chip')).toContainText('10,000 Coin');

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

    // --- /me rendered: email, auto-generated nickname (user_XXXX), credential linked
    await expect(page.getByTestId('account-email')).toContainText(email);
    await expect(page.getByTestId('nickname-input')).toHaveValue(/^user_/);
    await expect(page.getByTestId('unlink-credential')).toBeDisabled();
  });

  test('duplicate nickname -> field error (AC 4)', async ({ page }) => {
    // Two accounts; the second one tries to take the first one's nickname.
    await signUp(page, freshEmail());
    await page.goto('/settings');
    // Wait for the seeded value: the input exists before `GET /me` resolves.
    await expect(page.getByTestId('nickname-input')).toHaveValue(/^user_/);
    const taken = await page.getByTestId('nickname-input').inputValue();
    await logOut(page);

    await signUp(page, freshEmail());
    await page.goto('/settings');
    await expect(page.getByTestId('nickname-input')).toHaveValue(/^user_/);
    await page.getByTestId('nickname-input').fill(taken);
    // Scoped: the contact card has its own '저장' button.
    await page.getByTestId('settings-profile').getByRole('button', { name: copy.save }).click();
    await expect(page.getByText(copy.errNicknameTaken)).toBeVisible();
  });

  test('logged-in visitor is redirected away from /login', async ({ page }) => {
    await signUp(page, freshEmail());
    await page.goto('/login');
    await expect(page).toHaveURL('/');
  });
});
