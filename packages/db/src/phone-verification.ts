import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { phoneVerifications } from './schema/phone-verifications.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Whether an account has completed 본인확인 (#183, ADR-0070): the one place server code asks it,
 * so the onboarding (#58), the starting Coin (#70) and the admin grant (ADR-0056 decision 1-11)
 * read the same thing. True only once a confirmation matched an SMS code — the row is written by
 * nothing else — and false for an account that does not exist. Pass the transaction handle when
 * the answer must hold until a write commits (read it after the lock that write takes).
 *
 * `lock` takes a row lock on the record as it is read, for a caller whose write must not commit
 * beside a withdrawal (#140) that deletes it: 'key share' keeps the row from being deleted (or its
 * number changed) until the transaction ends and still lets the member edit the real name. The
 * start Coin's payment (`payStartGrant`, #70) reads it so. `StartGrantService.grant` (apps/api)
 * reads the row itself, FOR SHARE, because it needs the number too — the same test of the same row.
 */
export async function isPhoneVerified(
  executor: Db | Tx,
  userId: string,
  lock?: 'key share',
): Promise<boolean> {
  const query = executor
    .select({ verified: sql<number>`1` })
    .from(phoneVerifications)
    .where(eq(phoneVerifications.userId, userId))
    .limit(1);
  const [row] = await (lock === undefined ? query : query.for(lock));
  return row !== undefined;
}
