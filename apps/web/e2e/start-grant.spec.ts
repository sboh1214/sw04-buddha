import type { Route } from '@playwright/test';
import type { LedgerEntry, Me, StartGrant } from '@buddha/shared';
import { copy } from '../src/copy';
import { expect, freshEmail, signUp, startCoinText, startCoinValue, test } from './helpers';

/**
 * 시작 Coin (#70, ADR-0071) as a member sees it: creating an account grants nothing, and the
 * onboarding's nickname step (#58) records the account's start Coin — paid when the release setting
 * 시작 지급액 has a value, waiting otherwise — and the wallet — its balance card and MY 요약's
 * wallet preview (owner decision 2026-10-18) — says the start Coin is on its way only while it
 * waits (ADR-0069 decision 4 #70).
 *
 * The e2e database has a value for 시작 지급액 since #116: the suite's global setup enters one as a
 * 시험값 while it is 미정 (global-setup.ts; ADR-0107 결정 2 #73 7항 "e2e는 시험 DB의 시작 지급
 * 설정값으로 Coin을 받는다" — no admin adjusts a balance any more). So the paid wallet is the real
 * one, its amount the value in force (`startCoinValue`), and the waiting wallet is drawn from the
 * API's answers rewritten in the browser (`page.route`), the way phone-verification.spec.ts rewrites
 * a send's answer; waiting while the value is 미정, and the worker paying once it is entered, are
 * pinned by the API, db and worker suites.
 */

/** `{ data }` out of the success envelope. */
async function dataOf<T>(response: {
  ok(): boolean;
  text(): Promise<string>;
  url(): string;
}): Promise<T> {
  const body = await response.text();
  if (!response.ok()) throw new Error(`${response.url()} -> ${body}`);
  return (JSON.parse(body) as { data: T }).data;
}

/** The API's own `GET /me` answer with `startGrant` (and the balance, when given) replaced. */
async function rewriteMe(
  route: Route,
  startGrant: StartGrant | null,
  availableCoin?: string,
): Promise<void> {
  const response = await route.fetch();
  const body = (await response.json()) as { data: Me };
  body.data.startGrant = startGrant;
  if (availableCoin !== undefined) body.data.balance.availableCoin = availableCoin;
  await route.fulfill({ response, json: body });
}

