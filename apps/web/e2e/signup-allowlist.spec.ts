import type { APIRequestContext, APIResponse, Browser, Page } from '@playwright/test';
import {
  SIGNUP_ALLOWLIST_CLEAR_CONFIRMATION,
  type SignupAllowlist,
  type SignupAllowlistClearWrite,
} from '@buddha/shared';
import { copy } from '../src/copy';
import {
  E2E_REAL_NAME,
  adminAccount,
  agreeOnScreen,
  expect,
  expectCodeInput,
  freshEmail,
  freshPhone,
  meOf,
  openSetPassword,
  secondAdminAccount,
  signIn,
  smsCode,
  smsMessageIds,
  test,
} from './helpers';

/**
 * 가입 허용 목록 (#330, ADR-0174; owner answers 330-1…330-12), on the screens:
 *
 * - an admin opens the list from the admin menu, right after 운영자 계정; a pasted line that is no
 *   number sends nothing and is named (I1); numbers go on with a reason and the list applies;
 * - an email sign-up on a number off the list gets its code, and is refused once the code matched
 *   with the owner's sentence (330-5) — back to the number, still held by the onboarding gate; one
 *   on a listed number goes on to the nickname step;
 * - one number is taken off with a reason; the last one is not (I2);
 * - the clear of public launch: one admin asks with a reason and the typed confirmation, the
 *   other approves it on the same screen (330-2), and the list is empty — everyone signs up again.
 *
 * A social sign-up has no route here (the providers' callbacks need their consoles); it meets the
 * same confirmation, which `apps/api/src/signup-allowlist/signup-allowlist.controller.test.ts`
 * drives for an account better-auth's `createOAuthUser` made, refused and allowed alike.
 *
 * The list is global: while it holds a number, every other spec's sign-up on a fresh number would
 * be refused. A shard runs its tests one after another (`workers: 1`, one database per shard), so
 * the test empties the list — by the two seed admins' own clear, through the API — before it
 * starts (a failed earlier run) and whatever happens (`finally`), and no other spec sees it full.
 */

