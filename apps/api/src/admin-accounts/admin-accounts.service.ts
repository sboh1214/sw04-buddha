import { Inject, Injectable, Logger } from '@nestjs/common';
import { lockAdminRoles, schema, type Db } from '@buddha/db';
import {
  adminRoleChangePayloadSchema,
  decodeKeyset,
  encodeKeyset,
  MIN_ADMINS,
  type AdminAccount,
  type AdminRoleChange,
  type AdminRoleChangeRefusal,
  type AdminRoleChangeType,
  type Role,
} from '@buddha/shared';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AdminGuard } from '../auth/admin.guard.js';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { type Page } from '../wallet/wallet.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** admin_actions.target_type of a role change: the account. */
const TARGET_TYPE = 'user';

/**
 * Both role-change types, written as the literal predicate of the partial index
 * `admin_actions_role_change_created_at_id_idx` (migration 0021) so the planner can prove the
 * history query is inside it.
 */
const IS_ROLE_CHANGE: SQL = sql`${schema.adminActions.type} IN ('admin_grant', 'admin_revoke')`;

const actorProfile = alias(schema.profiles, 'actor_profile');
const targetProfile = alias(schema.profiles, 'target_profile');

/** Why a grant or revoke is refused; the web picks its copy by `details[0].message`. */
export function roleChangeNotAllowed(reason: AdminRoleChangeRefusal): AppError {
  const messages: Record<AdminRoleChangeRefusal, string> = {
    already_admin: 'The account is an admin already',
    email_not_verified: 'Only an account with a verified email can become an admin',
    contact_required:
      'Only an account with a real name and mobile number on file can become an admin',
    not_admin: 'The account is not an admin',
    min_admins: `A revoke may not leave fewer than ${String(MIN_ADMINS)} admins`,
  };
  return new AppError('ROLE_CHANGE_NOT_ALLOWED', {
    message: messages[reason],
    details: [{ path: ['userId'], message: reason }],
  });
}

/**
 * Admin accounts (#171): who holds the admin role, granting and revoking it, and the record of
 * both. The only writer of `profiles.role` outside the seed's bootstrap and the test fixtures.
 *
 * A grant or revoke runs under the exclusive admin-roles lock (`lockAdminRoles`), checks that the
 * actor is STILL an admin — AdminGuard read a cached role before the lock, and another admin may
 * have revoked this one meanwhile — and writes its `admin_grant` / `admin_revoke` row in the same
 * transaction as the role. A revoke also deletes every session of the account (better-auth reads
 * sessions from Postgres on each request, with no cookie cache), so it is signed out everywhere;
 * after the commit the role cache gets the new role, so the change applies from the next request
 * (owner decision 2026-10-13).
 */
@Injectable()
export class AdminAccountsService {
  private readonly logger = new Logger(AdminAccountsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly guard: AdminGuard,
  ) {}

  /** Every account that holds the admin role, oldest account first, with its latest grant. */
  async list(): Promise<AdminAccount[]> {
    const admins = await this.db
      .select({
        id: schema.user.id,
        email: schema.user.email,
        nickname: schema.profiles.nickname,
      })
      .from(schema.profiles)
      .innerJoin(schema.user, eq(schema.user.id, schema.profiles.userId))
      .where(eq(schema.profiles.role, 'admin'))
      .orderBy(asc(schema.profiles.createdAt), asc(schema.profiles.userId));
    if (admins.length === 0) return [];

    const grants = await this.db
      .selectDistinctOn([schema.adminActions.targetId], {
        targetId: schema.adminActions.targetId,
        createdAt: schema.adminActions.createdAt,
        actorId: schema.adminActions.adminId,
        actorNickname: actorProfile.nickname,
      })
      .from(schema.adminActions)
      .innerJoin(actorProfile, eq(actorProfile.userId, schema.adminActions.adminId))
      .where(
        and(
          eq(schema.adminActions.type, 'admin_grant'),
          eq(schema.adminActions.targetType, TARGET_TYPE),
          inArray(
            schema.adminActions.targetId,
            admins.map((admin) => admin.id),
          ),
        ),
      )
      .orderBy(
        schema.adminActions.targetId,
        desc(schema.adminActions.createdAt),
        desc(schema.adminActions.id),
      );
    const grantOf = new Map(grants.map((grant) => [grant.targetId, grant]));

    return admins.map((admin) => {
      const grant = grantOf.get(admin.id);
      return {
        ...admin,
        grantedAt: grant?.createdAt.toISOString() ?? null,
        grantedBy: grant ? { id: grant.actorId, nickname: grant.actorNickname } : null,
      };
    });
  }

