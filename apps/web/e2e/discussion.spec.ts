import { type APIRequestContext, type Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  E2E_PASSWORD,
  closeMarket,
  completeOnboardingThroughApi,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  logOut,
  meOf,
  openSetPassword,
  setFirstPassword,
  signUp,
  test,
} from './helpers';

/**
 * 토론 (#47, ADR-0075; owner decisions in ADR-0069 decision 4 #47, decision 2 #45-6, of 2026-10-18,
 * of 2026-10-20 and of 2026-10-21): the market detail's section of that market's 근거 글, read in the
 * browser only — the server's HTML holds its heading, 글쓰기 and its loading state, never a post, a
 * count or an author, and robots.txt keeps crawlers off `/api/`, where the browser reads them,
 * every answer of which says `noindex`, while the detail stays open to search engines. Before any
 * post it is its empty notice with '글 0' and 글쓰기; with posts it is the community list's cards
 * without their market line, newest first, 20 at a time per 더 보기 until every post is there, with
 * how many beside the heading — only this market's, each card opening its post; a first read that
 * fails says so with 다시 시도, and a 더 보기 that fails says so above the button, which asks again. A
 * closed market's 토론 reads the same and still offers 글쓰기 (every public status takes a post). A
 * refresh that fails keeps the cards and the count under a notice. 글쓰기 is one link to the write
 * screen of this market: a visitor is asked to sign in there and comes back to it, and a member
 * writes straight away, the post then at the top of the section. An account with onboarding steps
 * left never stays on the detail: the gate takes it to its step, as it does from the write screen's
 * address.
 *
 * What the API leaves out — deleted and hidden posts, a draft market, an author's holdings or
 * orders — is the API's integration and guard tests' (posts.controller.test.ts,
 * private-data.test.ts); this walks the screens.
 */

const section = (page: Page) => page.getByTestId('market-discussion');

/** A server error as the API's envelope says it (related.spec.ts's): the client retries it twice. */
const SERVER_ERROR = {
  status: 500,
  contentType: 'application/json',
  body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal error' } }),
};

/** The browser's reads of the market's 토론 (`GET /markets/:id/posts`), every page of it. */
const isDiscussionRead = (marketId: string) => (url: URL) =>
  url.pathname === `/api/v1/markets/${marketId}/posts`;

