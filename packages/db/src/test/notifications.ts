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
import * as z from 'zod';
import type { Db } from '../client.js';
import { createNotifications, type NotificationOutcome } from '../notifications.js';

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
