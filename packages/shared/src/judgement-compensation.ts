import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { coinAmountSchema } from './api/coin-amount.js';
import { approvalReasonSchema } from './approvals.js';
import {
  type MarketResult,
  type Outcome,
  approvalStatusSchema,
  marketResultSchema,
} from './enums.js';
import {
  type ExpectedAccountBody,
  expectedAccountBodySchema,
  expectedAccountIdSchema,
} from './expected-account.js';
import { settlementPayoutPerContract } from './market-settlement.js';

/**
 * 판정 오류 보상 (#144 part 2, ADR-0166; owner answers 144-1·144-2·144-4·144-6·144-7·144-10·
 * 144-11·144-12 and 144-15·144-16·144-18; ADR-0107 결정 2 #73 1·3·7·8·9항; ADR-0120 decisions 5·6):
 *
 * - 요청 (`POST /admin/markets/:id/judgement-compensations`): once a market's 판정 오류 사건 is
 *   confirmed (SETTLED alone, 144-13), any admin without a conflict on the market — the paid
 *   version's registrant included (144-4 "보상 요청은 할 수 있다") — asks for its compensation with
 *   an internal reason and the reason the compensated members read in their wallets (144-12). The
 *   body names no account and no amount (144-1 "관리자는 금액을 고치지 않는다"): the server
 *   computes the list (`judgementCompensationOwed` per account over the market's settlement
 *   records, YES and NO together, positive only, people's accounts only) and the request's payload
 *   freezes it (#171), with its count and total. One request waits at a time; none is taken once
 *   one is approved (144-2 "사건마다 한 번").
 * - 승인 (`…/:requestId/approve`): an admin who is neither the requester (#171) nor the paid
 *   version's registrant (144-4) nor conflicted (#143) approves it, and the same transaction pays
 *   every listed account once under the ledger type JUDGEMENT_COMPENSATION (a new issue naming the
 *   market, #73 8항) — a closed account recorded '탈퇴로 지급 못 함' and paid nothing (144-7), a
 *   restricted one paid (144-7 "제한과 상관없이"). Refused whole while the market is ledger-held
 *   (#93) or any open listed account's balance record left its ledger (144-16 "승인 전체를 거절").
 * - 반려 (`…/reject`): any admin but the requester, with a reason — a 정리 목적 반려 (ADR-0120
 *   decision 5), so neither 144-4 nor #143 applies; a new request may follow it. 철회 (`…/retract`)
 *   is the requester's; a self-declared conflict retracts the declarer's own waiting request.
 *
 * Nothing is taken back from anyone (N03 §7, AC 3): an account the paid result over-paid keeps
 * it, and the settlement records, the positions and the paid settlement never move. A 보상 is not
 * profit or loss (144-10): no P&L reads the ledger.
 */

/** `approval_requests.kind` of a 판정 오류 보상 request (#171: lower-case words, `_`). */
export const MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND = 'market_judgement_compensation';

// ---- the amount (144-1) ---------------------------------------------------------------
/** One settlement record of an account in a market (`position_settlements`, ADR-0118 결정 3). */
export interface JudgementCompensationRecord {
  /** The contract the record settled. */
  outcome: Outcome;
  /** The contracts the account held at the payout (`position_settlements.qty`), ≥ 0. */
  qty: number | bigint;
  /** What the payout paid it (`position_settlements.payout_coin`), ≥ 0. */
  payoutCoin: bigint;
}

/**
 * What a correction owes one account in one market (144-1 "올바른 결과였다면 받았을 지급 합계 −
 * 실제로 받은 지급 합계를 YES·NO를 합쳐 계산"): Σ qty × the corrected result's per-contract payout
 * (`settlementPayoutPerContract`, the one rule of CONTRACT_TERMS) − Σ the paid payouts, over the
 * account's records of the market — both outcomes netted. Negative when the paid result over-paid
 * the account (kept: nothing is taken back, N03 §7), 0 when even; the account is a target only
 * when it is positive (`isJudgementCompensationOwed`). Never mixes markets: the caller gives one
 * market's records. Migration 0081's `judgement_compensation_owed` is the same sum in SQL.
 */
