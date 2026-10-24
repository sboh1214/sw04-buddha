import type { APIRequestContext, APIResponse, Page, Route } from '@playwright/test';
import type {
  AdminCommentModeration,
  AdminPostModeration,
  AdminUserModeration,
  RetentionPurge,
} from '@buddha/shared';
import { copy } from '../src/copy';
import {
  adminAccount,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  logOut,
  meOf,
  signIn,
  signUp,
  test,
} from './helpers';

/**
 * 보존기간 처리 (#184, ADR-0087): an admin reads, on /admin/retention, what the worker's daily
 * `retention.purge` recorded — kind, count, the period applied and the run's instant, no personal
 * content (ADR-0069 decision 4 #184 «경과 처리 기록») — told that the periods are the release
 * settings' and only an approved one deletes (decision 7), and a kind a run gave up on marked 실패
 * beside its name, its count '오류 전까지 N건' (owner decision 2026-10-24 14); a member reads
 * nothing. And the operators' pages of a deleted original the retention emptied say so, and when —
 * as they do of a withdrawn member's hidden post it emptied, still hidden and without its earlier
 * versions (owner decisions 2026-10-24 3 and (2차) 2) — and a profile action whose removed item it
 * deleted names the item and says it is gone.
 *
 * The purge itself cannot run here: it runs once a day (04:30 KST) and deletes only what an approved
 * period has kept — records days old, under a value that would stay in the e2e database and delete
 * every later run's records too (release-settings.spec.ts changes no item). What it deletes, and the
 * records it writes, are the worker's suite's (retention-purge.test.ts) and the API's
 * (admin-retention-purges.controller.test.ts, moderation.controller.test.ts — `purgedAt`). So the
 * screen is checked twice: against the records the database holds (none on a fresh one; a run at
 * 04:30 KST during an e2e run would have written its rows of 0), and against answers this spec
 * shapes in the browser (`page.route`) — the runs and the pages a real purge would give, an
 * emptied original's moderation answers built from the real ones of a post and a comment the member
 * deleted, and a member's answer with a 소개 clearing's removed item gone — the way
 * account-closure.spec.ts shows the start grant's line.
 */

