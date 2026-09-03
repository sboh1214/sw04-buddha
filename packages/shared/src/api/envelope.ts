import * as z from 'zod';

export const pageMetaSchema = z
  .object({ nextCursor: z.string().nullable() })
  .meta({ id: 'PageMeta' });
export type PageMeta = z.infer<typeof pageMetaSchema>;

/** PLAN 7 success envelope for a single resource: `{ data }`. */
export function dataEnvelope<T extends z.ZodType>(data: T) {
  return z.object({ data });
}

/** PLAN 7 success envelope for a cursor page: `{ data: T[], meta: { nextCursor } }`. */
export function pageEnvelope<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), meta: pageMetaSchema });
}