export function judgementCompensationOwed(
  records: readonly JudgementCompensationRecord[],
  corrected: MarketResult,
): bigint {
  let owed = 0n;
  for (const record of records) {
    const qty = BigInt(record.qty);
    if (qty < 0n || record.payoutCoin < 0n) {
      throw new RangeError('A settlement record holds no negative quantity or payout');
    }
    owed +=
      qty * BigInt(settlementPayoutPerContract(corrected, record.outcome)) - record.payoutCoin;
  }
  return owed;
}

/** Whether `owed` makes its account a target: more than 0 (144-1 "0보다 큰 계정에만"). */
export function isJudgementCompensationOwed(owed: bigint): boolean {
  return owed > 0n;
}

/**
 * Account ids in bytewise order — the order `ORDER BY user_id COLLATE "C"` gives (ADR-0166 T23):
 * the frozen list, its stale comparison, the lock order and the recipients' cursor. A plain
 * code-unit comparison, never `localeCompare` (under a locale TS and SQL disagree). Code units
 * order as UTF-8 bytes do for every id without astral characters; account ids are ASCII.
 */
export function compareAccountIdsBytewise(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- the frozen list ------------------------------------------------------------------
/** A Coin amount above 0 as a decimal string (a bigint): what one account is owed. */
const owedCoinSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);

/** One account of the frozen list and what it is owed. */
export const judgementCompensationRecipientSchema = z.object({
  userId: z.string().min(1).max(255),
  amountCoin: owedCoinSchema,
});
export type JudgementCompensationRecipient = z.infer<typeof judgementCompensationRecipientSchema>;

/**
 * `approval_requests.payload` of a compensation request (frozen at the insert, migration 0021): the
 * requester's conflict confirmation (ADR-0120 decision 5, as an incident's and a judgement's
 * payloads keep theirs), the confirmed incident and its corrected result, the server-computed list
 * in bytewise account order (no account twice), its length and total — the closed accounts
 * included, whom the approval records '탈퇴로 지급 못 함' (144-7) — and the members' reason
 * (144-12). Migration 0081 holds the approval to it: one row per listed account with its amount,
 * their sum the total. Built by `judgementCompensationRequestPayload`; no `.meta`: no route answers
 * it as is.
 */
export const marketJudgementCompensationRequestPayloadSchema = z
  .object({
    noConflictConfirmed: z.literal(true),
    incidentId: z.uuid(),
    correctedResult: marketResultSchema,
    recipients: z.array(judgementCompensationRecipientSchema).min(1),
    accountCount: z.number().int().min(1),
    totalCoin: owedCoinSchema,
    userReason: approvalReasonSchema,
  })
  .superRefine((payload, ctx) => {
    const { recipients } = payload;
    for (let index = 1; index < recipients.length; index += 1) {
      if (
        compareAccountIdsBytewise(recipients[index - 1]!.userId, recipients[index]!.userId) >= 0
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['recipients', index, 'userId'],
          message: 'not in bytewise order or repeated',
        });
      }
    }
    if (payload.accountCount !== recipients.length) {
      ctx.addIssue({ code: 'custom', path: ['accountCount'], message: 'not the list length' });
    }
    // Zod runs this refinement after a field's own failure too: sum only well-formed amounts.
    const amounts = [payload.totalCoin, ...recipients.map((recipient) => recipient.amountCoin)];
    if (!amounts.every((amount) => typeof amount === 'string' && /^[0-9]+$/.test(amount))) return;
    const total = recipients.reduce((sum, recipient) => sum + BigInt(recipient.amountCoin), 0n);
    if (BigInt(payload.totalCoin) !== total) {
      ctx.addIssue({ code: 'custom', path: ['totalCoin'], message: 'not the list total' });
    }
  });
export type MarketJudgementCompensationRequestPayload = z.infer<
  typeof marketJudgementCompensationRequestPayloadSchema
>;

/** What one account is owed, as the server's list holds it before it is frozen. */
export interface JudgementCompensationOwedAccount {
  userId: string;
  amountCoin: bigint;
}

/**
 * The request's payload from the server's list: the accounts sorted bytewise, each owed more than
 * 0, none twice, with the count and the total. Throws on an empty list (the request refuses it as
 * `recipients` 'none' first), a non-positive amount or a repeated account — a broken reader, never
 * a list to freeze.
 */
