import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { schema, type Db } from '@buddha/db';
import {
  COUPON_CODE_PATTERN,
  decodeKeyset,
  encodeKeyset,
  serializeCoinAmount,
  type Coupon,
  type CreateCouponBody,
  type LedgerEntry,
  type UpdateCouponBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/errors/pg-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { toBalance, toLedgerEntry, type Page } from './wallet.service.js';
import { type Balance } from '@buddha/shared';

type CouponRow = typeof schema.coupons.$inferSelect;

/** Unambiguous alphabet (no 0/O/1/I), same idea as the auto nickname suffix. */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const GENERATED_CODE_LENGTH = 10;

export const COUPON_REDEMPTION_UNIQUE = 'coupon_redemptions_coupon_id_user_id_unique';

function toCoupon(row: CouponRow): Coupon {
  return {
    id: row.id,
    code: row.code,
    amountCoin: serializeCoinAmount(row.amountCoin),
    maxRedemptions: row.maxRedemptions,
    redeemedCount: row.redeemedCount,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    isActive: row.isActive,
    memo: row.memo,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * What an `admin_actions` payload records about a coupon; jsonb, so Coin is a string. `code` is
 * carried so the log reads without joining back to `coupons`. `amountCoin` is here for the
 * create row only — it is immutable once issued, so an update's before/after never differ.
 */
function snapshot(row: CouponRow): Record<string, unknown> {
  return {
    code: row.code,
    amountCoin: serializeCoinAmount(row.amountCoin),
    maxRedemptions: row.maxRedemptions,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    isActive: row.isActive,
    memo: row.memo,
  };
}

/** Random, readable and unlikely to collide (32^10); the UNIQUE index is the real guard. */
function generateCode(): string {
  const bytes = randomBytes(GENERATED_CODE_LENGTH);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

export interface RedeemResult {
  coupon: Coupon;
  balance: Balance;
  ledgerEntry: LedgerEntry;
}

/**
 * Admin-issued Coin grants (ADR-0026). Redemption is one transaction that locks the coupon row,
 * re-checks every limit under that lock, writes the redemption, the balance and a BONUS
 * ledger entry — so a capped coupon cannot overshoot and nobody can redeem twice.
 */
@Injectable()
export class CouponService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async redeem(userId: string, code: string): Promise<RedeemResult> {
    return this.db.transaction(async (tx) => {
      const [coupon] = await tx
        .select()
        .from(schema.coupons)
        .where(eq(schema.coupons.code, code))
        .limit(1)
        .for('update');
      // Same answer for "no such code" and "not usable": a probe must not map the catalogue.
      if (!coupon || !coupon.isActive) throw invalidCoupon();
      if (coupon.expiresAt && coupon.expiresAt.getTime() <= Date.now()) throw invalidCoupon();
      if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
        throw invalidCoupon();
      }

      try {
        await tx.insert(schema.couponRedemptions).values({
          couponId: coupon.id,
          userId,
          amountCoin: coupon.amountCoin,
        });
      } catch (error) {
        if (isPgError(error, PG_UNIQUE_VIOLATION, COUPON_REDEMPTION_UNIQUE)) {
          throw new AppError('DUPLICATE_REQUEST', {
            message: 'This coupon has already been used on this account',
            details: [{ path: ['code'], message: 'already redeemed' }],
            cause: error,
          });
        }
        throw error;
      }

      const [updated] = await tx
        .update(schema.coupons)
        .set({ redeemedCount: coupon.redeemedCount + 1, updatedAt: new Date() })
        .where(eq(schema.coupons.id, coupon.id))
        .returning();
      // The balance row first, then the clock: another writer of this account (a
      // settlement payout, another wallet write) may have committed while this transaction waited
      // on that row, and the ledger row written below must sort after it — `now()` is the
      // transaction start and would sort before work its own balance_after_coin includes
      // (clock.ts, A-M3-14). The lock is what the UPDATE below would take anyway, so no
      // writer's lock order changes; the result is discarded, and a vanished row still falls
      // through to the check the UPDATE already had.
      await tx
        .select({ userId: schema.balances.userId })
        .from(schema.balances)
        .where(eq(schema.balances.userId, userId))
        .limit(1)
        .for('update');
      const redeemedAt = await clockTimestamp(tx);

      const [balance] = await tx
        .update(schema.balances)
        .set({
          availableCoin: sql`${schema.balances.availableCoin} + ${coupon.amountCoin}`,
          // Explicit on purpose: the column's `$onUpdate` would write the API host's clock.
          updatedAt: redeemedAt,
        })
        .where(eq(schema.balances.userId, userId))
        .returning();
      if (!updated || !balance) throw new AppError('NOT_FOUND', { message: 'Balance not found' });

      const [redemption] = await tx
        .select({ id: schema.couponRedemptions.id })
        .from(schema.couponRedemptions)
        .where(
          and(
            eq(schema.couponRedemptions.couponId, coupon.id),
            eq(schema.couponRedemptions.userId, userId),
          ),
        )
        .limit(1);
      const [entry] = await tx
        .insert(schema.ledgerEntries)
        .values({
          userId,
          type: 'BONUS',
          amountCoin: coupon.amountCoin,
          balanceAfterCoin: balance.availableCoin,
          refType: 'coupon',
          refId: redemption?.id ?? coupon.id,
          memo: `쿠폰 ${coupon.code}`,
          createdAt: redeemedAt,
        })
        .returning();
      if (!entry) throw new AppError('INTERNAL', { message: 'Ledger insert failed' });

      return {
        coupon: toCoupon(updated),
        balance: toBalance(balance),
        ledgerEntry: toLedgerEntry(entry),
      };
    });
  }

  async create(adminId: string, input: WithoutExpectedAccount<CreateCouponBody>): Promise<Coupon> {
    const code = input.code ?? generateCode();
    if (!COUPON_CODE_PATTERN.test(code)) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Invalid coupon code',
        details: [{ path: ['code'], message: 'only A-Z, 0-9 and -' }],
      });
    }
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(schema.coupons)
          .values({
            code,
            amountCoin: input.amountCoin,
            maxRedemptions: input.maxRedemptions ?? null,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            memo: input.memo ?? null,
            createdBy: adminId,
          })
          .returning();
        if (!row) throw new AppError('INTERNAL', { message: 'Coupon insert failed' });
        await tx.insert(schema.adminActions).values({
          adminId,
          type: 'coupon_create',
          targetType: 'coupon',
          targetId: row.id,
          payload: snapshot(row),
        });
        return toCoupon(row);
      });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'This coupon code already exists',
          details: [{ path: ['code'], message: 'already exists' }],
          cause: error,
        });
      }
      throw error;
    }
  }

  async update(
    adminId: string,
    id: string,
    input: WithoutExpectedAccount<UpdateCouponBody>,
  ): Promise<Coupon> {
    return this.db.transaction(async (tx) => {
      // Locked: the cap check below reads `redeemedCount`, and `redeem` increments it under
      // the same row lock, so a redemption cannot slip in between the check and the UPDATE.
      // The audit row's `before` is this same view of the row.
      const [current] = await tx
        .select()
        .from(schema.coupons)
        .where(eq(schema.coupons.id, id))
        .limit(1)
        .for('update');
      if (!current) throw new AppError('NOT_FOUND', { message: 'Coupon not found' });

      // A cap under what has already been redeemed would read as "7 of 5 used". Stopping a
      // coupon is `isActive: false`; the cap may come down to the count, never below it.
      if (
        typeof input.maxRedemptions === 'number' &&
        input.maxRedemptions < current.redeemedCount
      ) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'maxRedemptions must not be below the redeemed count',
          details: [
            {
              path: ['maxRedemptions'],
              message: `below the redeemed count (${String(current.redeemedCount)})`,
            },
          ],
        });
      }

      const [row] = await tx
        .update(schema.coupons)
        .set({
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
          ...(input.maxRedemptions === undefined
            ? {}
            : { maxRedemptions: input.maxRedemptions ?? null }),
          ...(input.expiresAt === undefined
            ? {}
            : { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }),
          ...(input.memo === undefined ? {} : { memo: input.memo ?? null }),
          updatedAt: new Date(),
        })
        .where(eq(schema.coupons.id, id))
        .returning();
      if (!row) throw new AppError('INTERNAL', { message: 'Coupon update failed' });

      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'coupon_update',
        targetType: 'coupon',
        targetId: row.id,
        payload: { before: snapshot(current), after: snapshot(row) },
      });
      return toCoupon(row);
    });
  }

  async list(cursor: string | undefined, limit: number): Promise<Page<Coupon>> {
    const keyset = decodeKeyset(cursor, 'uuid');
    const rows = await this.db
      .select()
      .from(schema.coupons)
      .where(
        keyset
          ? keysetPredicate(schema.coupons.createdAt, schema.coupons.id, keyset, 'uuid')
          : undefined,
      )
      .orderBy(desc(schema.coupons.createdAt), desc(schema.coupons.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map(toCoupon),
      nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }
}

/** One answer for every unusable coupon: unknown, disabled, expired or exhausted. */
function invalidCoupon(): AppError {
  return new AppError('VALIDATION_ERROR', {
    message: 'This coupon cannot be used',
    details: [{ path: ['code'], message: 'invalid or expired' }],
  });
}
