import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Whether the 가입 허용 목록 (#330, ADR-0174) refuses a number: the list holds a row (330-3: it
 * applies exactly while it is not empty) and none of them is `phoneHash`, the keyed hash of the
 * number's digits (ADR-0071). One statement, so an empty list and a listed number read the same
 * snapshot. The 본인확인 confirmation asks it after the code matched and the number was found free
 * (330-5); docs/OPERATIONS.md's number change (#57-3, 330-7) asks the same predicate in SQL
 * (phone-change.ts).
 */
export async function signupAllowlistRefuses(
  executor: Db | Tx,
  phoneHash: string,
): Promise<boolean> {
  const { rows } = await executor.execute<{ refused: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM signup_allowlist)
      AND NOT EXISTS (SELECT 1 FROM signup_allowlist WHERE phone_hash = ${phoneHash}) AS refused`);
  return rows[0]?.refused === true;
}

/**
 * Serialises every write of the list — an add, a remove, a clear's request and its approval — so
 * each counts what the one before it left (I2): two removals of the last two entries cannot both
 * read two and empty the list between them. The two-key form keeps it apart from every single-key
 * advisory lock (markets, admin roles); taken after the admin-roles lock wherever both are.
 */
export async function lockSignupAllowlist(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('buddha:signup-allowlist'), 0)`);
}
