import { randomUUID } from 'node:crypto';
import {
  compareAccountIdsBytewise,
  MARKET_JUDGEMENT_COMPENSATED_NOTIFICATION,
  MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND,
  marketJudgementCompensationRequestPayloadSchema,
  sameJudgementCompensationRecipients,
  serializeCoinAmount,
  type ApprovalStatus,
  type JudgementCompensationPublicFacts,
  type MarketJudgementCompensatedParams,
  type MarketJudgementCompensationRequestPayload,
  type MarketResult,
} from '@buddha/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Db } from './client.js';
import {
  ledgerKeys,
  lockLedgerAccounts,
  recordLedgerEntry,
  type BalanceRow,
  type LedgerEntryRow,
} from './ledger.js';
import { ledgerHeldMarketIds } from './ledger-held-markets.js';
import type { MarketJudgementIncidentRow } from './market-judgement-incident.js';
import type { NotificationInput } from './notifications.js';
import type * as schema from './schema/index.js';
import {
  approvalRequests,
  judgementCompensations,
  profiles,
  type JudgementCompensationOutcome,
} from './schema/index.js';

/*
 * 판정 오류 보상 (#144 part 2, ADR-0166; @buddha/shared judgement-compensation.ts): what a confirmed
 * 판정 오류 사건 owes each account (`judgementCompensationTargets`, over migration 0081's
 * `judgement_compensation_owed`), the approval's checks under its locks
 * (`prepareJudgementCompensationPayout`: the #93 market hold, the frozen list against the live one,
 * the recipients' profiles and balance rows, and 144-16's ledger check), the one writer of
 * `judgement_compensations` and of JUDGEMENT_COMPENSATION entries (`payJudgementCompensation`, the
 * API's 보상 승인 in the approving transaction), the notice inputs of its payout (52-20, 144-18) and
 * the readers the admin detail and the public 판정 정정 take. Nothing here touches the market row,
 * its judgements, its settlement records, the positions, the collateral or a SETTLEMENT_PAYOUT
 * (ADR-0165 decision 2), and nothing takes Coin from anyone (N03 §7, #144 AC 3). Nothing here
 * publishes, decides a request or writes an admin action (the API's).
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Pick<NodePgDatabase<typeof schema>, 'select' | 'execute'>;

export type JudgementCompensationRow = typeof judgementCompensations.$inferSelect;

// ---- the amounts (144-1) --------------------------------------------------------------

/** One account a confirmed correction owes something, as the live list reads it. */
export interface JudgementCompensationTarget {
  readonly userId: string;
  /** What the correction owes it (144-1), above 0. */
  readonly amountCoin: bigint;
  /**
   * Its member closed it (or it has no profile — no open account): the approval records it
   * '탈퇴로 지급 못 함' and writes no ledger event (144-7).
   */
  readonly closed: boolean;
  /**
   * Open, but its balance row's ledger-total copy left its ledger (`balances.ledger_coin <>
   * ledger_account_last_after`, migration 0060), so no ledger event can be written for it — '원장
   * 확인 필요' (144-16: the approval is refused whole while any is).
   */
  readonly blocked: boolean;
}

/**
 * The accounts a market's confirmed correction to `corrected` owes something (144-1): every
 * person's account with a settlement record on the market (`position_settlements`, one row per
 * account and outcome — the 운영 마켓메이커's excluded by `is_human_account`, ADR-0166 T16), each
 * owed `judgement_compensation_owed` (migration 0081: Σ qty × the corrected result's per-contract
 * payout − Σ the paid payouts, YES and NO netted), those above 0 only, in bytewise account order
 * (`COLLATE "C"`, the order of `compareAccountIdsBytewise` — the frozen list's, the stale check's
 * and the lock order, ADR-0166 T23). Each with whether it is closed now and whether it is blocked
 * (`JudgementCompensationTarget`). An account that sold out before the payout has no record and is
 * owed nothing (144-1 "정산 기록으로"). One statement: the amount is the database's own function, so
 * the list and migration 0081's row check cannot disagree; @buddha/shared
 * `judgementCompensationOwed` is its twin (the db tests hold them equal). No row lock: the
 * approval locks the recipients afterwards (`prepareJudgementCompensationPayout`).
 */
