import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  inet,
  pgTable,
  text,
  varchar,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { createdAt } from './columns.js';

/**
 * 약관 동의 기록 (#58, ADR-0069 decision 1 #57-5, ADR-0072): one row per item an account answered
 * in a submission of the consent step — the item, the version of its text (CONSENT_DOCUMENTS in
 * @buddha/shared, `version` at most CONSENT_VERSION_MAX_LENGTH), whether it was agreed (a required
 * item only ever is; the optional marketing item either way), when (the database clock), and the
 * client address and the browser's User-Agent it came with (the record's IP·기기 정보, #57-5).
 *
 * Append-only: buddha_app may INSERT and SELECT but never UPDATE (migration 0032), so the history
 * stays — an answer is changed by a newer row, and an account's standing consent and newest
 * answers are read from its newest row of each item (`readOnboarding`, one index lookup per item
 * however long the history grew). Rows outlive a withdrawal (`user` RESTRICT; #140 keeps the
 * account row) because consent records stay, operator-only, for the retention period of #57-18;
 * deleting them after it is #184's, which is why DELETE is not revoked.
 *
 * - `item`: one of CONSENT_ITEMS, checked here as the watch events check theirs.
 * - `client_ip`: the rate limit's reading of the client (`clientAddress`: behind Caddy the
 *   visitor, NULL for loopback and the web server), as the 본인확인 sends keep it (ADR-0070 7-22).
 * - `user_agent`: the header as it came, cut to CONSENT_USER_AGENT_MAX_LENGTH; NULL without one.
 */
export const consentRecords = pgTable(
  'consent_records',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    item: varchar({ length: 16 }).notNull(),
    version: varchar({ length: 32 }).notNull(),
    agreed: boolean().notNull(),
    createdAt: createdAt(),
    clientIp: inet(),
    userAgent: varchar({ length: 512 }),
  },
  (t) => [
    check('consent_records_item_check', sql`${t.item} IN ('terms', 'privacy', 'age', 'marketing')`),
    // An account's newest row of an item, found from the end of its entries (`readOnboarding`):
    // the read costs the same however many times an answer was changed.
    index('consent_records_user_id_item_id_idx').on(t.userId, t.item, t.id),
  ],
);
