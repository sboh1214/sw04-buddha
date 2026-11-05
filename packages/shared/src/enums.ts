/**
 * Domain enumerations (PLAN 5.6, 6.2). Single source of truth for
 * - packages/db `pgEnum()` values (the Postgres enum types are built from these tuples),
 * - API DTOs (`z.enum(...)` schemas below),
 * - UI option lists.
 *
 * Adding a value here does NOT alter the database by itself: run `pnpm db:generate` so
 * drizzle-kit emits the matching `ALTER TYPE ... ADD VALUE` migration. Removing one means
 * recreating the Postgres type, which only an emptied table makes safe (migrations 0017, 0060).
 */
import * as z from 'zod';

// ---- users -------------------------------------------------------------------------
export const ROLES = ['user', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES).meta({ id: 'UserRole' });

/**
 * Account types (ADR-0107 결정 4 #115): '일반 사용자' (`member`) and '운영 마켓메이커'
 * (`market_maker`), nothing else — no test-account type and no system type (the treasury and the
 * collateral are ledger accounts, #116, not accounts of a kind). Fixed when the account is made
 * (`user.account_type`, migration 0059) and separate from the admin role above: an admin is a
 * member. Whether an account is a person's is asked of `isHumanAccountType` (account-types.ts),
 * never of a value here. No public or admin answer carries it (PRIVATE_DATA `account-type`).
 */
