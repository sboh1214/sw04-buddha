import { idempotencyKeySchema, type REGRANT_REFUSALS } from '../../packages/shared/dist/index.js';

/*
 * #332: the re-grant rule of #74 (ADR-0155) re-implemented for the #71 model, unchanged —
 * `decide()` (packages/db/src/regrants.ts), `readHistory()`'s period window and `applyRegrant()`'s
 * request-id handling, with time as milliseconds instead of database timestamps. #74's code is not
 * imported or changed (#332 excludes changes to #74); rule.test.ts pins the mirrored source and
 * replays #74's boundary cases. A synthetic test input, never a decided or recommended value.
 */

export type RegrantRefusal = (typeof REGRANT_REFUSALS)[number];

/** The six release settings (`grant.regrant_*`), all decided; null models '준비 중'. */
export interface RegrantValues {
  thresholdCoin: bigint;
  amountCoin: bigint;
  waitHours: number;
  periodDays: number;
  periodLimit: number;
  totalCapCoin: bigint;
}

/** What the conditions read of the account, apart from its re-grants (RegrantFacts). */
export interface RegrantFacts {
  restricted: boolean;
  admin: boolean;
  held: boolean;
  /** When the start grant was paid (ms); null when none was. */
  startGrantedAt: number | null;
  /** Available Coin — locked Coin excluded; null for an account with no user ledger account. */
  availableCoin: bigint | null;
  liveOrders: boolean;
  unsettledPositions: boolean;
}

/** The account's re-grants at `now` (RegrantHistory). */
export interface RegrantHistory {
  totalGrantedCoin: bigint;
  lastAt: number | null;
  periodUsed: number;
  nextPeriodAt: number | null;
}

export interface RegrantStatus {
  open: boolean;
  eligible: boolean;
  refusals: RegrantRefusal[];
  amountCoin: bigint | null;
  thresholdCoin: bigint | null;
  waitHours: number | null;
  waitUntil: number | null;
  periodDays: number | null;
  periodLimit: number | null;
  periodUsed: number | null;
  nextPeriodAt: number | null;
  totalCapCoin: bigint | null;
  totalGrantedCoin: bigint | null;
  remainingCapCoin: bigint | null;
}

