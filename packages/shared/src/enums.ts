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
  /**
   * 탈퇴 소멸 (#140, ADR-0069 decision 1 #57-16): the Coin left on an account its member closes,
   * forfeited with the closure — the balance taken to 0 by an entry, never overwritten, so the
   * ledger still sums to the balance (PLAN 5.6). Written only by the closure (−amount_coin, ref
   * `account_closure` → the account itself), once per account, and nothing is written for the
   * account after it (migration 0043). Not trading loss (N02 §8).
   */
  'CLOSURE_FORFEIT',
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
  /**
   * A CLOSURE_FORFEIT entry's closed account (#140): `ref_id` is the account's own id, and
   * `profiles.closed_at` says when it closed — one entry per account (migration 0043).
   */
  'account_closure',
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
  /**
   * 테마 (#81): an admin made a theme — target `theme` / its id, payload `{slug, name, intro,
   * startDate, endDate}`, the dates as stored (Korean dates, `YYYY-MM-DD`) — in the transaction
   * that inserts the `themes` row. Every theme record below has the same target and records the
   * actor and the time alone: no reason, no second admin (ADR-0069 decision 4, the #81 '기록·승인'
   * row). Each is written only when its write changed something.
   */
  'theme_create',
  /**
   * The address (slug — it changes only until the first publish), the name, the introduction or
   * the period changed: payload `{before, after}`, the changed fields only, keyed as in
   * `theme_create`.
   */
  'theme_update',
  /** The theme became public (`published_at` set). No payload. */
  'theme_publish',
  /** The theme stopped being public (`published_at` cleared); it is never deleted. No payload. */
  'theme_unpublish',
  /** A market was put in the theme (a `theme_markets` row): payload `{themeId, marketId}`. */
  'theme_market_link',
  /** A market left the theme (its row deleted): the same payload. */
  'theme_market_unlink',
  /** A theme notice was written: payload `{noticeId, title, body}`. */
  'theme_notice_create',
  /**
   * A notice's title or body changed: payload `{noticeId, before, after}`, the changed fields —
   * the earlier text stays here, for admins only.
   */
  'theme_notice_update',
  /** A notice left the public page (`hidden_at` set); it is never deleted. Payload `{noticeId}`. */
  'theme_notice_hide',
  /** A hidden notice is shown again (`hidden_at` cleared). Payload `{noticeId}`. */
  'theme_notice_show',
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
  /**
   * An operator hid a 근거 글 (#50, ADR-0081): target `moderation_action` / the action's id, payload
   * `{actionId, postId, userId, reason, note, reportIds}` — the report reason picked, the
   * explanation shown to the author and the pending reports the hiding resolved. Written in the
   * transaction that sets `posts.hidden_at` and inserts the `moderation_actions` row.
   */
  'moderation_post_hide',
  /** The same for a 댓글 or a 대댓글 (#50): payload `{actionId, commentId, userId, reason, note, reportIds}`. */
  'moderation_comment_hide',
  /**
   * An operator warned a member (#50, #45-11: a record and the member's notice only): target
   * `moderation_action` / its id, payload `{actionId, userId, subject, reason, note, reportIds}`.
   */
  'moderation_warning',
  /**
   * An operator gave a member's nickname back to an auto nickname (#50, #37-10): payload
   * `{actionId, userId, reason, note, reportIds}`. The nickname taken away is kept for operators in
   * `profile_item_removals`, never here.
   */
  'moderation_nickname_reset',
  /** An operator emptied a member's 소개 (#50, #37-10): the same payload; the 소개 is kept apart. */
  'moderation_bio_clear',
  /**
   * An operator removed a member's profile image (#50, #37-10): the same payload; the image stays,
   * for operators only, in `profile_item_removals` and `media_objects`.
   */
  'moderation_image_remove',
  /**
   * An operator cancelled a moderation action, with a reason (#50): target `moderation_action` /
   * its id, payload `{actionId, type, userId, reason}`. A hiding's cancellation shows the item
   * again; the profile items are not restored (#37-10).
   */
  'moderation_cancel',
  /**
   * An operator dismissed reports (#50: 기각, nothing done to anyone): target null, payload
   * `{reportIds, reason}` — the reports, each pending until then, and the operator's reason.
   */
  'report_dismiss',
  /**
   * An operator put a member under a writing restriction (작성 제한, #185, ADR-0082): target
   * `moderation_action` / its id, payload `{actionId, userId, subject, days, endsAt, reason, note,
   * reportIds}` — the term picked (`days`, null for 무기한), the end it gave (null for 무기한), and
   * the pending reports on the subject it resolved, as a warning's.
   */
  'moderation_writing_restriction',
  /**
   * An operator brought a writing restriction's end forward (감경, #185 and #45-14): target
   * `moderation_action` / its id, payload `{actionId, userId, previousEndsAt, endsAt, reason}` —
   * the end before (null for 무기한) and after, and the operator's reason (operators only). Written
   * with the `restriction_end_changes` row.
   */
  'moderation_restriction_shorten',
  /**
   * An operator lifted a writing restriction early (조기 해제, #185 and #45-12): the same target and
   * payload as a shortening, `endsAt` being the lift's own time.
   */
  'moderation_restriction_lift',
  /**
   * An operator marked a group of the repeated-link review list '확인함' (#187, owner decision
   * 2026-10-22, ADR-0083): target `link` / the normalised url, payload `LinkFlagReviewPayload`
   * (rule, outcome, note, how many entries, `through`). Written in the transaction that sets those
   * entries' `link_flags.review_action_id` to this row, and only when it set at least one.
   */
  'link_flag_review',
  /**
   * An operator asked for an account restriction (계정 제한, #139, ADR-0085) — nothing is in force
   * until another admin approves it (ADR-0056 decision 1-7): target `approval_request` / the
   * request's id, payload `{requestId, userId, subject, days, reason, note, memo}` — the term asked
   * for (`days`, null for 무기한), the reason the member will read, the operators' own memo (null
   * for none; owner decision 2026-10-23) and what it is about (a post, a comment or the profile,
   * whose pending reports its approval resolves). Written in the transaction that inserts the
   * `approval_requests` row.
   */
  'account_restriction_request',
  /**
   * An operator asked for an account restriction's end to be brought forward (감경, #45-14): target
   * `approval_request` / the request's id, payload `{requestId, actionId, userId, endsAt, reason}`
   * — the end asked for and the reason (operators only).
   */
  'account_restriction_shorten_request',
  /**
   * An operator asked for an account restriction to be lifted early (조기 해제, #57-12): the same
   * target, payload `{requestId, actionId, userId, reason}`.
   */
  'account_restriction_lift_request',
  /**
   * An operator asked for an account restriction to be cancelled (취소, #50 and #45-14): the same
   * target and payload as a lift's.
   */
  'account_restriction_cancel_request',
  /**
   * Another admin approved an account restriction request, and what it asked for was done in the
   * same transaction: target `approval_request` / the request's id, payload `{requestId, change,
   * actionId, userId, reason, reportIds}` — `change` (`apply`, `shorten`, `lift`, `cancel`), the
   * restriction given or changed, the approver's reason, and the pending reports an approved
   * restriction resolved (none for a change).
   */
  'account_restriction_approve',
  /**
   * Another admin rejected an account restriction request, nothing done: the same target, payload
   * `{requestId, change, actionId, userId, reason}` (`actionId` null for a restriction never
   * given).
   */
  'account_restriction_reject',
  /**
   * The operator who asked for an account restriction step retracted the request before anyone
   * decided it (owner decision 2026-10-23, ADR-0085), nothing done: the same target, payload
   * `{requestId, change, actionId, userId}` (`actionId` null for an `apply`). The actor is the one
   * who asked — no one else retracts it.
   */
  'account_restriction_retract',
  /**
   * 시장 제안 (#77): an admin started reviewing a proposal (접수 → 검토). Target `market_proposal`
   * / its id, payload `{from, to}` (the statuses). Written in the transaction that moves the row,
   * as are the three below: the record of which operator did what when (ADR-0069 decision 4 #77,
   * 검토 흐름·기록), which the proposal's own columns repeat for the admin screen.
   */
  'proposal_review',
  /**
   * A proposal was adopted (검토 → 채택): payload `{from, to, marketId, marketCreated, memo}` — the
   * market linked (a draft made from the proposal, `marketCreated`, or an existing one) or none,
   * and the memo the proposer sees. A draft made here also writes its own `market_create`.
   */
  'proposal_adopt',
  /**
   * A proposal was rejected (접수 or 검토 → 반려): payload `{from, to, reason, explanation,
   * duplicateMarketId}`.
   */
  'proposal_reject',
  /**
   * The operators' internal memo on a proposal changed (never shown to the proposer): payload
   * `{before, after}`. Written only when the memo changed.
   */
  'proposal_memo',
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
 * (approvals.ts) — or until its requester retracts it, `retracted`, where its consumer allows
 * that (#139, ADR-0085; migration 0042): closed with no decision, decided by no one.
 */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'retracted'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES).meta({ id: 'ApprovalStatus' });

