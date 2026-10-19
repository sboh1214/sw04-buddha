import type { Route } from '@playwright/test';
import type { LedgerEntry, Me, StartGrant } from '@buddha/shared';
import { copy } from '../src/copy';
import { expect, freshEmail, signUp, test } from './helpers';

/**
 * 시작 Coin (#70, ADR-0071) as a member sees it before the onboarding (#58) calls the grant:
 * creating an account grants nothing — every sign-up starts at 0 Coin with no ledger entry — and
 * the wallet — its balance card and MY 요약's wallet preview (owner decision 2026-10-18) — says the
 * start Coin is on its way only while the account's grant waits for its amount (ADR-0069 decision
 * 4 #70).
 *
 * Nothing in this build records a grant on a request: the grant has no route, and #58 is not here
 * yet. So the waiting and the paid wallet are drawn from the API's answers rewritten in the
 * browser (`page.route`), the way phone-verification.spec.ts rewrites a send's answer; recording,
 * waiting and paying once are pinned by the API, db and worker suites.
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
  startGrant: StartGrant,
  availableCoin?: string,
): Promise<void> {
  const response = await route.fetch();
  const body = (await response.json()) as { data: Me };
  body.data.startGrant = startGrant;
  if (availableCoin !== undefined) body.data.balance.availableCoin = availableCoin;
  await route.fulfill({ response, json: body });
}

test.describe('시작 Coin (#70)', () => {
  test('가입한 계정은 0 Coin이고 원장에 아무것도 없으며 지급 대기 안내도 없다', async ({
    page,
  }) => {
    await signUp(page, freshEmail());

    // The API: no grant record, a zero balance, an empty ledger — the sign-up trigger's 10,000
    // Coin and its BONUS entry are gone (migration 0031).
    const me = await dataOf<Me>(await page.request.get('/api/v1/me'));
    expect(me.startGrant).toBeNull();
    expect(me.balance).toEqual({ availableCoin: '0', lockedCoin: '0' });
    expect(await dataOf<LedgerEntry[]>(await page.request.get('/api/v1/me/ledger'))).toEqual([]);

    await page.goto('/my/wallet');
    await expect(page.getByTestId('wallet-available')).toHaveText('0 Coin');
    await expect(page.getByTestId('ledger-list')).toContainText(copy.ledgerEmpty);
    await expect(page.getByTestId('wallet-start-grant-pending')).toHaveCount(0);
    // MY 요약's wallet preview says nothing either.
    await page.goto('/my');
    await expect(page.getByTestId('my-preview-wallet-available')).toHaveText('0 Coin');
    await expect(page.getByTestId('my-preview-wallet')).toContainText(copy.ledgerEmpty);
    await expect(page.getByTestId('my-preview-wallet-start-grant-pending')).toHaveCount(0);
  });

  test('지급 대기 중이면 지갑과 MY 요약의 지갑 미리보기에 안내가 보이고, 지급되면 안내 대신 원장의 시작 지급이 보인다', async ({
    page,
  }) => {
    await signUp(page, freshEmail());

    // --- waiting: the amount is undecided, so the grant is recorded and nothing is paid.
    await page.route('**/api/v1/me', (route) =>
      route.request().method() === 'GET'
        ? rewriteMe(route, { status: 'pending', amountCoin: null, grantedAt: null })
        : route.fallback(),
    );
    await page.goto('/my/wallet');
    const notice = page.getByTestId('wallet-start-grant-pending');
    await expect(notice).toHaveText(copy.walletStartGrantPending);
    // Under the balance it explains, which is still the real 0.
    await expect(page.getByTestId('wallet-balance')).toContainText(copy.walletStartGrantPending);
    await expect(page.getByTestId('wallet-available')).toHaveText('0 Coin');
    // The fixed notice above stays as it was.
    await expect(page.getByTestId('wallet-notice')).toHaveText(copy.walletNotice);
    // MY 요약's wallet preview tells it too, under the same balance (owner decision 2026-10-18).
    await page.goto('/my');
    const preview = page.getByTestId('my-preview-wallet');
    const previewNotice = preview.getByTestId('my-preview-wallet-start-grant-pending');
    await expect(previewNotice).toHaveText(copy.walletStartGrantPending);
    // The preview's own 가용 figure: 잠금 beside it shows '0 Coin' too.
    const previewAvailable = preview.getByTestId('my-preview-wallet-available');
    await expect(previewAvailable).toHaveText('0 Coin');
    // Once, in the preview: 잔고 요약 above it does not repeat it.
    await expect(page.getByText(copy.walletStartGrantPending)).toHaveCount(1);
    await page.goto('/my/wallet');

    // --- paid: the profile says granted and the ledger holds the one START_GRANT entry.
    const grantedAt = new Date().toISOString();
    await page.unrouteAll({ behavior: 'wait' });
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
    await page.reload();
    await expect(page.getByTestId('wallet-available')).toHaveText('10,000 Coin');
    await expect(notice).toHaveCount(0);
    const row = page.getByTestId('ledger-list').getByTestId('ledger-type');
    await expect(row).toHaveText(copy.ledgerTypeStartGrant);
    await expect(page.getByTestId('ledger-amount')).toHaveText('+10,000 Coin');
    // And the preview: the balance and the 시작 지급 row, no notice.
    await page.goto('/my');
    // The 가용 figure itself, not the ledger row's '+10,000 Coin' beside it.
    await expect(previewAvailable).toHaveText('10,000 Coin');
    await expect(preview.getByTestId('ledger-type')).toHaveText(copy.ledgerTypeStartGrant);
    await expect(preview.getByTestId('ledger-amount')).toHaveText('+10,000 Coin');
    await expect(previewNotice).toHaveCount(0);
  });
});
