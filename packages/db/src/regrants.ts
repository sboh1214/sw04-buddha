import { randomUUID } from 'node:crypto';
import {
  adminRegrantListQuerySchema,
  decodeKeyset,
  encodeKeyset,
  idempotencyKeySchema,
  LIVE_ORDER_STATUSES,
  REGRANT_SETTINGS,
  RELEASE_SETTINGS,
  serializeCoinAmount,
  type AdminRegrantListQuery,
  type AdminRegrantPage,
  type RegrantRefusal,
  type RegrantStatusRead,
  type ReleaseSettingsRegistry,
} from '@buddha/shared';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { isHumanAccount } from './account-types.js';
import type { Db } from './client.js';
import {
  findLedgerAccount,
  ledgerKeys,
  lockLedgerAccounts,
  recordLedgerEntry,
  type BalanceRow,
  type LedgerEntryRow,
} from './ledger.js';
import { lockReconciliationUserKey, reconciliationUserHeld } from './reconciliation-holds.js';
import { getReleaseSettings } from './release-settings.js';
import {
  balances,
  moderationActions,
  orders,
  positions,
  profiles,
  regrants,
  startGrants,
} from './schema/index.js';
import { clockTimestamp } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

export type RegrantRow = typeof regrants.$inferSelect;

/*
 * 제한적 재지급 (#74, ADR-0155; owner answers 2026-11-21): the server half of `POST /me/regrant`
 * (`applyRegrant`) and `GET /me/regrant` (`regrantStatus`), and the admin records
 * (`readAdminRegrantPage`). The conditions, in the order REGRANT_REFUSALS names them:
 * the six release settings decided (12), no account restriction (8), no admin role (ADR-0156), no
 * #93 hold, the start grant paid (4), available Coin at or below the threshold (1), no waiting
 * order (2), no contract of a market not settled (7), the 대기기간 since the last re-grant or the
 * start grant passed, fewer re-grants in the last 주기 than its limit, and the 누적 상한 kept with
 * this one added — never a partial grant (5·6). Each is asked and every one that fails is named
 * (9). When none does, the request gets the amount at once (3): a REGRANT entry minted into the
 * account's user ledger account, and its `regrants` row.
 */

/** The six settings in one fixed order, read in one statement (`getReleaseSettings`). */
const SETTING_ORDER = [
  REGRANT_SETTINGS.thresholdCoin,
  REGRANT_SETTINGS.amountCoin,
  REGRANT_SETTINGS.waitHours,
  REGRANT_SETTINGS.periodDays,
  REGRANT_SETTINGS.periodLimit,
  REGRANT_SETTINGS.totalCapCoin,
] as const;

/** The six values, when all are decided (whatever their status, ADR-0069 decision 7). */
interface RegrantValues {
  thresholdCoin: bigint;
  amountCoin: bigint;
  waitHours: number;
  periodDays: number;
  periodLimit: number;
  totalCapCoin: bigint;
}

/** What the conditions read of the account, apart from its re-grants. */
interface RegrantFacts {
  restricted: boolean;
  /** The account holds the admin role (`profiles.role`, ADR-0156). */
  admin: boolean;
  held: boolean;
  /** When the account's start grant was paid; null when none was (pending, cancelled, none). */
  startGrantedAt: Date | null;
  /** The account's available Coin; null for an account with no user ledger account. */
  availableCoin: bigint | null;
  liveOrders: boolean;
  unsettledPositions: boolean;
}

