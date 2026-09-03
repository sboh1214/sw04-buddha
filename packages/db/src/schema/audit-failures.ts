import { bigserial, jsonb, pgTable, varchar } from 'drizzle-orm/pg-core';
import { createdAt } from './columns.js';

/** Written by the worker `ledger.audit` job on invariant violations (PLAN 5.6). */
export const auditFailures = pgTable('audit_failures', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  /** AUDIT_FAILURE_KINDS in @buddha/shared. */
  kind: varchar({ length: 40 }).notNull(),
  payload: jsonb().$type<Record<string, unknown>>(),
  createdAt: createdAt(),
});
