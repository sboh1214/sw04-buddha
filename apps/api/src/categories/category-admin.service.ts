import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  CATEGORY_GROUP_MAX,
  CATEGORY_REFUSALS,
  type AdminActionType,
  type AdminCategory,
  type CreateCategoryBody,
  type ReorderCategoriesBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { asc, count, eq, inArray, isNull, max, sql, type SQL } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { PG_UNIQUE_VIOLATION, isPgError } from '../common/errors/pg-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Reads that run either inside a transaction or on the pool. */
type Executor = Db | Tx;

type CategoryRow = typeof schema.categories.$inferSelect;

/** UNIQUE (slug) on categories (migration 0000): unique across the whole tree. */
export const CATEGORY_SLUG_UNIQUE = 'categories_slug_unique';
/** UNIQUE (coalesce(parent_id, 0), name_ko) (migration 0049): siblings never share a name. */
export const CATEGORY_SIBLING_NAME_UNIQUE = 'categories_parent_name_ko_unique';

/** The gap between two siblings' `sort_order`, as the seed spaces them. */
const SORT_ORDER_STEP = 10;

/**
 * The lock a write takes on the categories it reads and changes: the one its own UPDATE takes (no
 * key column changes — the slug never does). It waits for, and holds off, readCategorySelectability
 * (FOR SHARE), as FOR UPDATE would, but not the foreign-key check of a row being written that names
 * the category — a member's interest pick, a proposal, a market (FOR KEY SHARE). An interest write
 * holds a key-share lock on each category it picks, a sub-category before its parent if it lists
 * them so, and a write here holds the parent while it waits for the sub-category: with FOR UPDATE
 * the two would wait for each other (as ADR-0083 7-13 found for posts).
 */
const WRITE_LOCK = 'no key update';