export function judgementCompensationRequestPayload(input: {
  incidentId: string;
  correctedResult: MarketResult;
  owed: readonly JudgementCompensationOwedAccount[];
  userReason: string;
}): MarketJudgementCompensationRequestPayload {
  if (input.owed.length === 0) throw new RangeError('A compensation request lists an account');
  const sorted = [...input.owed].sort((a, b) => compareAccountIdsBytewise(a.userId, b.userId));
  let total = 0n;
  sorted.forEach((account, index) => {
    if (!isJudgementCompensationOwed(account.amountCoin)) {
      throw new RangeError(`Account ${account.userId} is owed nothing`);
    }
    if (index > 0 && sorted[index - 1]!.userId === account.userId) {
      throw new RangeError(`Account ${account.userId} is listed twice`);
    }
    total += account.amountCoin;
  });
  return marketJudgementCompensationRequestPayloadSchema.parse({
    noConflictConfirmed: true,
    incidentId: input.incidentId,
    correctedResult: input.correctedResult,
    recipients: sorted.map((account) => ({
      userId: account.userId,
      amountCoin: account.amountCoin.toString(),
    })),
    accountCount: sorted.length,
    totalCoin: total.toString(),
    userReason: input.userReason,
  });
}

/**
 * Whether the frozen list and the list re-derived at the approval name the same accounts with the
 * same amounts, each compared after a bytewise sort (never a locale's) — false is `recipients`
 * 'stale' (ADR-0166 T23).
 */
export function sameJudgementCompensationRecipients(
  frozen: readonly JudgementCompensationRecipient[],
  live: readonly JudgementCompensationOwedAccount[],
): boolean {
  if (frozen.length !== live.length) return false;
  const a = [...frozen].sort((x, y) => compareAccountIdsBytewise(x.userId, y.userId));
  const b = [...live].sort((x, y) => compareAccountIdsBytewise(x.userId, y.userId));
  return a.every(
    (recipient, index) =>
      recipient.userId === b[index]!.userId &&
      BigInt(recipient.amountCoin) === b[index]!.amountCoin,
  );
}

// ---- refusals -------------------------------------------------------------------------
/**
 * The refusal details of a compensation's request and approval (VALIDATION_ERROR, the API's), each
 * message under the path it names. A request, after the requester's conflict check (FORBIDDEN
 * `market_conflict`), in this order: `incident` 'not confirmed', `market` 'held', `compensation`
 * 'pending', `compensation` 'paid', `recipients` 'none', then `no_decider` (approvals.ts). An
 * approval: `requestId` 'unknown', the approval engine's own (`decided`, `retracted`, `requester`),
 * `decider` 'registrant', the conflict checks, `market` 'held', `recipients` 'stale', `recipients`
 * 'blocked'. A 반려 asks only the engine's and `requestId`; a 철회 the engine's too.
 * - `incident`: the market has no confirmed 판정 오류 사건 (`missing` — none is confirmed before
 *   SETTLED, 144-13);
 * - `market`: the market is ledger-held by #93 — an unrecovered `reconciliation_holds` row or a
 *   `ledger_failure` pause (`held`; its settlement records are what the list is computed from);
 * - `compensation`: a request waits (`pending` — one at a time) or one was approved (`paid` — once
 *   per incident, 144-2);
 * - `recipients`: no account is owed anything (`none` — public `none`, 144-15); the list
 *   re-derived at the approval differs from the frozen one (`stale`); an open listed account's
 *   balance record left its ledger, so no ledger event can be written for it (`blocked`, 144-16 —
 *   the whole approval is refused; the answer says how many, never which: the recipients list
 *   shows them to the admins);
 * - `decider`: the approver registered the paid judgement version (`registrant`, 144-4 — the same
 *   message as the incident's, from the same `judgementIncidentDecisionRefusal`);
 * - `requestId`: the path's request is no `market_judgement_compensation` request of the market
 *   (`unknown`).
 */
export const MARKET_JUDGEMENT_COMPENSATION_REFUSALS = {
  incident: { missing: 'not confirmed' },
  market: { held: 'held' },
  compensation: { pending: 'pending', paid: 'paid' },
  recipients: { none: 'none', stale: 'stale', blocked: 'blocked' },
  decider: { registrant: 'registrant' },
  requestId: { unknown: 'unknown' },
} as const;