// ---- community moderation (#45-10, #50, #51) ---------------------------------------
/**
 * 신고 사유 (ADR-0069 decision 2 #45-10): the eight a report picks one of, in the owner's order —
 * N05 §5's six (스팸, 괴롭힘, 개인정보 노출, 사칭, 공모·조작 유도, 기타) with 시장과 무관 and 권리
 * 침해 (명예훼손·저작권) set apart from 기타. The same list names why an operator hid a post or a
 * comment: the reason a hiding carries is one of these and the operator's explanation, if any
 * (owner decision 2026-10-22, ADR-0080; `hiddenReasonSchema`, authored.ts). #50 takes reports with
 * them and records a hiding's in the Postgres enum `report_reason` built from this tuple (migration
 * 0039). Labels: copy.ts (`reportReason*`, the web's `reportReasonLabel`).
 */
export const REPORT_REASONS = [
  'spam',
  'harassment',
  'personal_info',
  'impersonation',
  'collusion_manipulation',
  'off_topic',
  'rights_infringement',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const reportReasonSchema = z.enum(REPORT_REASONS).meta({ id: 'ReportReason' });

/**
 * 계정 제한의 사유 (#139, ADR-0085; ADR-0069 decision 1 #57-12 «정한 목록에서 하나(스팸·괴롭힘·개인정보
 * 노출·사칭·공모·조작 유도·이상 거래·다계정·기타)와 필수 설명»), in the owner's order: N05 §5's six — the
 * report reasons' 공모·조작 유도 kept as the one reason REPORT_REASONS has — with 이상 거래 (abnormal
 * trading) and 다계정 (one person's several accounts) of N01 §8 and N02 §9, and without 시장과 무관
 * and 권리 침해, which the owner's list does not have. Every account restriction carries one, with
 * the operator's explanation the member reads (required, whatever the reason). Labels: copy.ts.
 */
export const ACCOUNT_RESTRICTION_REASONS = [
  'spam',
  'harassment',
  'personal_info',
  'impersonation',
  'collusion_manipulation',
  'abnormal_trading',
  'multi_account',
  'other',
] as const;
export type AccountRestrictionReason = (typeof ACCOUNT_RESTRICTION_REASONS)[number];
export const accountRestrictionReasonSchema = z
  .enum(ACCOUNT_RESTRICTION_REASONS)
  .meta({ id: 'AccountRestrictionReason' });

/**
 * Every reason an operator's action may carry (Postgres enum `report_reason`, whose values come in
 * this order — the report reasons of migration 0039, then the two only an account restriction
 * takes, added by migration 0042): a report's reason is one of REPORT_REASONS (the reports' CHECK),
 * every action but an account restriction carries one of REPORT_REASONS too, and an account
 * restriction one of ACCOUNT_RESTRICTION_REASONS (moderation_actions' CHECK).
 */
export const MODERATION_REASONS = [...REPORT_REASONS, 'abnormal_trading', 'multi_account'] as const;
export type ModerationReason = (typeof MODERATION_REASONS)[number];
export const moderationReasonSchema = z.enum(MODERATION_REASONS).meta({ id: 'ModerationReason' });

/**
 * What a report is about (#50, ADR-0081; Postgres enum `report_target_type`): a 근거 글, a comment
 * (`comment` — a 댓글 and a 대댓글 alike, #45-10 «근거 글·댓글·대댓글») or a member's public profile
 * (#37-10 «프로필도 신고 대상», its nickname, image and 소개 together). Nothing else takes a report:
 * not a notice (#45-8 «공지는 … 신고를 받지 않는다»), not a market proposal (#77).
 */
export const REPORT_TARGET_TYPES = ['post', 'comment', 'profile'] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];
export const reportTargetTypeSchema = z.enum(REPORT_TARGET_TYPES).meta({ id: 'ReportTargetType' });