const PURGES = '/api/v1/admin/retention-purges';

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${response.url()} -> ${String(response.status())} ${body}`);
  }
  return (JSON.parse(body) as { data: T }).data;
}

async function expectForbidden(response: APIResponse): Promise<void> {
  expect(response.status(), response.url()).toBe(403);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
}

/** Two runs a day apart, as the worker writes them: KST 04:30 is 19:30 UTC the day before. */
const LATER = '2026-10-23T19:30:00.000Z';
const EARLIER = '2026-10-22T19:30:00.000Z';
/** `formatKst` of the two (lib/datetime.ts — the specs import only the copy from src/). */
const LATER_SHOWN = '2026. 10. 24. 오전 4:30';
const EARLIER_SHOWN = '2026. 10. 23. 오전 4:30';

function purge(
  id: number,
  ranAt: string,
  kind: RetentionPurge['kind'],
  count: number,
  periodDays: number,
  outcome: RetentionPurge['outcome'] = 'done',
): RetentionPurge {
  return { id: String(id), kind, count, periodDays, ranAt, outcome };
}

/**
 * Two pages of records as `GET /admin/retention-purges` would answer them — newest run first, the
 * record written last first, each page completed to the end of its last run (so a run never
 * splits): the later run on the first, with two batches of its edit history, a batch of deleted
 * originals and then that kind's failure, and a withdrawn member's hidden posts emptied — the
 * batch's rows of the posts, of the edit history they lost with their content and of their
 * hidings, under the 신고·제재 period (owner decisions 2026-10-24 3 and (2차) 2); the earlier run on
 * the second, under two periods approved at one value: the edit history's own step failed at its
 * first batch, and the hidden posts' step deleted some of it afterwards.
 */
const FIRST_PAGE = [
  purge(14, LATER, 'consent_records', 0, 365),
  purge(13, LATER, 'moderation_actions', 2, 1_825),
  purge(12, LATER, 'post_revisions', 3, 1_825),
  purge(11, LATER, 'hidden_posts', 2, 1_825),
  purge(10, LATER, 'deleted_posts', 0, 90, 'failed'),
  purge(9, LATER, 'deleted_posts', 500, 90),
  purge(8, LATER, 'post_revisions', 12, 90),
  purge(7, LATER, 'post_revisions', 500, 90),
  purge(6, LATER, 'nickname_holds', 3, 30),
];
const SECOND_PAGE = [
  purge(5, EARLIER, 'moderation_actions', 2, 365),
  purge(4, EARLIER, 'post_revisions', 3, 365),
  purge(3, EARLIER, 'hidden_posts', 2, 365),
  purge(2, EARLIER, 'post_revisions', 0, 365, 'failed'),
  purge(1, EARLIER, 'nickname_holds', 0, 30),
];
const NEXT_CURSOR = 'e2e-second-page';

/** Answers the browser's reads of the records with the two pages above. */
async function shapePurges(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === PURGES,
    async (route: Route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      await route.fulfill({
        json:
          cursor === NEXT_CURSOR
            ? { data: SECOND_PAGE, meta: { nextCursor: null } }
            : { data: FIRST_PAGE, meta: { nextCursor: NEXT_CURSOR } },
      });
    },
  );
}

/** A post straight at the API with the context's cookie. */
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

/** A 댓글 straight at the API with the context's cookie. */
async function commentThroughApi(
  context: APIRequestContext,
  postId: string,
  body: string,
): Promise<string> {
  const me = await meOf(context);
  const res = await context.post(`/api/v1/posts/${postId}/comments`, {
    data: { parentId: null, body, expectedAccountId: me.id },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** The author's edit (#45-4) straight at the API: the earlier version is kept for operators. */
async function editPostThroughApi(
  context: APIRequestContext,
  postId: string,
  title: string,
  text: string,
): Promise<void> {
  const me = await meOf(context);
  const res = await context.put(`/api/v1/posts/${postId}`, {
    data: {
      title,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
      expectedAccountId: me.id,
    },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** The author's deletion (#45-5) straight at the API: `path` is the post's or the comment's. */
async function deleteThroughApi(context: APIRequestContext, path: string): Promise<void> {
  const me = await meOf(context);
  const res = await context.post(`${path}/delete`, { data: { expectedAccountId: me.id } });
  expect(res.status(), await res.text()).toBe(200);
}

/** When the shaped answers say the retention emptied the originals: after their deletion. */
const PURGED_AT = '2031-01-01T00:00:00.000Z';
const PURGED_SHOWN = '2031. 1. 1. 오전 9:00';

test.describe('보존기간 처리 (#184)', () => {
  test('관리자 메뉴에서 열면 처리 기록이 회차마다 종류·건수·기간과 처리 시각으로 보이고, 기간은 출시 설정에서 승인됨일 때만 지운다고 알린다', async ({
    page,
    admin,
  }) => {
    // What the database holds: nothing on a fresh one, and never anything about whose.
    const held = await dataOf<RetentionPurge[]>(await admin.get(PURGES));
    for (const record of held) {
      expect(Object.keys(record).sort()).toEqual([
        'count',
        'id',
        'kind',
        'outcome',
        'periodDays',
        'ranAt',
      ]);
    }

    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto('/admin/markets');
    await page
      .getByTestId('admin-nav')
      .getByRole('link', { name: copy.adminRetention, exact: true })
      .click();
    await expect(page).toHaveURL('/admin/retention');

    const screen = page.getByTestId('admin-retention');
    await expect(screen).toContainText(copy.adminRetentionIntro);
    await expect(page.getByTestId('admin-retention-settings-notice')).toContainText(
      copy.adminRetentionSettingsNotice,
    );
    await expect(page.getByTestId('admin-retention-settings-link')).toHaveAttribute(
      'href',
      '/admin/settings',
    );
    // The records the database holds, as the screen shows them: none, or the newest run first.
    const [newest] = held;
    if (newest === undefined) {
      await expect(page.getByTestId('admin-retention-empty')).toHaveText(copy.adminRetentionEmpty);
    } else {
      await expect(
        page.getByTestId('admin-retention-runs').locator(':scope > li').first(),
      ).toHaveAttribute('data-testid', `admin-retention-run-${newest.ranAt}`);
    }

    // The runs a real purge would give: each run with its instant in Seoul and a line per kind in
    // the order the run takes them — a kind's batches summed, 0 when it looked and found nothing.
    // The first page holds the later run whole (the API ends a page at a run's end).
    await shapePurges(page);
    await page.reload();
    const runs = page.getByTestId('admin-retention-runs').locator(':scope > li');
    await expect(runs).toHaveCount(1);
    const later = page.getByTestId(`admin-retention-run-${LATER}`);
    await expect(later.getByTestId('admin-retention-ran-at')).toHaveText(
      `${copy.adminRetentionRanAt} ${LATER_SHOWN}`,
    );
    const laterKinds = later.locator('[data-testid^="admin-retention-kind-"]');
    await expect(laterKinds).toHaveCount(7);
    await expect(laterKinds.nth(0)).toHaveAttribute(
      'data-testid',
      'admin-retention-kind-nickname_holds',
    );
    await expect(laterKinds.nth(0)).toContainText(copy.adminRetentionKindNicknameHolds);
    await expect(laterKinds.nth(0).getByTestId('admin-retention-count')).toHaveText('3건');
    await expect(laterKinds.nth(0).getByTestId('admin-retention-period')).toHaveText('기간 30일');
    await expect(laterKinds.nth(1)).toHaveAttribute(
      'data-testid',
      'admin-retention-kind-post_revisions',
    );
    const revisions = laterKinds.nth(1);
    await expect(revisions).toContainText(copy.adminRetentionKindPostRevisions);
    await expect(revisions.getByTestId('admin-retention-count')).toHaveText('512건');
    await expect(revisions.getByTestId('admin-retention-period')).toHaveText('기간 90일');
    await expect(revisions.getByTestId('admin-retention-failed')).toHaveCount(0);
    // The edit history the hidden posts lost with their content: the same kind's line of the
    // 신고·제재 period, apart from the versions' own (owner decision 2026-10-24 (2차) 2).
    await expect(laterKinds.nth(2)).toHaveAttribute(
      'data-testid',
      'admin-retention-kind-post_revisions',
    );
    const hiddenRevisions = laterKinds.nth(2);
    await expect(hiddenRevisions).toContainText(copy.adminRetentionKindPostRevisions);
    await expect(hiddenRevisions.getByTestId('admin-retention-count')).toHaveText('3건');
    await expect(hiddenRevisions.getByTestId('admin-retention-period')).toHaveText('기간 1,825일');
    // A kind the run gave up on: marked 실패 beside its name, with what its batch before the
    // failure deleted said as such — a bare '500건' right after the badge reads as 500 failures.
    await expect(laterKinds.nth(3)).toHaveAttribute(
      'data-testid',
      'admin-retention-kind-deleted_posts',
    );
    const failedKind = later.getByTestId('admin-retention-kind-deleted_posts');
    const failedLabel = failedKind.getByTestId('admin-retention-label');
    await expect(failedLabel).toContainText(copy.adminRetentionKindDeletedPosts);
    await expect(failedLabel.getByTestId('admin-retention-failed')).toHaveText(
      copy.adminRetentionFailed,
    );
    await expect(
      failedKind.getByTestId('admin-retention-figures').getByTestId('admin-retention-failed'),
    ).toHaveCount(0);
    await expect(failedKind.getByTestId('admin-retention-count')).toHaveText(
      `${copy.adminRetentionCountBeforeFailure} 500건`,
    );
    await expect(failedKind.getByTestId('admin-retention-period')).toHaveText('기간 90일');
    await expect(laterKinds.nth(4)).toHaveAttribute(
      'data-testid',
      'admin-retention-kind-hidden_posts',
    );
    const hidden = later.getByTestId('admin-retention-kind-hidden_posts');
    await expect(hidden).toContainText(copy.adminRetentionKindHiddenPosts);
    await expect(hidden.getByTestId('admin-retention-count')).toHaveText('2건');
    await expect(hidden.getByTestId('admin-retention-period')).toHaveText('기간 1,825일');
    await expect(laterKinds.nth(5)).toHaveAttribute(
      'data-testid',
      'admin-retention-kind-moderation_actions',
    );
    const hidings = later.getByTestId('admin-retention-kind-moderation_actions');
    await expect(hidings).toContainText(copy.adminRetentionKindModerationActions);
    await expect(hidings.getByTestId('admin-retention-count')).toHaveText('2건');
    await expect(laterKinds.nth(6)).toHaveAttribute(
      'data-testid',
      'admin-retention-kind-consent_records',
    );
    const consent = later.getByTestId('admin-retention-kind-consent_records');
    await expect(consent).toContainText(copy.adminRetentionKindConsentRecords);
    await expect(consent.getByTestId('admin-retention-count')).toHaveText('0건');
    await expect(consent.getByTestId('admin-retention-period')).toHaveText('기간 365일');
    await expect(later.getByTestId('admin-retention-failed')).toHaveCount(1);

    // 더 보기: the earlier run follows, and the later one is as it was.
    await page.getByTestId('admin-retention-more').click();
    await expect(runs).toHaveCount(2);
    await expect(page.getByTestId('admin-retention-more')).toHaveCount(0);
    await expect(laterKinds).toHaveCount(7);
    await expect(revisions.getByTestId('admin-retention-count')).toHaveText('512건');
    const earlier = page.getByTestId(`admin-retention-run-${EARLIER}`);
    await expect(runs.nth(1)).toHaveAttribute('data-testid', `admin-retention-run-${EARLIER}`);
    await expect(earlier.getByTestId('admin-retention-ran-at')).toHaveText(
      `${copy.adminRetentionRanAt} ${EARLIER_SHOWN}`,
    );
    await expect(
      earlier
        .getByTestId('admin-retention-kind-nickname_holds')
        .getByTestId('admin-retention-count'),
    ).toHaveText('0건');
    // The edit history's own step failed before deleting any; what the hidden posts' step deleted
    // of it afterwards, under the same period, is not what went before the error — a line of its
    // own right after the failed one, without 실패.
    const earlierKinds = earlier.locator('[data-testid^="admin-retention-kind-"]');
    await expect(earlierKinds).toHaveCount(5);
    for (const at of [1, 2]) {
      await expect(earlierKinds.nth(at)).toHaveAttribute(
        'data-testid',
        'admin-retention-kind-post_revisions',
      );
      await expect(earlierKinds.nth(at)).toContainText(copy.adminRetentionKindPostRevisions);
      await expect(earlierKinds.nth(at).getByTestId('admin-retention-period')).toHaveText(
        '기간 365일',
      );
    }
    await expect(earlierKinds.nth(1).getByTestId('admin-retention-failed')).toHaveText(
      copy.adminRetentionFailed,
    );
    await expect(earlierKinds.nth(1).getByTestId('admin-retention-count')).toHaveText(
      `${copy.adminRetentionCountBeforeFailure} 0건`,
    );
    await expect(earlierKinds.nth(2).getByTestId('admin-retention-failed')).toHaveCount(0);
    await expect(earlierKinds.nth(2).getByTestId('admin-retention-count')).toHaveText('3건');
    await expect(earlierKinds.nth(3)).toHaveAttribute(
      'data-testid',
      'admin-retention-kind-hidden_posts',
    );
    await expect(earlier.getByTestId('admin-retention-failed')).toHaveCount(1);

    // The way to the periods: the release settings, where the five are listed.
    await page.getByTestId('admin-retention-settings-link').click();
    await expect(page).toHaveURL('/admin/settings');
    await expect(page.getByTestId('release-setting-retention.consent_records')).toBeVisible();
  });

  test('관리자가 아닌 계정은 /admin/retention을 열 수 없고, API는 기록을 거절한다', async ({
    page,
  }) => {
    // Signed out: the admin gate sends the visitor to sign in, and back here afterwards.
    await page.goto('/admin/retention');
    await page.waitForURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('next')).toBe('/admin/retention');
    expect((await page.request.get(PURGES)).status()).toBe(401);

    // A member: the admin layout sends it home without rendering the screen, and the API refuses
    // the operational record whatever the screen does (N04 §6).
    await signUp(page, freshEmail());
    await page.goto('/admin/retention');
    await expect(page).toHaveURL('/');
    await expect(page.getByTestId('admin-retention')).toHaveCount(0);
    await expectForbidden(await page.request.get(PURGES));
  });

  test('보존기간이 지나 비운 지운 글·댓글의 원문은 운영자 화면에서 원문 대신 그 안내와 비운 때로 보인다', async ({
    page,
    admin,
  }) => {
    // A member writes a post and a 댓글 and deletes both: operators read the deleted originals
    // (#45-5) until the retention empties them.
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const postId = await postThroughApi(page.request, market.id, `지울 글 ${tag}`, `본문 ${tag}`);
    const commentId = await commentThroughApi(page.request, postId, `지울 댓글 ${tag}`);
    await deleteThroughApi(page.request, `/api/v1/comments/${commentId}`);
    await deleteThroughApi(page.request, `/api/v1/posts/${postId}`);
    await logOut(page);
    await signIn(page, adminAccount.email, adminAccount.password);

    // Before: the original, title and text, and the 댓글 by its first line.
    await page.goto(`/admin/moderation/posts/${postId}`);
    await expect(page.getByTestId('moderation-post-title')).toHaveText(`지울 글 ${tag}`);
    await expect(page.getByTestId('moderation-content')).toContainText(`본문 ${tag}`);
    await expect(page.getByTestId('moderation-purged')).toHaveCount(0);
    await expect(page.getByTestId('moderation-purged-at')).toHaveCount(0);
    const row = page.getByTestId(`moderation-comment-${commentId}`);
    await expect(row.getByTestId('moderation-comment-open')).toHaveText(`지울 댓글 ${tag}`);

    // As the API answers once the retention emptied both (moderation-reads.service.ts): the row
    // stays with no title, an empty body and `purgedAt`; the 댓글's text is empty.
    await page.route(
      (url) => url.pathname === `/api/v1/admin/moderation/posts/${postId}`,
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { data: AdminPostModeration };
        await route.fulfill({
          response,
          json: {
            ...body,
            data: {
              ...body.data,
              title: null,
              body: { type: 'doc', content: [] },
              purgedAt: PURGED_AT,
              comments: body.data.comments.map((comment) =>
                comment.id === commentId ? { ...comment, excerpt: '' } : comment,
              ),
            },
          },
        });
      },
    );
    await page.route(
      (url) => url.pathname === `/api/v1/admin/moderation/comments/${commentId}`,
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { data: AdminCommentModeration };
        await route.fulfill({
          response,
          json: { ...body, data: { ...body.data, body: '', purgedAt: PURGED_AT } },
        });
      },
    );
    await page.reload();
    await expect(page.getByTestId('moderation-purged')).toHaveText(copy.adminModerationPurged);
    await expect(page.getByTestId('moderation-post-title')).toHaveCount(0);
    await expect(page.getByTestId('moderation-content')).not.toContainText(`본문 ${tag}`);
    // The line's label and value (`Line`), as the other times above it.
    await expect(page.getByTestId('moderation-purged-at')).toHaveText(
      `${copy.adminModerationPurgedAt}${PURGED_SHOWN}`,
    );
    // The 댓글's row still leads to its page, named by what became of it.
    const open = row.getByTestId('moderation-comment-open');
    await expect(open).toHaveText(copy.adminModerationPurgedLine);
    await open.click();
    await expect(page).toHaveURL(`/admin/moderation/comments/${commentId}`);
    await expect(page.getByTestId('admin-comment-moderation')).toBeVisible();
    await expect(page.getByTestId('moderation-purged')).toHaveText(copy.adminModerationPurged);
    await expect(page.getByTestId('moderation-comment-body')).toHaveCount(0);
    await expect(page.getByTestId('moderation-purged-at')).toHaveText(
      `${copy.adminModerationPurgedAt}${PURGED_SHOWN}`,
    );
  });

  test('탈퇴한 회원의 숨긴 채로 남은 글을 보존기간이 지나 비우면 운영자 화면에서 숨김 상태 그대로 원문과 이전 내용 대신 그 안내와 비운 때로 보인다', async ({
    page,
    admin,
  }) => {
    // A member writes a post and edits it, and an operator hides it (#45-5): operators read it,
    // its earlier version and its hiding until the retention empties it and deletes its edit
    // history and its hiding with it (owner decisions 2026-10-24 3 and (2차) 2).
    const market = await createOpenMarket(admin);
    const tag = freshTag();
    await signUp(page, freshEmail());
    const postId = await postThroughApi(page.request, market.id, `숨길 글 ${tag}`, `본문 ${tag}`);
    await editPostThroughApi(page.request, postId, `고친 글 ${tag}`, `고친 본문 ${tag}`);
    const operator = await meOf(admin);
    const hid = await admin.post(`/api/v1/admin/moderation/posts/${postId}/hide`, {
      data: { reason: 'spam', note: null, expectedAccountId: operator.id },
    });
    expect(hid.status(), await hid.text()).toBe(200);
    await logOut(page);
    await signIn(page, adminAccount.email, adminAccount.password);

    // Before: hidden, the original, its earlier version and its hiding.
    await page.goto(`/admin/moderation/posts/${postId}`);
    await expect(page.getByTestId('moderation-item-state')).toHaveText(
      copy.adminModerationStateHidden,
    );
    await expect(page.getByTestId('moderation-post-title')).toHaveText(`고친 글 ${tag}`);
    await expect(page.getByTestId('moderation-purged')).toHaveCount(0);
    const revisions = page.getByTestId('moderation-revisions');
    await expect(revisions.locator('ol > li')).toHaveCount(1);
    await expect(revisions).toContainText(`숨길 글 ${tag}`);
    await expect(revisions).toContainText(`본문 ${tag}`);
    const itemActions = page.getByTestId('moderation-item-actions');
    await expect(itemActions.getByTestId('moderation-actions').locator(':scope > li')).toHaveCount(
      1,
    );

    // As the API answers once the member withdrew and the 신고·제재 period passed
    // (moderation-reads.service.ts): still hidden, no title, an empty body, `purgedAt`, no earlier
    // version (deleted in the same step, whatever the edit history's own period), and the hiding
    // gone from the item's actions and the member's.
    await page.route(
      (url) => url.pathname === `/api/v1/admin/moderation/posts/${postId}`,
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { data: AdminPostModeration };
        await route.fulfill({
          response,
          json: {
            ...body,
            data: {
              ...body.data,
              title: null,
              body: { type: 'doc', content: [] },
              purgedAt: PURGED_AT,
              revisions: [],
              actions: [],
              authorActions: body.data.authorActions.filter((action) => action.type !== 'hide'),
            },
          },
        });
      },
    );
    await page.reload();
    await expect(page.getByTestId('moderation-item-state')).toHaveText(
      copy.adminModerationStateHidden,
    );
    await expect(page.getByTestId('moderation-purged')).toHaveText(copy.adminModerationPurged);
    await expect(page.getByTestId('moderation-post-title')).toHaveCount(0);
    await expect(page.getByTestId('moderation-content')).not.toContainText(`본문 ${tag}`);
    await expect(page.getByTestId('moderation-purged-at')).toHaveText(
      `${copy.adminModerationPurgedAt}${PURGED_SHOWN}`,
    );
    await expect(revisions.locator('ol > li')).toHaveCount(0);
    await expect(revisions).toContainText(copy.adminModerationNone);
    await expect(revisions).not.toContainText(`숨길 글 ${tag}`);
    await expect(itemActions.getByTestId('moderation-actions')).toHaveCount(0);
    await expect(itemActions).toContainText(copy.adminModerationNoActions);
  });

  test('보존기간이 지나 가져간 프로필 항목을 지운 조치는 운영자 화면에서 그 항목의 이름과 지웠다는 줄로 보인다', async ({
    page,
    admin,
  }) => {
    // A member with a 소개, which an operator empties (#37-10), and a warning beside it: operators
    // read what the clearing took until the retention deletes it (ADR-0087 결정 4의 9).
    const tag = freshTag();
    await signUp(page, freshEmail());
    const member = await meOf(page.request);
    const bio = `가져갈 소개 ${tag}`;
    const saved = await page.request.put('/api/v1/me/bio', {
      data: { bio, expectedAccountId: member.id },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    const operator = await meOf(admin);
    const cleared = await admin.post(`/api/v1/admin/moderation/users/${member.id}/bio-clear`, {
      data: { reason: 'personal_info', note: null, expectedAccountId: operator.id },
    });
    expect(cleared.status(), await cleared.text()).toBe(200);
    const clearing = ((await cleared.json()) as { data: { id: string } }).data.id;
    const warned = await admin.post(`/api/v1/admin/moderation/users/${member.id}/warn`, {
      data: { reason: 'spam', note: null, subject: null, expectedAccountId: operator.id },
    });
    expect(warned.status(), await warned.text()).toBe(200);
    const warning = ((await warned.json()) as { data: { id: string } }).data.id;
    await logOut(page);
    await signIn(page, adminAccount.email, adminAccount.password);

    // Before: what the clearing took, under its name; a warning took nothing and has no such line.
    await page.goto(`/admin/moderation/users/${member.id}`);
    const actions = page.getByTestId('moderation-author-actions');
    const removed = actions
      .getByTestId(`moderation-action-${clearing}`)
      .getByTestId('moderation-action-removed');
    await expect(removed).toHaveText(`${copy.adminModerationRemovedBio}${bio}`);
    const warningRemoved = actions
      .getByTestId(`moderation-action-${warning}`)
      .getByTestId('moderation-action-removed');
    await expect(warningRemoved).toHaveCount(0);

    // As the API answers once the removed items' period has passed and the action's has not
    // (moderation-reads.service.ts): the action stays with `removed` null.
    await page.route(
      (url) => url.pathname === `/api/v1/admin/moderation/users/${member.id}`,
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { data: AdminUserModeration };
        await route.fulfill({
          response,
          json: {
            ...body,
            data: {
              ...body.data,
              actions: body.data.actions.map((action) =>
                action.id === clearing ? { ...action, removed: null } : action,
              ),
            },
          },
        });
      },
    );
    await page.reload();
    // The item's name and that it is gone, never the 소개 itself.
    await expect(removed).toHaveText(
      `${copy.adminModerationRemovedBio}${copy.adminModerationRemovedPurged}`,
    );
    await expect(removed).not.toContainText(bio);
    await expect(warningRemoved).toHaveCount(0);
  });
});
