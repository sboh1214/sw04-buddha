import type { APIRequestContext, APIResponse, Request } from '@playwright/test';
import type { ApplyRegrantResult, LedgerEntry, RegrantStatus } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  type RegrantSettingName,
  adminAccount,
  coinText,
  createOpenMarket,
  dataOf,
  expect,
  expectNoSideScroll,
  freshEmail,
  meOf,
  placeOrder,
  regrantSettingValues,
  signIn,
  signUp,
  startCoinValue,
  test,
} from './helpers';

/**
 * 재지급 (#74, ADR-0155; N01 §2; owner answers 2026-11-21) as a member sees it: the wallet's card
 * is always there (answer 10); a fresh account, holding its start Coin, is not exhausted, so the
 * card lists the amount, the threshold, the period and the cap with its button off and the reason
 * with its number; while a setting is 미정 the card says '준비 중' (answer 12, drawn from the API's
 * own answer rewritten — this database has values). A member whose 가용 코인 ran down to the
 * threshold — through two trades against a counterparty, the member's contracts sold back so none
 * is held (answer 7) — is refused while an order of theirs waits (answer 2), and once it is
 * cancelled applies in the wallet: one press — a double click sends one request — gives the amount
 * at once (answer 3), the card says so, the ledger has its '재지급' row (and its filter), and the
 * same request id sent again answers that re-grant (`replayed`) rather than a second one (N01 §9),
 * while a new one is refused with the status as its details. The admins' 재지급 기록 lists it
 * (answer 3: records only).
 *
 * The suite's global setup enters the six release settings while they are 미정
 * (`ensureRegrantSettings`): the threshold 10,000 Coin under the start Coin, 50,000 Coin a
 * re-grant, no 대기기간, three in 30 days, 500,000 Coin in all. The values in force are read, not
 * assumed; a database whose values leave no way to reach the threshold in a test — a 대기기간, a
 * threshold at or above the start Coin or under 100 Coin — or that would refuse the second re-grant
 * for another reason than 소진 — an amount under 98 Coin, a period limit under two, a cap under two
 * re-grants — skips both tests, before any sign-up. Three sign-ups in all (the fresh member; the
 * member and the counterparty), each sending a handful of orders, under the 20 a minute (#119).
 */

const STATUS = '/api/v1/me/regrant';

/** The threshold the spend-down can reach: a sale back at 1 leaves at most 97 Coin to spare. */
const LOWEST_REACHABLE_THRESHOLD = 100;

/** What one contract bought at 99 and sold back at 1 costs the member. */
const LOSS_PER_CONTRACT = 98n;

/** The six in force, numbers all, or the test skipped (the file's header). */
async function regrantValues(
  admin: APIRequestContext,
): Promise<Readonly<Record<RegrantSettingName, number>>> {
  const values = await regrantSettingValues(admin);
  const startCoin = await startCoinValue(admin);
  const {
    thresholdCoin: threshold,
    amountCoin: amount,
    waitHours,
    periodDays,
    periodLimit,
    totalCapCoin: cap,
  } = values;
  const usable =
    startCoin !== null &&
    threshold !== null &&
    amount !== null &&
    waitHours === 0 &&
    periodDays !== null &&
    periodLimit !== null &&
    cap !== null &&
    threshold >= LOWEST_REACHABLE_THRESHOLD &&
    threshold < startCoin &&
    // After its grant the second test expects `not_exhausted` alone: the grant lifts the member
    // above the threshold (the spend-down leaves at most 97 under it), and a second one would fit
    // the period and the cap.
    amount >= Number(LOSS_PER_CONTRACT) &&
    periodLimit >= 2 &&
    cap >= 2 * amount;
  test.skip(
    !usable,
    `the re-grant settings in force (${JSON.stringify(values)}, start Coin ${String(startCoin)}) ` +
      'do not fit these tests here (the header): global-setup.ts enters its own while they are 미정',
  );
  return values as Record<RegrantSettingName, number>;
}

/** `GET /me/regrant` of `context`'s account. */
async function statusOf(context: APIRequestContext): Promise<RegrantStatus> {
  return dataOf<RegrantStatus>(await context.get(STATUS));
}

/** `POST /me/regrant` as `context`'s account, under `requestId`. */
async function sendRegrant(context: APIRequestContext, requestId: string): Promise<APIResponse> {
  return context.post(STATUS, {
    headers: { 'Idempotency-Key': requestId },
    data: { expectedAccountId: (await meOf(context)).id },
  });
}

