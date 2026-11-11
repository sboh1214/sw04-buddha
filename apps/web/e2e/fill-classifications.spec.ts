import type { APIResponse } from '@playwright/test';
import type { Fill, FillClassificationWrite, Market } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  adminAccount,
  createOpenMarket,
  expect,
  helperTraders,
  logOut,
  meOf,
  secondAdminAccount,
  signIn,
  subscribed,
  test,
  tradeOnce,
} from './helpers';
const dataOf = async <T>(response: APIResponse): Promise<T> => {
  expect(response.ok(), `${response.url()}: ${response.status()} ${await response.text()}`).toBe(
    true,
  );
  return ((await response.json()) as { data: T }).data;
};

test('고정 체결 분류는 두 관리자 승인 후 참가자만 갱신하고 늦은 조회 실패에도 완료 사실과 공개 경계를 보존한다', async ({
  admin,
  secondAdmin,
  page,
  browser,
  baseURL,
  request,
}) => {
  test.slow();
  await helperTraders(admin);
  const market = await createOpenMarket(admin);
  await tradeOnce(admin, market.id);
  const fills = await dataOf<Fill[]>(await request.get(`/api/v1/markets/${market.id}/fills`));
  expect(fills).toHaveLength(1);
  const fill = fills[0]!;
  const path = `/api/v1/admin/fills/${fill.id}`;
  const before = await dataOf<Market>(await request.get(`/api/v1/markets/${market.id}`));
  expect(before.traderCount).toBe(2);
  const viewerContext = await browser.newContext({
    baseURL,
    viewport: page.viewportSize() ?? undefined,
  });
  try {
    const viewer = await viewerContext.newPage();
    const ready = subscribed(viewer, market.id);
    await viewer.goto(`/markets/${market.slug}`);
    await ready;
    await expect(viewer.getByTestId('market-detail-traders')).toHaveText(`${copy.marketTraders} 2`);
    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto(`/admin/fills/${fill.id}`);
    await page.getByRole('button', { name: copy.classificationsMark, exact: true }).click();
    const proposing = page.getByTestId('classification-request-dialog');
    await expect(proposing.getByTestId('classification-request-dialog-confirm')).toBeDisabled();
    const privateReason = `분류비공개근거${market.tag}`;
    await proposing.getByTestId('classification-reason').fill(privateReason);
    const sent = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === `${path}/classification-requests`,
    );
    await proposing.getByTestId('classification-request-dialog-confirm').click();
    const response = await sent;
    expect(response.ok()).toBe(true);
    const pending = ((await response.json()) as { data: FillClassificationWrite }).data;
    expect(response.request().postDataJSON()).toEqual({
      expectedAccountId: (await meOf(admin)).id,
      action: 'mark',
      baseRevision: '0',
      reason: privateReason,
    });
    await expect(proposing).toHaveCount(0);
    await expect(
      page
        .getByTestId(`classification-request-${pending.request.id}`)
        .getByRole('button', { name: copy.classificationsApprove, exact: true }),
    ).toHaveCount(0);
    await logOut(page);
    await signIn(page, secondAdminAccount.email, secondAdminAccount.password);
    await page.goto(`/admin/fills/${fill.id}`);
    await page
      .getByTestId(`classification-request-${pending.request.id}`)
      .getByRole('button', { name: copy.classificationsApprove, exact: true })
      .click();
    const approving = page.getByTestId('classification-approve-dialog');
    await approving.getByTestId('classification-decision-reason').fill(`분류독립검토${market.tag}`);
    await expect(approving.getByTestId('classification-approve-dialog-confirm')).toBeEnabled();
    const failedRead = (url: URL) => url.pathname.startsWith(path);
    await page.route(failedRead, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'INTERNAL', message: 'unavailable' } }),
          })
        : route.continue(),
    );
    const committed = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname ===
          `${path}/classification-requests/${pending.request.id}/approve`,
    );
    await approving.getByTestId('classification-approve-dialog-confirm').click();
    expect((await committed).ok()).toBe(true);
    await expect(approving).toHaveCount(0);
    await expect(page.getByTestId('classification-fill-facts')).toContainText(
      copy.classificationsExcluded,
    );
    await expect(page.getByText(copy.classificationsReadFailed).first()).toBeVisible();
    await expect(viewer.getByTestId('market-detail-traders')).toHaveText(`${copy.marketTraders} 0`);
    await page.unroute(failedRead);
    const after = await dataOf<Market>(await request.get(`/api/v1/markets/${market.id}`));
    expect(after).toMatchObject({
      tradeCount: before.tradeCount,
      volumeCoin: before.volumeCoin,
      lastPrice: before.lastPrice,
      lastFillAt: before.lastFillAt,
      traderCount: 0,
    });
    expect(await dataOf<Fill[]>(await request.get(`/api/v1/markets/${market.id}/fills`))).toEqual(
      fills,
    );
    expect((await request.get(path)).status()).toBe(401);
    const [member] = await helperTraders(admin);
    expect((await member.get(path)).status()).toBe(403);
    for (const response of [
      await request.get(`/api/v1/markets/${market.id}`),
      await request.get(`/markets/${market.slug}`),
    ]) {
      const text = await response.text();
      for (const hidden of [
        privateReason,
        `분류독립검토${market.tag}`,
        pending.request.id,
        'classificationRevision',
        'classificationCutoff',
        'fillClassifications',
      ])
        expect(text).not.toContain(hidden);
    }
    // A new normal fill restores both participants without undoing the original mark.
    await tradeOnce(admin, market.id);
    await expect(viewer.getByTestId('market-detail-traders')).toHaveText(`${copy.marketTraders} 2`);
    const current = await dataOf<FillClassificationWrite['fill']>(await admin.get(path));
    const clear = await dataOf<FillClassificationWrite>(
      await admin.post(`${path}/classification-requests`, {
        data: {
          expectedAccountId: (await meOf(admin)).id,
          action: 'clear',
          baseRevision: current.classificationRevision,
          reason: '분류를 해제할 새 운영 근거',
        },
      }),
    );
    const cleared = await dataOf<FillClassificationWrite>(
      await secondAdmin.post(`${path}/classification-requests/${clear.request.id}/approve`, {
        data: { expectedAccountId: (await meOf(secondAdmin)).id, reason: '해제 근거 독립 확인' },
      }),
    );
    expect(cleared.fill.excluded).toBe(false);
    expect(
      (await dataOf<Market>(await request.get(`/api/v1/markets/${market.id}`))).traderCount,
    ).toBe(2);
  } finally {
    await viewerContext.close();
  }
});
