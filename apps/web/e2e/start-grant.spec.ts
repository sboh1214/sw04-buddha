import type { Route } from '@playwright/test';
import type { LedgerEntry, Me, StartGrant } from '@buddha/shared';
import { copy } from '../src/copy';
import { expect, freshEmail, signUp, test } from './helpers';

/**
 * 시작 Coin (#70, ADR-0071) as a member sees it: creating an account grants nothing, and the
 * onboarding's nickname step (#58) records the account's start Coin — paid when the release setting
 * 시작 지급액 has a value, waiting otherwise — and the wallet — its balance card and MY 요약's
 * wallet preview (owner decision 2026-10-18) — says the start Coin is on its way only while it
 * waits (ADR-0069 decision 4 #70).
 *
 * The e2e database has no value for 시작 지급액 and no spec enters one: a value entered here would
 * be paid by the worker to every account any spec made, which would break every spec that counts
 * a new account's Coin. So the waiting wallet is the real one, and the paid wallet is drawn from the
 * API's answers rewritten in the browser (`page.route`), the way phone-verification.spec.ts rewrites
 * a send's answer; paying once a value is entered is pinned by the API, db and worker suites.
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
  test('온보딩을 마친 계정의 시작 Coin은 지급액이 정해질 때까지 기다리고, 지갑과 MY 요약의 지갑 미리보기에 그 안내가 보인다', async ({
    page,
    admin,
  }) => {
    // The state every spec relies on: no value, so every grant waits.
    const settings = await dataOf<{ key: string; value: unknown }[]>(
      await admin.get('/api/v1/admin/release-settings'),
    );
    expect(settings.find((item) => item.key === 'grant.start_coin')?.value ?? null).toBeNull();

    await signUp(page, freshEmail());

    // The API: one grant record, waiting; nothing paid, so a zero balance and an empty ledger — the
    // sign-up trigger's 10,000 Coin and its BONUS entry are gone (migration 0031).
    const me = await dataOf<Me>(await page.request.get('/api/v1/me'));
    expect(me.startGrant).toEqual({ status: 'pending', amountCoin: null, grantedAt: null });
    expect(me.balance).toEqual({ availableCoin: '0', lockedCoin: '0' });
    expect(await dataOf<LedgerEntry[]>(await page.request.get('/api/v1/me/ledger'))).toEqual([]);

    await page.goto('/my/wallet');
    const notice = page.getByTestId('wallet-start-grant-pending');
    await expect(notice).toHaveText(copy.walletStartGrantPending);
    // Under the balance it explains, which is the real 0.
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
    await signUp(page, freshEmail());
    await page.route('**/api/v1/me', (route) =>
      route.request().method() === 'GET'
        ? rewriteMe(route, { status: 'number_used', amountCoin: null, grantedAt: null })
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

  test('지급되면 지갑과 MY 요약의 안내 대신 원장의 시작 지급이 보인다', async ({ page }) => {
    await signUp(page, freshEmail());
    const notice = page.getByTestId('wallet-start-grant-pending');

    // --- paid: the profile says granted and the ledger holds the one START_GRANT entry.
    const grantedAt = new Date().toISOString();
    await page.route('**/api/v1/me', (route) =>
      route.request().method() === 'GET'
        ? rewriteMe(route, { status: 'granted', amountCoin: '10000', grantedAt }, '10000')
        : route.fallback(),
    );
    await page.route('**/api/v1/me/ledger*', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { data: LedgerEntry[] };
      const entry: LedgerEntry = {
        id: '1',
        type: 'START_GRANT',
        amountCoin: '10000',
        balanceAfterCoin: '10000',
        refType: 'start_grant',
        refId: '00000000-0000-4000-8000-000000000000',
        memo: null,
        createdAt: grantedAt,
      };
      await route.fulfill({ response, json: { ...body, data: [entry] } });
    });
    await page.goto('/my/wallet');
    await expect(page.getByTestId('wallet-available')).toHaveText('10,000 Coin');
    await expect(notice).toHaveCount(0);
    const row = page.getByTestId('ledger-list').getByTestId('ledger-type');
    await expect(row).toHaveText(copy.ledgerTypeStartGrant);
    await expect(page.getByTestId('ledger-amount')).toHaveText('+10,000 Coin');
    // And the preview: the balance and the 시작 지급 row, no notice.
    await page.goto('/my');
    const preview = page.getByTestId('my-preview-wallet');
    // The 가용 figure itself, not the ledger row's '+10,000 Coin' beside it.
    await expect(preview.getByTestId('my-preview-wallet-available')).toHaveText('10,000 Coin');
    await expect(preview.getByTestId('ledger-type')).toHaveText(copy.ledgerTypeStartGrant);
    await expect(preview.getByTestId('ledger-amount')).toHaveText('+10,000 Coin');
    await expect(preview.getByTestId('my-preview-wallet-start-grant-pending')).toHaveCount(0);
  });
});