export async function judgementCompensationTargets(
  reader: Reader,
  marketId: string,
  corrected: MarketResult,
): Promise<JudgementCompensationTarget[]> {
  const { rows } = await reader.execute<{
    user_id: string;
    owed: string;
    closed: boolean;
    blocked: boolean;
  }>(sql`
    SELECT o.user_id, o.owed::text AS owed,
      (p.user_id IS NULL OR p.closed_at IS NOT NULL) AS closed,
      (p.user_id IS NOT NULL AND p.closed_at IS NULL
        AND (b.account_id IS NULL OR b.ledger_coin <> ledger_account_last_after(a.id))) AS blocked
    FROM (
      SELECT s.user_id, judgement_compensation_owed(${marketId}::uuid,
        ${corrected}::market_result, s.user_id) AS owed
      FROM (
        SELECT DISTINCT ps.user_id FROM position_settlements ps
        WHERE ps.market_id = ${marketId}::uuid AND is_human_account(ps.user_id)
      ) s
    ) o
    LEFT JOIN profiles p ON p.user_id = o.user_id
    LEFT JOIN ledger_accounts a ON a.kind = 'user' AND a.owner_id = o.user_id
    LEFT JOIN balances b ON b.account_id = a.id
    WHERE o.owed > 0
    ORDER BY o.user_id COLLATE "C"`);
  return rows.map((row) => ({
    userId: row.user_id,
    amountCoin: BigInt(row.owed),
    closed: row.closed,
    blocked: row.blocked,
  }));
}

// ---- the requests -----------------------------------------------------------------------

/**
 * A request's payload, parsed (`marketJudgementCompensationRequestPayloadSchema`). Anything but
 * the frozen list is a broken invariant: the API writes it whole and migration 0021 freezes it.
 */
