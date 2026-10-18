import type { Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  E2E_REAL_NAME,
  expect,
  expectCodeInput,
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
 * entries it has left, the fifth wrong entry that discards the code, the resend wait, an older
 * code typed after a resend, and a number another account has verified (one account per number,
 * ADR-0069 decision 1 #57-1) — a code the screen did not send (a reload, another tab), which can
 * still be entered, and a send whose answer was lost — the provider's (SMS_SEND_UNCONFIRMED) or
 * the API's own on its way to the browser (a dropped connection, a gateway's 5xx, a timeout) —
 * which may have texted the code and says so, as a warning, while its code is tried (owner
 * decisions 2026-10-18). The happy path and the gate are onboarding.spec.ts's.
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
  await expectCodeInput(page);
  await expect(page.getByTestId('verification-notice')).toHaveText(copy.verificationCodeSent);
  return smsCode(phone, seen);
}

/** The resend wait, with room for the screen's countdown to reach 0 and enable the button. */
const RESEND_WAIT_MS = 75_000;

/** The background the step's notice is drawn with: information and a warning differ. */
function noticeBackground(page: Page): Promise<string> {
  return page
    .getByTestId('verification-notice')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
}

/**
 * The colour a Chakra colour token (`yellow.subtle`) paints as a background on this page, in
 * its colour mode: read off a probe inside the notice, so it resolves as the notice's own would.
 */
function tokenBackground(page: Page, token: string): Promise<string> {
  return page.getByTestId('verification-notice').evaluate((element, name) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = `var(--chakra-colors-${name.replace('.', '-')})`;
    element.append(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  }, token);
}

/**
 * The warning is drawn yellow, as the owner answered (second round: 주의(노란) 모양): the yellow
 * palette's subtle background, not the orange Chakra gives the `warning` status by itself.
 */
async function expectYellowNotice(page: Page): Promise<void> {
  const yellow = await tokenBackground(page, 'yellow.subtle');
  const orange = await tokenBackground(page, 'orange.subtle');
  // Both tokens resolve to a colour (an unknown variable paints nothing) and they differ.
  expect(yellow).not.toBe('rgba(0, 0, 0, 0)');
  expect(yellow).not.toBe(orange);
  expect(await noticeBackground(page)).toBe(yellow);
}

/**
 * The step after a code request whose answer was lost, however it was lost (owner decisions
 * 2026-10-18): the warning that the text may have come, read out as an alert, the code input
 * open and focused, the name and the number locked, 다시 받기 waiting out the minute, and no
 * validity countdown (no answer said how long the code holds).
 */
