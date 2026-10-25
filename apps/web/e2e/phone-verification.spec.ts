import type { Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  E2E_REAL_NAME,
  agreeOnScreen,
  backgroundOf,
  expect,
  expectCodeInput,
  expectYellowWarning,
  freshEmail,
  freshPhone,
  logOut,
  meOf,
  openSetPassword,
  signUp,
  smsCode,
  smsMessageIds,
  switchAccountUnderScreen,
  test,
  tokenColour,
} from './helpers';

/**
 * 본인확인 (#183, ADR-0070): the step's refusals as a member meets them — a wrong code with the
 * entries it has left, the fifth wrong entry that discards the code, the resend wait, an older
 * code typed after a resend, and a number another account has verified (one account per number,
 * ADR-0069 decision 1 #57-1) — a code the screen did not send (a reload, another tab), which can
 * still be entered, and a send whose answer was lost — the provider's (SMS_SEND_UNCONFIRMED) or
 * the API's own on its way to the browser (a dropped connection, a gateway's 5xx, a timeout) —
 * which may have texted the code and says so, as a warning, while its code is tried, and after
 * which an older code is answered as the last text that came for as long as the screen knows it
 * (owner decisions 2026-10-18). The happy path and the gate are onboarding.spec.ts's. The step is
 * the onboarding's second (#58): every test agrees to the consent on screen first. A step, or MY
 * 설정's real-name card, still showing the account a tab was signed in as after the tab switched to
 * another names the account it shows and is refused (ADR-0090); a card whose `['me']` turned to
 * another account before the session did starts again from that account's name.
 *
 * Every account and number is fresh, so the per-account and per-number limits never meet another
 * test's sends. The codes come from the API's development SMS sender through Mailpit.
 */

/**
 * Opens the 본인확인 step for a fresh signed-in account: the onboarding's consent first (#58, the
 * owner's order), which the stepper follows with this step.
 */
async function openVerificationStep(page: Page): Promise<void> {
  await openSetPassword(page, freshEmail());
  await page.goto('/onboarding');
  await agreeOnScreen(page);
}

/**
 * A confirmed code: the toast, and the onboarding's next step (#58) on the same screen — the
 * stepper moves on to the nickname rather than leaving /onboarding.
 */
async function expectVerified(page: Page): Promise<void> {
  await expect(page.getByText(copy.verificationDone)).toBeVisible();
  await expect(page.getByTestId('nickname-step')).toBeVisible();
  await expect(page).toHaveURL('/onboarding');
}

/** Opens the step for a fresh signed-in account that has not verified, and sends a code. */
async function sendCode(page: Page, phone: string): Promise<string> {
  await openVerificationStep(page);
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

/** The step's notice, above its forms. */
const noticeOf = (page: Page) => page.getByTestId('verification-notice');

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
  // Yellow, as every warning is (third round).
  await expectYellowWarning(notice);
  await expect(notice).not.toContainText(copy.errVerificationSendFailed);
  await expect(page.getByTestId('verification-code')).toBeFocused();
  await expect(page.getByTestId('verification-phone')).not.toBeEditable();
  await expect(page.getByTestId('verification-real-name')).not.toBeEditable();
  await expect(page.getByTestId('verification-send')).toBeDisabled();
  await expect(page.getByTestId('verification-send')).toContainText(`${copy.verificationResend} (`);
  await expect(page.getByTestId('verification-code-expiry')).toHaveCount(0);
}

/**
 * Types `older` — a code before the newest, whose send's outcome is unknown — and expects it
 * refused under the input in the words for that case (owner decision 2026-10-18, third round 3):
 * type the last text's code, ask again later if no new text comes; not "type the new code".
 */
