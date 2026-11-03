/**
 * Postgres enum types. Values come from @buddha/shared so DTOs, UI and DB agree (PLAN 4.1:
 * db may depend on shared, never the reverse). Type names are given explicitly; `casing` in
 * drizzle.config.ts only affects column names.
 */
import {
  APPROVAL_STATUSES,
  COUNTERPARTY_TYPES,
  LEDGER_ENTRY_TYPES,
  MARKET_RESULTS,
  MARKET_STATUSES,
  MARKET_VISIBILITIES,
  ORDER_SIDES,
  ORDER_STATUSES,
  ORDER_TYPES,
  OUTCOMES,
  PAYMENT_STATUSES,
  PRICE_TICK_TRIGGERS,
  MODERATION_REASONS,
  PROPOSAL_REJECTION_REASONS,
  PROPOSAL_STATUSES,
  RELEASE_SETTING_STATUSES,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  ROLES,
  TIME_IN_FORCES,
} from '@buddha/shared';
import { pgEnum } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ROLES);
export const ledgerEntryTypeEnum = pgEnum('ledger_entry_type', LEDGER_ENTRY_TYPES);
export const paymentStatusEnum = pgEnum('payment_status', PAYMENT_STATUSES);
export const marketStatusEnum = pgEnum('market_status', MARKET_STATUSES);
export const marketVisibilityEnum = pgEnum('market_visibility', MARKET_VISIBILITIES);
export const outcomeEnum = pgEnum('outcome', OUTCOMES);
/** A market's result type, apart from the contract side `outcome` (#174, migration 0048). */
export const marketResultEnum = pgEnum('market_result', MARKET_RESULTS);
export const orderSideEnum = pgEnum('order_side', ORDER_SIDES);
export const orderTypeEnum = pgEnum('order_type', ORDER_TYPES);
export const orderStatusEnum = pgEnum('order_status', ORDER_STATUSES);
export const timeInForceEnum = pgEnum('time_in_force', TIME_IN_FORCES);
export const counterpartyTypeEnum = pgEnum('counterparty_type', COUNTERPARTY_TYPES);
export const priceTickTriggerEnum = pgEnum('price_tick_trigger', PRICE_TICK_TRIGGERS);
export const releaseSettingStatusEnum = pgEnum('release_setting_status', RELEASE_SETTING_STATUSES);
export const approvalStatusEnum = pgEnum('approval_status', APPROVAL_STATUSES);
/**
 * 신고 사유 (#45-10): a report's reason, and the reason every moderation action carries (#50) —
 * with the two only an account restriction takes (#139, ADR-0069 decision 1 #57-12: 이상 거래 and
 * 다계정), added by migration 0042 at the end (MODERATION_REASONS). The tables' CHECKs hold a
 * report and every other action to REPORT_REASONS (migration 0042).
 */
export const reportReasonEnum = pgEnum('report_reason', MODERATION_REASONS);
export const reportTargetTypeEnum = pgEnum('report_target_type', REPORT_TARGET_TYPES);
export const reportStatusEnum = pgEnum('report_status', REPORT_STATUSES);
/** 시장 제안 (#77): a proposal's status and a 반려's reason (PROPOSAL_STATUSES, enums.ts). */
export const marketProposalStatusEnum = pgEnum('market_proposal_status', PROPOSAL_STATUSES);
export const marketProposalRejectionReasonEnum = pgEnum(
  'market_proposal_rejection_reason',
  PROPOSAL_REJECTION_REASONS,
);
