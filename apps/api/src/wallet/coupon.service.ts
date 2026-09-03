import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { schema, type Db } from '@buddha/db';
import {
  COUPON_CODE_PATTERN,
  decodeKeyset,
  encodeKeyset,
  serializePAmount,
  type Coupon,
  type CreateCouponBody,
  type LedgerEntry,
  type UpdateCouponBody,
} from '@buddha/shared';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/errors/pg-error.js';
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
    amountP: serializePAmount(row.amountP),
    maxRedemptions: row.maxRedemptions,
    redeemedCount: row.redeemedCount,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    isActive: row.isActive,
    memo: row.memo,
    createdAt: row.createdAt.toISOString(),
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
 * Admin-issued P grants (ADR-0026). Redemption is one transaction that locks the coupon row,
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
          amountP: coupon.amountP,
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
      const [balance] = await tx
        .update(schema.balances)
        .set({
          availableP: sql`${schema.balances.availableP} + ${coupon.amountP}`,
          updatedAt: new Date(),
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
          amountP: coupon.amountP,
          balanceAfterP: balance.availableP,
          refType: 'coupon',
          refId: redemption?.id ?? coupon.id,
          memo: `쿠폰 ${coupon.code}`,
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

  async create(adminId: string, input: CreateCouponBody): Promise<Coupon> {
    const code = input.code ?? generateCode();
    if (!COUPON_CODE_PATTERN.test(code)) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Invalid coupon code',
        details: [{ path: ['code'], message: 'only A-Z, 0-9 and -' }],
      });
    }
    try {
      const [row] = await this.db
        .insert(schema.coupons)
        .values({
          code,
          amountP: input.amountP,
          maxRedemptions: input.maxRedemptions ?? null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          memo: input.memo ?? null,
          createdBy: adminId,
        })
        .returning();
      if (!row) throw new AppError('INTERNAL', { message: 'Coupon insert failed' });
      return toCoupon(row);
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

  async update(id: string, input: UpdateCouponBody): Promise<Coupon> {
    const [row] = await this.db
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
    if (!row) throw new AppError('NOT_FOUND', { message: 'Coupon not found' });
    return toCoupon(row);
  }

  async list(cursor: string | undefined, limit: number): Promise<Page<Coupon>> {
    const keyset = decodeKeyset(cursor);
    const rows = await this.db
      .select()
      .from(schema.coupons)
      .where(
        keyset
          ? or(
              lt(schema.coupons.createdAt, keyset.createdAt),
              and(eq(schema.coupons.createdAt, keyset.createdAt), lt(schema.coupons.id, keyset.id)),
            )
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
