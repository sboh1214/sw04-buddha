import {
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type Page,
} from '@playwright/test';
import type { Me, Proposal } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  E2E_PASSWORD,
  adminAccount,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  logOut,
  meOf,
  openSetPassword,
  setFirstPassword,
  signIn,
  signUp,
  test,
} from './helpers';

/**
 * 시장 제안 (#77, ADR-0089; owner decisions in ADR-0069 decision 4, the #77 rows, and decision 7):
 * a member proposes a market from the explore home's 시장 제안하기 and follows it in 내 제안 (a MY
 * sub-page linked from the summary and 설정, no tab of its own); an operator starts the review and
 * adopts it with a draft made from it — the member sees 채택 and the memo, and the market's link
 * only once the market is public. Another proposal is rejected as a 중복 with the existing market,
 * whose link the member sees with the reason and the explanation; a 접수 proposal is retracted (철회)
 * and a 검토 one cannot be; the fourth proposal in 24 hours is refused (the limit counts the
 * retracted and rejected ones). A proposal adopted with no market takes one later, once (owner
 * decision 2026-10-19): an existing draft market picked by title, whose link the member sees once
 * it opens. The search's no-results screen leads a visitor to the login and back to the form.
 *
 * Restacked onto #184's chain (ADR-0089 결과 5): a writing restriction refuses the form with its end
 * and the way to 조치·신고 내역 while the 철회 stays open (#185·#139); an account with steps of its
 * onboarding left — a new one, or one a terms revision sent back to agree again — opens 내 제안 and
 * takes a 접수 proposal back, while its 시장 제안하기 still meets the gate (owner decision
 * 2026-10-20); and a member who closed the account (#140) stays on the operators' screens as
 * '탈퇴한 사용자', the proposal reviewed all the same.
 *
 * Who may propose (onboarding, restrictions), the waiting limit, the exact edges of both limits,
 * the status machine against races and who sees what are the API's integration tests
 * (proposals.controller.test.ts, admin-proposals.controller.test.ts, private-data.test.ts).
 */

/** `{ data }` out of the PLAN 7 success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: T }).data;
}

/** A Korean calendar date `days` after today in Korea (`YYYY-MM-DD`), as the date input takes it. */
function koreanDateIn(days: number): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1_000);
  kst.setUTCDate(kst.getUTCDate() + days);
  return kst.toISOString().slice(0, 10);
}

/** The member's newest proposal (`GET /me/proposals`, newest first). */
async function newestProposal(page: Page): Promise<Proposal> {
  const items = await dataOf<Proposal[]>(await page.request.get('/api/v1/me/proposals'));
  const first = items[0];
  if (first === undefined) throw new Error('no proposal');
  return first;
}

/** A proposal straight at the API with the page's own cookie, for a spec whose subject is later. */
async function proposeThroughApi(page: Page, question: string): Promise<Proposal> {
  const me = await meOf(page.request);
  return dataOf<Proposal>(
    await page.request.post('/api/v1/me/proposals', {
      data: {
        question,
        deadline: koreanDateIn(7),
        yesCondition: `${question} — 공식 발표가 있으면 YES`,
        expectedSources: '공식 보도자료',
        expectedAccountId: me.id,
      },
    }),
  );
}

/** A draft market straight at the admin API (not opened), titled with `title`. */
async function createDraftMarket(
  admin: APIRequestContext,
  title: string,
): Promise<{ id: string; slug: string; title: string }> {
  const categories = await dataOf<{ id: number; parentId: number | null }[]>(
    await admin.get('/api/v1/categories'),
  );
  const category = categories.find((row) => row.parentId === null);
  if (category === undefined) throw new Error('no active category: run `pnpm db:seed`');
  const tag = freshTag();
  const draft = await dataOf<{ id: string; slug: string }>(
    await admin.post('/api/v1/admin/markets', {
      data: {
        title,
        description: null,
        rules: `자동화 테스트가 만든 초안입니다. ${tag}`,
        resolutionSource: `테스트 출처 ${tag}`,
        categoryId: category.id,
        imageUrl: null,
        closeAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
        slug: `e2e-${tag}`,
      },
    }),
  );
  return { id: draft.id, slug: draft.slug, title };
}