export function judgementCompensationPayloadOf(request: {
  id: string;
  payload: unknown;
}): MarketJudgementCompensationRequestPayload {
  const parsed = marketJudgementCompensationRequestPayloadSchema.safeParse(request.payload);
  if (!parsed.success) {
    throw new Error(`Judgement compensation request ${request.id} has a malformed payload`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * A compensation request as it was asked and decided: the request's columns, its payload parsed,
 * and its requester's and decider's current nicknames (null once the member closed the account —
 * #140; LEFT joins, so a missing profile hides no row).
 */
export interface JudgementCompensationRequestRead {
  id: string;
  status: ApprovalStatus;
  payload: MarketJudgementCompensationRequestPayload;
  /** The internal reason (admins only). */
  reason: string;
  requestedBy: string;
  requestedByNickname: string | null;
  requestedAt: Date;
  decidedBy: string | null;
  decidedByNickname: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  retractedAt: Date | null;
}

/**
 * Every `market_judgement_compensation` request of a market, the newest first — pending, approved
 * (paid), rejected or retracted: the admin detail's waiting request, its paid one and its log. The
 * index `approval_requests_target_idx` serves the market's requests.
 */
export async function readJudgementCompensationRequests(
  reader: Reader,
  marketId: string,
): Promise<JudgementCompensationRequestRead[]> {
  const requester = alias(profiles, 'requester');
  const decider = alias(profiles, 'decider');
  const rows = await reader
    .select({
      id: approvalRequests.id,
      status: approvalRequests.status,
      payload: approvalRequests.payload,
      reason: approvalRequests.requestReason,
      requestedBy: approvalRequests.requestedBy,
      requestedByNickname: requester.nickname,
      requestedAt: approvalRequests.requestedAt,
      decidedBy: approvalRequests.decidedBy,
      decidedByNickname: decider.nickname,
      decidedAt: approvalRequests.decidedAt,
      decisionReason: approvalRequests.decisionReason,
      retractedAt: approvalRequests.retractedAt,
    })
    .from(approvalRequests)
    .leftJoin(requester, eq(requester.userId, approvalRequests.requestedBy))
    .leftJoin(decider, eq(decider.userId, approvalRequests.decidedBy))
    .where(
      and(
        eq(approvalRequests.kind, MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND),
        eq(approvalRequests.targetType, 'market'),
        eq(approvalRequests.targetId, marketId),
      ),
    )
    .orderBy(desc(approvalRequests.requestedAt), desc(approvalRequests.id));
  return rows.map((row) => ({ ...row, payload: judgementCompensationPayloadOf(row) }));
}

/**
 * The rows an approved request wrote, in bytewise account order (the payout's order) — the admin
 * recipients list once paid (`paid` or `closed`, as the approval recorded each).
 */
export async function readJudgementCompensationRows(
  reader: Reader,
  approvalId: string,
): Promise<JudgementCompensationRow[]> {
  return reader
    .select()
    .from(judgementCompensations)
    .where(eq(judgementCompensations.approvalId, approvalId))
    .orderBy(sql`${judgementCompensations.userId} COLLATE "C"`);
}

/**
 * What the public 판정 정정 shows of a confirmed incident's compensation, read in the caller's
 * snapshot (144-6, 144-15; `publicJudgementCompensationOf` in @buddha/shared turns it into the
 * public shape): the approved request's rows — how many (paid and closed: the 대상 count), how many
 * paid, the Coin paid — else the waiting request's list length, and how many accounts the live
 * list owes (0 is 보상 대상 없음). Counts and a total only: never an account (ADR-0166 privacy).
 */
export async function readJudgementCompensationFacts(
  reader: Reader,
  incident: Pick<MarketJudgementIncidentRow, 'id' | 'marketId' | 'correctedResult'>,
): Promise<JudgementCompensationPublicFacts> {
  const { rows } = await reader.execute<{
    paid_rows: number;
    paid_count: number;
    paid_coin: string;
    pending_count: number | null;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM judgement_compensations c WHERE c.incident_id = ${incident.id}::uuid)
        AS paid_rows,
      (SELECT count(*)::int FROM judgement_compensations c
        WHERE c.incident_id = ${incident.id}::uuid AND c.outcome = 'paid') AS paid_count,
      (SELECT coalesce(sum(c.amount_coin) FILTER (WHERE c.outcome = 'paid'), 0)::text
        FROM judgement_compensations c WHERE c.incident_id = ${incident.id}::uuid) AS paid_coin,
      (SELECT jsonb_array_length(r.payload -> 'recipients') FROM approval_requests r
        WHERE r.kind = ${MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND} AND r.target_type = 'market'
          AND r.target_id = ${incident.marketId} AND r.status = 'pending'
        ORDER BY r.requested_at DESC LIMIT 1) AS pending_count`);
  const row = rows[0]!;
  // An approved request always wrote one row per listed account (migration 0081), at least one.
  const paid =
    row.paid_rows > 0
      ? { accountCount: row.paid_rows, paidCount: row.paid_count, paidCoin: BigInt(row.paid_coin) }
      : null;
  const owedCount =
    paid === null && row.pending_count === null
      ? (await judgementCompensationTargets(reader, incident.marketId, incident.correctedResult))
          .length
      : 0;
  return { paid, pendingAccountCount: row.pending_count, owedCount };
}

// ---- the approval -----------------------------------------------------------------------

/** One open listed account, its balance row locked. */
export interface LockedJudgementCompensationRecipient {
  readonly userId: string;
  readonly amountCoin: bigint;
  /** Its user ledger account's id. */
  readonly accountId: number;
}

/** The approval's recipients under their locks, split as the payout treats them. */
export interface JudgementCompensationRecipients {
  /** Open accounts, bytewise: each is paid. */
  readonly open: readonly LockedJudgementCompensationRecipient[];
  /** Closed accounts (or with no profile), bytewise: each recorded '탈퇴로 지급 못 함' (144-7). */
  readonly closed: readonly { readonly userId: string; readonly amountCoin: bigint }[];
}

/**
 * Why `prepareJudgementCompensationPayout` refused, nothing written (the API's refusals,
 * `MARKET_JUDGEMENT_COMPENSATION_REFUSALS`):
 * - `held`: the market is ledger-held (#93, `ledgerHeldMarketIds`) — `market` 'held';
 * - `stale`: the list re-derived now differs from the frozen one — `recipients` 'stale';
 * - `blocked`: `blockedCount` open listed accounts carry a ledger-total copy that left their
 *   ledger — `recipients` 'blocked' (144-16 "승인 전체를 거절"); never which (the admin list shows
 *   them).
 */
export type JudgementCompensationPayoutCheck =
  | { readonly outcome: 'ready'; readonly recipients: JudgementCompensationRecipients }
  | { readonly outcome: 'refused'; readonly reason: 'held' | 'stale' }
  | { readonly outcome: 'refused'; readonly reason: 'blocked'; readonly blockedCount: number };

/**
 * The approval's checks, every lock taken before the decision (ADR-0166 §6.2 steps 4–7; the
 * ledger's "clock after the last lock", ledger.ts): called under `lockMarket` with the market row
 * FOR UPDATE, after the approval engine's `decidable` and the approver's checks, BEFORE
 * `approvals.approve` — so the decision's instant, read after it, is later than every lock and the
 * entries' time and id order agree.
 * 1. `held`: the market is ledger-held (T21; settlement and the recall refuse the same state).
 * 2. `stale`: the live list (`judgementCompensationTargets`) against the frozen one, both sorted
 *    bytewise (`sameJudgementCompensationRecipients`) — defensive: settlement records never move.
 * 3. The recipients' profiles FOR KEY SHARE in bytewise order — a closure in flight is waited for
 *    and seen, and none starts until COMMIT (a closure takes the profile FOR UPDATE first, and
 *    locks no SETTLED market) — split open/closed; then every open recipient's balance row at once
 *    (`lockLedgerAccounts`, ascending id).
 * 4. `blocked`: an open recipient whose `ledger_coin` left its ledger takes no event (migration
 *    0060) — refused whole with the count (144-16), instead of failing inside the ledger's INSERT
 *    check as an untyped error (ADR-0166 T18).
 * No restriction check and no account-level #93 hold check: a restricted or account-held member is
 * paid (144-7 "제한과 상관없이"; ADR-0107 결정 2 #73 10항).
 */
export async function prepareJudgementCompensationPayout(
  tx: Tx,
  input: {
    marketId: string;
    incident: Pick<MarketJudgementIncidentRow, 'id' | 'marketId' | 'correctedResult'>;
    payload: MarketJudgementCompensationRequestPayload;
  },
): Promise<JudgementCompensationPayoutCheck> {
  const { marketId, incident, payload } = input;
  if (incident.marketId !== marketId || payload.incidentId !== incident.id) {
    throw new Error(
      `Judgement compensation of incident ${payload.incidentId} is not this market's`,
    );
  }
  if ((await ledgerHeldMarketIds(tx, [marketId])).has(marketId)) {
    return { outcome: 'refused', reason: 'held' };
  }
  const live = await judgementCompensationTargets(tx, marketId, incident.correctedResult);
  if (!sameJudgementCompensationRecipients(payload.recipients, live)) {
    return { outcome: 'refused', reason: 'stale' };
  }
  const recipients = await lockJudgementCompensationRecipients(
    tx,
    payload.recipients.map((recipient) => ({
      userId: recipient.userId,
      amountCoin: BigInt(recipient.amountCoin),
    })),
  );
  const blockedCount = await countBlockedAccounts(
    tx,
    recipients.open.map((recipient) => recipient.accountId),
  );
  if (blockedCount > 0) return { outcome: 'refused', reason: 'blocked', blockedCount };
  return { outcome: 'ready', recipients };
}

/**
 * Step 3 of `prepareJudgementCompensationPayout`: the recipients' profiles FOR KEY SHARE in
 * bytewise account order (one statement: the rows lock in the order it returns them), split by
 * `closed_at` (no profile: no open account), then every open recipient's balance row at once.
 */
export async function lockJudgementCompensationRecipients(
  tx: Tx,
  recipients: readonly { userId: string; amountCoin: bigint }[],
): Promise<JudgementCompensationRecipients> {
  const sorted = [...recipients].sort((a, b) => compareAccountIdsBytewise(a.userId, b.userId));
  if (sorted.length === 0) return { open: [], closed: [] };
  const { rows } = await tx.execute<{ user_id: string; closed: boolean }>(sql`
    SELECT p.user_id, p.closed_at IS NOT NULL AS closed FROM profiles p
    WHERE p.user_id IN (${sql.join(
      sorted.map((recipient) => sql`${recipient.userId}`),
      sql`, `,
    )})
    ORDER BY p.user_id COLLATE "C"
    FOR KEY SHARE`);
  const openIds = new Set(rows.filter((row) => !row.closed).map((row) => row.user_id));
  const openRecipients = sorted.filter((recipient) => openIds.has(recipient.userId));
  const locked = await lockLedgerAccounts(
    tx,
    openRecipients.map((recipient) => ({ kind: 'user', userId: recipient.userId })),
  );
  return {
    open: openRecipients.map((recipient, index) => ({
      userId: recipient.userId,
      amountCoin: recipient.amountCoin,
      accountId: locked[index]!.account.id,
    })),
    closed: sorted.filter((recipient) => !openIds.has(recipient.userId)),
  };
}

/** How many of `accountIds` carry a `ledger_coin` that left their ledger (read under the locks). */
async function countBlockedAccounts(tx: Tx, accountIds: readonly number[]): Promise<number> {
  if (accountIds.length === 0) return 0;
  const { rows } = await tx.execute<{ blocked: number }>(sql`
    SELECT count(*)::int AS blocked FROM balances b
    WHERE b.account_id IN (${sql.join(
      accountIds.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND b.ledger_coin <> ledger_account_last_after(b.account_id)`);
  return rows[0]!.blocked;
}

/** A blocked recipient met by the payout itself: a caller skipped the check (a bug). */
export class JudgementCompensationBlockedError extends Error {
  readonly blockedCount: number;
  constructor(blockedCount: number) {
    super(`${blockedCount} compensated account(s) carry a ledger total that left their ledger`);
    this.name = 'JudgementCompensationBlockedError';
    this.blockedCount = blockedCount;
  }
}

export interface PayJudgementCompensationInput {
  /** The market the request is about (its target). */
  marketId: string;
  /** The market's title when paid: the entries' memo (hidden on a market's event, ADR-0144). */
  marketTitle: string;
  /** The market's confirmed incident (`readMarketJudgementIncident`). */
  incident: Pick<MarketJudgementIncidentRow, 'id' | 'marketId' | 'correctedResult'>;
  /**
   * The `market_judgement_compensation` request as `ApprovalService.approve` left it in this
   * transaction: approved, its decider and decision instant set — every row's approver and every
   * entry's and row's instant (one instant per decision, ADR-0166 T20).
   */
  request: Pick<
    typeof approvalRequests.$inferSelect,
    'id' | 'kind' | 'status' | 'payload' | 'requestedBy' | 'decidedBy' | 'decidedAt'
  >;
  /** `prepareJudgementCompensationPayout`'s `ready` recipients, locked in this transaction. */
  recipients: JudgementCompensationRecipients;
}

/** One account paid: its row, its entry and its balance after. */
export interface JudgementCompensationPaid {
  readonly userId: string;
  readonly amountCoin: bigint;
  readonly row: JudgementCompensationRow;
  readonly entry: LedgerEntryRow;
  readonly balance: BalanceRow;
}

export interface PayJudgementCompensationResult {
  /** The decision's instant: every row's and entry's `created_at`. */
  readonly at: Date;
  /** The accounts paid, bytewise. */
  readonly paid: readonly JudgementCompensationPaid[];
  /** The closed accounts recorded '탈퇴로 지급 못 함', bytewise. */
  readonly closed: readonly JudgementCompensationRow[];
  /** The Coin paid in all (the closed accounts' amounts not included). */
  readonly paidCoin: bigint;
}

/**
 * 보상 지급 (144-2 "목록의 계정마다 한 번씩 지급한다"; #73 8항): writes the approved request's payout
 * at the decision's instant, in the approving transaction, after `approvals.approve` — per listed
 * account in bytewise order: an open one gets its JUDGEMENT_COMPENSATION entry (a mint into its
 * user ledger account naming the market, keyed `ledgerKeys.judgementCompensation(request,
 * account)`) and then its `paid` row, entry first — the row's own-entry check needs the entry, the
 * entry's deferred record check the row by COMMIT (0077's order); a closed one only its `closed`
 * row (144-7). Throws — and the caller's transaction, the approval with it, rolls back (ADR-0166
 * T6) — when the request is not an approved compensation of this incident, when the recipients are
 * not exactly its frozen list, when an open recipient's ledger copy left its ledger
 * (`JudgementCompensationBlockedError`: the caller skipped the check), or when an entry was
 * recorded before (`duplicate` is impossible once the request was pending: one approval). The
 * database holds all of it again (migration 0081): the amount recomputed, the closure, the market
 * hold, the paid version's registrant as approver, one row per listed account at COMMIT. No
 * restriction or account-level hold check (144-7, #73 10항); never touches positions, settlement
 * records, the collateral, the treasury or a 마켓메이커 자금.
 */
export async function payJudgementCompensation(
  tx: Tx,
  input: PayJudgementCompensationInput,
): Promise<PayJudgementCompensationResult> {
  const { marketId, incident, request, recipients } = input;
  if (
    request.kind !== MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND ||
    request.status !== 'approved' ||
    request.decidedBy === null ||
    request.decidedAt === null
  ) {
    throw new Error(`Request ${request.id} is no approved judgement compensation`);
  }
  const payload = judgementCompensationPayloadOf(request);
  if (payload.incidentId !== incident.id || incident.marketId !== marketId) {
    throw new Error(`Request ${request.id} compensates another incident`);
  }
  const given = [
    ...recipients.open.map(({ userId, amountCoin }) => ({ userId, amountCoin })),
    ...recipients.closed,
  ];
  if (!sameJudgementCompensationRecipients(payload.recipients, given)) {
    throw new Error(`Request ${request.id}'s recipients are not its frozen list`);
  }
  const blocked = await countBlockedAccounts(
    tx,
    recipients.open.map((recipient) => recipient.accountId),
  );
  if (blocked > 0) throw new JudgementCompensationBlockedError(blocked);

  const at = request.decidedAt;
  const approvedBy = request.decidedBy;
  const closedIds = new Set(recipients.closed.map((recipient) => recipient.userId));
  const paid: JudgementCompensationPaid[] = [];
  const closed: JudgementCompensationRow[] = [];
  let paidCoin = 0n;
  for (const listed of payload.recipients) {
    const amountCoin = BigInt(listed.amountCoin);
    const id = randomUUID();
    const row = {
      id,
      incidentId: incident.id,
      marketId,
      userId: listed.userId,
      approvalId: request.id,
      amountCoin,
      userReason: payload.userReason,
      requestedBy: request.requestedBy,
      approvedBy,
      appliedTxid: sql`pg_current_xact_id()::text`,
      createdAt: at,
    };
    if (closedIds.has(listed.userId)) {
      const [written] = await tx
        .insert(judgementCompensations)
        .values({ ...row, outcome: 'closed' satisfies JudgementCompensationOutcome })
        .returning();
      if (!written) throw new Error(`judgement compensation ${id} could not be recorded`);
      closed.push(written);
      continue;
    }
    const recorded = await recordLedgerEntry(tx, {
      type: 'JUDGEMENT_COMPENSATION',
      amountCoin,
      from: null,
      to: { kind: 'user', userId: listed.userId },
      marketId,
      refType: 'judgement_compensation',
      refId: id,
      idempotencyKey: ledgerKeys.judgementCompensation(request.id, listed.userId),
      // Hidden on a market's event (the wallet shows the row's members' reason, 144-12).
      memo: `판정 오류 보상: ${input.marketTitle}`,
      at,
    });
    if (recorded.outcome !== 'recorded' || !recorded.to) {
      throw new Error(`judgement compensation ${id} found its ledger entry recorded already`);
    }
    const [written] = await tx
      .insert(judgementCompensations)
      .values({
        ...row,
        outcome: 'paid' satisfies JudgementCompensationOutcome,
        ledgerEntryId: recorded.entry.id,
      })
      .returning();
    if (!written) throw new Error(`judgement compensation ${id} could not be recorded`);
    paid.push({
      userId: listed.userId,
      amountCoin,
      row: written,
      entry: recorded.entry,
      balance: recorded.to,
    });
    paidCoin += amountCoin;
  }
  return { at, paid, closed, paidCoin };
}

// ---- the notice (52-20, 144-18) ----------------------------------------------------------

/**
 * The inputs of a payout's notice (52-20 "보상받는 회원에게"; 144-18 "지급할 때 한 건, '시장' 분류,
 * 시장 상세로"): one `market_judgement_compensated` per account PAID — none to a closed account
 * (recorded '탈퇴로 지급 못 함'), a holder owed nothing, an over-paid one or a watcher — keyed by the
 * approval's `admin_actions` row (`adminActionEventKey`), at the decision's instant, leading to the
 * market's detail, naming its title, the paid and the corrected result and the recipient's own
 * amount as a decimal string (never anyone else's, never a P&L). The approving transaction appends
 * them to its ONE `createNotifications` call, last (ADR-0157 결정 4). Pure: no SQL.
 *
 * Throws — a caller bug, and the payout rolls back with it — when the market is not SETTLED (a
 * correction is confirmed on a SETTLED market alone, 144-13, and a market never leaves it), even
 * with no one paid. No one paid gives no input.
 */
export function judgementCompensationNotificationInputs(
  paid: readonly { readonly userId: string; readonly amountCoin: bigint }[],
  market: { slug: string; title: string; status: string },
  notice: {
    originalResult: MarketResult;
    correctedResult: MarketResult;
    eventKey: string;
    occurredAt: Date;
  },
): NotificationInput[] {
  if (market.status !== 'settled') {
    throw new Error(`judgement compensation notice: a market that is ${market.status}`);
  }
  return paid.map(({ userId, amountCoin }) => {
    const params: MarketJudgementCompensatedParams = {
      marketTitle: market.title,
      originalResult: notice.originalResult,
      correctedResult: notice.correctedResult,
      compensationCoin: serializeCoinAmount(amountCoin),
    };
    return {
      userId,
      type: MARKET_JUDGEMENT_COMPENSATED_NOTIFICATION.type,
      eventKey: notice.eventKey,
      occurredAt: notice.occurredAt,
      target: { kind: 'market', slug: market.slug },
      params,
    };
  });
}