// ---- bodies ---------------------------------------------------------------------------
/**
 * `POST /admin/markets/:id/judgement-compensations` (보상 요청; 144-1, 144-2, 144-12):
 * - `reason`: why it is asked, for the admins (the request's reason; never shown to a member);
 * - `userReason`: 회원에게 보일 사유 — what each compensated member reads beside the wallet's entry
 *   (144-12), written once per request; trimmed, 1..500;
 * - `noConflictConfirmed`: the requester's 이해충돌 없음 confirmation (ADR-0120 decision 5, as an
 *   incident's registration);
 * - and the admin on screen (ADR-0092).
 * No account and no amount: the server computes them (144-1).
 */
export const requestJudgementCompensationBodySchema = z
  .object({
    reason: approvalReasonSchema,
    userReason: approvalReasonSchema,
    noConflictConfirmed: z.literal(true),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'RequestJudgementCompensationBody' });
export type RequestJudgementCompensationBody = z.infer<
  typeof requestJudgementCompensationBodySchema
>;

/**
 * `POST /admin/markets/:id/judgement-compensations/:requestId/approve` (보상 승인 — and the payout
 * in the same transaction): the approver's reason (admins only), the approver's 이해충돌 없음
 * confirmation (#143, 144-4) and the admin on screen.
 */
export const approveJudgementCompensationBodySchema = z
  .object({
    reason: approvalReasonSchema,
    noConflictConfirmed: z.literal(true),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'ApproveJudgementCompensationBody' });
export type ApproveJudgementCompensationBody = z.infer<
  typeof approveJudgementCompensationBodySchema
>;

/**
 * `POST /admin/markets/:id/judgement-compensations/:requestId/reject` (보상 반려): the reason and
 * the admin on screen — no conflict confirmation: a 정리 목적 반려 (ADR-0120 decision 5 "정리 목적의
 * 반려·철회는 새 배제에 포함하지 않는다"; 144-4 bars only 보상 승인), most often to reword the
 * members' reason.
 */
export const rejectJudgementCompensationBodySchema = z
  .object({
    reason: approvalReasonSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'RejectJudgementCompensationBody' });
export type RejectJudgementCompensationBody = z.infer<typeof rejectJudgementCompensationBodySchema>;

/** `…/:requestId/retract` (철회, the requester's): the admin on screen alone. */
export const retractJudgementCompensationBodySchema = expectedAccountBodySchema;
export type RetractJudgementCompensationBody = ExpectedAccountBody;

// ---- admin action payloads ------------------------------------------------------------
/**
 * `market_judgement_compensation_request`'s payload (admin_actions, target `market`): the request
 * it opened, the incident, the internal reason (the work history's, 145-16), the list's count and
 * total, how many of its accounts were closed when it was asked, and the members' reason — never
 * an account (ADR-0064, ADR-0159 12-12).
 */
export interface MarketJudgementCompensationRequestActionPayload {
  approvalId: string;
  incidentId: string;
  reason: string;
  accountCount: number;
  totalCoin: string;
  closedCount: number;
  userReason: string;
}

/**
 * `market_judgement_compensation_approve`'s payload: the request, the incident, the approver's
 * reason, how many accounts were paid and how much in all, and how many were closed (144-7).
 */
export interface MarketJudgementCompensationApproveActionPayload {
  approvalId: string;
  incidentId: string;
  reason: string;
  paidCount: number;
  paidCoin: string;
  closedCount: number;
}

/** `market_judgement_compensation_reject`'s payload: the request, the incident, the reason. */
export interface MarketJudgementCompensationRejectActionPayload {
  approvalId: string;
  incidentId: string;
  reason: string;
}

/**
 * `market_judgement_compensation_retract`'s payload: the request and the incident — and, when a
 * self-declared conflict retracted it (ADR-0120 decision 6), the declaration.
 */
export interface MarketJudgementCompensationRetractActionPayload {
  conflictDeclarationId?: string;
  approvalId: string;
  incidentId: string;
}

// ---- admin read models ----------------------------------------------------------------
const countSchema = z.number().int().nonnegative();

/**
 * What a request would list now (`AdminMarket.judgementIncident.compensation.preview`): the owed
 * accounts, their total, how many of them are closed (recorded '탈퇴로 지급 못 함' at the approval,
 * 144-7) and how many are open with a balance record off its ledger ('원장 확인 필요', 144-16).
 */