/** A post straight at the API with the context's cookie: this spec's subject is reading it. */
async function postThroughApi(
  context: APIRequestContext,
  marketId: string,
  title: string,
  text: string,
): Promise<string> {
  const me = await meOf(context);
  const res = await context.post('/api/v1/posts', {
    data: {
      marketId,
      title,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
      expectedAccountId: me.id,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/**
 * Opens a market's detail and waits for it to hydrate: the 관심 등록 toggle leaves its placeholder
 * only then. A link pressed before that was seen to land and leave the page where it was (at
 * 375px: a native navigation the hydrating app router's own history write can cancel), and a
 * 더 보기 pressed before it has no handler yet.
 */
async function openDetail(page: Page, slug: string): Promise<void> {
  await page.goto(`/markets/${slug}`);
  await expect(page.getByTestId('watch-button')).toBeVisible();
}

/** The write screen of `marketId`, where the section's 글쓰기 goes for every reader. */
const writeHref = (marketId: string) => `/community/write?market=${marketId}`;

/**
 * The detail's HTML as the server sends it to anyone (no cookie): the section's frame — the
 * heading, 글쓰기 and the loading state — and nothing it reads (owner decision 2026-10-20 1).
 */
async function serverHtml(request: APIRequestContext, slug: string): Promise<string> {
  const html = await (await request.get(`/markets/${slug}`)).text();
  expect(html).toContain('data-testid="market-discussion"');
  expect(html).toMatch(new RegExp(`<h2[^>]*>${copy.marketDiscussion}</h2>`));
  expect(html).toContain('data-testid="market-discussion-write"');
  expect(html).toContain('data-testid="market-discussion-loading"');
  expect(html).not.toContain('data-testid="post-card-');
  expect(html).not.toContain('data-testid="market-discussion-count"');
  expect(html).not.toContain(copy.marketDiscussionEmpty);
  return html;
}

test.describe('시장 상세 · 토론', () => {
  test('글이 없으면 빈 안내와 글 0, 있으면 이 시장의 글만 시장 줄 없는 커뮤니티 카드로 최신순, 서버 HTML에는 글이 없고 브라우저가 20개씩 더 보기로 모두 읽으며, 카드는 글 화면을 연다', async ({
    admin,
    page,
    request,
  }) => {
    const market = await createOpenMarket(admin);
    const other = await createOpenMarket(admin);
    const tag = freshTag();

    // --- no post yet: the section stays, with its notice, the count and 글쓰기 (owner decision
    // 2026-10-20 4) — read in the browser; the server's HTML has the frame and the loading state.
    expect(await serverHtml(request, market.slug)).toContain(`href="${writeHref(market.id)}"`);
    await openDetail(page, market.slug);
    await expect(section(page).getByRole('heading', { level: 2 })).toHaveText(
      copy.marketDiscussion,
    );
    await expect(section(page).getByTestId('market-discussion-count')).toHaveText('글 0');
    await expect(section(page).getByTestId('market-discussion-empty')).toHaveText(
      copy.marketDiscussionEmpty,
    );
    await expect(section(page).getByTestId('market-discussion-loading')).toHaveCount(0);
    await expect(section(page).getByTestId('market-discussion-write')).toHaveText(
      copy.communityWrite,
    );
    await expect(section(page).getByTestId('market-discussion-write')).toHaveAttribute(
      'href',
      writeHref(market.id),
    );
    await expect(section(page).getByTestId('market-discussion-more')).toHaveCount(0);
    // No card around the section, as 관련 시장 under it has none (owner decision 2026-10-20 5):
    // the cards are the boxes.
    await expect(section(page)).toHaveCSS('border-top-width', '0px');

    // --- 21 posts, one at a time so each is newer than the last, and one on another market.
    // Numbered with two digits, so no title is the start of another.
    const titles = Array.from(
      { length: 21 },
      (_, i) => `토론 ${tag} #${String(i + 1).padStart(2, '0')}`,
    );
    const ids: string[] = [];
    for (const title of titles) ids.push(await postThroughApi(admin, market.id, title, title));
    const elsewhere = `다른 시장 ${tag}`;
    await postThroughApi(admin, other.id, elsewhere, elsewhere);
    const newestFirst = [...titles].reverse();

    // Not one post in the server's HTML or its dehydrated state: no title, no author.
    const html = await serverHtml(request, market.slug);
    for (const title of titles) expect(html, title).not.toContain(title);
    expect(html).not.toContain(tag);
    expect(html).not.toContain((await meOf(admin)).profile.nickname);

    await openDetail(page, market.slug);
    const list = section(page).getByTestId('market-discussion-list');
    // The community list's cards, titles one level under the section's heading.
    await expect(list.getByRole('heading', { level: 3 })).toHaveText(newestFirst.slice(0, 20));
    await expect(section(page).getByTestId('market-discussion-count')).toHaveText('글 21');
    await expect(section(page).getByTestId('market-discussion-empty')).toHaveCount(0);
    const newest = section(page).getByTestId(`post-card-${ids[20] ?? ''}`);
    await expect(newest.getByTestId('post-card-excerpt')).toHaveText(titles[20] ?? '');
    await expect(newest.getByTestId('post-author-admin')).toHaveText(copy.postAuthorAdmin);
    await expect(newest.getByTestId('post-card-comments')).toHaveText(`${copy.commentsHeading} 0`);
    // The card's like count, as on the community list (#49, ADR-0076).
    await expect(newest.getByTestId('post-card-likes')).toHaveText(`${copy.likeToggle} 0`);
    // No market line on any card: they are all this market's (owner decision 2026-10-20 6).
    await expect(section(page).getByTestId('post-card-market')).toHaveCount(0);
    await expect(list).not.toContainText(market.title);

    // A 더 보기 that fails — the next page refused through the client's retries — keeps the 20
    // cards and the count, says so above the button, and leaves 더 보기 to ask again (owner
    // decision 2026-10-20 7).
    const more = section(page).getByTestId('market-discussion-more');
    await expect(more).toHaveText(copy.loadMore);
    const isNextPage = (url: URL) =>
      isDiscussionRead(market.id)(url) && url.searchParams.has('cursor');
    await page.route(isNextPage, (route) => route.fulfill(SERVER_ERROR));
    await more.click();
    const moreFailed = section(page).getByTestId('market-discussion-more-failed');
    await expect(moreFailed).toHaveText(copy.errUnknown);
    await expect(moreFailed).toHaveAttribute('role', 'alert');
    // Above the button: the notice, then 더 보기.
    await expect(
      section(page).locator(
        '[data-testid="market-discussion-more-failed"] + [data-testid="market-discussion-more"]',
      ),
    ).toHaveCount(1);
    await expect(list.getByRole('heading', { level: 3 })).toHaveText(newestFirst.slice(0, 20));
    await expect(section(page).getByTestId('market-discussion-count')).toHaveText('글 21');
    await expect(section(page).getByTestId('market-discussion-refresh-failed')).toHaveCount(0);
    await expect(more).toBeEnabled();
    await page.unroute(isNextPage);

    // 더 보기 again: the 21st, and then nothing more to load.
    await more.click();
    await expect(list.getByRole('heading', { level: 3 })).toHaveText(newestFirst);
    await expect(moreFailed).toHaveCount(0);
    await expect(more).toHaveCount(0);
    await expect(section(page).getByTestId('market-discussion-count')).toHaveText('글 21');
    await expect(section(page)).not.toContainText(elsewhere);

    // A card opens its post page (owner decision 2026-10-18: 미리보기 카드 → 글 화면).
    await section(page)
      .getByTestId(`post-card-${ids[0] ?? ''}`)
      .getByTestId('post-card-link')
      .click();
    await expect(page).toHaveURL(`/community/posts/${ids[0] ?? ''}`);
    await expect(page.getByTestId('post-title')).toHaveText(titles[0] ?? '');
  });

  test('마감된 시장에서도 토론의 글을 읽고 글쓰기가 있으며, 카드에는 시장 줄도 상태도 없다', async ({
    admin,
    page,
    request,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const title = `마감 전 근거 ${tag}`;
    const id = await postThroughApi(admin, market.id, title, tag);
    await closeMarket(admin, market.id);

    // N05 §3: an ended market's 토론 is read like an open one's — in the browser, as there.
    const html = await serverHtml(request, market.slug);
    expect(html).not.toContain(title);

    await openDetail(page, market.slug);
    await expect(page.getByTestId('market-status-badge')).toHaveText(copy.marketStatusClosed);
    const card = section(page).getByTestId(`post-card-${id}`);
    await expect(card.getByRole('heading', { level: 3 })).toHaveText(title);
    await expect(section(page).getByTestId('market-discussion-count')).toHaveText('글 1');
    // The market's status is the header's to say: the card has no market line, so no badge
    // (owner decision 2026-10-20 6).
    await expect(card.getByTestId('post-card-market')).toHaveCount(0);
    await expect(card).not.toContainText(copy.marketStatusClosed);
    // Every public status takes a post (#45-6), so the door is open here too.
    await expect(section(page).getByTestId('market-discussion-write')).toHaveAttribute(
      'href',
      writeHref(market.id),
    );
    await card.getByTestId('post-card-link').click();
    await expect(page).toHaveURL(`/community/posts/${id}`);
    await expect(page.getByTestId('post-body')).toContainText(tag);
  });

  test('글쓰기는 방문자를 로그인 안내를 거쳐 이 시장의 쓰기 화면으로 보내고 회원은 곧바로 써서 토론 맨 위에서 보며(서버 HTML에는 그 글도 닉네임도 없다), 온보딩을 마치지 않은 계정은 상세에서도 쓰기 화면의 주소에서도 온보딩으로 간다', async ({
    admin,
    browser,
    page,
    request,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const email = freshEmail();
    await signUp(page, email);
    await logOut(page);

    // --- a visitor: 글쓰기 opens the write screen of this market, which asks them to sign in and
    // comes back to it (#46's door, N05 §2 «로그인 작성»; owner decision 2026-10-20 2).
    await openDetail(page, market.slug);
    await section(page).getByTestId('market-discussion-write').click();
    await expect(page).toHaveURL(writeHref(market.id));
    await expect(page.getByTestId('post-write-signed-out')).toBeVisible();
    await expect(page.getByTestId('post-editor')).toHaveCount(0);
    const login = page.getByTestId('post-write-login');
    await expect(login).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent(writeHref(market.id))}`,
    );
    await login.click();
    await page.getByLabel(copy.email).fill(email);
    await page.getByLabel(copy.password, { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: copy.loginWithEmail }).click();
    // Signed in, back on the write screen with this market picked.
    await expect(page).toHaveURL(writeHref(market.id));
    await expect(page.getByTestId('post-write-market-title')).toHaveText(market.title);
    await expect(page.getByTestId('post-editor-content')).toBeVisible();

    // --- a member: 글쓰기 is the write screen of this market straight away; the post sent, the
    // section has it at the top and counts it.
    await openDetail(page, market.slug);
    await section(page).getByTestId('market-discussion-write').click();
    await expect(page).toHaveURL(writeHref(market.id));
    await expect(page.getByTestId('post-write-market-title')).toHaveText(market.title);
    await page.getByTestId('post-title-input').fill(`토론에서 쓴 글 ${tag}`);
    await page.getByTestId('post-editor-content').click();
    await page.keyboard.type(`근거 ${tag}`);
    await page.getByTestId('post-submit').click();
    await expect(page).toHaveURL(/\/community\/posts\/[0-9a-f-]{36}$/);
    await page.getByTestId('post-market-link').click();
    await expect(page).toHaveURL(`/markets/${market.slug}`);
    await expect(
      section(page).getByTestId('market-discussion-list').getByRole('heading', { level: 3 }),
    ).toHaveText([`토론에서 쓴 글 ${tag}`]);
    await expect(section(page).getByTestId('market-discussion-count')).toHaveText('글 1');
    // The member's byline is on the card in the browser — and neither the post nor the member's
    // nickname is in the HTML the server gives anyone, a search engine included (owner decision
    // 2026-10-20 1).
    const { nickname } = (await meOf(page.request)).profile;
    await expect(section(page).getByTestId('post-author-name')).toHaveText(nickname);
    const html = await serverHtml(request, market.slug);
    expect(html).not.toContain(`토론에서 쓴 글 ${tag}`);
    expect(html).not.toContain(nickname);

    // --- an account with onboarding steps left never stays on the detail (the gate takes it to
    // its step, #57-8), and 글쓰기's write screen takes it there too; done, it comes back to the
    // write screen of this market (#57-9).
    const fresh = await browser.newContext();
    try {
      const pending = await fresh.newPage();
      await openSetPassword(pending, freshEmail());
      await setFirstPassword(pending);
      await expect(pending).toHaveURL('/onboarding');
      await pending.goto(`/markets/${market.slug}`);
      await expect(pending).toHaveURL(
        `/onboarding?next=${encodeURIComponent(`/markets/${market.slug}`)}`,
      );
      await pending.goto(writeHref(market.id));
      await expect(pending).toHaveURL(
        `/onboarding?next=${encodeURIComponent(writeHref(market.id))}`,
      );
      await expect(pending.getByTestId('consent-step')).toBeVisible();
      await completeOnboardingThroughApi(pending.request);
      await pending.reload();
      await expect(pending).toHaveURL(writeHref(market.id));
      await expect(pending.getByTestId('post-write-market-title')).toHaveText(market.title);
      await expect(pending.getByTestId('post-editor-content')).toBeVisible();
    } finally {
      await fresh.close();
    }
  });

  test('다시 읽기가 실패하면 카드와 글 수를 남기고 그 위에 알린다', async ({ admin, page }) => {
    // Review on #47: the notice over held cards was reached by no test. The page's clock, so the
    // page read on mount can be made older than `staleTime` (30 s, lib/query-client.ts) without
    // waiting for it; a refocus then reads the list again, as it does for a reader coming back to
    // the tab.
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const title = `다시 읽기 ${tag}`;
    const id = await postThroughApi(admin, market.id, title, tag);
    await page.clock.install();
    await openDetail(page, market.slug);
    const list = section(page).getByTestId('market-discussion-list');
    await expect(list.getByRole('heading', { level: 3 })).toHaveText([title]);

    let refused = 0;
    // One matcher for the route and its removal: `unroute` takes the same function back.
    const isRead = isDiscussionRead(market.id);
    await page.route(isRead, (route) => {
      refused += 1;
      return route.fulfill(SERVER_ERROR);
    });
    const refocus = async () => {
      await page.clock.fastForward('00:31');
      // TanStack's focus manager listens for `visibilitychange` on window (watchlist.spec.ts).
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    };
    await refocus();
    // Refused through the client's retries: the cards and the count stay, under the notice.
    const notice = section(page).getByTestId('market-discussion-refresh-failed');
    await expect(notice).toHaveText(copy.marketRefreshFailed);
    expect(refused).toBeGreaterThan(0);
    await expect(
      section(page).locator(
        '[data-testid="market-discussion-refresh-failed"] ~ [data-testid="market-discussion-list"]',
      ),
    ).toHaveCount(1);
    await expect(section(page).getByTestId(`post-card-${id}`)).toBeVisible();
    await expect(section(page).getByTestId('market-discussion-count')).toHaveText('글 1');
    await expect(section(page).getByTestId('market-discussion-error')).toHaveCount(0);
    await expect(section(page).getByTestId('market-discussion-empty')).toHaveCount(0);

    // Readable again: the next refresh takes the notice away.
    await page.unroute(isRead);
    await refocus();
    await expect(notice).toHaveCount(0);
    await expect(list.getByRole('heading', { level: 3 })).toHaveText([title]);
  });

  test('첫 읽기가 실패하면 그 안내와 다시 시도를 보이고, 다시 시도로 글을 읽는다', async ({
    admin,
    page,
  }) => {
    // Reachable now that the browser makes the first read (owner decision 2026-10-20 1): before,
    // the server read the first page and `page.route` could not refuse it.
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const title = `첫 읽기 ${tag}`;
    const id = await postThroughApi(admin, market.id, title, tag);
    const isRead = isDiscussionRead(market.id);
    await page.route(isRead, (route) => route.fulfill(SERVER_ERROR));
    await openDetail(page, market.slug);

    // Refused through the client's retries: the failure and 다시 시도, with 글쓰기 still there and
    // nothing to count.
    const failed = section(page).getByTestId('market-discussion-error');
    await expect(failed.getByRole('alert')).toHaveText(copy.errUnknown);
    await expect(failed.getByRole('button', { name: copy.retry })).toBeVisible();
    await expect(section(page).getByTestId('market-discussion-loading')).toHaveCount(0);
    await expect(section(page).getByTestId('market-discussion-count')).toHaveCount(0);
    await expect(section(page).getByTestId('market-discussion-empty')).toHaveCount(0);
    await expect(section(page).getByTestId('market-discussion-write')).toHaveAttribute(
      'href',
      writeHref(market.id),
    );

    // Readable again: 다시 시도 brings the post and its count.
    await page.unroute(isRead);
    await failed.getByRole('button', { name: copy.retry }).click();
    await expect(section(page).getByTestId(`post-card-${id}`)).toBeVisible();
    await expect(
      section(page).getByTestId('market-discussion-list').getByRole('heading', { level: 3 }),
    ).toHaveText([title]);
    await expect(section(page).getByTestId('market-discussion-count')).toHaveText('글 1');
    await expect(failed).toHaveCount(0);
  });

  test('검색 로봇은 robots.txt로 /api/를 읽지 못하고 /api/의 답은 noindex이며, 시장 상세는 검색 엔진에 열려 있다', async ({
    admin,
    request,
  }) => {
    // Owner decision 2026-10-20 1: the 토론 is read from `/api/`, which crawlers are asked to
    // leave alone; every page stays open — the detail has no `noindex`. Two lines and no
    // `Allow: /`: Next would write it ahead of the `Disallow`, and a crawler that takes the first
    // matching line would then fetch `/api/` (lib/robots.test.ts reads the text both ways).
    const robots = await request.get('/robots.txt');
    expect(robots.status()).toBe(200);
    expect(robots.headers()['content-type']).toContain('text/plain');
    expect(
      (await robots.text())
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    ).toEqual(['User-Agent: *', 'Disallow: /api/']);

    const market = await createOpenMarket(admin);
    const html = await serverHtml(request, market.slug);
    expect(html).not.toMatch(/<meta name="robots"/);

    // Owner decision 2026-10-21: and every `/api` answer says `noindex`, through the web's own
    // origin as the browser reads the 토론 — for a crawler that fetches it anyway. The page does not.
    const posts = await request.get(`/api/v1/markets/${market.id}/posts`);
    expect(posts.status()).toBe(200);
    expect(posts.headers()['x-robots-tag']).toBe('noindex');
    const detail = await request.get(`/markets/${market.slug}`);
    expect(detail.status()).toBe(200);
    expect(detail.headers()['x-robots-tag']).toBeUndefined();
  });
});
