/**
 * 앱 내 알림함 (#53, ADR-0157; owner answers 53-1…53-11) over HTTP, against the docker `test`
 * profile: `GET /me/notifications`, `GET /me/notifications/unread-count`, `POST
 * /me/notifications/:id/read` and `POST /me/notifications/read-all`. #53 ships no type (52-20), so
 * the notifications here are the tests' own (`createTestNotification`, @buddha/db/test), written
 * through the producers' one write path. Pinned: the session's own inbox newest first by 발생
 * 시각 with the keyset cursor (53-3) — a merged one at its latest event — and nobody else's; the
 * unread count capped at 100 (53-11 ①); opening the list marks nothing, one read mark or '모두
 * 읽음' does (53-2), a notification already read keeps its first read, another account's id is
 * NOT_FOUND and touches nothing; every write names the account on screen (403), comes from our
 * Origin (403) and needs a session (401); a restricted account reads and marks its inbox (53-6);
 * `user:notification` reaches the member's room after a write that changed something and never
 * after one that did not (53-1). A reply notice (#135, ADR-0161; 52-15) answers its latest reply's
 * author's public face, read with the list and the read mark — the current nickname, '탈퇴한
 * 사용자', the 운영자 mark — and none for a reply hidden or deleted since; other types answer no
 * such field. And 수신 설정 (#56, ADR-0162; 52-21·52-22·56-1·56-2): `GET /me/notifications/settings`
 * and `PUT /me/notifications/settings/:category` — every category starts on and each can be turned
 * off (none locked), one category per write, idempotent; another account, a foreign Origin, no
 * session or an unknown category writes nothing; a restricted member changes its own; a write
 * publishes nothing; while off the gate makes nothing of the category and what the inbox holds
 * stays listed and counted. Skips when TEST_* are unset.
 */
import { randomUUID } from 'node:crypto';
import {
  createNotifications,
  replyNotificationInput,
  schema,
  type Db,
  type NotificationInput,
} from '@buddha/db';
import {
  TEST_NOTIFICATION,
  TEST_NOTIFICATION_DEFINITIONS,
  closeAccount,
  completeOnboarding,
  createComment,
  createMarket,
  createModerationAction,
  createPost,
  createTestNotification,
} from '@buddha/db/test';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_SETTING_CATEGORIES,
  NOTIFICATION_UNREAD_COUNT_CAP,
  errorEnvelopeSchema,
  notificationReadResultSchema,
  notificationSchema,
  notificationSettingsSchema,
  notificationUnreadCountSchema,
  userChannel,
  type Notification,
  type NotificationCategory,
  type NotificationReadResult,
  type NotificationSettings,
  type ValidationIssue,
} from '@buddha/shared';
import { and, count, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep, waitForMessages } from '../test/wait.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import {
  NotificationsService,
  assertSettingCategory,
  replyAuthorsOf,
  toNotificationSettings,
} from './notifications.service.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

const BASE = '/api/v1/me/notifications';

type Res = { statusCode: number; body: string; json: <T>() => T };