/** One recorded re-grant (the `regrants` row the rule reads). */
export interface RegrantRow {
  /** Sequence within the account: the tie-break of `asc(created_at), asc(id)`. */
  id: number;
  requestId: string;
  amountCoin: bigint;
  availableBeforeCoin: bigint;
  createdAt: number;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

const CLOSED_NUMBERS = {
  amountCoin: null,
  thresholdCoin: null,
  waitHours: null,
  waitUntil: null,
  periodDays: null,
  periodLimit: null,
  periodUsed: null,
  nextPeriodAt: null,
  totalCapCoin: null,
  totalGrantedCoin: null,
  remainingCapCoin: null,
} as const;

/**
 * `readHistory()`: the lifetime total, the last one's time, how many fall in the period
 * (`created_at > now − periodDays`, strict) and — when they reach the limit — the
 * (used − limit + 1)-th oldest of them plus the period. Null exactly while not ready.
 */
export function readHistory(
  rows: readonly RegrantRow[],
  now: number,
  values: Pick<RegrantValues, 'periodDays' | 'periodLimit'> | null,
): RegrantHistory | null {
  if (values === null) return null;
  const periodMs = values.periodDays * DAY_MS;
  const since = now - periodMs;
  let total = 0n;
  let lastAt: number | null = null;
  const inPeriod: RegrantRow[] = [];
  for (const row of rows) {
    total += row.amountCoin;
    if (lastAt === null || row.createdAt > lastAt) lastAt = row.createdAt;
    if (row.createdAt > since) inPeriod.push(row);
  }
  const periodUsed = inPeriod.length;
  let nextPeriodAt: number | null = null;
  if (periodUsed >= values.periodLimit) {
    inPeriod.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
    const leaving = inPeriod[periodUsed - values.periodLimit];
    if (leaving) nextPeriodAt = leaving.createdAt + periodMs;
  }
  return { totalGrantedCoin: total, lastAt, periodUsed, nextPeriodAt };
}

/**
 * `decide()`: every refusal that applies, in REGRANT_REFUSALS' order. With a setting undecided
 * only the reasons that need no value are asked, and every number is null.
 */
export function decide(
  values: RegrantValues | null,
  facts: RegrantFacts,
  history: RegrantHistory | null,
  now: number,
): RegrantStatus {
  const refusals: RegrantRefusal[] = [];
  if (values === null) refusals.push('not_ready');
  if (facts.restricted) refusals.push('restricted');
  if (facts.admin) refusals.push('admin');
  if (facts.held) refusals.push('held');
  if (facts.startGrantedAt === null) refusals.push('no_start_grant');
  if (values === null || history === null) {
    return { open: false, eligible: false, refusals, ...CLOSED_NUMBERS };
  }
  if (facts.availableCoin !== null && facts.availableCoin > values.thresholdCoin) {
    refusals.push('not_exhausted');
  }
  if (facts.liveOrders) refusals.push('live_orders');
  if (facts.unsettledPositions) refusals.push('unsettled_positions');
  const since = history.lastAt ?? facts.startGrantedAt;
  let waitUntil: number | null = null;
  if (since !== null) {
    const until = since + values.waitHours * HOUR_MS;
    if (now < until) {
      refusals.push('waiting');
      waitUntil = until;
    }
  }
  const periodFull = history.periodUsed >= values.periodLimit;
  if (periodFull) refusals.push('period_limit');
  if (history.totalGrantedCoin + values.amountCoin > values.totalCapCoin) {
    refusals.push('total_cap');
  }
  const remaining = values.totalCapCoin - history.totalGrantedCoin;
  return {
    open: true,
    eligible: refusals.length === 0,
    refusals,
    amountCoin: values.amountCoin,
    thresholdCoin: values.thresholdCoin,
    waitHours: values.waitHours,
    waitUntil,
    periodDays: values.periodDays,
    periodLimit: values.periodLimit,
    periodUsed: history.periodUsed,
    nextPeriodAt: periodFull ? history.nextPeriodAt : null,
    totalCapCoin: values.totalCapCoin,
    totalGrantedCoin: history.totalGrantedCoin,
    remainingCapCoin: remaining > 0n ? remaining : 0n,
  };
}

export type ApplyOutcome =
  | { outcome: 'granted'; regrant: RegrantRow }
  | { outcome: 'replayed'; regrant: RegrantRow }
  | { outcome: 'refused'; status: RegrantStatus };

/**
 * One account's `applyRegrant()`: a request id no header carries throws RangeError; an id that
 * granted before reads its row back before any condition; a refusal records nothing (the same id
 * applies afresh later); otherwise the row is recorded. The caller mints `amountCoin`.
 */
export class RegrantAccount {
  readonly rows: RegrantRow[] = [];
  private readonly byRequest = new Map<string, RegrantRow>();

  apply(
    requestId: string,
    values: RegrantValues | null,
    facts: RegrantFacts,
    now: number,
  ): ApplyOutcome {
    const parsed = idempotencyKeySchema.safeParse(requestId);
    if (!parsed.success || parsed.data !== requestId)
      throw new RangeError(`request id ${JSON.stringify(requestId)} is not a request id`);
    const earlier = this.byRequest.get(requestId);
    if (earlier) return { outcome: 'replayed', regrant: earlier };
    const status = decide(values, facts, readHistory(this.rows, now, values), now);
    if (!status.eligible || values === null) return { outcome: 'refused', status };
    const regrant: RegrantRow = {
      id: this.rows.length + 1,
      requestId,
      amountCoin: values.amountCoin,
      availableBeforeCoin: facts.availableCoin ?? 0n,
      createdAt: now,
    };
    this.rows.push(regrant);
    this.byRequest.set(requestId, regrant);
    return { outcome: 'granted', regrant };
  }
}
