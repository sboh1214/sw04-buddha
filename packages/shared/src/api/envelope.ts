import * as z from 'zod';

export const pageMetaSchema = z
  .object({ nextCursor: z.string().nullable() })
  .meta({ id: 'PageMeta' });
export type PageMeta = z.infer<typeof pageMetaSchema>;

/**
 * The meta of a cursor page whose screen also says how many items the whole list holds — every
 * page, not only the ones already loaded (#47: the market detail's 토론 shows its post count above
 * the first 20, ADR-0069 decision 4). `total` is counted in the same snapshot as the page's items,
 * so the two never disagree in one answer; a later page counts again, as the list may have grown.
 * PLAN 7's page meta with one field more: a list whose screen shows no count stays `PageMeta`.
 */
export const countedPageMetaSchema = pageMetaSchema
  .extend({ total: z.number().int().min(0) })
  .meta({ id: 'CountedPageMeta' });
export type CountedPageMeta = z.infer<typeof countedPageMetaSchema>;

/** PLAN 7 success envelope for a single resource: `{ data }`. */
export function dataEnvelope<T extends z.ZodType>(data: T) {
  return z.object({ data });
}

/** PLAN 7 success envelope for a cursor page: `{ data: T[], meta: { nextCursor } }`. */
export function pageEnvelope<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), meta: pageMetaSchema });
}

/** A cursor page that counts its whole list: `{ data: T[], meta: { nextCursor, total } }`. */
export function countedPageEnvelope<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), meta: countedPageMetaSchema });
}
