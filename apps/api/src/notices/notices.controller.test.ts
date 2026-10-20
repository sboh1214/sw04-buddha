/**
 * 운영 공지 (#138) against the docker `test` profile: the pinned notices above the community list
 * and a notice page (`/notices`), and the admins' writes, pins and unpins (`/admin/notices`).
 * Owner decisions under test (ADR-0069 decision 2 #45-8, decision 4 #138): a required title and a
 * body of the posts' editor (its allow-list and limits, links and images); '수정됨' and the
 * operators' history; at most three pinned, never unpinned automatically, an unpinned notice kept
 * and pinnable again; every admin may write, edit, pin and unpin, no approval; each change records
 * its admin and time and no reason; anyone reads, and no answer names an operator. The owner's
 * answers of 2026-10-21: only a pinned notice is public — another answers like a missing one, its
 * images too — while the admin screens read it; the latest pinned first; the admin's notice screen
 * reads its operation records and its earlier versions (and their images); an edit opened from a
 * version another admin replaced since is refused (NOTICE_EDIT_CONFLICT). And this PR's choices: a
 * pin always after the ones in place; a notice's image belongs to it alone, never to a post; two
 * saves of one notice take turns, the second refused when both were opened from one version. Skips
 * when TEST_* are unset.
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
  adminNoticeActionSchema,
  adminNoticeRevisionSchema,
  adminNoticeRevisionSummarySchema,
  adminNoticeSchema,
  adminNoticeSummarySchema,
  adminNoticeUpdateResultSchema,
  noticeSchema,
  noticeSummarySchema,
  postImageNotUsableMessage,
  type AdminNotice,
  type AdminNoticeAction,
  type AdminNoticeRevisionSummary,
  type AdminNoticeSummary,
  type AdminNoticeUpdateResult,
  type NoticeSummary,
} from '@buddha/shared';
import { asc, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import {
  IMAGE_READ_BUDGET_BYTES,
  IMAGE_READ_BUSY_RETRY_SECONDS,
  imageReads,
} from '../media/image-reads.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const ORIGIN = 'http://localhost:3000';
const UNKNOWN = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';

type ErrorBody = { error: { code: string; details?: unknown } };
type AdminPage = { data: AdminNoticeSummary[]; meta: { nextCursor: string | null } };
type Page<T> = { data: T[]; meta: { nextCursor: string | null } };

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
  /** The notice's version as an edit screen opening it now reads it: its `editedAt`. */
  async function versionOf(id: string): Promise<string | null> {
    const [row] = await t.db
      .select({ editedAt: schema.notices.editedAt })
      .from(schema.notices)
      .where(eq(schema.notices.id, id));
    return row?.editedAt?.toISOString() ?? null;
  }
  /**
   * An edit, sent with the version it was opened from: `opened` when a test names one (a screen
   * opened earlier), else the notice's version now — a screen that just opened it.
   */
  const edit = async (
    id: string,
    payload: Record<string, unknown>,
    who: TestUser = admin,
    opened?: string | null,
  ) =>
    send('PUT', `/admin/notices/${id}`, who, {
      ...payload,
      expectedEditedAt: opened === undefined ? await versionOf(id) : opened,
    });
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

  it('answers a notice that is not pinned like a missing one, and shows it to admins', async () => {
    // Owner decision 2026-10-21: «고정하지 않았거나 푼 공지 → 공개 안 함(주소로도 없는 공지처럼),
    // 관리자 화면에서는 보임».
    const never = await created('고정한 적 없는 공지');
    const once = await created('고정했다 푼 공지');
    expect((await pin(once.id)).statusCode).toBe(200);
    expect((await send('GET', `/notices/${once.id}`, null)).statusCode).toBe(200);
    expect((await unpin(once.id)).statusCode).toBe(200);
    expect(await pinnedIds()).toEqual([]);
    const missing = await send('GET', `/notices/${UNKNOWN}`, null);
    for (const notice of [never, once]) {
      for (const who of [null, member, admin]) {
        const res = await send('GET', `/notices/${notice.id}`, who);
        // The same answer as an unknown id's: nothing tells a notice kept unpinned from none.
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(missing.json());
      }
      const kept = await send('GET', `/admin/notices/${notice.id}`, admin);
      expect(adminNoticeSchema.parse(data(kept))).toMatchObject({ id: notice.id, pinnedAt: null });
    }
    expect(await adminIds('unpinned')).toEqual([once.id, never.id]);
    // Pinned again, it is public again.
    expect((await pin(once.id)).statusCode).toBe(200);
    expect((await send('GET', `/notices/${once.id}`, null)).statusCode).toBe(200);
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
    // The same content again, from the version it now is, changes nothing: no '수정됨' moved, no
    // version, no record — and the answer says so itself (`changed: false`).
    const actionsBefore = await actions();
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

  it('refuses the later of two saves opened from one version, keeping the first one’s', async () => {
    // Owner decision 2026-10-21: «연 뒤 다른 운영자가 고쳤으면 저장을 막고». Both screens opened
    // the notice never edited (`null`); the row lock lets one save first, and the other then
    // finds its version gone.
    const notice = await created('처음', doc('처음 본문'));
    const answers = await behindTheNoticeRow(notice.id, [
      () => edit(notice.id, { title: '가', body: doc('가 본문') }, admin, null),
      () => edit(notice.id, { title: '나', body: doc('나 본문') }, otherAdmin, null),
    ]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const won = answers.find((res) => res.statusCode === 200)!;
    const lost = answers.find((res) => res.statusCode === 409)!;
    const saved = adminNoticeUpdateResultSchema.parse(data(won));
    expect(saved.changed).toBe(true);
    expect(errorOf(lost)).toEqual({
      code: 'NOTICE_EDIT_CONFLICT',
      message: expect.any(String) as unknown,
      details: { editedAt: saved.notice.editedAt },
    });
    // One version kept (the original), one edit recorded: the refused save wrote nothing.
    const [row] = await t.db.select().from(schema.notices);
    expect(row!.title).toBe(saved.notice.title);
    const history = await t.db.select().from(schema.noticeRevisions);
    expect(history.map((revision) => revision.title)).toEqual(['처음']);
    const updates = (await actions()).filter((action) => action.type === 'notice_update');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toEqual({ revisionId: history[0]!.id });
  });

  it('refuses an edit opened from a version another admin replaced, changing nothing', async () => {
    const notice = await created('처음', doc('처음 본문'));
    const first = adminNoticeUpdateResultSchema.parse(
      data(await edit(notice.id, { title: '둘째', body: doc('둘째 본문') }, otherAdmin, null)),
    );
    const before = await t.db.select().from(schema.notices);
    const actionsBefore = await actions();
    // A screen opened before that edit: refused, even to send what the notice now says.
    for (const payload of [
      { title: '내 수정', body: doc('내 본문') },
      { title: '둘째', body: doc('둘째 본문') },
    ]) {
      const res = await edit(notice.id, payload, admin, null);
      expect(res.statusCode, res.body).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'NOTICE_EDIT_CONFLICT',
        details: { editedAt: first.notice.editedAt },
      });
    }
    // A version the notice never had (a time off by a millisecond) is refused the same way.
    const off = new Date(new Date(first.notice.editedAt!).getTime() - 1).toISOString();
    expect((await edit(notice.id, { title: 'x', body: doc('x') }, admin, off)).statusCode).toBe(
      409,
    );
    expect(await t.db.select().from(schema.notices)).toEqual(before);
    expect(await t.db.select().from(schema.noticeRevisions)).toHaveLength(1);
    expect(await actions()).toEqual(actionsBefore);
    // Saying no version at all is malformed, not a conflict.
    const unsaid = await send('PUT', `/admin/notices/${notice.id}`, admin, {
      title: 'x',
      body: doc('x'),
    });
    expect(unsaid.statusCode).toBe(400);
    expect((errorOf(unsaid).details as { path: string[] }[])[0]?.path).toEqual([
      'expectedEditedAt',
    ]);
    // Reopened at the latest version, the save goes through, and is stamped after that version.
    const again = await edit(
      notice.id,
      { title: '내 수정', body: doc('내 본문') },
      admin,
      first.notice.editedAt,
    );
    expect(again.statusCode, again.body).toBe(200);
    const saved = adminNoticeUpdateResultSchema.parse(data(again));
    expect(saved.changed).toBe(true);
    expect(new Date(saved.notice.editedAt!).getTime()).toBeGreaterThan(
      new Date(first.notice.editedAt!).getTime(),
    );
  });

  it('refuses a save its own admin overtook as well: the check reads versions, not who saved', async () => {
    // ADR-0077 decision 8-19 (a choice, not the owner's — 결과 4 asks): the same admin's other tab,
    // or a retry of a save that committed but whose answer was lost, sends a version the notice
    // has left, and is refused as another admin's save would be — the same content included.
    const notice = await created('처음', doc('처음 본문'));
    const sent = { title: '내 수정', body: doc('내 본문') };
    const first = await edit(notice.id, sent, admin, null);
    expect(first.statusCode, first.body).toBe(200);
    const saved = adminNoticeUpdateResultSchema.parse(data(first));
    const actionsBefore = await actions();
    for (const payload of [sent, { title: '다른 탭의 수정', body: doc('다른 탭') }]) {
      const res = await edit(notice.id, payload, admin, null);
      expect(res.statusCode, res.body).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'NOTICE_EDIT_CONFLICT',
        details: { editedAt: saved.notice.editedAt },
      });
    }
    expect(await t.db.select().from(schema.noticeRevisions)).toHaveLength(1);
    expect(await actions()).toEqual(actionsBefore);
  });

  it('stamps an edit after the version it replaces even when the clock has not passed it', async () => {
    // A version whose time the clock has not reached: an edit in the same millisecond, or a clock
    // that stepped back. The next version must still have a time of its own, or two versions
    // would share the token an edit screen sends.
    const ahead = new Date(Date.now() + 60 * 60_000);
    const notice = await createNotice(t.db, { editedAt: ahead });
    const res = await edit(
      notice.id,
      { title: '고침', body: doc('고친 본문') },
      admin,
      ahead.toISOString(),
    );
    expect(res.statusCode, res.body).toBe(200);
    const saved = adminNoticeUpdateResultSchema.parse(data(res));
    expect(new Date(saved.notice.editedAt!).getTime()).toBe(ahead.getTime() + 1);
    const [revision] = await t.db.select().from(schema.noticeRevisions);
    expect(revision).toMatchObject({ writtenAt: ahead, replacedAt: new Date(ahead.getTime() + 1) });
  });

  // ---- the admin's notice screen: records and earlier versions ----------------------------------

  /** One of a notice's admin lists, page by page (`limit` per page), to the end. */
  async function pagesOf<T>(url: string, limit: number): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = `limit=${String(limit)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await send('GET', `${url}?${query}`, admin);
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<Page<T>>();
      items.push(...page.data);
      cursor = page.meta.nextCursor;
      pages += 1;
      if (pages > 20) throw new Error('the cursor never ended');
    } while (cursor);
    return items;
  }
  const nicknameOf = async (who: TestUser) => {
    const [row] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, who.id));
    return row!.nickname;
  };

  it('shows the admin a notice’s operation records, newest first, with who and when', async () => {
    // Owner decision 2026-10-21: «관리자 공지 화면 → 운영 기록(운영자·시각·동작)».
    const notice = await created('기록 공지', doc('처음'));
    await edit(notice.id, { title: '기록 공지', body: doc('고침') }, otherAdmin);
    await pin(notice.id, otherAdmin);
    await unpin(notice.id);
    const other = await created('다른 공지');
    await pin(other.id);
    const [revision] = await t.db.select().from(schema.noticeRevisions);
    // The API's order: newest first, and by id within a millisecond (uuids compare as their text).
    const ofNotice = (await actions())
      .filter((row) => row.targetId === notice.id)
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
    for (const limit of [20, 1]) {
      const items = await pagesOf<AdminNoticeAction>(`/admin/notices/${notice.id}/actions`, limit);
      for (const item of items) adminNoticeActionSchema.parse(item);
      // Each of this notice's records, none of the other's: the admin, the time, what was done.
      expect(items.map(({ id }) => id)).toEqual(ofNotice.map(({ id }) => id));
      expect(items).toEqual(
        ofNotice.map((row) => ({
          id: row.id,
          type: row.type,
          actor: { id: row.adminId, nickname: expect.any(String) as unknown },
          createdAt: row.createdAt.toISOString(),
          revisionId: row.type === 'notice_update' ? revision!.id : null,
        })),
      );
    }
    // Who did what, by the nickname the screen shows (the order is checked above).
    const items = await pagesOf<AdminNoticeAction>(`/admin/notices/${notice.id}/actions`, 20);
    expect(items.map(({ type, actor }) => `${type} ${actor.nickname}`).sort()).toEqual(
      [
        `notice_unpin ${await nicknameOf(admin)}`,
        `notice_pin ${await nicknameOf(otherAdmin)}`,
        `notice_update ${await nicknameOf(otherAdmin)}`,
        `notice_create ${await nicknameOf(admin)}`,
      ].sort(),
    );
    // An unknown notice has none; a member and a visitor are refused (admin-access.test.ts).
    expect(data(await send('GET', `/admin/notices/${UNKNOWN}/actions`, admin))).toEqual([]);
    expect((await send('GET', `/admin/notices/${notice.id}/actions`, member)).statusCode).toBe(403);
    expect((await send('GET', `/admin/notices/not-a-uuid/actions`, admin)).statusCode).toBe(400);
  });

  it('shows the admin a notice’s earlier versions, who wrote and who replaced each, and one whole', async () => {
    // Owner decision 2026-10-21: «관리자 공지 화면 → 이전 판을 보임»; the history is kept with no
    // retention period.
    const notice = await created('첫 판', doc('첫 본문'));
    await edit(notice.id, { title: '둘째 판', body: doc('둘째 본문') }, otherAdmin);
    await edit(notice.id, { title: '셋째 판', body: doc('셋째 본문') }, admin);
    await edit(notice.id, { title: '지금 판', body: doc('지금 본문') }, otherAdmin);
    const other = await created('다른 공지');
    await edit(other.id, { title: '다른 공지 고침', body: doc('x') });
    const history = await t.db
      .select()
      .from(schema.noticeRevisions)
      .where(eq(schema.noticeRevisions.noticeId, notice.id))
      .orderBy(asc(schema.noticeRevisions.id));
    expect(history.map(({ title }) => title)).toEqual(['첫 판', '둘째 판', '셋째 판']);
    const [mine, theirs] = [
      { id: admin.id, nickname: await nicknameOf(admin) },
      { id: otherAdmin.id, nickname: await nicknameOf(otherAdmin) },
    ];
    const expected = [
      { revision: history[2]!, writtenBy: mine, replacedBy: theirs },
      { revision: history[1]!, writtenBy: theirs, replacedBy: mine },
      { revision: history[0]!, writtenBy: mine, replacedBy: theirs },
    ].map(({ revision, writtenBy, replacedBy }) => ({
      id: revision.id,
      title: revision.title,
      writtenAt: revision.writtenAt.toISOString(),
      writtenBy,
      replacedAt: revision.replacedAt.toISOString(),
      replacedBy,
    }));
    // Page by page too: the version before a page's oldest is read with the page.
    for (const limit of [20, 2, 1]) {
      const items = await pagesOf<AdminNoticeRevisionSummary>(
        `/admin/notices/${notice.id}/revisions`,
        limit,
      );
      for (const item of items) adminNoticeRevisionSummarySchema.parse(item);
      expect(items).toEqual(expected);
    }
    // One version whole, read-only.
    const one = await send(
      'GET',
      `/admin/notices/${notice.id}/revisions/${String(history[1]!.id)}`,
      admin,
    );
    expect(one.statusCode, one.body).toBe(200);
    expect(adminNoticeRevisionSchema.parse(data(one))).toEqual({
      ...expected[1],
      body: doc('둘째 본문'),
    });
    const firstVersion = data<{ writtenBy: unknown }>(
      await send('GET', `/admin/notices/${notice.id}/revisions/${String(history[0]!.id)}`, admin),
    );
    expect(firstVersion.writtenBy).toEqual(mine);
    // Another notice's version, an unknown one, and a malformed id.
    const [otherVersion] = await t.db
      .select()
      .from(schema.noticeRevisions)
      .where(eq(schema.noticeRevisions.noticeId, other.id));
    for (const [path, status] of [
      [`${notice.id}/revisions/${String(otherVersion!.id)}`, 404],
      [`${notice.id}/revisions/999999`, 404],
      [`${UNKNOWN}/revisions/${String(history[0]!.id)}`, 404],
      [`${notice.id}/revisions/0`, 400],
      [`${notice.id}/revisions/x1`, 400],
      [`${notice.id}/revisions/${'9'.repeat(16)}`, 400],
    ] as const) {
      expect((await send('GET', `/admin/notices/${path}`, admin)).statusCode, path).toBe(status);
    }
    expect(data(await send('GET', `/admin/notices/${UNKNOWN}/revisions`, admin))).toEqual([]);
    // A version no record names (a row written past the API) has no operator to name.
    const bare = await createNotice(t.db);
    await t.db.insert(schema.noticeRevisions).values({
      noticeId: bare.id,
      title: bare.title,
      body: bare.body,
      bodyText: bare.bodyText,
      imageIds: [],
      writtenAt: bare.createdAt,
    });
    const [unnamed] = await pagesOf<AdminNoticeRevisionSummary>(
      `/admin/notices/${bare.id}/revisions`,
      20,
    );
    expect(unnamed).toMatchObject({ writtenBy: null, replacedBy: null });
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
  const adminImage = (noticeId: string, mediaId: string, who: TestUser | null = admin) =>
    send('GET', `/admin/notices/${noticeId}/images/${mediaId}`, who);

  it('serves the admin screens every image a notice holds, privately, and none it does not', async () => {
    const market = await createMarket(t.db);
    const kept = await upload();
    const notice = await created('사진 공지', withImages(kept.id));
    const res = await adminImage(notice.id, kept.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    // A copy for this admin's browser alone, asked again on every use.
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.etag).toBe(`"${kept.id}"`);
    const revalidated = await t.app.inject({
      method: 'GET',
      url: `/api/v1/admin/notices/${notice.id}/images/${kept.id}`,
      headers: { cookie: admin.cookie, 'if-none-match': `"${kept.id}"` },
    });
    expect(revalidated.statusCode).toBe(304);
    // Not another notice's image, a post's, an upload nothing took or an unknown one.
    const elsewhere = await upload();
    await createNotice(t.db, { imageIds: [elsewhere.id] });
    const inPost = await upload();
    await createPost(t.db, { marketId: market.id, authorId: admin.id, imageIds: [inPost.id] });
    const loose = await upload();
    for (const mediaId of [elsewhere.id, inPost.id, loose.id, UNKNOWN]) {
      expect((await adminImage(notice.id, mediaId)).statusCode, mediaId).toBe(404);
    }
    expect((await adminImage(UNKNOWN, kept.id)).statusCode).toBe(404);
    // Admins only.
    expect((await adminImage(notice.id, kept.id, member)).statusCode).toBe(403);
    expect((await adminImage(notice.id, kept.id, null)).statusCode).toBe(401);
  });

  it('holds an admin’s image read within the public reads’ budget: past it, refused unread; given back once sent', async () => {
    const kept = await upload();
    const notice = await created('사진 공지', withImages(kept.id));
    // Other reads hold the whole budget (the one `GET /media/:mediaId` takes from, image-reads.ts).
    const others = imageReads.take(IMAGE_READ_BUDGET_BYTES);
    expect(others).not.toBeNull();
    try {
      const busy = await adminImage(notice.id, kept.id);
      expect(busy.statusCode).toBe(429);
      expect(busy.headers['retry-after']).toBe(String(IMAGE_READ_BUSY_RETRY_SECONDS));
      expect(busy.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
    } finally {
      others?.();
    }
    expect(imageReads.size).toBe(0);
    const res = await adminImage(notice.id, kept.id);
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(imageReads.size).toBe(0);
    });
  });

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
    // Not served to the public while the notice is not pinned (owner decision 2026-10-21), as its
    // page is not; the admin screens read it all the same.
    expect((await image(mine.id)).statusCode).toBe(404);
    expect((await adminImage(notice.id, mine.id)).statusCode).toBe(200);
    expect((await pin(notice.id)).statusCode).toBe(200);
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
    // An edit that takes an image out stops serving it; the history keeps it attached, and the
    // admin screens still show it with the earlier version.
    const removed = await edit(notice.id, { title: '사진 공지', body: withImages(theirs.id) });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await image(mine.id)).statusCode).toBe(404);
    expect((await image(theirs.id)).statusCode).toBe(200);
    expect((await adminImage(notice.id, mine.id)).statusCode).toBe(200);
    // Unpinned, none of its images is public; the admin screens still show them.
    expect((await unpin(notice.id)).statusCode).toBe(200);
    expect((await image(theirs.id)).statusCode).toBe(404);
    expect((await adminImage(notice.id, theirs.id)).statusCode).toBe(200);
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