export const marketJudgementCompensationPreviewSchema = z
  .object({
    accountCount: countSchema,
    totalCoin: coinAmountSchema,
    closedCount: countSchema,
    blockedCount: countSchema,
  })
  .meta({ id: 'MarketJudgementCompensationPreview' });
export type MarketJudgementCompensationPreview = z.infer<
  typeof marketJudgementCompensationPreviewSchema
>;

/** What a request says, as every admin read model below shows it. */
const requestFields = {
  requestId: z.uuid(),
  requestedBy: adminAccountActorSchema,
  requestedAt: z.iso.datetime(),
  /** The frozen list's length and total. */
  accountCount: countSchema,
  totalCoin: coinAmountSchema,
  /** The request's internal reason (admins only). */
  reason: z.string(),
  /** 회원에게 보일 사유 (144-12). */
  userReason: z.string(),
};

/**
 * The compensation request waiting on a market (`…compensation.pending`). Neither its requester
 * nor the paid version's registrant may approve it.
 */
export const marketJudgementCompensationPendingSchema = z
  .object(requestFields)
  .meta({ id: 'MarketJudgementCompensationPending' });
export type MarketJudgementCompensationPending = z.infer<
  typeof marketJudgementCompensationPendingSchema
>;

/**
 * The approved request and its payout (`…compensation.paid`, at most one per incident, 144-2): who
 * approved it and when (the payout's instant), how many accounts were paid and how much in all,
 * and how many were closed — `paidCount + closedCount` is the list's length.
 */
export const marketJudgementCompensationPaidSchema = z
  .object({
    ...requestFields,
    approvedBy: adminAccountActorSchema,
    approvedAt: z.iso.datetime(),
    paidCount: countSchema,
    paidCoin: coinAmountSchema,
    closedCount: countSchema,
  })
  .meta({ id: 'MarketJudgementCompensationPaid' });
export type MarketJudgementCompensationPaid = z.infer<typeof marketJudgementCompensationPaidSchema>;

/**
 * One compensation request of the admin detail's log: the request and how it ended — `status`
 * pending, approved (paid), rejected or retracted; the decider, the decision's instant and reason
 * (null unless decided); the 철회's instant (null unless retracted).
 */
export const marketJudgementCompensationLogEntrySchema = z
  .object({
    ...requestFields,
    status: approvalStatusSchema,
    decidedBy: adminAccountActorSchema.nullable(),
    decidedAt: z.iso.datetime().nullable(),
    decisionReason: z.string().nullable(),
    retractedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'MarketJudgementCompensationLogEntry' });
export type MarketJudgementCompensationLogEntry = z.infer<
  typeof marketJudgementCompensationLogEntrySchema
>;

/**
 * `AdminMarket.judgementIncident.compensation` (#144, ADR-0166): the confirmed incident's
 * compensation, read in the detail's snapshot; null while no incident is confirmed.
 */
export const adminMarketJudgementCompensationSchema = z
  .object({
    /** What a request would list now; null once one is approved (the payout is then `paid`). */
    preview: marketJudgementCompensationPreviewSchema.nullable(),
    /** Whether the market is ledger-held (#93): no request or approval is taken then. */
    held: z.boolean(),
    /** The waiting request; null when none waits (at most one does). */
    pending: marketJudgementCompensationPendingSchema.nullable(),
    /** The approved request and its payout; null until one is approved (at most one ever is). */
    paid: marketJudgementCompensationPaidSchema.nullable(),
    /** Every compensation request of the incident, the newest first, the waiting one included. */
    log: z.array(marketJudgementCompensationLogEntrySchema),
  })
  .meta({ id: 'AdminMarketJudgementCompensation' });
export type AdminMarketJudgementCompensation = z.infer<
  typeof adminMarketJudgementCompensationSchema
>;

/**
 * Where one listed account stands (`GET /admin/markets/:id/judgement-compensations/recipients`):
 * before the approval `pending` (payable), `blocked` (원장 확인 필요 — its balance record left its
 * ledger, 144-16) or `closed` (its member closed it: 탈퇴로 지급 못 함, 144-7); after it `paid` or
 * `closed`, as the approval recorded it.
 */
