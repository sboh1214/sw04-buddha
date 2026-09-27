import { copy } from '../src/copy';
import { E2E_CONTACT, E2E_PASSWORD, expect, freshEmail, openSetPassword, test } from './helpers';

/**
 * 실명·휴대전화 수집과 온보딩 게이트 (ADR-0043, DESIGN §6.3).
 *
 * An account without a contact cannot be made from here through a social provider, and no
 * route clears one — but the email sign-up passes through exactly that state: the verification
 * link signs the account in on /set-password before it has given anything. Leaving that page
 * for another one is what a social sign-up or an account older than the requirement does after
 * signing in, so the gate is exercised on a real account with no database access.
 *
 * Messages are matched `exact`: the onboarding subtitle contains "휴대전화 번호를 입력해 주세요."
 * as a phrase, and a substring match would find the field error in it.
 */
test.describe('실명·연락처 (ADR-0043)', () => {
  test('이메일 가입: 비밀번호 설정 단계가 실명·휴대전화를 요구하고, 설정 화면에서 바꿀 수 있다', async ({
    page,
  }) => {
    await openSetPassword(page, freshEmail());
    await page.getByTestId('new-password').fill(E2E_PASSWORD);
    await page.getByTestId('new-password-confirm').fill(E2E_PASSWORD);

    // Both fields are required, and nothing is sent without them — not even the password,
    // which would otherwise swap this form for "비밀번호가 이미 설정되어 있습니다".
    await page.getByRole('button', { name: copy.setPasswordSubmit }).click();
    await expect(page.getByText(copy.errRealNameRequired, { exact: true })).toBeVisible();
    await expect(page.getByText(copy.errPhoneRequired, { exact: true })).toBeVisible();
    await expect(page).toHaveURL('/set-password');

    // The shared phoneSchema's rule: a landline is refused before the request.
    await page.getByTestId('contact-real-name').fill(E2E_CONTACT.realName);
    await page.getByTestId('contact-phone').fill('02-123-4567');
    await page.getByRole('button', { name: copy.setPasswordSubmit }).click();
    await expect(page.getByText(copy.errPhoneFormat, { exact: true })).toBeVisible();
    await expect(page).toHaveURL('/set-password');

    await page.getByTestId('contact-phone').fill(E2E_CONTACT.phone);
    await page.getByRole('button', { name: copy.setPasswordSubmit }).click();
    await expect(page).toHaveURL('/');

    // /settings shows what was saved — the number as digits on the wire, hyphenated here.
    await page.goto('/settings');
    const card = page.getByTestId('settings-contact');
    await expect(card.getByTestId('contact-real-name')).toHaveValue(E2E_CONTACT.realName);
    await expect(card.getByTestId('contact-phone')).toHaveValue('010-1234-5678');
    await expect(card.getByTestId('contact-save')).toBeDisabled();

    await card.getByTestId('contact-phone').fill('010 9876 5432');
    await card.getByTestId('contact-save').click();
    await expect(page.getByText(copy.contactSaved)).toBeVisible();
    await expect(card.getByTestId('contact-phone')).toHaveValue('010-9876-5432');

    await page.reload();
    await expect(page.getByTestId('settings-contact').getByTestId('contact-phone')).toHaveValue(
      '010-9876-5432',
    );
  });

  test('연락처가 없는 계정은 /onboarding으로 보내지고, 저장하면 가려던 화면으로 돌아간다', async ({
    page,
  }) => {
    // Signed in, no password, no contact.
    await openSetPassword(page, freshEmail());

    // Exempt: the legal documents stay readable. The balance chip means `GET /me` has answered,
    // and the gate decides in the same render — so its placeholder would be up by now.
    await page.goto('/terms');
    await expect(page.getByTestId('balance-chip')).toBeVisible();
    await expect(page.getByTestId('onboarding-gate')).toHaveCount(0);
    await expect(page).toHaveURL('/terms');

    // Gated: any other page sends the account to /onboarding, carrying where it was going.
    await page.goto('/wallet');
    await expect(page).toHaveURL('/onboarding?next=%2Fwallet');
    await expect(page.getByTestId('onboarding-form')).toBeVisible();

    // Required, and checked with the API's own rules before anything is sent.
    await page.getByTestId('onboarding-submit').click();
    await expect(page.getByText(copy.errRealNameRequired, { exact: true })).toBeVisible();
    await expect(page.getByText(copy.errPhoneRequired, { exact: true })).toBeVisible();
    await page.getByTestId('contact-real-name').fill('홍길동1');
    await page.getByTestId('contact-phone').fill(E2E_CONTACT.phone);
    await page.getByTestId('onboarding-submit').click();
    await expect(page.getByText(copy.errRealNameFormat, { exact: true })).toBeVisible();
    await expect(page).toHaveURL('/onboarding?next=%2Fwallet');

    // Saved → back to the page the gate sent it away from.
    await page.getByTestId('contact-real-name').fill(E2E_CONTACT.realName);
    await page.getByTestId('onboarding-submit').click();
    await expect(page).toHaveURL('/wallet');
    await expect(page.getByText(copy.contactSaved)).toBeVisible();

    // The gate is satisfied now: other pages open as usual.
    await page.goto('/');
    await expect(page.getByTestId('balance-chip')).toBeVisible();
    await expect(page.getByTestId('onboarding-gate')).toHaveCount(0);
    await expect(page).toHaveURL('/');

    // /onboarding sends an account that has a contact straight on — to a path on this origin
    // only; anything else is home.
    await page.goto('/onboarding?next=%2Fsettings');
    await expect(page).toHaveURL('/settings');
    await page.goto(`/onboarding?next=${encodeURIComponent('https://evil.example/')}`);
    await expect(page).toHaveURL('/');
    await page.goto(`/onboarding?next=${encodeURIComponent('//evil.example')}`);
    await expect(page).toHaveURL('/');

    // /set-password asks only for the password of an account that already gave its contact.
    await page.goto('/set-password');
    await expect(page.getByTestId('new-password')).toBeVisible();
    await expect(page.getByTestId('set-password-contact')).toHaveCount(0);
    await page.getByTestId('new-password').fill(E2E_PASSWORD);
    await page.getByTestId('new-password-confirm').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: copy.setPasswordSubmit }).click();
    await expect(page).toHaveURL('/');
  });

  test('로그인하지 않은 방문자의 /onboarding은 로그인 화면으로, next를 그대로 싣고 간다', async ({
    page,
  }) => {
    await page.goto('/onboarding?next=%2Fwallet');
    // Compared decoded: how much of a server redirect's query string stays percent-encoded is
    // the framework's business (auth.spec.ts accepts both spellings for the same reason).
    await page.waitForURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('next')).toBe('/onboarding?next=%2Fwallet');
  });
});
