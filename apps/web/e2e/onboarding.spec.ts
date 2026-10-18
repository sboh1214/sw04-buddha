import { copy } from '../src/copy';
import {
  E2E_PASSWORD,
  E2E_REAL_NAME,
  expect,
  freshEmail,
  freshPhone,
  openSetPassword,
  test,
  verifyPhone,
} from './helpers';

/**
 * 본인확인과 온보딩 게이트 (ADR-0043, ADR-0070).
 *
 * An account that has not verified cannot be made from here through a social provider, and no
 * route clears a verification — but the email sign-up passes through exactly that state: the
 * verification link signs the account in on /set-password before it has verified anything.
 * Leaving that page for another one is what a social sign-up or an account older than the
 * requirement does after signing in, so the gate is exercised on a real account with no database
 * access. The codes come from the API's development SMS sender, which mails them to Mailpit
 * (helpers.ts `smsCode`); phone-verification.spec.ts covers the step's refusals.
 *
 * Messages are matched `exact`: the onboarding subtitle contains "휴대전화 번호를 입력하고" as a
 * phrase, and a substring match could find a field error in it.
 */
test.describe('본인확인과 온보딩 게이트 (ADR-0070)', () => {
  test('이메일 가입: 비밀번호만 정하면 본인확인 단계로 가고, 설정에서 실명은 고치고 번호는 읽기만 한다', async ({
    page,
  }) => {
    await openSetPassword(page, freshEmail());
    // No real name or number here any more: the 본인확인 step is the one place they are given.
    await expect(page.getByTestId('new-password')).toBeVisible();
    await expect(page.getByTestId('verification-real-name')).toHaveCount(0);
    await expect(page.getByTestId('verification-phone')).toHaveCount(0);
    await page.getByTestId('new-password').fill(E2E_PASSWORD);
    await page.getByTestId('new-password-confirm').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: copy.setPasswordSubmit }).click();

    // Home, and the gate takes the account that has not verified on to the step.
    await expect(page).toHaveURL('/onboarding');
    const phone = freshPhone();
    await verifyPhone(page, phone);
    await expect(page).toHaveURL('/');
    await expect(page.getByText(copy.verificationDone)).toBeVisible();

    // /my/settings shows the record: the number read-only and hyphenated, the name editable.
    await page.goto('/my/settings');
    const card = page.getByTestId('settings-verification');
    const formatted = `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;
    await expect(card.getByTestId('verification-real-name')).toHaveValue(E2E_REAL_NAME);
    await expect(card.getByTestId('verification-phone')).toHaveValue(formatted);
    await expect(card.getByTestId('verification-phone')).not.toBeEditable();
    await expect(card.getByText(copy.verifiedPhoneHint)).toBeVisible();
    await expect(card.getByTestId('verification-real-name-save')).toBeDisabled();

    // The real name keeps the shared rule, and saves trimmed.
    await card.getByTestId('verification-real-name').fill('홍길동1');
    await card.getByTestId('verification-real-name-save').click();
    await expect(card.getByText(copy.errRealNameFormat, { exact: true })).toBeVisible();
    await card.getByTestId('verification-real-name').fill(' 김 철수 ');
    await card.getByTestId('verification-real-name-save').click();
    await expect(page.getByText(copy.realNameSaved)).toBeVisible();
    await expect(card.getByTestId('verification-real-name')).toHaveValue('김 철수');

    await page.reload();
    const reloaded = page.getByTestId('settings-verification');
    await expect(reloaded.getByTestId('verification-real-name')).toHaveValue('김 철수');
    await expect(reloaded.getByTestId('verification-phone')).toHaveValue(formatted);
  });

  test('본인확인하지 않은 계정은 /onboarding으로 보내지고, 마치면 가려던 화면으로 돌아간다', async ({
    page,
  }) => {
    // Signed in, no password, not verified.
    await openSetPassword(page, freshEmail());

    // Exempt: the legal documents stay readable. The balance chip means `GET /me` has answered,
    // and the gate decides in the same render — so its placeholder would be up by now.
    await page.goto('/terms');
    await expect(page.getByTestId('balance-chip')).toBeVisible();
    await expect(page.getByTestId('onboarding-gate')).toHaveCount(0);
    await expect(page).toHaveURL('/terms');

    // Gated: any other page sends the account to /onboarding, carrying where it was going.
    await page.goto('/my/wallet');
    await expect(page).toHaveURL('/onboarding?next=%2Fmy%2Fwallet');
    await expect(page.getByTestId('verification-step')).toBeVisible();

    // Required, and checked with the API's own rules before anything is sent.
    await page.getByTestId('verification-send').click();
    await expect(page.getByText(copy.errRealNameRequired, { exact: true })).toBeVisible();
    await expect(page.getByText(copy.errPhoneRequired, { exact: true })).toBeVisible();
    await page.getByTestId('verification-real-name').fill('홍길동1');
    await page.getByTestId('verification-phone').fill('02-123-4567');
    await page.getByTestId('verification-send').click();
    await expect(page.getByText(copy.errRealNameFormat, { exact: true })).toBeVisible();
    await expect(page.getByText(copy.errPhoneFormat, { exact: true })).toBeVisible();
    await expect(page.getByTestId('verification-code')).toHaveCount(0);
    await expect(page).toHaveURL('/onboarding?next=%2Fmy%2Fwallet');

    // Verified → back to the page the gate sent it away from.
    await verifyPhone(page);
    await expect(page).toHaveURL('/my/wallet');
    await expect(page.getByText(copy.verificationDone)).toBeVisible();

    // The gate is satisfied now: other pages open as usual.
    await page.goto('/');
    await expect(page.getByTestId('balance-chip')).toBeVisible();
    await expect(page.getByTestId('onboarding-gate')).toHaveCount(0);
    await expect(page).toHaveURL('/');

    // /onboarding sends a verified account straight on — to a path on this origin only;
    // anything else is home.
    await page.goto('/onboarding?next=%2Fmy%2Fsettings');
    await expect(page).toHaveURL('/my/settings');
    await page.goto(`/onboarding?next=${encodeURIComponent('https://evil.example/')}`);
    await expect(page).toHaveURL('/');
    await page.goto(`/onboarding?next=${encodeURIComponent('//evil.example')}`);
    await expect(page).toHaveURL('/');

    // /set-password still sets the first password of an account that has none, and goes home.
    await page.goto('/set-password');
    await page.getByTestId('new-password').fill(E2E_PASSWORD);
    await page.getByTestId('new-password-confirm').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: copy.setPasswordSubmit }).click();
    await expect(page).toHaveURL('/');
  });

  test('게이트에 묶인 계정은 /set-password와 /onboarding에서 로그아웃할 수 있다', async ({
    page,
  }) => {
    // 로그아웃 is in MY, which the gate keeps such an account out of, and the header has no
    // profile menu (owner decision 2026-10-13, #16). Both land where MY's 로그아웃 does.
    await openSetPassword(page, freshEmail());
    await page.getByTestId('set-password-logout').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('link', { name: copy.login })).toBeVisible();
    await page.goto('/set-password');
    await page.waitForURL(/\/login\?/);

    await openSetPassword(page, freshEmail());
    await page.goto('/my');
    await expect(page).toHaveURL('/onboarding?next=%2Fmy');
    await expect(page.getByTestId('verification-step')).toBeVisible();
    await page.getByTestId('onboarding-logout').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('link', { name: copy.login })).toBeVisible();
    await page.goto('/onboarding');
    await page.waitForURL(/\/login\?/);
  });

  test('프로필을 불러오지 못한 /onboarding에도 로그아웃이 있다', async ({ page }) => {
    await openSetPassword(page, freshEmail());
    // `GET /me` failing is the rung with no form; the gate cannot say "not verified" either, so
    // the screen is opened directly.
    await page.route('**/api/v1/me', (route) => route.abort());
    await page.goto('/onboarding');
    await expect(page.getByTestId('onboarding-unavailable')).toBeVisible();
    await page.getByTestId('onboarding-logout').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('link', { name: copy.login })).toBeVisible();
  });

  test('로그인하지 않은 방문자의 /onboarding은 로그인 화면으로, next를 그대로 싣고 간다', async ({
    page,
  }) => {
    await page.goto('/onboarding?next=%2Fmy%2Fwallet');
    // Compared decoded: how much of a server redirect's query string stays percent-encoded is
    // the framework's business (auth.spec.ts accepts both spellings for the same reason).
    await page.waitForURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('next')).toBe('/onboarding?next=%2Fmy%2Fwallet');
  });
});
