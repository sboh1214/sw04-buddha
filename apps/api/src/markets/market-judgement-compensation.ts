import {
  judgementCompensationPayloadOf,
  judgementCompensationTargets,
  ledgerHeldMarketIds,
  readJudgementCompensationRequests,
  readJudgementCompensationRows,
  readMarketJudgementIncident,
  schema,
  type Db,
  type JudgementCompensationRequestRead,
  type MarketJudgementIncidentRow,
} from '@buddha/db';
import {
  MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND,
  compareAccountIdsBytewise,
  decodeTupleCursor,
  encodeTupleCursor,
  serializeCoinAmount,
  type AdminAccountActor,
  type AdminJudgementCompensationRecipient,
  type AdminMarketJudgementCompensation,
  type CursorQuery,
  type JudgementCompensationRecipientState,
  type MarketJudgementCompensationLogEntry,
  type MarketJudgementCompensationRequestPayload,
} from '@buddha/shared';
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { type Page } from '../wallet/wallet.service.js';
import { type Executor } from './market-item-rules.js';

/**
 * 판정 오류 보상 (#144 part 2, ADR-0166; judgement-compensation.ts in @buddha/shared and
 * @buddha/db) as the admin screens read it: the confirmed incident's compensation on the admin
 * detail (`AdminMarket.judgementIncident.compensation` — the live preview, the #93 hold, the
 * waiting request, the paid one and the log), a market's compensation request by id for the
 * writes, and the per-account recipients list (`GET /admin/markets/:id/judgement-compensations/
 * recipients`, OPERATION_RECORDS). Accounts are named as every admin record names one
 * (`AdminAccountActor`: the id and the current nickname, null once closed — #140). Nothing here is
 * public: the public 판정 정정's figures are `readMarketJudgingRecord`'s counts and total (144-6),
 * never this.
 */

const { approvalRequests, judgementCompensations, profiles } = schema;

/** An account as the admin screen names it (see the module doc). */
const actor = (id: string, nickname: string | null): AdminAccountActor => ({ id, nickname });

/** A compensation request as the writes read it, its payload not yet parsed. */
export interface JudgementCompensationRequest {
  id: string;
  requestedBy: string;
  requestReason: string;
  requestedAt: Date;
  status: (typeof approvalRequests.$inferSelect)['status'];
  payload: Record<string, unknown> | null;
}

/**
 * The market's `market_judgement_compensation` request `requestId` — locked FOR UPDATE when
 * `forUpdate` (the approval's step 2, ADR-0166 §6.2) — or null when the market has none by that
 * id: another market's, another kind's (an incident's among them) or no request at all.
 */
export async function judgementCompensationRequestOf(
  executor: Executor,
  marketId: string,
  requestId: string,
  forUpdate = false,
): Promise<JudgementCompensationRequest | null> {
  const query = executor
    .select({
      id: approvalRequests.id,
      requestedBy: approvalRequests.requestedBy,
      requestReason: approvalRequests.requestReason,
      requestedAt: approvalRequests.requestedAt,
      status: approvalRequests.status,
      payload: approvalRequests.payload,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.kind, MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND),
        eq(approvalRequests.targetType, 'market'),
        eq(approvalRequests.targetId, marketId),
        eq(approvalRequests.id, requestId),
      ),
    )
    .limit(1);
  const [row] = forUpdate ? await query.for('update') : await query;
  return row ?? null;
}

/**
 * A compensation request's payload, parsed (@buddha/db `judgementCompensationPayloadOf`); anything
 * but the frozen list is a broken invariant — INTERNAL, never an answer.
 */
export function compensationPayloadOf(request: {
  id: string;
  payload: unknown;
}): MarketJudgementCompensationRequestPayload {
  try {
    return judgementCompensationPayloadOf(request);
  } catch (error) {
    throw new AppError('INTERNAL', {
      message: `Judgement compensation request ${request.id} has a malformed payload`,
      cause: error,
    });
  }
}

/** What every admin read model shows of a request (`requestFields` in @buddha/shared). */
function requestOf(request: JudgementCompensationRequestRead) {
  return {
    requestId: request.id,
    requestedBy: actor(request.requestedBy, request.requestedByNickname),
    requestedAt: request.requestedAt.toISOString(),
    accountCount: request.payload.accountCount,
    totalCoin: request.payload.totalCoin,
    reason: request.reason,
    userReason: request.payload.userReason,
  };
}

