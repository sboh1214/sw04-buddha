import type { APIRequestContext, Page } from '@playwright/test';
import type { Me, Notification, PostAuthor } from '@buddha/shared';
import { copy } from '../src/copy';
import { formatKst } from '../src/lib/datetime';
import {
  ONE_READ_MS,
  REALTIME_BUDGET_MS,
  accountIdOf,
  commentThroughApi,
  createOpenMarket,
  dataOf,
  documentSurvived,
  expect,
  expectDecided,
  freshEmail,
  freshTag,
  inboxOf,
  markDocument,
  meOf,
  myUnread,
  noticesOf,
  notificationRow,
  onlyNoticeOf,
  openCounted,
  postThroughApi,
  signUp,
  test,
  unreadCountOf,
} from './helpers';

/**
 * 커뮤니티 알림 (#135, ADR-0161; owner answers 135-1…135-7, 52-7, 52-15…52-19) on the screens,
 * every event through the API as production makes it: MY › 알림's rows of `post_replied`,
 * `comment_replied`, `moderation_action_taken`, `moderation_action_cancelled`,
 * `moderation_restriction_end_changed` and `proposal_decided`, in the sentences the owner approved
 * (135-5), each under 커뮤니티 and leading to the top of its screen (135-7).
 *
 * 1: a 댓글 on A's post reaches A without a reload, a second one merges into the same unread row
 * with its count and the latest replier (52-7, 52-15); A's own 댓글 and B's edit tell nobody
 * (135-3); A's row opens the post, and a 댓글 after the read is a new row. A 대댓글 reaches the
 * 댓글's author and not the post's — a reply to a 대댓글 too (52-18) — and the author's own reply in
 * their thread nobody; hiding the latest reply keeps the notice with no name (135-4) and tells its
 * author of the hide. 2: a dismissal tells nobody and a reporter is never told (135-1, 52-17); a
 * hide, a warning, a writing restriction, its 감경 and 조기 해제, the hide's cancellation and an
 * approved account restriction and its cancellation each tell the member its kind and, for a
 * restriction, its own end (52-16, 135-2, 135-6) — never the operator, the reporter, a reason or a
 * note; re-sent writes are refused and add nothing (AC 6). 3: a proposal's 채택 and 반려 tell its
 * proposer with the question (52-19); 검토 시작 and a later market link do not.
 *
 * Rows of one event may share an instant: notices are found by type and id, never by place. A
 * merged row keeps its id; a read row is never merged (ADR-0157 결정 4의 5). The comment limit is
 * five a minute per writer (write-limits.ts) and proposals three a day per number, so each test
 * spreads its writes over its members.
 */

/** The public face a reply notice names (52-15): the post page's, never the account id. */
function memberFace(me: Me): PostAuthor {
  return {
    kind: 'member',
    publicId: me.profile.publicId,
    nickname: me.profile.nickname,
    imageUrl: null,
    isAdmin: false,
  };
}

/** The member's notices of #135's 커뮤니티 types, newest first. */
async function communityNoticesOf(context: APIRequestContext): Promise<Notification[]> {
  return (await inboxOf(context)).filter((notice) => notice.category === 'community');
}

/** What a page's inbox is, its read state aside: the rows and their sayings. */
async function sayingsOf(context: APIRequestContext) {
  return (await communityNoticesOf(context)).map(({ id, type, params, eventCount }) => ({
    id,
    type,
    params,
    eventCount,
  }));
}

/** The member's one notice of `type` whose target names `id` (an action's, a proposal's). */
function noticeAbout(inbox: readonly Notification[], type: string, id: string): Notification {
  const found = noticesOf(inbox, type).filter((notice) =>
    (Object.values(notice.target) as unknown[]).includes(id),
  );
  const [only, ...others] = found;
  if (only === undefined || others.length > 0) throw new Error(`not one ${type} about ${id}`);
  return only;
}

