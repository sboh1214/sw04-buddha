/**
 * Postgres enum types. Values come from @buddha/shared so DTOs, UI and DB agree (PLAN 4.1:
 * db may depend on shared, never the reverse). Type names are given explicitly; `casing` in
 * drizzle.config.ts only affects column names.
 */
import {
  COUNTERPARTY_TYPES,
  LEDGER_ENTRY_TYPES,
  MARKET_STATUSES,
  MARKET_VISIBILITIES,
  ORDER_SIDES,
  ORDER_STATUSES,
  ORDER_TYPES,
  OUTCOMES,
  PAYMENT_STATUSES,
  PRICE_TICK_TRIGGERS,
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
export const orderSideEnum = pgEnum('order_side', ORDER_SIDES);
export const orderTypeEnum = pgEnum('order_type', ORDER_TYPES);
export const orderStatusEnum = pgEnum('order_status', ORDER_STATUSES);
export const timeInForceEnum = pgEnum('time_in_force', TIME_IN_FORCES);
export const counterpartyTypeEnum = pgEnum('counterparty_type', COUNTERPARTY_TYPES);
export const priceTickTriggerEnum = pgEnum('price_tick_trigger', PRICE_TICK_TRIGGERS);
