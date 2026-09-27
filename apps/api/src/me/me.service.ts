import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { type Me, serializePAmount } from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/errors/pg-error.js';
import { DB } from '../infra/db/db.provider.js';

/** Constraint name drizzle generates for `profiles.nickname.unique()`. */
export const NICKNAME_UNIQUE_CONSTRAINT = 'profiles_nickname_unique';

@Injectable()
export class MeService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async getMe(userId: string): Promise<Me> {
    const [[row], accounts] = await Promise.all([
      this.db
        .select({
          id: schema.user.id,
          email: schema.user.email,
          emailVerified: schema.user.emailVerified,
          nickname: schema.profiles.nickname,
          role: schema.profiles.role,
          createdAt: schema.profiles.createdAt,
          availableP: schema.balances.availableP,
          lockedP: schema.balances.lockedP,
          realName: schema.userContacts.realName,
          phone: schema.userContacts.phone,
        })
        .from(schema.user)
        .innerJoin(schema.profiles, eq(schema.profiles.userId, schema.user.id))
        .innerJoin(schema.balances, eq(schema.balances.userId, schema.user.id))
        // At most one row per account (user_id is its primary key); none until the member
        // provides a name and number (ADR-0043).
        .leftJoin(schema.userContacts, eq(schema.userContacts.userId, schema.user.id))
        .where(eq(schema.user.id, userId))
        .limit(1),
      // Read-only view of better-auth's account table (PLAN 6.1: never written by us).
      // `id` is what authClient.unlinkAccount({ accountId }) expects.
      this.db
        .select({
          id: schema.account.id,
          providerId: schema.account.providerId,
          accountId: schema.account.accountId,
          createdAt: schema.account.createdAt,
        })
        .from(schema.account)
        .where(eq(schema.account.userId, userId))
        .orderBy(asc(schema.account.createdAt), asc(schema.account.id)),
    ]);
    // The "user" trigger (PLAN 10.4) guarantees both rows; missing means a broken account.
    if (!row) throw new AppError('NOT_FOUND', { message: 'Profile not found' });

    return {
      id: row.id,
      email: row.email,
      emailVerified: row.emailVerified,
      profile: {
        nickname: row.nickname,
        role: row.role,
        createdAt: row.createdAt.toISOString(),
      },
      balance: {
        availableP: serializePAmount(row.availableP),
        lockedP: serializePAmount(row.lockedP),
      },
      linkedAccounts: accounts.map((a) => ({
        id: a.id,
        providerId: a.providerId,
        accountId: a.accountId,
        createdAt: a.createdAt.toISOString(),
      })),
      contact:
        row.realName !== null && row.phone !== null
          ? { realName: row.realName, phone: row.phone }
          : null,
    };
  }

  /** PLAN 17 Q4: unlimited changes; uniqueness enforced by the DB, reported as VALIDATION_ERROR. */
  async updateNickname(userId: string, nickname: string): Promise<Me> {
    try {
      const updated = await this.db
        .update(schema.profiles)
        .set({ nickname })
        .where(eq(schema.profiles.userId, userId))
        .returning({ userId: schema.profiles.userId });
      if (updated.length === 0) throw new AppError('NOT_FOUND', { message: 'Profile not found' });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION, NICKNAME_UNIQUE_CONSTRAINT)) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Nickname already in use',
          details: [{ path: ['nickname'], message: 'already in use' }],
          cause: error,
        });
      }
      throw error;
    }
    return this.getMe(userId);
  }
}
