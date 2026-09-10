import { desc } from 'drizzle-orm';
import { bigserial, index, jsonb, pgTable, varchar } from 'drizzle-orm/pg-core';
import { createdAt } from './columns.js';

/** Written by the worker `ledger.audit` job on invariant violations (PLAN 5.6). */
export const auditFailures = pgTable(
  'audit_failures',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    /** AUDIT_FAILURE_KINDS in @buddha/shared. */
    kind: varchar({ length: 40 }).notNull(),
    payload: jsonb().$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    /**
     * `GET /admin/audit-failures`: the global list, ordered `(created_at DESC, id DESC)`. One of
     * the "전역 키셋 목록 넷" A-M3-10 handed to M6, and it arrives with the row-comparison cursor
     * predicate (`keysetPredicate`, apps/api) because the two are one change — with the index but
     * the old OR-form predicate the deep page measured 647 ms at 2M rows against 172 ms with no
     * index at all. With both it is 0.07 ms and FOUR buffers, flat from 10k to 2M.
     */
    index('audit_failures_created_at_id_idx').on(desc(t.createdAt), desc(t.id)),
  ],
);
