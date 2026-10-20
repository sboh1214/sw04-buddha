/**
 * 운영 공지 (#138) against the docker `test` profile: the pinned notices above the community list
 * and a notice page (`/notices`), and the admins' writes, pins and unpins (`/admin/notices`).
 * Owner decisions under test (ADR-0069 decision 2 #45-8, decision 4 #138): a required title and a
 * body of the posts' editor (its allow-list and limits, links and images); '수정됨' and the
 * operators' history; at most three pinned, never unpinned automatically, an unpinned notice kept
 * and pinnable again; every admin may write, edit, pin and unpin, no approval; each change records
 * its admin and time and no reason; anyone reads, and no answer names an operator. And this PR's
 * choices: an unpinned notice stays readable at its address; the latest pinned first, a pin always
 * after the ones in place; a notice's image belongs to it alone, never to a post; two saves of one
 * notice take turns, the later one winning with the earlier kept in the history. Skips when TEST_*
 * are unset.
 */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createMarket,
  createMedia,
  createNotice,
  createPost,
} from '@buddha/db/test';
import {
  NOTICE_PIN_LIMIT,
  POST_BODY_MAX_LENGTH,
  adminNoticeSchema,
  adminNoticeSummarySchema,
  adminNoticeUpdateResultSchema,
  noticeSchema,
  noticeSummarySchema,
  postImageNotUsableMessage,
  type AdminNotice,
  type AdminNoticeSummary,
  type AdminNoticeUpdateResult,
  type NoticeSummary,
} from '@buddha/shared';
import { asc, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const ORIGIN = 'http://localhost:3000';
const UNKNOWN = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';

type ErrorBody = { error: { code: string; details?: unknown } };
type AdminPage = { data: AdminNoticeSummary[]; meta: { nextCursor: string | null } };

const doc = (...paragraphs: string[]) => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});
const withImages = (...mediaIds: string[]) => ({
  type: 'doc',
  content: [
    ...doc('사진').content,
    ...mediaIds.map((mediaId) => ({ type: 'image', attrs: { mediaId } })),
  ],
});