/** The error envelope of a refused answer. */
async function refusalOf(response: APIResponse): Promise<{ code: string; details?: unknown }> {
  return ((await response.json()) as { error: { code: string; details?: unknown } }).error;
}

/**
 * Brings `member`'s 가용 코인 to `target` or under, with nothing left waiting and nothing held: per
 * round, `counterparty`'s NO bid of the quantity at 1 rests and the member's YES buy at 99 meets it
 * as one pair mint (99 a contract), then the counterparty's YES bid at 1 rests and the member sells
 * every YES back into it (1 a contract) — 98 a contract gone, the member's position 0 (a market
 * sold out entirely holds nothing, owner answer 7). 지정가 (GTC) both: the 가격 보호 폭 narrows only
 * an immediate order (#119). Rounds until the balance is there, the quantity what the Coin above
 * the target asks and the balance pays for. Returns the 가용 코인 it ends at.
 */
async function spendDownTo(
  member: APIRequestContext,
  counterparty: APIRequestContext,
  marketId: string,
  target: bigint,
): Promise<bigint> {
  for (let round = 0; round < 6; round += 1) {
    const available = BigInt((await meOf(member)).balance.availableCoin);
    if (available <= target) return available;
    const over = available - target;
    const needed = (over + LOSS_PER_CONTRACT - 1n) / LOSS_PER_CONTRACT;
    const affordable = available / 99n;
    const qty = Number(needed < affordable ? needed : affordable);
    if (qty < 1) throw new Error(`${String(available)} Coin cannot buy a contract at 99`);
    const order = (context: APIRequestContext, terms: Parameters<typeof placeOrder>[3]) =>
      placeOrder(context, marketId, crypto.randomUUID(), terms);
    await order(counterparty, {
      outcome: 'NO',
      side: 'buy',
      timeInForce: 'gtc',
      limitPriceCoin: 1,
      qty,
    });
    const bought = await order(member, {
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'gtc',
      limitPriceCoin: 99,
      qty,
    });
    expect(bought.order.status).toBe('filled');
    await order(counterparty, {
      outcome: 'YES',
      side: 'buy',
      timeInForce: 'gtc',
      limitPriceCoin: 1,
      qty,
    });
    const sold = await order(member, {
      outcome: 'YES',
      side: 'sell',
      timeInForce: 'gtc',
      limitPriceCoin: 1,
      qty,
    });
    expect(sold.order.status).toBe('filled');
  }
  throw new Error(`the balance did not come down to ${String(target)} Coin`);
}

