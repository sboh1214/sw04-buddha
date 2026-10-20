/**
 * Domain enumerations (PLAN 5.6, 6.2). Single source of truth for
 * - packages/db `pgEnum()` values (the Postgres enum types are built from these tuples),
 * - API DTOs (`z.enum(...)` schemas below),
 * - UI option lists.
 *
 * Adding a value here does NOT alter the database by itself: run `pnpm db:generate` so
 * drizzle-kit emits the matching `ALTER TYPE ... ADD VALUE` migration. Removing one means
 * recreating the Postgres type, which only an emptied table makes safe (migration 0017).
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
  'ADMIN_ADJUST',
  /**
   * A redeemed coupon (ADR-0026, kept while paid Coin is closed, D9). Accounts created before
   * #70 also carry the old sign-up grant under it; new accounts never get one (ADR-0071).
   */
  'BONUS',
  /**
   * An admin refund claws back a charge's Coin (−amount_coin, ref payment) before the PG cancel.
   */
  'PAYMENT_CANCEL',
  /**
   * Puts that Coin back (+amount_coin, ref payment) when the PG refused the cancel. Written only
   * after a PAYMENT_CANCEL of the same payment, so the ledger shows both halves.
   */
  'PAYMENT_CANCEL_REVERSAL',
  /**
   * 시작 지급 (#70, ADR-0069 decision 4 #70, ADR-0071): the start Coin a verified phone number
   * gets once — new issuance with its own type, never `BONUS`, which coupons share. Written only
   * by the start grant (+amount_coin, ref `start_grant` → start_grants.id). Not trading profit
   * (N02 §8): nothing that computes PnL reads the ledger.
   */
  'START_GRANT',
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];
export const ledgerEntryTypeSchema = z.enum(LEDGER_ENTRY_TYPES);

/** ledger_entries.ref_type (varchar, not a Postgres enum): what ref_id points at. */
export const LEDGER_REF_TYPES = [
  'payment',
  'fill',
  'market',
  'admin_action',
  'coupon',
  /** A START_GRANT entry's start_grants row (#70, ADR-0071). */
  'start_grant',
] as const;
export type LedgerRefType = (typeof LEDGER_REF_TYPES)[number];
export const ledgerRefTypeSchema = z.enum(LEDGER_REF_TYPES);

// ---- payments -----------------------------------------------------------------------
/**
 * payments.status (ADR-0042). Appended in lifecycle order; a Postgres enum only grows.
 * - `pending`: reserved, waiting for the PG (or an approval in flight / outcome unknown)
 * - `succeeded`: approved and credited
 * - `failed`: refused, stopped by the payer, or never approved — no money moved
 * - `cancelled`: approved by the PG but net-cancelled by us before any Coin was credited
 * - `refunding`: admin refund in progress — Coin already clawed back, PG cancel not yet confirmed
 * - `refunded`: admin refund done — card cancelled, Coin clawed back
 */
export const PAYMENT_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'refunding',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

/**
 * payments.provider (varchar): `mock` succeeds immediately (PLAN 1.2). The SmartroPay
 * integration (`smartro`, ADR-0042) was removed before any real payment (ADR-0049); the next PG
 * joins this tuple. The API's PAYMENT_PROVIDER env picks which one takes new charges; a refund
 * follows the provider recorded on the row.
 */
export const PAYMENT_PROVIDERS = ['mock'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];
export const paymentProviderSchema = z.enum(PAYMENT_PROVIDERS);

/**
 * payment_events.type (varchar(32), append-only): one row per exchange with the PG, so an
 * outcome can be reconstructed without reading logs (ADR-0042). Only `refund_cancel` is written
 * today; the others are the payment-window flow a redirect PG brings (kept for the next one,
 * ADR-0049).
 * - `return`: the browser came back from the payment window
 * - `approval` / `approval_inquiry`: the approval call and its result inquiry
 * - `stop`: the payer closed the payment window
 * - `notify`: the PG's server-to-server notice (재통보)
 * - `net_cancel`: we cancelled an approval we could not credit (망취소); `payload.outcome` is
 *   `cancelled`, `refused` or `unknown`
 * - `refund_cancel`: the PG cancel of an admin refund
 */
export const PAYMENT_EVENT_TYPES = [
  'return',
  'approval',
  'approval_inquiry',
  'stop',
  'notify',
  'net_cancel',
  'refund_cancel',
] as const;
export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];
export const paymentEventTypeSchema = z.enum(PAYMENT_EVENT_TYPES);