describe.skipIf(!hasTestInfra)('/api/v1/me/notifications (integration)', () => {
  let t: TestApp;
  let member: TestUser;
  let other: TestUser;
  let market: Awaited<ReturnType<typeof createMarket>>;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    member = await signUpTestUser(t);
    other = await signUpTestUser(t);
    market = await createMarket(t.db, { title: '기준금리 인하' });
  });

  const get = (url: string, who: TestUser | null = member) =>
    t.app.inject({ method: 'GET', url, headers: who ? { cookie: who.cookie } : {} });
  const post = (
    url: string,
    payload: unknown,
    who: TestUser | null = member,
    headers: Record<string, string> = {},
  ) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
        ...(who ? { cookie: who.cookie } : {}),
        ...headers,
      },
      payload: JSON.stringify(payload),
    });
  const dataOf = <T>(res: Res, status = 200): T => {
    expect(res.statusCode, res.body).toBe(status);
    return res.json<{ data: T }>().data;
  };
  const errorOf = (res: Res, status: number, code: string) => {
    expect(res.statusCode, res.body).toBe(status);
    const { error } = errorEnvelopeSchema.parse(res.json());
    expect(error.code).toBe(code);
    return error.details;
  };

  const pageOf = async (who: TestUser = member, query = '') => {
    const res = await get(`${BASE}${query}`, who);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ data: unknown[]; meta: { nextCursor: string | null } }>();
    return { items: notificationSchema.array().parse(body.data), next: body.meta.nextCursor };
  };
  const countOf = async (who: TestUser = member) =>
    notificationUnreadCountSchema.parse(dataOf(await get(`${BASE}/unread-count`, who))).unreadCount;
  const readOf = async (id: string, who: TestUser = member) =>
    notificationReadResultSchema.parse(
      dataOf<NotificationReadResult>(
        await post(`${BASE}/${id}/read`, { expectedAccountId: who.id }, who),
      ),
    );
  const readAllOf = async (who: TestUser = member) =>
    notificationUnreadCountSchema.parse(
      dataOf(await post(`${BASE}/read-all`, { expectedAccountId: who.id }, who)),
    ).unreadCount;

  /** One test notification for `who`, created; its id. */
  async function notify(
    who: TestUser,
    input: Omit<Parameters<typeof createTestNotification>[1], 'userId' | 'slug'> = {},
  ): Promise<string> {
    const outcome = await createTestNotification(t.db, {
      userId: who.id,
      slug: market.slug,
      ...input,
    });
    if (outcome.kind !== 'created' && outcome.kind !== 'merged') {
      throw new Error(`expected a notification, got ${outcome.kind}`);
    }
    return outcome.id;
  }

  /** The rows of `who`, as stored. */
  const rowsOf = (who: TestUser) =>
    t.db.select().from(schema.notifications).where(eq(schema.notifications.userId, who.id));
  const unreadRowsOf = async (who: TestUser) =>
    (
      await t.db
        .select({ id: schema.notifications.id })
        .from(schema.notifications)
        .where(and(eq(schema.notifications.userId, who.id), isNull(schema.notifications.readAt)))
    ).map((row) => row.id);

  /** Listens on `who`'s room (`user:<id>`) while `run` runs; what was published there. */
  async function heardBy<T>(
    who: TestUser,
    run: (received: string[]) => Promise<T>,
  ): Promise<{ result: T; received: unknown[] }> {
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel: string, message: string) => received.push(message));
    await subscriber.subscribe(userChannel(who.id));
    try {
      const result = await run(received);
      return { result, received: received.map((message) => JSON.parse(message) as unknown) };
    } finally {
      await subscriber.quit();
    }
  }

  // ---- the list and the count -------------------------------------------------------------

  it('answers an empty inbox and a count of 0 to a new member', async () => {
    expect(await pageOf()).toEqual({ items: [], next: null });
    expect(await countOf()).toBe(0);
  });

  it('lists the member’s notifications newest first by 발생 시각, as stored, and opening it marks nothing (53-2, 53-3)', async () => {
    const base = Date.now() - 60 * 60 * 1_000;
    const first = await notify(member, { label: '첫 알림', occurredAt: new Date(base) });
    const merged = await notify(member, {
      label: '묶인 알림 1',
      mergeKey: 'order-1',
      total: 2,
      occurredAt: new Date(base + 1_000),
    });
    const latest = await notify(member, {
      label: '마지막 알림',
      occurredAt: new Date(base + 2_000),
    });
    // A second event of the merged one (52-6, 134-2): its params folded, its count up, its 발생
    // 시각 raised to the event's — it moves to the top.
    expect(
      await notify(member, {
        label: '묶인 알림 2',
        mergeKey: 'order-1',
        total: 3,
        occurredAt: new Date(base + 3_000),
      }),
    ).toBe(merged);
    const [row] = (await rowsOf(member)).filter((stored) => stored.id === first);

    const { items, next } = await pageOf();
    expect(next).toBeNull();
    expect(items.map((item) => item.id)).toEqual([merged, latest, first]);
    expect(items[0]).toEqual({
      id: merged,
      type: 'test_merged_notice',
      category: 'trade',
      params: { label: '묶인 알림 2', total: 5 },
      target: { kind: 'market', slug: market.slug },
      eventCount: 2,
      occurredAt: new Date(base + 3_000).toISOString(),
      readAt: null,
    } satisfies Notification);
    expect(items[2]).toEqual({
      id: first,
      type: TEST_NOTIFICATION.type,
      category: 'market',
      params: { label: '첫 알림' },
      target: { kind: 'market', slug: market.slug },
      eventCount: 1,
      occurredAt: row!.occurredAt.toISOString(),
      readAt: null,
    } satisfies Notification);
    // Reading the list (twice) marked nothing.
    await pageOf();
    expect(await countOf()).toBe(3);
    expect((await unreadRowsOf(member)).sort()).toEqual([first, merged, latest].sort());
  });

  it('pages with the keyset cursor, ties in one millisecond by id, and serves the first page for a cursor that does not decode', async () => {
    const base = Date.now() - 60 * 60 * 1_000;
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(
        await notify(member, { label: `알림 ${String(i)}`, occurredAt: new Date(base + i) }),
      );
    }
    // Two at one millisecond, the newest: ordered by id among themselves.
    const tied = [
      await notify(member, { label: '같은 시각 1', occurredAt: new Date(base + 10) }),
      await notify(member, { label: '같은 시각 2', occurredAt: new Date(base + 10) }),
    ]
      .sort()
      .reverse();
    const expected = [...tied, ...ids.reverse()];

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await pageOf(member, query);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.next;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected);

    for (const bad of ['garbage', '123_not-a-uuid', `99999999999999999_${randomUUID()}`]) {
      const page = await pageOf(member, `?limit=2&cursor=${encodeURIComponent(bad)}`);
      expect({ bad, ids: page.items.map((item) => item.id) }).toEqual({
        bad,
        ids: expected.slice(0, 2),
      });
    }
    // A limit past the maximum is refused, as on every list.
    errorOf(await get(`${BASE}?limit=101`), 400, 'VALIDATION_ERROR');
  });

  it('never answers one member with another’s notifications or count', async () => {
    const mine = await notify(member, { label: '내 알림' });
    const theirs = await notify(other, { label: '남의 알림' });
    expect((await pageOf(member)).items.map((item) => item.id)).toEqual([mine]);
    expect((await pageOf(other)).items.map((item) => item.id)).toEqual([theirs]);
    expect(await countOf(member)).toBe(1);
    expect(await countOf(other)).toBe(1);
  });

  it('counts the unread up to the cap, the cap meaning that many or more (53-11 ①)', async () => {
    const total = NOTIFICATION_UNREAD_COUNT_CAP + 1;
    // One event's call for many notifications of one member: the write path in one transaction.
    const inputs: NotificationInput[] = Array.from({ length: total }, (_, i) => ({
      userId: member.id,
      type: TEST_NOTIFICATION.type,
      eventKey: `cap-${String(i)}`,
      params: { label: `알림 ${String(i)}` },
      target: { kind: 'market', slug: market.slug },
      occurredAt: new Date(Date.now() - 60_000 + i),
    }));
    const outcomes = await t.db.transaction((tx) =>
      createNotifications(tx, inputs, { definitions: TEST_NOTIFICATION_DEFINITIONS }),
    );
    expect(outcomes.filter((outcome) => outcome.kind === 'created')).toHaveLength(total);
    expect(await countOf()).toBe(NOTIFICATION_UNREAD_COUNT_CAP);
    const [newest] = (await pageOf(member, '?limit=1')).items;
    // One read leaves 100 unread: still the cap; the next one goes below it.
    expect((await readOf(newest!.id)).unreadCount).toBe(NOTIFICATION_UNREAD_COUNT_CAP);
    const [second] = (await pageOf(member, '?limit=2')).items.slice(1);
    expect((await readOf(second!.id)).unreadCount).toBe(NOTIFICATION_UNREAD_COUNT_CAP - 1);
    expect(await countOf()).toBe(NOTIFICATION_UNREAD_COUNT_CAP - 1);
  });

  // ---- read marks -------------------------------------------------------------------------

  it('marks one read once: its first read kept, the count down by one, a repeat changing nothing (53-2)', async () => {
    const older = await notify(member, { occurredAt: new Date(Date.now() - 2_000) });
    const id = await notify(member, { occurredAt: new Date(Date.now() - 1_000) });
    expect(await countOf()).toBe(2);
    const before = Date.now();
    const first = await readOf(id);
    expect(first.unreadCount).toBe(1);
    expect(first.notification).toMatchObject({ id, eventCount: 1 });
    const readAt = first.notification.readAt!;
    expect(Date.parse(readAt)).toBeGreaterThanOrEqual(before - 5_000);
    const again = await readOf(id);
    expect(again).toEqual(first);
    expect(await countOf()).toBe(1);
    expect(await unreadRowsOf(member)).toEqual([older]);
    // The list shows it read, at that first read.
    const { items } = await pageOf();
    expect(items.map((item) => [item.id, item.readAt])).toEqual([
      [id, readAt],
      [older, null],
    ]);
  });

  it('answers another account’s notification as a missing one and leaves it unread', async () => {
    const theirs = await notify(other);
    errorOf(
      await post(`${BASE}/${theirs}/read`, { expectedAccountId: member.id }),
      404,
      'NOT_FOUND',
    );
    errorOf(
      await post(`${BASE}/${randomUUID()}/read`, { expectedAccountId: member.id }),
      404,
      'NOT_FOUND',
    );
    expect(await unreadRowsOf(other)).toEqual([theirs]);
    expect(await countOf(other)).toBe(1);
  });

  it('marks every unread notification of the member read at one instant, nobody else’s (53-2 모두 읽음)', async () => {
    const read = await notify(member, { occurredAt: new Date(Date.now() - 3_000) });
    const { notification } = await readOf(read);
    await notify(member, { occurredAt: new Date(Date.now() - 2_000) });
    await notify(member, { mergeKey: 'order-1', occurredAt: new Date(Date.now() - 1_000) });
    const theirs = await notify(other);
    expect(await readAllOf()).toBe(0);
    expect(await countOf()).toBe(0);
    const rows = await rowsOf(member);
    const instants = new Set(
      rows.filter((row) => row.id !== read).map((row) => row.readAt?.toISOString()),
    );
    expect(instants.size).toBe(1);
    expect([...instants][0]).not.toBeUndefined();
    // The one read before keeps its first read.
    expect(rows.find((row) => row.id === read)!.readAt!.toISOString()).toBe(notification.readAt);
    expect(await unreadRowsOf(other)).toEqual([theirs]);
    // Nothing left to read: the same answer, nothing changed.
    expect(await readAllOf()).toBe(0);
    // A merged event after the read makes a new notification (52-6): the read one is no target.
    await notify(member, { mergeKey: 'order-1' });
    expect(await countOf()).toBe(1);
  });

  it('lets a restricted account list, count and mark its notifications (53-6)', async () => {
    const admins: TestUser[] = [];
    for (let i = 0; i < 2; i += 1) {
      const admin = await signUpTestUser(t);
      await t.db
        .update(schema.profiles)
        .set({ role: 'admin' })
        .where(eq(schema.profiles.userId, admin.id));
      await completeOnboarding(t.db, { userId: admin.id });
      await t.app.get(AdminGuard).invalidate(admin.id);
      admins.push(admin);
    }
    await completeOnboarding(t.db, { userId: member.id });
    await createModerationAction(t.db, {
      userId: member.id,
      createdBy: admins[0]!.id,
      type: 'account_restriction',
      reason: 'multi_account',
      approvedBy: admins[1]!.id,
    });
    await createModerationAction(t.db, {
      userId: member.id,
      createdBy: admins[0]!.id,
      type: 'writing_restriction',
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    });
    const one = await notify(member, { occurredAt: new Date(Date.now() - 1_000) });
    await notify(member);
    expect((await pageOf()).items).toHaveLength(2);
    expect(await countOf()).toBe(2);
    expect((await readOf(one)).unreadCount).toBe(1);
    expect(await readAllOf()).toBe(0);
  });

  // ---- who may ----------------------------------------------------------------------------

  it('answers 401 without a session and 403 for a foreign Origin, marking nothing', async () => {
    const id = await notify(member);
    for (const url of [BASE, `${BASE}/unread-count`]) {
      errorOf(await get(url, null), 401, 'UNAUTHENTICATED');
    }
    for (const url of [`${BASE}/${id}/read`, `${BASE}/read-all`]) {
      errorOf(await post(url, { expectedAccountId: member.id }, null), 401, 'UNAUTHENTICATED');
      for (const origin of ['https://evil.example', 'null']) {
        const res = await post(url, { expectedAccountId: member.id }, member, { origin });
        expect({ url, origin, status: res.statusCode }).toEqual({ url, origin, status: 403 });
        expect(errorEnvelopeSchema.parse(res.json()).error.code).toBe('FORBIDDEN');
      }
    }
    expect(await unreadRowsOf(member)).toEqual([id]);
  });

  it('refuses a body naming another account than the cookie (403 naming expectedAccountId) and a malformed body or id (400), marking nothing', async () => {
    const mine = await notify(member);
    const theirs = await notify(other);
    // A window still showing `member` after `other` signed in: the cookie is the other's.
    for (const url of [`${BASE}/${mine}/read`, `${BASE}/${theirs}/read`, `${BASE}/read-all`]) {
      const details = errorOf(
        await post(url, { expectedAccountId: member.id }, other),
        403,
        'FORBIDDEN',
      ) as ValidationIssue[];
      expect({ url, paths: details.map((issue) => issue.path) }).toEqual({
        url,
        paths: [['expectedAccountId']],
      });
    }
    for (const url of [`${BASE}/${mine}/read`, `${BASE}/read-all`]) {
      for (const payload of [{}, { expectedAccountId: '' }]) {
        const details = errorOf(await post(url, payload), 400, 'VALIDATION_ERROR');
        expect({ url, payload, paths: (details as ValidationIssue[]).map((i) => i.path) }).toEqual({
          url,
          payload,
          paths: [['expectedAccountId']],
        });
      }
    }
    errorOf(
      await post(`${BASE}/not-a-uuid/read`, { expectedAccountId: member.id }),
      400,
      'VALIDATION_ERROR',
    );
    expect(await unreadRowsOf(member)).toEqual([mine]);
    expect(await unreadRowsOf(other)).toEqual([theirs]);
  });

  // ---- the signal -------------------------------------------------------------------------

  it('publishes user:notification to the member’s room after a mark that changed something, never after one that did not (53-1)', async () => {
    const id = await notify(member, { occurredAt: new Date(Date.now() - 1_000) });
    await notify(member);
    const theirs = await notify(other);
    const { result, received } = await heardBy(member, async (messages) => {
      const read = await readOf(id);
      await waitForMessages(messages, 1, 'user:notification after a read');
      // Nothing changes: a repeat, another account's id (404), another account's '모두 읽음'.
      await readOf(id);
      errorOf(
        await post(`${BASE}/${theirs}/read`, { expectedAccountId: member.id }),
        404,
        'NOT_FOUND',
      );
      await readAllOf(other);
      expect(await readAllOf()).toBe(0);
      await waitForMessages(messages, 2, 'user:notification after 모두 읽음');
      // And '모두 읽음' with nothing left: nothing.
      await readAllOf();
      await sleep(200);
      return read;
    });
    expect(received).toEqual([
      { type: 'user:notification', ts: result.notification.readAt },
      { type: 'user:notification', ts: expect.any(String) as string },
    ]);
    const [, all] = received as { ts: string }[];
    const [row] = (await rowsOf(member)).filter((stored) => stored.id !== id);
    expect(Date.parse(all!.ts)).toBeGreaterThanOrEqual(row!.readAt!.getTime());
  });

  // ---- the reply author (#135, ADR-0161; 52-15) ----------------------------------------------

  describe('the reply author (#135, ADR-0161; 52-15)', () => {
    let replier: TestUser;
    let postRow: Awaited<ReturnType<typeof createPost>>;
    beforeEach(async () => {
      replier = await signUpTestUser(t);
      await completeOnboarding(t.db, { userId: replier.id });
      postRow = await createPost(t.db, { marketId: market.id, authorId: member.id });
    });

    /** A 댓글 of `who` on the member's post and its notice through the real write path. */
    async function replied(who: TestUser = replier) {
      const comment = await createComment(t.db, { postId: postRow.id, authorId: who.id });
      const input = replyNotificationInput(
        { id: comment.id, createdAt: comment.createdAt, authorId: who.id },
        { kind: 'post', postId: postRow.id, authorId: member.id },
      );
      await t.db.transaction((tx) => createNotifications(tx, [input!]));
      return comment;
    }
    const faceOf = async (who: TestUser) => {
      const [profile] = await t.db
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, who.id));
      return {
        kind: 'member',
        publicId: profile!.publicId,
        nickname: profile!.nickname,
        imageUrl: null,
        isAdmin: profile!.role === 'admin',
      };
    };
    const onlyItem = async () => {
      const { items } = await pageOf();
      expect(items).toHaveLength(1);
      return items[0]!;
    };

    it('answers the latest reply’s author’s public face on the list and on the read mark, never the account id', async () => {
      await replied(other);
      const comment = await replied();
      const listed = await onlyItem();
      expect(listed).toMatchObject({
        type: 'post_replied',
        eventCount: 2,
        params: { replyId: comment.id },
        replyAuthor: await faceOf(replier),
      });
      const res = await get(BASE);
      expect(res.body).not.toContain(replier.id);
      const read = await readOf(listed.id);
      expect(read.notification).toEqual({ ...listed, readAt: read.notification.readAt });
      expect(read.notification.readAt).not.toBeNull();
    });

    it('follows the author’s current face: a new nickname, the 운영자 mark, then 탈퇴한 사용자', async () => {
      await replied();
      await t.db
        .update(schema.profiles)
        .set({ nickname: 'user_zz99' })
        .where(eq(schema.profiles.userId, replier.id));
      expect((await onlyItem()).replyAuthor).toMatchObject({
        kind: 'member',
        nickname: 'user_zz99',
      });
      await t.db
        .update(schema.profiles)
        .set({ role: 'admin' })
        .where(eq(schema.profiles.userId, replier.id));
      await t.app.get(AdminGuard).invalidate(replier.id);
      expect((await onlyItem()).replyAuthor).toEqual(await faceOf(replier));
      expect((await onlyItem()).replyAuthor).toMatchObject({ isAdmin: true });
      await t.db
        .update(schema.profiles)
        .set({ role: 'user' })
        .where(eq(schema.profiles.userId, replier.id));
      await closeAccount(t.db, replier.id);
      expect((await onlyItem()).replyAuthor).toEqual({ kind: 'former_member' });
    });

    it('answers no author once the latest reply is hidden or deleted (135-4), and none for other types', async () => {
      const comment = await replied();
      await t.db
        .update(schema.postComments)
        .set({ hiddenAt: new Date() })
        .where(eq(schema.postComments.id, comment.id));
      const hidden = await onlyItem();
      expect(hidden.replyAuthor).toBeNull();
      expect(hidden.eventCount).toBe(1);
      await t.db
        .update(schema.postComments)
        .set({ hiddenAt: null, deletedAt: new Date() })
        .where(eq(schema.postComments.id, comment.id));
      expect((await onlyItem()).replyAuthor).toBeNull();
      expect((await readOf(hidden.id)).notification.replyAuthor).toBeNull();
      await notify(member);
      const { items } = await pageOf();
      const other = items.find((item) => item.type === TEST_NOTIFICATION.type)!;
      expect('replyAuthor' in other).toBe(false);
      expect('replyAuthor' in (await readOf(other.id)).notification).toBe(false);
    });

    it('reads the authors of a page in one statement, and none for a page without a reply notice', async () => {
      await replied();
      await notify(member);
      const statements: string[] = [];
      const recording: Db = drizzle({
        client: t.db.$client,
        schema,
        casing: 'snake_case',
        logger: { logQuery: (text) => statements.push(text) },
      });
      const rows = await rowsOf(member);
      const replies = rows.filter((row) => row.type === 'post_replied');
      const others = rows.filter((row) => row.type !== 'post_replied');
      expect(await replyAuthorsOf(recording, others)).toEqual(new Map());
      expect(statements).toEqual([]);
      const authors = await replyAuthorsOf(recording, [...rows, ...replies]);
      expect(statements).toHaveLength(1);
      expect([...authors.values()]).toEqual([await faceOf(replier)]);
    });
  });

  // ---- 수신 설정 (#56, ADR-0162) -------------------------------------------------------------

  describe('수신 설정 (#56, ADR-0162; 52-21·52-22·56-1·56-2)', () => {
    const SETTINGS = `${BASE}/settings`;
    const put = (
      category: string,
      payload: unknown,
      who: TestUser | null = member,
      headers: Record<string, string> = {},
    ) =>
      t.app.inject({
        method: 'PUT',
        url: `${SETTINGS}/${category}`,
        headers: {
          origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
          ...(who ? { cookie: who.cookie } : {}),
          ...headers,
        },
        payload: JSON.stringify(payload),
      });
    /** The switches of a member whose off-list is `off`, in the order the API answers them. */
    const switches = (...off: NotificationCategory[]): NotificationSettings => ({
      categories: (['trade', 'market', 'community'] as const).map((category) => ({
        category,
        enabled: !off.includes(category),
      })),
    });
    const settingsOf = async (who: TestUser = member) =>
      notificationSettingsSchema.parse(dataOf(await get(SETTINGS, who)));
    const setOf = async (category: string, enabled: boolean, who: TestUser = member) =>
      notificationSettingsSchema.parse(
        dataOf(await put(category, { enabled, expectedAccountId: who.id }, who)),
      );
    const storedOff = async (who: TestUser = member) =>
      (
        await t.db
          .select({ off: schema.notificationInboxes.categoriesOff })
          .from(schema.notificationInboxes)
          .where(eq(schema.notificationInboxes.userId, who.id))
      ).map((row) => row.off);
    const keyCount = async () =>
      (await t.db.select({ n: count() }).from(schema.notificationKeys))[0]!.n;

    it('answers every category on to a member who never saved (52-21 처음엔 켜짐), in NOTIFICATION_CATEGORIES order', async () => {
      expect(NOTIFICATION_SETTING_CATEGORIES).toEqual(['trade', 'market', 'community']);
      const res = await get(SETTINGS);
      expect(res.json()).toEqual({ data: switches() });
      expect(await storedOff()).toEqual([[]]);
    });

    it('turns one category off and on again, idempotently, rewriting no other, and keeps it for the next read', async () => {
      expect(await setOf('market', false)).toEqual(switches('market'));
      expect(await settingsOf()).toEqual(switches('market'));
      // Repeating it changes nothing (the stored list stays canonical: one entry).
      expect(await setOf('market', false)).toEqual(switches('market'));
      expect(await storedOff()).toEqual([['market']]);
      // Another category joins it; turning market on leaves trade off.
      expect(await setOf('trade', false)).toEqual(switches('trade', 'market'));
      expect(await storedOff()).toEqual([['market', 'trade']]);
      expect(await setOf('market', true)).toEqual(switches('trade'));
      expect(await setOf('market', true)).toEqual(switches('trade'));
      expect(await settingsOf()).toEqual(switches('trade'));
      // Nobody else's changed.
      expect(await settingsOf(other)).toEqual(switches());
    });

    it('lets every category be turned off — none is locked (52-21 잠그는 알림은 없다, AC 7)', async () => {
      for (const category of NOTIFICATION_SETTING_CATEGORIES) {
        const res = await put(category, { enabled: false, expectedAccountId: member.id });
        expect({ category, status: res.statusCode }).toEqual({ category, status: 200 });
      }
      expect(await settingsOf()).toEqual(switches('trade', 'market', 'community'));
      // Each entry is a category and a switch, nothing else (#56 AC 9: no channel, no price item).
      for (const entry of (await settingsOf()).categories) {
        expect(Object.keys(entry).sort()).toEqual(['category', 'enabled']);
      }
    });

    it('refuses an unknown category and a malformed body (400), writing nothing', async () => {
      for (const category of ['price', 'email', 'push', 'all', 'TRADE']) {
        const details = errorOf(
          await put(category, { enabled: false, expectedAccountId: member.id }),
          400,
          'VALIDATION_ERROR',
        ) as ValidationIssue[];
        // The path parameter is a bare enum, not an object: its one issue has an empty path.
        expect({ category, paths: details.map((issue) => issue.path) }).toEqual({
          category,
          paths: [[]],
        });
      }
      for (const payload of [
        { expectedAccountId: member.id },
        { enabled: 'false', expectedAccountId: member.id },
        { enabled: null, expectedAccountId: member.id },
      ]) {
        const details = errorOf(await put('market', payload), 400, 'VALIDATION_ERROR');
        expect({ payload, paths: (details as ValidationIssue[]).map((i) => i.path) }).toEqual({
          payload,
          paths: [['enabled']],
        });
      }
      for (const payload of [{ enabled: false }, { enabled: false, expectedAccountId: '' }]) {
        const details = errorOf(await put('market', payload), 400, 'VALIDATION_ERROR');
        expect({ payload, paths: (details as ValidationIssue[]).map((i) => i.path) }).toEqual({
          payload,
          paths: [['expectedAccountId']],
        });
      }
      expect(await storedOff()).toEqual([[]]);
    });

    it('refuses a category with no type yet (56-2) before anything is written — a planted list', () => {
      // Every category has a type today, so the route cannot reach it; the check is the
      // service's, against the list it is given.
      expect(() => {
        assertSettingCategory('community', ['trade', 'market']);
      }).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }) as Error);
      for (const category of NOTIFICATION_CATEGORIES) {
        expect(() => {
          assertSettingCategory(category);
        }).not.toThrow();
      }
      // The answer lists only the categories with a type, in their order.
      expect(toNotificationSettings(['community'], ['market', 'community'])).toEqual({
        categories: [
          { category: 'market', enabled: true },
          { category: 'community', enabled: false },
        ],
      });
    });

    it('answers 401 without a session and 403 for a foreign Origin or another account (naming expectedAccountId), writing nothing (ADR-0091)', async () => {
      errorOf(await get(SETTINGS, null), 401, 'UNAUTHENTICATED');
      errorOf(
        await put('market', { enabled: false, expectedAccountId: member.id }, null),
        401,
        'UNAUTHENTICATED',
      );
      for (const origin of ['https://evil.example', 'null']) {
        const res = await put('market', { enabled: false, expectedAccountId: member.id }, member, {
          origin,
        });
        expect({ origin, status: res.statusCode }).toEqual({ origin, status: 403 });
        expect(errorEnvelopeSchema.parse(res.json()).error.code).toBe('FORBIDDEN');
      }
      // A window still showing `member` after `other` signed in: the cookie is the other's.
      const details = errorOf(
        await put('market', { enabled: false, expectedAccountId: member.id }, other),
        403,
        'FORBIDDEN',
      ) as ValidationIssue[];
      expect(details.map((issue) => issue.path)).toEqual([['expectedAccountId']]);
      expect(await storedOff(member)).toEqual([[]]);
      expect(await storedOff(other)).toEqual([[]]);
      // The other's GET answers its own.
      await setOf('community', false, other);
      expect(await settingsOf(member)).toEqual(switches());
      expect(await settingsOf(other)).toEqual(switches('community'));
    });

    it('answers NOT_FOUND once the inbox is gone with a closure (ADR-0157 결정 5)', async () => {
      await closeAccount(t.db, member.id);
      // A request that passed SessionGuard before the closure committed finds no inbox: the db
      // function's null is NOT_FOUND, read or write, and nothing is written.
      const service = t.app.get(NotificationsService);
      await expect(service.settings(member.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(service.setCategory(member.id, 'market', false)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(await storedOff(member)).toEqual([]);
    });

    it('lets a restricted account read and change its own settings — a private setting (ADR-0157 결과 6, ADR-0069 #37-9)', async () => {
      const admins: TestUser[] = [];
      for (let i = 0; i < 2; i += 1) {
        const admin = await signUpTestUser(t);
        await t.db
          .update(schema.profiles)
          .set({ role: 'admin' })
          .where(eq(schema.profiles.userId, admin.id));
        await completeOnboarding(t.db, { userId: admin.id });
        await t.app.get(AdminGuard).invalidate(admin.id);
        admins.push(admin);
      }
      await completeOnboarding(t.db, { userId: member.id });
      await completeOnboarding(t.db, { userId: other.id });
      // `member` under an account restriction, `other` under a writing restriction.
      await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admins[0]!.id,
        type: 'account_restriction',
        reason: 'multi_account',
        approvedBy: admins[1]!.id,
      });
      await createModerationAction(t.db, {
        userId: other.id,
        createdBy: admins[0]!.id,
        type: 'writing_restriction',
        endsAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      });
      for (const who of [member, other]) {
        expect(await settingsOf(who)).toEqual(switches());
        expect(await setOf('community', false, who)).toEqual(switches('community'));
        expect(await setOf('community', true, who)).toEqual(switches());
      }
    });

    it('publishes nothing on a write — the inbox did not change — and logs no line', async () => {
      const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishUser');
      try {
        const { received } = await heardBy(member, async () => {
          await setOf('market', false);
          await setOf('market', true);
          await sleep(200);
        });
        expect(received).toEqual([]);
        expect(publish).not.toHaveBeenCalled();
      } finally {
        publish.mockRestore();
      }
    });

    it('makes nothing of an off category while it is off, keeps what the inbox holds listed and counted (56-1), and makes the next event once on again (52-22)', async () => {
      // Before: one market notice (TEST_NOTIFICATION is `market`) and one trade one (merged).
      const held = await notify(member, {
        label: '끄기 전',
        occurredAt: new Date(Date.now() - 1_000),
      });
      const merged = await notify(member, { label: '묶음', mergeKey: 'order-1', total: 1 });
      const before = await rowsOf(member);
      const keysBefore = await keyCount();
      await setOf('market', false);
      await setOf('trade', false);
      // While off: both are skipped — no row, no merge, no key.
      for (const input of [{ label: '끈 동안' }, { label: '끈 동안', mergeKey: 'order-1' }]) {
        const outcome = await createTestNotification(t.db, {
          userId: member.id,
          slug: market.slug,
          ...input,
        });
        expect(outcome).toEqual({ kind: 'skipped', userId: member.id, reason: 'category_off' });
      }
      expect(await rowsOf(member)).toEqual(before);
      expect(await keyCount()).toBe(keysBefore);
      // What it held stays: listed, counted, readable, and '모두 읽음' marks it (56-1).
      expect((await pageOf()).items.map((item) => item.id).sort()).toEqual([held, merged].sort());
      expect(await countOf()).toBe(2);
      // Another member's own settings are its own: `other` (all on) is notified.
      expect(
        (await createTestNotification(t.db, { userId: other.id, slug: market.slug })).kind,
      ).toBe('created');
      // On again: the next event of the merge group joins the still-unread row (52-6), with the
      // off-period event never counted; a new market event makes a new row.
      await setOf('trade', true);
      await setOf('market', true);
      expect(
        await createTestNotification(t.db, {
          userId: member.id,
          slug: market.slug,
          label: '다시 켠 뒤',
          mergeKey: 'order-1',
        }),
      ).toMatchObject({ kind: 'merged', id: merged });
      expect((await notify(member, { label: '다시 켠 뒤' })) === held).toBe(false);
      const [row] = (await rowsOf(member)).filter((stored) => stored.id === merged);
      expect(row).toMatchObject({ eventCount: 2, params: { label: '다시 켠 뒤', total: 2 } });
      expect(await countOf()).toBe(3);
      expect(await readAllOf()).toBe(0);
    });
  });
});
