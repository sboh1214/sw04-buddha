import { type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test';
import type { Category, Me } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  E2E_REAL_NAME,
  createOpenMarket,
  expect,
  expectOnboardingClosureLink,
  freshEmail,
  freshTag,
  logOut,
  meOf,
  signUp,
  switchAccountUnderScreen,
  test,
} from './helpers';

/**
 * 공개 프로필 (#41, ADR-0078; owner decisions in ADR-0069 decision 3 #37, decision 4 #41 and of
 * 2026-10-21): a member edits the 소개 and the interest categories in MY 설정 and sees them on
 * their own profile at `/u/<publicId>`, which links back to MY 설정; cleared, neither shows, and
 * Back from MY 설정 shows each change, the nickname's too; MY's summary leads there as well. Anyone
 * reaches a profile from a byline — the post's, a comment's, a community card's — signed in or not,
 * and reads the same public items and counts (the likes received leave out the member's own, which
 * the post still counts); only the member gets the link to MY 설정, an admin's profile says
 * '운영자', and an old link shows the new nickname. The posts and comments on a profile are
 * authored.spec.ts's (#51). Every answer is `noindex`, the HTML is the
 * server's and holds nothing private, and an unknown public id is a 404. A member facing a
 * re-consent stays on MY 설정 to clear the 소개 and drop categories, and keeps its account cards (the
 * time zone, 2026-10-22 answer 1); a new 소개, a category added, a
 * nickname change and the marketing switch go to the step and come back (owner decisions 2026-10-21
 * answer 2 and 2026-10-22 answer 1, ADR-0078 7-24), with the 소개 typed and the categories picked
 * put back (2026-10-22 answer 3, 7-25), and the nickname typed (2026-10-22 (2nd) answer 2); the
 * step links to MY 설정 (answer 2, 7-26), and signing out drops what was kept. The field allow-list, the
 * counts' rules (deleted, hidden and voided content), the restriction hook and the refusals are the
 * API's tests (profiles.controller.test.ts, public-items*.test.ts, private-data.test.ts); this
 * walks the screens.
 */

/** A post straight at the API with the context's cookie: this spec's subject is its author. */
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

