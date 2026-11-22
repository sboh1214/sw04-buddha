import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { NOTIFICATION_UNREAD_COUNT_CAP, type NotificationDefinition } from '@buddha/shared';
import { DrizzleQueryError, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from './client.js';
import {
  createNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  NotificationInputError,
  notificationPage,
  NotificationWriteError,
  notifiedUserIds,
  unreadNotificationCount,
  type NotificationInput,
  type NotificationOutcome,
} from './notifications.js';
import {
  marketSearches,
  notificationInboxes,
  notificationKeys,
  notifications,
  user,
} from './schema/index.js';
import {
  closeAccount,
  createMarket,
  createMarketMakerAccount,
  createModerationAction,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import {
  TEST_MERGED_NOTIFICATION,
  TEST_NOTIFICATION,
  TEST_NOTIFICATION_DEFINITIONS,
  createTestNotification,
  plantNotificationInsertFailure,
} from './test/notifications.js';
import { waitForLockWaiter } from './test/wait.js';
import { TransactionBusyError, withTransactionRetry } from './transaction-retry.js';
import { clockTimestamp } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const definitions = TEST_NOTIFICATION_DEFINITIONS;

/** A test notice for `userId` about `slug`, keyed by `eventKey`. */
const notice = (
  userId: string,
  slug: string,
  eventKey: string,
  extra: Partial<NotificationInput> = {},
): NotificationInput => ({
  userId,
  type: TEST_NOTIFICATION.type,
  eventKey,
  params: { label: eventKey },
  target: { kind: 'market', slug },
  ...extra,
});

/** A mergeable test notice: `total` adds up while unread. */
const mergeable = (
  userId: string,
  slug: string,
  eventKey: string,
  mergeKey: string,
  total = 1,
  extra: Partial<NotificationInput> = {},
): NotificationInput => ({
  userId,
  type: TEST_MERGED_NOTIFICATION.type,
  eventKey,
  params: { label: eventKey, total },
  target: { kind: 'market', slug },
  mergeKey,
  ...extra,
});

/**
 * Every form a caller could keep of a thrown value — its message, its string form, its stack, its
 * JSON (a pino line, a BullMQ result) — and each of its causes, as far as they go.
 */
function keptForms(error: unknown): string[] {
  const forms: string[] = [];
  let link = error;
  for (let depth = 0; depth < 5 && link !== undefined; depth++) {
    forms.push(JSON.stringify(link) ?? '');
    if (link instanceof Error) forms.push(String(link), link.message, link.stack ?? '');
    link = typeof link === 'object' && link !== null && 'cause' in link ? link.cause : undefined;
  }
  return forms;
}

/** A gate one transaction waits at until the test opens it. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe.skipIf(!hasTestDb())('notifications (integration, #53)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
  });

  const deliver = (inputs: readonly NotificationInput[], db: Db = t.db) =>
    db.transaction((tx) => createNotifications(tx, inputs, { definitions }));
  const member = async () => (await createUser(t.db)).user.id;
  const slug = async () => (await createMarket(t.db)).slug;
  const rowsOf = (userId: string) =>
    t.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(asc(notifications.createdAt), asc(notifications.id));
  const keysOf = (userId: string) =>
    t.db
      .select()
      .from(notificationKeys)
      .where(eq(notificationKeys.userId, userId))
      .orderBy(asc(notificationKeys.eventKey));
  const rowOf = async (id: string) =>
    (await t.db.select().from(notifications).where(eq(notifications.id, id)))[0];
  const kinds = (outcomes: readonly NotificationOutcome[]) => outcomes.map((o) => o.kind);
  const idOf = (outcome: NotificationOutcome | undefined) => {
    if (outcome?.kind !== 'created' && outcome?.kind !== 'merged') {
      throw new Error(`expected a notification, got ${outcome?.kind ?? 'nothing'}`);
    }
    return outcome.id;
  };

  /** Holds a pool connection inside an open transaction, for lock tests. */
  async function holder() {
    const client = await t.db.$client.connect();
    await client.query('BEGIN');
    return {
      client,
      waitFor: (what: string, n = 1) => waitForLockWaiter(client, what, n),
      async end(how: 'COMMIT' | 'ROLLBACK' = 'ROLLBACK') {
        await client.query(how);
        client.release();
      },
    };
  }

  /** `createNotifications` in a transaction held open until `release`, telling `written`. */
  function heldDelivery(inputs: readonly NotificationInput[]) {
    const written = gate();
    const release = gate();
    let outcomes: NotificationOutcome[] = [];
    const done = t.db.transaction(async (tx) => {
      outcomes = await createNotifications(tx, inputs, { definitions });
      written.open();
      await release.opened;
    });
    return {
      written: written.opened,
      release: release.open,
      done: done.then(() => outcomes),
    };
  }

  describe('the inbox (53-5)', () => {
    it('comes with every person’s account and with no other', async () => {
      const userId = await member();
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      const marketMaker = await createMarketMakerAccount(t.db);
      const inboxes = await t.db.select().from(notificationInboxes);
      expect(inboxes.map((inbox) => inbox.userId).sort()).toEqual([userId, admin.id].sort());
      expect(inboxes.map((inbox) => inbox.userId)).not.toContain(marketMaker);
      // A closure deletes it (53-7), and its notifications and their keys with it.
      const created = await createTestNotification(t.db, { userId, slug: await slug() });
      expect(created.kind).toBe('created');
      await closeAccount(t.db, userId);
      expect(await rowsOf(userId)).toEqual([]);
      expect(await keysOf(userId)).toEqual([]);
      expect(
        await t.db.select().from(notificationInboxes).where(eq(notificationInboxes.userId, userId)),
      ).toEqual([]);
    });
  });

  describe('createNotifications', () => {
    it('creates a notification of its definition’s category, at the database clock unless the event says when', async () => {
      const userId = await member();
      const market = await slug();
      const before = await clockTimestamp(t.db);
      const [created] = await deliver([notice(userId, market, 'event-1')]);
      const after = await clockTimestamp(t.db);
      expect(created).toEqual({ kind: 'created', id: expect.any(String) as unknown, userId });
      const row = await rowOf(idOf(created));
      expect(row).toEqual({
        id: idOf(created),
        userId,
        type: 'test_notice',
        category: 'market',
        params: { label: 'event-1' },
        target: { kind: 'market', slug: market },
        mergeKey: null,
        eventCount: 1,
        occurredAt: row!.createdAt,
        createdAt: expect.any(Date) as unknown,
        readAt: null,
      });
      expect(row!.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row!.occurredAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(await keysOf(userId)).toEqual([
        { userId, type: 'test_notice', eventKey: 'event-1', notificationId: idOf(created) },
      ]);
      // An event's own time is kept as its 발생 시각.
      const at = new Date('2026-11-20T03:00:00.000Z');
      const [dated] = await deliver([notice(userId, market, 'event-2', { occurredAt: at })]);
      expect((await rowOf(idOf(dated)))!.occurredAt).toEqual(at);
      // The category is the definition's (the merged test type is a 거래 one).
      const [merged] = await deliver([mergeable(userId, market, 'event-3', 'order-1')]);
      expect(await rowOf(idOf(merged))).toMatchObject({ category: 'trade', mergeKey: 'order-1' });
    });

    it('answers in the inputs’ order, whatever order it writes them in', async () => {
      const [a, b] = [await member(), await member()].sort().reverse();
      const market = await slug();
      const outcomes = await deliver([
        notice(a!, market, 'z-event'),
        notice(b!, market, 'a-event'),
        notice(a!, market, 'a-event'),
      ]);
      expect(outcomes.map((outcome) => outcome.userId)).toEqual([a, b, a]);
      for (const [index, outcome] of outcomes.entries()) {
        expect((await rowOf(idOf(outcome)))!.params, String(index)).toEqual({
          label: ['z-event', 'a-event', 'a-event'][index],
        });
      }
      expect(notifiedUserIds(outcomes)).toEqual([a, b]);
      expect(await deliver([])).toEqual([]);
    });

    it('refuses a producer bug before it writes anything, and the event rolls back with it (53-4)', async () => {
      const userId = await member();
      const market = await slug();
      const good = notice(userId, market, 'good');
      const bugs: [string, NotificationInput][] = [
        ['unknown type', { ...good, type: 'no_such_type' }],
        ['bad event key', { ...good, eventKey: 'has space' }],
        ['bad event key', { ...good, eventKey: '' }],
        ['a merge key on a type that does not merge', { ...good, mergeKey: 'order-1' }],
        [
          'no merge key on a type that merges',
          { ...mergeable(userId, market, 'm', 'k'), mergeKey: undefined },
        ],
        ['bad merge key', mergeable(userId, market, 'm', 'bad key')],
        ['params its definition refuses', { ...good, params: { label: 3 } }],
        ['params its definition refuses', { ...good, params: { other: 'x' } }],
        ['params its definition refuses', { ...good, params: { label: 'x'.repeat(201) } }],
        [
          'a target it does not lead to',
          { ...good, target: { kind: 'order', id: randomUUID() } as never },
        ],
        ['a target it does not lead to', { ...good, target: { kind: 'market', slug: 'A B' } }],
      ];
      for (const [message, bug] of bugs) {
        const attempt = t.db.transaction(async (tx) => {
          // The event's own write, before its notifications: it goes too.
          await tx.insert(marketSearches).values({ userId, query: '사건의 쓰기' });
          return createNotifications(tx, [good, bug], { definitions });
        });
        await expect(attempt, message).rejects.toSatisfy(
          (error) => error instanceof NotificationInputError && error.message.includes(message),
        );
      }
      expect(await rowsOf(userId)).toEqual([]);
      expect(await keysOf(userId)).toEqual([]);
      expect(await t.db.select().from(marketSearches)).toEqual([]);
    });

    it('holds the product list by default: no test type ships in it (52-20)', async () => {
      const userId = await member();
      const market = await slug();
      await expect(
        t.db.transaction((tx) => createNotifications(tx, [notice(userId, market, 'e')])),
      ).rejects.toSatisfy(
        (error) =>
          error instanceof NotificationInputError && error.message.includes('unknown type'),
      );
    });

    it('skips a duplicate silently: the same type and event reach a member once (53-4)', async () => {
      const userId = await member();
      const market = await slug();
      const [first] = await deliver([notice(userId, market, 'fill-1')]);
      // Reprocessed: answered, not refused — the event goes on.
      expect(
        await deliver([notice(userId, market, 'fill-1', { params: { label: 'again' } })]),
      ).toEqual([{ kind: 'duplicate', userId }]);
      // Twice in one call: the second is the duplicate.
      const twice = await deliver([
        notice(userId, market, 'fill-2'),
        notice(userId, market, 'fill-2'),
      ]);
      expect(twice.map((outcome) => outcome.kind)).toEqual(['created', 'duplicate']);
      expect(notifiedUserIds(twice)).toEqual([userId]);
      expect((await rowsOf(userId)).map((row) => row.params)).toEqual([
        { label: 'fill-1' },
        { label: 'fill-2' },
      ]);
      expect((await keysOf(userId)).map((key) => [key.eventKey, key.notificationId])).toEqual([
        ['fill-1', idOf(first)],
        ['fill-2', idOf(twice[0])],
      ]);
      // Another type of the same event is its own notification; so is another member's.
      const other = await member();
      const more = await deliver([
        mergeable(userId, market, 'fill-1', 'order-1'),
        notice(other, market, 'fill-1'),
      ]);
      expect(more.map((outcome) => outcome.kind)).toEqual(['created', 'created']);
      expect(await rowsOf(userId)).toHaveLength(3);
      expect(await rowsOf(other)).toHaveLength(1);
    });

    it('makes one notification of the same event delivered twice at once (동시에 와도 한 건만)', async () => {
      const userId = await member();
      const market = await slug();
      const first = heldDelivery([notice(userId, market, 'race')]);
      await first.written;
      const second = deliver([notice(userId, market, 'race')]);
      const lock = await holder();
      try {
        await lock.waitFor('the second delivery waits on the key');
      } finally {
        await lock.end();
      }
      first.release();
      expect(await first.done).toEqual([
        { kind: 'created', id: expect.any(String) as unknown, userId },
      ]);
      expect(await second).toEqual([{ kind: 'duplicate', userId }]);
      expect(await rowsOf(userId)).toHaveLength(1);
      expect(await keysOf(userId)).toHaveLength(1);
    });

    it('delivers again when the first delivery rolled back', async () => {
      const userId = await member();
      const market = await slug();
      const written = gate();
      const release = gate();
      const first = t.db.transaction(async (tx) => {
        await createNotifications(tx, [notice(userId, market, 'retry')], { definitions });
        written.open();
        await release.opened;
        tx.rollback();
      });
      await written.opened;
      const second = deliver([notice(userId, market, 'retry')]);
      const lock = await holder();
      try {
        await lock.waitFor('the second delivery waits on the key');
      } finally {
        await lock.end();
      }
      release.open();
      await expect(first).rejects.toThrow();
      expect((await second)[0]!.kind).toBe('created');
      expect(await rowsOf(userId)).toHaveLength(1);
    });
  });

  describe('the recipients (53-5, 53-6)', () => {
    it('skips the 운영 마켓메이커, a closed account and no account, and delivers to the rest', async () => {
      const open = await member();
      const closed = await member();
      await closeAccount(t.db, closed);
      const marketMaker = await createMarketMakerAccount(t.db);
      const market = await slug();
      const outcomes = await deliver([
        notice(marketMaker, market, 'e'),
        notice(open, market, 'e'),
        notice(closed, market, 'e'),
        notice('no-such-account', market, 'e'),
      ]);
      expect(outcomes).toEqual([
        { kind: 'skipped', userId: marketMaker, reason: 'no_inbox' },
        { kind: 'created', id: expect.any(String) as unknown, userId: open },
        { kind: 'skipped', userId: closed, reason: 'no_inbox' },
        { kind: 'skipped', userId: 'no-such-account', reason: 'no_inbox' },
      ]);
      expect(notifiedUserIds(outcomes)).toEqual([open]);
      expect((await t.db.select().from(notifications)).map((row) => row.userId)).toEqual([open]);
    });

    it('delivers to a restricted account like any other (53-6)', async () => {
      const userId = await member();
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      const { user: approver } = await createUser(t.db, { role: 'admin' });
      await createModerationAction(t.db, {
        userId,
        createdBy: admin.id,
        type: 'account_restriction',
        reason: ACCOUNT_RESTRICTION_REASON,
        approvedBy: approver.id,
      });
      expect((await deliver([notice(userId, await slug(), 'e')]))[0]!.kind).toBe('created');
    });

    it('skips an account whose closure holds its inbox, without waiting for it', async () => {
      const userId = await member();
      const market = await slug();
      const closure = await holder();
      try {
        await closure.client.query(
          'SELECT 1 FROM notification_inboxes WHERE user_id = $1 FOR UPDATE',
          [userId],
        );
        const started = Date.now();
        expect(await deliver([notice(userId, market, 'e')])).toEqual([
          { kind: 'skipped', userId, reason: 'no_inbox' },
        ]);
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        await closure.end();
      }
      expect(await rowsOf(userId)).toEqual([]);
    });

    it('makes a closure that starts after it wait for its commit, and the closure then deletes what it wrote', async () => {
      const userId = await member();
      const market = await slug();
      const writer = heldDelivery([notice(userId, market, 'e')]);
      await writer.written;
      let closedAt: Date | undefined;
      const closing = closeAccount(t.db, userId).then((at) => (closedAt = at));
      const lock = await holder();
      try {
        await lock.waitFor('the closure waits on the inbox');
      } finally {
        await lock.end();
      }
      expect(closedAt).toBeUndefined();
      writer.release();
      expect((await writer.done)[0]!.kind).toBe('created');
      await closing;
      expect(await rowsOf(userId)).toEqual([]);
      expect(await keysOf(userId)).toEqual([]);
      // And a delivery after it skips the closed account.
      expect((await deliver([notice(userId, market, 'later')]))[0]!.kind).toBe('skipped');
    });
  });

  describe('merging (52-6, 52-7, 134-2)', () => {
    it('merges an event into the unread notification of its merge key: params folded, count up, time raised, never lowered', async () => {
      const userId = await member();
      const market = await slug();
      const t0 = new Date('2026-11-21T01:00:00.000Z');
      const [created] = await deliver([
        mergeable(userId, market, 'fill-1', 'order-1', 2, { occurredAt: t0 }),
      ]);
      const id = idOf(created);
      const createdRow = (await rowOf(id))!;
      const t1 = new Date('2026-11-21T02:00:00.000Z');
      const [merged] = await deliver([
        mergeable(userId, market, 'fill-2', 'order-1', 3, { occurredAt: t1 }),
      ]);
      expect(merged).toEqual({ kind: 'merged', id, userId, paramsReset: false });
      expect(await rowOf(id)).toEqual({
        ...createdRow,
        params: { label: 'fill-2', total: 5 },
        eventCount: 2,
        occurredAt: t1,
      });
      // An event of an earlier time joins without moving the row back.
      const [late] = await deliver([
        mergeable(userId, market, 'fill-0', 'order-1', 1, { occurredAt: t0 }),
      ]);
      expect(late).toEqual({ kind: 'merged', id, userId, paramsReset: false });
      expect(await rowOf(id)).toMatchObject({
        eventCount: 3,
        occurredAt: t1,
        params: { total: 6 },
      });
      // The same event again is a duplicate: nothing changes.
      expect(await deliver([mergeable(userId, market, 'fill-2', 'order-1', 100)])).toEqual([
        { kind: 'duplicate', userId },
      ]);
      expect(await rowOf(id)).toMatchObject({ eventCount: 3, params: { total: 6 } });
      expect((await keysOf(userId)).map((key) => [key.eventKey, key.notificationId])).toEqual([
        ['fill-0', id],
        ['fill-1', id],
        ['fill-2', id],
      ]);
      // Another merge key is another notification; two events of one key in one call merge.
      const both = await deliver([
        mergeable(userId, market, 'fill-4', 'order-2'),
        mergeable(userId, market, 'fill-5', 'order-2'),
      ]);
      expect(both.map((outcome) => outcome.kind)).toEqual(['created', 'merged']);
      expect(await rowOf(idOf(both[0]))).toMatchObject({ eventCount: 2, params: { total: 2 } });
    });

    it('never fails the event on held params it cannot fold: the event’s own replace them, the count and the time still move', async () => {
      const userId = await member();
      const market = await slug();
      const t0 = new Date('2026-11-21T01:00:00.000Z');
      const [created] = await deliver([
        mergeable(userId, market, 'fill-1', 'order-1', 2, { occurredAt: t0 }),
      ]);
      const id = idOf(created);
      // What an earlier version of the type stored: no `total`, which the type now requires.
      await t.db
        .update(notifications)
        .set({ params: { label: 'fill-1' } })
        .where(eq(notifications.id, id));
      const held = (await rowOf(id))!;
      const t1 = new Date('2026-11-21T02:00:00.000Z');
      const outcomes = await t.db.transaction(async (tx) => {
        // The event's own write, before its notifications: it commits with them.
        await tx.insert(marketSearches).values({ userId, query: '사건의 쓰기' });
        return createNotifications(
          tx,
          [mergeable(userId, market, 'fill-2', 'order-1', 3, { occurredAt: t1 })],
          { definitions },
        );
      });
      expect(outcomes).toEqual([{ kind: 'merged', id, userId, paramsReset: true }]);
      expect(await t.db.select({ query: marketSearches.query }).from(marketSearches)).toEqual([
        { query: '사건의 쓰기' },
      ]);
      expect(await rowOf(id)).toEqual({
        ...held,
        params: { label: 'fill-2', total: 3 },
        eventCount: 2,
        occurredAt: t1,
      });
      expect((await keysOf(userId)).map((key) => [key.eventKey, key.notificationId])).toEqual([
        ['fill-1', id],
        ['fill-2', id],
      ]);
      // The row fits again: the next event folds as any other does.
      const [next] = await deliver([
        mergeable(userId, market, 'fill-3', 'order-1', 4, { occurredAt: t0 }),
      ]);
      expect(next).toEqual({ kind: 'merged', id, userId, paramsReset: false });
      expect(await rowOf(id)).toMatchObject({
        params: { label: 'fill-3', total: 7 },
        eventCount: 3,
        occurredAt: t1,
      });
      // A merge that throws on what the row holds, or folds it to params its schema refuses: the
      // same safety net.
      const refusing: NonNullable<typeof TEST_MERGED_NOTIFICATION.merge>[] = [
        () => {
          throw new Error('an older shape');
        },
        (_, incoming) => ({ label: incoming.label, total: 0.5 }),
      ];
      for (const [round, merge] of refusing.entries()) {
        const eventKey = `refused-${String(round)}`;
        const t2 = new Date(Date.parse('2026-11-21T03:00:00.000Z') + round * 60_000);
        const refused = await t.db.transaction((tx) =>
          createNotifications(
            tx,
            [mergeable(userId, market, eventKey, 'order-1', 10, { occurredAt: t2 })],
            { definitions: [TEST_NOTIFICATION, { ...TEST_MERGED_NOTIFICATION, merge }] },
          ),
        );
        expect(refused, eventKey).toEqual([{ kind: 'merged', id, userId, paramsReset: true }]);
        expect(await rowOf(id), eventKey).toMatchObject({
          params: { label: eventKey, total: 10 },
          eventCount: 4 + round,
          occurredAt: t2,
        });
      }
    });

    it('never merges into a read notification: the next event makes a new one', async () => {
      const userId = await member();
      const market = await slug();
      const [first] = await deliver([mergeable(userId, market, 'fill-1', 'order-1')]);
      await deliver([mergeable(userId, market, 'fill-2', 'order-1')]);
      await t.db.transaction((tx) => markNotificationRead(tx, userId, idOf(first)));
      const readRow = (await rowOf(idOf(first)))!;
      const [next] = await deliver([mergeable(userId, market, 'fill-3', 'order-1')]);
      expect(next!.kind).toBe('created');
      expect(idOf(next)).not.toBe(idOf(first));
      expect(await rowOf(idOf(first))).toEqual(readRow);
      expect(await rowOf(idOf(next))).toMatchObject({ eventCount: 1, readAt: null });
      // An event the read one already holds, reprocessed, is still a duplicate — and leaves no
      // new row behind.
      await t.db.transaction((tx) => markNotificationRead(tx, userId, idOf(next)));
      expect(await deliver([mergeable(userId, market, 'fill-2', 'order-1')])).toEqual([
        { kind: 'duplicate', userId },
      ]);
      expect(await rowsOf(userId)).toHaveLength(2);
    });

    it('makes one notification of two first events of one merge key at once', async () => {
      const userId = await member();
      const market = await slug();
      const first = heldDelivery([mergeable(userId, market, 'fill-1', 'order-1', 1)]);
      await first.written;
      const second = deliver([mergeable(userId, market, 'fill-2', 'order-1', 2)]);
      const lock = await holder();
      try {
        await lock.waitFor('the second insert waits on the merge target');
      } finally {
        await lock.end();
      }
      first.release();
      const [created] = await first.done;
      expect(created!.kind).toBe('created');
      expect(await second).toEqual([
        { kind: 'merged', id: idOf(created), userId, paramsReset: false },
      ]);
      expect(await rowsOf(userId)).toEqual([
        expect.objectContaining({
          id: idOf(created),
          eventCount: 2,
          params: { label: 'fill-2', total: 3 },
        }),
      ]);
    });

    it('gives up after three rounds of races on one row (a bug: the event rolls back)', async () => {
      // Every read finds no unread row and every insert finds one: what three read/insert races
      // on one row in a row would look like.
      const userId = randomUUID();
      const statements: string[] = [];
      const answer = (what: string, rows: unknown) => {
        statements.push(what);
        return rows;
      };
      let selects = 0;
      const tx = {
        execute: () =>
          Promise.resolve({ rows: [{ ms: String(Date.parse('2026-11-21T00:00:00.000Z')) }] }),
        select: () =>
          chain(() =>
            selects++ === 0 ? answer('gate', [{ userId }]) : answer('read merge target', []),
          ),
        insert: (table: unknown) =>
          chain(() => answer(table === notifications ? 'insert notification' : 'insert key', [])),
        update: () => chain(() => answer('update', [])),
        delete: () => chain(() => answer('delete', [])),
      } as unknown as Tx;
      const error = await createNotifications(
        tx,
        [mergeable(userId, 'market-slug', 'fill-1', 'order-1')],
        { definitions },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotificationWriteError);
      expect((error as Error).message).toMatch(/no merge after 3 rounds/);
      // Not the account either (#54, ADR-0159).
      expect(keptForms(error).some((form) => form.includes(userId))).toBe(false);
      expect(statements).toEqual([
        'gate',
        'read merge target',
        'insert notification',
        'read merge target',
        'insert notification',
        'read merge target',
        'insert notification',
      ]);
    });
  });

  describe('the inputs that do not merge, in one statement (#54, ADR-0159)', () => {
    /** Spies on the transaction's statements while `createNotifications` runs in it. */
    async function counted(inputs: readonly NotificationInput[]) {
      return t.db.transaction(async (tx) => {
        const spies = {
          select: vi.spyOn(tx, 'select'),
          execute: vi.spyOn(tx, 'execute'),
          insert: vi.spyOn(tx, 'insert'),
          delete: vi.spyOn(tx, 'delete'),
          update: vi.spyOn(tx, 'update'),
        };
        try {
          const outcomes = await createNotifications(tx, inputs, { definitions });
          const calls = Object.fromEntries(
            Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length]),
          );
          return { outcomes, calls };
        } finally {
          for (const spy of Object.values(spies)) spy.mockRestore();
        }
      });
    }

    it('delivers every recipient with a gate, a clock and one statement, whatever their number', async () => {
      const market = await slug();
      const members = [];
      for (let i = 0; i < 30; i++) members.push(await member());
      const closed = await member();
      await closeAccount(t.db, closed);
      const marketMaker = await createMarketMakerAccount(t.db);
      const at = new Date('2026-11-22T00:00:00.000Z');
      const inputs = [...members, closed, marketMaker].map((userId) =>
        notice(userId, market, 'market_event:1', { occurredAt: at }),
      );
      const { outcomes, calls } = await counted(inputs);
      expect(calls).toEqual({ select: 1, execute: 2, insert: 0, delete: 0, update: 0 });
      expect(outcomes.map((o) => [o.userId, o.kind])).toEqual([
        ...members.map((userId) => [userId, 'created']),
        [closed, 'skipped'],
        [marketMaker, 'skipped'],
      ]);
      // Each its own row and key, at the event's instant, as the one-by-one path wrote them.
      for (const [index, userId] of members.entries()) {
        const rows = await rowsOf(userId);
        expect(rows, userId).toEqual([
          expect.objectContaining({
            id: idOf(outcomes[index]),
            type: 'test_notice',
            category: 'market',
            params: { label: 'market_event:1' },
            target: { kind: 'market', slug: market },
            mergeKey: null,
            eventCount: 1,
            occurredAt: at,
            readAt: null,
          }),
        ]);
        expect(await keysOf(userId)).toEqual([
          {
            userId,
            type: 'test_notice',
            eventKey: 'market_event:1',
            notificationId: idOf(outcomes[index]),
          },
        ]);
      }
      // One creation instant for the call, the database's.
      const created = new Set(
        (await t.db.select({ at: notifications.createdAt }).from(notifications)).map((row) =>
          row.at.getTime(),
        ),
      );
      expect(created.size).toBe(1);
      expect(notifiedUserIds(outcomes)).toEqual(members);
    });

    it('answers a reprocessed event and a twin in the call as duplicates, with one DELETE of their rows', async () => {
      const market = await slug();
      const [a, b, c] = [await member(), await member(), await member()];
      const [first] = await deliver([notice(a, market, 'event-1')]);
      const { outcomes, calls } = await counted([
        notice(b, market, 'event-1'),
        notice(a, market, 'event-1', { params: { label: 'again' } }),
        notice(c, market, 'event-1'),
        notice(c, market, 'event-1', { params: { label: 'twin' } }),
        notice(a, market, 'event-2'),
      ]);
      expect(calls).toEqual({ select: 1, execute: 2, insert: 0, delete: 1, update: 0 });
      expect(outcomes.map((o) => [o.userId, o.kind])).toEqual([
        [b, 'created'],
        [a, 'duplicate'],
        [c, 'created'],
        [c, 'duplicate'],
        [a, 'created'],
      ]);
      // The duplicates' rows are gone; each key names the row that stayed.
      expect((await rowsOf(a)).map((row) => [row.id, row.params])).toEqual([
        [idOf(first), { label: 'event-1' }],
        [idOf(outcomes[4]), { label: 'event-2' }],
      ]);
      expect((await rowsOf(c)).map((row) => row.params)).toEqual([{ label: 'event-1' }]);
      expect((await keysOf(c)).map((key) => key.notificationId)).toEqual([idOf(outcomes[2])]);
      expect(await t.db.select().from(notifications)).toHaveLength(4);
      // All of a call duplicates: nothing more, still one DELETE.
      const again = await counted([notice(b, market, 'event-1'), notice(c, market, 'event-1')]);
      expect(kinds(again.outcomes)).toEqual(['duplicate', 'duplicate']);
      expect(again.calls.delete).toBe(1);
      expect(await t.db.select().from(notifications)).toHaveLength(4);
    });

    it('delivers the merging inputs after the others, and answers in the inputs’ order', async () => {
      const market = await slug();
      const [a, b] = [await member(), await member()];
      const closed = await member();
      await closeAccount(t.db, closed);
      const outcomes = await deliver([
        mergeable(a, market, 'fill-1', 'order-1', 2),
        notice(b, market, 'event-1'),
        mergeable(a, market, 'fill-2', 'order-1', 3),
        notice(a, market, 'event-1'),
        notice(closed, market, 'event-1'),
        mergeable(closed, market, 'fill-3', 'order-2'),
      ]);
      expect(kinds(outcomes)).toEqual([
        'created',
        'created',
        'merged',
        'created',
        'skipped',
        'skipped',
      ]);
      expect(idOf(outcomes[2])).toBe(idOf(outcomes[0]));
      expect(await rowOf(idOf(outcomes[0]))).toMatchObject({
        eventCount: 2,
        params: { label: 'fill-2', total: 5 },
      });
      expect((await rowsOf(a)).map((row) => row.type).sort()).toEqual([
        'test_merged_notice',
        'test_notice',
      ]);
    });

    it('leaves nothing when the event rolls back after it', async () => {
      const market = await slug();
      const members = [await member(), await member(), await member()];
      await expect(
        t.db.transaction(async (tx) => {
          await createNotifications(
            tx,
            members.map((userId) => notice(userId, market, 'event-1')),
            { definitions },
          );
          throw new Error('the event failed after its notices');
        }),
      ).rejects.toThrow('the event failed after its notices');
      expect(await t.db.select().from(notifications)).toEqual([]);
      expect(await t.db.select().from(notificationKeys)).toEqual([]);
      // And the same event delivers afterwards.
      const outcomes = await deliver(members.map((userId) => notice(userId, market, 'event-1')));
      expect(kinds(outcomes)).toEqual(['created', 'created', 'created']);
    });

    it('waits on the keys a concurrent delivery of the same event holds, and makes the rest', async () => {
      const market = await slug();
      const [a, b, c] = [await member(), await member(), await member()];
      const first = heldDelivery([notice(a, market, 'race'), notice(b, market, 'race')]);
      await first.written;
      const second = deliver([
        notice(a, market, 'race'),
        notice(b, market, 'race'),
        notice(c, market, 'race'),
      ]);
      const lock = await holder();
      try {
        await lock.waitFor('the second delivery waits on the first’s keys');
      } finally {
        await lock.end();
      }
      first.release();
      expect(kinds(await first.done)).toEqual(['created', 'created']);
      expect(kinds(await second)).toEqual(['duplicate', 'duplicate', 'created']);
      for (const userId of [a, b, c]) expect(await rowsOf(userId)).toHaveLength(1);
    });

    // ADR-0159 §5 asked what one event costs with thousands of recipients under the producer's
    // locks; the number goes into the ADR. Off by default (PERF=1 runs it).
    it.skipIf(process.env.PERF !== '1')(
      'times one event delivered to 10,000 members',
      async () => {
        const market = await slug();
        const ids = Array.from({ length: 10_000 }, () => randomUUID());
        // The sign-up trigger gives each account its profile, ledger account and inbox.
        for (let from = 0; from < ids.length; from += 1_000) {
          await t.db.insert(user).values(
            ids.slice(from, from + 1_000).map((id) => ({
              id,
              name: `perf ${id.slice(0, 8)}`,
              email: `perf-${id}@test.local`,
              emailVerified: true,
            })),
          );
        }
        const inputs = ids.map((userId) => notice(userId, market, 'market_event:1'));
        const started = performance.now();
        const outcomes = await deliver(inputs);
        const ms = performance.now() - started;
        expect(outcomes.every((outcome) => outcome.kind === 'created')).toBe(true);
        const again = performance.now();
        expect((await deliver(inputs)).every((outcome) => outcome.kind === 'duplicate')).toBe(true);
        const duplicateMs = performance.now() - again;
        console.info(
          `[perf] one event, 10,000 recipients: ${ms.toFixed(0)} ms created, ` +
            `${duplicateMs.toFixed(0)} ms all duplicate`,
        );
      },
      120_000,
    );
  });

  describe('a failed statement names no recipient (#54, ADR-0159)', () => {
    /** True when one of `ids` is in one of the forms a caller could keep of `error`. */
    const names = (error: unknown, ids: readonly string[]) =>
      keptForms(error).some((form) => ids.some((id) => form.includes(id)));

    it.each([
      { path: 'the one statement of the inputs that do not merge', merging: false },
      { path: 'a merge', merging: true },
    ])(
      'throws a refusal Postgres raised by its SQLSTATE and reason alone ($path)',
      async ({ merging }) => {
        const market = await slug();
        const members = [await member(), await member(), await member()];
        const inputs = members.map((userId, i) =>
          merging
            ? mergeable(userId, market, `fill-${String(i)}`, `order-${String(i)}`)
            : notice(userId, market, 'market_event:1'),
        );
        // Its message, DETAIL and HINT name the row's account.
        const planted = await plantNotificationInsertFailure();
        try {
          // The control: drizzle's own error of a statement binding an account names it.
          const raw = await t.db
            .insert(notifications)
            .values({
              userId: members[0]!,
              type: TEST_NOTIFICATION.type,
              category: 'market',
              params: {},
              target: { kind: 'market', slug: market },
              occurredAt: new Date(),
            })
            .catch((error: unknown) => error);
          expect(raw).toBeInstanceOf(DrizzleQueryError);
          expect(names(raw, members)).toBe(true);

          const error = await deliver(inputs).catch((e: unknown) => e);
          expect(error).toBeInstanceOf(NotificationWriteError);
          expect(error).toMatchObject({
            name: 'NotificationWriteError',
            code: 'P0001',
            message: 'notification write failed: planted failure for <recipient>',
          });
          // No cause: neither drizzle's wrapper (the bound values) nor the driver's (DETAIL, HINT).
          expect(error).not.toHaveProperty('cause');
          expect(names(error, members)).toBe(false);
        } finally {
          await planted.remove();
        }
        expect(await t.db.select().from(notifications)).toEqual([]);
        expect(await t.db.select().from(notificationKeys)).toEqual([]);
      },
    );

    it('throws a gate that could not lock the inboxes by its SQLSTATE alone, still a retry', async () => {
      // The gate binds every recipient in one array; it never waits on a row (SKIP LOCKED), but a
      // table lock stops it, and a lock_timeout then refuses it — 55P03, a retryable failure.
      const market = await slug();
      const members = [await member(), await member()];
      const inputs = members.map((userId) => notice(userId, market, 'market_event:1'));
      const timed = (tx: Tx) =>
        tx
          .execute(sql`SET LOCAL lock_timeout = '100ms'`)
          .then(() => createNotifications(tx, inputs, { definitions }));
      const lock = await holder();
      try {
        await lock.client.query('LOCK TABLE notification_inboxes IN EXCLUSIVE MODE');
        const error = await t.db.transaction(timed).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NotificationWriteError);
        expect(error).toMatchObject({
          code: '55P03',
          message: 'notification write failed: canceling statement due to lock timeout',
        });
        expect(error).not.toHaveProperty('cause');
        expect(names(error, members)).toBe(false);
        // withTransactionRetry reads the kept SQLSTATE: it retries, then gives up busy.
        await expect(withTransactionRetry(t.db, timed, { attempts: 2 })).rejects.toBeInstanceOf(
          TransactionBusyError,
        );
      } finally {
        await lock.end();
      }
      expect(kinds(await deliver(inputs))).toEqual(['created', 'created']);
    });

    it.each(['40001', '40P01'])(
      'keeps a %s refusal a retry for withTransactionRetry, and nothing else',
      async (code) => {
        const market = await slug();
        const userId = await member();
        let attempts = 0;
        const run = (tx: Tx) => {
          attempts++;
          return createNotifications(tx, [notice(userId, market, 'market_event:1')], {
            definitions,
          });
        };
        const planted = await plantNotificationInsertFailure(code);
        try {
          await expect(withTransactionRetry(t.db, run, { attempts: 3 })).rejects.toBeInstanceOf(
            TransactionBusyError,
          );
          expect(attempts).toBe(3);
        } finally {
          await planted.remove();
        }
        // A refusal that is no retry is thrown as it is, at once.
        const other = await plantNotificationInsertFailure('P0001');
        attempts = 0;
        try {
          const error = await withTransactionRetry(t.db, run, { attempts: 3 }).catch(
            (e: unknown) => e,
          );
          expect(error).toMatchObject({ name: 'NotificationWriteError', code: 'P0001' });
          expect(attempts).toBe(1);
        } finally {
          await other.remove();
        }
      },
    );
  });

  describe('reading', () => {
    it('marks one read once: the first read time is kept, and another account’s id is a missing one (53-2)', async () => {
      const userId = await member();
      const other = await member();
      const market = await slug();
      const [created] = await deliver([notice(userId, market, 'e')]);
      const id = idOf(created);
      const first = await t.db.transaction((tx) => markNotificationRead(tx, userId, id));
      expect(first).toEqual({ row: expect.objectContaining({ id }) as unknown, changed: true });
      expect(first!.row.readAt).toBeInstanceOf(Date);
      const again = await t.db.transaction((tx) => markNotificationRead(tx, userId, id));
      expect(again).toEqual({ row: first!.row, changed: false });
      // Another account's id answers as a missing one, and the row is not touched.
      const [mine] = await deliver([notice(other, market, 'e')]);
      expect(
        await t.db.transaction((tx) => markNotificationRead(tx, userId, idOf(mine))),
      ).toBeNull();
      expect(
        await t.db.transaction((tx) => markNotificationRead(tx, userId, randomUUID())),
      ).toBeNull();
      expect((await rowOf(idOf(mine)))!.readAt).toBeNull();
    });

    it('marks all of one member’s unread read at one instant, and nobody else’s (53-2)', async () => {
      const userId = await member();
      const other = await member();
      const market = await slug();
      const outcomes = await deliver([
        notice(userId, market, 'a'),
        notice(userId, market, 'b'),
        notice(userId, market, 'c'),
        notice(other, market, 'a'),
      ]);
      const [readFirst] = outcomes;
      const earlier = await t.db.transaction((tx) =>
        markNotificationRead(tx, userId, idOf(readFirst)),
      );
      expect(await t.db.transaction((tx) => markAllNotificationsRead(tx, userId))).toEqual({
        changed: 2,
      });
      const rows = await rowsOf(userId);
      expect(rows.every((row) => row.readAt !== null)).toBe(true);
      expect(rows.find((row) => row.id === idOf(readFirst))!.readAt).toEqual(earlier!.row.readAt);
      const others = rows.filter((row) => row.id !== idOf(readFirst)).map((row) => row.readAt);
      expect(new Set(others.map((at) => at!.getTime())).size).toBe(1);
      expect(await unreadNotificationCount(t.db, userId)).toBe(0);
      expect(await unreadNotificationCount(t.db, other)).toBe(1);
      expect(await t.db.transaction((tx) => markAllNotificationsRead(tx, userId))).toEqual({
        changed: 0,
      });
    });

    it('counts the unread up to the cap (53-11 ①)', async () => {
      const userId = await member();
      const market = await slug();
      expect(await unreadNotificationCount(t.db, userId)).toBe(0);
      const many = Array.from({ length: NOTIFICATION_UNREAD_COUNT_CAP + 5 }, (_, index) =>
        notice(userId, market, `event-${String(index)}`),
      );
      const outcomes = await deliver(many);
      expect(await unreadNotificationCount(t.db, userId)).toBe(NOTIFICATION_UNREAD_COUNT_CAP);
      for (const outcome of outcomes.slice(0, 10)) {
        await t.db.transaction((tx) => markNotificationRead(tx, userId, idOf(outcome)));
      }
      expect(await unreadNotificationCount(t.db, userId)).toBe(NOTIFICATION_UNREAD_COUNT_CAP - 5);
    });

    it('pages newest first by 발생 시각, ties at one millisecond kept apart by id, a merged one moved to the top (53-3)', async () => {
      const userId = await member();
      const other = await member();
      const market = await slug();
      const at = new Date('2026-11-21T00:00:00.000Z');
      const later = new Date(at.getTime() + 60_000);
      const tied = await deliver(
        ['a', 'b', 'c', 'd'].map((key) => notice(userId, market, key, { occurredAt: at })),
      );
      const [merging] = await deliver([
        mergeable(userId, market, 'fill-1', 'order-1', 1, {
          occurredAt: new Date(at.getTime() - 1),
        }),
      ]);
      const [newest] = await deliver([notice(userId, market, 'newest', { occurredAt: later })]);
      await deliver([notice(other, market, 'theirs', { occurredAt: later })]);
      const readAll = async () => {
        const ids: string[] = [];
        let after: { at: Date; id: string } | null = null;
        for (let pages = 0; pages < 10; pages++) {
          const page = await notificationPage(t.db, userId, { after, limit: 2 });
          ids.push(...page.items.map((item) => item.id));
          if (page.next === null) return ids;
          after = page.next;
        }
        throw new Error('too many pages');
      };
      const tiedIds = tied.map(idOf).sort().reverse();
      expect(await readAll()).toEqual([idOf(newest), ...tiedIds, idOf(merging)]);
      // A merge raises its time past the newest: the row moves to the top.
      await deliver([
        mergeable(userId, market, 'fill-2', 'order-1', 1, {
          occurredAt: new Date(later.getTime() + 1),
        }),
      ]);
      expect(await readAll()).toEqual([idOf(merging), idOf(newest), ...tiedIds]);
      // The last page says so; an empty inbox is one empty page.
      expect(await notificationPage(t.db, userId, { after: null, limit: 10 })).toMatchObject({
        next: null,
      });
      const empty = await member();
      expect(await notificationPage(t.db, empty, { after: null, limit: 10 })).toEqual({
        items: [],
        next: null,
      });
    });
  });

  describe('reading while a merge runs', () => {
    it('waits for a merge in flight: the merged row is what 모두 읽음 reads', async () => {
      const userId = await member();
      const market = await slug();
      const [created] = await deliver([mergeable(userId, market, 'fill-1', 'order-1')]);
      const merge = heldDelivery([mergeable(userId, market, 'fill-2', 'order-1')]);
      await merge.written;
      const reading = t.db.transaction((tx) => markAllNotificationsRead(tx, userId));
      const lock = await holder();
      try {
        await lock.waitFor('모두 읽음 waits on the merge');
      } finally {
        await lock.end();
      }
      merge.release();
      expect(await merge.done).toEqual([
        { kind: 'merged', id: idOf(created), userId, paramsReset: false },
      ]);
      expect(await reading).toEqual({ changed: 1 });
      expect(await rowsOf(userId)).toEqual([
        expect.objectContaining({ eventCount: 2, readAt: expect.any(Date) as unknown }),
      ]);
      expect(await unreadNotificationCount(t.db, userId)).toBe(0);
    });

    it('makes a new notification of a merge that waited on 모두 읽음: none lost, none counted twice', async () => {
      const userId = await member();
      const market = await slug();
      const [created] = await deliver([mergeable(userId, market, 'fill-1', 'order-1')]);
      const written = gate();
      const release = gate();
      const reading = t.db.transaction(async (tx) => {
        const done = await markAllNotificationsRead(tx, userId);
        written.open();
        await release.opened;
        return done;
      });
      await written.opened;
      const merging = deliver([mergeable(userId, market, 'fill-2', 'order-1')]);
      const lock = await holder();
      try {
        await lock.waitFor('the merge waits on 모두 읽음');
      } finally {
        await lock.end();
      }
      release.open();
      expect(await reading).toEqual({ changed: 1 });
      const [next] = await merging;
      expect(next!.kind).toBe('created');
      const rows = await rowsOf(userId);
      expect(rows.map((row) => [row.id, row.eventCount, row.readAt === null])).toEqual([
        [idOf(created), 1, false],
        [idOf(next), 1, true],
      ]);
      expect(await unreadNotificationCount(t.db, userId)).toBe(1);
    });
  });
});

