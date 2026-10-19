import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { type Me, serializeCoinAmount } from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/errors/pg-error.js';
import { DB } from '../infra/db/db.provider.js';
import { toStartGrant } from '../start-grant/start-grant.service.js';

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
          timeZone: schema.profiles.timeZone,
          availableCoin: schema.balances.availableCoin,
          lockedCoin: schema.balances.lockedCoin,
          realName: schema.phoneVerifications.realName,
          phone: schema.phoneVerifications.phone,
          verifiedAt: schema.phoneVerifications.verifiedAt,
          startGrantId: schema.startGrants.id,
          startGrantAmountCoin: schema.startGrants.amountCoin,
          startGrantedAt: schema.startGrants.grantedAt,
          startGrantCancelledAt: schema.startGrants.cancelledAt,
        })
        .from(schema.user)
        .innerJoin(schema.profiles, eq(schema.profiles.userId, schema.user.id))
        .innerJoin(schema.balances, eq(schema.balances.userId, schema.user.id))
        // At most one row per account (user_id is its primary key); none until the account
        // confirms an SMS code (ADR-0070).
        .leftJoin(schema.phoneVerifications, eq(schema.phoneVerifications.userId, schema.user.id))
        // At most one row per account (user_id is UNIQUE); none until the account is granted or
        // waits for its start Coin (#70, ADR-0071). A cancelled one reads as none (toStartGrant).
        .leftJoin(schema.startGrants, eq(schema.startGrants.userId, schema.user.id))
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
        timeZone: row.timeZone,
      },
      balance: {
        availableCoin: serializeCoinAmount(row.availableCoin),
        lockedCoin: serializeCoinAmount(row.lockedCoin),
      },
      linkedAccounts: accounts.map((a) => ({
        id: a.id,
        providerId: a.providerId,
        accountId: a.accountId,
        createdAt: a.createdAt.toISOString(),
      })),
      verification:
        row.realName !== null && row.phone !== null && row.verifiedAt !== null
          ? { realName: row.realName, phone: row.phone, verifiedAt: row.verifiedAt.toISOString() }
          : null,
      startGrant:
        row.startGrantId === null
          ? null
          : toStartGrant({
              amountCoin: row.startGrantAmountCoin,
              grantedAt: row.startGrantedAt,
              cancelledAt: row.startGrantCancelledAt,
            }),
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

  /**
   * ADR-0063: the zone the member reads times in, or null to follow the browser again. The name
   * was checked by `timeZoneSchema` (Node's Intl) and is stored as given; `updated_at` follows
   * through drizzle's `$onUpdate`, as for the nickname.
   */
  async updateTimeZone(userId: string, timeZone: string | null): Promise<Me> {
    const updated = await this.db
      .update(schema.profiles)
      .set({ timeZone })
      .where(eq(schema.profiles.userId, userId))
      .returning({ userId: schema.profiles.userId });
    if (updated.length === 0) throw new AppError('NOT_FOUND', { message: 'Profile not found' });
    return this.getMe(userId);
  }
}
