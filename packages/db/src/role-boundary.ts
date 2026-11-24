import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { adminActions, markets } from './schema/index.js';
import { clockTimestamp, lockAdminRoles } from './tx-helpers.js';
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Db | Tx;

/*
 * The admin role's time boundaries (#143, ADR-0120): every `admin_grant`/`admin_revoke` record is
 * strictly later than the last role change of any account (and a revoke than every market's
 * creation), and a new market strictly after the last role change. Whether an account WAS admin
 * at a past instant — the observation metrics' "활동한 때 관리자" (#96, ADR-0169) — is read from
 * these records in admin-role-spans.ts (`adminSpansCte`, `wasAdminAtSql`); the strictly
 * increasing times are what make its per-account spans free of ties.
 */

export async function latestAdminRevocation(reader: Reader, userId: string): Promise<Date | null> {
  const [row] = await reader
    .select({ at: adminActions.createdAt })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.type, 'admin_revoke'),
        eq(adminActions.targetType, 'user'),
        eq(adminActions.targetId, userId),
      ),
    )
    .orderBy(desc(adminActions.createdAt), desc(adminActions.id))
    .limit(1);
  return row?.at ?? null;
}
async function lastRoleChange(reader: Reader): Promise<Date | null> {
  const [row] = await reader
    .select({ at: adminActions.createdAt })
    .from(adminActions)
    .where(sql`${adminActions.type} IN ('admin_grant','admin_revoke')`)
    .orderBy(desc(adminActions.createdAt), desc(adminActions.id))
    .limit(1);
  return row?.at ?? null;
}

/** Shared with every create path. Keep the role lock until INSERT/event/audit commit. */
export async function marketCreationTimestamp(tx: Tx, clock?: Date): Promise<Date> {
  await lockAdminRoles(tx, 'shared');
  const now = clock ?? (await clockTimestamp(tx));
  const last = await lastRoleChange(tx);
  return new Date(Math.max(now.getTime(), last === null ? -Infinity : last.getTime() + 1));
}

/** Caller owns roles exclusive; revoke is strictly after every existing market creation too. */
export async function adminRoleChangeTimestamp(
  tx: Tx,
  type: 'admin_grant' | 'admin_revoke',
  clock?: Date,
): Promise<Date> {
  const now = clock ?? (await clockTimestamp(tx));
  const last = await lastRoleChange(tx);
  const [market] =
    type === 'admin_revoke'
      ? await tx
          .select({ at: markets.createdAt })
          .from(markets)
          .orderBy(desc(markets.createdAt))
          .limit(1)
      : [];
  return new Date(
    Math.max(
      now.getTime(),
      last === null ? -Infinity : last.getTime() + 1,
      market ? market.at.getTime() + 1 : -Infinity,
    ),
  );
}
