/**
 * The market lifecycle's allowed transitions (N03 §3, ADR-0093 decision 1 items 1·3·4·10 and
 * decision 2 #172 item 6, result 1; #174). Every writer of `markets.status` — the API's admin
 * actions and the worker's jobs — goes through `transitionMarket` (@buddha/db), which refuses a
 * pair this table does not list, so the table IS the server's state machine. Which actor may
 * take an edge (a timer, one admin, an admin with another's approval) is the action's own rule,
 * made by the issue that adds the action; the table only says which edges exist.
 *
 * Not here, on purpose:
 * - CLOSED → OPEN·PAUSED: no reopening after the close, without exception (item 4).
 * - Any edge into VOID: VOID is a result (`MARKET_RESULTS`), chosen in the judgement (item 4).
 * - RESOLVED → PROVISIONAL: a correction happens in PROVISIONAL only (item 8), so it changes the
 *   result and republishes the status without a status change.
 */
import type { MarketStatus } from './enums.js';

/**
 * The lifecycle ADR-0093 decided, keyed by the status a market leaves. The issue that makes
 * each edge happen is named beside it; until it lands, the edge exists but nothing takes it.
 */
export const MARKET_LIFECYCLE_TRANSITIONS: Readonly<Record<MarketStatus, readonly MarketStatus[]>> =
  {
    // #78: submitted for review once the open-items check passes (the content locks, #172 item 6).
    draft: ['review'],
    // #78: approved by an admin other than the creator, the editors and the submitter; rejected
    // (반려) by such an admin, or sent back (되돌리기) by any admin with a reason (#172 items 5·6,
    // #173 item 1). Approved at or after its scheduled open, it is scheduled all the same and the
    // approval opens it in the same transaction (#21, #172 item 6): scheduled, then open, two
    // transitions.
    review: ['scheduled', 'draft'],
    // #21: opened by the worker at its scheduled open (actor NULL), or at once by the approval or
    // by #78's reschedule (a move with a reason and no new review) that finds that time already
    // come — never once its close has passed, which an admin fixes by sending it back to a draft
    // (#173 item 1, #172 item 6). #78: sent back to a draft by any admin with a reason, to edit and
    // review again (#172 item 6). #173·#20: ended without opening with another admin's approval
    // (#173 item 10).
    scheduled: ['open', 'draft', 'cancelled'],
    // #114: paused by one admin (#173 item 2). At `close_at` the worker closes it, or (#120, #20)
    // cancels it when no user fill happened.
    open: ['paused', 'closed', 'cancelled'],
    // #114: resumed (재개) or closed early (조기 마감), each asked for by one admin and approved by
    // another (#173 items 2·4); at `close_at` as above, on schedule and never later (#173 item 3).
    paused: ['open', 'closed', 'cancelled'],
    // #152: the judgement published once an admin other than its registrant approves it (#173
    // item 1, ADR-0103); a rejected one leaves the market CLOSED to be judged again.
    closed: ['provisional'],
    // #152: confirmed by the worker (actor NULL) once the dispute deadline has passed with nothing
    // held — #175's disputes and #176's corrections add the holds (#173 item 1).
    provisional: ['resolved'],
    // #126: the payout starts at once (item 1).
    resolved: ['settling'],
    // #126: every payout and contract retirement reconciled (N03 §7, item 14).
    settling: ['settled'],
    settled: [],
    cancelled: [],
  };

/**
 * Edges that keep today's admin actions working on the new statuses until the issue that
 * replaces each one merges (ADR-0047 result 3). Each is deleted by that issue's PR, which also
 * removes the action that takes it: #21 deleted ADR-0027's direct open from a draft (draft →
 * open, ADR-0093 result 2; ADR-0100), so a market opens only from SCHEDULED or, by #114's approved
 * resume, from PAUSED. #114 deleted the one-admin close (ADR-0102), which took the lasting open →
 * closed edge and so was never listed here: an early end is a pause and an approved early close.
 * #152 deleted ADR-0046's immediate judgement by one admin (closed → resolved, ADR-0103), which
 * skipped PROVISIONAL and the dispute window: a judgement is registered, another admin approves it
 * (CLOSED → PROVISIONAL) and the worker confirms it at its deadline (PROVISIONAL → RESOLVED). None
 * is left; the list stays for the next interim edge, if one is ever needed.
 */
export const INTERIM_MARKET_TRANSITIONS: readonly {
  from: MarketStatus;
  to: MarketStatus;
  /** The issue whose PR removes the edge. */
  until: string;
}[] = [];

/** Whether the server lets a market go from `from` to `to` (#174 acceptance criterion 3). */
export function canTransitionMarket(from: MarketStatus, to: MarketStatus): boolean {
  return (
    MARKET_LIFECYCLE_TRANSITIONS[from].includes(to) ||
    INTERIM_MARKET_TRANSITIONS.some((edge) => edge.from === from && edge.to === to)
  );
}

/**
 * Statuses in which a market has not been closed yet: trading has not ended, and `close_at` is
 * still ahead or due (ADR-0093 decision 1 item 3: a paused market closes on schedule). DRAFT
 * and REVIEW count too — nothing has closed them — though only the admin sees them.
 */
export const PRE_CLOSE_MARKET_STATUSES = [
  'draft',
  'review',
  'scheduled',
  'open',
  'paused',
] as const satisfies readonly MarketStatus[];

export function isPreCloseMarketStatus(status: MarketStatus): boolean {
  return (PRE_CLOSE_MARKET_STATUSES as readonly MarketStatus[]).includes(status);
}