/** One request of the log, as `MarketJudgementCompensationLogEntry`. */
function logEntryOf(
  request: JudgementCompensationRequestRead,
): MarketJudgementCompensationLogEntry {
  return {
    ...requestOf(request),
    status: request.status,
    decidedBy:
      request.decidedBy === null ? null : actor(request.decidedBy, request.decidedByNickname),
    decidedAt: request.decidedAt?.toISOString() ?? null,
    decisionReason: request.decisionReason,
    retractedAt: request.retractedAt?.toISOString() ?? null,
  };
}

/**
 * `AdminMarket.judgementIncident.compensation` (#144 part 2) of a market's confirmed `incident`,
 * through `executor` so a write answers with what it wrote and the detail with its REPEATABLE READ
 * snapshot: every compensation request of the market the newest first
 * (`readJudgementCompensationRequests`, one statement with the requester's and the decider's
 * nicknames), the waiting one, the approved one with its payout's counts and total from its rows
 * (`readJudgementCompensationRows` — paid and closed, 144-7), whether the market is ledger-held
 * (#93, `ledgerHeldMarketIds`) and, while nothing is approved, what a request would list now
 * (`judgementCompensationTargets`: the owed accounts, their total, how many are closed and how
 * many open ones are 원장 확인 필요 — 144-16).
 */
export async function readAdminMarketJudgementCompensation(
  executor: Executor,
  marketId: string,
  incident: Pick<MarketJudgementIncidentRow, 'id' | 'marketId' | 'correctedResult'>,
): Promise<AdminMarketJudgementCompensation> {
  const requests = await readJudgementCompensationRequests(executor, marketId);
  const pending = requests.find((request) => request.status === 'pending');
  const approved = requests.find((request) => request.status === 'approved');
  const held = (await ledgerHeldMarketIds(executor, [marketId])).has(marketId);
  let preview: AdminMarketJudgementCompensation['preview'] = null;
  if (approved === undefined) {
    const targets = await judgementCompensationTargets(
      executor,
      marketId,
      incident.correctedResult,
    );
    preview = {
      accountCount: targets.length,
      totalCoin: serializeCoinAmount(targets.reduce((sum, target) => sum + target.amountCoin, 0n)),
      closedCount: targets.filter((target) => target.closed).length,
      blockedCount: targets.filter((target) => target.blocked).length,
    };
  }
  let paid: AdminMarketJudgementCompensation['paid'] = null;
  if (approved !== undefined) {
    if (approved.decidedBy === null || approved.decidedAt === null) {
      throw new AppError('INTERNAL', {
        message: `Judgement compensation request ${approved.id} is approved by no one`,
      });
    }
    const rows = await readJudgementCompensationRows(executor, approved.id);
    const paidRows = rows.filter((row) => row.outcome === 'paid');
    paid = {
      ...requestOf(approved),
      approvedBy: actor(approved.decidedBy, approved.decidedByNickname),
      approvedAt: approved.decidedAt.toISOString(),
      paidCount: paidRows.length,
      paidCoin: serializeCoinAmount(paidRows.reduce((sum, row) => sum + row.amountCoin, 0n)),
      closedCount: rows.length - paidRows.length,
    };
  }
  return {
    preview,
    held,
    pending: pending === undefined ? null : requestOf(pending),
    paid,
    log: requests.map(logEntryOf),
  };
}

/** One listed account before the approval, with its owed amount. */
interface ListedAccount {
  userId: string;
  amountCoin: bigint;
}

/**
 * Where each of `userIds` stands before an approval, read now: its nickname, whether it is closed
 * (or has no profile) and whether, open, its balance record left its ledger — the predicate of
 * `judgementCompensationTargets` and of the approval's 144-16 check (migration 0060's
 * `ledger_account_last_after`).
 */
