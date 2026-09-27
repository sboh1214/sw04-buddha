import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  serializePAmount,
  type AdminBalanceAdjustResult,
  type AdminPayment,
  type AdminUser,
  type AuditFailure,
  type Role,
} from '@buddha/shared';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { toLedgerEntry, toBalance, type Page } from '../wallet/wallet.service.js';

const userColumns = {
  id: schema.user.id,
  email: schema.user.email,
  nickname: schema.profiles.nickname,
  role: schema.profiles.role,
  availableP: schema.balances.availableP,
  lockedP: schema.balances.lockedP,
  createdAt: schema.profiles.createdAt,
};

/** Row shape of the three-table join above (drizzle infers exactly these columns). */
interface UserRow {
  id: string;
  email: string;
  nickname: string;
  role: Role;
  availableP: bigint;
  lockedP: bigint;
  createdAt: Date;
}

function toAdminUser(row: UserRow): AdminUser {
  return {
    id: row.id,
    email: row.email,
    nickname: row.nickname,
    role: row.role,
    balance: toBalance(row),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Admin reads and the balance adjustment (PLAN 7.3, 12; M2). */
@Injectable()
export class AdminService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listUsers(
    q: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<AdminUser>> {
    const keyset = decodeKeyset(cursor, 'text');
    const pattern = q ? `%${q.replaceAll(/[%_\\]/g, (m) => `\\${m}`)}%` : undefined;
    const rows = await this.db
      .select(userColumns)
      .from(schema.user)
      .innerJoin(schema.profiles, eq(schema.profiles.userId, schema.user.id))
      .innerJoin(schema.balances, eq(schema.balances.userId, schema.user.id))
      .where(
        and(
          pattern
            ? or(ilike(schema.user.email, pattern), ilike(schema.profiles.nickname, pattern))
            : undefined,
          // `profiles.user_id`, not `user.id`: the two hold the same value (the FK guarantees
          // it, so the cursor a client already has keeps working), but a row comparison can only
          // become an index condition when both halves come from ONE table. Measured at 384 ms
          // with `user.id` during the M2 review, against one descent this way.
          keyset
            ? keysetPredicate(schema.profiles.createdAt, schema.profiles.userId, keyset, 'text')
            : undefined,
        ),
      )
      .orderBy(desc(schema.profiles.createdAt), desc(schema.profiles.userId))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map(toAdminUser),
      nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  async getUser(userId: string): Promise<AdminUser> {
    const [row] = await this.db
      .select(userColumns)
      .from(schema.user)
      .innerJoin(schema.profiles, eq(schema.profiles.userId, schema.user.id))
      .innerJoin(schema.balances, eq(schema.balances.userId, schema.user.id))
      .where(eq(schema.user.id, userId))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'User not found' });
    return toAdminUser(row);
  }

  /**
   * ADMIN_ADJUST (PLAN 5.6): one transaction writes the audit row, moves the balance and
   * appends the ledger entry. The UPDATE carries the non-negative guard, so an adjustment
   * that would overdraw the account matches no row and is refused — the CHECK constraint
   * would abort the transaction anyway, but this reports the reason.
   */
  async adjustBalance(
    adminId: string,
    userId: string,
    amountP: bigint,
    memo: string,
  ): Promise<AdminBalanceAdjustResult> {
    await this.getUser(userId); // 404 before writing anything

    const ledgerEntry = await this.db.transaction(async (tx) => {
      // The balance row first, then the clock: another writer of this account (a trade, a
      // void refund, a charge) may have committed while this transaction waited on that row,
      // and the rows written below must sort after it — `now()` is the transaction start and
      // would sort before work their own balance_after_p includes (clock.ts, A-M3-14). The
      // lock is what the UPDATE below would take anyway, so no writer's lock order changes;
      // the result is discarded, and a vanished row still falls through to the guard's own
      // zero-row branch (INSUFFICIENT_BALANCE).
      await tx
        .select({ userId: schema.balances.userId })
        .from(schema.balances)
        .where(eq(schema.balances.userId, userId))
        .limit(1)
        .for('update');
      const adjustedAt = await clockTimestamp(tx);

      const [action] = await tx
        .insert(schema.adminActions)
        .values({
          adminId,
          type: 'balance_adjust',
          targetType: 'user',
          targetId: userId,
          payload: { amountP: serializePAmount(amountP), memo },
          createdAt: adjustedAt,
        })
        .returning();
      if (!action) throw new AppError('INTERNAL', { message: 'Admin action insert failed' });

      const [balance] = await tx
        .update(schema.balances)
        .set({
          availableP: sql`${schema.balances.availableP} + ${amountP}`,
          // Explicit on purpose: the column's `$onUpdate` would write the API host's clock.
          updatedAt: adjustedAt,
        })
        .where(
          and(
            eq(schema.balances.userId, userId),
            sql`${schema.balances.availableP} + ${amountP} >= 0`,
          ),
        )
        .returning();
      if (!balance) {
        throw new AppError('INSUFFICIENT_BALANCE', {
          message: 'The adjustment would make the balance negative',
          details: [{ path: ['amountP'], message: 'balance would go negative' }],
        });
      }

      const [entry] = await tx
        .insert(schema.ledgerEntries)
        .values({
          userId,
          type: 'ADMIN_ADJUST',
          amountP,
          balanceAfterP: balance.availableP,
          refType: 'admin_action',
          refId: action.id,
          memo,
          createdAt: adjustedAt,
        })
        .returning();
      if (!entry) throw new AppError('INTERNAL', { message: 'Ledger insert failed' });
      return entry;
    });

    return { user: await this.getUser(userId), ledgerEntry: toLedgerEntry(ledgerEntry) };
  }

  async listPayments(cursor: string | undefined, limit: number): Promise<Page<AdminPayment>> {
    const keyset = decodeKeyset(cursor, 'uuid');
    const rows = await this.db
      .select({
        id: schema.payments.id,
        userId: schema.payments.userId,
        nickname: schema.profiles.nickname,
        amountP: schema.payments.amountP,
        priceKrw: schema.payments.priceKrw,
        packageId: schema.payments.packageId,
        provider: schema.payments.provider,
        providerRef: schema.payments.providerRef,
        status: schema.payments.status,
        method: schema.payments.method,
        approvedAt: schema.payments.approvedAt,
        refundedAt: schema.payments.refundedAt,
        resultMessage: schema.payments.resultMessage,
        createdAt: schema.payments.createdAt,
      })
      .from(schema.payments)
      .innerJoin(schema.profiles, eq(schema.profiles.userId, schema.payments.userId))
      .where(
        keyset
          ? keysetPredicate(schema.payments.createdAt, schema.payments.id, keyset, 'uuid')
          : undefined,
      )
      .orderBy(desc(schema.payments.createdAt), desc(schema.payments.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => ({
        id: row.id,
        userId: row.userId,
        nickname: row.nickname,
        amountP: serializePAmount(row.amountP),
        priceKrw: row.priceKrw,
        packageId: row.packageId,
        provider: row.provider,
        providerRef: row.providerRef,
        status: row.status,
        method: row.method,
        approvedAt: row.approvedAt?.toISOString() ?? null,
        refundedAt: row.refundedAt?.toISOString() ?? null,
        resultMessage: row.resultMessage,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  async listAuditFailures(cursor: string | undefined, limit: number): Promise<Page<AuditFailure>> {
    const keyset = decodeKeyset(cursor, 'int');
    const rows = await this.db
      .select()
      .from(schema.auditFailures)
      .where(
        keyset
          ? keysetPredicate(
              schema.auditFailures.createdAt,
              schema.auditFailures.id,
              keyset,
              'bigint',
            )
          : undefined,
      )
      .orderBy(desc(schema.auditFailures.createdAt), desc(schema.auditFailures.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => ({
        id: row.id.toString(),
        kind: row.kind,
        payload: row.payload ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor:
        hasMore && last
          ? encodeKeyset({ createdAt: last.createdAt, id: last.id.toString() })
          : null,
    };
  }
}
