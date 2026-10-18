import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import type { AdminAccount } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  E2E_PASSWORD,
  adminAccount,
  expect,
  freshEmail,
  openSetPassword,
  secondAdminAccount,
  signIn,
  signUp,
  test,
} from './helpers';

/**
 * 운영자 계정 (#171, ADR-0056): an admin grants the role on the screen to an account that has a
 * verified email and a verified phone (ADR-0070), and revokes it with a reason; the revoked account
 * is signed out at once and is a member again. A revoke that would leave fewer than two admins
 * is refused, one's own included. A member never reaches the screen or its API.
 *
 * Role changes run in one project only, in order. Both projects share one database, and the
 * floor of two is checked against exactly the two seeded admins: a third admin granted by the
 * other project at the same moment would let that revoke through.
 */

const ADMINS = '/api/v1/admin/admins';
const CHANGES = '/api/v1/admin/admins/changes';

/** Accounts `freshEmail()` made: the only admins this spec may revoke to tidy up after itself. */
const E2E_ACCOUNT = /^e2e-\d+-[a-z0-9]+@buddha\.local$/;

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${response.url()} -> ${String(response.status())} ${body}`);
  }
  return (JSON.parse(body) as { data: T }).data;
}

async function expectError(response: APIResponse, status: number, code: string): Promise<void> {
  expect(response.status(), response.url()).toBe(status);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
}

async function nicknameOf(context: APIRequestContext): Promise<string> {
  return (await dataOf<{ profile: { nickname: string } }>(await context.get('/api/v1/me'))).profile
    .nickname;
}

/** The row of `email` in the admin list. */
function adminRow(page: Page, email: string) {
  return page
    .getByTestId('admin-accounts-list')
    .getByTestId('admin-account-row')
    .filter({ has: page.getByText(email, { exact: true }) });
}

/** Finds `email` with the grant search and opens its grant dialog. */
async function openGrant(page: Page, email: string): Promise<void> {
  const grant = page.getByTestId('admin-grant');
  await grant.getByTestId('admin-grant-search').fill(email);
  await grant.getByTestId('admin-grant-search-submit').click();
  await grant
    .getByTestId('admin-grant-candidate')
    .filter({ has: page.getByText(email, { exact: true }) })
    .getByTestId('admin-grant-open')
    .click();
  await expect(page.getByTestId('admin-role-dialog')).toContainText(email);
}

test.describe('관리자 권한 부여·회수 (#171)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(({ isMobile }) => isMobile, 'role changes run once, in the desktop project');

  test('관리자가 조건을 갖춘 계정에 사유와 함께 부여하고 회수하면, 그 계정은 로그아웃되고 관리자 기능을 잃는다', async ({
    page,
    browser,
    secondAdmin,
  }) => {
    const secondNickname = await nicknameOf(secondAdmin);
    const memberContext = await browser.newContext();
    const pendingContext = await browser.newContext();
    try {
      // The account to grant: a sign-up verifies its email and then its phone.
      const memberPage = await memberContext.newPage();
      const memberEmail = freshEmail();
      await signUp(memberPage, memberEmail);
      await memberPage.goto('/admin/admins');
      await expect(memberPage).toHaveURL('/');

      // One that verified its email but not its phone yet.
      const pendingPage = await pendingContext.newPage();
      const pendingEmail = freshEmail();
      await openSetPassword(pendingPage, pendingEmail);

      // The second seeded admin opens the screen from the admin menu.
      await signIn(page, secondAdminAccount.email, secondAdminAccount.password);
      await page.goto('/admin/markets');
      await page
        .getByTestId('admin-nav')
        .getByRole('link', { name: copy.adminAccounts, exact: true })
        .click();
      await expect(page).toHaveURL('/admin/admins');
      await expect(adminRow(page, adminAccount.email)).toBeVisible();
      await expect(adminRow(page, secondAdminAccount.email)).toBeVisible();
      await expect(
        adminRow(page, secondAdminAccount.email).getByTestId('admin-account-self'),
      ).toBeVisible();

      const dialog = page.getByTestId('admin-role-dialog');
      const latest = page.getByTestId('admin-role-change').first();

      // Refused before the phone is verified (ADR-0070): the dialog says why and stays.
      await openGrant(page, pendingEmail);
      await dialog.getByTestId('admin-role-reason').fill('e2e 조건 확인');
      await dialog.getByTestId('admin-role-submit').click();
      await expect(dialog.getByTestId('admin-role-refusal')).toHaveText(
        copy.errAdminGrantPhoneNotVerified,
      );
      await dialog.getByTestId('admin-role-cancel').click();
      await expect(dialog).toBeHidden();
      await expect(adminRow(page, pendingEmail)).toHaveCount(0);

      // A new search's matches replace the last one's only when they arrive. Until then the
      // last term's matches stay dimmed with 부여 off: none of them can be granted by mistake.
      const search = page.getByTestId('admin-grant');
      const memberSearch = (url: URL) =>
        url.pathname === '/api/v1/admin/users' && url.searchParams.get('q') === memberEmail;
      let answer!: () => void;
      const held = new Promise<void>((resolve) => {
        answer = resolve;
      });
      await page.route(memberSearch, async (route) => {
        await held;
        await route.continue();
      });
      await search.getByTestId('admin-grant-search').fill(memberEmail);
      await search.getByTestId('admin-grant-search-submit').click();
      await expect(search.getByTestId('admin-grant-results')).toHaveAttribute('aria-busy', 'true');
      await expect(
        search
          .getByTestId('admin-grant-candidate')
          .filter({ has: page.getByText(pendingEmail, { exact: true }) })
          .getByTestId('admin-grant-open'),
      ).toBeDisabled();
      answer();
      await expect(search.getByTestId('admin-grant-results')).toHaveAttribute('aria-busy', 'false');
      await page.unroute(memberSearch);

      // Granted, with the reason in the record beside the admin who did it.
      const grantReason = `e2e 운영 교대 ${memberEmail}`;
      await openGrant(page, memberEmail);
      await dialog.getByTestId('admin-role-reason').fill(grantReason);
      await dialog.getByTestId('admin-role-submit').click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText(copy.adminAccountsGrantDone)).toBeVisible();
      await expect(adminRow(page, memberEmail)).toBeVisible();
      await expect(adminRow(page, memberEmail).getByTestId('admin-account-granted')).toContainText(
        `· ${secondNickname}`,
      );
      await expect(
        page
          .getByTestId('admin-grant-candidate')
          .filter({ has: page.getByText(memberEmail, { exact: true }) })
          .getByTestId('admin-grant-candidate-admin'),
      ).toBeVisible();
      await expect(latest.getByTestId('admin-role-change-type')).toHaveText(
        copy.adminAccountsChangeGrant,
      );
      await expect(latest).toContainText(memberEmail);
      await expect(latest.getByTestId('admin-role-change-reason')).toContainText(grantReason);
      await expect(latest.getByTestId('admin-role-change-actor')).toHaveText(
        `${copy.adminAccountsChangeActor} ${secondNickname}`,
      );

      // Three admins at once, and the new one is in from its next request.
      await memberPage.goto('/admin/admins');
      await expect(memberPage.getByTestId('admin-accounts')).toBeVisible();
      await expect(adminRow(memberPage, memberEmail)).toBeVisible();
      expect((await memberPage.request.get(ADMINS)).status()).toBe(200);

      // A revoke needs its reason too.
      await adminRow(page, memberEmail).getByTestId('admin-account-revoke').click();
      await expect(dialog).toContainText(memberEmail);
      await dialog.getByTestId('admin-role-submit').click();
      await expect(dialog).toContainText(copy.errAdminRoleReason);
      const revokeReason = `e2e 교대 종료 ${memberEmail}`;
      await dialog.getByTestId('admin-role-reason').fill(revokeReason);
      await dialog.getByTestId('admin-role-submit').click();
      await expect(dialog).toBeHidden();
      await expect(adminRow(page, memberEmail)).toHaveCount(0);
      await expect(latest.getByTestId('admin-role-change-type')).toHaveText(
        copy.adminAccountsChangeRevoke,
      );
      await expect(latest).toContainText(memberEmail);
      await expect(latest.getByTestId('admin-role-change-reason')).toContainText(revokeReason);

      // Its session is gone: the next request is signed out, and the admin pages send it to
      // sign in.
      await expectError(await memberPage.request.get(ADMINS), 401, 'UNAUTHENTICATED');
      await memberPage.goto('/admin/admins');
      await memberPage.waitForURL(/\/login\?/);

      // Signed in again, it is a member: the screen and the API turn it away.
      await signIn(memberPage, memberEmail, E2E_PASSWORD);
      await memberPage.goto('/admin/admins');
      await expect(memberPage).toHaveURL('/');
      await expectError(await memberPage.request.get(ADMINS), 403, 'FORBIDDEN');
    } finally {
      await memberContext.close();
      await pendingContext.close();
    }
  });

  test('관리자가 2명 미만이 되는 회수는 내 계정까지 거절되고, 화면이 까닭을 보인다', async ({
    page,
    admin,
  }) => {
    // A grant or revoke names the admin it is sent as (`expectedAccountId`), as the screen does.
    const adminId = (await dataOf<{ id: string }>(await admin.get('/api/v1/me'))).id;
    // An interrupted run of the test above may have left its account an admin, and a third
    // admin would let the revokes below through: such leftovers go first.
    for (const leftover of (await dataOf<AdminAccount[]>(await admin.get(ADMINS))).filter(
      (account) => E2E_ACCOUNT.test(account.email),
    )) {
      await dataOf(
        await admin.post(`${ADMINS}/${leftover.id}/revoke`, {
          data: { reason: 'e2e 정리', expectedAccountId: adminId },
        }),
      );
    }
    const admins = await dataOf<AdminAccount[]>(await admin.get(ADMINS));
    expect(
      admins.map((account) => account.email).sort(),
      'this check needs exactly the two seeded admins (pnpm db:seed on an empty database)',
    ).toEqual([adminAccount.email, secondAdminAccount.email].sort());

    await signIn(page, adminAccount.email, adminAccount.password);
    // The list can arrive before the session: 회수 stays off until the tab knows who is signed
    // in, or a revoke of one's own role taken for another admin's would skip the sign-out.
    let releaseSession: () => void = () => undefined;
    const sessionHeld = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    const isSessionRead = (url: URL) => url.pathname === '/api/auth/get-session';
    await page.route(isSessionRead, async (route) => {
      await sessionHeld;
      await route.continue().catch(() => undefined); // the tab may have dropped it meanwhile
    });
    await page.goto('/admin/admins');
    await expect(page.getByTestId('admin-accounts-count')).toHaveText(
      `${copy.adminTitle} 2${copy.adminAccountsCountUnit}`,
    );
    const revokeButtons = page
      .getByTestId('admin-accounts-list')
      .getByTestId('admin-account-revoke');
    await expect(revokeButtons).toHaveCount(2);
    for (const button of await revokeButtons.all()) await expect(button).toBeDisabled();
    releaseSession();
    await page.unroute(isSessionRead);
    for (const button of await revokeButtons.all()) await expect(button).toBeEnabled();
    await expect(page.getByTestId('admin-accounts')).toContainText(copy.adminAccountsRevokeRule);
    const dialog = page.getByTestId('admin-role-dialog');

    // The other admin.
    await adminRow(page, secondAdminAccount.email).getByTestId('admin-account-revoke').click();
    await dialog.getByTestId('admin-role-reason').fill('e2e 하한 확인');
    await dialog.getByTestId('admin-role-submit').click();
    await expect(dialog.getByTestId('admin-role-refusal')).toHaveText(copy.errAdminRevokeMinAdmins);
    await dialog.getByTestId('admin-role-cancel').click();
    await expect(dialog).toBeHidden();

    // One's own, under the same floor.
    const own = adminRow(page, adminAccount.email);
    await expect(own.getByTestId('admin-account-self')).toBeVisible();
    await own.getByTestId('admin-account-revoke').click();
    await expect(dialog).toContainText(copy.adminAccountsRevokeSelfNotice);
    await dialog.getByTestId('admin-role-reason').fill('e2e 자기 회수 확인');
    await dialog.getByTestId('admin-role-submit').click();
    await expect(dialog.getByTestId('admin-role-refusal')).toHaveText(copy.errAdminRevokeMinAdmins);
    await dialog.getByTestId('admin-role-cancel').click();
    await expect(dialog).toBeHidden();

    // Nothing changed, and still signed in.
    await page.reload();
    await expect(page).toHaveURL('/admin/admins');
    await expect(
      page.getByTestId('admin-accounts-list').getByTestId('admin-account-row'),
    ).toHaveCount(2);

    // The API says why.
    const second = admins.find((account) => account.email === secondAdminAccount.email);
    if (second === undefined) throw new Error('the second seeded admin is not listed');
    const refused = await admin.post(`${ADMINS}/${second.id}/revoke`, {
      data: { reason: 'e2e 하한 확인', expectedAccountId: adminId },
    });
    expect(refused.status()).toBe(409);
    const { error } = (await refused.json()) as {
      error: { code: string; details: { message: string }[] };
    };
    expect(error.code).toBe('ROLE_CHANGE_NOT_ALLOWED');
    expect(error.details[0]?.message).toBe('min_admins');
  });
});

test('관리자가 아닌 계정은 /admin/admins를 열 수 없고, API는 목록·기록·부여·회수를 거절한다', async ({
  page,
}) => {
  // Signed out: the admin gate sends the visitor to sign in, and back here afterwards.
  await page.goto('/admin/admins');
  await page.waitForURL(/\/login\?/);
  expect(new URL(page.url()).searchParams.get('next')).toBe('/admin/admins');

  // A member: the admin layout sends it home without rendering the screen.
  await signUp(page, freshEmail());
  await page.goto('/admin/admins');
  await expect(page).toHaveURL('/');
  await expect(page.getByTestId('admin-accounts')).toHaveCount(0);

  // And the API refuses the member whatever the screen does — the record included (N04 §6).
  const me = await dataOf<{ id: string }>(await page.request.get('/api/v1/me'));
  await expectError(await page.request.get(ADMINS), 403, 'FORBIDDEN');
  await expectError(await page.request.get(CHANGES), 403, 'FORBIDDEN');
  await expectError(
    await page.request.post(ADMINS, {
      data: { userId: me.id, reason: 'e2e', expectedAccountId: me.id },
    }),
    403,
    'FORBIDDEN',
  );
  await expectError(
    await page.request.post(`${ADMINS}/${me.id}/revoke`, {
      data: { reason: 'e2e', expectedAccountId: me.id },
    }),
    403,
    'FORBIDDEN',
  );
});
