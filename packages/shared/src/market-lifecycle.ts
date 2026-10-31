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
    // #78: submitted for review (the content locks, #172 item 6).
    draft: ['review'],
    // #78: approved by another admin, or sent back to a draft. Approved after its scheduled
    // open time, it opens at once (#172 item 6): scheduled, then open, two transitions.
    review: ['scheduled', 'draft'],
    // #21: opens at its scheduled time; back to a draft to edit before opening; ended without
    // opening with another admin's approval (#172 item 6, #173 item 10).
    scheduled: ['open', 'draft', 'cancelled'],
    // #114: paused. At `close_at`: closed, or cancelled when no user fill happened (#120, #20).
    open: ['paused', 'closed', 'cancelled'],
    // #114: resumed or closed early, both with another admin's approval; at `close_at` as above,
    // on schedule (#173 item 3).
    paused: ['open', 'closed', 'cancelled'],
    // #152: the judgement published once another admin approves it.
    closed: ['provisional'],
    // #152·#175·#176: confirmed when the dispute window ends with nothing pending.
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
 * replaces each one merges (ADR-0047 result 3; ADR-0093 result 2 for ADR-0027). Each is
 * deleted by that issue's PR, which also removes the action that takes it.
 */
export const INTERIM_MARKET_TRANSITIONS: readonly {
  from: MarketStatus;
  to: MarketStatus;
  /** The issue whose PR removes the edge. */
  until: string;
}[] = [
  // ADR-0027's direct open from a draft, without review or a scheduled time (#78·#21).
  { from: 'draft', to: 'open', until: '#21' },
  // ADR-0046's immediate judgement by one admin, skipping PROVISIONAL and the dispute window.
  { from: 'closed', to: 'resolved', until: '#152' },
];

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