/**
 * reports.status (Postgres enum `report_status`): a report waits as `pending` until an operator
 * processes it, once — `actioned` when an action was taken on what it reported, `dismissed` when
 * the operator closed it with nothing done (기각). The reporter sees 접수 and then 조치함 or 기각
 * (#45-13); the same person may report the same target again only once theirs is not pending
 * (ADR-0069 decision 7).
 */
export const REPORT_STATUSES = ['pending', 'actioned', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const reportStatusSchema = z.enum(REPORT_STATUSES).meta({ id: 'ReportStatus' });

/**
 * moderation_actions.type (#50, ADR-0081): what an operator did to a member, chosen by the
 * violation's weight (#45-11 «위반 정도에 맞춰 고른다», never step by step and never by a count of
 * reports):
 * - `hide`: a 근거 글 or a comment hidden (#45-5, reversible by cancelling it);
 * - `warning`: a record and the member's notice only (#45-11);
 * - `nickname_reset`, `bio_clear`, `image_remove`: a public profile item taken away (#37-10: the
 *   nickname back to an auto nickname, the 소개 emptied, the image removed — kept for operators,
 *   never restored).
 * - `writing_restriction`: 작성 제한 (#185, ADR-0082; N05 §5 '댓글 제한', ADR-0069 decision 2
 *   #45-12): no new post, comment or 대댓글 and no edit of one's own, nor a new value of a public
 *   profile item (#37-9), until it ends — 1, 3, 7 or 30 days or 무기한 (`ends_at` null). Deleting
 *   one's own, likes and reports stay open.
 * - `account_restriction`: 계정 제한 (#139, ADR-0085; ADR-0069 decision 1 #57-12, #57-13, decision 3
 *   #37-9, decision 4 #139 and #140 rows): no trading — no new order, the check #119 calls
 *   (`assertCanTrade`) — no market proposal (#77), no new value of a public profile item (#37-9)
 *   and no 탈퇴 (#140) until it ends, a term or 무기한 (`ends_at` null); community writing, likes,
 *   reports and the 관심 등록 stay open. Given, lifted early, shortened (감경) and cancelled only
 *   once another admin approved it (ADR-0056 decision 1-7, `approval_requests`).
 * Stored as a varchar with a CHECK rather than a Postgres enum, so the migration that adds a type
 * can use it in the same batch (drizzle runs a batch in one transaction, where a value an `ADD
 * VALUE` added cannot be used — 55P04, migration 0014; migrations 0040 and 0042 added
 * `writing_restriction` and `account_restriction` so).
 */
export const MODERATION_ACTION_TYPES = [
  'hide',
  'warning',
  'nickname_reset',
  'bio_clear',
  'image_remove',
  'writing_restriction',
  'account_restriction',
] as const;
export type ModerationActionType = (typeof MODERATION_ACTION_TYPES)[number];
export const moderationActionTypeSchema = z
  .enum(MODERATION_ACTION_TYPES)
  .meta({ id: 'ModerationActionType' });

/**
 * restriction_end_changes.kind (#185, ADR-0082): how an operator brought a writing restriction's
 * end forward — `shorten` (감경, #45-14: «종료 시각을 앞당기는 기능», 무기한 to a term included) to a
 * later instant, or `lift` (조기 해제, #45-12: «운영자가 일찍 풀 수 있다») at once. Either keeps the
 * action as it was given (its reason, its time); a cancellation (취소) voids it instead.
 */
export const RESTRICTION_END_CHANGE_KINDS = ['shorten', 'lift'] as const;
export type RestrictionEndChangeKind = (typeof RESTRICTION_END_CHANGE_KINDS)[number];
export const restrictionEndChangeKindSchema = z
  .enum(RESTRICTION_END_CHANGE_KINDS)
  .meta({ id: 'RestrictionEndChangeKind' });

// ---- market proposals (#77) ---------------------------------------------------------
/**
 * market_proposals.status (Postgres enum `market_proposal_status`), the five statuses of a 시장
 * 제안 (ADR-0069 decision 4 #77): 접수 (`submitted`, where every proposal starts), 검토
 * (`reviewing`), 채택 (`adopted`), 반려 (`rejected`) and 철회 (`retracted`, the fifth: the proposer
 * took it back while it was 접수). The moves are 접수 → 검토 → 채택·반려, 접수 → 반려 and 접수 → 철회;
 * 채택, 반려 and 철회 are final (PROPOSAL_TRANSITIONS, proposals.ts). Not `withdrawn`: that word is
 * the cash-out's in the excluded-feature guard (guards/excluded.ts), which reads every stored name
 * and route path.
 */
export const PROPOSAL_STATUSES = [
  'submitted',
  'reviewing',
  'adopted',
  'rejected',
  'retracted',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const proposalStatusSchema = z.enum(PROPOSAL_STATUSES).meta({ id: 'ProposalStatus' });

/**
 * market_proposals.rejection_reason (Postgres enum `market_proposal_rejection_reason`): the list a
 * 반려 picks one from (ADR-0069 decision 4 #77, 사유) — 중복 (`duplicate`, with the existing
 * market), 판정 기준이 모호함 (`ambiguous_criteria`), 개설 금지 주제 (`prohibited_topic`) and 기타
 * (`other`). The explanation the proposer reads goes with every one of them.
 */
export const PROPOSAL_REJECTION_REASONS = [
  'duplicate',
  'ambiguous_criteria',
  'prohibited_topic',
  'other',
] as const;
export type ProposalRejectionReason = (typeof PROPOSAL_REJECTION_REASONS)[number];
export const proposalRejectionReasonSchema = z
  .enum(PROPOSAL_REJECTION_REASONS)
  .meta({ id: 'ProposalRejectionReason' });

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
