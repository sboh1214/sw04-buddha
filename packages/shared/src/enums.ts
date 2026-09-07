/**
 * Domain enumerations (PLAN 5.6, 6.2). Single source of truth for
 * - packages/db `pgEnum()` values (the Postgres enum types are built from these tuples),
 * - API DTOs (`z.enum(...)` schemas below),
 * - UI option lists.
 *
 * Adding a value here does NOT alter the database by itself: run `pnpm db:generate` so
 * drizzle-kit emits the matching `ALTER TYPE ... ADD VALUE` migration.
 */
import * as z from 'zod';

// ---- users -------------------------------------------------------------------------
export const ROLES = ['user', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES).meta({ id: 'UserRole' });

// ---- ledger (PLAN 5.6) --------------------------------------------------------------
export const LEDGER_ENTRY_TYPES = [
  'DEPOSIT',
  'TRADE_BUY',
  'TRADE_SELL',
  'FEE',
  'SETTLEMENT_PAYOUT',
  'MARKET_VOID_REFUND',
  'ADMIN_ADJUST',
  'BONUS',
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];
export const ledgerEntryTypeSchema = z.enum(LEDGER_ENTRY_TYPES);

/** ledger_entries.ref_type (varchar, not a Postgres enum): what ref_id points at. */
export const LEDGER_REF_TYPES = ['payment', 'fill', 'market', 'admin_action', 'coupon'] as const;
export type LedgerRefType = (typeof LEDGER_REF_TYPES)[number];
export const ledgerRefTypeSchema = z.enum(LEDGER_REF_TYPES);

// ---- payments -----------------------------------------------------------------------
export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

/** payments.provider (varchar). Only the mock provider exists in the MVP (PLAN 1.2). */
export const PAYMENT_PROVIDERS = ['mock'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

// ---- markets (PLAN 5.2) -------------------------------------------------------------
/** PLAN 16: the engine behind a market; `MarketMechanism` in mechanism.ts is the interface. */
/** PLAN 16: which engine prices a market. `MarketMechanism` (mechanism.ts) is the interface. */
export const MARKET_MECHANISMS = ['lmsr', 'clob'] as const;
export type MarketMechanismKind = (typeof MARKET_MECHANISMS)[number];
export const marketMechanismSchema = z.enum(MARKET_MECHANISMS);

export const MARKET_STATUSES = [
  'draft',
  'open',
  'closed',
  'resolving',
  'settled',
  'voided',
] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];
export const marketStatusSchema = z.enum(MARKET_STATUSES);

export const MARKET_VISIBILITIES = ['public', 'group'] as const;
export type MarketVisibility = (typeof MARKET_VISIBILITIES)[number];
export const marketVisibilitySchema = z.enum(MARKET_VISIBILITIES);

/** Binary markets only (PLAN 5.2). PLAN 16: swap this tuple when multi-outcome arrives. */
export const OUTCOMES = ['YES', 'NO'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const outcomeSchema = z.enum(OUTCOMES);

/** market_events.type (varchar(40), PLAN 6.2). */
export const MARKET_EVENT_TYPES = [
  'created',
  'opened',
  'closed',
  'resolve_proposed',
  'result_changed',
  'finalized',
  'voided',
  'rules_edited',
] as const;
export type MarketEventType = (typeof MARKET_EVENT_TYPES)[number];
export const marketEventTypeSchema = z.enum(MARKET_EVENT_TYPES);

// ---- orders / fills (PLAN 6.2, CLOB-ready) ------------------------------------------
export const ORDER_SIDES = ['buy', 'sell'] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];
export const orderSideSchema = z.enum(ORDER_SIDES);

export const ORDER_TYPES = ['market', 'limit'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];
export const orderTypeSchema = z.enum(ORDER_TYPES);

export const ORDER_STATUSES = [
  'open',
  'partially_filled',
  'filled',
  'cancelled',
  'rejected',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const orderStatusSchema = z.enum(ORDER_STATUSES);

export const TIME_IN_FORCES = ['ioc', 'gtc'] as const;
export type TimeInForce = (typeof TIME_IN_FORCES)[number];
export const timeInForceSchema = z.enum(TIME_IN_FORCES);

export const COUNTERPARTY_TYPES = ['amm', 'order'] as const;
export type CounterpartyType = (typeof COUNTERPARTY_TYPES)[number];
export const counterpartyTypeSchema = z.enum(COUNTERPARTY_TYPES);

// ---- price ticks --------------------------------------------------------------------
export const PRICE_TICK_TRIGGERS = ['trade', 'open', 'resolve'] as const;
export type PriceTickTrigger = (typeof PRICE_TICK_TRIGGERS)[number];
export const priceTickTriggerSchema = z.enum(PRICE_TICK_TRIGGERS);

// ---- disputes (PLAN 5.5) ------------------------------------------------------------
export const DISPUTE_STATUSES = ['open', 'accepted', 'rejected'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export const disputeStatusSchema = z.enum(DISPUTE_STATUSES);

// ---- admin / audit (varchar columns, PLAN 6.2) --------------------------------------
export const ADMIN_ACTION_TYPES = [
  'balance_adjust',
  'charge_package_create',
  'charge_package_update',
  'charge_package_delete',
  'coupon_create',
  'coupon_update',
  'market_create',
  'market_update',
  'market_open',
  'market_close',
  'market_resolve',
  'market_void',
  'dispute_review',
] as const;
export type AdminActionType = (typeof ADMIN_ACTION_TYPES)[number];
export const adminActionTypeSchema = z.enum(ADMIN_ACTION_TYPES);

export const AUDIT_FAILURE_KINDS = ['ledger_balance_mismatch'] as const;
export type AuditFailureKind = (typeof AUDIT_FAILURE_KINDS)[number];
export const auditFailureKindSchema = z.enum(AUDIT_FAILURE_KINDS);

/** Seed categories (PLAN 1.3, 6.2). Never sports or elections (PLAN 0.2). */
export const CATEGORY_SLUGS = ['economy', 'culture', 'entertainment', 'tech', 'weather'] as const;
export type CategorySlug = (typeof CATEGORY_SLUGS)[number];
export const categorySlugSchema = z.enum(CATEGORY_SLUGS);