// ---- markets (PLAN 5.2) -------------------------------------------------------------
/**
 * Market lifecycle (GD 01-01 §8, O-5~O-7, ADR-0046): `closed` → `resolved` is the admin's
 * judgement, final at once (no dispute stage); `resolved` → `settled` is the worker finishing
 * every SETTLEMENT_STEPS step. The Postgres label `resolved` is M5's dispute-stage label renamed
 * in place (migration 0016), so the enum keeps this order.
 */
export const MARKET_STATUSES = [
  'draft',
  'open',
  'closed',
  'resolved',
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
  /** Legacy (M5 dispute flow, before ADR-0046): no longer written, kept to read old rows. */
  'resolve_proposed',
  /** Legacy (M5 dispute flow, before ADR-0046): no longer written, kept to read old rows. */
  'result_changed',
  'finalized',
  'voided',
  'rules_edited',
  /** closed → resolved: the admin's judgement, payload `{result, note, evidenceUrl}`. */
  'resolved',
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

/** fills.counterparty_type: the resting order a fill matched (#119 shapes the CLOB fills). */
export const COUNTERPARTY_TYPES = ['order'] as const;
export type CounterpartyType = (typeof COUNTERPARTY_TYPES)[number];
export const counterpartyTypeSchema = z.enum(COUNTERPARTY_TYPES);

// ---- price ticks --------------------------------------------------------------------
/**
 * `'trade'` is a fill's tick. Nothing is written when a market opens (#125): before its first
 * fill a market has no price to chart (N02 §5). `'resolve'` is RESERVED and nothing writes it
 * (M6 review, A-M6-6). It is kept rather than removed because Q-M5-4 — whether a settled market
 * should get a 100%/0% tick so the chart ends on the result — is an open owner question whose
 * answer would need exactly this value, and dropping it would cost a Postgres enum migration
 * to add back.
 */
export const PRICE_TICK_TRIGGERS = ['trade', 'resolve'] as const;
export type PriceTickTrigger = (typeof PRICE_TICK_TRIGGERS)[number];
export const priceTickTriggerSchema = z.enum(PRICE_TICK_TRIGGERS);

// ---- settlement steps (O-6, ADR-0046) -----------------------------------------------
/**
 * market_settlement_steps.step (varchar, not a Postgres enum): the steps that must ALL finish
 * before a `resolved` market becomes `settled` (O-6), run in this order. `coin` pays out the
 * positions. A step added later is appended here — a varchar column, so it needs no enum
 * migration.
 */
export const SETTLEMENT_STEPS = ['coin'] as const;
export type SettlementStep = (typeof SETTLEMENT_STEPS)[number];
export const settlementStepSchema = z.enum(SETTLEMENT_STEPS).meta({ id: 'SettlementStep' });

/**
 * market_settlement_steps.status (varchar). `pending` from the judgement until the step runs;
 * `done` once it committed (`completed_at` set); `failed` when its last attempt rolled back
 * (`last_error` says why) — the per-minute scan retries a failed step without a cap.
 */
export const SETTLEMENT_STEP_STATUSES = ['pending', 'done', 'failed'] as const;
export type SettlementStepStatus = (typeof SETTLEMENT_STEP_STATUSES)[number];
export const settlementStepStatusSchema = z
  .enum(SETTLEMENT_STEP_STATUSES)
  .meta({ id: 'SettlementStepStatus' });

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
  /**
   * Two markets became related (#65, ADR-0068): target `market` / the market the admin linked
   * from, payload `{marketId, relatedMarketId}` — both ends, since the link is one row for the
   * pair and shows on both details. Written in the transaction that inserts the
   * `market_links` row, and only when it did (a repeated link writes nothing). Actor and time
   * only: no reason, no second admin (ADR-0061 decision 1, item 19).
   */
  'market_link',
  /** The link ended (#65): the same target and payload, written only when a row was deleted. */
  'market_unlink',
  'payment_refund',
  /**
   * A release setting's status and value changed (#170): target `release_setting` / its key,
   * payload `{key, before: {status, value}, after: {status, value}, reason}`. A constraint
   * trigger (migration 0020) refuses a release_settings write without this row.
   */
  'release_setting_change',
  /**
   * An account received the admin role (#171): target `user` / its id, payload `{reason}`,
   * written in the transaction that sets `profiles.role`. The seed's bootstrap admins record
   * themselves as the actor with the reason '시드'.
   */
  'admin_grant',
  /**
   * An account lost the admin role (#171): target `user` / its id, payload `{reason}`, written in
   * the transaction that resets `profiles.role` and deletes the account's sessions.
   */
  'admin_revoke',
  /**
   * 운영 공지 (#138, ADR-0069 decision 4: the admin and the time of every write, pin and unpin,
   * no reason): a notice was written — target `notice` / its id, no payload. Written in the
   * transaction that inserts the `notices` row. A new notice is not pinned.
   */
  'notice_create',
  /**
   * A notice's title or body changed: target `notice` / its id, payload `{revisionId}` — the
   * `notice_revisions` row that keeps the version it replaced (the operators' history, #138).
   * Written only when something changed, in the transaction that writes both.
   */
  'notice_update',
  /**
   * A notice was pinned above the community list: target `notice` / its id, no payload. Written
   * only when it was not pinned already, in the transaction that pins it.
   */
  'notice_pin',
  /** A notice was unpinned: the same target, written only when it was pinned. */
  'notice_unpin',
] as const;
export type AdminActionType = (typeof ADMIN_ACTION_TYPES)[number];
export const adminActionTypeSchema = z.enum(ADMIN_ACTION_TYPES);

