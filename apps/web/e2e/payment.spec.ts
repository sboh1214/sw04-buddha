import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import type { ChargePackage, Coupon, Me } from '@buddha/shared';
import { copy } from '../src/copy';
import { accountIdOf, adminAccount, expect, freshEmail, signIn, signUp, test } from './helpers';

/**
 * Paid Coin is closed in the initial product (N06, owner decision D9, ADR-0049): no screen shows
 * a way to charge, a price list or a coupon box, and the API refuses the routes behind them
 * whatever reaches it. The charge, coupon and refund code itself is kept and tested by the API
 * suites with sales switched on (`createTestApp({ paidCoinSales: true })`); this spec holds the
 * shipped state, end to end.
 */

/** What every closed route answers: 404, naming no feature (PaidCoinSalesGuard). */
const CLOSED = { error: { code: 'NOT_FOUND', message: 'Not available' } };

async function expectClosed(response: APIResponse): Promise<void> {
  expect(response.status(), response.url()).toBe(404);
  expect(await response.json()).toEqual(CLOSED);
}

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${response.url()} -> ${String(response.status())} ${body}`);
  }
  return (JSON.parse(body) as { data: T }).data;
}

/** The signed-in member as the API sees it, read with the page's own cookie. */
function meOf(page: Page): Promise<Me> {
  return page.request.get('/api/v1/me').then((response) => dataOf<Me>(response));
}

/**
 * A package that is on sale, through the admin routes the owner left open (2026-10-13): the
 * seed's are off sale (#125), and the charge must be refused for a package that would
 * otherwise be bought.
 */
async function packageOnSale(admin: APIRequestContext): Promise<ChargePackage> {
  const packages = await dataOf<ChargePackage[]>(await admin.get('/api/v1/admin/charge-packages'));
  const active = packages.find((pack) => pack.isActive);
  if (active !== undefined) return active;
  return dataOf<ChargePackage>(
    await admin.post('/api/v1/admin/charge-packages', {
      // priceKrw must not exceed the face value (charge-package.ts `priceWithinFaceValue`).
      data: {
        amountCoin: '10000',
        priceKrw: 9900,
        sortOrder: 0,
        isActive: true,
        expectedAccountId: await accountIdOf(admin),
      },
    }),
  );
}

test.describe('유료 충전 닫힘 (ADR-0049)', () => {
  test('푸터·지갑 어디에도 충전·쿠폰·결제 진입점이 없고 /charge는 없는 페이지다', async ({
    page,
  }) => {
    // --- a visitor: the footer keeps its policy links and business facts, without 충전 안내.
    await page.goto('/');
    const footer = page.getByTestId('site-footer');
    await expect(footer).toBeVisible();
    for (const key of ['terms', 'privacy', 'refund']) {
      await expect(footer.getByTestId(`footer-link-${key}`)).toBeVisible();
    }
    await expect(footer.getByTestId('footer-link-charge')).toHaveCount(0);
    await expect(page.getByRole('link', { name: copy.chargeGuideTitle })).toHaveCount(0);

    const guide = await page.goto('/charge');
    expect(guide?.status()).toBe(404);
    await expect(page.locator('[data-testid^="charge-guide-"]')).toHaveCount(0);
    // Not even its name: the 404 must not say what it hides.
    expect(await page.title()).not.toContain(copy.chargeGuideTitle);

    // --- a member: the wallet is the balance, the notice and the ledger — nothing to buy.
    await signUp(page, freshEmail());
    await page.goto('/my/wallet');
    await expect(page.getByTestId('wallet-notice')).toHaveText(copy.walletNotice);
    await expect(page.getByTestId('wallet-available')).toBeVisible();
    await expect(page.getByTestId('ledger-list')).toBeVisible();
    for (const id of ['charge-form', 'coupon-form', 'payment-history']) {
      await expect(page.getByTestId(id)).toHaveCount(0);
    }
    await expect(page.getByText(copy.chargeSubmit)).toHaveCount(0);
    await expect(page.getByText(copy.couponTitle)).toHaveCount(0);
    await expect(page.getByText(copy.paymentHistoryTitle)).toHaveCount(0);

    // Signed in, /charge is still not there — not even a detour through the onboarding gate.
    const signedIn = await page.goto('/charge');
    expect(signedIn?.status()).toBe(404);
  });

  test('관리자 메뉴에 충전 상품·쿠폰·결제가 없다', async ({ page, admin }) => {
    // The fixture verifies the seed admin's phone, so the onboarding gate lets it through.
    void admin;
    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto('/admin/markets');
    const menu = page.getByTestId('admin-nav');
    await expect(menu.getByRole('link', { name: copy.adminMarkets, exact: true })).toBeVisible();
    await expect(menu.getByRole('link', { name: copy.adminUsers, exact: true })).toBeVisible();
    for (const label of [copy.adminPackages, copy.adminCoupons, copy.adminPayments]) {
      await expect(menu.getByRole('link', { name: label, exact: true })).toHaveCount(0);
    }
    for (const href of ['/admin/charge-packages', '/admin/coupons', '/admin/payments']) {
      await expect(page.locator(`a[href="${href}"]`)).toHaveCount(0);
    }
    // Hidden, not removed: the payments list still opens by address, with no refund to offer.
    await page.goto('/admin/payments');
    await expect(
      page
        .getByText(copy.adminNoPayments)
        .or(page.locator('[data-testid^="admin-payment-"]').first()),
    ).toBeVisible();
    await expect(page.locator('[data-testid^="admin-payment-refund-"]')).toHaveCount(0);
  });

  test('서버가 충전 상품·충전·쿠폰 요청을 거절하고 잔고는 그대로다', async ({
    page,
    request,
    admin,
  }) => {
    // --- anonymous: no price list, no provider.
    await expectClosed(await request.get('/api/v1/charge-packages'));
    await expectClosed(await request.get('/api/v1/payments/provider'));

    // --- a member, straight at the API with a package on sale and a live coupon.
    const pack = await packageOnSale(admin);
    const coupon = await dataOf<Coupon>(
      await admin.post('/api/v1/admin/coupons', {
        data: { amountCoin: '500', memo: 'e2e 닫힘', expectedAccountId: await accountIdOf(admin) },
      }),
    );
    await signUp(page, freshEmail());
    const before = await meOf(page);

    await expectClosed(await page.request.get('/api/v1/charge-packages'));
    await expectClosed(
      await page.request.post('/api/v1/payments/charge', {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        data: {
          packageId: pack.id,
          expectedAmountCoin: pack.amountCoin,
          expectedPriceKrw: pack.priceKrw,
          expectedAccountId: before.id,
        },
      }),
    );
    await expectClosed(
      await page.request.post('/api/v1/coupons/redeem', {
        data: { code: coupon.code, expectedAccountId: before.id },
      }),
    );

    // Nothing moved: still the 0 a new account starts with (#70), no payment, and the coupon
    // unused.
    const after = await meOf(page);
    expect(after.balance).toEqual(before.balance);
    const payments = await dataOf<unknown[]>(await page.request.get('/api/v1/me/payments'));
    expect(payments).toEqual([]);
    const coupons = await dataOf<Coupon[]>(await admin.get('/api/v1/admin/coupons'));
    expect(coupons.find((row) => row.id === coupon.id)?.redeemedCount).toBe(0);
  });
});