/** Waits for `page`'s count beside MY to read `count` without a reload. */
async function expectUnread(page: Page, count: number): Promise<void> {
  await expect(myUnread(page)).toHaveText(String(count), {
    timeout: REALTIME_BUDGET_MS + ONE_READ_MS,
  });
}

/** The row's title in MY › 알림, once open there. */
function rowTitle(page: Page, id: string) {
  return notificationRow(page, id).getByTestId('notification-row-title');
}

/** A KST calendar date `days` from today, as the proposal form takes it. */
function koreanDateIn(days: number): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1_000);
  kst.setUTCDate(kst.getUTCDate() + days);
  return kst.toISOString().slice(0, 10);
}

test.describe('커뮤니티 알림 (#135)', () => {
  test('글의 댓글은 글 작성자에게 리프레시 없이 오고 읽기 전까지 같은 줄에 수와 마지막 작성자로 합쳐지며, 자기 댓글과 수정은 알리지 않고, 누르면 그 글이 열리며, 읽은 뒤의 댓글은 새 줄이고, 대댓글과 대댓글에 단 답은 그 댓글 작성자에게만 가며, 그 답글이 숨겨지면 알림은 이름 없이 남는다', async ({
    admin,
    browser,
    page,
  }) => {
    test.slow(); // three members, eleven writes and the signals they send
    const tag = freshTag();
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    try {
      const [bPage, cPage] = await Promise.all([contexts[0].newPage(), contexts[1].newPage()]);
      for (const each of [page, bPage, cPage]) await signUp(each, freshEmail());
      const [a, b, c] = [page.request, bPage.request, cPage.request];
      const [bMe, cMe, aMe] = await Promise.all([meOf(b), meOf(c), meOf(a)]);
      const market = await createOpenMarket(admin);
      const postId = await postThroughApi(a, market.id, `댓글 받을 글 ${tag}`, tag);
      const postTarget = { kind: 'post', postId };

      // --- A keeps MY open, its count read (none) and its socket in A's room.
      await openCounted(page, '/my');
      await expect(myUnread(page)).toHaveCount(0);
      await page.waitForTimeout(REALTIME_BUDGET_MS);
      await markDocument(page);

      // --- B's 댓글: A's count turns 1 without a reload; one post_replied naming B's reply only
      // (its id and time — never its body, 135-4) and B's public face read with it (52-15).
      const b1 = await commentThroughApi(b, postId, null, `B의 댓글 ${tag}`);
      await expectUnread(page, 1);
      expect(await documentSurvived(page)).toBe(true);
      const first = onlyNoticeOf(await inboxOf(a), 'post_replied');
      expect(first).toMatchObject({
        category: 'community',
        target: postTarget,
        eventCount: 1,
        readAt: null,
        replyAuthor: memberFace(bMe),
      });
      expect(first.params).toEqual({ replyId: b1.id, replyCreatedAt: b1.createdAt });
      expect(JSON.stringify(first)).not.toContain(bMe.id);

      // --- C's 댓글: the SAME row, two replies, the latest C's (52-7).
      await page.waitForTimeout(REALTIME_BUDGET_MS);
      const c1 = await commentThroughApi(c, postId, null, `C의 댓글 ${tag}`);
      await expect
        .poll(async () => onlyNoticeOf(await inboxOf(a), 'post_replied').eventCount, {
          timeout: REALTIME_BUDGET_MS + ONE_READ_MS,
        })
        .toBe(2);
      const merged = onlyNoticeOf(await inboxOf(a), 'post_replied');
      expect(merged).toMatchObject({
        id: first.id,
        target: postTarget,
        replyAuthor: memberFace(cMe),
        readAt: null,
      });
      expect(merged.params).toEqual({ replyId: c1.id, replyCreatedAt: c1.createdAt });
      await expect(myUnread(page)).toHaveText('1');

      // --- A's own 댓글 on its post and B's edit of b1: nothing new (135-3).
      const before = await sayingsOf(a);
      await commentThroughApi(a, postId, null, `A가 자기 글에 단 댓글 ${tag}`);
      const edited = await b.put(`/api/v1/comments/${b1.id}`, {
        data: { body: `B가 고친 댓글 ${tag}`, expectedAccountId: bMe.id },
      });
      expect(edited.status(), await edited.text()).toBe(200);
      expect(await sayingsOf(a)).toEqual(before);
      expect(await communityNoticesOf(b)).toEqual([]);

      // --- MY › 알림: one row under 커뮤니티, the owner's sentence (135-5). Pressed: the post, at its
      // top with both 댓글 (135-7); back, the row is read.
      await openCounted(page, '/my/notifications');
      const firstRow = notificationRow(page, first.id);
      await expect(firstRow.getByTestId('notification-row-category')).toHaveText(
        copy.notificationCategoryCommunity,
      );
      await expect(rowTitle(page, first.id)).toHaveText(
        `내 글에 새 댓글 2개 · 마지막: ${cMe.profile.nickname}`,
      );
      await expect(firstRow).toHaveAttribute('href', `/community/posts/${postId}`);
      await expect(firstRow).toHaveAttribute('data-read', 'false');
      await firstRow.click();
      await expect(page).toHaveURL(`/community/posts/${postId}`);
      await expect(page.getByTestId(`comment-${b1.id}`)).toBeVisible();
      await expect(page.getByTestId(`comment-${c1.id}`)).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL('/my/notifications');
      await expect(firstRow).toHaveAttribute('data-read', 'true');

      // --- B's next 댓글 after the read: a NEW unread row (a read row is never merged).
      const b2 = await commentThroughApi(b, postId, null, `B의 둘째 댓글 ${tag}`);
      const afterRead = noticesOf(await inboxOf(a), 'post_replied');
      expect(afterRead.map((notice) => notice.id)).toHaveLength(2);
      const second = afterRead.find((notice) => notice.id !== first.id);
      expect(second).toMatchObject({ eventCount: 1, readAt: null, replyAuthor: memberFace(bMe) });
      expect(second?.params).toEqual({ replyId: b2.id, replyCreatedAt: b2.createdAt });

      // --- A answers b1: B — the 댓글's author — hears of it, A nothing (52-18).
      const commentTarget = { kind: 'comment', postId, commentId: b1.id };
      const a1 = await commentThroughApi(a, postId, b1.id, `A의 답글 ${tag}`);
      const reply = onlyNoticeOf(await inboxOf(b), 'comment_replied');
      expect(reply).toMatchObject({
        category: 'community',
        target: commentTarget,
        eventCount: 1,
        replyAuthor: memberFace(aMe),
      });
      expect(reply.params).toEqual({ replyId: a1.id, replyCreatedAt: a1.createdAt });
      expect(noticesOf(await inboxOf(a), 'comment_replied')).toEqual([]);

      // --- C answers A's 대댓글: still b1's thread, so B's row merges (latest C); A, whose 대댓글
      // C named, and the post's author hear nothing (52-18).
      const aBefore = await sayingsOf(a);
      const c2 = await commentThroughApi(c, postId, a1.id, `C가 A에게 단 답 ${tag}`);
      const replyMerged = onlyNoticeOf(await inboxOf(b), 'comment_replied');
      expect(replyMerged).toMatchObject({
        id: reply.id,
        target: commentTarget,
        eventCount: 2,
        replyAuthor: memberFace(cMe),
      });
      expect(replyMerged.params).toEqual({ replyId: c2.id, replyCreatedAt: c2.createdAt });
      expect(await sayingsOf(a)).toEqual(aBefore);

      // --- B answers in its own thread: nobody (135-3).
      const bBefore = await sayingsOf(b);
      await commentThroughApi(b, postId, b1.id, `B가 자기 스레드에 단 답 ${tag}`);
      expect(await sayingsOf(b)).toEqual(bBefore);
      expect(await sayingsOf(a)).toEqual(aBefore);
      expect(await communityNoticesOf(c)).toEqual([]);

      // --- B's row reads the merged sentence.
      await openCounted(bPage, '/my/notifications');
      await expect(rowTitle(bPage, reply.id)).toHaveText(
        `내 댓글에 새 답글 2개 · 마지막: ${cMe.profile.nickname}`,
      );

      // --- 135-4: the admin hides C's reply. B's notice stays — same id, same count — with no
      // name, and opens the post where C's reply is the hidden placeholder; C hears of the hide.
      const operator = await accountIdOf(admin);
      const hideNote = `숨김의 설명 ${tag}`;
      const hidden = await admin.post(`/api/v1/admin/moderation/comments/${c2.id}/hide`, {
        data: { reason: 'spam', note: hideNote, expectedAccountId: operator },
      });
      expect(hidden.status(), await hidden.text()).toBe(200);
      const hideId = ((await hidden.json()) as { data: { id: string } }).data.id;
      const kept = onlyNoticeOf(await inboxOf(b), 'comment_replied');
      expect(kept).toMatchObject({ id: reply.id, eventCount: 2, replyAuthor: null });
      expect(kept.params).toEqual(replyMerged.params);
      await bPage.reload();
      await expect(rowTitle(bPage, reply.id)).toHaveText('내 댓글에 새 답글 2개');
      await notificationRow(bPage, reply.id).click();
      await expect(bPage).toHaveURL(`/community/posts/${postId}`);
      await expect(
        bPage.getByTestId(`comment-${c2.id}`).getByTestId('comment-placeholder'),
      ).toHaveText(copy.commentHiddenPlaceholder);
      const cHide = onlyNoticeOf(await inboxOf(c), 'moderation_action_taken');
      expect(cHide).toMatchObject({
        target: { kind: 'moderation_action', actionId: hideId },
        eventCount: 1,
      });
      expect(cHide.params).toEqual({ action: 'hide', endsAt: null });
      expect(JSON.stringify(await inboxOf(c))).not.toContain(hideNote);
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test('나에게 내린 운영 조치(숨김·경고·작성 제한과 그 감경·조기 해제·숨김 취소·승인된 계정 제한과 그 취소)는 종류와 그 조치의 끝나는 때만으로 조치·신고 내역에 이어 오고, 기각과 신고자에게는 오지 않으며, 다시 보낸 처리는 거절되어 아무것도 더하지 않는다', async ({
    admin,
    secondAdmin,
    browser,
    page,
  }) => {
    test.slow(); // two members and ten operator writes, two of them approvals
    const tag = freshTag();
    const rContext = await browser.newContext();
    const operator = await accountIdOf(admin);
    const approver = await accountIdOf(secondAdmin);
    /** The restrictions in force, cancelled by the `finally` if a step failed. */
    const standing = { writing: null as string | null, account: null as string | null };
    try {
      const rPage = await rContext.newPage();
      await signUp(page, freshEmail());
      await signUp(rPage, freshEmail());
      const [m, r] = [page.request, rPage.request];
      const [mMe, rMe, adminMe] = await Promise.all([meOf(m), meOf(r), meOf(admin)]);
      const market = await createOpenMarket(admin);
      const postId = await postThroughApi(m, market.id, `신고될 글 ${tag}`, tag);
      const note = `회원이 읽는 설명 ${tag}`;
      const reasonText = `운영자의 기록 ${tag}`;
      const actionTarget = (actionId: string) => ({ kind: 'moderation_action', actionId });
      /** A report of M's post by R: its id. */
      const report = async () => {
        const res = await r.post(`/api/v1/posts/${postId}/reports`, {
          data: { reason: 'spam', description: `신고 설명 ${tag}`, expectedAccountId: rMe.id },
        });
        expect(res.status(), await res.text()).toBe(201);
        return ((await res.json()) as { data: { id: string } }).data.id;
      };
      /** An operator write answered 200 with the action: its id and end. */
      const act = async (path: string, data: Record<string, unknown>, by = admin) => {
        const res = await by.post(path, {
          data: { ...data, expectedAccountId: by === admin ? operator : approver },
        });
        expect(res.status(), await res.text()).toBe(200);
        return (await res.json()) as { data: unknown };
      };
      /** The refusal of a re-sent moderation write (409 MODERATION_NOT_ALLOWED). */
      const expectRefused = async (path: string, data: Record<string, unknown>, reason: string) => {
        const res = await admin.post(path, { data: { ...data, expectedAccountId: operator } });
        const body = await res.text();
        expect(res.status(), body).toBe(409);
        expect((JSON.parse(body) as { error: unknown }).error).toMatchObject({
          code: 'MODERATION_NOT_ALLOWED',
          details: { reason },
        });
      };

      // --- R reports; the admin dismisses it: M and R hear nothing (135-1, 52-17).
      const dismissed = await admin.post('/api/v1/admin/reports/dismiss', {
        data: { reportIds: [await report()], reason: reasonText, expectedAccountId: operator },
      });
      expect(dismissed.status(), await dismissed.text()).toBe(200);
      expect(await communityNoticesOf(m)).toEqual([]);
      expect(await communityNoticesOf(r)).toEqual([]);

      // --- M keeps MY open, its socket in M's room.
      await openCounted(page, '/my');
      await expect(myUnread(page)).toHaveCount(0);
      await page.waitForTimeout(REALTIME_BUDGET_MS);
      await markDocument(page);

      // --- R reports again; the admin hides the post: M hears '숨김' alone without a reload, R
      // nothing (52-17).
      await report();
      const hidePath = `/api/v1/admin/moderation/posts/${postId}/hide`;
      const hideBody = { reason: 'spam', note };
      const hideId = ((await act(hidePath, hideBody)).data as { id: string }).id;
      await expectUnread(page, 1);
      expect(await documentSurvived(page)).toBe(true);
      const hidden = onlyNoticeOf(await inboxOf(m), 'moderation_action_taken');
      expect(hidden).toMatchObject({
        category: 'community',
        target: actionTarget(hideId),
        eventCount: 1,
      });
      expect(hidden.params).toEqual({ action: 'hide', endsAt: null });
      expect(await communityNoticesOf(r)).toEqual([]);

      // --- Its row: the owner's sentence, leading to 조치·신고 내역's top with the action (135-2).
      await openCounted(page, '/my/notifications');
      const hiddenRow = notificationRow(page, hidden.id);
      await expect(hiddenRow.getByTestId('notification-row-category')).toHaveText(
        copy.notificationCategoryCommunity,
      );
      await expect(rowTitle(page, hidden.id)).toHaveText('운영 조치: 숨김');
      await expect(hiddenRow).toHaveAttribute('href', '/my/moderation');
      await hiddenRow.click();
      await expect(page).toHaveURL('/my/moderation');
      await expect(page.getByTestId(`my-action-${hideId}`)).toBeVisible();

      // --- The hide sent again: refused, nothing new (AC 6).
      let held = await sayingsOf(m);
      await expectRefused(hidePath, hideBody, 'hidden');
      expect(await sayingsOf(m)).toEqual(held);

      // --- A warning.
      const warningId = (
        (await act(`/api/v1/admin/moderation/users/${mMe.id}/warn`, {
          reason: 'spam',
          note,
          subject: null,
        })) as { data: { id: string } }
      ).data.id;
      const warned = noticeAbout(await inboxOf(m), 'moderation_action_taken', warningId);
      expect(warned).toMatchObject({ target: actionTarget(warningId), eventCount: 1 });
      expect(warned.params).toEqual({ action: 'warning', endsAt: null });

      // --- A seven-day writing restriction: its own end (135-6), in the member's zone.
      const restriction = (
        (await act(`/api/v1/admin/moderation/users/${mMe.id}/writing-restriction`, {
          reason: 'spam',
          note,
          days: 7,
          subject: null,
        })) as { data: { id: string; endsAt: string } }
      ).data;
      standing.writing = restriction.id;
      const restricted = noticeAbout(await inboxOf(m), 'moderation_action_taken', restriction.id);
      expect(restricted.params).toEqual({
        action: 'writing_restriction',
        endsAt: restriction.endsAt,
      });
      await page.goto('/my/notifications');
      await expect(rowTitle(page, restricted.id)).toHaveText(
        `운영 조치: 작성 제한 · ${formatKst(restriction.endsAt)}까지`,
      );

      // --- Its 감경 to two days on, then its 조기 해제: one notice each, the 감경 with its new end
      // (135-5 (h)), the 해제 with none.
      const shortenedTo = new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000).toISOString();
      await act(`/api/v1/admin/moderation/actions/${restriction.id}/shorten`, {
        endsAt: shortenedTo,
        reason: reasonText,
      });
      const shortened = onlyNoticeOf(await inboxOf(m), 'moderation_restriction_end_changed');
      expect(shortened).toMatchObject({ target: actionTarget(restriction.id), eventCount: 1 });
      expect(shortened.params).toEqual({
        action: 'writing_restriction',
        change: 'shorten',
        endsAt: shortenedTo,
      });
      await act(`/api/v1/admin/moderation/actions/${restriction.id}/lift`, { reason: reasonText });
      standing.writing = null;
      const changes = noticesOf(await inboxOf(m), 'moderation_restriction_end_changed');
      expect(changes).toHaveLength(2);
      const lifted = changes.find((notice) => notice.id !== shortened.id);
      if (lifted === undefined) throw new Error('M has no notice of the lift');
      // A lift ends it at its own instant: the notice's 발생 시각.
      expect(lifted.params).toEqual({
        action: 'writing_restriction',
        change: 'lift',
        endsAt: lifted.occurredAt,
      });
      await page.goto('/my/notifications');
      await expect(rowTitle(page, shortened.id)).toHaveText(
        `운영 조치 감경: 작성 제한 · ${formatKst(shortenedTo)}까지`,
      );
      await expect(rowTitle(page, lifted.id)).toHaveText('운영 조치 조기 해제: 작성 제한');

      // --- The hide cancelled: '운영 조치 취소: 숨김'; sent again, refused and nothing new.
      const cancelPath = `/api/v1/admin/moderation/actions/${hideId}/cancel`;
      await act(cancelPath, { reason: reasonText });
      const cancelled = onlyNoticeOf(await inboxOf(m), 'moderation_action_cancelled');
      expect(cancelled).toMatchObject({ target: actionTarget(hideId), eventCount: 1 });
      expect(cancelled.params).toEqual({ action: 'hide' });
      held = await sayingsOf(m);
      await expectRefused(cancelPath, { reason: reasonText }, 'cancelled');
      expect(await sayingsOf(m)).toEqual(held);
      await page.goto('/my/notifications');
      await expect(rowTitle(page, cancelled.id)).toHaveText('운영 조치 취소: 숨김');

      // --- An account restriction: asked by the admin (nothing yet), approved by the second —
      // M's count rises by one without a reload; no orders_cancelled (M has no order).
      await openCounted(page, '/my');
      const unread = await unreadCountOf(m);
      await expect(myUnread(page)).toHaveText(String(unread));
      await page.waitForTimeout(REALTIME_BUDGET_MS);
      held = await sayingsOf(m);
      const asked = (
        (await act(`/api/v1/admin/moderation/users/${mMe.id}/account-restriction`, {
          reason: 'abnormal_trading',
          note,
          days: 7,
          subject: null,
        })) as { data: { id: string } }
      ).data;
      expect(await sayingsOf(m)).toEqual(held);
      const requests = '/api/v1/admin/moderation/account-restriction-requests';
      const approvePath = `${requests}/${asked.id}/approve`;
      const approval = { reason: `승인합니다 ${tag}` };
      const account = (
        (await act(approvePath, approval, secondAdmin)) as {
          data: { action: { id: string; endsAt: string } };
        }
      ).data.action;
      standing.account = account.id;
      await expectUnread(page, unread + 1);
      const accountNotice = noticeAbout(await inboxOf(m), 'moderation_action_taken', account.id);
      expect(accountNotice.target).toEqual(actionTarget(account.id));
      expect(accountNotice.params).toEqual({
        action: 'account_restriction',
        endsAt: account.endsAt,
      });
      expect(noticesOf(await inboxOf(m), 'orders_cancelled')).toEqual([]);

      // --- The approval sent again: refused as decided, nothing new.
      held = await sayingsOf(m);
      await expectDecided(
        await secondAdmin.post(approvePath, { data: { ...approval, expectedAccountId: approver } }),
      );
      expect(await sayingsOf(m)).toEqual(held);

      // --- Its cancellation, asked and approved: '운영 조치 취소: 계정 제한'.
      const cancelAsked = (
        (await act(`/api/v1/admin/moderation/actions/${account.id}/account-restriction/cancel`, {
          reason: reasonText,
        })) as { data: { id: string } }
      ).data;
      await act(`${requests}/${cancelAsked.id}/approve`, approval, secondAdmin);
      standing.account = null;
      const accountCancelled = noticeAbout(
        await inboxOf(m),
        'moderation_action_cancelled',
        account.id,
      );
      expect(accountCancelled.params).toEqual({ action: 'account_restriction' });

      // --- Eight notices, every one under 커뮤니티 and naming no one: never the operators, the
      // reporter, a reason or a note (135-2, #45 13항); R heard nothing throughout (52-17).
      const all = await communityNoticesOf(m);
      expect(all.map((notice) => notice.type).sort()).toEqual([
        'moderation_action_cancelled',
        'moderation_action_cancelled',
        'moderation_action_taken',
        'moderation_action_taken',
        'moderation_action_taken',
        'moderation_action_taken',
        'moderation_restriction_end_changed',
        'moderation_restriction_end_changed',
      ]);
      const said = JSON.stringify(all);
      for (const secret of [
        adminMe.id,
        adminMe.profile.nickname,
        approver,
        rMe.id,
        rMe.profile.nickname,
        rMe.profile.publicId,
        note,
        reasonText,
        approval.reason,
        `신고 설명 ${tag}`,
      ]) {
        expect(said).not.toContain(secret);
      }
      expect(await communityNoticesOf(r)).toEqual([]);
    } finally {
      // Nothing left in force on a persistent database if a step failed: a writing restriction
      // cancelled, an account restriction's cancellation asked and approved (best effort).
      const cleanup = { reason: `시험 정리 ${tag}` };
      if (standing.writing !== null) {
        await admin
          .post(`/api/v1/admin/moderation/actions/${standing.writing}/cancel`, {
            data: { ...cleanup, expectedAccountId: operator },
          })
          .catch(() => undefined);
      }
      if (standing.account !== null) {
        const asked = await admin
          .post(`/api/v1/admin/moderation/actions/${standing.account}/account-restriction/cancel`, {
            data: { ...cleanup, expectedAccountId: operator },
          })
          .then((res) => res.json() as Promise<{ data?: { id: string } }>)
          .catch(() => ({ data: undefined }));
        if (asked.data !== undefined) {
          await secondAdmin
            .post(
              `/api/v1/admin/moderation/account-restriction-requests/${asked.data.id}/approve`,
              { data: { ...cleanup, expectedAccountId: approver } },
            )
            .catch(() => undefined);
        }
      }
      await rContext.close();
    }
  });

  test('시장 제안의 채택과 반려는 제안자에게 결론과 질문으로 오고 누르면 내 제안이 열리며, 검토 시작과 나중의 시장 연결은 알리지 않는다', async ({
    admin,
    page,
  }) => {
    const tag = freshTag();
    await signUp(page, freshEmail());
    const p = page.request;
    const pMe = await meOf(p);
    const operator = await accountIdOf(admin);
    const propose = async (question: string) =>
      dataOf<{ id: string }>(
        await p.post('/api/v1/me/proposals', {
          data: {
            question,
            deadline: koreanDateIn(7),
            yesCondition: `${question} — 공식 발표가 있으면 YES`,
            expectedSources: '공식 보도자료',
            expectedAccountId: pMe.id,
          },
        }),
      );
    const adoptedQuestion = `E2E 채택될 제안 ${tag}`;
    const rejectedQuestion = `E2E 반려될 제안 ${tag}`;
    const toAdopt = await propose(adoptedQuestion);
    const toReject = await propose(rejectedQuestion);

    // --- 검토 시작 on both: nothing (52-19 '결론만').
    for (const proposal of [toAdopt, toReject]) {
      await dataOf(
        await admin.post(`/api/v1/admin/proposals/${proposal.id}/review`, {
          data: { expectedAccountId: operator },
        }),
      );
    }
    expect(await communityNoticesOf(p)).toEqual([]);

    // --- 채택 with no market, then 반려 with a reason the proposer reads on MY 내 제안 only.
    await dataOf(
      await admin.post(`/api/v1/admin/proposals/${toAdopt.id}/adopt`, {
        data: { memo: `채택 메모 ${tag}`, market: null, expectedAccountId: operator },
      }),
    );
    const explanation = `기준이 모호합니다 ${tag}`;
    await dataOf(
      await admin.post(`/api/v1/admin/proposals/${toReject.id}/reject`, {
        data: { reason: 'other', explanation, expectedAccountId: operator },
      }),
    );
    const decided = noticesOf(await inboxOf(p), 'proposal_decided');
    expect(decided).toHaveLength(2);
    const adopted = noticeAbout(decided, 'proposal_decided', toAdopt.id);
    const rejected = noticeAbout(decided, 'proposal_decided', toReject.id);
    expect(adopted).toMatchObject({
      category: 'community',
      target: { kind: 'proposal', proposalId: toAdopt.id },
      eventCount: 1,
    });
    expect(rejected.target).toEqual({ kind: 'proposal', proposalId: toReject.id });
    expect(adopted.params).toEqual({ decision: 'adopted', question: adoptedQuestion });
    expect(rejected.params).toEqual({ decision: 'rejected', question: rejectedQuestion });
    expect(JSON.stringify(decided)).not.toContain(explanation);
    expect(JSON.stringify(decided)).not.toContain(`채택 메모 ${tag}`);

    // --- The rows: the owner's sentences; pressed, 내 제안 at its top (135-7).
    await openCounted(page, '/my/notifications');
    await expect(rowTitle(page, adopted.id)).toHaveText(`시장 제안 채택 · ${adoptedQuestion}`);
    await expect(rowTitle(page, rejected.id)).toHaveText(`시장 제안 반려 · ${rejectedQuestion}`);
    await expect(notificationRow(page, rejected.id)).toHaveAttribute('href', '/my/proposals');
    await notificationRow(page, adopted.id).click();
    await expect(page).toHaveURL('/my/proposals');

    // --- A market linked to the adopted one later: nothing new (52-19).
    const held = await sayingsOf(p);
    const market = await createOpenMarket(admin);
    await dataOf(
      await admin.post(`/api/v1/admin/proposals/${toAdopt.id}/market`, {
        data: { market: { type: 'existing', marketId: market.id }, expectedAccountId: operator },
      }),
    );
    expect(await sayingsOf(p)).toEqual(held);
  });
});
