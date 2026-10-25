import {
  PROPOSAL_BACKGROUND_MAX,
  PROPOSAL_NOTE_MAX,
  PROPOSAL_QUESTION_MAX,
  PROPOSAL_SOURCES_MAX,
  PROPOSAL_YES_CONDITION_MAX,
} from '@buddha/shared';
import { desc, sql } from 'drizzle-orm';
import { check, date, index, integer, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { categories } from './categories.js';
import { createdAt, timestampTz } from './columns.js';
import { marketProposalRejectionReasonEnum, marketProposalStatusEnum } from './enums.js';
import { markets } from './markets.js';

/**
 * 시장 제안 (#77, ADR-0069 decision 4 #77): one row per proposal a member submitted, with the
 * operators' review of it. What was submitted never changes (no edits), the status moves only
 * along PROPOSAL_TRANSITIONS (@buddha/shared) — 접수 → 검토 → 채택·반려, 접수 → 반려, 접수 → 철회 —
 * and 채택, 반려 and 철회 are final; triggers (migration 0046) hold both whoever writes, and the
 * CHECKs below tie each status to the columns it fills. The operators' internal memo, and once
 * the market of a 채택 that had none, are what change after a decision.
 *
 * - `phone_hash` is the keyed hash of the proposer's verified number when it proposed (HMAC under
 *   PHONE_HASH_KEY, apps/api identity/phone-hash.ts, ADR-0071): the pending and daily limits count
 *   by it, not by account, so an account made again on the same number carries on from the last
 *   one's count (ADR-0069 decision 7). Never shown to anyone, the proposer included.
 * - `deadline` is the date the result is to be known, a Korean calendar date.
 * - `review_started_*` is set by 검토 (and stays through the decision after it); `decided_*` by
 *   채택 or 반려; `retracted_at` by 철회. The admin screen shows who and when (검토 흐름·기록), and
 *   `admin_actions` keeps the same moves (`proposal_review`, `proposal_adopt`, `proposal_reject`).
 * - A 반려 keeps its reason, the explanation the proposer reads and, for a 중복 only, the existing
 *   market. A 채택 keeps the memo the proposer reads, if any, and the market it led to, if any — a
 *   draft made from it or an existing market.
 * - A 채택 with no market may take one later, once (owner decision 2026-10-19): `market_id` is
 *   set then with `market_linked_at`/`market_linked_by` (who and when, `proposal_link` in
 *   `admin_actions`), the status staying 채택. A market that came with the 채택 has no link time.
 *   That is the one change a 채택 allows besides the internal memo (the trigger).
 * - `internal_memo` is the operators' alone; no owner-only answer carries it.
 *
 * Accounts and markets are RESTRICT: an account row stays through a withdrawal (#140), and a
 * proposal still being reviewed is reviewed and recorded after it (ADR-0069 #140 row). buddha_app
 * keeps DELETE for #184, which removes a withdrawn account's proposals once their retention period
 * has passed (decision 7: not while they are still being processed). Categories are RESTRICT too:
 * one is retired by `is_active`, not deleted.
 */
export const marketProposals = pgTable(
  'market_proposals',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** Lower-case hex of HMAC-SHA256(PHONE_HASH_KEY, digits): 64 characters. */
    phoneHash: varchar({ length: 64 }).notNull(),
    question: varchar({ length: PROPOSAL_QUESTION_MAX }).notNull(),
    deadline: date({ mode: 'string' }).notNull(),
    yesCondition: varchar({ length: PROPOSAL_YES_CONDITION_MAX }).notNull(),
    expectedSources: varchar({ length: PROPOSAL_SOURCES_MAX }).notNull(),
    background: varchar({ length: PROPOSAL_BACKGROUND_MAX }),
    categoryId: integer().references(() => categories.id, { onDelete: 'restrict' }),
    status: marketProposalStatusEnum().notNull().default('submitted'),
    /** The database clock of the submission: the daily limit's window reads it. */
    createdAt: createdAt(),
    reviewStartedAt: timestampTz(),
    reviewStartedBy: text().references(() => user.id, { onDelete: 'restrict' }),
    /** The 채택 or 반려. */
    decidedAt: timestampTz(),
    decidedBy: text().references(() => user.id, { onDelete: 'restrict' }),
    retractedAt: timestampTz(),
    rejectionReason: marketProposalRejectionReasonEnum(),
    rejectionExplanation: varchar({ length: PROPOSAL_NOTE_MAX }),
    duplicateMarketId: uuid().references(() => markets.id, { onDelete: 'restrict' }),
    adoptionMemo: varchar({ length: PROPOSAL_NOTE_MAX }),
    marketId: uuid().references(() => markets.id, { onDelete: 'restrict' }),
    /** A market linked after the 채택, once (owner decision 2026-10-19): when, and by whom. */
    marketLinkedAt: timestampTz(),
    marketLinkedBy: text().references(() => user.id, { onDelete: 'restrict' }),
    internalMemo: varchar({ length: PROPOSAL_NOTE_MAX }),
  },
  (t) => [
    check('market_proposals_phone_hash_check', sql`${t.phoneHash} ~ '^[0-9a-f]{64}$'`),
    // The API trims; a blank required field is never a proposal, whoever writes it.
    check(
      'market_proposals_text_check',
      sql`btrim(${t.question}) <> '' AND btrim(${t.yesCondition}) <> '' AND btrim(${t.expectedSources}) <> '' AND btrim(${t.background}) IS DISTINCT FROM ''`,
    ),
    // Who and when come together, and each status has the moves that led to it: 검토 and 채택
    // passed through a review start, 접수 and 철회 did not, a 반려 may have or not; 채택 and 반려
    // are decided, nothing else is; only 철회 is retracted.
    check(
      'market_proposals_moves_check',
      sql`(${t.reviewStartedAt} IS NULL) = (${t.reviewStartedBy} IS NULL) AND (${t.decidedAt} IS NULL) = (${t.decidedBy} IS NULL) AND (${t.marketLinkedAt} IS NULL) = (${t.marketLinkedBy} IS NULL) AND (${t.reviewStartedAt} IS NOT NULL OR ${t.status} NOT IN ('reviewing', 'adopted')) AND (${t.reviewStartedAt} IS NULL OR ${t.status} NOT IN ('submitted', 'retracted')) AND (${t.decidedAt} IS NOT NULL) = (${t.status} IN ('adopted', 'rejected')) AND (${t.retractedAt} IS NOT NULL) = (${t.status} = 'retracted')`,
    ),
    // A 반려 has its reason and explanation, and a market exactly when the reason is 중복.
    check(
      'market_proposals_rejection_check',
      sql`(${t.rejectionReason} IS NOT NULL) = (${t.status} = 'rejected') AND (${t.rejectionReason} IS NULL) = (${t.rejectionExplanation} IS NULL) AND btrim(${t.rejectionExplanation}) IS DISTINCT FROM '' AND coalesce(${t.rejectionReason} = 'duplicate', false) = (${t.duplicateMarketId} IS NOT NULL)`,
    ),
    // Only a 채택 has a memo for the proposer or a market, and a later link has its market.
    check(
      'market_proposals_adoption_check',
      sql`(${t.status} = 'adopted' OR (${t.adoptionMemo} IS NULL AND ${t.marketId} IS NULL AND ${t.marketLinkedAt} IS NULL)) AND (${t.marketLinkedAt} IS NULL OR ${t.marketId} IS NOT NULL)`,
    ),
    check(
      'market_proposals_memo_check',
      sql`btrim(${t.adoptionMemo}) IS DISTINCT FROM '' AND btrim(${t.internalMemo}) IS DISTINCT FROM ''`,
    ),
    /** 내 제안: an account's proposals, newest first, with the row-comparison cursor. */
    index('market_proposals_user_id_created_at_id_idx').on(t.userId, desc(t.createdAt), desc(t.id)),
    /** The daily limit: a number's proposals of the last 24 hours. */
    index('market_proposals_phone_hash_created_at_idx').on(t.phoneHash, t.createdAt),
    /** The pending limit: a number's proposals waiting for the operators. */
    index('market_proposals_phone_hash_pending_idx')
      .on(t.phoneHash)
      .where(sql`${t.status} IN ('submitted', 'reviewing')`),
    /** The admin list, every status or one, newest first, with the row-comparison cursor. */
    index('market_proposals_created_at_id_idx').on(desc(t.createdAt), desc(t.id)),
    index('market_proposals_status_created_at_id_idx').on(t.status, desc(t.createdAt), desc(t.id)),
  ],
);