test.describe('재지급 (#74)', () => {
  test('지갑에는 재지급 카드가 늘 있고, 시작 Coin만 가진 계정은 기준을 넘어 신청이 꺼져 있으며, 설정이 미정이면 준비 중이다', async ({
    page,
    admin,
  }) => {
    const values = await regrantValues(admin);
    await signUp(page, freshEmail());

    // The API: open, refused for the balance alone, every number the settings' — and a request
    // now is refused with that same status as its details, nothing written.
    const status = await statusOf(page.request);
    expect(status).toMatchObject({
      open: true,
      eligible: false,
      refusals: ['not_exhausted'],
      amountCoin: String(values.amountCoin),
      thresholdCoin: String(values.thresholdCoin),
      waitHours: 0,
      periodDays: values.periodDays,
      periodLimit: values.periodLimit,
      periodUsed: 0,
      totalCapCoin: String(values.totalCapCoin),
      totalGrantedCoin: '0',
      remainingCapCoin: String(values.totalCapCoin),
    });
    const refused = await sendRegrant(page.request, crypto.randomUUID());
    expect(refused.status()).toBe(409);
    expect(await refusalOf(refused)).toMatchObject({
      code: 'REGRANT_NOT_ALLOWED',
      details: status,
    });

    // The card, under the balance: the four numbers, the conditions, the reason with the
    // threshold, and 재지급 신청 off.
    await page.goto('/my/wallet');
    const card = page.getByTestId('regrant-card');
    await expect(card).toContainText(copy.regrantTitle);
    await expect(card.getByTestId('regrant-panel')).toHaveAttribute('data-eligible', 'false');
    await expect(card.getByTestId('regrant-amount')).toHaveText(coinText(values.amountCoin));
    await expect(card.getByTestId('regrant-threshold')).toHaveText(
      `${copy.walletBalance} ${coinText(values.thresholdCoin)} ${copy.regrantAtOrBelow}`,
    );
    await expect(card.getByTestId('regrant-period')).toHaveText(
      `최근 ${String(values.periodDays)}일 ${String(values.periodLimit)}회 중 ` +
        `${String(values.periodLimit)}회`,
    );
    await expect(card.getByTestId('regrant-remaining-cap')).toHaveText(
      `${coinText(values.totalCapCoin)} (${copy.regrantTotalCap} ${coinText(values.totalCapCoin)})`,
    );
    await expect(card.getByTestId('regrant-conditions')).toHaveText(copy.regrantConditions);
    const reasons = card.getByTestId('regrant-refusal');
    await expect(reasons).toHaveCount(1);
    await expect(reasons).toHaveAttribute('data-reason', 'not_exhausted');
    await expect(reasons).toHaveText(
      `${copy.regrantRefusalNotExhaustedLead} ${coinText(values.thresholdCoin)} ` +
        copy.regrantRefusalNotExhaustedTail,
    );
    await expect(card.getByTestId('regrant-apply')).toBeDisabled();
    // The ledger's filter offers 재지급 after the five (#74), before 판정 오류 보상 (#144).
    await expect(page.getByTestId('wallet-kind').locator('option').nth(-2)).toHaveText(
      copy.ledgerTypeRegrant,
    );
    await expectNoSideScroll(page);

    // A setting 미정: '준비 중' alone, the button off — drawn from the API's own answer rewritten.
    await page.route(`**${STATUS}`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const body = (await response.json()) as { data: RegrantStatus };
      body.data = {
        open: false,
        eligible: false,
        refusals: ['not_ready'],
        amountCoin: null,
        thresholdCoin: null,
        waitHours: null,
        waitUntil: null,
        periodDays: null,
        periodLimit: null,
        periodUsed: null,
        nextPeriodAt: null,
        totalCapCoin: null,
        totalGrantedCoin: null,
        remainingCapCoin: null,
      };
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect(card.getByTestId('regrant-not-ready')).toHaveText(copy.regrantNotReady);
    await expect(card.getByTestId('regrant-amount')).toHaveCount(0);
    await expect(card.getByTestId('regrant-refusal')).toHaveCount(0);
    await expect(card.getByTestId('regrant-apply')).toBeDisabled();
  });

  test('가용 코인을 기준까지 쓴 회원은 대기 주문이 있는 동안 거절되고, 주문을 취소하면 지갑에서 한 번 신청해 바로 받으며, 같은 요청 ID는 한 번만 준다', async ({
    page,
    admin,
    browser,
  }) => {
    test.slow();
    const values = await regrantValues(admin);
    const market = await createOpenMarket(admin);
    const counterpartyContext = await browser.newContext();
    const adminContext = await browser.newContext();
    try {
      const counterpartyPage = await counterpartyContext.newPage();
      await signUp(counterpartyPage, freshEmail());
      await signUp(page, freshEmail());
      const member = page.request;
      const counterparty = counterpartyPage.request;

      // --- Down to the threshold, nothing waiting and nothing held.
      const spent = await spendDownTo(
        member,
        counterparty,
        market.id,
        BigInt(values.thresholdCoin),
      );
      expect(spent).toBeLessThanOrEqual(BigInt(values.thresholdCoin));
      expect(await statusOf(member)).toMatchObject({ open: true, eligible: true, refusals: [] });

      // --- An order of the member's waits (a NO bid at 1 nothing meets): refused for it, the
      // card says why with its button off.
      const resting = await placeOrder(member, market.id, crypto.randomUUID(), {
        outcome: 'NO',
        side: 'buy',
        timeInForce: 'gtc',
        limitPriceCoin: 1,
        qty: 1,
      });
      expect(resting.order.status).toBe('open');
      expect((await statusOf(member)).refusals).toEqual(['live_orders']);
      await page.goto('/my/wallet');
      const card = page.getByTestId('regrant-card');
      const reasons = card.getByTestId('regrant-refusal');
      await expect(reasons).toHaveCount(1);
      await expect(reasons).toHaveAttribute('data-reason', 'live_orders');
      await expect(reasons).toHaveText(copy.regrantRefusalLiveOrders);
      await expect(card.getByTestId('regrant-apply')).toBeDisabled();

      // --- Cancelled, its lock back (still at the threshold or under): the button is on.
      const cancelled = await member.post(`/api/v1/me/orders/${resting.order.id}/cancel`, {
        data: { expectedAccountId: (await meOf(member)).id },
      });
      expect(cancelled.ok(), await cancelled.text()).toBe(true);
      const before = BigInt((await meOf(member)).balance.availableCoin);
      expect(before).toBe(spent);
      await page.reload();
      await expect(card.getByTestId('regrant-panel')).toHaveAttribute('data-eligible', 'true');
      await expect(card.getByTestId('regrant-refusal')).toHaveCount(0);
      const apply = card.getByTestId('regrant-apply');
      await expect(apply).toBeEnabled();

      // --- A double click sends one request; the re-grant is given at once and said so.
      const sent: Request[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === STATUS) {
          sent.push(request);
        }
      });
      await apply.dblclick();
      const amount = coinText(values.amountCoin);
      await expect(card.getByTestId('regrant-granted')).toHaveText(
        `${copy.regrantGrantedLead} ${amount}${copy.regrantGrantedTail}`,
      );
      await expect(card.getByTestId('regrant-granted')).toHaveAttribute('role', 'status');
      expect(sent).toHaveLength(1);
      const requestId = sent[0]?.headers()['idempotency-key'];
      expect(requestId).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
      // The balance, the ledger's newest row, and the card now above the threshold again.
      const after = before + BigInt(values.amountCoin);
      await expect(page.getByTestId('wallet-available')).toHaveText(coinText(String(after)));
      const ledger = page.getByTestId('ledger-list');
      await expect(ledger.getByTestId('ledger-type').first()).toHaveText(copy.ledgerTypeRegrant);
      await expect(ledger.getByTestId('ledger-amount').first()).toHaveText(`+${amount}`);
      await expect(card.getByTestId('regrant-period')).toHaveText(
        `최근 ${String(values.periodDays)}일 ${String(values.periodLimit)}회 중 ` +
          `${String(values.periodLimit - 1)}회`,
      );
      await expect(card.getByTestId('regrant-apply')).toBeDisabled();

      // --- The API: one REGRANT entry; the same request id answers it again (replayed), a new
      // one is refused with the status as its details, and nothing more is given.
      const entries = await dataOf<LedgerEntry[]>(
        await member.get('/api/v1/me/ledger?kind=REGRANT'),
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kind: 'REGRANT',
        amountCoin: String(values.amountCoin),
        balanceAfterCoin: String(after),
        refType: 'regrant',
      });
      const replay = await dataOf<ApplyRegrantResult>(await sendRegrant(member, requestId ?? ''));
      expect(replay).toMatchObject({
        replayed: true,
        regrant: { id: entries[0]?.refId, amountCoin: String(values.amountCoin) },
      });
      const again = await sendRegrant(member, crypto.randomUUID());
      expect(again.status()).toBe(409);
      const refusal = await refusalOf(again);
      expect(refusal.code).toBe('REGRANT_NOT_ALLOWED');
      expect(refusal.details).toMatchObject({
        eligible: false,
        refusals: ['not_exhausted'],
        periodUsed: 1,
        totalGrantedCoin: String(values.amountCoin),
      });
      expect(
        await dataOf<LedgerEntry[]>(await member.get('/api/v1/me/ledger?kind=REGRANT')),
      ).toHaveLength(1);
      expect(BigInt((await meOf(member)).balance.availableCoin)).toBe(after);

      // --- The ledger's 재지급 filter: its address and its one row.
      await page.goto('/my/wallet?kind=regrant');
      await expect(page.getByTestId('wallet-kind')).toHaveValue('REGRANT');
      await expect(page.getByTestId('ledger-list').getByTestId('ledger-type')).toHaveText([
        copy.ledgerTypeRegrant,
      ]);

      // --- The admins' 재지급 기록, from the admin menu: the record with the member's nickname,
      // the Coin given and the 가용 코인 read before it.
      const nickname = (await meOf(member)).profile.nickname;
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto('/admin/markets');
      await adminPage
        .getByTestId('admin-nav')
        .getByRole('link', { name: copy.adminRegrants, exact: true })
        .click();
      await expect(adminPage).toHaveURL('/admin/regrants');
      const record = adminPage.getByTestId(`admin-regrant-${entries[0]?.refId ?? ''}`);
      await expect(record.getByTestId('admin-regrant-account')).toHaveText(nickname);
      await expect(record.getByTestId('admin-regrant-amount')).toHaveText(
        `${copy.adminRegrantAmount} ${amount}`,
      );
      await expect(record.getByTestId('admin-regrant-available-before')).toHaveText(
        `${copy.adminRegrantAvailableBefore} ${coinText(String(before))}`,
      );
    } finally {
      await adminContext.close();
      await counterpartyContext.close();
    }
  });
});