/** Fills the form and submits it. */
async function fillForm(page: Page, question: string, deadline: string): Promise<void> {
  await page.getByTestId('proposal-question').fill(question);
  await page.getByTestId('proposal-deadline').fill(deadline);
  await page.getByTestId('proposal-yes-condition').fill(`${question} — 공식 발표가 있으면 YES`);
  await page.getByTestId('proposal-expected-sources').fill('공식 보도자료와 통계 누리집');
}

/** A browser signed in as the first seed admin (its fixture onboarded it). */
async function adminBrowser(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, adminAccount.email, adminAccount.password);
  return { page, close: () => context.close() };
}

const item = (page: Page, id: string) => page.getByTestId(`my-proposal-${id}`);
const statusOf = (page: Page, id: string) => page.getByTestId(`my-proposal-status-${id}`);

test.describe('시장 제안', () => {
  test('제안하면 내 제안에 접수로 보이고, 운영자가 검토해 초안과 함께 채택하면 채택·메모가, 시장이 공개되면 그 링크가 보인다', async ({
    admin,
    browser,
    page,
    request,
  }) => {
    await signUp(page, freshEmail());
    const proposer = await meOf(page.request);
    const adminNickname = (await meOf(admin)).profile.nickname;

    // --- the way in: 시장 제안하기 at the bottom of the explore home, in the HTML every visitor
    // gets (ADR-0069 decision 4 #77 위치).
    const home = await (await request.get('/')).text();
    expect(home).toContain('data-testid="home-propose-market"');
    await page.goto('/');
    const entry = page.getByTestId('home-propose-market');
    await expect(entry).toContainText(copy.proposeMarketEntry);
    await entry.getByRole('link', { name: copy.proposeMarket }).click();
    await expect(page).toHaveURL('/proposals/new');

    // --- the form: the notice that a 채택 opens nothing and pays nothing (N05 §6), four required
    // fields, two optional ones, and no probability (N02 §10).
    await expect(page.getByTestId('proposal-notice')).toHaveText(copy.proposalNotice);
    const form = page.getByTestId('proposal-form');
    await expect(form.locator('input, textarea, select')).toHaveCount(6);
    await expect(form.locator('input[type="range"], input[type="number"]')).toHaveCount(0);
    // Refused before sending: the required fields left blank.
    await page.getByTestId('proposal-submit').click();
    await expect(page.getByText(copy.errProposalQuestion)).toBeVisible();
    await expect(page.getByText(copy.errProposalDeadline)).toBeVisible();

    const tag = freshTag();
    const question = `E2E 제안 ${tag}: 연말까지 발표될까?`;
    await fillForm(page, question, koreanDateIn(2));
    await page.getByTestId('proposal-background').fill('배경 설명입니다.');
    // The first parent, which has sub-categories: a wish the form takes at either level.
    await page.getByTestId('proposal-category').selectOption({ index: 1 });
    await page.getByTestId('proposal-submit').click();
    await expect(page.getByText(copy.proposalSubmitted)).toBeVisible();

    // --- 내 제안: 접수, with 철회 on offer; MY's tab bar with no tab current.
    await expect(page).toHaveURL('/my/proposals');
    const proposal = await newestProposal(page);
    expect(proposal.question).toBe(question);
    await expect(statusOf(page, proposal.id)).toHaveText(copy.proposalStatusSubmitted);
    await expect(item(page, proposal.id).getByRole('heading', { level: 4 })).toHaveText(question);
    await expect(page.getByTestId(`my-proposal-retract-${proposal.id}`)).toBeVisible();
    await expect(page.getByTestId('my-proposals-notice')).toHaveText(copy.proposalNotice);
    await expect(page.getByTestId('my-tabs').locator('[aria-current="page"]')).toHaveCount(0);

    // --- linked from the MY summary and from 설정.
    await page.goto('/my');
    const preview = page.getByTestId('my-preview-proposals');
    await expect(preview.getByTestId(`my-proposal-${proposal.id}`)).toContainText(question);
    await expect(preview.getByRole('link', { name: copy.myViewAll })).toHaveAttribute(
      'href',
      '/my/proposals',
    );
    await page.goto('/my/settings');
    await expect(
      page.getByTestId('settings-proposals').getByRole('link', { name: copy.myProposalsOpen }),
    ).toHaveAttribute('href', '/my/proposals');

    const operator = await adminBrowser(browser);
    try {
      const adminPage = operator.page;
      // --- the operators' list, newest first, and the detail with the proposer.
      await adminPage.goto('/admin/proposals');
      const row = adminPage.getByTestId(`admin-proposal-${proposal.id}`);
      await expect(row).toContainText(question);
      await expect(row).toContainText(proposer.profile.nickname);
      await row.getByRole('link', { name: question }).click();
      await expect(adminPage).toHaveURL(`/admin/proposals/${proposal.id}`);
      await expect(adminPage.getByTestId('admin-proposal-proposer')).toContainText(
        proposer.profile.nickname,
      );

      // --- 검토 시작: recorded with the operator; the member's 철회 is gone.
      await adminPage.getByTestId('admin-proposal-review').click();
      await expect(adminPage.getByText(copy.adminProposalReviewStarted)).toBeVisible();
      await expect(adminPage.getByTestId('admin-proposal-status')).toHaveText(
        copy.proposalStatusReviewing,
      );
      await expect(adminPage.getByTestId('admin-proposal-record-review')).toContainText(
        adminNickname,
      );
      await page.goto('/my/proposals');
      await expect(statusOf(page, proposal.id)).toHaveText(copy.proposalStatusReviewing);
      await expect(page.getByTestId(`my-proposal-retract-${proposal.id}`)).toHaveCount(0);

      // --- 채택 with a memo and a draft made from the proposal, confirmed first (it is final).
      const memo = `좋은 제안입니다 ${tag}`;
      await adminPage.getByTestId('admin-proposal-adopt-memo').fill(memo);
      await adminPage.getByTestId('admin-proposal-adopt-market-draft').click();
      await expect(adminPage.getByTestId('admin-proposal-draft-close-at')).toBeVisible();
      // The wish is a parent that has sub-categories, where no market sits (ADR-0041): it is no
      // default, and the draft waits for a leaf — refused before anything is sent.
      await expect(adminPage.getByTestId('admin-proposal-draft-category-wish')).toContainText(
        copy.adminProposalDraftCategoryPickLeaf,
      );
      // Which line, and the blank option's label, are draftCategoryView's (unit-tested there,
      // the retired wish included — no API retires a category, so e2e cannot reach that one).
      await expect(adminPage.getByTestId('admin-proposal-draft-category-retired')).toHaveCount(0);
      await expect(
        adminPage.getByTestId('admin-proposal-draft-category').locator('option').first(),
      ).toHaveText(copy.adminMarketCategoryPlaceholder);
      await adminPage.getByTestId('admin-proposal-adopt-submit').click();
      await expect(
        adminPage.getByText(copy.errProposalDraftCategory, { exact: true }),
      ).toBeVisible();
      await adminPage.getByTestId('admin-proposal-draft-category').selectOption({ index: 1 });
      await adminPage.getByTestId('admin-proposal-adopt-submit').click();
      await expect(adminPage.getByText(copy.adminProposalAdoptBody)).toBeVisible();
      await expect(adminPage.getByText(copy.adminProposalAdoptDraftBody)).toBeVisible();
      await adminPage.getByTestId('admin-proposal-adopt-confirm').click();
      await expect(adminPage.getByText(copy.adminProposalAdopted)).toBeVisible();
      await expect(adminPage.getByTestId('admin-proposal-status')).toHaveText(
        copy.proposalStatusAdopted,
      );
      await expect(adminPage.getByTestId('admin-proposal-record-decided')).toContainText(
        adminNickname,
      );
      // No more moves: 채택 is final.
      await expect(adminPage.getByTestId('admin-proposal-actions')).toHaveCount(0);
      // The draft, titled with the question, still a draft: a 채택 opens nothing.
      const marketCell = adminPage.getByTestId('admin-proposal-market');
      await expect(marketCell).toContainText(question);
      await expect(marketCell).toContainText(copy.marketStatusDraft);
      const href = await marketCell.getByRole('link', { name: question }).getAttribute('href');
      const marketId = href?.split('/').pop();
      if (marketId === undefined) throw new Error('no draft link');

      // --- the member: 채택 and the memo, and no link while the market is a draft.
      await page.goto('/my/proposals');
      await expect(statusOf(page, proposal.id)).toHaveText(copy.proposalStatusAdopted);
      await expect(page.getByTestId(`my-proposal-memo-${proposal.id}`)).toHaveText(memo);
      await expect(page.getByTestId(`my-proposal-market-${proposal.id}`)).toHaveCount(0);

      // --- the operators open the market through its own steps; then the member sees its link.
      const opened = await dataOf<{ slug: string; status: string }>(
        await admin.post(`/api/v1/admin/markets/${marketId}/open`),
      );
      expect(opened.status).toBe('open');
      await page.reload();
      const link = page.getByTestId(`my-proposal-market-${proposal.id}`);
      await expect(link).toHaveText(question);
      await expect(link).toHaveAttribute('href', `/markets/${opened.slug}`);
      await link.click();
      await expect(page).toHaveURL(`/markets/${opened.slug}`);
      // The market never names who proposed it (ADR-0069 decision 4 #77 공개 범위).
      const detail = await (await request.get(`/markets/${opened.slug}`)).text();
      expect(detail).toContain(question);
      expect(detail).not.toContain(proposer.profile.nickname);
    } finally {
      await operator.close();
    }
  });

  test('중복 반려는 사유·설명과 기존 시장 링크가 보이고, 접수 제안은 철회되며 검토 중인 제안은 철회할 수 없고, 24시간에 넷째 제안은 거절된다', async ({
    admin,
    browser,
    page,
  }) => {
    const group = freshTag();
    const existing = await createOpenMarket(admin, { group });
    await signUp(page, freshEmail());
    const rejected = await proposeThroughApi(page, `E2E 중복 ${group}`);
    const retracted = await proposeThroughApi(page, `E2E 철회 ${group}`);
    const reviewing = await proposeThroughApi(page, `E2E 검토 ${group}`);
    await dataOf(await admin.post(`/api/v1/admin/proposals/${reviewing.id}/review`));

    // --- the operator rejects one as a 중복, naming the existing market found by its title.
    const explanation = `같은 조건의 시장이 이미 열려 있습니다 ${group}`;
    const operator = await adminBrowser(browser);
    try {
      const adminPage = operator.page;
      await adminPage.goto(`/admin/proposals/${rejected.id}`);
      await adminPage.getByTestId('admin-proposal-reject-reason').selectOption('duplicate');
      await adminPage.getByTestId('admin-proposal-reject-explanation').fill(explanation);
      // A 중복 needs its market: refused until one is picked.
      await adminPage.getByTestId('admin-proposal-reject-submit').click();
      await expect(adminPage.getByText(copy.errProposalDuplicateMarket)).toBeVisible();
      await adminPage.getByTestId('admin-proposal-reject-picker-input').fill(existing.tag);
      await adminPage.getByTestId('admin-proposal-reject-picker-submit').click();
      await adminPage.getByTestId(`admin-proposal-reject-picker-pick-${existing.id}`).click();
      await expect(adminPage.getByTestId('admin-proposal-reject-picker-picked')).toContainText(
        existing.title,
      );
      await adminPage.getByTestId('admin-proposal-reject-submit').click();
      await expect(adminPage.getByText(copy.adminProposalRejectBody)).toBeVisible();
      await adminPage.getByTestId('admin-proposal-reject-confirm').click();
      await expect(adminPage.getByText(copy.adminProposalRejected)).toBeVisible();
      await expect(adminPage.getByTestId('admin-proposal-status')).toHaveText(
        copy.proposalStatusRejected,
      );
      await expect(adminPage.getByTestId('admin-proposal-result')).toContainText(explanation);
    } finally {
      await operator.close();
    }

    // --- the member: the reason, the explanation and the existing market's link.
    await page.goto('/my/proposals');
    await expect(statusOf(page, rejected.id)).toHaveText(copy.proposalStatusRejected);
    await expect(page.getByTestId(`my-proposal-reason-${rejected.id}`)).toHaveText(
      copy.proposalReasonDuplicate,
    );
    await expect(page.getByTestId(`my-proposal-explanation-${rejected.id}`)).toHaveText(
      explanation,
    );
    await expect(page.getByTestId(`my-proposal-duplicate-${rejected.id}`)).toHaveAttribute(
      'href',
      `/markets/${existing.slug}`,
    );
    // Final: no 철회 on a 반려 nor on a proposal under review.
    await expect(page.getByTestId(`my-proposal-retract-${rejected.id}`)).toHaveCount(0);
    await expect(statusOf(page, reviewing.id)).toHaveText(copy.proposalStatusReviewing);
    await expect(page.getByTestId(`my-proposal-retract-${reviewing.id}`)).toHaveCount(0);

    // --- 철회 of the 접수 one, behind its confirmation.
    await page.getByTestId(`my-proposal-retract-${retracted.id}`).click();
    await expect(page.getByText(copy.proposalRetractBody)).toBeVisible();
    await page.getByTestId('my-proposal-retract-confirm').click();
    await expect(page.getByText(copy.proposalRetracted)).toBeVisible();
    await expect(statusOf(page, retracted.id)).toHaveText(copy.proposalStatusRetracted);
    await expect(page.getByTestId(`my-proposal-retract-${retracted.id}`)).toHaveCount(0);

    // --- three in 24 hours, the retracted and the rejected one counted: the fourth is refused.
    await page.goto('/proposals/new');
    await fillForm(page, `E2E 넷째 ${group}`, koreanDateIn(3));
    await page.getByTestId('proposal-submit').click();
    await expect(page.getByTestId('proposal-form-error')).toContainText(copy.errProposalDailyLimit);
    await expect(page).toHaveURL('/proposals/new');
    const items = await dataOf<Proposal[]>(await page.request.get('/api/v1/me/proposals'));
    expect(items).toHaveLength(3);
  });

  test('시장 없이 채택한 제안에는 나중에 한 번 시장을 연결하고, 그 시장이 공개되면 제안자가 링크를 본다', async ({
    admin,
    browser,
    page,
  }) => {
    const group = freshTag();
    await signUp(page, freshEmail());
    const proposal = await proposeThroughApi(page, `E2E 나중 연결 ${group}`);
    await dataOf(await admin.post(`/api/v1/admin/proposals/${proposal.id}/review`));
    const draft = await createDraftMarket(admin, `E2E 초안 ${group}`);
    const adminNickname = (await meOf(admin)).profile.nickname;

    const operator = await adminBrowser(browser);
    try {
      const adminPage = operator.page;
      await adminPage.goto(`/admin/proposals/${proposal.id}`);
      // --- 채택 with no market (the form's first choice), confirmed.
      await adminPage.getByTestId('admin-proposal-adopt-submit').click();
      await adminPage.getByTestId('admin-proposal-adopt-confirm').click();
      await expect(adminPage.getByText(copy.adminProposalAdopted)).toBeVisible();
      await expect(adminPage.getByTestId('admin-proposal-market')).toContainText(
        copy.adminProposalNoMarket,
      );

      // --- 시장 연결, on offer for a 채택 with no market (owner decision 2026-10-19): an existing
      // market, a draft here, picked by its title — refused until one is picked.
      const form = adminPage.getByTestId('admin-proposal-link');
      await expect(form).toContainText(copy.adminProposalLinkHint);
      await adminPage.getByTestId('admin-proposal-link-submit').click();
      await expect(adminPage.getByText(copy.errProposalExistingMarket)).toBeVisible();
      await adminPage.getByTestId('admin-proposal-link-picker-input').fill(group);
      await adminPage.getByTestId('admin-proposal-link-picker-submit').click();
      await adminPage.getByTestId(`admin-proposal-link-picker-pick-${draft.id}`).click();
      await expect(adminPage.getByTestId('admin-proposal-link-picker-picked')).toContainText(
        draft.title,
      );
      await adminPage.getByTestId('admin-proposal-link-submit').click();
      await expect(adminPage.getByText(copy.adminProposalLinkBody)).toBeVisible();
      await adminPage.getByTestId('admin-proposal-link-confirm').click();
      await expect(adminPage.getByText(copy.adminProposalLinked)).toBeVisible();

      // --- still 채택, the link kept with its operator, and no second link: it is once.
      await expect(adminPage.getByTestId('admin-proposal-status')).toHaveText(
        copy.proposalStatusAdopted,
      );
      await expect(adminPage.getByTestId('admin-proposal-record-linked')).toContainText(
        adminNickname,
      );
      const marketCell = adminPage.getByTestId('admin-proposal-market');
      await expect(marketCell).toContainText(draft.title);
      await expect(marketCell).toContainText(copy.marketStatusDraft);
      await expect(adminPage.getByTestId('admin-proposal-actions')).toHaveCount(0);
    } finally {
      await operator.close();
    }

    // --- the member: 채택, and no link while the market is a draft.
    await page.goto('/my/proposals');
    await expect(statusOf(page, proposal.id)).toHaveText(copy.proposalStatusAdopted);
    await expect(page.getByTestId(`my-proposal-market-${proposal.id}`)).toHaveCount(0);

    // --- once the operators open it, its link.
    const opened = await dataOf<{ slug: string; status: string }>(
      await admin.post(`/api/v1/admin/markets/${draft.id}/open`),
    );
    expect(opened.status).toBe('open');
    await page.reload();
    const link = page.getByTestId(`my-proposal-market-${proposal.id}`);
    await expect(link).toHaveText(draft.title);
    await expect(link).toHaveAttribute('href', `/markets/${opened.slug}`);
  });

  test('검색 결과가 없으면 시장 제안하기가 있고, 로그인하지 않은 방문자는 로그인한 뒤 양식으로 온다', async ({
    page,
  }) => {
    const email = freshEmail();
    await signUp(page, email);
    await logOut(page);

    await page.goto(`/search?q=${freshTag()}`);
    await expect(page.getByTestId('markets-empty')).toHaveText(copy.marketsSearchEmpty);
    const entry = page.getByTestId('search-propose-market');
    await expect(entry).toContainText(copy.proposeMarketEntry);
    await entry.getByRole('link', { name: copy.proposeMarket }).click();
    await expect(page).toHaveURL('/login?next=%2Fproposals%2Fnew');

    await page.getByLabel(copy.email).fill(email);
    await page.getByLabel(copy.password, { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: copy.loginWithEmail }).click();
    await expect(page).toHaveURL('/proposals/new');
    await expect(page.getByTestId('proposal-form')).toBeVisible();

    // 내 제안 is behind MY's own gate.
    await logOut(page);
    await page.goto('/my/proposals');
    await expect(page).toHaveURL('/login?next=%2Fmy%2Fproposals');
  });
  test('작성 제한 중에는 양식이 끝나는 때와 조치·신고 내역 링크로 거절하고, 접수 제안의 철회는 그대로 된다', async ({
    admin,
    page,
  }) => {
    const group = freshTag();
    await signUp(page, freshEmail());
    const waiting = await proposeThroughApi(page, `E2E 제한 전 ${group}`);
    const me = await meOf(page.request);
    // An operator's one-day writing restriction (#185), straight at the admin API.
    await dataOf(
      await admin.post(`/api/v1/admin/moderation/users/${me.id}/writing-restriction`, {
        data: { reason: 'spam', days: 1 },
      }),
    );

    // The form refuses a new proposal (ADR-0069 decision 4 #77 자격): which restriction, until when,
    // and the way to 조치·신고 내역 under it — no appeal sentence (owner decision 2026-10-22 evening).
    await page.goto('/proposals/new');
    await fillForm(page, `E2E 제한 중 ${group}`, koreanDateIn(5));
    await page.getByTestId('proposal-submit').click();
    const refusal = page.getByTestId('proposal-form-error');
    await expect(refusal).toContainText(copy.errRestrictedProposal);
    await expect(refusal).toContainText(copy.restrictionUntil);
    await expect(refusal.getByTestId('restricted-moderation-link')).toHaveAttribute(
      'href',
      '/my/moderation',
    );
    await expect(refusal).not.toContainText('이의');
    await expect(page).toHaveURL('/proposals/new');

    // The 접수 one is still taken back (#45-12: one's own, under a restriction too).
    await page.goto('/my/proposals');
    await page.getByTestId(`my-proposal-retract-${waiting.id}`).click();
    await page.getByTestId('my-proposal-retract-confirm').click();
    await expect(page.getByText(copy.proposalRetracted)).toBeVisible();
    await expect(statusOf(page, waiting.id)).toHaveText(copy.proposalStatusRetracted);
    const items = await dataOf<Proposal[]>(await page.request.get('/api/v1/me/proposals'));
    expect(items.map((row) => row.id)).toEqual([waiting.id]);
  });

  test('온보딩을 마치지 않은 계정도 재동의만 남은 계정도 내 제안을 열고 접수 제안을 철회하며, 시장 제안하기는 온보딩으로 보낸다', async ({
    page,
  }) => {
    // A new account with every step left (owner decision 2026-10-20): 내 제안 opens — empty, as an
    // account that never finished has proposed nothing — and 시장 제안하기 meets the gate.
    await openSetPassword(page, freshEmail());
    await setFirstPassword(page);
    await expect(page).toHaveURL('/onboarding');
    await page.goto('/my/proposals');
    await expect(page.getByTestId('my-proposals-empty')).toBeVisible();
    await expect(page).toHaveURL('/my/proposals');
    await page.getByTestId('my-proposals-new').click();
    await expect(page).toHaveURL('/onboarding?next=%2Fproposals%2Fnew');
    // Signed out by dropping the cookie: MY's 로그아웃 is behind the gate for this account.
    await page.context().clearCookies();

    // A member a revision of the terms sent back to agree again (#57-5): its 접수 proposal from
    // before. `GET /me` says the re-consent, as onboarding.spec.ts makes it — the server's own
    // onboarding stays done, and the 철회 asks it nothing anyway (owner decision 2026-10-19).
    const group = freshTag();
    await signUp(page, freshEmail());
    const waiting = await proposeThroughApi(page, `E2E 재동의 ${group}`);
    await page.route('**/api/v1/me', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const body = (await response.json()) as { data: Me };
      body.data.onboarding = {
        ...body.data.onboarding,
        consent: false,
        completed: false,
        nextStep: 'consent',
      };
      await route.fulfill({ response, json: body });
    });
    // The rest of MY is gated as before.
    await page.goto('/my');
    await expect(page).toHaveURL('/onboarding?next=%2Fmy');
    await page.goto('/my/proposals');
    await expect(statusOf(page, waiting.id)).toHaveText(copy.proposalStatusSubmitted);
    await expect(page).toHaveURL('/my/proposals');
    await page.getByTestId(`my-proposal-retract-${waiting.id}`).click();
    await page.getByTestId('my-proposal-retract-confirm').click();
    await expect(page.getByText(copy.proposalRetracted)).toBeVisible();
    await expect(statusOf(page, waiting.id)).toHaveText(copy.proposalStatusRetracted);
    await page.getByTestId('my-proposals-new').click();
    await expect(page).toHaveURL('/onboarding?next=%2Fproposals%2Fnew');
  });

  test('탈퇴한 회원의 제안은 운영자 화면에 탈퇴한 사용자로 남고 그대로 검토된다', async ({
    browser,
    page,
  }) => {
    const group = freshTag();
    await signUp(page, freshEmail());
    const waiting = await proposeThroughApi(page, `E2E 탈퇴 ${group}`);
    const me = await meOf(page.request);
    // 탈퇴 (#140): a waiting proposal does not refuse it.
    await dataOf(
      await page.request.post('/api/v1/me/closure', {
        data: { confirmation: '탈퇴', expectedAccountId: me.id },
      }),
    );

    const operator = await adminBrowser(browser);
    try {
      const adminPage = operator.page;
      await adminPage.goto('/admin/proposals');
      const row = adminPage.getByTestId(`admin-proposal-${waiting.id}`);
      await expect(row).toContainText(`${copy.adminProposalProposer} ${copy.postAuthorFormer}`);
      await row.getByRole('link', { name: waiting.question }).click();
      await expect(adminPage).toHaveURL(`/admin/proposals/${waiting.id}`);
      await expect(adminPage.getByTestId('admin-proposal-proposer')).toHaveText(
        copy.postAuthorFormer,
      );
      // ADR-0069 decision 4 #140 «처리 중인 … 제안: 그대로 검토하고 결과를 기록한다».
      await adminPage.getByTestId('admin-proposal-review').click();
      await expect(adminPage.getByTestId('admin-proposal-status')).toHaveText(
        copy.proposalStatusReviewing,
      );
      await expect(adminPage.getByTestId('admin-proposal-record')).toContainText(
        copy.postAuthorFormer,
      );
    } finally {
      await operator.close();
    }
  });
});