/** The account's re-grants as the wait, the period and the cap count them, at `now`. */
interface RegrantHistory {
  totalGrantedCoin: bigint;
  lastAt: Date | null;
  periodUsed: number;
  /** When enough of the period's re-grants leave it to free one; null while one is free. */
  nextPeriodAt: Date | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

async function readValues(
  executor: Executor,
  registry: ReleaseSettingsRegistry,
): Promise<RegrantValues | null> {
  const readings = await getReleaseSettings(executor, registry, SETTING_ORDER);
  const values: number[] = [];
  for (const reading of readings) {
    if (reading.status === 'undecided') return null;
    values.push(reading.value);
  }
  const [threshold, amount, waitHours, periodDays, periodLimit, cap] = values as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return {
    thresholdCoin: BigInt(threshold),
    amountCoin: BigInt(amount),
    waitHours,
    periodDays,
    periodLimit,
    totalCapCoin: BigInt(cap),
  };
}

/**
 * Whether an account restriction stands on the account (#139): the rule apps/api
 * `accountRestrictionOf` reads, and `assertCanTrade` refuses an order by — the member's account
 * restrictions not cancelled whose end is still to come by the database clock. A writing
 * restriction does not stop a re-grant, as it does not stop trading (#57-12).
 */
async function accountRestricted(executor: Executor, userId: string): Promise<boolean> {
  const [standing] = await executor
    .select({ one: sql`1` })
    .from(moderationActions)
    .where(
      and(
        eq(moderationActions.userId, userId),
        eq(moderationActions.type, 'account_restriction'),
        isNull(moderationActions.cancelledAt),
        sql`(${moderationActions.endsAt} IS NULL OR ${moderationActions.endsAt} > clock_timestamp())`,
      ),
    )
    .limit(1);
  return standing !== undefined;
}

/**
 * Whether the account holds the admin role now, read without a lock (`regrantStatus`): an admin
 * never gets a re-grant while it holds the role (ADR-0156), as it never orders (ADR-0107 결정 5).
 * `applyRegrant` reads it with its profile lock instead.
 */
async function holdsAdminRole(executor: Executor, userId: string): Promise<boolean> {
  const [profile] = await executor
    .select({ role: profiles.role })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  return profile?.role === 'admin';
}

/** Whether an order of the account still rests in a book (대기·부분 체결, owner answer 2). */
async function hasLiveOrders(executor: Executor, userId: string): Promise<boolean> {
  const [live] = await executor
    .select({ one: sql`1` })
    .from(orders)
    .where(and(eq(orders.userId, userId), inArray(orders.status, [...LIVE_ORDER_STATUSES])))
    .limit(1);
  return live !== undefined;
}

/**
 * Whether the account holds a contract of a market not settled yet (owner answer 7): the
 * closure's rule (`unsettled_contracts`) — a position with `qty > 0`, not settled. A market whose
 * contracts the account sold entirely does not count.
 */
async function hasUnsettledPositions(executor: Executor, userId: string): Promise<boolean> {
  const [held] = await executor
    .select({ one: sql`1` })
    .from(positions)
    .where(and(eq(positions.userId, userId), gt(positions.qty, 0), eq(positions.settled, false)))
    .limit(1);
  return held !== undefined;
}

/** The account's start grant's payment time, or null; FOR UPDATE under `applyRegrant`. */
async function startGrantedAt(
  executor: Executor,
  userId: string,
  lock: boolean,
): Promise<Date | null> {
  const query = executor
    .select({ grantedAt: startGrants.grantedAt, cancelledAt: startGrants.cancelledAt })
    .from(startGrants)
    .where(eq(startGrants.userId, userId))
    .limit(1);
  const [grant] = await (lock ? query.for('update') : query);
  // Paid and cancelled exclude each other (start_grants_settled_check); paid is all that counts.
  return grant?.grantedAt ?? null;
}

/**
 * The account's re-grants at `now`: their lifetime total, the last one's time, how many fall in
 * the period (`created_at > now − periodDays`) and — when that many reach the limit — when enough
 * of them leave it to free one: the (used − limit + 1)-th oldest of them plus the period (the
 * oldest itself while the limit is unchanged; more when the limit was lowered since).
 */
async function readHistory(
  executor: Executor,
  userId: string,
  now: Date,
  values: Pick<RegrantValues, 'periodDays' | 'periodLimit'> | null,
): Promise<RegrantHistory | null> {
  if (values === null) return null;
  const periodMs = values.periodDays * DAY_MS;
  const since = new Date(now.getTime() - periodMs);
  const [row] = await executor
    .select({
      total: sql<string>`coalesce(sum(${regrants.amountCoin}), 0)::text`,
      lastAt: sql<Date | null>`max(${regrants.createdAt})`.mapWith(regrants.createdAt),
      periodUsed: sql<number>`(count(*) FILTER (WHERE ${regrants.createdAt} > ${since.toISOString()}::timestamptz))::int`,
    })
    .from(regrants)
    .where(eq(regrants.userId, userId));
  const periodUsed = row?.periodUsed ?? 0;
  let nextPeriodAt: Date | null = null;
  if (periodUsed >= values.periodLimit) {
    const [leaving] = await executor
      .select({ createdAt: regrants.createdAt })
      .from(regrants)
      .where(
        and(
          eq(regrants.userId, userId),
          sql`${regrants.createdAt} > ${since.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(regrants.createdAt), asc(regrants.id))
      .offset(periodUsed - values.periodLimit)
      .limit(1);
    if (leaving) nextPeriodAt = new Date(leaving.createdAt.getTime() + periodMs);
  }
  return {
    totalGrantedCoin: BigInt(row?.total ?? '0'),
    lastAt: row?.lastAt ?? null,
    periodUsed,
    nextPeriodAt,
  };
}

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
 * The status the conditions give (REGRANT_REFUSALS, in its order, every one that applies). With
 * a setting undecided only the reasons that need no value are asked, and every number is null;
 * `history` is null exactly then (`readHistory`).
 */
function decide(
  values: RegrantValues | null,
  facts: RegrantFacts,
  history: RegrantHistory | null,
  now: Date,
): RegrantStatusRead {
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
  // 대기기간: from the last re-grant, else from the start grant's payment (owner answer 5).
  const since = history.lastAt ?? facts.startGrantedAt;
  let waitUntil: Date | null = null;
  if (since !== null) {
    const until = new Date(since.getTime() + values.waitHours * HOUR_MS);
    if (now.getTime() < until.getTime()) {
      refusals.push('waiting');
      waitUntil = until;
    }
  }
  const periodFull = history.periodUsed >= values.periodLimit;
  if (periodFull) refusals.push('period_limit');
  // 누적 상한: this one added must stay within it, never granted in part (owner answer 6).
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

/** The facts of an account that is no person's (the 운영 마켓메이커, #115): it never gets one. */
const OPERATING_FACTS: RegrantFacts = {
  restricted: false,
  admin: false,
  held: false,
  startGrantedAt: null,
  availableCoin: null,
  liveOrders: false,
  unsettledPositions: false,
};

/**
 * `GET /me/regrant`: the account's status now, read without locks — what the wallet's card draws
 * (owner answers 9·10). The request asks everything again under its locks (`applyRegrant`), so a
 * status read a moment before can differ from the request's answer. The settings are read in one
 * statement, the clock is the database's.
 */
export async function regrantStatus(
  executor: Executor,
  userId: string,
  registry: ReleaseSettingsRegistry = RELEASE_SETTINGS,
): Promise<RegrantStatusRead> {
  let facts = OPERATING_FACTS;
  if (await isHumanAccount(executor, userId)) {
    const account = await findLedgerAccount(executor, { kind: 'user', userId });
    const [balance] =
      account === null
        ? []
        : await executor
            .select({ availableCoin: balances.availableCoin })
            .from(balances)
            .where(eq(balances.accountId, account.id))
            .limit(1);
    facts = {
      restricted: await accountRestricted(executor, userId),
      admin: await holdsAdminRole(executor, userId),
      held: await reconciliationUserHeld(executor, userId),
      startGrantedAt: await startGrantedAt(executor, userId, false),
      availableCoin: balance?.availableCoin ?? null,
      liveOrders: await hasLiveOrders(executor, userId),
      unsettledPositions: await hasUnsettledPositions(executor, userId),
    };
  }
  return statusOf(executor, userId, registry, facts);
}

/** The status of `facts` with the settings and the account's re-grants read now. */
async function statusOf(
  executor: Executor,
  userId: string,
  registry: ReleaseSettingsRegistry,
  facts: RegrantFacts,
): Promise<RegrantStatusRead> {
  const values = await readValues(executor, registry);
  const now = await clockTimestamp(executor);
  return decide(values, facts, await readHistory(executor, userId, now, values), now);
}

export interface ApplyRegrantInput {
  userId: string;
  /** The request's `Idempotency-Key` (idempotencyKeySchema, as sent: no blanks around it). */
  requestId: string;
  /** The API's injected registry; RELEASE_SETTINGS by default (as `placeOrder`'s). */
  registry?: ReleaseSettingsRegistry;
}

/**
 * What one request did:
 * - `granted`: this request granted the amount — the REGRANT entry, the balance after it and the
 *   `regrants` row, together;
 * - `replayed`: this request id granted before (an earlier request, or a twin that waited): its
 *   row as recorded, nothing written (N01 §9);
 * - `refused`: some condition failed, nothing written — the status read under the locks, every
 *   reason named. A refused request leaves no record: the same id applies afresh later.
 */
export type ApplyRegrantOutcome =
  | {
      outcome: 'granted';
      regrant: RegrantRow;
      entry: LedgerEntryRow;
      balance: BalanceRow;
      replayed: false;
    }
  | { outcome: 'replayed'; regrant: RegrantRow; replayed: true }
  | { outcome: 'refused'; status: RegrantStatusRead };

/**
 * One account's re-grant requests one at a time: the two-key form is a lock space of its own,
 * apart from the one-key market and admin-role locks and from the order request lock's first key,
 * so a hash collision can only make two requests wait for each other.
 */
async function lockRegrantAccount(tx: Tx, userId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('buddha:regrant'), hashtext(${userId}))`,
  );
}

async function regrantByRequest(
  executor: Executor,
  userId: string,
  requestId: string,
): Promise<RegrantRow | null> {
  const [row] = await executor
    .select()
    .from(regrants)
    .where(and(eq(regrants.userId, userId), eq(regrants.requestId, requestId)))
    .limit(1);
  return row ?? null;
}

/**
 * `POST /me/regrant` (#74, ADR-0155): grants the account its re-grant when every condition holds,
 * in the caller's transaction. Its locks come in this order, which keeps every other writer's
 * (ledger.ts's lock order; the profile first, as the closure and an account restriction take it):
 * 1. The account's profile row FOR KEY SHARE — `assertCanTrade`'s lock, which the API takes first
 *    for the RESTRICTED answer (taking it again is a no-op): an approved account restriction and a
 *    closure lock it FOR UPDATE before they write, so one in flight commits first and is seen.
 *    The same statement reads the role (ADR-0156): a role grant locks the grantee's profile FOR
 *    UPDATE NOWAIT before it writes `admin` (AdminAccountsService.grant, the seed's promotion;
 *    ADR-0120 결정 7), which conflicts with this lock — a grant in flight commits first and its
 *    role is read here, and one that comes later fails to lock the row until this re-grant
 *    commits (the grant is retried whole, at worst TRANSACTION_BUSY): it then follows the
 *    re-grant, given to a member. A revoke writes the row without that lock: racing it, a re-grant
 *    is refused for the role or given once the role is gone, both as the account stands.
 * 2. The account's re-grant lock (`pg_advisory_xact_lock`): two requests of one account never
 *    interleave — a second waits, then sees the first's row.
 * 3. The request id: a re-grant this id recorded before → `replayed`, before any condition, so a
 *    lost answer reads back whatever stands now.
 * 4. The account restriction (8) and the role read in (1), then the start grant FOR UPDATE: a
 *    payment in flight commits first (4) — after the profile, as the closure takes them (profile
 *    → 본인확인 기록 → grant → balance).
 * 5. #93's account key (`lockReconciliationUserKey`), before any balance lock as an order takes
 *    it, then whether a hold stands — an order is refused for it too (`ledger_hold`).
 * 6. The account's user ledger account FOR UPDATE (`lockLedgerAccounts`): the available Coin (1),
 *    then the waiting orders (2) and the unsettled contracts (7), which an order or a fill changes
 *    only under this lock.
 * 7. The six settings, in one statement (12), and the clock after the last lock; then the
 *    account's re-grants: the wait, the period and the cap (5·6).
 * With no reason, the REGRANT entry — a mint into the account's own user ledger account, ref and
 * key the new row's id, at that instant (`recordLedgerEntry`) — and the row naming it (migration
 * 0077 checks both ways). The 운영 마켓메이커 (no profile) is answered `no_start_grant` after (3)
 * and locks nothing more (#115; the table refuses its row too).
 *
 * Throws RangeError for a request id no request can carry (the API's header schema refuses it
 * first). A closed account is refused by the row's trigger (`regrants_open_account`, 23000), which
 * the API answers as the session that ended.
 */
export async function applyRegrant(tx: Tx, input: ApplyRegrantInput): Promise<ApplyRegrantOutcome> {
  const { userId, requestId } = input;
  const registry = input.registry ?? RELEASE_SETTINGS;
  const parsed = idempotencyKeySchema.safeParse(requestId);
  if (userId === '' || !parsed.success || parsed.data !== requestId) {
    throw new RangeError(`request id ${JSON.stringify(requestId)} is not a request id`);
  }

  // The role as the lock holds the row: no role grant commits until this transaction ends.
  const [profile] = await tx
    .select({ role: profiles.role })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .for('key share');
  await lockRegrantAccount(tx, userId);
  const earlier = await regrantByRequest(tx, userId, requestId);
  if (earlier) return { outcome: 'replayed', regrant: earlier, replayed: true };

  if (!(await isHumanAccount(tx, userId))) {
    return { outcome: 'refused', status: await statusOf(tx, userId, registry, OPERATING_FACTS) };
  }

  const restricted = await accountRestricted(tx, userId);
  const grantedAt = await startGrantedAt(tx, userId, true);
  await lockReconciliationUserKey(tx, userId);
  const held = await reconciliationUserHeld(tx, userId);
  const [locked] = await lockLedgerAccounts(tx, [{ kind: 'user', userId }]);
  const availableCoin = locked!.balance.availableCoin;
  const facts: RegrantFacts = {
    restricted,
    admin: profile?.role === 'admin',
    held,
    startGrantedAt: grantedAt,
    availableCoin,
    liveOrders: await hasLiveOrders(tx, userId),
    unsettledPositions: await hasUnsettledPositions(tx, userId),
  };
  const values = await readValues(tx, registry);
  const now = await clockTimestamp(tx);
  const status = decide(values, facts, await readHistory(tx, userId, now, values), now);
  if (!status.eligible || values === null) return { outcome: 'refused', status };

  const id = randomUUID();
  const recorded = await recordLedgerEntry(tx, {
    type: 'REGRANT',
    amountCoin: values.amountCoin,
    from: null,
    to: { kind: 'user', userId },
    refType: 'regrant',
    refId: id,
    idempotencyKey: ledgerKeys.regrant(id),
    // The type says what it is ('재지급' on the wallet); nothing else to note.
    memo: null,
    at: now,
  });
  // A fresh id: its key cannot have been recorded.
  if (recorded.outcome !== 'recorded' || !recorded.to) {
    throw new Error(`re-grant ${id} found its ledger entry recorded already`);
  }
  const [regrant] = await tx
    .insert(regrants)
    .values({
      id,
      userId,
      requestId,
      amountCoin: values.amountCoin,
      availableBeforeCoin: availableCoin,
      ledgerEntryId: recorded.entry.id,
      createdAt: now,
    })
    .returning();
  if (!regrant) throw new Error(`re-grant ${id} could not be recorded`);
  return {
    outcome: 'granted',
    regrant,
    entry: recorded.entry,
    balance: recorded.to,
    replayed: false,
  };
}

/**
 * `GET /admin/regrants` (owner answer 3: the admin screen reads the records only): every account's
 * re-grants, newest first (`created_at DESC, id DESC`, `regrants_created_at_id_idx`), one cursor
 * page (PLAN 7) — the account by its id, public id and nickname (null once closed, #140), the Coin
 * given, the available Coin under the lock, and when. A malformed cursor reads the first page.
 */
export async function readAdminRegrantPage(
  executor: Executor,
  input: Partial<AdminRegrantListQuery> = {},
): Promise<AdminRegrantPage> {
  const query = adminRegrantListQuerySchema.parse(input);
  const cursor = decodeKeyset(query.cursor, 'uuid');
  const rows = await executor
    .select({
      id: regrants.id,
      userId: regrants.userId,
      publicId: profiles.publicId,
      nickname: profiles.nickname,
      amountCoin: regrants.amountCoin,
      availableBeforeCoin: regrants.availableBeforeCoin,
      createdAt: regrants.createdAt,
    })
    .from(regrants)
    .innerJoin(profiles, eq(profiles.userId, regrants.userId))
    .where(
      cursor
        ? sql`(${regrants.createdAt}, ${regrants.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
        : undefined,
    )
    .orderBy(desc(regrants.createdAt), desc(regrants.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map((row) => ({
      id: row.id,
      account: { userId: row.userId, publicId: row.publicId, nickname: row.nickname },
      amountCoin: serializeCoinAmount(row.amountCoin),
      availableBeforeCoin: serializeCoinAmount(row.availableBeforeCoin),
      createdAt: row.createdAt.toISOString(),
    })),
    meta: {
      nextCursor:
        rows.length > query.limit && last
          ? encodeKeyset({ createdAt: last.createdAt, id: last.id })
          : null,
    },
  };
}

/** The account's re-grants, newest first (a reader's; no member route lists them). */
export async function regrantsOf(executor: Executor, userId: string): Promise<RegrantRow[]> {
  return executor
    .select()
    .from(regrants)
    .where(eq(regrants.userId, userId))
    .orderBy(desc(regrants.createdAt), desc(regrants.id));
}
