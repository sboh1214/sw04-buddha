import type { APIResponse, Locator, Page } from '@playwright/test';
import type { Me } from '@buddha/shared';
import { copy } from '../src/copy';
import { createOpenMarket, expect, freshEmail, signUp, test } from './helpers';

/**
 * 금액 표기 (#13, ADR-0051): `formatCoin` writes '12,345 Coin' with an ORDINARY space before the
 * unit, four characters longer than the '12,345P' it replaced. On a narrow screen that could
 * leave 'Coin' on a line of its own or push the amount past the edge, so the spots the issue
 * names are measured at 375px: the header's balance chip (and the row it shares with the wordmark
 * and the search), a market card's 거래량 and the wallet's balance.
 *
 * The balance is raised to 1,000,000 Coin first — seven digits, the largest single adjustment an
 * admin can make (`ADJUST_MAX_ABS_COIN`) — so the chip is measured with a long amount rather than
 * whatever the sign-up bonus happens to be. The account is a fresh one: the seed admin's balance
 * is read by other specs running alongside this one.
 *
 * A card's volume cannot be raised that way: a new market has no fill and the API has no order
 * path to make one, and the home page renders its cards on the server, so `page.route` cannot
 * rewrite the figure either. The card is measured as it renders ('0 Coin') and then with a
 * nine-digit figure written into the same element, which keeps the card's own styles.
 */

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${response.url()} -> ${String(response.status())} ${body}`);
  }
  return (JSON.parse(body) as { data: T }).data;
}

/**
 * How an element's text lies on screen: how many lines its glyphs take (two fragments share a
 * line when their vertical extents overlap) and the left and right edges of the text.
 */
function textLayout(locator: Locator) {
  return locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    const lines: { top: number; bottom: number }[] = [];
    for (const rect of rects) {
      const line = lines.find((l) => rect.top < l.bottom && rect.bottom > l.top);
      if (line === undefined) {
        lines.push({ top: rect.top, bottom: rect.bottom });
      } else {
        line.top = Math.min(line.top, rect.top);
        line.bottom = Math.max(line.bottom, rect.bottom);
      }
    }
    return {
      lines: lines.length,
      left: Math.min(...rects.map((r) => r.left)),
      right: Math.max(...rects.map((r) => r.right)),
    };
  });
}

/**
 * The left and right edges of what the header's first row paints, in order: the wordmark, the
 * search icon (below md the search is a 36px button around a 16px glyph) and the balance chip,
 * which ends the row now that there is no profile menu (#16). The glyph rather than its button,
 * because a long balance may push the button's empty padding up to the wordmark without covering
 * a single letter of it.
 */
function headerRow(page: Page) {
  return page.evaluate(() => {
    const edges = (selector: string) => {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`${selector} is not on the page`);
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    };
    return [
      edges('header h1'),
      edges('[data-testid="nav-search-toggle"] svg'),
      edges('[data-testid="balance-chip"]'),
    ];
  });
}

/** One line, wholly inside the viewport, and the page itself does not scroll sideways. */
async function expectOneLineOnScreen(page: Page, locator: Locator, name: string) {
  const layout = await textLayout(locator);
  const viewport = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.lines, `${name}: lines`).toBe(1);
  expect(layout.left, `${name}: left edge`).toBeGreaterThanOrEqual(0);
  expect(layout.right, `${name}: right edge`).toBeLessThanOrEqual(viewport.width);
  expect(viewport.scrollWidth, `${name}: page width`).toBeLessThanOrEqual(viewport.width);
  return layout;
}

test.describe('금액 표기 · 375px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('잔고 칩·시장 카드 거래량·지갑 잔고가 한 줄에 잘리지 않고 보인다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());

    const me = await dataOf<Me>(await page.request.get('/api/v1/me'));
    const delta = 1_000_000n - BigInt(me.balance.availableCoin);
    if (delta !== 0n) {
      await dataOf(
        await admin.post(`/api/v1/admin/users/${me.id}/balance-adjust`, {
          data: { amountCoin: delta.toString(), memo: 'e2e 금액 표기' },
        }),
      );
    }

    // --- the header chip and the card, on a home page holding exactly this market's card.
    await page.goto(`/?q=${market.tag}`);
    const chip = page.getByTestId('balance-chip');
    await expect(chip).toContainText('1,000,000 Coin');
    await expectOneLineOnScreen(page, chip, 'balance chip');
    // Nothing in the row covers its neighbour: each item ends before the next one starts.
    const row = await headerRow(page);
    for (let i = 1; i < row.length; i += 1) {
      expect(row[i]!.left, `header item ${String(i)}`).toBeGreaterThanOrEqual(row[i - 1]!.right);
    }

    const card = page.getByTestId(`market-card-${market.id}`);
    const volume = card.getByTestId('market-card-volume');
    // One line, left of the sparkline, and the sparkline still inside the card.
    const expectVolumeFits = async (name: string) => {
      const layout = await expectOneLineOnScreen(page, volume, name);
      const sparkline = await card.getByTestId('market-card-sparkline').boundingBox();
      const box = await card.boundingBox();
      if (sparkline === null || box === null) throw new Error('the card has no bounding box');
      expect(layout.right, `${name}: beside the sparkline`).toBeLessThanOrEqual(sparkline.x);
      expect(sparkline.x + sparkline.width, `${name}: sparkline`).toBeLessThanOrEqual(
        box.x + box.width,
      );
    };
    // No fill yet, so nothing has traded: the volume is 0, written the same way as any other.
    await expect(volume).toHaveText(`${copy.marketVolume} 0 Coin`);
    await expectVolumeFits('card volume');
    const longVolume = `${copy.marketVolume} 123,456,789 Coin`;
    await volume.evaluate((element, text) => {
      element.textContent = text;
    }, longVolume);
    await expect(volume).toHaveText(longVolume);
    await expectVolumeFits('long card volume');

    // --- the wallet's balance, the largest type an amount is set in.
    await page.goto('/my/wallet');
    const available = page.getByTestId('wallet-available');
    await expect(available).toHaveText('1,000,000 Coin');
    await expectOneLineOnScreen(page, available, 'wallet balance');
  });
});