  /**
   * Makes `userId` an admin: refused (ROLE_CHANGE_NOT_ALLOWED) for an admin, an unverified email
   * or an account with no real name and mobile number on file (ADR-0043; owner decision
   * 2026-10-13). No other admin's approval: the two-person rule does not cover role changes.
   */
  async grant(actorId: string, userId: string, reason: string): Promise<AdminRoleChange> {
    const recordId = await this.db.transaction(async (tx) => {
      await lockAdminRoles(tx, 'exclusive');
      await this.assertAdmin(tx, actorId);
      const [target] = await tx
        .select({
          role: schema.profiles.role,
          emailVerified: schema.user.emailVerified,
          contact: schema.userContacts.userId,
        })
        .from(schema.user)
        .innerJoin(schema.profiles, eq(schema.profiles.userId, schema.user.id))
        .leftJoin(schema.userContacts, eq(schema.userContacts.userId, schema.user.id))
        .where(eq(schema.user.id, userId))
        .limit(1);
      if (!target) throw new AppError('NOT_FOUND', { message: 'User not found' });
      if (target.role === 'admin') throw roleChangeNotAllowed('already_admin');
      if (!target.emailVerified) throw roleChangeNotAllowed('email_not_verified');
      if (target.contact === null) throw roleChangeNotAllowed('contact_required');
      return this.writeRole(tx, actorId, userId, 'admin_grant', reason);
    });
    await this.cacheRole(userId, 'admin');
    return this.change(recordId);
  }

