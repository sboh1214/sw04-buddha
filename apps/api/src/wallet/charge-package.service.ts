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

/** What an `admin_actions` payload records about a package; jsonb, so P is a string. */
function snapshot(row: PackageRow): Record<string, unknown> {
  return {
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

  async create(adminId: string, input: CreateChargePackageBody): Promise<ChargePackage> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.chargePackages)
        .values({
          amountP: input.amountP,
          priceKrw: input.priceKrw,
          sortOrder: input.sortOrder,
          isActive: input.isActive,
        })
        .returning();
      if (!row) throw new AppError('INTERNAL', { message: 'Charge package insert failed' });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'charge_package_create',
        targetType: 'charge_package',
        targetId: row.id,
        payload: snapshot(row),
      });
      return toChargePackage(row);
    });
  }

  async update(
    adminId: string,
    id: string,
    input: UpdateChargePackageBody,
  ): Promise<ChargePackage> {
    return this.db.transaction(async (tx) => {
      // Both halves of the price/amount pair matter to the CHECK, so the missing half is read
      // from the row and written back with it — which is only sound while the row is locked.
      // Unlocked, a patch of just `isActive` would restore a price a concurrent patch had
      // already changed, and `charge` snapshots that price onto the payment. Writing the pair
      // rather than only the supplied fields is deliberate: the CHECK then re-evaluates
      // exactly what was validated here, so a violation stays a VALIDATION_ERROR and never
      // reaches the exception filter, which has no SQLSTATE branch and would render it as 500.
      const [current] = await tx
        .select()
        .from(schema.chargePackages)
        .where(eq(schema.chargePackages.id, id))
        .limit(1)
        .for('update');
      if (!current) throw new AppError('NOT_FOUND', { message: 'Charge package not found' });

      const amountP = input.amountP ?? current.amountP;
      const priceKrw = input.priceKrw ?? current.priceKrw;
      if (BigInt(priceKrw) > amountP) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'priceKrw must not exceed amountP',
          details: [{ path: ['priceKrw'], message: 'must not exceed amountP' }],
        });
      }

      const [row] = await tx
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
      // The row was found and is locked, so a miss here is not a 404.
      if (!row) throw new AppError('INTERNAL', { message: 'Charge package update failed' });

      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'charge_package_update',
        targetType: 'charge_package',
        targetId: row.id,
        payload: { before: snapshot(current), after: snapshot(row) },
      });
      return toChargePackage(row);
    });
  }

  /** Payments keep their own amount/price snapshot; `payments.package_id` becomes NULL. */
  async remove(adminId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // The whole row, not just its id: the package is hard-deleted, so this audit payload is
      // the only place its amount and price survive.
      const [row] = await tx
        .delete(schema.chargePackages)
        .where(eq(schema.chargePackages.id, id))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', { message: 'Charge package not found' });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'charge_package_delete',
        targetType: 'charge_package',
        targetId: row.id,
        payload: snapshot(row),
      });
    });
  }

  /**
   * The package a user is buying (WalletService.charge is the only caller).
   *
   * The 404 names the body field, the way the VALIDATION_ERROR for a retired package does.
   * `charge` answers NOT_FOUND for an account with no balance row too, after the provider has
   * run, and the web tells the two apart by this detail: only a package that is gone means
   * the catalogue on screen is stale and worth refetching.
   */
  async get(id: string): Promise<ChargePackage> {
    const found = await this.find(id);
    if (!found) {
      throw new AppError('NOT_FOUND', {
        message: 'Charge package not found',
        details: [{ path: ['packageId'], message: 'not found' }],
      });
    }
    return found;
  }

  /** `get` without the 404: for a reference that may legitimately be gone (a replayed charge). */
  async find(id: string): Promise<ChargePackage | null> {
    const [row] = await this.db
      .select()
      .from(schema.chargePackages)
      .where(eq(schema.chargePackages.id, id))
      .limit(1);
    return row ? toChargePackage(row) : null;
  }
}