const LIST = '/api/v1/admin/signup-allowlist';

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${response.url()} -> ${String(response.status())} ${body}`);
  }
  return (JSON.parse(body) as { data: T }).data;
}

/**
 * Empties the list as the two seed admins would: a waiting clear decided by the admin who did not
 * ask for it, or a new one asked by `admin` and approved by `secondAdmin`.
 */
async function emptyList(admin: APIRequestContext, secondAdmin: APIRequestContext) {
  const ids = new Map([
    [(await meOf(admin)).id, admin],
    [(await meOf(secondAdmin)).id, secondAdmin],
  ]);
  let list = await dataOf<SignupAllowlist>(await admin.get(LIST));
  if (list.pendingClear === null && list.summary.entryCount === 0) return;
  const request =
    list.pendingClear ??
    (
      await dataOf<SignupAllowlistClearWrite>(
        await admin.post(`${LIST}/clear-requests`, {
          data: {
            reason: 'e2e 정리',
            confirmation: SIGNUP_ALLOWLIST_CLEAR_CONFIRMATION,
            expectedAccountId: (await meOf(admin)).id,
          },
        }),
      )
    ).request;
  const [deciderId, decider] = [...ids].find(([id]) => id !== request.requestedBy.id)!;
  list = (
    await dataOf<SignupAllowlistClearWrite>(
      await decider.post(`${LIST}/clear-requests/${request.id}/approve`, {
        data: { reason: 'e2e 정리', expectedAccountId: deciderId },
      }),
    )
  ).allowlist;
  expect(list.summary.entryCount).toBe(0);
}

/** A fresh email sign-up at the 본인확인 step, in a browser context of its own. */
async function memberAtVerification(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await openSetPassword(page, freshEmail());
  await page.goto('/onboarding');
  await agreeOnScreen(page);
  return { context, page };
}

/** Sends a code to `phone` on the step and types it back. */
async function confirmOnScreen(page: Page, phone: string): Promise<void> {
  const seen = await smsMessageIds(phone);
  await page.getByTestId('verification-real-name').fill(E2E_REAL_NAME);
  await page.getByTestId('verification-phone').fill(phone);
  await page.getByTestId('verification-send').click();
  await expectCodeInput(page);
  // The send is answered as any other: nothing about the list before the code matched.
  await expect(page.getByTestId('verification-notice')).toHaveText(copy.verificationCodeSent);
  await page.getByTestId('verification-code').fill(await smsCode(phone, seen));
  await page.getByTestId('verification-confirm').click();
}

/** The list's screen, opened from the admin menu. */
async function openList(page: Page): Promise<void> {
  await page.goto('/admin/markets');
  await page
    .getByTestId('admin-nav')
    .getByRole('link', { name: copy.adminSignupAllowlist, exact: true })
    .click();
  await expect(page).toHaveURL('/admin/signup-allowlist');
  await expect(page.getByTestId('signup-allowlist-summary')).toBeVisible();
}

test.describe('가입 허용 목록 (#330)', () => {
  test('관리자가 번호를 넣고 빼고, 다른 관리자의 승인으로 비우며, 목록 밖 번호는 확인 단계에서 거절된다', async ({
    page,
    browser,
    baseURL,
    admin,
    secondAdmin,
  }) => {
    await emptyList(admin, secondAdmin);
    const listed = freshPhone();
    const other = freshPhone();
    const unlisted = freshPhone();
    const members: { close: () => Promise<void> }[] = [];
    try {
      // --- the menu: right after 운영자 계정; the list is empty and does not apply.
      await signIn(page, adminAccount.email, adminAccount.password);
      await page.goto('/admin/markets');
      const links = await page.getByTestId('admin-nav').getByRole('link').allTextContents();
      expect(links[links.indexOf(copy.adminAccounts) + 1]).toBe(copy.adminSignupAllowlist);
      expect(links.at(-1)).toBe(copy.adminObservationMetrics);
      await openList(page);
      await expect(page.getByTestId('signup-allowlist-status')).toHaveText(
        copy.adminSignupAllowlistOff,
      );
      await expect(page.getByTestId('signup-allowlist-entries-empty')).toBeVisible();

      // --- an add with a line that is no number sends nothing, and names the line (I1).
      const phones = page.getByTestId('signup-allowlist-add-phones');
      await phones.fill(`${listed}\n02-123-4567`);
      await page.getByTestId('signup-allowlist-add-reason').fill('폐쇄 테스트 참여자');
      await page.getByTestId('signup-allowlist-add-submit').click();
      await expect(page.getByTestId('signup-allowlist-add-phones-error')).toHaveText(
        `${copy.adminSignupAllowlistBadLines} 2`,
      );
      await expect(page.getByTestId('signup-allowlist-count')).toHaveText('0');

      // --- two numbers, one typed with hyphens: the list applies.
      const hyphened = `${listed.slice(0, 3)}-${listed.slice(3, 7)}-${listed.slice(7)}`;
      await phones.fill(`${hyphened}\n\n${other}\n`);
      await page.getByTestId('signup-allowlist-add-submit').click();
      await expect(page.getByTestId('signup-allowlist-count')).toHaveText('2');
      await expect(page.getByTestId('signup-allowlist-status')).toHaveText(
        copy.adminSignupAllowlistOn,
      );
      await expect(page.getByTestId('signup-allowlist-entry')).toHaveCount(2);
      // Ids and times only: no number on the screen (330-8).
      await expect(page.getByTestId('signup-allowlist-entries')).not.toContainText(listed);

      // --- a sign-up on a number off the list: refused once its code matched (330-5).
      const refused = await memberAtVerification(browser, baseURL);
      members.push(refused.context);
      await confirmOnScreen(refused.page, unlisted);
      await expect(refused.page.getByTestId('verification-notice')).toHaveText(
        copy.errSignupNotListed,
      );
      await expect(refused.page.getByTestId('verification-notice')).toHaveAttribute(
        'role',
        'alert',
      );
      await expect(
        refused.page
          .getByTestId('verification-details-form')
          .getByText(copy.errSignupNotListed, { exact: true }),
      ).toBeVisible();
      await expect(refused.page.getByTestId('verification-code')).toHaveCount(0);
      await expect(refused.page.getByTestId('verification-phone')).toBeEditable();
      // Still held by the gate: the account has not verified.
      await refused.page.goto('/my');
      await expect(refused.page).toHaveURL('/onboarding?next=%2Fmy');
      expect((await meOf(refused.page.request)).onboarding.verification).toBe(false);

      // --- a sign-up on a listed number goes on to the nickname step.
      const allowed = await memberAtVerification(browser, baseURL);
      members.push(allowed.context);
      await confirmOnScreen(allowed.page, listed);
      await expect(allowed.page.getByText(copy.verificationDone)).toBeVisible();
      await expect(allowed.page.getByTestId('nickname-step')).toBeVisible();

      // --- one number off with a reason; never the last one (I2).
      await page.getByTestId('signup-allowlist-remove-phone').fill(other);
      await page.getByTestId('signup-allowlist-remove-reason').fill('참여 취소');
      await page.getByTestId('signup-allowlist-remove-submit').click();
      await expect(page.getByTestId('signup-allowlist-count')).toHaveText('1');
      await page.getByTestId('signup-allowlist-remove-phone').fill(listed);
      await page.getByTestId('signup-allowlist-remove-reason').fill('참여 취소');
      await page.getByTestId('signup-allowlist-remove-submit').click();
      await expect(page.getByTestId('signup-allowlist-remove-error')).toHaveText(
        copy.errSignupAllowlistLastEntry,
      );
      await expect(page.getByTestId('signup-allowlist-count')).toHaveText('1');

      // --- the clear: asked by one admin, with the typed confirmation…
      await page.getByTestId('signup-allowlist-clear-reason').fill('공개 출시');
      await page.getByTestId('signup-allowlist-clear-confirmation').fill('비우기');
      await page.getByTestId('signup-allowlist-clear-submit').click();
      await expect(page.getByText(copy.errSignupAllowlistConfirmation)).toBeVisible();
      await page
        .getByTestId('signup-allowlist-clear-confirmation')
        .fill(SIGNUP_ALLOWLIST_CLEAR_CONFIRMATION);
      await page.getByTestId('signup-allowlist-clear-submit').click();
      const pending = page.getByTestId('signup-allowlist-pending');
      await expect(pending).toContainText('공개 출시');
      await expect(pending).toContainText(copy.adminSignupAllowlistClearOwn);
      await expect(page.getByTestId('signup-allowlist-approve')).toHaveCount(0);
      await expect(page.getByTestId('signup-allowlist-count')).toHaveText('1');

      // …approved by the other on the same screen (330-2): every entry goes (330-4).
      const second = await browser.newContext({ baseURL });
      members.push(second);
      const secondPage = await second.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      await openList(secondPage);
      await expect(secondPage.getByTestId('signup-allowlist-retract')).toHaveCount(0);
      await secondPage.getByTestId('signup-allowlist-decision-reason').fill('공개 출시 승인');
      await secondPage.getByTestId('signup-allowlist-approve').click();
      await expect(secondPage.getByText(copy.adminSignupAllowlistApproved)).toBeVisible();
      await expect(secondPage.getByTestId('signup-allowlist-count')).toHaveText('0');
      await expect(secondPage.getByTestId('signup-allowlist-status')).toHaveText(
        copy.adminSignupAllowlistOff,
      );
      await expect(secondPage.getByTestId('signup-allowlist-entries-empty')).toBeVisible();
      await expect(secondPage.getByTestId('signup-allowlist-pending')).toHaveCount(0);
      const list = await dataOf<SignupAllowlist>(await admin.get(LIST));
      expect(list).toMatchObject({ summary: { entryCount: 0 }, pendingClear: null });

      // --- the list empty, a number off it passes again (330-3).
      const open = await memberAtVerification(browser, baseURL);
      members.push(open.context);
      await confirmOnScreen(open.page, freshPhone());
      await expect(open.page.getByTestId('nickname-step')).toBeVisible();
    } finally {
      for (const member of members) await member.close();
      await emptyList(admin, secondAdmin);
    }
  });
});
