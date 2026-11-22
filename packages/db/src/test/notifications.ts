/**
 * Test-only notification types (#53, ADR-0157). #53 shipped no type of the product (52-20); #134
 * ships the 거래 three (ADR-0158). A test-only type must never ship in NOTIFICATION_DEFINITIONS, so
 * the tests — the packages' suites, the API's and the e2e fixture worker's — deliver theirs through
 * the real write path with `{ definitions: TEST_NOTIFICATION_DEFINITIONS }`, which no production
 * source may pass (notifications.test.ts's static guard). No vitest import here: the e2e fixture
 * worker imports `@buddha/db/test`.
 */
import { randomUUID } from 'node:crypto';
import { defineNotification } from '@buddha/shared';
import { Client } from 'pg';
import * as z from 'zod';
import type { Db } from '../client.js';
import { createNotifications, type NotificationOutcome } from '../notifications.js';
import { testDbUrls } from './harness.js';

/** A notice about one market: a label the tests read back, no merge. */
export const TEST_NOTIFICATION = defineNotification({
  type: 'test_notice',
  category: 'market',
  targets: ['market'],
  params: z.object({ label: z.string().max(200) }),
  merge: null,
});

/** A mergeable one (52-6's shape): each event adds its `total`; the newest label is kept. */
export const TEST_MERGED_NOTIFICATION = defineNotification({
  type: 'test_merged_notice',
  category: 'trade',
  targets: ['market'],
  params: z.object({ label: z.string().max(200), total: z.number().int() }),
  merge: (held, next) => ({ label: next.label, total: held.total + next.total }),
});

export const TEST_NOTIFICATION_DEFINITIONS = [TEST_NOTIFICATION, TEST_MERGED_NOTIFICATION] as const;

export interface CreateTestNotificationInput {
  userId: string;
  /** The target market's slug. */
  slug: string;
  /** The event's key; a fresh one when absent. */
  eventKey?: string;
  label?: string;
  occurredAt?: Date;
  /** A merge key makes it a TEST_MERGED_NOTIFICATION, of `total` (1 when absent). */
  mergeKey?: string;
  total?: number;
}

/**
 * One test notification for `userId` through the real write path, in a transaction of its own (a
 * savepoint when `executor` is one already): what `createNotifications` answered for it.
 */
export async function createTestNotification(
  executor: Db,
  input: CreateTestNotificationInput,
): Promise<NotificationOutcome> {
  const merged = input.mergeKey !== undefined;
  const outcomes = await executor.transaction((tx) =>
    createNotifications(
      tx,
      [
        {
          userId: input.userId,
          type: merged ? TEST_MERGED_NOTIFICATION.type : TEST_NOTIFICATION.type,
          eventKey: input.eventKey ?? randomUUID(),
          params: merged
            ? { label: input.label ?? 'test', total: input.total ?? 1 }
            : { label: input.label ?? 'test' },
          target: { kind: 'market', slug: input.slug },
          mergeKey: input.mergeKey,
          occurredAt: input.occurredAt,
        },
      ],
      { definitions: TEST_NOTIFICATION_DEFINITIONS },
    ),
  );
  return outcomes[0]!;
}

/** The trigger (and its function) `plantNotificationInsertFailure` adds. */
const PLANTED_FAILURE = 'notifications_test_failure';

/**
 * Makes Postgres itself refuse every row inserted into `notifications`, with SQLSTATE `code`,
 * until `remove()`: a BEFORE INSERT trigger whose RAISE names the row's account in its message,
 * DETAIL and HINT — a refusal that quotes a key. DDL, so on a migrate-role connection; `reset()`
 * truncates and keeps triggers, so call `remove()` in a `finally`.
 */
export async function plantNotificationInsertFailure(
  code = 'P0001',
): Promise<{ remove(): Promise<void> }> {
  if (!/^[0-9A-Z]{5}$/.test(code)) throw new Error(`not a SQLSTATE: ${code}`);
  const urls = testDbUrls();
  if (!urls) throw new Error('plantNotificationInsertFailure needs the test database');
  const client = new Client({ connectionString: urls.migrateUrl });
  await client.connect();
  const remove = async () => {
    try {
      await client.query(`DROP TRIGGER IF EXISTS ${PLANTED_FAILURE} ON notifications`);
      await client.query(`DROP FUNCTION IF EXISTS ${PLANTED_FAILURE}()`);
    } finally {
      await client.end();
    }
  };
  try {
    await client.query(`CREATE FUNCTION ${PLANTED_FAILURE}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'planted failure for %', NEW.user_id
          USING ERRCODE = '${code}', DETAIL = 'account ' || NEW.user_id, HINT = NEW.user_id;
      END $$`);
    await client.query(`CREATE TRIGGER ${PLANTED_FAILURE} BEFORE INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION ${PLANTED_FAILURE}()`);
  } catch (error) {
    await remove();
    throw error;
  }
  return { remove };
}
