import type { Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  E2E_REAL_NAME,
  expect,
  freshEmail,
  freshPhone,
  logOut,
  openSetPassword,
  signUp,
  smsCode,
  smsMessageIds,
  test,
} from './helpers';

/**
 * 본인확인 (#183, ADR-0070): the step's refusals as a member meets them — a wrong code with the
 * entries it has left, the fifth wrong entry that discards the code, the resend wait, and a
 * number another account has verified (one account per number, ADR-0069 decision 1 #57-1) —
 * and a code the screen did not send (a reload, another tab, a lost answer), which can still be
 * entered. The happy path and the gate are onboarding.spec.ts's.
 *
 * Every account and number is fresh, so the per-account and per-number limits never meet another
 * test's sends. The codes come from the API's development SMS sender through Mailpit.
 */

/** Opens the step for a fresh signed-in account that has not verified, and sends a code. */
async function sendCode(page: Page, phone: string): Promise<string> {
  await openSetPassword(page, freshEmail());
  await page.goto('/onboarding');
  const seen = await smsMessageIds(phone);
  await page.getByTestId('verification-real-name').fill(E2E_REAL_NAME);
  await page.getByTestId('verification-phone').fill(phone);
  await page.getByTestId('verification-send').click();
  await expect(page.getByTestId('verification-code')).toBeVisible();
  await expect(page.getByTestId('verification-notice')).toHaveText(copy.verificationCodeSent);
  return smsCode(phone, seen);
}

