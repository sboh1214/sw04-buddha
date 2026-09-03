import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  serializePAmount,
  type ChargePackage,
  type CreateChargePackageBody,
  type UpdateChargePackageBody,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';

type PackageRow = typeof schema.chargePackages.$inferSelect;

export function toChargePackage(row: PackageRow): ChargePackage {
  return {
    id: row.id,
    amountP: serializePAmount(row.amountP),
    priceKrw: row.priceKrw,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  };
}

/**
 * The catalogue users buy from (ADR-0026). Everything here is admin-managed data, so the
 * service only reads and writes rows; the discount is derived by the client from
 * `amountP`/`priceKrw`, and the DB CHECK keeps the price at or below face value.
 */
@Injectable()
export class ChargePackageService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** What the wallet screen offers: active packages, in the order the admin set. */
  async listActive(): Promise<ChargePackage[]> {
    const rows = await this.db
      .select()
      .from(schema.chargePackages)
      .where(eq(schema.chargePackages.isActive, true))
      .orderBy(asc(schema.chargePackages.sortOrder), asc(schema.chargePackages.amountP));
    return rows.map(toChargePackage);
  }

  /** Admin view: inactive ones too, so a retired package can be brought back. */
  async listAll(): Promise<ChargePackage[]> {
    const rows = await this.db
      .select()
      .from(schema.chargePackages)
      .orderBy(asc(schema.chargePackages.sortOrder), asc(schema.chargePackages.amountP));
    return rows.map(toChargePackage);
  }

  async create(input: CreateChargePackageBody): Promise<ChargePackage> {
    const [row] = await this.db
      .insert(schema.chargePackages)
      .values({
        amountP: input.amountP,
        priceKrw: input.priceKrw,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      })
      .returning();
    if (!row) throw new AppError('INTERNAL', { message: 'Charge package insert failed' });
    return toChargePackage(row);
  }

  async update(id: string, input: UpdateChargePackageBody): Promise<ChargePackage> {
    // Both halves of the price/amount pair matter to the CHECK, so the missing half is read
    // from the row and sent along; a violation comes back as VALIDATION_ERROR, not a 500.
    const current = await this.get(id);
    const amountP = input.amountP ?? BigInt(current.amountP);
    const priceKrw = input.priceKrw ?? current.priceKrw;
    if (BigInt(priceKrw) > amountP) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'priceKrw must not exceed amountP',
        details: [{ path: ['priceKrw'], message: 'must not exceed amountP' }],
      });
    }
    const [row] = await this.db
      .update(schema.chargePackages)
      .set({
        amountP,
        priceKrw,
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        updatedAt: new Date(),
      })
      .where(eq(schema.chargePackages.id, id))
      .returning();
    if (!row) throw new AppError('NOT_FOUND', { message: 'Charge package not found' });
    return toChargePackage(row);
  }

  /** Payments keep their own amount/price snapshot; `payments.package_id` becomes NULL. */
  async remove(id: string): Promise<void> {
    const deleted = await this.db
      .delete(schema.chargePackages)
      .where(eq(schema.chargePackages.id, id))
      .returning({ id: schema.chargePackages.id });
    if (deleted.length === 0) {
      throw new AppError('NOT_FOUND', { message: 'Charge package not found' });
    }
  }

  async get(id: string): Promise<ChargePackage> {
    const [row] = await this.db
      .select()
      .from(schema.chargePackages)
      .where(eq(schema.chargePackages.id, id))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Charge package not found' });
    return toChargePackage(row);
  }
}