/** A VALIDATION_ERROR naming one field, with one of the `CATEGORY_REFUSALS`. */
function refusal(
  which: (typeof CATEGORY_REFUSALS)[keyof typeof CATEGORY_REFUSALS],
  message: string,
  cause?: unknown,
): AppError {
  return new AppError('VALIDATION_ERROR', {
    message,
    details: [{ path: [which.field], message: which.message }],
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * 카테고리 관리 (#17) for admins: the two-level tree `GET /categories` answers, kept on
 * `/admin/categories`. Owner decisions (ADR-0093 decision 2 #172 item 1, decision 3's #17 rows):
 * two levels, as today; a category with markets is never deleted, only hidden — it leaves
 * new-market entry, the explore categories and the interest pick, and its markets keep it;
 * operators set the order, top-level categories among themselves and sub-categories within their
 * parent, a new one last; every add, rename, reorder and hide records the actor, the time and the
 * value before and after, with no reason and no second admin (as ADR-0068 and ADR-0088). And the
 * choices made for it (#17): the slug is chosen at creation and never changes, a rename changes the
 * name only; nothing is deleted, a hidden category is shown again the same way; a sub-category is
 * made under an active top-level category, and no category moves to another parent or level;
 * siblings never share a name (`categories_parent_name_ko_unique`) and no two categories a slug; a
 * reorder names every sibling of the group, hidden ones included. Hiding a top-level category hides
 * its sub-categories with it through the parent rule — `GET /categories` leaves them out and none
 * can be picked (`categoryUnselectableReason`) — without touching their own `is_active`. Names are
 * not held to the excluded words, and sports and politics may be added (D10). The record is
 * write-only, as the themes' is (ADR-0088): no route reads it back.
 *
 * Each write runs in one transaction. It locks what it changes (`WRITE_LOCK`) — a sub-category's
 * parent first, then the sub-category, the order readCategorySelectability takes them in; a new
 * sub-category and a reorder of a parent's sub-categories lock that parent, and a new top-level
 * category and a reorder of the top level every top-level row, so two writes of one group are
 * ordered and the second sees the first's result — then reads the clock (`clockTimestamp`), and
 * writes one `admin_actions` row (a `category_*` type, target `category` / the category's id, or
 * for a reorder the parent's, none for the top level) when something changed: the same name again,
 * a hidden category hidden again or an unchanged order writes none.
 */
@Injectable()
export class CategoryAdminService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * `GET /admin/categories`: every category, hidden ones too, in the public list's order — every
   * top-level row first (`parent_id` NULLS FIRST), siblings by `sort_order` then id — each with the
   * markets filed under it.
   */
  async list(): Promise<AdminCategory[]> {
    return this.rows(this.db);
  }

  /**
   * `POST /admin/categories`: a top-level category (`parentId` null) or a sub-category of an active
   * top-level one — an unknown parent is NOT_FOUND naming `parentId`, a sub-category or a hidden
   * one VALIDATION_ERROR naming it — placed last among its siblings, hidden ones counted
   * (`sort_order` the largest + 10, 10 for the first). A group that already holds
   * CATEGORY_GROUP_MAX categories takes no more (`groupFull`, naming `parentId`). A slug any
   * category has, or a name a sibling has, is VALIDATION_ERROR naming the field (the unique
   * indexes decide). A top-level category with markets that gets its first sub-category keeps
   * them; it just stops being pickable.
   */
  async create(
    adminId: string,
    body: WithoutExpectedAccount<CreateCategoryBody>,
  ): Promise<AdminCategory> {
    try {
      return await this.db.transaction(async (tx) => {
        if (body.parentId === null) {
          await this.lockGroup(tx, null);
        } else {
          const parent = await this.lockRow(tx, body.parentId, ['parentId']);
          if (parent.parentId !== null) {
            throw refusal(
              CATEGORY_REFUSALS.parentNotTopLevel,
              'A sub-category goes under a top-level category',
            );
          }
          if (!parent.isActive) {
            throw refusal(CATEGORY_REFUSALS.parentInactive, 'The parent category is hidden');
          }
        }
        const now = await clockTimestamp(tx);
        const [last] = await tx
          .select({ sortOrder: max(schema.categories.sortOrder), size: count() })
          .from(schema.categories)
          .where(groupOf(body.parentId));
        // The group is locked above, so its size cannot grow past the cap behind this check.
        if ((last?.size ?? 0) >= CATEGORY_GROUP_MAX) {
          throw refusal(
            CATEGORY_REFUSALS.groupFull,
            `A group holds at most ${CATEGORY_GROUP_MAX} categories, hidden ones included`,
          );
        }
        const [row] = await tx
          .insert(schema.categories)
          .values({
            slug: body.slug,
            nameKo: body.nameKo,
            parentId: body.parentId,
            sortOrder: (last?.sortOrder ?? 0) + SORT_ORDER_STEP,
            isActive: true,
          })
          .returning();
        const category = row!;
        await this.audit(
          tx,
          adminId,
          'category_create',
          category.id,
          {
            after: {
              slug: category.slug,
              nameKo: category.nameKo,
              parentId: category.parentId,
              sortOrder: category.sortOrder,
              isActive: category.isActive,
            },
          },
          now,
        );
        return this.row(tx, category.id);
      });
    } catch (error) {
      throw uniqueRefusal(error) ?? error;
    }
  }

  /**
   * `PATCH /admin/categories/:id`: the name, the one thing about a category that changes (the
   * slug is fixed, so `?category=` links outlive a rename). The same name again is no change; a
   * name a sibling has is VALIDATION_ERROR naming `nameKo`.
   */
  async rename(adminId: string, categoryId: number, nameKo: string): Promise<AdminCategory> {
    try {
      return await this.db.transaction(async (tx) => {
        const current = await this.lockForWrite(tx, categoryId);
        const now = await clockTimestamp(tx);
        if (nameKo !== current.nameKo) {
          await tx
            .update(schema.categories)
            .set({ nameKo })
            .where(eq(schema.categories.id, categoryId));
          await this.audit(
            tx,
            adminId,
            'category_rename',
            categoryId,
            { before: { nameKo: current.nameKo }, after: { nameKo } },
            now,
          );
        }
        return this.row(tx, categoryId);
      });
    } catch (error) {
      throw uniqueRefusal(error) ?? error;
    }
  }

  /**
   * `PUT /admin/categories/order`: one group's new order — the top-level categories (`parentId`
   * null) or one top-level category's sub-categories — as every id of the group, hidden ones
   * included, each once, first to last; anything else is VALIDATION_ERROR naming `ids` (a list
   * read before another admin's add or reorder of the group is refused, not half applied). An
   * unknown parent is NOT_FOUND naming `parentId`, and a sub-category, which has no group under
   * it, VALIDATION_ERROR naming it; a hidden parent's sub-categories may be ordered. The group is
   * spaced again by 10 from 10, and recorded with its order before and after; the same order
   * writes nothing. Answers the group as it then stands.
   */
  async reorder(
    adminId: string,
    body: WithoutExpectedAccount<ReorderCategoriesBody>,
  ): Promise<AdminCategory[]> {
    const { categories } = schema;
    return this.db.transaction(async (tx) => {
      if (body.parentId !== null) {
        const parent = await this.lockRow(tx, body.parentId, ['parentId']);
        if (parent.parentId !== null) {
          throw refusal(
            CATEGORY_REFUSALS.parentNotTopLevel,
            'Only a top-level category has sub-categories',
          );
        }
      }
      await this.lockGroup(tx, body.parentId);
      const now = await clockTimestamp(tx);
      // Read after the locks, by a statement of its own: it sees a sibling added by a write that
      // committed while this one waited, which the locking statement's snapshot did not.
      const before = (
        await tx
          .select({ id: categories.id })
          .from(categories)
          .where(groupOf(body.parentId))
          .orderBy(asc(categories.sortOrder), asc(categories.id))
      ).map((row) => row.id);
      const members = new Set(before);
      if (body.ids.length !== before.length || !body.ids.every((id) => members.has(id))) {
        throw refusal(
          CATEGORY_REFUSALS.orderMismatch,
          'The order must name every category of the group once',
        );
      }
      if (body.ids.some((id, index) => id !== before[index])) {
        const placed = sql.join(
          body.ids.map(
            (id, index) => sql`when ${id} then ${(index + 1) * SORT_ORDER_STEP}::integer`,
          ),
          sql` `,
        );
        await tx
          .update(categories)
          .set({ sortOrder: sql`case ${categories.id} ${placed} end` })
          .where(inArray(categories.id, body.ids));
        await this.audit(
          tx,
          adminId,
          'category_reorder',
          body.parentId,
          { parentId: body.parentId, before, after: body.ids },
          now,
        );
      }
      return this.rows(tx, groupOf(body.parentId));
    });
  }

  /**
   * `POST /admin/categories/:id/hide`: out of new-market entry, the explore categories and the
   * interest pick; its markets keep it, and a top-level category's sub-categories go with it
   * without their own `is_active` changing. A hidden category stays as it is.
   */
  async hide(adminId: string, categoryId: number): Promise<AdminCategory> {
    return this.setActive(adminId, categoryId, false);
  }

  /**
   * `POST /admin/categories/:id/show`: a hidden category back. A shown one stays as it is; a
   * sub-category of a hidden top-level one is shown with it once the parent is.
   */
  async show(adminId: string, categoryId: number): Promise<AdminCategory> {
    return this.setActive(adminId, categoryId, true);
  }

  private async setActive(
    adminId: string,
    categoryId: number,
    active: boolean,
  ): Promise<AdminCategory> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockForWrite(tx, categoryId);
      const now = await clockTimestamp(tx);
      if (current.isActive !== active) {
        await tx
          .update(schema.categories)
          .set({ isActive: active })
          .where(eq(schema.categories.id, categoryId));
        await this.audit(
          tx,
          adminId,
          active ? 'category_show' : 'category_hide',
          categoryId,
          { before: { isActive: current.isActive }, after: { isActive: active } },
          now,
        );
      }
      return this.row(tx, categoryId);
    });
  }

  /**
   * The category a write changes, locked: its parent first when it has one, then the row — the
   * order readCategorySelectability takes them in. The parent's id is read unlocked: a category
   * never moves. NOT_FOUND for an unknown id (the path's).
   */
  private async lockForWrite(tx: Tx, categoryId: number): Promise<CategoryRow> {
    const [placed] = await tx
      .select({ parentId: schema.categories.parentId })
      .from(schema.categories)
      .where(eq(schema.categories.id, categoryId));
    if (!placed) throw new AppError('NOT_FOUND', { message: 'Category not found' });
    if (placed.parentId !== null) await this.lockRow(tx, placed.parentId);
    return this.lockRow(tx, categoryId);
  }

  /** One category row, locked; NOT_FOUND (naming `path` when the body sent the id) when unknown. */
  private async lockRow(tx: Tx, categoryId: number, path?: string[]): Promise<CategoryRow> {
    const [row] = await tx
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.id, categoryId))
      .for(WRITE_LOCK);
    if (!row) {
      throw new AppError('NOT_FOUND', {
        message: 'Category not found',
        ...(path ? { details: [{ path, message: 'not found' }] } : {}),
      });
    }
    return row;
  }

  /**
   * Every row of a group, locked in id order — the top level for `null`, else the parent's
   * sub-categories (whose parent the caller has locked already). Two writes of one group wait for
   * each other here, and lock its rows in the same order. An empty top level has no row to lock:
   * two first categories made at once may share a `sort_order`, and their ids then order them.
   */
  private async lockGroup(tx: Tx, parentId: number | null): Promise<void> {
    await tx
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(groupOf(parentId))
      .orderBy(asc(schema.categories.id))
      .for(WRITE_LOCK);
  }

  /** The record of a change (actor, time, before and after; ADR-0093 decision 2 #172 item 1). */
  private async audit(
    tx: Tx,
    adminId: string,
    type: Extract<AdminActionType, `category_${string}`>,
    categoryId: number | null,
    payload: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    await tx.insert(schema.adminActions).values({
      adminId,
      type,
      targetType: 'category',
      targetId: categoryId === null ? null : String(categoryId),
      payload,
      createdAt: now,
    });
  }

  /** One category as the admin sees it, read through `executor`: a write answers what it wrote. */
  private async row(executor: Executor, categoryId: number): Promise<AdminCategory> {
    const [row] = await this.rows(executor, eq(schema.categories.id, categoryId));
    if (!row) throw new AppError('NOT_FOUND', { message: 'Category not found' });
    return row;
  }

  /**
   * Categories as the admin sees them, hidden ones too, in the public list's order, each with the
   * markets filed under it in any status (not those of its sub-categories).
   */
  private async rows(executor: Executor, where?: SQL): Promise<AdminCategory[]> {
    const { categories, markets } = schema;
    // A join rather than a correlated subquery: drizzle leaves the columns of a one-table select
    // unqualified, so `markets.category_id = categories.id` would compare `markets.id` there.
    const counts = executor
      .select({ categoryId: markets.categoryId, n: count().as('n') })
      .from(markets)
      .groupBy(markets.categoryId)
      .as('market_counts');
    return executor
      .select({
        id: categories.id,
        slug: categories.slug,
        nameKo: categories.nameKo,
        sortOrder: categories.sortOrder,
        parentId: categories.parentId,
        isActive: categories.isActive,
        marketCount: sql<number>`coalesce(${counts.n}, 0)`.mapWith(Number),
      })
      .from(categories)
      .leftJoin(counts, eq(counts.categoryId, categories.id))
      .where(where)
      .orderBy(
        sql`${categories.parentId} nulls first`,
        asc(categories.sortOrder),
        asc(categories.id),
      );
  }
}

/** The rows of one sibling group: the top level for `null`, else that parent's sub-categories. */
function groupOf(parentId: number | null): SQL {
  return parentId === null
    ? isNull(schema.categories.parentId)
    : eq(schema.categories.parentId, parentId);
}

/** A unique index's violation as the refusal naming its field, or undefined for any other error. */
function uniqueRefusal(error: unknown): AppError | undefined {
  if (isPgError(error, PG_UNIQUE_VIOLATION, CATEGORY_SLUG_UNIQUE)) {
    return refusal(CATEGORY_REFUSALS.slugTaken, 'This slug is already taken', error);
  }
  if (isPgError(error, PG_UNIQUE_VIOLATION, CATEGORY_SIBLING_NAME_UNIQUE)) {
    return refusal(CATEGORY_REFUSALS.nameTaken, 'A sibling already has this name', error);
  }
  return undefined;
}