async function expectSupersededUncertain(page: Page, older: string): Promise<void> {
  await page.getByTestId('verification-code').fill(older);
  await page.getByTestId('verification-confirm').click();
  await expect(
    page.getByText(copy.errVerificationCodeSupersededUncertain, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(copy.errVerificationCodeSuperseded, { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('verification-code')).toBeVisible();
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
    await expectVerified(page);
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
    await expectVerified(page);
  });

  test('1분 안에 다른 화면에서 보낸 인증번호가 있으면 다시 받기 대신 그 입력 칸을 연다', async ({
    page,
  }) => {
    const phone = freshPhone();
    await openVerificationStep(page);

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
    await expectVerified(page);
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
    // The words for a send that may not have come are the uncertain resend's alone (third round).
    await expect(
      page.getByText(copy.errVerificationCodeSupersededUncertain, { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByTestId('verification-code')).toBeVisible();
    // A real wrong entry after it is the first counted: four left.
    const other = ['000000', '000001', '000002'].find((code) => code !== older && code !== newest)!;
    await page.getByTestId('verification-code').fill(other);
    await page.getByTestId('verification-confirm').click();
    await expect(page.getByText(mismatch(4), { exact: true })).toBeVisible();

    await page.getByTestId('verification-code').fill(newest);
    await page.getByTestId('verification-confirm').click();
    await expectVerified(page);
  });

  test('발송 결과를 알 수 없으면 문자가 갔을 수 있다고 알리고 그 인증번호를 받는다', async ({
    page,
  }) => {
    const phone = freshPhone();
    await openVerificationStep(page);

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
    await expectVerified(page);
  });

  test('다시 받기의 결과를 알 수 없을 때 예전 인증번호를 넣으면 마지막 문자의 인증번호를 묻고 문자가 갔을 수 있다는 안내가 남는다', async ({
    page,
  }) => {
    test.slow(); // the resend interval is a real minute
    const phone = freshPhone();
    const older = await sendCode(page, phone);
    // The sent code's notice is information (blue); the lost answer's below is a warning, drawn
    // apart, in yellow.
    await expect(noticeOf(page)).toHaveAttribute('data-status', 'info');
    const sentBackground = await backgroundOf(noticeOf(page));
    expect(sentBackground).toBe(await tokenColour(noticeOf(page), 'blue.subtle'));

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
    expect(await backgroundOf(notice)).not.toBe(sentBackground);
    await expectYellowWarning(notice);
    expect(realStatus).toBe(200);
    await page.unroute('**/api/v1/me/phone-verification/code');
    const newest = await smsCode(phone, seen);
    test.skip(older === newest, 'the two draws were the same code (one in a million)');

    // The new text "never came", so the member types the first one: refused under the input as
    // an older code, in the words for a send that may not have come — type the last text's code,
    // ask again later if no new text comes (owner decision 2026-10-18, third round), not "type the
    // new code" — and the line that says to ask again later if nothing came stays above.
    await expectSupersededUncertain(page, older);
    await expect(notice).toHaveText(copy.verificationMaybeSent);
    // A wrong code keeps it too (the first counted entry: four left).
    const other = ['000000', '000001', '000002'].find((code) => code !== older && code !== newest)!;
    await page.getByTestId('verification-code').fill(other);
    await page.getByTestId('verification-confirm').click();
    await expect(page.getByText(mismatch(4), { exact: true })).toBeVisible();
    await expect(notice).toHaveText(copy.verificationMaybeSent);

    // Another minute, and a 다시 받기 that surely sent nothing (the provider refused: 502
    // SMS_SEND_FAILED, never reaching the API here): the newest code is still the uncertain
    // resend's, so the older code is still answered as the last text that came (ADR-0070 7-32).
    await expect(send).toBeEnabled({ timeout: RESEND_WAIT_MS });
    await page.route('**/api/v1/me/phone-verification/code', (route) =>
      route.fulfill({
        status: 502,
        json: { error: { code: 'SMS_SEND_FAILED', message: 'Internal server error' } },
      }),
    );
    await send.click();
    await expect(notice).toHaveText(copy.errVerificationSendFailed);
    await expect(page.getByTestId('verification-code')).toBeVisible();
    await page.unroute('**/api/v1/me/phone-verification/code');
    await expectSupersededUncertain(page, older);
    // The code's own notice comes back with the entry (`CodeEntry.standing`).
    await expect(notice).toHaveText(copy.verificationMaybeSent);

    // 실명·번호 다시 입력 → 이미 받은 인증번호 입력 on the same screen: the newest code is still
    // that send's, and the screen still knows it (the flag is the screen's, not the input's).
    await page.getByTestId('verification-edit').click();
    await expect(page.getByTestId('verification-code')).toHaveCount(0);
    await page.getByTestId('verification-enter-code').click();
    await expectSupersededUncertain(page, older);

    // A reload forgets what this screen saw of its sends: 이미 받은 인증번호 입력 then answers
    // the older code in the plain words (7-32 — whether the server's record of the unknown send
    // should say otherwise is the owner's open question, ADR-0070 결과 4).
    await page.reload();
    await page.getByTestId('verification-enter-code').click();
    await page.getByTestId('verification-code').fill(older);
    await page.getByTestId('verification-confirm').click();
    await expect(page.getByText(copy.errVerificationCodeSuperseded, { exact: true })).toBeVisible();
    await expect(
      page.getByText(copy.errVerificationCodeSupersededUncertain, { exact: true }),
    ).toHaveCount(0);

    // None of the older codes spent an entry: the newest still verifies.
    await page.getByTestId('verification-code').fill(newest);
    await page.getByTestId('verification-confirm').click();
    await expectVerified(page);
  });

  test('답을 받지 못한 다시 받기 뒤 실명·번호 다시 입력과 이미 받은 인증번호 입력으로 예전 인증번호를 넣어도 마지막 문자의 인증번호를 묻고, 다른 화면이 보낸 뒤에는 보통의 문장이다', async ({
    page,
  }) => {
    test.slow(); // the resend interval is a real minute
    const phone = freshPhone();
    const older = await sendCode(page, phone);

    // A minute later, 다시 받기: the API sends a new code (kept as the newest), and its answer
    // never reaches the browser — the other way a send's outcome is unknown (second round).
    const send = page.getByTestId('verification-send');
    await expect(send).toBeEnabled({ timeout: RESEND_WAIT_MS });
    let realStatus = 0;
    await page.route('**/api/v1/me/phone-verification/code', async (route) => {
      realStatus = (await route.fetch()).status();
      await route.abort('timedout');
    });
    const seen = await smsMessageIds(phone);
    await send.click();
    await expectMaybeSent(page);
    expect(realStatus).toBe(200);
    await page.unroute('**/api/v1/me/phone-verification/code');
    const newest = await smsCode(phone, seen);
    test.skip(older === newest, 'the two draws were the same code (one in a million)');

    // No new text came, so the member opens the name and the number again, thinks better of it
    // and goes back to the code they have (the send button still counts the minute down).
    await page.getByTestId('verification-edit').click();
    await expect(page.getByTestId('verification-code')).toHaveCount(0);
    await expect(page.getByTestId('verification-notice')).toHaveCount(0);
    await expect(send).toBeDisabled();
    await page.getByTestId('verification-enter-code').click();
    // The older code: the last text that came, not one a new text replaced (third round 3).
    await expectSupersededUncertain(page, older);

    // Once the minute is over another tab of the account texts a code, and this screen's send
    // right after is refused for the resend wait: the newest code is now a send this screen did
    // not see, whose outcome it does not know, so an older code reads in the plain words again,
    // as after a reload (ADR-0070 7-32).
    await expect(send).toBeEnabled({ timeout: RESEND_WAIT_MS });
    const me = (await (await page.request.get('/api/v1/me')).json()) as { data: { id: string } };
    const seenOther = await smsMessageIds(phone);
    const otherTab = await page.request.post('/api/v1/me/phone-verification/code', {
      data: { realName: E2E_REAL_NAME, phone, expectedAccountId: me.data.id },
    });
    expect(otherTab.status()).toBe(200);
    const latest = await smsCode(phone, seenOther);
    test.skip(
      latest === older || latest === newest,
      'two draws were the same code (one in a million)',
    );
    await send.click();
    await expect(page.getByTestId('verification-notice')).toContainText(
      copy.errVerificationResendWait,
    );
    await expect(send).toBeDisabled();
    await page.getByTestId('verification-code').fill(older);
    await page.getByTestId('verification-confirm').click();
    await expect(page.getByText(copy.errVerificationCodeSuperseded, { exact: true })).toBeVisible();
    await expect(
      page.getByText(copy.errVerificationCodeSupersededUncertain, { exact: true }),
    ).toHaveCount(0);

    await page.getByTestId('verification-code').fill(latest);
    await page.getByTestId('verification-confirm').click();
    await expectVerified(page);
  });

  test('API의 답이 브라우저에 오지 않으면(연결 끊김·시간 초과) 문자가 갔을 수 있다고 알리고 그 인증번호를 받는다', async ({
    page,
  }) => {
    const phone = freshPhone();
    await openVerificationStep(page);

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
    await expectVerified(page);
  });

  test('앞단 게이트웨이가 API 대신 5xx로 답해도 문자가 갔을 수 있다고 알린다', async ({ page }) => {
    const phone = freshPhone();
    await openVerificationStep(page);

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
    await expectVerified(page);
  });

  test('보내지 못한 것이 확실하면 그대로 알리고 인증번호 칸을 열지 않는다', async ({ page }) => {
    await openVerificationStep(page);
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

  test('탭의 계정이 다른 회원으로 바뀐 뒤 앞 계정의 본인확인 단계가 화면에 남아 있으면 인증번호 받기와 본인확인 완료는 그 화면의 계정을 대어 거절되고, 어느 계정에도 문자를 보내거나 기록하지 않는다', async ({
    browser,
    page,
  }) => {
    // ADR-0090 (the remaining sibling of PR #224's Codex fix, ADR-0078 7-29 (3)): in the render
    // between the session naming B and SessionCacheGuard's reset the stepper still shows A's step
    // while the session already says B, and a body naming the session's account would be taken
    // with B's cookie — the name and the number typed on A's screen texted for B, a code verified
    // as B's. The step names the stepper's account (`me.id`), so the server refuses both as another
    // account's. That render is held here: B's cookie in this tab and the session read again, while
    // `GET /me` still answers as A (`switchAccountUnderScreen`) — B at its own 본인확인 step, so a
    // body naming B would have been taken.
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await openVerificationStep(other);
      const b = await meOf(other.request);
      await openVerificationStep(page);
      const a = await meOf(page.request);
      await shownContext.addCookies(await page.context().cookies());
      await switchAccountUnderScreen(page, shownContext.request, {
        id: b.id,
        cookies: await otherContext.cookies(),
      });
      // The stepper drawn again from A's `Me` after the guard's reset: A's 본인확인 step.
      await expect(page.getByTestId('verification-step')).toBeVisible();

      const writes: { path: string; body: unknown }[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() === 'POST' && path.startsWith('/api/v1/me/phone-verification/')) {
          writes.push({ path, body: request.postDataJSON() });
        }
      });
      const answerOf = (path: string) =>
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === path && response.request().method() === 'POST',
        );

      // 인증번호 받기 names A: refused with B's cookie, no text sent.
      const phone = freshPhone();
      await page.getByTestId('verification-real-name').fill(E2E_REAL_NAME);
      await page.getByTestId('verification-phone').fill(phone);
      let answered = answerOf('/api/v1/me/phone-verification/code');
      await page.getByTestId('verification-send').click();
      expect((await answered).status()).toBe(403);
      await expect(noticeOf(page)).toHaveText(copy.sessionChanged);
      await expect(page.getByTestId('verification-code')).toHaveCount(0);

      // A code received before (a reload, another tab) entered on A's step: refused the same way.
      await page.getByTestId('verification-enter-code').click();
      await page.getByTestId('verification-code').fill('123456');
      answered = answerOf('/api/v1/me/phone-verification/confirm');
      await page.getByTestId('verification-confirm').click();
      expect((await answered).status()).toBe(403);
      await expect(noticeOf(page)).toHaveText(copy.sessionChanged);

      expect(writes).toEqual([
        {
          path: '/api/v1/me/phone-verification/code',
          body: { realName: E2E_REAL_NAME, phone, expectedAccountId: a.id },
        },
        {
          path: '/api/v1/me/phone-verification/confirm',
          body: { code: '123456', expectedAccountId: a.id },
        },
      ]);
      // No text to the number; nothing recorded for B or for A.
      expect(await smsMessageIds(phone)).toEqual([]);
      const bAfter = await meOf(other.request);
      expect(bAfter.verification).toBeNull();
      expect(bAfter.onboarding).toEqual(b.onboarding);
      const aAfter = await meOf(shownContext.request);
      expect(aAfter.verification).toBeNull();
      expect(aAfter.onboarding).toEqual(a.onboarding);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await otherContext.close();
      await shownContext.close();
    }
  });

  test('탭의 계정이 다른 회원으로 바뀐 뒤 앞 계정의 MY 설정이 남아 있으면 실명 저장은 그 화면의 계정을 대어 거절되고, 어느 계정의 실명도 바뀌지 않는다', async ({
    browser,
    page,
  }) => {
    // ADR-0090: the same render on MY 설정 — the 본인확인 card still shows A's record while the
    // session already says B, and a save naming the session's account would rename B with the name
    // typed on A's card. The card names the account of the `Me` it was drawn from, so the server
    // refuses it as another account's.
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      const b = await meOf(other.request);
      await signUp(page, freshEmail());
      const a = await meOf(page.request);
      await page.goto('/my/settings');
      const card = page.getByTestId('settings-verification');
      const name = card.getByTestId('verification-real-name');
      await expect(name).toHaveValue(E2E_REAL_NAME);
      await shownContext.addCookies(await page.context().cookies());
      await switchAccountUnderScreen(page, shownContext.request, {
        id: b.id,
        cookies: await otherContext.cookies(),
      });

      const writes: unknown[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/v1/me/real-name') {
          writes.push(request.postDataJSON());
        }
      });
      // A's card, drawn again from A's `Me` after the guard's reset.
      await expect(name).toHaveValue(E2E_REAL_NAME);
      await name.fill('김바뀜');
      const saved = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/v1/me/real-name',
      );
      await card.getByTestId('verification-real-name-save').click();
      expect((await saved).status()).toBe(403);
      await expect(
        page.locator('[data-scope="toast"]').getByText(copy.sessionChanged),
      ).toBeVisible();

      expect(writes).toEqual([{ realName: '김바뀜', expectedAccountId: a.id }]);
      // Nothing renamed, B or A.
      expect((await meOf(other.request)).verification).toEqual(b.verification);
      expect((await meOf(shownContext.request)).verification).toEqual(a.verification);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await otherContext.close();
      await shownContext.close();
    }
  });

  test('탭의 세션이 아직 앞 계정을 말하는데 MY 설정의 `GET /me`가 다른 회원으로 답하면 실명 카드는 그 회원의 것으로 다시 그려지고, 앞 계정에 적던 실명은 남지 않는다', async ({
    browser,
    page,
  }) => {
    // ADR-0090 결정 4-2: the reverse of `switchAccountUnderScreen`'s order. `['me']` turns from A
    // to B in place, before the session does, so SessionCacheGuard resets nothing: a window-focus
    // refetch of `GET /me` answered with B's cookie while better-auth's session still says A (its
    // own focus refetch skips a tab back within 5 s; a realtime resnapshot does the same; two
    // windows side by side tell nothing). Unkeyed, the card kept the name typed on A's card over
    // B's, 저장 on, and the save named B — the `Me` now drawn — with B's cookie: B renamed with A's
    // draft. Keyed by account, it starts again from B's own name. Held here: better-auth's answers
    // come from A's jar, B's cookie is put in the tab, and the page's clock makes `['me']` older
    // than its `staleTime` (30 s) for a focus refetch, as posts.spec.ts does.
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      const b = await meOf(other.request);
      const renamed = await other.request.put('/api/v1/me/real-name', {
        data: { realName: '박둘째', expectedAccountId: b.id },
      });
      expect(renamed.status(), await renamed.text()).toBe(200);
      await signUp(page, freshEmail());
      const a = await meOf(page.request);
      await page.clock.install();
      await page.goto('/my/settings');
      const card = page.getByTestId('settings-verification');
      const name = card.getByTestId('verification-real-name');
      const save = card.getByTestId('verification-real-name-save');
      await expect(name).toHaveValue(E2E_REAL_NAME);
      await name.fill('김바뀜');
      await expect(save).toBeEnabled();

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
      const writes: unknown[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/v1/me/real-name') {
          writes.push(request.postDataJSON());
        }
      });
      await page.context().clearCookies();
      await page.context().addCookies(await otherContext.cookies());
      const meRead = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === '/api/v1/me',
      );
      await page.clock.fastForward('00:31');
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
      const drawn = (await (await meRead).json()) as { data: { id: string } };
      expect(drawn.data.id).toBe(b.id);

      // B's card, from B's name: A's draft gone, nothing to save.
      await expect(name).toHaveValue('박둘째');
      await expect(save).toBeDisabled();
      expect(writes).toEqual([]);
      expect((await meOf(other.request)).verification?.realName).toBe('박둘째');
      expect((await meOf(shownContext.request)).verification).toEqual(a.verification);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await otherContext.close();
      await shownContext.close();
    }
  });
});
