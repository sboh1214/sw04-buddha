import { schema, type Db } from '@buddha/db';
import { categoryUnselectableReason, type CategoryUnselectableReason } from '@buddha/shared';
import { and, count, eq } from 'drizzle-orm';

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** What `readCategorySelectability` found: no such row, or why it cannot be picked (or null). */
export type CategorySelectability =
  { found: false } | { found: true; reason: CategoryUnselectableReason | null };

/**
 * Whether a new market may be filed under `categoryId` (#17, ADR-0093 decision 2 #172 item 1):
 * active, under an active parent, and a leaf — `categoryUnselectableReason` in @buddha/shared.
 * The market writes (create, a category change), the open-items check and a proposal's 채택 ask
 * the same question.
 *
 * Inside the caller's transaction, the parent's row and then the category's are held FOR SHARE
 * until it ends, and every category admin write takes the row it changes FOR NO KEY UPDATE, and a
 * sub-category's parent first (CategoryAdminService): a hide, a show of a sub-category, or a new
 * one under the parent either commits before this read sees the rows or waits for the market write
 * that read them to commit — never a market filed under a category that stopped being pickable in
 * between. Parent first, as the admin writes lock: the other way round, this read holding the
 * sub-category and waiting for the parent while a write holds the parent and waits for the
 * sub-category would be a deadlock. The parent's id is read before any lock, which is safe because
 * a category never moves (#17: no change of parent or level). FOR SHARE also keeps the referenced
 * row from vanishing before the market row is written (the FK is ON DELETE RESTRICT, but a race
 * would surface as a 500).
 */
export async function readCategorySelectability(
  tx: Tx,
  categoryId: number,
): Promise<CategorySelectability> {
  const { categories } = schema;
  const [placed] = await tx
    .select({ parentId: categories.parentId })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1);
  if (!placed) return { found: false };
  let parentActive: boolean | null = null;
  if (placed.parentId !== null) {
    const [parent] = await tx
      .select({ isActive: categories.isActive })
      .from(categories)
      .where(eq(categories.id, placed.parentId))
      .limit(1)
      .for('share');
    // The FK keeps the parent; a missing one would be a hidden one as far as picking goes.
    parentActive = parent?.isActive ?? false;
  }
  const [category] = await tx
    .select({ isActive: categories.isActive })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1)
    .for('share');
  // Never deleted (ON DELETE RESTRICT, and no route deletes one): found above, found here.
  if (!category) return { found: false };
  const [children] = await tx
    .select({ n: count() })
    .from(categories)
    .where(and(eq(categories.parentId, categoryId), eq(categories.isActive, true)));
  return {
    found: true,
    reason: categoryUnselectableReason({
      isActive: category.isActive,
      parentActive,
      activeChildCount: children?.n ?? 0,
    }),
  };
}
