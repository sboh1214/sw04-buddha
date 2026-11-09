import * as z from 'zod';
import { adminMarketSchema } from './market.js';
import { adminMarketConflictsSchema } from './market-conflicts.js';

/** The declaration and its pending-decision cleanup, read in the same transaction. */
export const adminMarketConflictWriteSchema = z
  .object({
    conflicts: adminMarketConflictsSchema,
    market: adminMarketSchema,
  })
  .meta({ id: 'AdminMarketConflictWrite' });
export type AdminMarketConflictWrite = z.infer<typeof adminMarketConflictWriteSchema>;