/** The restriction reason an account restriction takes (ACCOUNT_RESTRICTION_REASONS). */
const ACCOUNT_RESTRICTION_REASON = 'spam' as const;

/**
 * A stand-in for a drizzle query chain: any method returns the chain, and awaiting it answers
 * `result()` — enough of a transaction to drive `createNotifications` through a fixed script.
 */
function chain(result: () => unknown): unknown {
  const target = function () {
    return undefined;
  };
  const proxy: unknown = new Proxy(target, {
    get(_, property) {
      if (property === 'then') {
        return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve().then(result).then(resolve, reject);
      }
      return () => proxy;
    },
  });
  return proxy;
}

describe('notifiedUserIds', () => {
  it('names each account something reached, once, in the order reached', () => {
    expect(
      notifiedUserIds([
        { kind: 'created', id: '1', userId: 'b' },
        { kind: 'duplicate', userId: 'c' },
        { kind: 'skipped', userId: 'd', reason: 'no_inbox' },
        { kind: 'merged', id: '2', userId: 'a', paramsReset: false },
        { kind: 'created', id: '3', userId: 'b' },
      ]),
    ).toEqual(['b', 'a']);
    expect(notifiedUserIds([])).toEqual([]);
  });
});

/**
 * The test types never reach production (#53, ADR-0157): no source under `apps/<app>/src` or
 * `packages/<package>/src` outside the tests passes `createNotifications` a definitions list of its
 * own (a third argument), names TEST_NOTIFICATION* or `createTestNotification`, or imports the test
 * helpers (`@buddha/db/test`, a `/test/notifications` module). Reads files only.
 */