export const JUDGEMENT_COMPENSATION_RECIPIENT_STATES = [
  'pending',
  'blocked',
  'closed',
  'paid',
] as const;
export type JudgementCompensationRecipientState =
  (typeof JUDGEMENT_COMPENSATION_RECIPIENT_STATES)[number];

/**
 * One row of the recipients list (admins only — OPERATION_RECORDS; query `cursorQuerySchema`, in
 * bytewise account order): the account as every admin record names one (its nickname null once
 * closed), what it is owed and where it stands. Before a request, the live list; while one waits,
 * its frozen list; once approved, the approval's records.
 */
export const adminJudgementCompensationRecipientSchema = z
  .object({
    account: adminAccountActorSchema,
    amountCoin: coinAmountSchema,
    state: z.enum(JUDGEMENT_COMPENSATION_RECIPIENT_STATES),
  })
  .meta({ id: 'AdminJudgementCompensationRecipient' });
export type AdminJudgementCompensationRecipient = z.infer<
  typeof adminJudgementCompensationRecipientSchema
>;

// ---- the public figures (144-6, 144-15) -----------------------------------------------
/**
 * Where a confirmed correction's compensation stands publicly (144-6, 144-15): `preparing` (보상
 * 준비 중 — no request yet, or the last was rejected or retracted), `none` (보상 대상 없음 — no
 * account is owed anything), `pending` (승인 대기), `paid` (지급 완료).
 */
export const JUDGEMENT_COMPENSATION_PUBLIC_STATUSES = [
  'preparing',
  'none',
  'pending',
  'paid',
] as const;
export type JudgementCompensationPublicStatus =
  (typeof JUDGEMENT_COMPENSATION_PUBLIC_STATUSES)[number];

/**
 * The public 판정 정정's compensation (#144, ADR-0166; 144-6 "보상 대상 계정 수, 지급한 Coin 총액,
 * 지급 상태(승인 대기·지급 완료)", 144-15 "두 상태를 더하고 탈퇴 대상을 따로 센다"):
 * - `accountCount`: the 대상 count — the frozen list's length while `pending`, the approval's
 *   records (paid and closed) once `paid`; null otherwise;
 * - `paidCount`: the accounts paid (`paid` only) — below `accountCount` when closed accounts were
 *   recorded '탈퇴로 지급 못 함' ('대상 계정 {n}개 중 {m}개 지급');
 * - `totalCoin`: the Coin paid in all (`paid` only; '0' when every target was closed).
 * Never an account, a nickname or one account's amount — though with one paid account the total
 * is that account's amount, which 144-6 accepted by publishing counts and totals (ADR-0166).
 */
export const publicJudgementCompensationSchema = z
  .object({
    status: z.enum(JUDGEMENT_COMPENSATION_PUBLIC_STATUSES),
    accountCount: countSchema.nullable(),
    paidCount: countSchema.nullable(),
    totalCoin: coinAmountSchema.nullable(),
  })
  .meta({ id: 'PublicJudgementCompensation' });
export type PublicJudgementCompensation = z.infer<typeof publicJudgementCompensationSchema>;

/** What the public figures are read from (the reader's, under one snapshot). */
export interface JudgementCompensationPublicFacts {
  /** The approved request's records: how many, how many paid, the Coin paid; null if none. */
  paid: { accountCount: number; paidCount: number; paidCoin: bigint } | null;
  /** The waiting request's list length; null if none waits. */
  pendingAccountCount: number | null;
  /** How many accounts the correction owes now (the live list): 0 is `none`. */
  owedCount: number;
}

/**
 * The public figures from the facts, in this order: an approved request is `paid`, a waiting one
 * `pending`, no owed account `none`, anything else `preparing` (144-15).
 */
export function publicJudgementCompensationOf(
  facts: JudgementCompensationPublicFacts,
): PublicJudgementCompensation {
  if (facts.paid !== null) {
    return {
      status: 'paid',
      accountCount: facts.paid.accountCount,
      paidCount: facts.paid.paidCount,
      totalCoin: facts.paid.paidCoin.toString(),
    };
  }
  if (facts.pendingAccountCount !== null) {
    return {
      status: 'pending',
      accountCount: facts.pendingAccountCount,
      paidCount: null,
      totalCoin: null,
    };
  }
  return {
    status: facts.owedCount === 0 ? 'none' : 'preparing',
    accountCount: null,
    paidCount: null,
    totalCoin: null,
  };
}