  /**
   * Takes the admin role from `userId` — the actor's own included — unless fewer than MIN_ADMINS
   * admins would remain (ROLE_CHANGE_NOT_ALLOWED `min_admins`), and deletes every session of the
   * account in the same transaction. A self-revoke answers before the actor's cookie stops
   * working: its session is gone once this commits.
   */
  async revoke(actorId: string, userId: string, reason: string): Promise<AdminRoleChange> {
    const recordId = await this.db.transaction(async (tx) => {
      await lockAdminRoles(tx, 'exclusive');
      await this.assertAdmin(tx, actorId);
      const [target] = await tx
        .select({ role: schema.profiles.role })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, userId))
        .limit(1);
      if (!target) throw new AppError('NOT_FOUND', { message: 'User not found' });
      if (target.role !== 'admin') throw roleChangeNotAllowed('not_admin');
      // Every role change holds the lock, so this count cannot move before the commit.
      const [admins] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.profiles)
        .where(eq(schema.profiles.role, 'admin'));
      if ((admins?.count ?? 0) - 1 < MIN_ADMINS) throw roleChangeNotAllowed('min_admins');
      const id = await this.writeRole(tx, actorId, userId, 'admin_revoke', reason);
      await tx.delete(schema.session).where(eq(schema.session.userId, userId));
      return id;
    });
    await this.cacheRole(userId, 'user');
    return this.change(recordId);
  }

  /**
   * Grants and revokes, newest first (keyset over admin_actions' `(created_at, id)`), of one
   * account when `userId` is given. An account deleted since keeps its records, with no email or
   * nickname.
   */
  async listChanges(
    userId: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<AdminRoleChange>> {
    const keyset = decodeKeyset(cursor, 'uuid');
    const rows = await this.changes(
      and(
        userId === undefined
          ? undefined
          : and(
              eq(schema.adminActions.targetType, TARGET_TYPE),
              eq(schema.adminActions.targetId, userId),
            ),
        keyset
          ? keysetPredicate(schema.adminActions.createdAt, schema.adminActions.id, keyset, 'uuid')
          : undefined,
      ),
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept,
      nextCursor:
        hasMore && last ? encodeKeyset({ createdAt: new Date(last.createdAt), id: last.id }) : null,
    };
  }

  /** FORBIDDEN unless `actorId` holds the admin role now, as the lock holder reads it. */
  private async assertAdmin(tx: Tx, actorId: string): Promise<void> {
    const [actor] = await tx
      .select({ role: schema.profiles.role })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, actorId))
      .limit(1);
    if (actor?.role !== 'admin') throw new AppError('FORBIDDEN', { message: 'Admin only' });
  }

  /** The record and the role, at one instant read after the lock. Returns the record's id. */
  private async writeRole(
    tx: Tx,
    actorId: string,
    userId: string,
    type: AdminRoleChangeType,
    reason: string,
  ): Promise<string> {
    const at = await clockTimestamp(tx);
    const [record] = await tx
      .insert(schema.adminActions)
      .values({
        adminId: actorId,
        type,
        targetType: TARGET_TYPE,
        targetId: userId,
        payload: { reason },
        createdAt: at,
      })
      .returning({ id: schema.adminActions.id });
    if (!record) throw new AppError('INTERNAL', { message: 'Admin action insert failed' });
    await tx
      .update(schema.profiles)
      .set({ role: type === 'admin_grant' ? 'admin' : 'user', updatedAt: at })
      .where(eq(schema.profiles.userId, userId));
    return record.id;
  }

  /**
   * The committed role into the cache (AdminGuard.cacheRole). A failure is logged, not thrown:
   * the change is committed, a revoke's sessions are gone already, and the guard falls back to
   * Postgres while Redis does not answer.
   */
  private async cacheRole(userId: string, role: Role): Promise<void> {
    try {
      await this.guard.cacheRole(userId, role);
    } catch (error) {
      this.logger.warn(`role cache write after a ${role} change failed: ${String(error)}`);
    }
  }

  private async change(recordId: string): Promise<AdminRoleChange> {
    const [change] = await this.changes(eq(schema.adminActions.id, recordId), 1);
    if (!change) throw new AppError('INTERNAL', { message: 'Admin action not found' });
    return change;
  }

  private async changes(where: SQL | undefined, limit: number): Promise<AdminRoleChange[]> {
    const rows = await this.db
      .select({
        id: schema.adminActions.id,
        type: schema.adminActions.type,
        actorId: schema.adminActions.adminId,
        actorNickname: actorProfile.nickname,
        targetId: schema.adminActions.targetId,
        targetEmail: schema.user.email,
        targetNickname: targetProfile.nickname,
        payload: schema.adminActions.payload,
        createdAt: schema.adminActions.createdAt,
      })
      .from(schema.adminActions)
      .innerJoin(actorProfile, eq(actorProfile.userId, schema.adminActions.adminId))
      .leftJoin(schema.user, eq(schema.user.id, schema.adminActions.targetId))
      .leftJoin(targetProfile, eq(targetProfile.userId, schema.adminActions.targetId))
      .where(and(IS_ROLE_CHANGE, where))
      .orderBy(desc(schema.adminActions.createdAt), desc(schema.adminActions.id))
      .limit(limit);
    return rows.map((row) => {
      const payload = adminRoleChangePayloadSchema.safeParse(row.payload);
      if (!payload.success || row.targetId === null) {
        throw new AppError('INTERNAL', {
          message: `admin_actions ${row.id} is not a role change`,
          cause: payload.error,
        });
      }
      return {
        id: row.id,
        type: row.type as AdminRoleChangeType,
        target: { id: row.targetId, email: row.targetEmail, nickname: row.targetNickname },
        actor: { id: row.actorId, nickname: row.actorNickname },
        reason: payload.data.reason,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }
}