describe('the test notification types stay in the tests (static)', () => {
  const ROOT = new URL('../../../', import.meta.url);

  /** The top-level arguments of each `createNotifications(` call in `source`. */
  function callArguments(source: string): number[] {
    const counts: number[] = [];
    const pattern = /\bcreateNotifications\s*\(/g;
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      // Its declaration is not a call.
      if (/\bfunction\s*$/.test(source.slice(0, match.index))) continue;
      let depth = 0;
      let args = 0;
      let sawToken = false;
      let quote: string | null = null;
      for (let i = match.index + match[0].length; i < source.length; i++) {
        const char = source[i]!;
        if (quote !== null) {
          if (char === '\\') i++;
          else if (char === quote) quote = null;
          continue;
        }
        if (char === "'" || char === '"' || char === '`') {
          quote = char;
          sawToken = true;
        } else if ('([{'.includes(char)) {
          depth++;
          sawToken = true;
        } else if (')]}'.includes(char)) {
          if (depth === 0) break;
          depth--;
        } else if (char === ',' && depth === 0) {
          if (sawToken) args++;
          sawToken = false;
        } else if (!/\s/.test(char)) sawToken = true;
      }
      counts.push(args + (sawToken ? 1 : 0));
    }
    return counts;
  }

  /** The production sources: no test, spec, test helper, build output or dependency. */
  function productionSources(): { path: string; source: string }[] {
    const files: { path: string; source: string }[] = [];
    for (const group of ['apps', 'packages']) {
      for (const name of readdirSync(new URL(`${group}/`, ROOT))) {
        const src = new URL(`${group}/${name}/src/`, ROOT);
        let entries: string[];
        try {
          entries = readdirSync(src, { recursive: true }) as string[];
        } catch {
          continue;
        }
        for (const entry of entries) {
          const path = `${group}/${name}/src/${entry}`;
          if (!/\.(?:ts|tsx|mts|js|mjs)$/.test(entry)) continue;
          if (/(?:^|\/)(?:test|tests|__tests__|e2e|node_modules)\//.test(entry)) continue;
          if (/\.(?:test|spec)\.[a-z]+$/.test(entry)) continue;
          files.push({ path, source: readFileSync(new URL(path, ROOT), 'utf8') });
        }
      }
    }
    return files;
  }

  /** A test type (TEST_NOTIFICATION*), or the test helper that delivers one, named. */
  const TEST_NAME = /\b(?:TEST_(?:MERGED_)?NOTIFICATION\w*|createTestNotification)\b/;
  /** An import of the test helpers: `@buddha/db/test`, or a `/test/notifications` module. */
  const TEST_IMPORT =
    /['"](?:@buddha\/db\/test(?:\/[^'"]*)?|[^'"\n]*\/test\/notifications(?:\.[cm]?[jt]s)?)['"]/;

  /** What the guard finds in one production source: a line per way it reaches the test types. */
  function hitsOf(path: string, source: string): string[] {
    return [
      ...callArguments(source)
        .filter((count) => count > 2)
        .map(() => `${path}: createNotifications with definitions of its own`),
      ...(TEST_NAME.test(source) ? [`${path}: names a test type or helper`] : []),
      ...(TEST_IMPORT.test(source) ? [`${path}: imports the test helpers`] : []),
    ];
  }

  it('reads the arguments of a call the way the guard needs', () => {
    expect(callArguments('createNotifications(tx, inputs)')).toEqual([2]);
    expect(callArguments('await createNotifications(tx, [a, b], { definitions })')).toEqual([3]);
    expect(callArguments("createNotifications(\n  tx,\n  [{ a: 'x,y', b: f(1, 2) }],\n)")).toEqual([
      2,
    ]);
    expect(
      callArguments('createNotifications(tx, inputs, opts) + createNotifications(t, i)'),
    ).toEqual([3, 2]);
    expect(
      callArguments('export async function createNotifications(\n  tx: Tx,\n  a: A,\n  b: B,\n)'),
    ).toEqual([]);
  });

  it('catches each way a production source could reach the test types (positive control)', () => {
    const at = 'apps/api/src/demo.ts';
    const own = `${at}: createNotifications with definitions of its own`;
    const named = `${at}: names a test type or helper`;
    const imported = `${at}: imports the test helpers`;
    expect(hitsOf(at, 'await createNotifications(tx, inputs, { definitions });')).toEqual([own]);
    expect(
      hitsOf(
        at,
        "import { createTestNotification } from '@buddha/db/test';\n" +
          'await createTestNotification(db, { userId, slug });',
      ),
    ).toEqual([named, imported]);
    expect(hitsOf(at, 'const types = TEST_NOTIFICATION_DEFINITIONS;')).toEqual([named]);
    expect(
      hitsOf(at, "import { TEST_MERGED_NOTIFICATION } from './test/notifications.js';"),
    ).toEqual([named, imported]);
    expect(hitsOf(at, "const helpers = await import('../test/notifications');")).toEqual([
      imported,
    ]);
    expect(hitsOf(at, 'import * as helpers from "@buddha/db/test";')).toEqual([imported]);
    // What production does write passes: the write path, its two arguments, its own module.
    expect(
      hitsOf(
        at,
        "import { createNotifications } from '@buddha/db';\n" +
          "import { notifiedUserIds } from './notifications.js';\n" +
          'await createNotifications(tx, inputs);',
      ),
    ).toEqual([]);
  });

  it('finds the write path where it is defined and the test types where they live', () => {
    const sources = productionSources();
    expect(sources.map((file) => file.path)).toContain('packages/db/src/notifications.ts');
    expect(sources.map((file) => file.path)).not.toContain('packages/db/src/test/notifications.ts');
    // The guard is not blind: the test helper does pass a list of its own.
    const helper = readFileSync(new URL('packages/db/src/test/notifications.ts', ROOT), 'utf8');
    expect(callArguments(helper)).toEqual([3]);
  });

  it('passes no definitions of its own and names no test type in production code', () => {
    expect(productionSources().flatMap(({ path, source }) => hitsOf(path, source))).toEqual([]);
  });

  it('keeps the test types out of the product list', () => {
    const types = TEST_NOTIFICATION_DEFINITIONS.map(
      (definition: NotificationDefinition) => definition.type,
    );
    expect(types).toEqual(['test_notice', 'test_merged_notice']);
  });
});
