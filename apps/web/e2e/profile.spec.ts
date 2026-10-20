import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Category, Me } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  E2E_REAL_NAME,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  logOut,
  meOf,
  signUp,
  test,
} from './helpers';

/**
 * 공개 프로필 (#41, ADR-0078; owner decisions in ADR-0069 decision 3 #37, decision 4 #41): a member
 * edits the 소개 and the interest categories in MY 설정 and sees them on their own profile at
 * `/u/<publicId>`, which links back to MY 설정; cleared, neither shows, and Back from MY 설정
 * shows each change, the nickname's too. Anyone reaches a profile from a byline — the post's, a
 * comment's, a community card's — signed in or not, and reads the same public items and counts;
 * only the member gets the link to MY 설정, an admin's profile says
 * '운영자', and an old link shows the new nickname. Every answer is `noindex`, the HTML is the
 * server's and holds nothing private, and an unknown public id is a 404. The field allow-list, the
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
    await expect(page.getByTestId('profile-posts-coming-soon')).toHaveText(copy.comingSoon);
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
    // likes the post and the 대댓글. A post the member deleted counts for nothing (#37-14).
    const postId = await postThroughApi(page.request, market.id, `프로필 글 ${tag}`, tag);
    const adminComment = await commentThroughApi(admin, postId, null, `운영자의 댓글 ${tag}`);
    const reply = await commentThroughApi(page.request, postId, adminComment, `답글 ${tag}`);
    await likeThroughApi(admin, 'posts', postId);
    await likeThroughApi(admin, 'comments', reply);
    const gone = await postThroughApi(page.request, market.id, `지울 글 ${tag}`, `${tag} 지움`);
    const deleted = await page.request.post(`/api/v1/posts/${gone}/delete`, {
      data: { expectedAccountId: me.id },
    });
    expect(deleted.status(), await deleted.text()).toBe(200);

    // --- the post's byline leads to the author's profile: 1 post, 1 comment, 2 likes received.
    await page.goto(`/community/posts/${postId}`);
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
});
