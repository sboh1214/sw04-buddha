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
 * after one that did not (53-1). Skips when TEST_* are unset.
 */
import { randomUUID } from 'node:crypto';
import { createNotifications, schema, type NotificationInput } from '@buddha/db';
import {
  TEST_NOTIFICATION,
  TEST_NOTIFICATION_DEFINITIONS,
  completeOnboarding,
  createMarket,
  createModerationAction,
  createTestNotification,
} from '@buddha/db/test';
import {
  NOTIFICATION_UNREAD_COUNT_CAP,
  errorEnvelopeSchema,
  notificationReadResultSchema,
  notificationSchema,
  notificationUnreadCountSchema,
  userChannel,
  type Notification,
  type NotificationReadResult,
  type ValidationIssue,
} from '@buddha/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep, waitForMessages } from '../test/wait.js';

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
});