async function expectMaybeSent(page: Page): Promise<void> {
  const notice = page.getByTestId('verification-notice');
  await expect(notice).toHaveText(copy.verificationMaybeSent);
  // A warning (second round: 주의(노란) 모양), read out although no error: the cursor moves with it.
  await expect(notice).toHaveAttribute('data-status', 'warning');
  await expect(notice).toHaveAttribute('role', 'alert');
  await expectYellowNotice(page);
  await expect(notice).not.toContainText(copy.errVerificationSendFailed);
  await expect(page.getByTestId('verification-code')).toBeFocused();
  await expect(page.getByTestId('verification-phone')).not.toBeEditable();
  await expect(page.getByTestId('verification-real-name')).not.toBeEditable();
  await expect(page.getByTestId('verification-send')).toBeDisabled();
  await expect(page.getByTestId('verification-send')).toContainText(`${copy.verificationResend} (`);
  await expect(page.getByTestId('verification-code-expiry')).toHaveCount(0);
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
    // Read out although the cursor moves into the code input with it.
    await expect(page.getByTestId('verification-notice')).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('verification-notice')).toContainText(
      copy.verificationCodeWaiting,
    );
    await expect(page.getByTestId('verification-send')).toBeDisabled();

    await page.getByTestId('verification-code').fill(code);
    await page.getByTestId('verification-confirm').click();
    await expect(page).toHaveURL('/');
  });

  test('다시 받은 뒤 예전 인증번호를 넣으면 틀린 입력으로 세지 않고 새 인증번호를 묻는다', async ({
    page,
  }) => {
    test.slow(); // the resend interval is a real minute
    const phone = freshPhone();
    const older = await sendCode(page, phone);

    // A minute later, 다시 받기 sends a new code to the same number.
    const send = page.getByTestId('verification-send');
    await expect(send).toBeEnabled({ timeout: RESEND_WAIT_MS });
    const seen = await smsMessageIds(phone);
    await send.click();
    // Answered: the minute counts down again (the input is cleared for the new code by then).
    await expect(send).toContainText(`${copy.verificationResend} (0:`);
    await expect(page.getByTestId('verification-notice')).toHaveText(copy.verificationCodeSent);
    const newest = await smsCode(phone, seen);
    test.skip(older === newest, 'the two draws were the same code (one in a million)');

    // The first text, typed now: asked for the new code under the input, no entry spent.
    await page.getByTestId('verification-code').fill(older);
    await page.getByTestId('verification-confirm').click();
    await expect(page.getByText(copy.errVerificationCodeSuperseded, { exact: true })).toBeVisible();
    await expect(page.getByTestId('verification-code')).toBeVisible();
    // A real wrong entry after it is the first counted: four left.
    const other = ['000000', '000001', '000002'].find((code) => code !== older && code !== newest)!;
    await page.getByTestId('verification-code').fill(other);
    await page.getByTestId('verification-confirm').click();
    await expect(page.getByText(mismatch(4), { exact: true })).toBeVisible();

    await page.getByTestId('verification-code').fill(newest);
    await page.getByTestId('verification-confirm').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByText(copy.verificationDone)).toBeVisible();
  });

  test('발송 결과를 알 수 없으면 문자가 갔을 수 있다고 알리고 그 인증번호를 받는다', async ({
    page,
  }) => {
    const phone = freshPhone();
    await openSetPassword(page, freshEmail());
    await page.goto('/onboarding');
    await expect(page.getByTestId('verification-step')).toBeVisible();

    // The API sends the code (the development sender mails it to Mailpit), and the answer the
    // screen gets is the one a lost provider answer makes: 502 SMS_SEND_UNCONFIRMED.
    let realStatus = 0;
    await page.route('**/api/v1/me/phone-verification/code', async (route) => {
      realStatus = (await route.fetch()).status();
      await route.fulfill({
        status: 502,
        json: { error: { code: 'SMS_SEND_UNCONFIRMED', message: 'Internal server error' } },
      });
    });
    const seen = await smsMessageIds(phone);
    await page.getByTestId('verification-real-name').fill(E2E_REAL_NAME);
    await page.getByTestId('verification-phone').fill(phone);
    await page.getByTestId('verification-send').click();

    // Not "could not send": the text may have come. The input is open for its code, the name and
    // the number it went to are locked, and 다시 받기 waits out the minute.
    await expectMaybeSent(page);
    expect(realStatus).toBe(200);
    await page.unroute('**/api/v1/me/phone-verification/code');

    // The text did come: its code verifies the account.
    await page.getByTestId('verification-code').fill(await smsCode(phone, seen));
    await page.getByTestId('verification-confirm').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByText(copy.verificationDone)).toBeVisible();
  });

  test('다시 받기의 결과를 알 수 없을 때 예전 인증번호를 넣어도 문자가 갔을 수 있다는 안내가 남는다', async ({
    page,
  }) => {
    test.slow(); // the resend interval is a real minute
    const phone = freshPhone();
    const older = await sendCode(page, phone);
    // The sent code's notice is information (blue); the lost answer's below is a warning, drawn
    // apart, in yellow.
    await expect(page.getByTestId('verification-notice')).toHaveAttribute('data-status', 'info');
    const sentBackground = await noticeBackground(page);
    expect(sentBackground).toBe(await tokenBackground(page, 'blue.subtle'));

    // A minute later, 다시 받기: the API sends a new code (kept as the newest), and the answer the
    // screen gets is the one a lost provider answer makes: 502 SMS_SEND_UNCONFIRMED.
    const send = page.getByTestId('verification-send');
    await expect(send).toBeEnabled({ timeout: RESEND_WAIT_MS });
    let realStatus = 0;
    await page.route('**/api/v1/me/phone-verification/code', async (route) => {
      realStatus = (await route.fetch()).status();
      await route.fulfill({
        status: 502,
        json: { error: { code: 'SMS_SEND_UNCONFIRMED', message: 'Internal server error' } },
      });
    });
    const seen = await smsMessageIds(phone);
    await send.click();
    const notice = page.getByTestId('verification-notice');
    await expect(notice).toHaveText(copy.verificationMaybeSent);
    await expect(notice).toHaveAttribute('data-status', 'warning');
    expect(await noticeBackground(page)).not.toBe(sentBackground);
    await expectYellowNotice(page);
    expect(realStatus).toBe(200);
    await page.unroute('**/api/v1/me/phone-verification/code');
    const newest = await smsCode(phone, seen);
    test.skip(older === newest, 'the two draws were the same code (one in a million)');

    // The new text "never came", so the member types the first one: refused under the input as
    // an older code — and the line that says to ask again later if nothing came stays.
    await page.getByTestId('verification-code').fill(older);
    await page.getByTestId('verification-confirm').click();
    await expect(page.getByText(copy.errVerificationCodeSuperseded, { exact: true })).toBeVisible();
    await expect(notice).toHaveText(copy.verificationMaybeSent);
    // A wrong code keeps it too (the first counted entry: four left).
    const other = ['000000', '000001', '000002'].find((code) => code !== older && code !== newest)!;
    await page.getByTestId('verification-code').fill(other);
    await page.getByTestId('verification-confirm').click();
    await expect(page.getByText(mismatch(4), { exact: true })).toBeVisible();
    await expect(notice).toHaveText(copy.verificationMaybeSent);

    await page.getByTestId('verification-code').fill(newest);
    await page.getByTestId('verification-confirm').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByText(copy.verificationDone)).toBeVisible();
  });

  test('API의 답이 브라우저에 오지 않으면(연결 끊김·시간 초과) 문자가 갔을 수 있다고 알리고 그 인증번호를 받는다', async ({
    page,
  }) => {
    const phone = freshPhone();
    await openSetPassword(page, freshEmail());
    await page.goto('/onboarding');
    await expect(page.getByTestId('verification-step')).toBeVisible();

    // The API sends the code, and its answer never reaches the browser: the request fails at the
    // network level, as a dropped connection or a timeout on the way back does.
    let realStatus = 0;
    await page.route('**/api/v1/me/phone-verification/code', async (route) => {
      realStatus = (await route.fetch()).status();
      await route.abort('timedout');
    });
    const seen = await smsMessageIds(phone);
    await page.getByTestId('verification-real-name').fill(E2E_REAL_NAME);
    await page.getByTestId('verification-phone').fill(phone);
    await page.getByTestId('verification-send').click();

    // Not "a problem occurred": whether the text went is not known, so it is said as for a lost
    // provider answer (owner decision 2026-10-18, second round).
    await expectMaybeSent(page);
    expect(realStatus).toBe(200);
    await expect(page.getByTestId('verification-notice')).not.toContainText(copy.errUnknown);
    await page.unroute('**/api/v1/me/phone-verification/code');

    // The text did come: its code verifies the account.
    await page.getByTestId('verification-code').fill(await smsCode(phone, seen));
    await page.getByTestId('verification-confirm').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByText(copy.verificationDone)).toBeVisible();
  });

  test('앞단 게이트웨이가 API 대신 5xx로 답해도 문자가 갔을 수 있다고 알린다', async ({ page }) => {
    const phone = freshPhone();
    await openSetPassword(page, freshEmail());
    await page.goto('/onboarding');
    await expect(page.getByTestId('verification-step')).toBeVisible();

    // The API sends the code, and a gateway in front of it answers for it — a 502 page, not the
    // API's error envelope.
    let realStatus = 0;
    await page.route('**/api/v1/me/phone-verification/code', async (route) => {
      realStatus = (await route.fetch()).status();
      await route.fulfill({
        status: 502,
        contentType: 'text/html',
        body: '<html><body><h1>502 Bad Gateway</h1></body></html>',
      });
    });
    const seen = await smsMessageIds(phone);
    await page.getByTestId('verification-real-name').fill(E2E_REAL_NAME);
    await page.getByTestId('verification-phone').fill(phone);
    await page.getByTestId('verification-send').click();

    await expectMaybeSent(page);
    expect(realStatus).toBe(200);
    await page.unroute('**/api/v1/me/phone-verification/code');

    await page.getByTestId('verification-code').fill(await smsCode(phone, seen));
    await page.getByTestId('verification-confirm').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByText(copy.verificationDone)).toBeVisible();
  });

  test('보내지 못한 것이 확실하면 그대로 알리고 인증번호 칸을 열지 않는다', async ({ page }) => {
    await openSetPassword(page, freshEmail());
    await page.goto('/onboarding');
    await expect(page.getByTestId('verification-step')).toBeVisible();
    // A refusal before anything was sent (the provider said no): 502 SMS_SEND_FAILED.
    await page.route('**/api/v1/me/phone-verification/code', (route) =>
      route.fulfill({
        status: 502,
        json: { error: { code: 'SMS_SEND_FAILED', message: 'Internal server error' } },
      }),
    );
    await page.getByTestId('verification-real-name').fill(E2E_REAL_NAME);
    await page.getByTestId('verification-phone').fill(freshPhone());
    await page.getByTestId('verification-send').click();
    await expect(page.getByTestId('verification-notice')).toHaveText(
      copy.errVerificationSendFailed,
    );
    await expect(page.getByTestId('verification-notice')).toHaveAttribute('data-status', 'error');
    await expect(page.getByTestId('verification-code')).toHaveCount(0);
    await expect(page.getByTestId('verification-phone')).toBeEditable();
    await expect(page.getByTestId('verification-send')).toBeEnabled();
  });
});