/** A comment straight at the API with the context's cookie: a 댓글, or a 대댓글 under `parentId`. */
async function commentThroughApi(
  context: APIRequestContext,
  postId: string,
  parentId: string | null,
  body: string,
): Promise<string> {
  const me = await meOf(context);
  const res = await context.post(`/api/v1/posts/${postId}/comments`, {
    data: { parentId, body, expectedAccountId: me.id },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** A like straight at the API with the context's cookie (`posts` or `comments`). */
async function likeThroughApi(
  context: APIRequestContext,
  target: 'posts' | 'comments',
  id: string,
): Promise<void> {
  const me = await meOf(context);
  const res = await context.put(`/api/v1/${target}/${id}/like`, {
    data: { liked: true, expectedAccountId: me.id },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** The active categories (`GET /categories`): a top-level one that has a sub-category, and it. */
async function topAndSub(context: APIRequestContext): Promise<{ top: Category; sub: Category }> {
  const res = await context.get('/api/v1/categories');
  expect(res.ok(), await res.text()).toBe(true);
  const categories = ((await res.json()) as { data: Category[] }).data;
  for (const top of categories.filter((row) => row.parentId === null)) {
    const sub = categories.find((row) => row.parentId === top.id);
    if (sub !== undefined) return { top, sub };
  }
  throw new Error('no top-level category with a sub-category: run `pnpm db:seed`');
}

/**
 * '2026년 10월 가입' for an account made at `createdAt`: the month in Korea time, as the API works
 * it out (ADR-0078) — Korea keeps no daylight saving, so nine hours ahead of UTC.
 */
function joinedText(createdAt: string): string {
  const korea = new Date(Date.parse(createdAt) + 9 * 60 * 60 * 1_000);
  return `${String(korea.getUTCFullYear())}${copy.profileYearUnit} ${String(korea.getUTCMonth() + 1)}${copy.profileMonthUnit} ${copy.profileJoined}`;
}

/** React's hydration complaints in the browser's console from now on (likes.spec.ts says why). */
function hydrationErrors(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydrat/i.test(message.text())) seen.push(message.text());
  });
  return seen;
}

/** The three counts as the profile draws them: 글, 댓글, 받은 좋아요. */
async function expectCounts(
  page: Page,
  posts: number,
  comments: number,
  likes: number,
): Promise<void> {
  const count = (key: string) => page.getByTestId(`profile-count-${key}`);
  await expect(count('posts')).toHaveText(`${copy.profilePostCount}${String(posts)}`);
  await expect(count('comments')).toHaveText(`${copy.profileCommentCount}${String(comments)}`);
  await expect(count('likes')).toHaveText(`${copy.profileReceivedLikes}${String(likes)}`);
}

/**
 * `GET /me` in this page answering as the server would after a revision of the terms that changed
 * members' rights, while `on`; agreeing on the step turns it off (likes.spec.ts and comments.spec.ts
 * draw it the same way — no spec can bring about a re-consent for real).
 */
async function asReconsent(page: Page): Promise<{ on: boolean }> {
  const state = { on: false };
  await page.route('**/api/v1/me', async (route) => {
    if (route.request().method() !== 'GET' || !state.on) return route.fallback();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = (await response.json()) as { data: Me };
    const { onboarding } = body.data;
    body.data.onboarding = {
      ...onboarding,
      consent: false,
      completed: false,
      nextStep: 'consent',
      consents: onboarding.consents.map((answer) =>
        answer.item === 'terms' ? { ...answer, version: 'draft-1999-01-01' } : answer,
      ),
    };
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/v1/me/consents', async (route) => {
    const response = await route.fetch();
    state.on = false;
    await route.fulfill({ response });
  });
  return state;
}

/** The consent step of a re-consent, agreed on screen. */
async function agreeAgain(page: Page): Promise<void> {
  await expect(page.getByTestId('onboarding-return-reason')).toHaveText(
    copy.onboardingReconsentReason,
  );
  await page.getByTestId('consent-all').click();
  await page.getByTestId('consent-submit').click();
}

/** The 소개 as the page lays it out: its line breaks as `\n` (`pre-line`), never a link in it. */
async function expectBio(bio: Locator, text: string): Promise<void> {
  await expect.poll(() => bio.innerText()).toBe(text);
  await expect(bio.locator('a')).toHaveCount(0);
}

test.describe('공개 프로필', () => {
  test('회원이 MY 설정에서 소개와 관심 카테고리를 고치면 자기 공개 프로필에 보이고, 자기 프로필에만 MY 설정으로 가는 링크가 있으며, 비우면 둘 다 사라지고, 고친 뒤 뒤로 가기로 돌아간 프로필에도 바뀐 것이 보인다', async ({
    page,
  }) => {
    const tag = freshTag();
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const { top, sub } = await topAndSub(page.request);
    const hydration = hydrationErrors(page);

    // --- MY 설정: the 소개, two lines and an address, counted as the server counts it.
    await page.goto('/my/settings');
    const bioCard = page.getByTestId('settings-bio');
    const bioInput = bioCard.getByTestId('bio-input');
    const bio = `안녕하세요 ${tag}\nhttps://example.com/${tag} 는 링크가 아닙니다`;
    await bioInput.fill(`  ${bio}  `);
    await expect(bioCard.getByTestId('bio-length')).toHaveText(
      `${String(Array.from(bio).length)} / 160${copy.bioLengthUnit}`,
    );
    // Over the limit: counted past it, said, and not sent.
    await bioInput.fill('가'.repeat(161));
    await expect(bioCard.getByTestId('bio-length')).toHaveText(`161 / 160${copy.bioLengthUnit}`);
    await expect(bioCard.getByTestId('bio-limit')).toHaveText(copy.errBioTooLong);
    await expect(bioCard.getByTestId('bio-save')).toBeDisabled();
    await bioInput.fill(`  ${bio}  `);
    await bioCard.getByTestId('bio-save').click();
    await expect(page.getByText(copy.bioSaved)).toBeVisible();
    // What the server kept: trimmed, the line break kept.
    await expect(bioInput).toHaveValue(bio);
    await expect(bioCard.getByTestId('bio-save')).toBeDisabled();

    // --- the interest categories: a top-level one and a sub-category (#57-7), as many as liked.
    const interests = page.getByTestId('settings-interests');
    const save = interests.getByTestId('interests-settings-save');
    await expect(save).toBeDisabled();
    await interests.getByTestId(`interest-${top.slug}`).click();
    await interests.getByTestId(`interest-${sub.slug}`).click();
    await save.click();
    await expect(page.getByText(copy.interestsSaved)).toBeVisible();
    await expect(save).toBeDisabled();
    expect((await meOf(page.request)).profile).toMatchObject({
      bio,
      interestCategoryIds: [top.id, sub.id].sort((a, b) => a - b),
    });

    // --- the own profile, from the 프로필 card: everything public, and the way back.
    await page.getByTestId('settings-view-profile').click();
    await expect(page).toHaveURL(`/u/${me.profile.publicId}`);
    await expect(page.getByTestId('profile-nickname')).toHaveText(me.profile.nickname);
    await expect(page.getByTestId('profile-admin')).toHaveCount(0);
    await expect(page.getByTestId('profile-joined')).toHaveText(joinedText(me.profile.createdAt));
    await expectBio(page.getByTestId('profile-bio'), bio);
    await expect(page.getByTestId(`profile-interest-${top.slug}`)).toHaveText(top.nameKo);
    await expect(page.getByTestId(`profile-interest-${sub.slug}`)).toHaveText(
      `${top.nameKo} › ${sub.nameKo}`,
    );
    await expectCounts(page, 0, 0, 0);
    // The 글·댓글 area (#51, ADR-0080): nothing written yet, said on the tab shown first.
    await expect(page.getByTestId('profile-posts-list-empty')).toHaveText(copy.authoredPostsEmpty);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    // A category named at length (32 characters a name, the seed's today and the operators' with
    // #17) stays inside the line: its chip is cut short, and the page never scrolls sideways at
    // 375px. A copy of the sub-category's chip with such a trail, beside the real ones.
    const fits = await page.getByTestId(`profile-interest-${sub.slug}`).evaluate((chip) => {
      const item = chip.closest('li');
      const list = item?.parentElement;
      if (!item || !list) throw new Error('a chip outside its list');
      const copied = item.cloneNode(true) as HTMLElement;
      const copiedChip = copied.querySelector('[data-testid]') ?? copied;
      const label = copiedChip.firstElementChild ?? copiedChip;
      label.textContent = `${'아주 긴 상위 카테고리 이름'.repeat(2)} › ${'하위카테고리이름'.repeat(4)}`;
      item.after(copied);
      const root = document.documentElement;
      const measured = {
        chipInLine:
          copiedChip.getBoundingClientRect().right <= list.getBoundingClientRect().right + 0.5,
        pageInView: root.scrollWidth <= root.clientWidth,
      };
      copied.remove();
      return measured;
    });
    expect(fits).toEqual({ chipInLine: true, pageInView: true });
    await page.getByTestId('profile-edit').click();
    await expect(page).toHaveURL('/my/settings');

    // --- cleared (#37-19: deleting a profile item): an empty 소개 and no category show nothing.
    // Each save is seen at once on Back to the profile: the router would otherwise draw the
    // profile it kept from before the save (ADR-0078 7-12). Waiting for the nickname first, so
    // what is read is the profile and not the screen being left. The 소개 first.
    const profileUrl = `/u/${me.profile.publicId}`;
    await bioInput.fill('   ');
    await bioCard.getByTestId('bio-save').click();
    await expect(page.getByText(copy.bioCleared)).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(profileUrl);
    await expect(page.getByTestId('profile-nickname')).toHaveText(me.profile.nickname);
    await expect(page.getByTestId('profile-bio')).toHaveCount(0);
    await expect(page.getByTestId(`profile-interest-${sub.slug}`)).toBeVisible();
    // Then the categories, every one unpicked.
    await page.getByTestId('profile-edit').click();
    await expect(page).toHaveURL('/my/settings');
    await interests.getByTestId(`interest-${top.slug}`).click();
    await interests.getByTestId(`interest-${sub.slug}`).click();
    await save.click();
    // The first save's toast may still be up: the server's answer says this one landed.
    await expect(save).toBeDisabled();
    await expect
      .poll(async () => (await meOf(page.request)).profile.interestCategoryIds)
      .toEqual([]);
    await page.goBack();
    await expect(page.getByTestId('profile-nickname')).toHaveText(me.profile.nickname);
    await expect(page.getByTestId('profile-interests')).toHaveCount(0);
    // And the nickname, from the 프로필 card: the first change after the onboarding is open.
    await page.getByTestId('profile-edit').click();
    await expect(page).toHaveURL('/my/settings');
    const nickname = `p${tag}`.slice(0, 20);
    const profileCard = page.getByTestId('settings-profile');
    await profileCard.getByTestId('nickname-input').fill(nickname);
    await profileCard.getByRole('button', { name: copy.save }).click();
    await expect(page.getByText(copy.nicknameSaved)).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(profileUrl);
    await expect(page.getByTestId('profile-nickname')).toHaveText(nickname);
    await expect(page.getByTestId('profile-bio')).toHaveCount(0);
    await expect(page.getByTestId('profile-interests')).toHaveCount(0);
    await expect(page.getByTestId('profile-edit')).toBeVisible();

    // --- MY's summary leads to the own profile too (owner decision 2026-10-21 answer 7).
    await page.goto('/my');
    await page.getByTestId('my-view-profile').click();
    await expect(page).toHaveURL(profileUrl);
    await expect(page.getByTestId('profile-nickname')).toHaveText(nickname);
    expect(hydration).toEqual([]);
  });

  test('작성자 표기(글·댓글·카드)에서 누구나 그 프로필로 가 같은 공개 항목과 수를 보고, 운영자의 프로필에는 운영자 표시가, 닉네임을 바꿔도 옛 주소에 새 닉네임이 보이며, 없는 프로필은 404다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    const email = freshEmail();
    const phone = await signUp(page, email);
    const me: Me = await meOf(page.request);
    const profileUrl = `/u/${me.profile.publicId}`;
    const bio = `공개 소개 ${tag}`;
    const saved = await page.request.put('/api/v1/me/bio', {
      data: { bio, expectedAccountId: me.id },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    // The member's post, the admin's 댓글 under it and the member's 대댓글 under that; the admin
    // likes the post and the 대댓글, and so does the member — its own likes, which the total it
    // received leaves out (owner decision 2026-10-21 answer 3). A post the member deleted counts for
    // nothing (#37-14).
    const postId = await postThroughApi(page.request, market.id, `프로필 글 ${tag}`, tag);
    const adminComment = await commentThroughApi(admin, postId, null, `운영자의 댓글 ${tag}`);
    const reply = await commentThroughApi(page.request, postId, adminComment, `답글 ${tag}`);
    await likeThroughApi(admin, 'posts', postId);
    await likeThroughApi(admin, 'comments', reply);
    await likeThroughApi(page.request, 'posts', postId);
    await likeThroughApi(page.request, 'comments', reply);
    const gone = await postThroughApi(page.request, market.id, `지울 글 ${tag}`, `${tag} 지움`);
    const deleted = await page.request.post(`/api/v1/posts/${gone}/delete`, {
      data: { expectedAccountId: me.id },
    });
    expect(deleted.status(), await deleted.text()).toBe(200);

    // --- the post's byline leads to the author's profile: 1 post, 1 comment, 2 likes received —
    // the admin's two, while the post itself counts the member's like too.
    await page.goto(`/community/posts/${postId}`);
    await expect(page.getByTestId('post-like')).toContainText(`${copy.likeToggle} 2`);
    await page.getByTestId('post-screen').getByTestId('post-author-link').first().click();
    await expect(page).toHaveURL(profileUrl);
    await expect(page.getByTestId('profile-nickname')).toHaveText(me.profile.nickname);
    await expect(page.getByTestId('profile-bio')).toHaveText(bio);
    await expectCounts(page, 1, 1, 2);
    await expect(page.getByTestId('profile-edit')).toBeVisible();

    // --- a 댓글's byline leads to its author: the admin's profile says 운영자 (#45-9), and the
    // member, who is not that admin, gets no link to MY 설정.
    await page.goto(`/community/posts/${postId}`);
    await page.getByTestId(`comment-${adminComment}`).getByTestId('post-author-link').click();
    await expect(page).toHaveURL(/\/u\/[a-z0-9]{10}$/);
    expect(page.url()).not.toContain(me.profile.publicId);
    await expect(page.getByTestId('profile-admin')).toHaveText(copy.postAuthorAdmin);
    await expect(page.getByTestId('profile-counts')).toBeVisible();
    await expect(page.getByTestId('profile-edit')).toHaveCount(0);

    // --- an old link after a nickname change shows the new nickname (#37-2·#37-3): the first
    // change after the onboarding is open.
    const nickname = `p${tag}`.slice(0, 20);
    const renamed = await page.request.patch('/api/v1/me', {
      data: { nickname, expectedAccountId: me.id },
    });
    expect(renamed.status(), await renamed.text()).toBe(200);

    // --- a visitor: the community card's byline, the same profile, no link to MY 설정.
    await logOut(page);
    await page.goto(`/community?q=${tag}`);
    await page.getByTestId(`post-card-${postId}`).getByTestId('post-author-link').click();
    await expect(page).toHaveURL(profileUrl);
    await expect(page.getByTestId('profile-nickname')).toHaveText(nickname);
    await expect(page.getByTestId('profile-bio')).toHaveText(bio);
    await expectCounts(page, 1, 1, 2);
    await expect(page.getByTestId('profile-posts')).toBeVisible();
    await expect(page.getByTestId('profile-edit')).toHaveCount(0);

    // The HTML as a crawler reads it: drawn by the server, `noindex`, the public items only — no
    // email, real name, number or account id (#37-8, #37-11), no earlier nickname (#37-3).
    const html = await (await page.request.get(profileUrl)).text();
    expect(html).toMatch(/<meta name="robots" content="noindex"/);
    expect(html).toContain(nickname);
    expect(html).toContain(bio);
    for (const secret of [email, E2E_REAL_NAME, phone, me.id, me.profile.nickname]) {
      expect(html).not.toContain(secret);
    }

    // The public id typed in capitals finds the same member; an unknown one is a 404, noindex too.
    await page.goto(`/u/${me.profile.publicId.toUpperCase()}`);
    await expect(page.getByTestId('profile-nickname')).toHaveText(nickname);
    const missing = await page.goto('/u/zzzzzzzzzz');
    expect(missing?.status()).toBe(404);
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute('content', /noindex/);
  });

  test('재동의가 남은 회원은 MY 설정에서 로그인만으로 소개를 비우고 관심 카테고리를 빼며 계정 관리 카드(시간대)도 그대로 쓰고, 새 소개·카테고리 더하기·닉네임 바꾸기와 마케팅 정보 수신은 보내지 않고 남은 단계로 갔다가 마치면 MY 설정으로 돌아와 쓰던 소개·고른 카테고리·쓰던 닉네임을 되살리고, 재동의 단계에는 MY 설정으로 가는 링크가 있으며, 로그아웃하면 둔 것이 사라진다', async ({
    page,
  }) => {
    const tag = freshTag();
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const { top, sub } = await topAndSub(page.request);
    // A 소개 and a category, written while nothing was left — straight at the API.
    const bio = `재동의 전에 쓴 소개 ${tag}`;
    let res = await page.request.put('/api/v1/me/bio', {
      data: { bio, expectedAccountId: me.id },
    });
    expect(res.status(), await res.text()).toBe(200);
    res = await page.request.put('/api/v1/me/interest-categories', {
      data: { categoryIds: [top.id], expectedAccountId: me.id },
    });
    expect(res.status(), await res.text()).toBe(200);

    const settings = '/my/settings';
    const viaStep = `/onboarding?next=${encodeURIComponent(settings)}`;
    // What the browser sends of the public items — the nickname's included — and of the consent.
    const profileWrites: string[] = [];
    let consentWrites = 0;
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (
        (request.method() === 'PUT' &&
          (pathname === '/api/v1/me/bio' || pathname === '/api/v1/me/interest-categories')) ||
        (request.method() === 'PATCH' && pathname === '/api/v1/me')
      ) {
        profileWrites.push(`${request.method()} ${pathname}`);
      }
      if (request.method() === 'POST' && pathname === '/api/v1/me/consents') consentWrites += 1;
    });
    const reconsent = await asReconsent(page);
    /** The browser's read of `GET /me`, which says the step is left — the cards wait for it. */
    const meRead = () =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/me' &&
          response.request().method() === 'GET',
      );
    const reloadAsReconsent = async () => {
      reconsent.on = true;
      const read = meRead();
      await page.reload();
      await read;
      await expect(page).toHaveURL(settings);
    };
    /** What this tab keeps of MY 설정 for the step's return (lib/profile-drafts.ts). */
    const keptDrafts = () =>
      page.evaluate(() =>
        Object.keys(sessionStorage)
          .filter((key) => key.startsWith('buddha.profileDraft:'))
          .sort(),
      );
    const bioCard = page.getByTestId('settings-bio');
    const bioInput = bioCard.getByTestId('bio-input');
    const interests = page.getByTestId('settings-interests');
    const save = interests.getByTestId('interests-settings-save');
    const subBox = interests.getByTestId(`interest-${sub.slug}`).getByRole('checkbox');
    const profileCard = page.getByTestId('settings-profile');
    const nicknameInput = profileCard.getByTestId('nickname-input');
    const restored = page.getByText(copy.profileDraftRestored);

    // --- MY 설정 stays open for the re-consent (ADR-0078 7-24), with the account's 소개.
    reconsent.on = true;
    const firstRead = meRead();
    await page.goto(settings);
    await firstRead;
    await expect(page).toHaveURL(settings);
    await expect(bioInput).toHaveValue(bio);

    // --- 탈퇴 (#140) from MY 설정's last card: the screen is open to the account as to any with a
    // step left, and its way back stays on MY 설정, open to this one (ADR-0086 결과 5 (9)).
    await page.getByTestId('settings-closure-open').click();
    await expect(page).toHaveURL('/my/settings/closure');
    await expect(page.getByTestId('closure-coin')).toBeVisible();
    await page.getByTestId('closure-back').click();
    await expect(page).toHaveURL(settings);
    await expect(bioInput).toHaveValue(bio);

    // --- a new 소개: not sent — the step, which links back to MY 설정 (owner decision 2026-10-22
    // answer 2); agreed, back on MY 설정 with the 소개 typed put back in its box, unsaved (answer 3).
    await bioInput.fill(`${bio} 더`);
    await bioCard.getByTestId('bio-save').click();
    await expect(page).toHaveURL(viaStep);
    expect(await keptDrafts()).toEqual(['buddha.profileDraft:bio']);
    const settingsLink = page.getByTestId('onboarding-settings-link');
    await expect(settingsLink).toContainText(copy.onboardingReconsentSettingsHint);
    await expect(
      settingsLink.getByRole('link', { name: copy.onboardingReconsentSettingsLink }),
    ).toHaveAttribute('href', settings);
    // The step's '탈퇴하기' (#140) stays at the very bottom, under this line too (ADR-0086 결과 5
    // (9), 오너 결정 2026-10-23 (4차) 1).
    await expectOnboardingClosureLink(page);
    const line = await settingsLink.boundingBox();
    const leave = await page.getByTestId('onboarding-closure').boundingBox();
    expect(leave!.y).toBeGreaterThan(line!.y + line!.height - 1);
    await agreeAgain(page);
    await expect(page).toHaveURL(settings);
    await expect(bioInput).toHaveValue(`${bio} 더`);
    await expect(restored).toBeVisible();
    await expect(bioCard.getByTestId('bio-save')).toBeEnabled();
    expect(await keptDrafts()).toEqual([]);
    expect(profileWrites).toEqual([]);

    // --- a category added goes the same way, and comes back picked.
    await reloadAsReconsent();
    // The reload dropped the 소개 put back unsaved: nothing of it was kept any more.
    await expect(bioInput).toHaveValue(bio);
    await interests.getByTestId(`interest-${sub.slug}`).click();
    await save.click();
    await expect(page).toHaveURL(viaStep);
    expect(await keptDrafts()).toEqual(['buddha.profileDraft:interests']);
    await agreeAgain(page);
    await expect(page).toHaveURL(settings);
    await expect(subBox).toBeChecked();
    await expect(save).toBeEnabled();
    expect(profileWrites).toEqual([]);

    // --- so does a nickname change (answer 1: the server would refuse it), with the 소개 typed in
    // its own card meanwhile kept too — whichever card sent the page — and the nickname typed kept
    // and put back unsaved like them (owner decision 2026-10-22 (2nd) answer 2, ADR-0078 7-25).
    await reloadAsReconsent();
    await expect(subBox).not.toBeChecked();
    const nicknameSave = profileCard.getByRole('button', { name: copy.save });
    const typedNickname = `n${tag}`.slice(0, 20);
    await bioInput.fill(`${bio} 닉네임과 함께`);
    await nicknameInput.fill(typedNickname);
    await nicknameSave.click();
    await expect(page).toHaveURL(viaStep);
    expect(await keptDrafts()).toEqual(['buddha.profileDraft:bio', 'buddha.profileDraft:nickname']);
    await agreeAgain(page);
    await expect(page).toHaveURL(settings);
    await expect(nicknameInput).toHaveValue(typedNickname);
    await expect(bioInput).toHaveValue(`${bio} 닉네임과 함께`);
    await expect(restored).toBeVisible();
    await expect(nicknameSave).toBeEnabled();
    expect(await keptDrafts()).toEqual([]);
    expect(profileWrites).toEqual([]);
    expect((await meOf(page.request)).profile.nickname).toBe(me.profile.nickname);

    // --- the step's link leads to MY 설정 before agreeing: what was kept stays kept — the nickname
    // typed too (2026-10-22 (2nd) answer 3) — and comes back only once the step is done — reached
    // here by the marketing switch, which goes to the step too (a consent record comes with the
    // consent step's items).
    await reloadAsReconsent();
    // The reload dropped the nickname put back unsaved, as the 소개's.
    await expect(nicknameInput).toHaveValue(me.profile.nickname);
    const linkNickname = `l${tag}`.slice(0, 20);
    await nicknameInput.fill(linkNickname);
    await bioInput.fill(`${bio} 링크`);
    await bioCard.getByTestId('bio-save').click();
    await expect(page).toHaveURL(viaStep);
    await settingsLink.getByRole('link', { name: copy.onboardingReconsentSettingsLink }).click();
    await expect(page).toHaveURL(settings);
    await expect(bioInput).toHaveValue(bio);
    await expect(nicknameInput).toHaveValue(me.profile.nickname);
    expect(await keptDrafts()).toEqual(['buddha.profileDraft:bio', 'buddha.profileDraft:nickname']);
    const consentsBefore = consentWrites;
    await page.getByTestId('settings-marketing-switch').click();
    await expect(page).toHaveURL(viaStep);
    expect(consentWrites).toBe(consentsBefore);
    await agreeAgain(page);
    await expect(page).toHaveURL(settings);
    await expect(bioInput).toHaveValue(`${bio} 링크`);
    await expect(nicknameInput).toHaveValue(linkNickname);
    expect(profileWrites).toEqual([]);

    // --- clearing the 소개 and dropping the category: sent with a session alone, right here.
    await reloadAsReconsent();
    await bioInput.fill('');
    await bioCard.getByTestId('bio-save').click();
    await expect(page.getByText(copy.bioCleared)).toBeVisible();
    await interests.getByTestId(`interest-${top.slug}`).click();
    await save.click();
    await expect(page.getByText(copy.interestsSaved)).toBeVisible();
    await expect(page).toHaveURL(settings);
    expect(profileWrites).toEqual(['PUT /api/v1/me/bio', 'PUT /api/v1/me/interest-categories']);
    expect((await meOf(page.request)).profile).toMatchObject({
      bio: null,
      interestCategoryIds: [],
    });

    // --- the account cards stay as they are (owner decision 2026-10-22 answer 1): the time zone,
    // one of them, saves right here with a session alone — no step.
    await page.getByTestId('time-zone-select').selectOption('Asia/Tokyo');
    await page.getByTestId('time-zone-save').click();
    await expect(page.getByText(copy.timeZoneSaved)).toBeVisible();
    await expect(page).toHaveURL(settings);
    expect((await meOf(page.request)).profile.timeZone).toBe('Asia/Tokyo');

    // --- MY's other screens still send the re-consent to its step.
    await page.goto('/my');
    await expect(page).toHaveURL(`/onboarding?next=${encodeURIComponent('/my')}`);

    // --- signing out in the tab drops what a trip to the step kept (as the posts' and comments').
    await page.goto(settings);
    await expect(page).toHaveURL(settings);
    await bioInput.fill(`로그아웃 전에 쓴 소개 ${tag}`);
    await nicknameInput.fill(`o${tag}`.slice(0, 20));
    await bioCard.getByTestId('bio-save').click();
    await expect(page).toHaveURL(viaStep);
    expect(await keptDrafts()).toEqual(['buddha.profileDraft:bio', 'buddha.profileDraft:nickname']);
    await page.getByTestId('onboarding-logout').click();
    await expect(page).toHaveURL('/');
    expect(await keptDrafts()).toEqual([]);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('재동의를 늦게 안 MY 설정 — 단계를 말하기 전에 보낸 닉네임·소개가 온보딩으로 거절되면 알림 없이 단계로 가며 쓰던 것을 두고(갈 곳이 없으면 닉네임 카드도 소개와 같은 문장), 카테고리 목록이 읽히기 전에는 카테고리를 두지도 되살리지도 않으며, 다른 탭에서 마친 단계를 늦게 알아도 고치던 소개·닉네임을 덮지 않는다', async ({
    page,
  }) => {
    const tag = freshTag();
    await signUp(page, freshEmail());
    const me = await meOf(page.request);
    const { top, sub } = await topAndSub(page.request);
    const bio = `거절 전에 쓴 소개 ${tag}`;
    let res = await page.request.put('/api/v1/me/bio', {
      data: { bio, expectedAccountId: me.id },
    });
    expect(res.status(), await res.text()).toBe(200);
    res = await page.request.put('/api/v1/me/interest-categories', {
      data: { categoryIds: [top.id], expectedAccountId: me.id },
    });
    expect(res.status(), await res.text()).toBe(200);

    const settings = '/my/settings';
    const viaStep = `/onboarding?next=${encodeURIComponent(settings)}`;
    const profileWrites: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (
        (request.method() === 'PUT' &&
          (pathname === '/api/v1/me/bio' || pathname === '/api/v1/me/interest-categories')) ||
        (request.method() === 'PATCH' && pathname === '/api/v1/me')
      ) {
        profileWrites.push(`${request.method()} ${pathname}`);
      }
    });
    const reconsent = await asReconsent(page);
    /**
     * `method path` answered once as the server answers an account a revision of the terms asked
     * the consent again — after the page's `GET /me` said nothing was left — and `GET /me` saying
     * so from then on (the hook reads it again before the refusal reaches the card).
     */
    const refuseOnceForReconsent = async (method: string, path: string) => {
      let refused = false;
      await page.route(`**${path}`, async (route) => {
        if (route.request().method() !== method || refused) return route.fallback();
        refused = true;
        reconsent.on = true;
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'ONBOARDING_REQUIRED',
              message: 'The onboarding is not done',
              details: { steps: ['consent'] },
            },
          },
        });
      });
    };
    /** `GET /categories` held until the returned function lets it go (the list not loaded yet). */
    const holdCategories = async () => {
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/v1/categories', async (route) => {
        await held;
        await route.fallback();
      });
      return release;
    };
    const reloadAsReconsent = async () => {
      reconsent.on = true;
      const read = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/me' &&
          response.request().method() === 'GET',
      );
      await page.reload();
      await read;
      await expect(page).toHaveURL(settings);
    };
    const keptDrafts = () =>
      page.evaluate(() =>
        Object.keys(sessionStorage)
          .filter((key) => key.startsWith('buddha.profileDraft:'))
          .sort(),
      );
    const bioCard = page.getByTestId('settings-bio');
    const bioInput = bioCard.getByTestId('bio-input');
    const interests = page.getByTestId('settings-interests');
    const save = interests.getByTestId('interests-settings-save');
    const subBox = interests.getByTestId(`interest-${sub.slug}`).getByRole('checkbox');
    const profileCard = page.getByTestId('settings-profile');
    const nicknameInput = profileCard.getByTestId('nickname-input');
    const restored = page.getByText(copy.profileDraftRestored);

    // --- MY 설정 drawn while `GET /me` said nothing was left; a revision asks the consent again
    // meanwhile, and the nickname change sent is refused for it (`PATCH /me`, ADR-0078 7-27). With
    // nowhere to go — `GET /me` read again fails (a 429 is not retried), so `['me']` still says
    // nothing is left — the card stays and says MY 설정's sentence, the 소개's, not the onboarding
    // stepper's (7-24, `settingsNicknameFailure`), and nothing is kept.
    reconsent.on = false;
    await page.goto(settings);
    await expect(bioInput).toHaveValue(bio);
    let refusedOnce = false;
    let readFailed = false;
    const nowhereToGo = async (route: Route) => {
      const method = route.request().method();
      if (method === 'PATCH' && !refusedOnce) {
        refusedOnce = true;
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'ONBOARDING_REQUIRED',
              message: 'The onboarding is not done',
              details: { steps: ['consent'] },
            },
          },
        });
      }
      if (method === 'GET' && refusedOnce && !readFailed) {
        readFailed = true;
        return route.fulfill({
          status: 429,
          json: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
        });
      }
      return route.fallback();
    };
    await page.route('**/api/v1/me', nowhereToGo);
    await bioInput.fill(`${bio} 갈 곳 없음`);
    await nicknameInput.fill(`r${tag}`.slice(0, 20));
    await profileCard.getByRole('button', { name: copy.save }).click();
    await expect(profileCard.getByTestId('nickname-notice')).toHaveText(copy.errPostOnboarding);
    expect(readFailed).toBe(true);
    await expect(page).toHaveURL(settings);
    expect(await keptDrafts()).toEqual([]);
    await page.unroute('**/api/v1/me', nowhereToGo);

    // --- the same refusal with `GET /me` read again saying the re-consent: the card goes on to the
    // step without a word, the 소개 typed in its own card kept (7-24, 7-25) and the nickname typed
    // too, put back unsaved on return (owner decision 2026-10-22 (2nd) answer 2).
    const refusedNickname = `r${tag}`.slice(0, 20);
    await refuseOnceForReconsent('PATCH', '/api/v1/me');
    await bioInput.fill(`${bio} 닉네임과 거절`);
    await nicknameInput.fill(refusedNickname);
    await profileCard.getByRole('button', { name: copy.save }).click();
    await expect(page).toHaveURL(viaStep);
    expect(await keptDrafts()).toEqual(['buddha.profileDraft:bio', 'buddha.profileDraft:nickname']);
    expect(profileWrites).toEqual(['PATCH /api/v1/me', 'PATCH /api/v1/me']);
    await agreeAgain(page);
    await expect(page).toHaveURL(settings);
    await expect(bioInput).toHaveValue(`${bio} 닉네임과 거절`);
    await expect(restored).toBeVisible();
    await expect(nicknameInput).toHaveValue(refusedNickname);
    expect((await meOf(page.request)).profile.nickname).toBe(me.profile.nickname);

    // --- the 소개's own save refused the same way (`PUT /me/bio`): to the step, every card's kept
    // (the nickname put back unsaved is the box's still).
    await interests.getByTestId(`interest-${sub.slug}`).click();
    await refuseOnceForReconsent('PUT', '/api/v1/me/bio');
    await bioCard.getByTestId('bio-save').click();
    await expect(page).toHaveURL(viaStep);
    expect(await keptDrafts()).toEqual([
      'buddha.profileDraft:bio',
      'buddha.profileDraft:interests',
      'buddha.profileDraft:nickname',
    ]);
    expect(profileWrites).toEqual(['PATCH /api/v1/me', 'PATCH /api/v1/me', 'PUT /api/v1/me/bio']);
    await agreeAgain(page);
    await expect(page).toHaveURL(settings);
    await expect(bioInput).toHaveValue(`${bio} 닉네임과 거절`);
    await expect(subBox).toBeChecked();
    await expect(nicknameInput).toHaveValue(refusedNickname);
    expect(await keptDrafts()).toEqual([]);
    expect((await meOf(page.request)).profile).toMatchObject({
      bio,
      interestCategoryIds: [top.id],
    });

    // --- the categories' list not loaded yet: the card keeps nothing as the page goes to the step
    // (nothing on screen was picked or unpicked — read among no categories, the account's would
    // look dropped, and a save of that clears them).
    let releaseList = await holdCategories();
    await reloadAsReconsent();
    await expect(bioInput).toHaveValue(bio);
    await expect(save).toBeDisabled();
    await bioInput.fill(`${bio} 목록 전`);
    await bioCard.getByTestId('bio-save').click();
    await expect(page).toHaveURL(viaStep);
    expect(await keptDrafts()).toEqual(['buddha.profileDraft:bio']);
    await agreeAgain(page);
    await expect(page).toHaveURL(settings);
    await expect(bioInput).toHaveValue(`${bio} 목록 전`);
    releaseList();
    await expect(interests.getByTestId(`interest-${top.slug}`).getByRole('checkbox')).toBeChecked();
    await expect(subBox).not.toBeChecked();
    await expect(save).toBeDisabled();

    // --- the picks kept come back only once the list has loaded: MY 설정 opened afresh after the
    // step was done elsewhere, the list held — what was kept waits for it, then is put back.
    await reloadAsReconsent();
    await interests.getByTestId(`interest-${sub.slug}`).click();
    await save.click();
    await expect(page).toHaveURL(viaStep);
    expect(await keptDrafts()).toEqual(['buddha.profileDraft:interests']);
    releaseList = await holdCategories();
    reconsent.on = false;
    await page.goto(settings);
    await expect(bioInput).toHaveValue(bio);
    expect(await keptDrafts()).toEqual(['buddha.profileDraft:interests']);
    releaseList();
    await expect(subBox).toBeChecked();
    await expect(restored).toBeVisible();
    await expect(save).toBeEnabled();
    expect(await keptDrafts()).toEqual([]);

    // --- the step done in another tab, learned late (a later `['me']`) while the member is typing
    // a 소개 and a nickname on MY 설정 reached by the step's link: what is typed is not written over
    // (the newer typing wins — owner decision 2026-10-22 (2nd) answer 4, and answer 2 for the
    // nickname), nothing is said, and what the trip kept is dropped (ADR-0078 7-25 (3)).
    await reloadAsReconsent();
    await expect(nicknameInput).toHaveValue(me.profile.nickname);
    await bioInput.fill(`${bio} 두었던 것`);
    await nicknameInput.fill(`k${tag}`.slice(0, 20));
    await bioCard.getByTestId('bio-save').click();
    await expect(page).toHaveURL(viaStep);
    await page
      .getByTestId('onboarding-settings-link')
      .getByRole('link', { name: copy.onboardingReconsentSettingsLink })
      .click();
    await expect(page).toHaveURL(settings);
    await expect(bioInput).toHaveValue(bio);
    await expect(nicknameInput).toHaveValue(me.profile.nickname);
    expect(await keptDrafts()).toEqual(['buddha.profileDraft:bio', 'buddha.profileDraft:nickname']);
    await bioInput.fill(`${bio} 지금 쓰는 것`);
    const newerNickname = `w${tag}`.slice(0, 20);
    await nicknameInput.fill(newerNickname);
    // Agreed elsewhere; this tab learns it from the answer to dropping the category here.
    reconsent.on = false;
    await interests.getByTestId(`interest-${top.slug}`).click();
    await save.click();
    await expect(page.getByText(copy.interestsSaved)).toBeVisible();
    await expect.poll(keptDrafts).toEqual([]);
    await expect(bioInput).toHaveValue(`${bio} 지금 쓰는 것`);
    await expect(nicknameInput).toHaveValue(newerNickname);
    await expect(restored).toHaveCount(0);
    await expect(bioCard.getByTestId('bio-save')).toBeEnabled();
    expect((await meOf(page.request)).profile).toMatchObject({
      bio,
      nickname: me.profile.nickname,
      interestCategoryIds: [],
    });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('탭의 계정이 다른 회원으로 바뀐 뒤 앞 계정의 MY 설정이 남아 있으면 관심 카테고리 저장과 마케팅 정보 수신은 그 화면의 계정을 대어 거절되고, 어느 계정에도 쓰이지 않는다', async ({
    browser,
    page,
  }) => {
    // PR #224 Codex review (ADR-0078 7-29): in the render between the session naming B and
    // SessionCacheGuard's reset the cards still show A's `Me` while the session already says B, and
    // a body naming the session's account would be taken with B's cookie — A's picks written to B,
    // A's marketing answer recorded as B's. The cards name the account of the `Me` they were drawn
    // from, so the server refuses both as another account's. That render is held here: B's cookie
    // in this tab and the session read again, while `GET /me` still answers as A
    // (`switchAccountUnderScreen`).
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      const b = await meOf(other.request);
      await signUp(page, freshEmail());
      const a = await meOf(page.request);
      const { top } = await topAndSub(page.request);
      await page.goto('/my/settings');
      const interests = page.getByTestId('settings-interests');
      await expect(interests.getByTestId(`interest-${top.slug}`)).toBeVisible();
      await shownContext.addCookies(await page.context().cookies());
      await switchAccountUnderScreen(page, shownContext.request, {
        id: b.id,
        cookies: await otherContext.cookies(),
      });

      const writes: unknown[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path === '/api/v1/me/interest-categories' || path === '/api/v1/me/consents') {
          writes.push(request.postDataJSON());
        }
      });
      // A's card, drawn again from A's `Me` after the guard's reset.
      const box = interests.getByTestId(`interest-${top.slug}`);
      await expect(box).toBeVisible();
      await box.click();
      const savedInterests = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/v1/me/interest-categories',
      );
      await interests.getByTestId('interests-settings-save').click();
      expect((await savedInterests).status()).toBe(403);
      await expect(interests.getByTestId('interests-notice')).toHaveText(copy.sessionChanged);

      const marketing = page.getByTestId('settings-marketing');
      const recorded = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/v1/me/consents',
      );
      await marketing.getByTestId('settings-marketing-switch').click();
      expect((await recorded).status()).toBe(403);
      await expect(
        page.locator('[data-scope="toast"]').getByText(copy.sessionChanged),
      ).toBeVisible();

      expect(writes).toEqual([
        { categoryIds: [top.id], expectedAccountId: a.id },
        expect.objectContaining({ expectedAccountId: a.id }),
      ]);
      // Nothing written, to B or to A.
      const bAfter = await meOf(other.request);
      expect(bAfter.profile.interestCategoryIds).toEqual(b.profile.interestCategoryIds);
      expect(bAfter.onboarding.consents).toEqual(b.onboarding.consents);
      const aAfter = await meOf(shownContext.request);
      expect(aAfter.profile.interestCategoryIds).toEqual(a.profile.interestCategoryIds);
      expect(aAfter.onboarding.consents).toEqual(a.onboarding.consents);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await otherContext.close();
      await shownContext.close();
    }
  });
});