describe.skipIf(!hasTestInfra)('notices (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let otherAdmin: TestUser;
  let member: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    admin = await signUpTestUser(t);
    otherAdmin = await signUpTestUser(t);
    member = await signUpTestUser(t);
    for (const account of [admin, otherAdmin]) {
      await t.db
        .update(schema.profiles)
        .set({ role: 'admin' })
        .where(eq(schema.profiles.userId, account.id));
      // The guard caches roles for 60 s (PLAN 10.5); the promotion above happened behind it.
      await t.app.get(AdminGuard).invalidate(account.id);
    }
    // Every account finishes the onboarding: /admin answers an onboarded admin only (ADR-0072),
    // and the member is refused for its role, not its onboarding.
    for (const account of [admin, otherAdmin, member]) {
      await completeOnboarding(t.db, { userId: account.id });
    }
  });

  const send = (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    who: TestUser | null,
    payload?: unknown,
  ) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        origin: ORIGIN,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...(who ? { cookie: who.cookie } : {}),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
  const errorOf = (res: { json: <U>() => U }) => res.json<ErrorBody>().error;

  const create = (payload: unknown, who: TestUser = admin) =>
    send('POST', '/admin/notices', who, payload);
  const created = async (title = '점검 안내', body: unknown = doc('내일 새벽 점검합니다')) => {
    const res = await create({ title, body });
    expect(res.statusCode, res.body).toBe(201);
    return adminNoticeSchema.parse(data(res));
  };
  const edit = (id: string, payload: unknown, who: TestUser = admin) =>
    send('PUT', `/admin/notices/${id}`, who, payload);
  const pin = (id: string, who: TestUser = admin) => send('POST', `/admin/notices/${id}/pin`, who);
  const unpin = (id: string, who: TestUser = admin) =>
    send('POST', `/admin/notices/${id}/unpin`, who);

  /** The fixed area as anyone reads it: ids in order, each card checked against its schema. */
  async function pinnedIds(cookie?: string): Promise<string[]> {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/notices',
      headers: cookie ? { cookie } : {},
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = data<NoticeSummary[]>(res);
    for (const row of rows) noticeSummarySchema.parse(row);
    return rows.map((row) => row.id);
  }
  /** One admin list's ids, page by page (`limit` per page), to the end. */
  async function adminIds(state: 'pinned' | 'unpinned', limit = 20): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = `state=${state}&limit=${String(limit)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await send('GET', `/admin/notices?${query}`, admin);
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<AdminPage>();
      for (const row of page.data) adminNoticeSummarySchema.parse(row);
      ids.push(...page.data.map((row) => row.id));
      cursor = page.meta.nextCursor;
      pages += 1;
      if (pages > 20) throw new Error('the cursor never ended');
    } while (cursor);
    return ids;
  }
  /**
   * The notices' audit rows by time. Two writes one after another can share a millisecond, and the
   * rows' ids are random, so a tie goes in the order a notice's life takes (written, edited, pinned,
   * unpinned) — what every test that reads the order does, one request after another.
   */
  async function actions() {
    const rows = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetType, 'notice'))
      .orderBy(asc(schema.adminActions.createdAt));
    const life = ['notice_create', 'notice_update', 'notice_pin', 'notice_unpin'];
    return rows.sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        life.indexOf(a.type) - life.indexOf(b.type),
    );
  }
  /** Who recorded what, whatever the order: for writes whose turns the database decided. */
  async function recordedSet() {
    return (await actions()).map(({ type, adminId }) => `${type} ${adminId}`).sort();
  }

  // ---- reading --------------------------------------------------------------------------------

  it('lets anyone read the pinned notices and a notice page, naming nobody', async () => {
    const notice = await created('서비스 점검', doc('첫 줄', '둘째 줄'));
    expect((await pin(notice.id)).statusCode).toBe(200);
    for (const cookie of [undefined, member.cookie, admin.cookie]) {
      expect(await pinnedIds(cookie)).toEqual([notice.id]);
    }
    const listed = await send('GET', '/notices', null);
    // The card is the title and the dates alone: no author, no operator, no pin detail.
    expect(data(listed)).toEqual([
      { id: notice.id, title: '서비스 점검', createdAt: notice.createdAt, editedAt: null },
    ]);
    const page = await send('GET', `/notices/${notice.id}`, null);
    expect(page.statusCode).toBe(200);
    expect(noticeSchema.parse(data(page))).toEqual({
      id: notice.id,
      title: '서비스 점검',
      body: doc('첫 줄', '둘째 줄'),
      createdAt: notice.createdAt,
      editedAt: null,
    });
    // Nothing of the admin who wrote it, in either answer.
    for (const body of [listed.body, page.body]) {
      expect(body).not.toContain(admin.id);
      expect(body).not.toContain(admin.email);
    }
    expect((await send('GET', `/notices/${UNKNOWN}`, null)).statusCode).toBe(404);
    expect((await send('GET', '/notices/not-a-uuid', null)).statusCode).toBe(400);
  });

  it('keeps an unpinned notice readable at its address and out of the fixed area', async () => {
    const never = await created('고정한 적 없는 공지');
    const once = await created('고정했다 푼 공지');
    expect((await pin(once.id)).statusCode).toBe(200);
    expect((await unpin(once.id)).statusCode).toBe(200);
    expect(await pinnedIds()).toEqual([]);
    for (const notice of [never, once]) {
      expect((await send('GET', `/notices/${notice.id}`, null)).statusCode).toBe(200);
    }
  });

  // ---- who may write ---------------------------------------------------------------------------

  it('lets only an admin write, edit, pin and unpin, and a refused request changes nothing', async () => {
    const notice = await created();
    const before = await t.db.select().from(schema.notices);
    const actionsBefore = await actions();
    const attempts = [
      () => send('POST', '/admin/notices', member, { title: '사칭', body: doc('x') }),
      () => send('PUT', `/admin/notices/${notice.id}`, member, { title: '사칭', body: doc('x') }),
      () => pin(notice.id, member),
      () => unpin(notice.id, member),
      () => send('GET', '/admin/notices?state=unpinned', member),
      () => send('GET', `/admin/notices/${notice.id}`, member),
    ];
    for (const attempt of attempts) {
      const res = await attempt();
      expect(res.statusCode, res.body).toBe(403);
    }
    expect(
      (await send('POST', '/admin/notices', null, { title: 'x', body: doc('x') })).statusCode,
    ).toBe(401);
    expect(await t.db.select().from(schema.notices)).toEqual(before);
    expect(await actions()).toEqual(actionsBefore);
    expect(await pinnedIds()).toEqual([]);
  });

  // ---- writing ---------------------------------------------------------------------------------

  it('writes an unpinned notice with a required title and the posts’ allow-list and limits', async () => {
    const notice = await created('  점검 안내  ', {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '<script>x</script> 안내', marks: [{ type: 'bold' }] },
            {
              type: 'text',
              text: '링크',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        },
        { type: 'iframe', attrs: { src: 'https://evil.example' } },
      ],
    });
    expect(notice).toMatchObject({ title: '점검 안내', editedAt: null, pinnedAt: null });
    // Markup is text, an unsafe link loses its mark, an unknown node goes with its content.
    expect(notice.body).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '<script>x</script> 안내', marks: [{ type: 'bold' }] },
            { type: 'text', text: '링크' },
          ],
        },
      ],
    });
    // Not pinned: in the admin's unpinned list, out of the fixed area.
    expect(await pinnedIds()).toEqual([]);
    expect(await adminIds('unpinned')).toEqual([notice.id]);
    const [row] = await t.db.select().from(schema.notices);
    expect(row).toMatchObject({ bodyText: '<script>x</script> 안내링크', pinSlot: null });

    const refusals = [
      [{ title: '   ', body: doc('x') }, ['title']],
      [{ body: doc('x') }, ['title']],
      [{ title: '가'.repeat(101), body: doc('x') }, ['title']],
      [{ title: '제목', body: { type: 'doc', content: [] } }, ['body']],
      [{ title: '제목', body: doc('가'.repeat(POST_BODY_MAX_LENGTH + 1)) }, ['body']],
    ] as const;
    for (const [payload, path] of refusals) {
      const res = await create(payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
      const details = errorOf(res).details as { path: (string | number)[] }[];
      expect(details[0]?.path.slice(0, 1)).toEqual(path);
    }
    expect(await t.db.select({ id: schema.notices.id }).from(schema.notices)).toEqual([
      { id: notice.id },
    ]);
  });

  it('edits by any admin, shows it as edited and keeps the version it replaced for operators', async () => {
    const notice = await created('처음 제목', doc('처음 본문'));
    expect((await pin(notice.id)).statusCode).toBe(200);
    const res = await edit(notice.id, { title: '고친 제목', body: doc('고친 본문') }, otherAdmin);
    expect(res.statusCode, res.body).toBe(200);
    const answer = adminNoticeUpdateResultSchema.parse(data(res));
    expect(answer.changed).toBe(true);
    const edited = answer.notice;
    expect(edited).toMatchObject({ title: '고친 제목', body: doc('고친 본문') });
    expect(edited.editedAt).not.toBeNull();
    // Still pinned where it was, and the public sees the edit and its '수정됨'.
    expect(edited.pinnedAt).not.toBeNull();
    expect(await pinnedIds()).toEqual([notice.id]);
    const page = noticeSchema.parse(data(await send('GET', `/notices/${notice.id}`, null)));
    expect(page).toMatchObject({ title: '고친 제목', editedAt: edited.editedAt });
    // The version it replaced, for operators only: never in a public answer.
    const revisions = await t.db.select().from(schema.noticeRevisions);
    expect(revisions).toEqual([
      expect.objectContaining({
        noticeId: notice.id,
        title: '처음 제목',
        body: doc('처음 본문'),
        bodyText: '처음 본문',
        imageIds: [],
        writtenAt: new Date(notice.createdAt),
        replacedAt: new Date(edited.editedAt!),
      }),
    ]);
    expect(JSON.stringify(page)).not.toContain('처음');
    // The same content again changes nothing: no '수정됨' moved, no version, no record.
    const actionsBefore = await actions();
    // The answer says so itself: `editedAt` is set (by the first edit) and still nothing changed —
    // what an admin who never read that edit could not tell from the time.
    const same = await edit(notice.id, { title: ' 고친 제목 ', body: doc('고친 본문') });
    expect(same.statusCode).toBe(200);
    expect(data<AdminNoticeUpdateResult>(same)).toMatchObject({
      changed: false,
      notice: { editedAt: edited.editedAt },
    });
    expect(await t.db.select().from(schema.noticeRevisions)).toHaveLength(1);
    expect(await actions()).toEqual(actionsBefore);
    // An unknown notice, and an edit the rules refuse, change nothing.
    expect((await edit(UNKNOWN, { title: 'x', body: doc('x') })).statusCode).toBe(404);
    expect((await edit(notice.id, { title: '', body: doc('x') })).statusCode).toBe(400);
    expect(await t.db.select().from(schema.noticeRevisions)).toHaveLength(1);
    // A second edit keeps the first edit's version, which began when that edit wrote it.
    const again = adminNoticeUpdateResultSchema.parse(
      data(await edit(notice.id, { title: '세 번째', body: doc('세 번째 본문') })),
    );
    expect(again.changed).toBe(true);
    const history = await t.db
      .select()
      .from(schema.noticeRevisions)
      .orderBy(asc(schema.noticeRevisions.id));
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      title: '고친 제목',
      body: doc('고친 본문'),
      imageIds: [],
      writtenAt: new Date(edited.editedAt!),
      replacedAt: new Date(again.notice.editedAt!),
    });
  });

  // ---- the record ------------------------------------------------------------------------------

  it('records the admin and the time of each write, edit, pin and unpin, only when it changed something', async () => {
    const notice = await created();
    await edit(notice.id, { title: '고침', body: doc('고친 본문') }, otherAdmin);
    await pin(notice.id, otherAdmin);
    await pin(notice.id); // pinned already: nothing
    await unpin(notice.id);
    await unpin(notice.id, otherAdmin); // unpinned already: nothing
    const [revision] = await t.db.select().from(schema.noticeRevisions);
    const recorded = await actions();
    expect(
      recorded.map(({ adminId, type, targetType, targetId, payload }) => ({
        adminId,
        type,
        targetType,
        targetId,
        payload,
      })),
    ).toEqual([
      {
        adminId: admin.id,
        type: 'notice_create',
        targetType: 'notice',
        targetId: notice.id,
        payload: null,
      },
      {
        adminId: otherAdmin.id,
        type: 'notice_update',
        targetType: 'notice',
        targetId: notice.id,
        payload: { revisionId: revision!.id },
      },
      {
        adminId: otherAdmin.id,
        type: 'notice_pin',
        targetType: 'notice',
        targetId: notice.id,
        payload: null,
      },
      {
        adminId: admin.id,
        type: 'notice_unpin',
        targetType: 'notice',
        targetId: notice.id,
        payload: null,
      },
    ]);
    // Each record is at the instant its change wrote.
    const [row] = await t.db.select().from(schema.notices);
    expect(recorded[0]!.createdAt).toEqual(row!.createdAt);
    expect(recorded[1]!.createdAt).toEqual(row!.editedAt);
    // The answers of the writes name no admin either.
    const res = await pin(notice.id);
    expect(res.body).not.toContain(admin.id);
  });

  // ---- pinning ---------------------------------------------------------------------------------

  it('pins at most three, the latest pinned first, and refuses a fourth until one is unpinned', async () => {
    const notices = [];
    for (const title of ['하나', '둘', '셋', '넷']) notices.push(await created(title));
    const [one, two, three, four] = notices as [AdminNotice, AdminNotice, AdminNotice, AdminNotice];
    for (const notice of [one, two, three]) {
      const res = await pin(notice.id);
      expect(res.statusCode, res.body).toBe(200);
      expect(data<AdminNotice>(res).pinnedAt).not.toBeNull();
    }
    expect(await pinnedIds()).toEqual([three.id, two.id, one.id]);
    const actionsBefore = await actions();
    const refused = await pin(four.id, otherAdmin);
    expect(refused.statusCode).toBe(409);
    expect(errorOf(refused)).toMatchObject({
      code: 'NOTICE_PIN_LIMIT_REACHED',
      details: { limit: NOTICE_PIN_LIMIT },
    });
    // Nothing unpinned itself to make room, and nothing was recorded.
    expect(await pinnedIds()).toEqual([three.id, two.id, one.id]);
    expect(await actions()).toEqual(actionsBefore);
    // Unpinned, a notice stays on the admin screen and can be pinned again; a fourth fits now.
    expect((await unpin(two.id)).statusCode).toBe(200);
    expect((await pin(four.id)).statusCode).toBe(200);
    expect(await pinnedIds()).toEqual([four.id, three.id, one.id]);
    expect(await adminIds('unpinned')).toEqual([two.id]);
    expect((await pin(two.id)).statusCode).toBe(409);
    expect((await unpin(one.id)).statusCode).toBe(200);
    expect((await pin(two.id)).statusCode).toBe(200);
    // Pinned again, on top: the area is the latest pinned first, whenever it was written.
    expect(await pinnedIds()).toEqual([two.id, four.id, three.id]);
    // The admin's pinned list is the area, in its order, page by page.
    expect(await adminIds('pinned', 1)).toEqual([two.id, four.id, three.id]);
    expect(await adminIds('unpinned', 1)).toEqual([one.id]);
    // An unknown notice.
    expect((await pin(UNKNOWN)).statusCode).toBe(404);
    expect((await unpin(UNKNOWN)).statusCode).toBe(404);
  });

  it('lists the unpinned notices newest first, page by page', async () => {
    const base = Date.now() - 60_000;
    const rows = [];
    for (let index = 0; index < 5; index += 1) {
      rows.push(await createNotice(t.db, { createdAt: new Date(base + index * 1_000) }));
    }
    await createNotice(t.db, { pinSlot: 2 });
    const newestFirst = rows.map((row) => row.id).reverse();
    expect(await adminIds('unpinned', 2)).toEqual(newestFirst);
    expect(await adminIds('unpinned')).toEqual(newestFirst);
    expect((await send('GET', '/admin/notices', admin)).statusCode).toBe(400);
    const one = await send('GET', `/admin/notices/${rows[0]!.id}`, admin);
    expect(adminNoticeSchema.parse(data(one))).toMatchObject({ id: rows[0]!.id, pinnedAt: null });
    expect((await send('GET', `/admin/notices/${UNKNOWN}`, admin)).statusCode).toBe(404);
  });

  it('never pins past the limit when pins race, and refuses none while a slot is free', async () => {
    const notices = [];
    for (let index = 0; index < NOTICE_PIN_LIMIT + 2; index += 1) notices.push(await created());
    // Every pin queues behind the pinned set's lock, held here, and then runs at once.
    const holder = await t.db.$client.connect();
    let pending: Promise<Awaited<ReturnType<typeof pin>>[]> | undefined;
    let held = true;
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext('buddha:notice-pins'), 0)");
      pending = Promise.all(
        notices.map((notice, index) => pin(notice.id, index % 2 === 0 ? admin : otherAdmin)),
      );
      await waitForLockWaiter(holder, 'the pins waiting for the pinned set', notices.length);
      await holder.query("SELECT pg_advisory_unlock(hashtext('buddha:notice-pins'), 0)");
      held = false;
      const results = await pending;
      const statuses = results.map((res) => res.statusCode).sort();
      expect(statuses).toEqual([200, 200, 200, 409, 409]);
      for (const res of results.filter((candidate) => candidate.statusCode === 409)) {
        expect(errorOf(res).code).toBe('NOTICE_PIN_LIMIT_REACHED');
      }
    } finally {
      if (held) await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
      await pending?.catch(() => undefined);
    }
    const slots = await t.db
      .select({ slot: schema.notices.pinSlot })
      .from(schema.notices)
      .where(isNotNull(schema.notices.pinSlot));
    expect(slots.map((row) => row.slot).sort()).toEqual([1, 2, 3]);
    expect((await actions()).filter((row) => row.type === 'notice_pin')).toHaveLength(
      NOTICE_PIN_LIMIT,
    );
    expect(await pinnedIds()).toHaveLength(NOTICE_PIN_LIMIT);
  });

  it('records one pin when two admins pin the same notice at once', async () => {
    const notice = await created();
    const results = await Promise.all([pin(notice.id), pin(notice.id, otherAdmin)]);
    expect(results.map((res) => res.statusCode)).toEqual([200, 200]);
    expect((await actions()).filter((row) => row.type === 'notice_pin')).toHaveLength(1);
    const unpinned = await Promise.all([unpin(notice.id), unpin(notice.id, otherAdmin)]);
    expect(unpinned.map((res) => res.statusCode)).toEqual([200, 200]);
    expect((await actions()).filter((row) => row.type === 'notice_unpin')).toHaveLength(1);
  });

  it('pins on top even when the clock has not passed the latest pin', async () => {
    // A pin whose time the clock has not reached: what a pin in the same millisecond, or a clock
    // that stepped back, leaves for the next one.
    const ahead = new Date(Date.now() + 60 * 60_000);
    const earlier = await createNotice(t.db, { pinSlot: 2, pinnedAt: ahead });
    const notice = await created();
    const res = await pin(notice.id);
    expect(res.statusCode, res.body).toBe(200);
    const pinnedAt = new Date(data<AdminNotice>(res).pinnedAt!);
    expect(pinnedAt.getTime()).toBe(ahead.getTime() + 1);
    expect(await pinnedIds()).toEqual([notice.id, earlier.id]);
    expect(await adminIds('pinned')).toEqual([notice.id, earlier.id]);
    // The record is at the pin's instant.
    const [record] = (await actions()).filter((row) => row.type === 'notice_pin');
    expect(record?.createdAt).toEqual(pinnedAt);
  });

  /**
   * Holds the notice's row lock — what a write of it holds until it commits — and sends the
   * requests one at a time, each once the one before waits on a lock (pin and unpin take the pinned
   * set's lock before the row, an edit the row alone), then lets them go and returns the answers.
   */
  async function behindTheNoticeRow(
    noticeId: string,
    requests: (() => ReturnType<typeof send>)[],
  ): Promise<Awaited<ReturnType<typeof send>>[]> {
    const holder = await t.db.$client.connect();
    const pending: ReturnType<typeof send>[] = [];
    let committed = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM notices WHERE id = $1 FOR UPDATE', [noticeId]);
      for (const [index, request] of requests.entries()) {
        pending.push(request());
        await waitForLockWaiter(holder, `request ${String(index + 1)} on the notice`, index + 1);
      }
      await holder.query('COMMIT');
      committed = true;
      return await Promise.all(pending);
    } finally {
      if (!committed) await holder.query('ROLLBACK');
      holder.release();
      await Promise.allSettled(pending);
    }
  }

  it('keeps every version when two admins save one notice at once, the later save winning', async () => {
    const notice = await created('처음', doc('처음 본문'));
    const answers = await behindTheNoticeRow(notice.id, [
      () => edit(notice.id, { title: '가', body: doc('가 본문') }, admin),
      () => edit(notice.id, { title: '나', body: doc('나 본문') }, otherAdmin),
    ]);
    expect(answers.map((res) => res.statusCode)).toEqual([200, 200]);
    for (const res of answers) expect(data<AdminNoticeUpdateResult>(res).changed).toBe(true);
    // The second save replaced the first one's version, not the one both started from: the
    // history holds the original and the version the notice no longer shows, in a chain.
    const [row] = await t.db.select().from(schema.notices);
    const history = await t.db
      .select()
      .from(schema.noticeRevisions)
      .orderBy(asc(schema.noticeRevisions.id));
    expect(history.map((revision) => revision.title)).toEqual([
      '처음',
      row!.title === '가' ? '나' : '가',
    ]);
    expect(history[1]!.writtenAt).toEqual(history[0]!.replacedAt);
    expect(row!.editedAt).toEqual(history[1]!.replacedAt);
    // Each record names the version its own save replaced.
    const [firstSaver, lastSaver] = row!.title === '나' ? [admin, otherAdmin] : [otherAdmin, admin];
    const updates = (await actions()).filter((action) => action.type === 'notice_update');
    expect(Object.fromEntries(updates.map(({ adminId, payload }) => [adminId, payload]))).toEqual({
      [firstSaver.id]: { revisionId: history[0]!.id },
      [lastSaver.id]: { revisionId: history[1]!.id },
    });
  });

  // A pin and an unpin of one notice take the pinned set's lock and then the row, both of them:
  // in the other order each would hold what the other waits for (a deadlock, a 500). The first
  // request is sent while the row is held, so it holds the pinned set's lock as it waits — the
  // second one queues behind it rather than taking the row first.
  it('lets a pin and an unpin of one notice take turns, the pin first', async () => {
    const notice = await created();
    const answers = await behindTheNoticeRow(notice.id, [
      () => pin(notice.id),
      () => unpin(notice.id, otherAdmin),
    ]);
    expect(answers.map((res) => res.statusCode)).toEqual([200, 200]);
    // The pin went first and the unpin after it: unpinned, each recorded once.
    expect(await pinnedIds()).toEqual([]);
    expect(await recordedSet()).toEqual(
      [
        `notice_create ${admin.id}`,
        `notice_pin ${admin.id}`,
        `notice_unpin ${otherAdmin.id}`,
      ].sort(),
    );
  });

  it('lets an unpin and a pin of one notice take turns, the unpin first', async () => {
    const notice = await created();
    expect((await pin(notice.id)).statusCode).toBe(200);
    const answers = await behindTheNoticeRow(notice.id, [
      () => unpin(notice.id),
      () => pin(notice.id, otherAdmin),
    ]);
    expect(answers.map((res) => res.statusCode)).toEqual([200, 200]);
    // The unpin went first and the pin after it: pinned again, each recorded once.
    expect(await pinnedIds()).toEqual([notice.id]);
    expect(await recordedSet()).toEqual(
      [
        `notice_create ${admin.id}`,
        `notice_pin ${admin.id}`,
        `notice_unpin ${admin.id}`,
        `notice_pin ${otherAdmin.id}`,
      ].sort(),
    );
  });

  // ---- images ----------------------------------------------------------------------------------

  /** An upload of `who`'s with its object in the test store, as `POST /media/images` leaves it. */
  async function upload(who: TestUser = admin) {
    const media = await createMedia(t.db, { ownerId: who.id, contentType: 'image/png' });
    await t.storage.put(media.storageKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png');
    return media;
  }
  const image = (mediaId: string) => send('GET', `/media/${mediaId}`, null);

  it('takes the admin’s own uploads, serves them while the notice shows them, and keeps them through any admin’s edit', async () => {
    const mine = await upload();
    const notice = await created('사진 공지', withImages(mine.id));
    expect(notice.body).toEqual(withImages(mine.id));
    expect(await t.db.select().from(schema.noticeImages)).toEqual([
      { noticeId: notice.id, mediaId: mine.id, createdAt: expect.any(Date) as unknown },
    ]);
    const [attached] = await t.db
      .select()
      .from(schema.mediaObjects)
      .where(eq(schema.mediaObjects.id, mine.id));
    expect(attached?.attachedAt).toBeInstanceOf(Date);
    // Served unpinned too: the notice is read at its address.
    expect((await image(mine.id)).statusCode).toBe(200);
    // Another admin's edit keeps the image the first admin uploaded, and adds its own.
    const theirs = await upload(otherAdmin);
    const kept = await edit(
      notice.id,
      { title: '사진 공지', body: withImages(mine.id, theirs.id) },
      otherAdmin,
    );
    expect(kept.statusCode, kept.body).toBe(200);
    expect((await image(theirs.id)).statusCode).toBe(200);
    // An edit that takes an image out stops serving it; the history keeps it attached.
    const removed = await edit(notice.id, { title: '사진 공지', body: withImages(theirs.id) });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await image(mine.id)).statusCode).toBe(404);
    expect((await image(theirs.id)).statusCode).toBe(200);
    expect(
      (await t.db.select().from(schema.noticeImages)).map((row) => row.mediaId).sort(),
    ).toEqual([mine.id, theirs.id].sort());
    // Each version in the history keeps the images it had, not the ones that replaced them.
    const history = await t.db
      .select({ imageIds: schema.noticeRevisions.imageIds })
      .from(schema.noticeRevisions)
      .orderBy(asc(schema.noticeRevisions.id));
    expect(history).toEqual([{ imageIds: [mine.id] }, { imageIds: [mine.id, theirs.id] }]);
  });

  it('refuses an image that is not the admin’s, that a post or another notice holds, and gives a notice’s image to no post', async () => {
    const market = await createMarket(t.db);
    const othersUpload = await upload(otherAdmin);
    const membersUpload = await upload(member);
    const inPost = await upload();
    await createPost(t.db, { marketId: market.id, authorId: admin.id, imageIds: [inPost.id] });
    const inNotice = await upload();
    await createNotice(t.db, { imageIds: [inNotice.id] });
    for (const mediaId of [othersUpload.id, membersUpload.id, inPost.id, inNotice.id, UNKNOWN]) {
      const res = await create({ title: '사진', body: withImages(mediaId) });
      expect(res.statusCode, mediaId).toBe(400);
      expect(errorOf(res).details).toEqual([
        { path: ['body'], message: postImageNotUsableMessage(mediaId) },
      ]);
    }
    // A post cannot take a notice's image either, its own uploader's post included.
    const post = await send('POST', '/posts', admin, {
      marketId: market.id,
      body: withImages(inNotice.id),
      expectedAccountId: admin.id,
    });
    expect(post.statusCode, post.body).toBe(400);
    expect(errorOf(post).details).toEqual([
      { path: ['body'], message: postImageNotUsableMessage(inNotice.id) },
    ]);
    expect(await t.db.select().from(schema.noticeImages)).toHaveLength(1);
  });

  /**
   * A write of another kind holding `mediaId` and not committed yet — what a post's or a notice's
   * transaction holds between its claim and its commit: the upload locked, its owner recorded.
   * Runs `whileHeld` once the write under test waits on that lock, then commits.
   */
  async function racingTheClaim<T>(
    mediaId: string,
    claim: string,
    params: unknown[],
    whileHeld: () => Promise<T>,
  ): Promise<T> {
    const holder = await t.db.$client.connect();
    let pending: Promise<T> | undefined;
    let committed = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM media_objects WHERE id = $1 FOR UPDATE', [mediaId]);
      await holder.query(claim, params);
      await holder.query('UPDATE media_objects SET attached_at = now() WHERE id = $1', [mediaId]);
      pending = whileHeld();
      await waitForLockWaiter(holder, 'the write on the upload another write holds');
      await holder.query('COMMIT');
      committed = true;
      return await pending;
    } finally {
      if (!committed) await holder.query('ROLLBACK');
      holder.release();
      await pending?.catch(() => undefined);
    }
  }

  it('refuses a notice the upload a post took while it waited, and a post the one a notice took', async () => {
    const market = await createMarket(t.db);
    const forPost = await upload();
    const post = await createPost(t.db, { marketId: market.id, authorId: admin.id });
    const notice = await racingTheClaim(
      forPost.id,
      'INSERT INTO post_images (post_id, media_id) VALUES ($1, $2)',
      [post.id, forPost.id],
      () => create({ title: '사진', body: withImages(forPost.id) }),
    );
    expect(notice.statusCode, notice.body).toBe(400);
    expect(await t.db.select().from(schema.notices)).toEqual([]);

    const forNotice = await upload();
    const held = await createNotice(t.db);
    const posted = await racingTheClaim(
      forNotice.id,
      'INSERT INTO notice_images (notice_id, media_id) VALUES ($1, $2)',
      [held.id, forNotice.id],
      () =>
        send('POST', '/posts', admin, {
          marketId: market.id,
          body: withImages(forNotice.id),
          expectedAccountId: admin.id,
        }),
    );
    expect(posted.statusCode, posted.body).toBe(400);
    expect(await t.db.select({ id: schema.posts.id }).from(schema.posts)).toEqual([
      { id: post.id },
    ]);
    expect(await t.db.select().from(schema.postImages)).toEqual([
      { postId: post.id, mediaId: forPost.id, createdAt: expect.any(Date) as unknown },
    ]);
  });
});
