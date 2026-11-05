import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  serializeCoinAmount,
  type AdminPayment,
  type AdminUser,
  type AdminUserStatus,
  type AuditFailure,
  type Role,
} from '@buddha/shared';
import { and, desc, eq, ilike, isNotNull, isNull, or } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { DB } from '../infra/db/db.provider.js';
import { paymentColumns, toBalance, type Page } from '../wallet/wallet.service.js';

const userColumns = {
  id: schema.user.id,
  email: schema.user.email,
  nickname: schema.profiles.nickname,
  role: schema.profiles.role,
  availableCoin: schema.balances.availableCoin,
  lockedCoin: schema.balances.lockedCoin,
  createdAt: schema.profiles.createdAt,
};

/** Row shape of the three-table join above (drizzle infers exactly these columns). */
interface UserRow {
  id: string;
  email: string;
  /** Null for an account its member closed (#140). */
  nickname: string | null;
  role: Role;
  availableCoin: bigint;
  lockedCoin: bigint;
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

const adminPaymentColumns = {
  id: schema.payments.id,
  userId: schema.payments.userId,
  nickname: schema.profiles.nickname,
  amountCoin: schema.payments.amountCoin,
  priceKrw: schema.payments.priceKrw,
  packageId: schema.payments.packageId,
  provider: schema.payments.provider,
  providerRef: schema.payments.providerRef,
  status: schema.payments.status,
  method: schema.payments.method,
  approvedAt: schema.payments.approvedAt,
  refundedAt: schema.payments.refundedAt,
  resultMessage: schema.payments.resultMessage,
  cancelConfirmed: paymentColumns.cancelConfirmed,
  createdAt: schema.payments.createdAt,
};

type AdminPaymentRow = Omit<typeof schema.payments.$inferSelect, 'idempotencyKey' | 'updatedAt'> & {
  /** Null for an account its member closed (#140). */
  nickname: string | null;
  cancelConfirmed: boolean | null;
};

function toAdminPayment(row: AdminPaymentRow): AdminPayment {
  return {
    id: row.id,
    userId: row.userId,
    nickname: row.nickname,
    amountCoin: serializeCoinAmount(row.amountCoin),
    priceKrw: row.priceKrw,
    packageId: row.packageId,
    provider: row.provider,
    providerRef: row.providerRef,
    status: row.status,
    method: row.method,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    refundedAt: row.refundedAt?.toISOString() ?? null,
    resultMessage: row.resultMessage,
    cancelConfirmed: row.cancelConfirmed,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Admin reads (PLAN 7.3, 12; M2). The balance adjustment went with #116 (ADR-0109). */
@Injectable()
export class AdminService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * `GET /admin/users`: accounts newest first, matched by email or nickname, every one or only the
   * open (`status=open`) or closed (`status=closed`) ones — a closed account (its member closed it,
   * #140) stays in the list with its placeholder address and no nickname, while the admin role's
   * grant search asks for the open ones only (owner decision 2026-10-23 (2차) 5, ADR-0086).
   */
  async listUsers(
    q: string | undefined,
    status: AdminUserStatus | undefined,
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
          status === 'open' ? isNull(schema.profiles.closedAt) : undefined,
          status === 'closed' ? isNotNull(schema.profiles.closedAt) : undefined,
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

  async listPayments(cursor: string | undefined, limit: number): Promise<Page<AdminPayment>> {
    const keyset = decodeKeyset(cursor, 'uuid');
    const rows = await this.db
      .select(adminPaymentColumns)
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
      items: kept.map(toAdminPayment),
      nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  /** One payment as the admin list shows it (the refund answers with it). */
  async getPayment(paymentId: string): Promise<AdminPayment> {
    const [row] = await this.db
      .select(adminPaymentColumns)
      .from(schema.payments)
      .innerJoin(schema.profiles, eq(schema.profiles.userId, schema.payments.userId))
      .where(eq(schema.payments.id, paymentId))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Payment not found' });
    return toAdminPayment(row);
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