export const ACCOUNT_TYPES = ['member', 'market_maker'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

// ---- ledger (PLAN 5.6, #116) --------------------------------------------------------
/**
 * Ledger event types (ADR-0107 결정 2 #73 1·2·15·16항, ADR-0109): one per source of a move
 * between ledger accounts (LEDGER_ACCOUNT_KINDS below). Which accounts each moves Coin between,
 * and which ones mint or burn, is LEDGER_ENTRY_RULES (ledger.ts), which the database repeats
 * (`ledger_entry_direction_allowed`, migration 0060). Migration 0060 recreated the Postgres type
 * on the emptied database (#116, as 0017 did for #125) — ADMIN_ADJUST, TRADE_BUY, TRADE_SELL and
 * FEE went —, so this order is 0060's; from here on it only appends again (ADR-0042). No FEE type
 * while fees are 0 (15항), no generic burn (16항), no test-only value (7항); 재지급 and 판정 오류
 * 보상 come with #74 and #144. Names avoid the excluded storage tokens (`transfer`, `reward`, …).
 */
export const LEDGER_ENTRY_TYPES = [
  /**
   * 시작 지급 (#70, ADR-0071; ADR-0107 결정 5): the start Coin a verified phone number gets once,
   * minted straight into the account's user ledger account — never `BONUS`, which coupons share.
   * Written only by the start grant (ref `start_grant` → start_grants.id). Not trading profit
   * (N02 §8): nothing that computes PnL reads the ledger.
   */
  'START_GRANT',
  /** 금고 발행 (#73 4·5항): minted into the operating treasury. #129 writes it, approved by two. */
  'TREASURY_MINT',
  /** 봇 배정 (#73 1항, 운영금 이전): treasury → a market's 마켓메이커 자금, at the open and on 증액. */
  'BOT_ALLOCATION',
  /** 봇 회수 (#73 1항, 운영금 이전): a market's 마켓메이커 자금 → treasury (#181). */
  'BOT_RECALL',
  /**
   * 쌍 발행 담보 (#73 1항): a buyer's locked Coin → the market's collateral, 100 per pair between
   * the two buyers (`applyPairMintFill`, #118; #119 calls it at a fill of two opposite buys).
   */
  'PAIR_MINT_COLLATERAL',
  /**
   * 쌍 소각 반환 (#73 1·12항, #177 6항): collateral → the owner of the burned pair, which is only
   * the bot's automatic burn today (`burnMarketMakerPairs`, #118; #129 calls it) — so never a user
   * ledger account.
   */
  'PAIR_BURN_RETURN',
  /** 체결 대금 (#73 1항): buyer → seller, the only move between two holders (#119). */
  'TRADE_FILL',
  /** 정산 지급 (#73 1항): a market's collateral → a holder, VOID's 50·50 too (#126). */
  'SETTLEMENT_PAYOUT',
  /**
   * 탈퇴 소멸 (#140, ADR-0069 decision 1 #57-16): the Coin left on an account its member closes,
   * burned with the closure — the only real burn (#73 16항). Written only by the closure (ref
   * `account_closure` → the account itself), once per account, and nothing is written for the
   * account after it (migrations 0043, 0060). Not trading loss (N02 §8).
   */
  'CLOSURE_FORFEIT',
  /**
   * 대사 정정 (#73 10항): the only way a reconciliation difference is fixed, against the operating
   * treasury, referring to its `audit_failures` row and approved by a second admin (#93). Never
   * takes Coin from a user and never undoes a paid settlement (N03 §7).
   */
  'RECONCILIATION_CORRECTION',
  /**
   * The kept paid-Coin and coupon types (D9, ADR-0049; #73 2항: '보존·비활성'): a charge's Coin,
   * a redeemed coupon's (BONUS), an admin refund's clawback before the PG cancel (PAYMENT_CANCEL)
   * and its return when the PG refused the cancel (PAYMENT_CANCEL_REVERSAL, written only after a
   * PAYMENT_CANCEL of the same payment). Mints into, or (the cancel) burns from, the user ledger
   * account, so #93's totals still agree if sales reopen (#111).
   */
  'DEPOSIT',
  'BONUS',
  'PAYMENT_CANCEL',
  'PAYMENT_CANCEL_REVERSAL',
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];
export const ledgerEntryTypeSchema = z.enum(LEDGER_ENTRY_TYPES);

/**
 * Ledger account kinds (#116, ADR-0107 결정 2 #73 1·11항): a person's own (`user`, one per
 * person's account, made with it), the operating treasury (one), a market's collateral and a
 * market's 마켓메이커 자금 (one each per market, owned by the 운영 마켓메이커). The treasury and the
 * collateral have no owner. `ledger_accounts.kind` (migration 0060).
 */
export const LEDGER_ACCOUNT_KINDS = [
  'user',
  'treasury',
  'market_collateral',
  'market_maker_funds',
] as const;
export type LedgerAccountKind = (typeof LEDGER_ACCOUNT_KINDS)[number];
export const ledgerAccountKindSchema = z.enum(LEDGER_ACCOUNT_KINDS);

/** ledger_entries.ref_type (varchar, not a Postgres enum): what ref_id points at. */
export const LEDGER_REF_TYPES = [
  'payment',
  'fill',
  'market',
  'coupon',
  /** A START_GRANT entry's start_grants row (#70, ADR-0071). */
  'start_grant',
  /**
   * A CLOSURE_FORFEIT entry's closed account (#140): `ref_id` is the account's own id, and
   * `profiles.closed_at` says when it closed — one entry per account (migration 0043).
   */
  'account_closure',
  /** The two-person request a TREASURY_MINT or a BOT_ALLOCATION on 증액 carries out (#129/#130). */
  'approval_request',
  /** The `audit_failures` row a RECONCILIATION_CORRECTION fixes (#93). */
  'audit_failure',
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
 * Market lifecycle (N03 §3, ADR-0093 decision 1, #174), in the order N03 §3 lists it with the
 * two side states after the step they branch from (PAUSED beside OPEN) and CANCELLED last.
 * The transitions are `MARKET_LIFECYCLE_TRANSITIONS` (market-lifecycle.ts); this order is only the
 * rank `statusRank` falls back to for a row that carries no transition key (realtime.ts).
 *
 * - `draft` → `review` → `scheduled` → `open` (↔ `paused`) → `closed` → `provisional` →
 *   `resolved` → `settling` → `settled`; `cancelled` ends a market that never had a user fill.
 * - DRAFT and REVIEW are the admin's alone (ADR-0093 decision 1 item 12); every other status
 *   is public (`PUBLIC_MARKET_STATUSES`, market.ts).
 * - The judgement's result is not a status: `MARKET_RESULTS` below, stored beside it.
 *
 * Migration 0048 rebuilt the Postgres type on emptied tables (#174), so the order is free.
 */
export const MARKET_STATUSES = [
  'draft',
  'review',
  'scheduled',
  'open',
  'paused',
  'closed',
  'provisional',
  'resolved',
  'settling',
  'settled',
  'cancelled',
] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];
export const marketStatusSchema = z.enum(MARKET_STATUSES);

export const MARKET_VISIBILITIES = ['public', 'group'] as const;
export type MarketVisibility = (typeof MARKET_VISIBILITIES)[number];
export const marketVisibilitySchema = z.enum(MARKET_VISIBILITIES);

/**
 * A contract's side (PLAN 5.2): what an order buys, a fill trades and a position holds. Binary
 * markets only; PLAN 16 swaps this tuple when multi-outcome arrives. Not a market's result,
 * which can also be VOID (`MARKET_RESULTS`).
 */
export const OUTCOMES = ['YES', 'NO'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const outcomeSchema = z.enum(OUTCOMES);

/**
 * A market's result type (N03 §3 "결과 유형은 YES/NO/VOID로 상태와 별도 저장한다", #174):
 * `markets.resolved_result`, null until a judgement publishes one and on a CANCELLED market
 * (ADR-0093 decision 1 item 10). VOID is a judgement's result, never a status, and pays every
 * contract 50 Coin (item 9, #126). Its own Postgres type (`market_result`), so a contract side
 * can never be VOID.
 */
export const MARKET_RESULTS = ['YES', 'NO', 'VOID'] as const;
export type MarketResult = (typeof MARKET_RESULTS)[number];
export const marketResultSchema = z.enum(MARKET_RESULTS).meta({ id: 'MarketResult' });

/**
 * market_events.type (varchar(40), PLAN 6.2). A row with a status change also carries
 * `from_status`/`to_status` (#174); each action issue adds the type of the transitions it
 * makes (#78 review, #114 pause, #152 judgement, #176 correction and #142 delay record, below;
 * #20 cancel) — #21's scheduled open writes the `opened` the interim open wrote before it, and
 * #152's confirmation the `resolved` the interim judgement wrote.
 */
export const MARKET_EVENT_TYPES = [
  /** → draft: the row is written (`to_status` only). */
  'created',
  /**
   * draft → review: 검수 제출 (#78, ADR-0099; ADR-0093 decision 2 #172 item 6): the open-items
   * check passed, the close was ahead, and the content locked. Payload `{approvalId,
   * leadCloseGapMinutes}` (`MarketSubmittedPayload`, market-review.ts) — the `market_review`
   * approval request it opened and the lead-close gap the check used (null while the release
   * setting is undecided and no announcement needs it), which the approval checks with again.
   */
  'submitted',
  /**
   * review → scheduled: an admin other than the creator, the editors and the submitter approved
   * it, every checklist item confirmed (#172 items 4·5). Payload `{approvalId, checklist, reason}`.
   */
  'approved',
  /**
   * review → draft: 반려 by such an admin (#173 item 1, #172 item 4). Payload `{approvalId,
   * rejectReason, reason}` — one of MARKET_REJECT_REASONS and the description the creator reads.
   */
  'rejected',
  /**
   * review or scheduled → draft: 되돌리기 by any admin, with a reason (#172 item 6). Payload
   * `{approvalId, reason}`: in REVIEW the request it ended (retracted by its submitter, rejected
   * with this reason by anyone else), in SCHEDULED the approved one.
   */
  'reverted',
  /**
   * No status change (`from_status`/`to_status` null): a SCHEDULED market's 예정 개장 시각 moved
   * without a new review (#172 item 6; ADR-0093 decision 3 '#78 수정 기록의 사유', '#21 앞당긴
   * 개장'). Payload `{before, after, reason}`, the times as ISO instants.
   */
  'open_rescheduled',
  /**
   * scheduled → open (#21, ADR-0100; ADR-0093 decision 1 #173 item 1, decision 2 #172 item 6):
   * the worker at `scheduled_open_at` (actor NULL), or the approval or the reschedule that found
   * the scheduled open already come (actor that admin). Payload `{openAt, closeAt, source}`: the
   * instants as ISO and `source` 'job', 'approval' or 'reschedule'. Rows from before #21 are draft
   * → open, the admin's direct open (ADR-0027, the interim open), payload `{openAt, closeAt}`.
   * Since #80 the open also records the market's rules v1 (`market_rule_versions`, ADR-0101) in its
   * transaction, with no event of its own: this one is its record.
   */
  'opened',
  /**
   * open or paused → closed: the worker at `close_at` (actor NULL; ADR-0093 decision 1 #173 items
   * 1·3 — a PAUSED market too, on schedule, #114), payload `{closedAt, source: 'job'}`; or the
   * approved 조기 마감 of a PAUSED market (#114, ADR-0102; #173 items 2·4 — the actor is the
   * approver), payload `{closedAt, source: 'early_close', pauseId, approvalId, requestedBy,
   * reviewResult}` (`MarketEarlyClosedPayload`, market-pause.ts). `closedAt` is the actual close;
   * `close_at` stays the scheduled one. Rows of the one-admin close that #114 retired (open →
   * closed, ADR-0027) carry `{closedAt}` alone.
   */
  'closed',
  /** settling → settled: the worker finished every SETTLEMENT_STEPS step. */
  'finalized',
  /**
   * No status change (`from_status`/`to_status` null): an edit of a draft (REVIEW and SCHEDULED are
   * locked, #78, and after the open the rules change by a supplement alone, `rules_supplemented`,
   * #80) that changed rule items (#23) or the announcement time or judgement time zone (#22,
   * `RULES_EDITED_ITEMS`), payload `{items, before, after}` (`rulesEditedPayload`). Rows from
   * before #80 may be an open market's edit, and rows from before #23 carry `{before, after}` as
   * the old rules text.
   */
  'rules_edited',
  /**
   * provisional → resolved: the worker confirmed the result once its 이의 기한 passed with nothing
   * held (#152, ADR-0103; ADR-0093 decision 1 #173 item 1 — actor NULL): no 판정 이의 of the
   * version pending or accepted (#175, ADR-0104). Payload `{version, result, source: 'deadline'}`
   * (`MarketResolvedByDeadlinePayload`, market-judgement.ts) — after the last dismissal too: the
   * judgement version confirmed and its result. Rows from before #152 are closed → resolved,
   * ADR-0046's interim judgement by one admin (the actor), payload `{result, note, evidenceUrl}`
   * (`MarketInterimResolvedPayload`).
   */
  'resolved',
  /** resolved → settling: the worker starts the settlement steps (ADR-0093 decision 1 item 1). */
  'settling',
  /**
   * No status change (`from_status`/`to_status` null): another admin approved a 보충 of an OPEN or
   * PAUSED market and its rules moved to a new version (#80, ADR-0101; ADR-0093 decision 2 #172
   * items 14·15) — the actor is the approver. Payload `{version, approvalId, items, reason,
   * requestedBy}` (`MarketRulesSupplementedPayload`, market-supplement.ts): the version it made,
   * the `market_supplement` request, the items it changed, the supplement's reason and its
   * requester. A supplement's one market event: its request, 반려 and 철회 are admin actions alone.
   */
  'rules_supplemented',
  /**
   * open → paused: 거래 일시 중단 by one admin (#114, ADR-0102; ADR-0093 decision 1 #173 items 2·3),
   * the actor, with one of MARKET_PAUSE_REASONS and a note (its `market_pauses` row). Payload
   * `{pauseId, reason, resultPublishedAt}` (`MarketPausedPayload`, market-pause.ts): the pause row,
   * its reason and, for `early_result` alone, the result's publication instant (ISO, else null).
   */
  'paused',
  /**
   * paused → open: 재개, asked for by one admin and approved by another (#114; #173 item 2) — the
   * actor is the approver. Payload `{pauseId, approvalId, requestedBy, reviewResult}`
   * (`MarketResumedPayload`). The next path's request, 반려 and 철회 are admin actions alone; its
   * other end is `closed` with `source: 'early_close'`.
   */
  'resumed',
  /**
   * closed → provisional: 잠정 결과의 공개 (#152, ADR-0103; ADR-0093 decision 1 #173 items 1·5·9)
   * — an admin other than the registrant approved a `market_judgement` registration (the actor is
   * the approver), and `markets.resolved_result` holds its result, VOID included. Payload
   * `{version, result, approvalId, requestedBy, disputeDeadline}` (`MarketProvisionalPayload`,
   * market-judgement.ts): the judgement version it published, the result, the request, its
   * registrant and the 이의 기한 (ISO). The registration, 반려 and 철회 are admin actions alone.
   */
  'provisional',
  /**
   * No status change (`from_status`/`to_status` null): 판정 정정 (#176, ADR-0105; ADR-0093 decision
   * 1 #173 items 2·5·8) — an admin other than the registrant approved a `market_judgement`
   * registration of a PROVISIONAL market's current version (the actor is the approver): the
   * judgement version moved on, `markets.resolved_result` took its result, a new 이의 기한 of the
   * base version's length opened from the approval, and the replaced version's pending 판정 이의
   * closed as 정정으로 종결. The market's `status_event_id` moves to it, so `market:status`
   * republishes PROVISIONAL under a newer key. Payload `{version, previousVersion, result,
   * previousResult, approvalId, requestedBy, disputeDeadline, closedDisputes}`
   * (`MarketJudgementCorrectedPayload`, market-judgement.ts). The registration, 반려 and 철회 are
   * admin actions alone, as a first judgement's.
   */
  'judgement_corrected',
  /**
   * No status change (`from_status`/`to_status` null): 판정 지연 기록 (#142, ADR-0106; ADR-0093
   * decision 1 #173 items 2·11, decision 3 '#142 지연 사유') — one admin, the actor, recorded the
   * reason and the next review time of a market that reads '판정 지연' (a CLOSED one past its
   * scheduled judgement, a held PROVISIONAL one past its 이의 기한; its `market_judgement_delays`
   * row). No result and no market column change, and the market's `status_event_id` stays, so
   * `market:status` republishes the unchanged key. Payload `{delayId, reason, nextReviewAt,
   * marketStatus, judgementVersion}` (`MarketJudgementDelayRecordedPayload`,
   * market-judgement-delay.ts): the record, its public reason, the time as ISO, and the status and
   * judgement version it was made on (null on CLOSED). Each change is a new record and a new event
   * (no edit, no withdrawal).
   */
  'judgement_delay_recorded',
  /**
   * No status change (`from_status`/`to_status` null): an OPEN or PAUSED market's 가격 보호 폭
   * changed after the open by one admin with a reason (#119, ADR-0112; ADR-0107 결정 1 #177 2항,
   * ADR-0093 #172 14항). Payload `{before, after, reason}`, the widths in ticks (`before` null for
   * a market opened with none). Applies to the orders taken after it; resting orders keep theirs.
   */
  'price_protection_changed',
] as const;
export type MarketEventType = (typeof MARKET_EVENT_TYPES)[number];
export const marketEventTypeSchema = z.enum(MARKET_EVENT_TYPES);

// ---- orders / fills (PLAN 6.2; #119, ADR-0112) ---------------------------------------
export const ORDER_SIDES = ['buy', 'sell'] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];
export const orderSideSchema = z.enum(ORDER_SIDES);

/**
 * An order's six states (ADR-0107 결정 1 #177 7항): 대기 (`open`) and 부분 체결 (`partially_filled`)
 * rest in the book and hold their lock (`LIVE_ORDER_STATUSES`, contract.ts); 전량 체결 (`filled`),
 * 취소 완료 (`cancelled`), 만료 (`expired`, a GTC order at the close, #120) and 거절 (`rejected`, ended
 * with no fill, its reason in `ORDER_REJECT_REASONS`) have ended. An IOC order that filled nothing
 * is 거절; one that filled some is 취소 완료 with its remainder (`ioc_remainder`).
 */
export const ORDER_STATUSES = [
  'open',
  'partially_filled',
  'filled',
  'cancelled',
  'expired',
  'rejected',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const orderStatusSchema = z.enum(ORDER_STATUSES);

/**
 * Why the server ended an order with no fill, 거절 (ADR-0107 결정 1 #177 8항, ADR-0111 결정 6), in
 * the ADR's order: 잔액 부족 (`insufficient_coin`, the lock it needs is above the available Coin),
 * 보유량 부족 (`insufficient_contracts`, a sell above the unlocked holding), 개장 전
 * (`not_open_yet`, SCHEDULED), 마감 (`closed`, CLOSED and every later status), 일시 중단
 * (`paused`), 호가 부족 (`no_quote`, nothing opposite to meet, the bot not quoting included), 가격
 * 한도 (`price_limit`, the best opposite entry is beyond the limit), 금액 부족 (`budget_too_small`,
 * a budget order that cannot buy one contract) and 자기 체결 (`self_trade`, the first entry is the
 * owner's own group's). Each is kept on the order's row with its request id (no retention).
 * Refusals that write no row — a malformed request, the rate limit, onboarding, a restriction, an
 * admin's order, closed intake — are errors, not reasons. #143 appends one (its own migration).
 */
export const ORDER_REJECT_REASONS = [
  'insufficient_coin',
  'insufficient_contracts',
  'not_open_yet',
  'closed',
  'paused',
  'no_quote',
  'price_limit',
  'budget_too_small',
  'self_trade',
] as const;
export type OrderRejectReason = (typeof ORDER_REJECT_REASONS)[number];
export const orderRejectReasonSchema = z.enum(ORDER_REJECT_REASONS);

/**
 * Why an order ended 취소 완료 (ADR-0107 결정 1 #177 8항), in the ADR's order: 본인 취소
 * (`by_owner`, #178), 즉시 거래 잔량 (`ioc_remainder`, an IOC order's unfilled rest), 자기 체결
 * (`self_trade`, the walk stopped at the owner's own group after a fill, a GTC order too), 일시
 * 중단 (`paused`, #178 at a pause), 관리자 권한 (`admin_role`, #143), 계정 제한 (`restricted`,
 * #178·#139) and 탈퇴 (`account_closed`, shown only on records and operations screens). The intake
 * (#119) writes only `ioc_remainder` and `self_trade`.
 */
export const ORDER_CANCEL_REASONS = [
  'by_owner',
  'ioc_remainder',
  'self_trade',
  'paused',
  'admin_role',
  'restricted',
  'account_closed',
] as const;
export type OrderCancelReason = (typeof ORDER_CANCEL_REASONS)[number];
export const orderCancelReasonSchema = z.enum(ORDER_CANCEL_REASONS);

export const TIME_IN_FORCES = ['ioc', 'gtc'] as const;
export type TimeInForce = (typeof TIME_IN_FORCES)[number];
export const timeInForceSchema = z.enum(TIME_IN_FORCES);

/**
 * What a fill is (`fills.kind`, ADR-0107 결정 1 #177 11항): `trade` moved existing contracts from a
 * seller to a buyer of one outcome; `pair_mint` turned a buy of each outcome into a new pair — one
 * fill with one YES price. The matcher's `MATCH_FILL_KINDS` (matching.ts) are the same two.
 */
export const FILL_KINDS = ['trade', 'pair_mint'] as const;
export type FillKind = (typeof FILL_KINDS)[number];
export const fillKindSchema = z.enum(FILL_KINDS);

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
 * before a `settling` market becomes `settled` (O-6, ADR-0093 decision 1 item 14), run in this
 * order. `coin` pays out the positions. A step added later is appended here — a varchar column,
 * so it needs no enum migration.
 */
export const SETTLEMENT_STEPS = ['coin'] as const;
export type SettlementStep = (typeof SETTLEMENT_STEPS)[number];
export const settlementStepSchema = z.enum(SETTLEMENT_STEPS).meta({ id: 'SettlementStep' });

/**
 * market_settlement_steps.status (varchar). `pending` from the result's confirmation
 * (`resolved`) until the step runs; `done` once it committed (`completed_at` set); `failed` when
 * its last attempt rolled back (`last_error` says why) — the per-minute scan retries a failed
 * step without a cap.
 */
export const SETTLEMENT_STEP_STATUSES = ['pending', 'done', 'failed'] as const;
export type SettlementStepStatus = (typeof SETTLEMENT_STEP_STATUSES)[number];
export const settlementStepStatusSchema = z
  .enum(SETTLEMENT_STEP_STATUSES)
  .meta({ id: 'SettlementStepStatus' });

// ---- admin / audit (varchar columns, PLAN 6.2) --------------------------------------
export const ADMIN_ACTION_TYPES = [
  'charge_package_create',
  'charge_package_update',
  'charge_package_delete',
  'coupon_create',
  'coupon_update',
  /**
   * A market's draft (payload `{after}`) and an edit of it (`{before, after}`): the snapshot holds
   * every field a PATCH reaches, its tags (#17) included, so an edit of an OPEN or PAUSED market's
   * category or tags is recorded with the actor, the time and both values (ADR-0093 decision 2
   * #172 item 14; PAUSED since #114). Its version items change by a supplement alone after the
   * open (#80, `market_supplement_approve`).
   */
  'market_create',
  'market_update',
  /**
   * 개설 검수 (#78, ADR-0099): target `market` / its id, in the transaction that writes the
   * market's own review event (MARKET_EVENT_TYPES). A submission: payload `{approvalId, after}` —
   * the request it opened and the market as submitted, `market_create`'s snapshot.
   */
  'market_submit',
  /** An approval (REVIEW → SCHEDULED): payload `{approvalId, checklist, reason}`. */
  'market_approve',
  /** A 반려 (REVIEW → DRAFT): payload `{approvalId, rejectReason, reason}`. */
  'market_reject',
  /**
   * A 되돌리기 (REVIEW or SCHEDULED → DRAFT): payload `{approvalId, reason, from}` — `from` the
   * status it left.
   */
  'market_revert',
  /** A SCHEDULED market's 예정 개장 시각 moved: payload `{before, after, reason}`, ISO instants. */
  'market_reschedule',
  /**
   * 규칙 보충 (#80, ADR-0101; ADR-0093 decision 2 #172 item 15): target `market` / its id, as each
   * supplement record below. An admin asked for one, which opens a `market_supplement` approval
   * request and changes nothing yet: payload `{approvalId, baseVersion, items, changes, reason,
   * settlementImpact}` — the version it was written against, the items and their new values, the
   * reason and the 정산 영향 검토.
   */
  'market_supplement_request',
  /**
   * Another admin approved it, and the market's rules moved to `version` in the same transaction
   * (its `rules_supplemented` event): payload `{approvalId, version, items, reason, before,
   * after}` — the approver's reason and `market_update`'s snapshot before and after.
   */
  'market_supplement_approve',
  /** Another admin rejected it, nothing changed: payload `{approvalId, rejectReason, reason}`. */
  'market_supplement_reject',
  /** Its requester retracted it before anyone decided it, nothing changed: `{approvalId}`. */
  'market_supplement_retract',
  /**
   * 거래 일시 중단 (#114, ADR-0102; ADR-0093 decision 1 #173 items 2·3): target `market` / its id,
   * as each pause record below. One admin paused an OPEN market (its `paused` event): payload
   * `{pauseId, reason, note, resultPublishedAt, before, after}` (`MarketPauseActionPayload`,
   * market-pause.ts) — the pause row, the body's fields and `market_update`'s snapshot.
   */
  'market_pause',
  /**
   * An admin asked for a PAUSED market's next path, 재개 or 조기 마감 (#173 item 2), which opens a
   * `market_pause_decision` approval request and changes nothing yet: payload `{approvalId,
   * pauseId, path, reviewResult, reason}` — the review result of a `basis_change` pause alone.
   */
  'market_pause_decision_request',
  /**
   * Another admin approved it, and the market resumed (`resumed`) or closed early (`closed`) in the
   * same transaction: payload `{approvalId, pauseId, path, reviewResult, reason, before, after}` —
   * the approver's reason and `market_update`'s snapshot before and after.
   */
  'market_pause_decision_approve',
  /** Another admin rejected it, nothing changed: payload `{approvalId, pauseId, path, reason}`. */
  'market_pause_decision_reject',
  /** Its requester retracted it before anyone decided it: payload `{approvalId, pauseId, path}`. */
  'market_pause_decision_retract',
  /**
   * 판정 (#152, ADR-0103; ADR-0093 decision 3 the #152 rows): target `market` / its id, as each
   * judgement record below — a 판정 정정's too (#176, ADR-0105: the same four, told apart by the
   * request's `correction`). An admin registered a CLOSED market's judgement, or a correction of
   * a PROVISIONAL one's current version, which opens a `market_judgement` approval request and
   * changes no status: payload `{approvalId, result, source, fallbackReason, voidReason, evidence,
   * ruleVersion, correction, description}` (`MarketJudgementRequestActionPayload`,
   * market-judgement.ts) — the registration as the request froze it, the source's name and
   * address copied from the rules (`correction` null for a first judgement; rows before #176 lack
   * it).
   */
  'market_judgement_request',
  /**
   * An admin other than the registrant approved it, and in the same transaction the market went
   * CLOSED → PROVISIONAL (its `provisional` event) or, for a correction, moved to the next version
   * (its `judgement_corrected` event): payload `{approvalId, version, result, reason,
   * eventDeadlineConfirmed, disputeWindowMinutes, disputeDeadline, previous, correction,
   * closedDisputeIds, before, after}` (`MarketJudgementApproveActionPayload`) — the approver's
   * reason and event-deadline confirmation, the window used and the deadline it fixed, the
   * version a correction replaced, its correction and the disputes it closed (null, null and
   * empty for a first judgement; rows before #176 lack the three), and `market_update`'s snapshot
   * before and after.
   */
  'market_judgement_approve',
  /**
   * Another admin rejected it, the market stays as it was — CLOSED, or PROVISIONAL at the base
   * version for a correction: payload `{approvalId, result, reason}`, and for a correction
   * `reopenedDisputeIds`, the accepted disputes it sent back to pending (owner answer 2026-11-02).
   */
  'market_judgement_reject',
  /**
   * Its registrant retracted it before anyone decided it: payload `{approvalId, result}`, and for
   * a correction `reopenedDisputeIds`, as a 반려's.
   */
  'market_judgement_retract',
  /**
   * 판정 이의 (#175, ADR-0104; ADR-0093 decision 1 #173 items 2·7): target `market` / its id. One
   * admin who is not the registrant of the dispute's judgement version dismissed a pending dispute
   * (기각): payload `{disputeId, judgementVersion, reason}` (`MarketDisputeDecisionActionPayload`,
   * market-dispute.ts) — never the submitter's links or reason. No market event: the status stays
   * PROVISIONAL, and the worker confirms once nothing holds it past the deadline.
   */
  'market_dispute_dismiss',
  /**
   * Such an admin accepted it (수용, a correction to come, #173 item 7): the same payload. The
   * dispute keeps holding the market until a correction is approved (owner answer 2026-11-02), and
   * goes back to pending when the correction registered for it is rejected or retracted (#176,
   * ADR-0105) — this row still records the acceptance.
   */
  'market_dispute_accept',
  /**
   * 판정 지연 기록 (#142, ADR-0106; ADR-0093 decision 1 #173 items 2·11): target `market` / its id.
   * One admin, no approval request, recorded a delayed market's reason and next review time (its
   * `judgement_delay_recorded` event): payload `{delayId, reason, nextReviewAt, marketStatus,
   * judgementVersion}` (`MarketDelayRecordActionPayload`, market-judgement-delay.ts) — the event's
   * fields; no before and after, the market row being unchanged.
   */
  'market_delay_record',
  /**
   * Retired (#21, ADR-0100): the interim open (ADR-0027, draft → open) wrote it until #21 removed
   * that action. Kept so the rows it wrote still parse and render; nothing writes it now — an open
   * is recorded by its `opened` market event (the actor and `source`).
   */
  'market_open',
  /**
   * Retired (#114, ADR-0102): the one-admin close (ADR-0027, open → closed, payload `{before,
   * after}`) wrote it until #114 made an early end a pause and another admin's approved 조기 마감
   * (ADR-0093 decision 1 #173 items 2·4, decision 2 #172 item 14). Kept so the rows it wrote still
   * parse and render; nothing writes it now.
   */
  'market_close',
  /**
   * Retired (#152, ADR-0103): ADR-0046's interim judgement by one admin (closed → resolved, final
   * at once, payload `{result, note, evidenceUrl, before, after}`) wrote it until #152 made the
   * judgement a registration another admin approves (`market_judgement_*`) and the worker confirms
   * at its dispute deadline. Kept so the rows it wrote still parse and render; nothing writes it
   * now.
   */
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
  /**
   * 카테고리 관리 (#17, ADR-0093 decision 2 #172 item 1): an admin added a category — target
   * `category` / its id, payload `{after: {slug, nameKo, parentId, sortOrder, isActive}}`. Every
   * category record below has the same target (a reorder: the parent's id, or none for the
   * top-level group) and records the actor, the time and the value before and after; no reason,
   * no second admin. Each is written only when its write changed something.
   */
  'category_create',
  /** The name changed: payload `{before: {nameKo}, after: {nameKo}}`. */
  'category_rename',
  /**
   * One group's order changed — the top-level categories or one parent's sub-categories: payload
   * `{parentId, before, after}`, each the group's ids first to last.
   */
  'category_reorder',
  /**
   * It left new-market entry, the explore categories and the interest pick: payload
   * `{before: {isActive}, after: {isActive}}`.
   */
  'category_hide',
  /** It came back: the same payload. */
  'category_show',
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
   * as are the four below: the record of which operator did what when (ADR-0069 decision 4 #77,
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
   * A market was linked later to a proposal adopted with none (owner decision 2026-10-19,
   * ADR-0089): payload `{marketId, marketCreated}` — a draft made from the proposal then
   * (`marketCreated`, with its own `market_create`) or an existing market. Once per proposal; the
   * status stays 채택.
   */
  'proposal_link',
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
  /**
   * An OPEN or PAUSED market's 가격 보호 폭 changed (#119, ADR-0112): target `market` / its id,
   * payload `{before, after, reason}` — as its `price_protection_changed` event.
   */
  'market_price_protection_change',
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
 * Seed categories (PLAN 1.3, 6.2): the five TOP-LEVEL slugs the seed starts the tree with. Since
 * #17 the operators keep the tree (`/admin/categories`) and may add any category, sports and
 * politics included (owner decision D10): these lists are the first deploy's data, not the set of
 * categories there are, and the seed never changes a category that exists (`seedCategories`).
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
