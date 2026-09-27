import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { type Contact, type ContactBody, type Me, serializePAmount } from '@buddha/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { findPgError, isPgError, PG_UNIQUE_VIOLATION } from '../common/errors/pg-error.js';
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

  /**
   * ADR-0043: one row per account, created by the first call and replaced by every later one
   * (both fields, every time — `contactBodySchema` has no optional member). `updated_at` comes
   * from the database clock, like `created_at` does on the insert.
   *
   * The values never reach a log line: see `contactWriteFailure`.
   */
  async updateContact(userId: string, contact: ContactBody): Promise<Contact> {
    let row: Contact | undefined;
    try {
      [row] = await this.db
        .insert(schema.userContacts)
        .values({ userId, realName: contact.realName, phone: contact.phone })
        .onConflictDoUpdate({
          target: schema.userContacts.userId,
          set: { realName: contact.realName, phone: contact.phone, updatedAt: sql`now()` },
        })
        .returning({ realName: schema.userContacts.realName, phone: schema.userContacts.phone });
    } catch (error) {
      throw contactWriteFailure(error);
    }
    // ON CONFLICT DO UPDATE returns the row on both paths; nothing here can yield zero rows.
    if (!row) throw new AppError('INTERNAL', { message: 'Contact upsert returned no row' });
    return row;
  }
}

/**
 * The upsert's failure with the personal data taken out. ApiExceptionFilter logs a 5xx with its
 * whole cause chain, and each level of this one can carry the values: drizzle's
 * `DrizzleQueryError` puts the bound parameters in its message (`params: <id>,<name>,<phone>`)
 * and in `params`, and a node-postgres error can quote the row in `detail` ("Failing row
 * contains …"). Only the SQLSTATE is kept — enough to tell a constraint from an outage — and
 * the original is dropped rather than attached as `cause`.
 */
export function contactWriteFailure(error: unknown): AppError {
  const pg = findPgError(error);
  return new AppError('INTERNAL', {
    message: `Saving the contact failed (${pg ? `SQLSTATE ${pg.code}` : 'no SQLSTATE'})`,
  });
}