export const AUDIT_FAILURE_KINDS = ['ledger_balance_mismatch'] as const;
export type AuditFailureKind = (typeof AUDIT_FAILURE_KINDS)[number];
export const auditFailureKindSchema = z.enum(AUDIT_FAILURE_KINDS);

// ---- release settings (#170) --------------------------------------------------------
/**
 * release_settings.status (Postgres enum `release_setting_status`): how far a release setting's
 * value is settled. `undecided` holds no value; the other three hold one. `proposal` is a design
 * proposal and `test` a value for internal testing before the release value exists — neither is
 * shown as settled (N01 §10). Labels: RELEASE_SETTING_STATUS_LABELS (release-settings.ts).
 */
export const RELEASE_SETTING_STATUSES = ['undecided', 'proposal', 'test', 'approved'] as const;
export type ReleaseSettingStatus = (typeof RELEASE_SETTING_STATUSES)[number];
export const releaseSettingStatusSchema = z
  .enum(RELEASE_SETTING_STATUSES)
  .meta({ id: 'ReleaseSettingStatus' });

// ---- two-person rule (#171) ---------------------------------------------------------
/**
 * approval_requests.status (Postgres enum `approval_status`): a request waits as `pending` until
 * an admin other than its requester decides it, once, as `approved` or `rejected`
 * (approvals.ts).
 */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES).meta({ id: 'ApprovalStatus' });

/**
 * Seed categories (PLAN 1.3, 6.2): the five TOP-LEVEL slugs. Never sports or elections
 * (PLAN 0.2). These are the second row of the header and, through their leaves, the home
 * screen's sub-category sidebar.
 */
export const CATEGORY_SLUGS = ['economy', 'culture', 'entertainment', 'tech', 'weather'] as const;
export type CategorySlug = (typeof CATEGORY_SLUGS)[number];
export const categorySlugSchema = z.enum(CATEGORY_SLUGS);

/**
 * The second level (Kalshi's "Economics → Housing / Jobs / Inflation" shape): each top-level
 * category's sub-categories, in display order. A market is filed under ONE of these leaves — a
 * card's header names the leaf, and `GET /markets?category=economy` lists every leaf under it.
 *
 * Two levels and no more: `categories.parent_id` points at a top-level row, and nothing here or
 * in the seed makes a leaf a parent. The slugs are unique ACROSS the whole tree, not just within
 * a parent, because `?category=<slug>` names one row without saying which level it is on.
 * Never sports or elections here either (PLAN 0.2).
 */
export const SUBCATEGORY_SLUGS = {
  economy: ['housing', 'jobs', 'fx', 'rates', 'prices'],
  culture: ['books', 'exhibitions', 'performances', 'food'],
  entertainment: ['movies', 'music', 'tv', 'games'],
  tech: ['ai', 'devices', 'semiconductors', 'space'],
  weather: ['temperature', 'rain', 'typhoons', 'air-quality'],
} as const satisfies Record<CategorySlug, readonly string[]>;
export type SubcategorySlug = (typeof SUBCATEGORY_SLUGS)[CategorySlug][number];
/** Every slug on either level: what a seeded market's `category` may name. */
export const ALL_CATEGORY_SLUGS = [
  ...CATEGORY_SLUGS,
  ...Object.values(SUBCATEGORY_SLUGS).flat(),
] as const;
export type AnyCategorySlug = (typeof ALL_CATEGORY_SLUGS)[number];