/** Six digits that are not `code`. */
function wrongCode(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

/** The message under the code input after a wrong entry that leaves `remaining` entries. */
function mismatch(remaining: number): string {
  return `${copy.errVerificationCodeMismatch} (${copy.verificationAttemptsLeft} ${String(
    remaining,
  )}${copy.verificationAttemptsUnit})`;
}

test.describe('본인확인 인증번호 (#183)', () => {
  test('틀린 인증번호는 남은 입력 기회를 알리고, 맞는 인증번호로 본인확인을 마친다', async ({
    page,
  }) => {
    const code = await sendCode(page, freshPhone());
    // The name and the number the code was sent with are locked; the code's three minutes count
    // down under it.
    await expect(page.getByTestId('verification-phone')).not.toBeEditable();
    await expect(page.getByTestId('verification-real-name')).not.toBeEditable();
    await expect(page.getByTestId('verification-code-expiry')).toContainText(
      copy.verificationExpiresIn,
    );

    await page.getByTestId('verification-code').fill('12345');
    await page.getByTestId('verification-confirm').click();
    await expect(page.getByText(copy.errVerificationCodeFormat, { exact: true })).toBeVisible();

    await page.getByTestId('verification-code').fill(wrongCode(code));
    await page.getByTestId('verification-confirm').click();
    await expect(page.getByText(mismatch(4), { exact: true })).toBeVisible();
    await expect(page).toHaveURL('/onboarding');

    await page.getByTestId('verification-code').fill(code);
    await page.getByTestId('verification-confirm').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByText(copy.verificationDone)).toBeVisible();
  });

  test('다섯 번 틀리면 그 인증번호는 버려지고 새로 받아야 한다', async ({ page }) => {
    const code = await sendCode(page, freshPhone());
    for (const remaining of [4, 3, 2, 1]) {
      await page.getByTestId('verification-code').fill(wrongCode(code));
      await page.getByTestId('verification-confirm').click();
      await expect(page.getByText(mismatch(remaining), { exact: true })).toBeVisible();
    }
    await page.getByTestId('verification-code').fill(wrongCode(code));
    await page.getByTestId('verification-confirm').click();

    // Discarded: back to the send button, the right code no longer accepted by anything here.
    await expect(page.getByTestId('verification-notice')).toHaveText(
      copy.errVerificationCodeAttemptsExceeded,
    );
    await expect(page.getByTestId('verification-code')).toHaveCount(0);
    await expect(page.getByTestId('verification-phone')).toBeEditable();
    // The cursor left with the code input: it waits on the number, not on the page.
    await expect(page.getByTestId('verification-phone')).toBeFocused();
    // The server agrees: even the right code verifies nothing now.
    const me = (await (await page.request.get('/api/v1/me')).json()) as { data: { id: string } };
    const late = await page.request.post('/api/v1/me/phone-verification/confirm', {
      data: { code, expectedAccountId: me.data.id },
    });
    expect(late.status()).toBe(409);
    expect(((await late.json()) as { error: { details: unknown } }).error.details).toEqual({
      reason: 'attempts_exceeded',
    });
  });

  test('인증번호는 1분이 지나야 다시 받을 수 있다', async ({ page }) => {
    const phone = freshPhone();
    await sendCode(page, phone);

    // 다시 받기 waits out the minute, counting down on the button.
    const send = page.getByTestId('verification-send');
    await expect(send).toBeDisabled();
    await expect(send).toContainText(`${copy.verificationResend} (0:`);

    // 실명·번호 다시 입력 opens the name and the number again; the wait stays on the send button.
    await expect(page.getByTestId('verification-edit')).toHaveText(copy.verificationEdit);
    await page.getByTestId('verification-edit').click();
    await expect(page.getByTestId('verification-code')).toHaveCount(0);
    await expect(page.getByTestId('verification-phone')).toBeEditable();
    await expect(page.getByTestId('verification-real-name')).toBeEditable();
    await expect(send).toBeDisabled();
    await expect(send).toContainText(`${copy.verificationSend} (0:`);

    // The server holds the minute whatever the screen does.
    const me = (await (await page.request.get('/api/v1/me')).json()) as { data: { id: string } };
    const again = await page.request.post('/api/v1/me/phone-verification/code', {
      data: { realName: E2E_REAL_NAME, phone, expectedAccountId: me.data.id },
    });
    expect(again.status()).toBe(429);
    const { error } = (await again.json()) as {
      error: { code: string; details: { reason: string; retryAfterSeconds: number } };
    };
    expect(error.code).toBe('PHONE_VERIFICATION_LIMITED');
    expect(error.details.reason).toBe('resend_interval');
    expect(error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  test('다른 계정이 본인확인한 번호로는 본인확인할 수 없다', async ({ page }) => {
    // Account A verifies a number.
    const phone = await signUp(page, freshEmail());
    await logOut(page);

    // Account B receives a code at the same number — it holds the phone — and is refused only
    // once the code matched, so nobody else learns whose number it is.
    const code = await sendCode(page, phone);
    await page.getByTestId('verification-code').fill(code);
    await page.getByTestId('verification-confirm').click();

    // Said in the alert, which is read out, and under the number, which takes the cursor.
    await expect(page.getByTestId('verification-notice')).toHaveText(copy.errPhoneInUse);
    await expect(page.getByTestId('verification-notice')).toHaveAttribute('role', 'alert');
    await expect(
      page.getByTestId('verification-details-form').getByText(copy.errPhoneInUse, { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('verification-code')).toHaveCount(0);
    await expect(page.getByTestId('verification-phone')).toBeEditable();
    await expect(page.getByTestId('verification-phone')).toBeFocused();
    await expect(page).toHaveURL('/onboarding');
    // Still held by the gate: B has not verified.
    await page.goto('/my');
    await expect(page).toHaveURL('/onboarding?next=%2Fmy');
  });

  test('새로 고침 뒤에도 이미 받은 인증번호를 입력할 수 있다', async ({ page }) => {
    const phone = freshPhone();
    const code = await sendCode(page, phone);

    // The screen forgets the code it sent; the server still holds it for the account.
    await page.reload();
    await expect(page.getByTestId('verification-code')).toHaveCount(0);
    await page.getByTestId('verification-enter-code').click();
    await expect(page.getByTestId('verification-code')).toBeFocused();
    // No countdown for a code this screen did not send, and the name and number stay open.
    await expect(page.getByTestId('verification-code-expiry')).toHaveCount(0);
    await expect(page.getByTestId('verification-phone')).toBeEditable();

    await page.getByTestId('verification-code').fill(code);
    await page.getByTestId('verification-confirm').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByText(copy.verificationDone)).toBeVisible();
  });

  test('1분 안에 다른 화면에서 보낸 인증번호가 있으면 다시 받기 대신 그 입력 칸을 연다', async ({
    page,
  }) => {
    const phone = freshPhone();
    await openSetPassword(page, freshEmail());
    await page.goto('/onboarding');
    await expect(page.getByTestId('verification-step')).toBeVisible();

    // Another tab of the account (or a send whose answer this screen never got) texts a code.
    const seen = await smsMessageIds(phone);
    const me = (await (await page.request.get('/api/v1/me')).json()) as { data: { id: string } };
    const sent = await page.request.post('/api/v1/me/phone-verification/code', {
      data: { realName: E2E_REAL_NAME, phone, expectedAccountId: me.data.id },
    });
    expect(sent.status()).toBe(200);
    const code = await smsCode(phone, seen);

    // This screen asks for a code too: refused for the minute, it opens the input for that code.
    await page.getByTestId('verification-real-name').fill(E2E_REAL_NAME);
    await page.getByTestId('verification-phone').fill(phone);
    await page.getByTestId('verification-send').click();
    await expect(page.getByTestId('verification-code')).toBeVisible();
    await expect(page.getByTestId('verification-notice')).toContainText(
      copy.verificationCodeWaiting,
    );
    await expect(page.getByTestId('verification-send')).toBeDisabled();

    await page.getByTestId('verification-code').fill(code);
    await page.getByTestId('verification-confirm').click();
    await expect(page).toHaveURL('/');
  });
});
