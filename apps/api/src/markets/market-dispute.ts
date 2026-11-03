import {
  readMarketDisputes,
  type AdminDisputeRead,
  type DisputeMarketRef,
  type MarketDisputeRead,
  type MemberDisputeRead,
} from '@buddha/db';
import {
  disputeRetractionRefusal,
  isHoldingDisputeStatus,
  type AdminAccountActor,
  type AdminDisputeQueueItem,
  type AdminMarketDispute,
  type AdminMarketDisputes,
  type DisputeNotAllowedDetails,
  type DisputeNotAllowedReason,
  type MyDispute,
} from '@buddha/shared';
import { AppError } from '../common/errors/app-error.js';
import { type Executor } from './market-item-rules.js';
import { type MarketRow } from './market.service.js';

/**
 * 판정 이의 (#175, ADR-0104; market-dispute.ts in @buddha/shared and @buddha/db) as the API answers
 * it: the refusal, the member's form of a dispute (`MyDispute`, never the decider — #173 item 13)
 * and the operators' (`AdminMarketDispute`, the submitter and the decider named as every admin
 * record names an account: the id and the current nickname, null once its member closed it), each
 * with its market's current judgement version — a dispute of an older one is of a version a 판정
 * 정정 replaced (#176, ADR-0105). Nothing here is public: the public `Market` carries the deadline,
 * the version and the flags (`toMarketSummary`), and the count, the statuses and the reasons are
 * #24's to publish.
 */

const MESSAGES: Readonly<Record<DisputeNotAllowedReason, string>> = {
  not_provisional: 'The market shows no provisional result to dispute',
  stale_version: 'The judgement version is not the market’s current one',
  deadline_passed: 'The dispute deadline has passed',
  admin: 'An admin account does not dispute a judgement',
  no_fill: 'Only an account with a fill on the market disputes its judgement',
  duplicate: 'The account has disputed this judgement version already',
  decided: 'The dispute is decided',
  retracted: 'The dispute is retracted',
  registrant: 'The registrant of the judgement does not decide its disputes',
  own: 'An admin does not decide a dispute they submitted',
};

/** DISPUTE_NOT_ALLOWED (409) with `details.reason` (`disputeNotAllowedDetailsSchema`). */
export function disputeNotAllowed(reason: DisputeNotAllowedReason): AppError {
  const details: DisputeNotAllowedDetails = { reason };
  return new AppError('DISPUTE_NOT_ALLOWED', { message: MESSAGES[reason], details });
}

const iso = (at: Date | null) => at?.toISOString() ?? null;

/** The market a dispute links to (`DisputeMarket`), its current judgement version among it. */
const disputeMarketOf = ({ id, slug, title, status, judgementVersion }: DisputeMarketRef) => ({
  id,
  slug,
  title,
  status,
  judgementVersion,
});

/**
 * What a dispute says and how it ended — decided, retracted or closed by a correction (#176) —
 * the submitter's and the operators' alike.
 */
function disputeFieldsOf(row: MarketDisputeRead | MemberDisputeRead) {
  return {
    id: row.id,
    judgementVersion: row.judgementVersion,
    links: [...row.links],
    reason: row.reason,
    status: row.status,
    submittedAt: row.submittedAt.toISOString(),
    decidedAt: iso(row.decidedAt),
    decisionReason: row.decisionReason,
    retractedAt: iso(row.retractedAt),
    closedAt: iso(row.closedAt),
  };
}

/**
 * One of the member's disputes (`MyDispute`): what it submitted, how it ended and the decision's
 * reason (#173 item 7), never who decided it (#173 item 13) — the row's `decided_by` stays here —
 * and whether it may still be retracted at `nowMs` (`disputeRetractionRefusal`: pending and its
 * version's deadline ahead; the database clock of the read).
 */
export function toMyDispute(row: MemberDisputeRead, nowMs: number): MyDispute {
  return {
    ...disputeFieldsOf(row),
    market: disputeMarketOf(row.market),
    retractable: disputeRetractionRefusal(row, row.disputeDeadline, nowMs) === null,
  };
}

const actor = (id: string, nickname: string | null): AdminAccountActor => ({ id, nickname });

/** A dispute on the admin screens, with who submitted and who decided it. */
export function toAdminMarketDispute(row: MarketDisputeRead): AdminMarketDispute {
  return {
    ...disputeFieldsOf(row),
    submitter: actor(row.userId, row.submitterNickname),
    decidedBy: row.decidedBy === null ? null : actor(row.decidedBy, row.deciderNickname),
    purgedAt: iso(row.purgedAt),
  };
}

/** One row of 이의 접수 (`GET /admin/market-disputes`): the dispute and its market. */
export function toAdminDisputeQueueItem(row: AdminDisputeRead): AdminDisputeQueueItem {
  return {
    ...toAdminMarketDispute(row),
    market: disputeMarketOf(row.market),
  };
}

/**
 * `AdminMarket.disputes` (#175, every status), through `executor` so a write answers with what it
 * wrote: the disputes of the market's current judgement version, the oldest first (none before a
 * judgement), and how many of them hold the confirmation (HOLDING_DISPUTE_STATUSES) — counted from
 * the rows, never from the `dispute_hold_count` mirror the labels read. One statement.
 */
export async function readAdminMarketDisputes(
  executor: Executor,
  row: Pick<MarketRow, 'id' | 'judgementVersion'>,
): Promise<AdminMarketDisputes> {
  const rows = await readMarketDisputes(executor, row.id, row.judgementVersion);
  return {
    holding: rows.filter((dispute) => isHoldingDisputeStatus(dispute.status)).length,
    items: rows.map(toAdminMarketDispute),
  };
}