async function accountStates(
  executor: Executor,
  userIds: readonly string[],
): Promise<Map<string, { nickname: string | null; state: JudgementCompensationRecipientState }>> {
  if (userIds.length === 0) return new Map();
  const { rows } = await executor.execute<{
    user_id: string;
    nickname: string | null;
    closed: boolean;
    blocked: boolean;
  }>(sql`
    SELECT u.id AS user_id, p.nickname,
      (p.user_id IS NULL OR p.closed_at IS NOT NULL) AS closed,
      (p.user_id IS NOT NULL AND p.closed_at IS NULL
        AND (b.account_id IS NULL OR b.ledger_coin <> ledger_account_last_after(a.id))) AS blocked
    FROM unnest(ARRAY[${sql.join(
      userIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::text[]) AS u(id)
    LEFT JOIN profiles p ON p.user_id = u.id
    LEFT JOIN ledger_accounts a ON a.kind = 'user' AND a.owner_id = u.id
    LEFT JOIN balances b ON b.account_id = a.id`);
  return new Map(
    rows.map((row) => [
      row.user_id,
      {
        nickname: row.nickname,
        state: row.closed ? 'closed' : row.blocked ? 'blocked' : 'pending',
      },
    ]),
  );
}

/**
 * `GET /admin/markets/:id/judgement-compensations/recipients` (admins only, OPERATION_RECORDS): the
 * accounts a market's confirmed correction compensates, in bytewise account order (ADR-0166 T23 —
 * the cursor is the last account id, compared as `COLLATE "C"` and `compareAccountIdsBytewise`
 * compare it), each named, with what it is owed and where it stands — once a request is approved,
 * as its rows recorded it (`paid` or `closed`); while one waits, its frozen list; before any, the
 * live list (`judgementCompensationTargets`); `pending`, `blocked` (원장 확인 필요, 144-16) or
 * `closed` (탈퇴로 지급 못 함, 144-7) read now. One REPEATABLE READ, read-only snapshot. A market
 * with no confirmed incident — an unknown market among them — answers an empty page.
 */
export async function listJudgementCompensationRecipients(
  db: Db,
  marketId: string,
  query: CursorQuery,
): Promise<Page<AdminJudgementCompensationRecipient>> {
  const after = decodeTupleCursor(query.cursor, [], 'text')?.id;
  const { limit } = query;
  return db.transaction(
    async (tx) => {
      const incident = await readMarketJudgementIncident(tx, marketId);
      if (incident === null) return { items: [], nextCursor: null };
      const requests = await readJudgementCompensationRequests(tx, marketId);
      const approved = requests.find((request) => request.status === 'approved');
      if (approved !== undefined) {
        const rows = await tx
          .select({
            userId: judgementCompensations.userId,
            nickname: profiles.nickname,
            amountCoin: judgementCompensations.amountCoin,
            outcome: judgementCompensations.outcome,
          })
          .from(judgementCompensations)
          .leftJoin(profiles, eq(profiles.userId, judgementCompensations.userId))
          .where(
            and(
              eq(judgementCompensations.approvalId, approved.id),
              after === undefined
                ? undefined
                : sql`${judgementCompensations.userId} COLLATE "C" > ${after}`,
            ),
          )
          .orderBy(sql`${judgementCompensations.userId} COLLATE "C"`)
          .limit(limit + 1);
        const hasMore = rows.length > limit;
        const kept = hasMore ? rows.slice(0, limit) : rows;
        return {
          items: kept.map((row) => ({
            account: actor(row.userId, row.nickname),
            amountCoin: serializeCoinAmount(row.amountCoin),
            state: row.outcome,
          })),
          nextCursor: hasMore ? encodeTupleCursor([], kept.at(-1)!.userId) : null,
        };
      }
      const pending = requests.find((request) => request.status === 'pending');
      const listed: ListedAccount[] =
        pending === undefined
          ? (await judgementCompensationTargets(tx, marketId, incident.correctedResult)).map(
              ({ userId, amountCoin }) => ({ userId, amountCoin }),
            )
          : pending.payload.recipients.map((recipient) => ({
              userId: recipient.userId,
              amountCoin: BigInt(recipient.amountCoin),
            }));
      const page = listed
        .sort((a, b) => compareAccountIdsBytewise(a.userId, b.userId))
        .filter(
          (account) => after === undefined || compareAccountIdsBytewise(account.userId, after) > 0,
        )
        .slice(0, limit + 1);
      const hasMore = page.length > limit;
      const kept = hasMore ? page.slice(0, limit) : page;
      const states = await accountStates(
        tx,
        kept.map((account) => account.userId),
      );
      return {
        items: kept.map((account) => {
          const state = states.get(account.userId);
          return {
            account: actor(account.userId, state?.nickname ?? null),
            amountCoin: serializeCoinAmount(account.amountCoin),
            state: state?.state ?? 'closed',
          };
        }),
        nextCursor: hasMore ? encodeTupleCursor([], kept.at(-1)!.userId) : null,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