test.describe('시작 Coin (#70)', () => {
  test('시작 Coin이 지급액을 기다리는 동안에는 지갑과 MY 요약의 지갑 미리보기에 그 안내가 보인다', async ({
    page,
  }) => {
    // A grant waiting for its amount (the setting 미정), drawn from the API's own answers
    // rewritten: this database has a value, so the account below is paid at once.
    await signUp(page, freshEmail());
    await page.route('**/api/v1/me', (route) =>
      route.request().method() === 'GET'
        ? rewriteMe(route, { status: 'pending', amountCoin: null, grantedAt: null }, '0')
        : route.fallback(),
    );
    await page.route('**/api/v1/me/ledger*', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { data: LedgerEntry[] };
      await route.fulfill({ response, json: { ...body, data: [] } });
    });

    await page.goto('/my/wallet');
    const notice = page.getByTestId('wallet-start-grant-pending');
    await expect(notice).toHaveText(copy.walletStartGrantPending);
    // Under the balance it explains, the 0 of an account paid nothing yet.
    await expect(page.getByTestId('wallet-balance')).toContainText(copy.walletStartGrantPending);
    await expect(page.getByTestId('wallet-available')).toHaveText('0 Coin');
    await expect(page.getByTestId('ledger-list')).toContainText(copy.ledgerEmpty);
    // The fixed notice above stays as it was.
    await expect(page.getByTestId('wallet-notice')).toHaveText(copy.walletNotice);
    // MY 요약's wallet preview tells it too, under the same balance (owner decision 2026-10-18).
    await page.goto('/my');
    const preview = page.getByTestId('my-preview-wallet');
    await expect(preview.getByTestId('my-preview-wallet-start-grant-pending')).toHaveText(
      copy.walletStartGrantPending,
    );
    // The preview's own 가용 figure: 잠금 beside it shows '0 Coin' too.
    await expect(preview.getByTestId('my-preview-wallet-available')).toHaveText('0 Coin');
    await expect(preview).toContainText(copy.ledgerEmpty);
    // Once, in the preview: 잔고 요약 above it does not repeat it.
    await expect(page.getByText(copy.walletStartGrantPending)).toHaveCount(1);
  });

  test('이미 시작 Coin을 받은 번호의 계정의 지갑과 MY 요약에는 지급 대기 안내가 없다', async ({
    page,
  }) => {
    // An account whose verified number's start Coin went to an earlier account (#57-1): the API
    // says `number_used` (ADR-0072), drawn from its own answer rewritten, as nothing in a spec can
    // make that account. Only the onboarding's notice says so; the wallet has nothing to wait for.
    // Its balance is drawn as the 0 such an account holds (this database pays the start Coin).
    await signUp(page, freshEmail());
    await page.route('**/api/v1/me', (route) =>
      route.request().method() === 'GET'
        ? rewriteMe(route, { status: 'number_used', amountCoin: null, grantedAt: null }, '0')
        : route.fallback(),
    );
    await page.goto('/my/wallet');
    await expect(page.getByTestId('wallet-available')).toHaveText('0 Coin');
    await expect(page.getByTestId('wallet-start-grant-pending')).toHaveCount(0);
    // MY 요약's wallet preview says nothing either.
    await page.goto('/my');
    await expect(page.getByTestId('my-preview-wallet-available')).toHaveText('0 Coin');
    await expect(page.getByTestId('my-preview-wallet-start-grant-pending')).toHaveCount(0);
  });

  test('온보딩을 마친 계정은 시작 Coin을 받고, 지갑과 MY 요약에는 안내 대신 원장의 시작 지급이 보인다', async ({
    page,
    admin,
  }) => {
    // The value the global setup entered (or one already there): every grant is paid with it.
    const startCoin = await startCoinValue(admin);
    expect(startCoin).not.toBeNull();
    const amount = String(startCoin);
    const shown = await startCoinText(admin);

    await signUp(page, freshEmail());

    // The API: one grant record, paid at the nickname step; the balance is the start Coin and the
    // ledger holds the one START_GRANT entry (#116: minted into the account's own ledger account).
    const me = await dataOf<Me>(await page.request.get('/api/v1/me'));
    expect(me.startGrant).toMatchObject({ status: 'granted', amountCoin: amount });
    expect(me.balance).toEqual({ availableCoin: amount, lockedCoin: '0' });
    const ledger = await dataOf<LedgerEntry[]>(await page.request.get('/api/v1/me/ledger'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      type: 'START_GRANT',
      amountCoin: amount,
      balanceAfterCoin: amount,
      refType: 'start_grant',
    });

    await page.goto('/my/wallet');
    await expect(page.getByTestId('wallet-available')).toHaveText(shown);
    await expect(page.getByTestId('wallet-start-grant-pending')).toHaveCount(0);
    const row = page.getByTestId('ledger-list').getByTestId('ledger-type');
    await expect(row).toHaveText(copy.ledgerTypeStartGrant);
    await expect(page.getByTestId('ledger-amount')).toHaveText(`+${shown}`);
    // And the preview: the balance and the 시작 지급 row, no notice.
    await page.goto('/my');
    const preview = page.getByTestId('my-preview-wallet');
    // The 가용 figure itself, not the ledger row's '+…' beside it.
    await expect(preview.getByTestId('my-preview-wallet-available')).toHaveText(shown);
    await expect(preview.getByTestId('ledger-type')).toHaveText(copy.ledgerTypeStartGrant);
    await expect(preview.getByTestId('ledger-amount')).toHaveText(`+${shown}`);
    await expect(preview.getByTestId('my-preview-wallet-start-grant-pending')).toHaveCount(0);
  });
});
