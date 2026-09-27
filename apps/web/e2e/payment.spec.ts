import type { Locator, Page } from '@playwright/test';
import type { Payment } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  adminAccount,
  chargeOnce,
  ensureChargePackage,
  expect,
  freshEmail,
  signIn,
  signUp,
  test,
} from './helpers';

/**
 * 결제 결과 안내와 관리자 환불 (ADR-0042, DESIGN §6.2) on the provider the suite runs with — the
 * mock, which settles a charge at once (PAYMENT_PROVIDER defaults to mock; CI never sets it).
 * The SmartroPay window itself needs STG credentials and is verified there, not here; what
 * these tests cover is everything around it that the mock exercises the same way: the wallet
 * the callbacks redirect to, the user's 결제 내역, and the refund path (claw-back → provider
 * cancel → ledger row), which the mock provider's cancel always approves.
 */

/** The P a `formatP` string shows ('12,345P' → 12345n). Balances here are never negative. */
function pOf(text: string): bigint {
  return BigInt(text.replace(/[^0-9]/g, ''));
}

async function availableP(available: Locator): Promise<bigint> {
  return pOf(await available.innerText());
}

/** The signed-in member's newest payment, read with the page's own cookie (`GET /me/payments`). */
async function newestPayment(page: Page): Promise<Payment> {
  const response = await page.request.get('/api/v1/me/payments');
  const body = await response.text();
  if (!response.ok()) throw new Error(`${response.url()} -> ${String(response.status())} ${body}`);
  const newest = (JSON.parse(body) as { data: Payment[] }).data[0];
  if (newest === undefined) throw new Error('the member has no payment: did chargeOnce run?');
  return newest;
}

test.describe('결제 결과 · 환불', () => {
  test('결제 창에서 돌아온 지갑: 결과 안내와 결제 내역', async ({ page, admin }) => {
    await ensureChargePackage(admin);
    await signUp(page, freshEmail());
    await chargeOnce(page);
    const payment = await newestPayment(page);
    expect(payment.status).toBe('succeeded');

    // Where the ReturnUrl sends the browser after an approval.
    await page.goto(`/wallet?payment=${payment.id}&result=succeeded`);
    const notice = page.getByTestId('payment-result-notice');
    await expect(notice).toHaveAttribute('data-outcome', 'succeeded');
    await expect(notice).toContainText(copy.paymentResultSucceeded);
    // The fixed wallet notice stays, under the result.
    await expect(page.getByTestId('wallet-notice')).toBeVisible();
    // 결제 내역 lists the charge with its status.
    await expect(
      page.getByTestId(`payment-row-${payment.id}`).getByTestId('payment-status'),
    ).toHaveText(copy.paymentStatusSucceeded);

    // The payment's current status outranks the URL: a `pending` return of a payment that has
    // since been credited reads as the success it is.
    await page.goto(`/wallet?payment=${payment.id}&result=pending`);
    await expect(notice).toHaveAttribute('data-outcome', 'succeeded');

    // No payment id — a return the API could not tie to a payment: the URL's word alone.
    await page.goto('/wallet?result=stopped');
    await expect(notice).toHaveAttribute('data-outcome', 'stopped');
    await expect(notice).toContainText(copy.paymentResultStopped);

    // No result, no notice.
    await page.goto('/wallet');
    await expect(page.getByTestId('wallet-notice')).toBeVisible();
    await expect(notice).toHaveCount(0);
  });

  test('관리자 환불: 원장에 결제 취소(환불) · 잔고 감소 · 두 번째 환불은 거절', async ({
    browser,
    page,
    admin,
  }) => {
    await ensureChargePackage(admin);
    await signUp(page, freshEmail());
    await chargeOnce(page);
    const payment = await newestPayment(page);
    const amountP = BigInt(payment.amountP);

    // The balance before: the sign-up bonus plus this charge, so the charge's P is all unused.
    await page.goto('/wallet');
    const available = page.getByTestId('wallet-available');
    await expect(available).toBeVisible();
    const before = await availableP(available);
    expect(before).toBeGreaterThanOrEqual(amountP);

    // --- the refund through the ADMIN UI, in a second browser signed in as the seed admin.
    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto('/admin/payments');
      const row = adminPage.getByTestId(`admin-payment-${payment.id}`);
      await expect(row.getByTestId('admin-payment-status')).toHaveText(copy.paymentStatusSucceeded);
      await row.getByTestId(`admin-payment-refund-${payment.id}`).click();
      // The reason is required: an empty one is refused under the field, nothing is sent.
      await adminPage.getByTestId('payment-refund-confirm').click();
      await expect(adminPage.getByText(copy.errRefundReason)).toBeVisible();
      await adminPage.getByTestId('payment-refund-reason').fill('e2e 청약철회 요청');
      await adminPage.getByTestId('payment-refund-confirm').click();
      await expect(adminPage.getByText(copy.adminPaymentRefunded)).toBeVisible();
      await expect(row.getByTestId('admin-payment-status')).toHaveText(copy.paymentStatusRefunded);
      // A refunded payment offers no second refund.
      await expect(row.getByTestId(`admin-payment-refund-${payment.id}`)).toHaveCount(0);
    } finally {
      await adminContext.close();
    }

    // --- the member: the P went back out, with a ledger row of its own saying why.
    await page.goto('/wallet');
    await expect(page.getByTestId('ledger-list')).toContainText(copy.ledgerTypePaymentCancel);
    await expect.poll(() => availableP(available)).toBe(before - amountP);
    await expect(
      page.getByTestId(`payment-row-${payment.id}`).getByTestId('payment-status'),
    ).toHaveText(copy.paymentStatusRefunded);

    // --- refunding it again is refused (the API, since the UI no longer offers it), and
    // nothing moves.
    const again = await admin.post(`/api/v1/admin/payments/${payment.id}/refund`, {
      data: { reason: 'e2e 두 번째 환불' },
    });
    expect(again.status()).toBe(409);
    expect(await again.json()).toMatchObject({
      error: { code: 'REFUND_NOT_ALLOWED', details: [{ path: ['payment'], message: 'status' }] },
    });
    await page.reload();
    await expect.poll(() => availableP(available)).toBe(before - amountP);
  });
});
