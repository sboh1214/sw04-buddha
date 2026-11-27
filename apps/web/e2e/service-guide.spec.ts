import type { Locator, Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  SERVICE_GUIDE_ANCHORS,
  SERVICE_GUIDE_PATH,
  type ServiceGuideAnchor,
  serviceGuideHref,
} from '../src/lib/service-guide';
import {
  createOpenMarket,
  detailCopyTestId,
  expect,
  expectNoSideScroll,
  freshEmail,
  meOf,
  openSetPassword,
  signUp,
  test,
} from './helpers';

/**
 * 서비스 안내 (#136, ADR-0177) at both widths: `/guide` is the same page for a visitor, a member
 * and an account with onboarding steps left (owner answer 136-6), with the eight sections under
 * their anchors and nothing of the account on it; and each entry point the owner answers chose
 * opens it — the footer on every page, the judging record's head at 판정과 이의 (ADR-0107 결정 4
 * #24), the market price notice under the detail's chart at 시장가격의 뜻 (ADR-0135 '남은 것') and
 * the first-order guide on 확인 at 주문 방식 (ADR-0154 #59-4), the last in a new tab. The section
 * an anchor opens stands below the sticky header (`scrollMarginTop`). The sentences, their
 * numbers and their words are the unit tests' (app/(service-guide)/guide/guide-content.test.tsx).
 */

const SECTION_TITLES = [
  copy.serviceGuideContractTitle,
  copy.serviceGuideCollateralTitle,
  copy.serviceGuideOrdersTitle,
  copy.serviceGuideMarketPriceTitle,
  copy.serviceGuideLiquidityTitle,
  copy.serviceGuideJudgementTitle,
  copy.serviceGuideVoidCancelTitle,
  copy.serviceGuideCoinTitle,
];

const guideOf = (page: Page): Locator => page.getByTestId('service-guide');

/** The guide's own HTML in a server render: its `<article>`, from the tag to its end. */
function articleHtml(html: string): string {
  const article = /<article\b[^>]*data-testid="service-guide"[\s\S]*?<\/article>/.exec(html)?.[0];
  expect(article, 'the server HTML has the guide').toBeDefined();
  return article ?? '';
}

/** The title, the eight sections in order under their anchors, and the link to the 이용약관. */
async function expectGuide(page: Page): Promise<void> {
  const guide = guideOf(page);
  await expect(guide.getByRole('heading', { level: 2 })).toHaveText(copy.serviceGuideTitle);
  await expect(guide.getByRole('heading', { level: 3 })).toHaveText(SECTION_TITLES);
  const sections = guide.locator('section');
  await expect(sections).toHaveCount(SERVICE_GUIDE_ANCHORS.length);
  expect(await sections.evaluateAll((all) => all.map((section) => section.id))).toEqual([
    ...SERVICE_GUIDE_ANCHORS,
  ]);
  await expect(guide.getByTestId('service-guide-terms-link')).toHaveAttribute('href', '/terms');
}

/**
 * The guide opened at `anchor`: the address carries it, and its section's heading is on screen
 * below the sticky header — the anchor's scroll stops at the section's `scrollMarginTop`.
 */
async function expectSectionShown(page: Page, anchor: ServiceGuideAnchor): Promise<void> {
  await expect(page).toHaveURL(serviceGuideHref(anchor));
  const heading = page.locator(`section#${anchor}`).getByRole('heading', { level: 3 });
  await expect(heading).toBeInViewport();
  await expect
    .poll(async () => {
      const [header, box] = await Promise.all([
        page.locator('header').first().boundingBox(),
        heading.boundingBox(),
      ]);
      return header !== null && box !== null && box.y >= header.y + header.height - 1;
    }, `${anchor} clears the header`)
    .toBe(true);
}

/** The order panel this width draws (first-order-guide.spec.ts's, restated), on YES. */
async function openPanel(page: Page): Promise<Locator> {
  let place: Locator;
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    place = page.getByTestId('order-area');
  } else {
    place = page.getByTestId('order-sheet');
    if (!(await place.isVisible())) await page.getByTestId('order-entry-yes').click();
  }
  await expect(place.getByTestId('order-panel')).toBeVisible();
  await place.getByTestId('order-contract-yes').click();
  return place;
}

test.describe('서비스 안내 (#136)', () => {
  test('비로그인 방문자와 로그인 회원은 같은 여덟 절을 보고, 회원의 정보는 실리지 않는다', async ({
    page,
    request,
  }) => {
    await page.goto(SERVICE_GUIDE_PATH);
    await expectGuide(page);
    await expectNoSideScroll(page);
    const visitor = articleHtml(await (await request.get(SERVICE_GUIDE_PATH)).text());

    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    await page.goto(SERVICE_GUIDE_PATH);
    await expect(page.getByTestId('balance-chip')).toBeVisible();
    await expectGuide(page);
    await expectNoSideScroll(page);
    const secrets = [me.email, me.profile.nickname, me.profile.publicId];
    for (const secret of secrets) await expect(guideOf(page)).not.toContainText(secret);
    // The server renders the same guide for the member's cookie as for no cookie at all.
    const member = articleHtml(await (await page.request.get(SERVICE_GUIDE_PATH)).text());
    expect(member).toBe(visitor);
    for (const secret of secrets) expect(member).not.toContain(secret);
  });

  test('온보딩을 마치지 않은 계정도 남은 단계로 보내지지 않고 안내를 읽는다 (136-6)', async ({
    page,
  }) => {
    // Signed in, no password, no step done (onboarding.spec.ts's start).
    await openSetPassword(page, freshEmail());
    await page.goto(SERVICE_GUIDE_PATH);
    // `GET /me` has answered, and the gate decides in the same render.
    await expect(page.getByTestId('balance-chip')).toBeVisible();
    await expect(page.getByTestId('onboarding-gate')).toHaveCount(0);
    await expect(page).toHaveURL(SERVICE_GUIDE_PATH);
    await expectGuide(page);
  });

  test('바닥글의 첫 링크가 어느 화면에서나 서비스 안내를 연다', async ({ page }) => {
    for (const from of ['/', '/terms', SERVICE_GUIDE_PATH]) {
      await page.goto(from);
      const links = page
        .getByTestId('site-footer')
        .getByRole('navigation', { name: copy.footerNavLabel })
        .getByRole('link');
      await expect(links.first(), from).toHaveText(copy.serviceGuideTitle);
      await expect(links.first(), from).toHaveAttribute('href', SERVICE_GUIDE_PATH);
    }
    await page.goto('/');
    await page.getByTestId('footer-link-guide').click();
    await expect(page).toHaveURL(SERVICE_GUIDE_PATH);
    await expectGuide(page);
    await expect(guideOf(page).getByRole('heading', { level: 2 })).toBeInViewport();
  });

  test('시장 상세의 시장가격 안내와 공개 판정 기록이 그 절을 연다', async ({ admin, page }) => {
    const market = await createOpenMarket(admin);

    // Under the chart, beside the notice that the price is no promise of a probability.
    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('market-price-notice')).toHaveText(copy.marketPriceNotice);
    const priceLink = page.getByTestId('market-price-guide-link');
    await expect(priceLink).toHaveText(copy.guideLinkMarketPrice);
    await priceLink.click();
    await expectSectionShown(page, 'market-price');

    // The judging record's head, beside its principle, in the copy this width draws.
    await page.goto(`/markets/${market.slug}`);
    const record = detailCopyTestId(page, 'market-judging-record');
    await expect(page.getByTestId(`${record}-principle`)).toHaveText(copy.judgingPrinciple);
    const judgingLink = page.getByTestId(`${record}-guide-link`);
    await expect(judgingLink).toHaveText(copy.guideLinkJudgement);
    await judgingLink.click();
    await expectSectionShown(page, 'judgement');
  });

  test('주문 확인의 첫 주문 안내 끝 링크가 새 탭에서 주문 방식을 열고, 확인 화면은 그대로다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());
    await page.goto(`/markets/${market.slug}`);
    const panel = await openPanel(page);
    // A YES limit buy of one at 30 (first-order-guide.spec.ts's), up to 확인.
    await panel.getByTestId('order-side-buy').click();
    await panel.getByTestId('order-kind-gtc').click();
    await panel.getByTestId('order-qty').fill('1');
    await panel.getByTestId('order-limit').fill('30');
    await expect(panel.getByTestId('order-quote')).toBeVisible();
    await expect(panel.getByTestId('order-confirm-open')).toBeEnabled();
    await panel.getByTestId('order-confirm-open').click();
    const review = panel.getByTestId('order-review');
    await expect(review).toBeVisible();
    const guide = review.getByTestId('first-order-guide');
    await expect(guide).toHaveAttribute('data-folded', 'false');
    const link = guide.getByTestId('first-order-guide-link');
    await expect(link).toHaveText(copy.guideLinkOrders);
    await expect(link).toHaveAttribute('target', '_blank');

    const opened = page.context().waitForEvent('page');
    await link.click();
    const tab = await opened;
    try {
      await tab.waitForLoadState();
      await expectSectionShown(tab, 'orders');
      await expectGuide(tab);
    } finally {
      await tab.close();
    }
    // The order being confirmed stays where it was.
    await expect(page).toHaveURL(`/markets/${market.slug}`);
    await expect(review).toBeVisible();
    await expect(review.getByTestId('order-submit')).toBeEnabled();
  });
});
