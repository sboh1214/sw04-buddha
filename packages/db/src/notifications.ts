import { randomUUID } from 'node:crypto';
import {
  NOTIFICATION_DEFINITIONS,
  NOTIFICATION_EVENT_KEY_PATTERN,
  NOTIFICATION_UNREAD_COUNT_CAP,
  notificationParamsSchema,
  notificationTargetSchema,
  type NotificationCategory,
  type NotificationDefinition,
  type NotificationParamValues,
  type NotificationTarget,
} from '@buddha/shared';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { notificationInboxes, notificationKeys, notifications } from './schema/index.js';
import { clockTimestamp } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

export type NotificationRow = typeof notifications.$inferSelect;

/*
 * 앱 내 알림함 (#53, ADR-0157): the ONE write path of notifications, and the member's reads.
 * Every producer — #134 (거래), #54 (시장 상태), #188 (판정·정산), #135 (커뮤니티), #144
 * (정정·보상) — calls `createNotifications` and nothing else writes a notification. The rules it
 * holds bind them all:
 *
 * - Same transaction (53-4 '사건과 같은 DB 트랜잭션'): ONE call per transaction, with every
 *   recipient of the event, after the event's other writes — nothing locks after it but the
 *   COMMIT. A duplicate is an outcome, never an error; anything thrown (a validation failure, a
 *   database error — NotificationWriteError, which names no recipient) rolls back with the event:
 *   no retry queue, no partial notification. A producer that wants its event to stand whatever
 *   happens to the notification has no such option (#52 item 18, AC 10 '생성 실패 때의 처리').
 * - The type list (52-20): every input is validated against its definition
 *   (NOTIFICATION_DEFINITIONS; the tests pass their own through `options.definitions`, which no
 *   production source may do — notifications.test.ts's static guard) — an unknown type, params its
 *   schema refuses, a target kind it does not lead to, a merge key on a type that does not merge
 *   (or none on one that does) and a bad event key throw before anything is written.
 * - Recipients (53-5, 53-6): a person's account with an inbox, restricted or not. The inbox is
 *   taken FOR KEY SHARE SKIP LOCKED in one statement: an account with none — the 운영 마켓메이커,
 *   a closed account, no account — or one a closure holds FOR UPDATE is `skipped`. It never waits,
 *   so no producer deadlocks with a closure whatever locks it holds; holding the KEY SHARE makes a
 *   closure that starts now wait for this COMMIT and then delete what it wrote. Row locks, not
 *   advisory ones: a market's close may notify thousands of members.
 * - 수신 설정 (#56, ADR-0162; 52-21, 52-22, 56-1): the same statement reads the inbox's
 *   `categories_off`, and an input whose type's category the member turned off is `skipped`
 *   (`category_off`) — per input, never per call or per member: one call may mix categories (a
 *   pause's `orders_cancelled` and `market_paused`), and a member with 거래 off and 시장 on gets
 *   the second only. `no_inbox` comes first (a closed account has no settings). A skipped input
 *   reaches no insert and no merge: no row, no key claimed (a key needs its row, so a later event
 *   is never blocked by it), no `FOR UPDATE` of the unread row, its count and 발생 시각 untouched.
 *   What the inbox already holds stays as it is (56-1) — the readers below never read the setting.
 *   Turned on again, the next event is delivered as any: a merge joins the still-unread row of its
 *   group (52-6, 52-7), which counts the delivered events only. Every producer, and every later
 *   one (#144), passes this step: nothing else writes a notification (notifications.test.ts pins
 *   it), so no producer is edited.
 *   The switch is judged at the gate's moment, in READ COMMITTED: the gate sees the last committed
 *   `categories_off`. A settings write (`setNotificationCategory`) is one plain UPDATE of a column
 *   no unique index holds: FOR NO KEY UPDATE, which FOR KEY SHARE does not conflict with —
 *   PostgreSQL grants the KEY SHARE without sleeping when the row's updater changed no key column
 *   (the property the foreign keys to the inbox already rely on), so the gate neither waits for an
 *   open settings write nor skips the member (it reads the old value until that write commits).
 *   A settings write that took the row FOR UPDATE would make the gate skip the member as
 *   `no_inbox` while open — never do it (the static pin, and the column grant of migration 0079).
 * - Dedupe (53-4): a key per member, type and event id (`notification_keys`). The same event
 *   reprocessed for a member is `duplicate` (silently: the event goes on); another type is its own
 *   notification. A concurrent duplicate waits on the key's unique index and ends `duplicate` once
 *   the first commits ("동시에 와도 한 건만"). Keys live as long as their notification: once the
 *   retention deletes it, the same event reprocessed would notify again (accepted).
 * - Cost under the producer's locks (#54, ADR-0159): every input that does not merge is delivered
 *   in ONE statement whatever the recipients (a market's close may notify every watcher and
 *   holder, under its market lock and the order owners' balances) — the rows and their keys from
 *   one JSON parameter, the keys `ON CONFLICT DO NOTHING`, then one DELETE of the rows whose key
 *   was taken (`duplicate`) only when there are some. Mergeable inputs follow one by one. The
 *   statement inserts only new rows and waits only on the key of the same (member, type, event).
 * - Merge (52-6, 52-7, 134-2): a mergeable type's event joins the account's unread notification of
 *   the same type and merge key — its params folded by the definition's `merge`, its event count
 *   up by one, its 발생 시각 raised to the event's (the row moves to the top) — keeping its target,
 *   category and creation. A read notification is never a merge target: the next event after
 *   reading makes a new one.
 * - Stored params never fail an event. An unread row may hold params an earlier version of its
 *   type wrote, so a mergeable type's params schema should only gain optional fields, and its
 *   `merge` should accept every shape it ever stored. When the held params no longer parse, the
 *   merge throws on them or its result does not parse, the event's own params replace them — the
 *   count still goes up by one and the 발생 시각 is still raised — and the outcome says so
 *   (`merged` with `paramsReset`): a safety net, not a design; the producer's event commits.
 * - Never publish inside the transaction: after COMMIT, the API publishes `notificationEvent(at)`
 *   (`MarketPublisher.publishUser`) and the worker on `userChannel` to `notifiedUserIds(outcomes)`.
 *
 * Inputs are processed in one fixed order — (account, type, merge key, event key) — so concurrent
 * writers take the rows they lock in the same order: the non-merging ones first, in that order in
 * their one statement, then the merging ones. No producer mixes the two in one call today.
 */

/** One notification to deliver: who, which type, the event it tells, and what it shows. */
export interface NotificationInput {
  /** The recipient (`user.id`). */
  readonly userId: string;
  /** A type of the definitions (NOTIFICATION_DEFINITIONS unless the tests pass theirs). */
  readonly type: string;
  /** The event's id as the producer keys it (NOTIFICATION_EVENT_KEY_PATTERN): the dedupe key. */
  readonly eventKey: string;
  /** The type's parameters (its definition's schema). */
  readonly params: NotificationParamValues;
  /** Where it leads: a kind among the definition's `targets`. */
  readonly target: NotificationTarget;
  /** A mergeable type's merge key (the order, the post, the comment); absent for any other. */
  readonly mergeKey?: string | undefined;
  /** The event's 발생 시각; the database clock of the write when absent. */
  readonly occurredAt?: Date | undefined;
}

/**
 * Why a recipient got nothing: `no_inbox` — no person's open account, or a closure in flight;
 * `category_off` — the member turned the input's category off (#56, 52-22: nothing is made while
 * off; 56-1: what the inbox holds stays).
 */
export type NotificationSkipReason = 'no_inbox' | 'category_off';

/** What became of one input, in the inputs' order. */
export type NotificationOutcome =
  | { readonly kind: 'created'; readonly id: string; readonly userId: string }
  | {
      readonly kind: 'merged';
      readonly id: string;
      readonly userId: string;
      /**
       * True when the held params could not be folded (they no longer fit the type, or its merge
       * refused them) and the event's own params replaced them; the event still counted.
       */
      readonly paramsReset: boolean;
    }
  | { readonly kind: 'duplicate'; readonly userId: string }
  | { readonly kind: 'skipped'; readonly userId: string; readonly reason: NotificationSkipReason };

export interface CreateNotificationsOptions {
  /** The type list. Tests only (their own types); production uses NOTIFICATION_DEFINITIONS. */
  readonly definitions?: readonly NotificationDefinition[];
}

/** A producer bug: an input its definition refuses. Thrown before anything is written. */
export class NotificationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationInputError';
  }
}

/**
 * Any failure of `createNotifications`'s statements, told without its recipients (#54, ADR-0159).
 * Those statements bind every recipient's account id (the gate's array, the rows' one JSON
 * parameter); drizzle's DrizzleQueryError writes the bound values into its message and stack, and
 * the driver's error can quote a key in `detail`, `where` or `hint`. The callers keep what they
 * catch — the worker's scan result BullMQ stores, a job's `failedReason`, the log lines — so the
 * original never leaves this module. This keeps what the callers classify on, as they read it
 * off a driver error: the SQLSTATE `code` (withTransactionRetry's 40001/40P01/55P03, apps/api
 * pg-error.ts, the worker's messageOf) and `constraint`, plus the driver's short message with any
 * recipient's id cut out. It has no `cause`.
 */
export class NotificationWriteError extends Error {
  /** The SQLSTATE when Postgres refused a statement; undefined for any other failure. */
  readonly code: string | undefined;
  /** The constraint (or the trigger raising as one) Postgres named, if any. */
  readonly constraint: string | undefined;

  constructor(message: string, pg: { code?: string; constraint?: string | undefined } = {}) {
    super(message);
    this.name = 'NotificationWriteError';
    this.code = pg.code;
    this.constraint = pg.constraint;
  }
}

/** How many links of a cause chain `writeFailure` reads (drizzle's wrapper, then the driver's). */
const CAUSE_DEPTH = 5;

/** A node-postgres DatabaseError as `writeFailure` reads it: `code` is the SQLSTATE. */
function driverErrorOf(
  value: unknown,
): { code: string; message: string; constraint?: unknown } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { code, message } = value as { code?: unknown; message?: unknown };
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && typeof message === 'string'
    ? (value as { code: string; message: string; constraint?: unknown })
    : undefined;
}

/** drizzle's wrapper of a failed query (its SQL and bound values), recognised by its shape. */
function isFailedQuery(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { query, params } = value as { query?: unknown; params?: unknown };
  return typeof query === 'string' && Array.isArray(params);
}

/**
 * `error` as NotificationWriteError (see there): the driver's SQLSTATE, constraint and message
 * when Postgres refused a statement, else the message of the first link that is not drizzle's
 * wrapper (a lost connection, a bug), each with every id of `userIds` replaced.
 */
function writeFailure(error: unknown, userIds: readonly string[]): NotificationWriteError {
  const scrub = (text: string) =>
    userIds.reduce(
      (out, id) => (id !== '' && out.includes(id) ? out.split(id).join('<recipient>') : out),
      text,
    );
  let reason: string | undefined;
  let link = error;
  for (let depth = 0; depth < CAUSE_DEPTH && link !== undefined && link !== null; depth++) {
    const driver = driverErrorOf(link);
    if (driver !== undefined) {
      const { constraint } = driver;
      return new NotificationWriteError(`notification write failed: ${scrub(driver.message)}`, {
        code: driver.code,
        constraint: typeof constraint === 'string' ? constraint : undefined,
      });
    }
    if (reason === undefined && !isFailedQuery(link)) {
      reason =
        link instanceof Error ? link.message : typeof link === 'string' ? link : 'a thrown value';
    }
    link = typeof link === 'object' && 'cause' in link ? link.cause : undefined;
  }
  return new NotificationWriteError(
    `notification write failed: ${scrub(reason ?? 'a query failed')}`,
  );
}

/** The rounds a merge may race a concurrent read or insert before it gives up (a bug). */
const MERGE_ROUNDS = 3;

/** An input as validated: its definition and the parsed values the row stores. */
interface CheckedInput {
  readonly index: number;
  readonly input: NotificationInput;
  readonly definition: NotificationDefinition;
  readonly params: NotificationParamValues;
  readonly target: NotificationTarget;
  readonly mergeKey: string | null;
}

function check(
  input: NotificationInput,
  index: number,
  byType: ReadonlyMap<string, NotificationDefinition>,
): CheckedInput {
  const where = `notification input ${String(index)} (${input.type})`;
  const definition = byType.get(input.type);
  if (definition === undefined) throw new NotificationInputError(`${where}: unknown type`);
  if (!NOTIFICATION_EVENT_KEY_PATTERN.test(input.eventKey)) {
    throw new NotificationInputError(`${where}: bad event key`);
  }
  const mergeKey = input.mergeKey ?? null;
  if (mergeKey !== null && !NOTIFICATION_EVENT_KEY_PATTERN.test(mergeKey)) {
    throw new NotificationInputError(`${where}: bad merge key`);
  }
  if ((mergeKey !== null) !== (definition.merge !== null)) {
    throw new NotificationInputError(
      definition.merge === null
        ? `${where}: a merge key on a type that does not merge`
        : `${where}: no merge key on a type that merges`,
    );
  }
  const params = definition.params.safeParse(input.params);
  if (!params.success || !notificationParamsSchema.safeParse(params.data).success) {
    throw new NotificationInputError(`${where}: params its definition refuses`);
  }
  const target = notificationTargetSchema.safeParse(input.target);
  if (!target.success || !definition.targets.includes(target.data.kind)) {
    throw new NotificationInputError(`${where}: a target it does not lead to`);
  }
  return { index, input, definition, params: params.data, target: target.data, mergeKey };
}

/** The fixed processing order: (account, type, merge key, event key). */
function compareChecked(a: CheckedInput, b: CheckedInput): number {
  const keys = (c: CheckedInput) => [
    c.input.userId,
    c.input.type,
    c.mergeKey ?? '',
    c.input.eventKey,
  ];
  const left = keys(a);
  const right = keys(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i]! < right[i]!) return -1;
    if (left[i]! > right[i]!) return 1;
  }
  return a.index - b.index;
}

/**
 * Claims the event's key for notification `id`: true when this event reaches the member for the
 * first time, false when the same type and event already did (53-4). Waits on a concurrent claim
 * of the same key until it commits or rolls back.
 */
async function claimKey(tx: Tx, checked: CheckedInput, id: string): Promise<boolean> {
  const claimed = await tx
    .insert(notificationKeys)
    .values({
      userId: checked.input.userId,
      type: checked.input.type,
      eventKey: checked.input.eventKey,
      notificationId: id,
    })
    .onConflictDoNothing({
      target: [notificationKeys.userId, notificationKeys.type, notificationKeys.eventKey],
    })
    .returning({ notificationId: notificationKeys.notificationId });
  return claimed.length > 0;
}

/** The row values of a new notification. */
function rowOf(checked: CheckedInput, occurredAt: Date, at: Date) {
  return {
    userId: checked.input.userId,
    type: checked.input.type,
    category: checked.definition.category,
    params: { ...checked.params },
    target: checked.target,
    mergeKey: checked.mergeKey,
    occurredAt,
    createdAt: at,
  };
}

/**
 * Every non-mergeable input of the call (`items`, in the processing order) in one statement (#54,
 * ADR-0159): each a row of its own with a random id, and its key claimed for it — a row whose key
 * another notification already holds (the same event reprocessed, a twin in this call, or a
 * concurrent delivery that committed first) is deleted again and answers `duplicate`. One JSON
 * parameter carries the rows, so no bind-parameter limit applies however many recipients. The
 * keys are inserted in the processing order (`ord`), as one-by-one inserts would take them; the
 * foreign key from a key to its row is checked at the end of the statement, which sees `made`.
 */
async function createMany(
  tx: Tx,
  items: readonly CheckedInput[],
  at: Date,
  outcomes: NotificationOutcome[],
): Promise<void> {
  if (items.length === 0) return;
  const rows = items.map((item, ord) => ({
    id: randomUUID(),
    user_id: item.input.userId,
    type: item.input.type,
    category: item.definition.category,
    params: item.params,
    target: item.target,
    occurred_at: (item.input.occurredAt ?? at).toISOString(),
    event_key: item.input.eventKey,
    ord,
  }));
  const { rows: claimed } = await tx.execute<{ notification_id: string }>(sql`
    WITH input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(
        id uuid, user_id text, type text, category text, params jsonb, target jsonb,
        occurred_at timestamptz, event_key text, ord int)
    ), made AS (
      INSERT INTO ${notifications}
        (id, user_id, type, category, params, target, occurred_at, created_at)
      SELECT id, user_id, type, category, params, target, occurred_at,
        ${at.toISOString()}::timestamptz
      FROM input ORDER BY ord
      RETURNING id
    )
    INSERT INTO ${notificationKeys} (user_id, type, event_key, notification_id)
    SELECT i.user_id, i.type, i.event_key, i.id FROM input i JOIN made m ON m.id = i.id
    ORDER BY i.ord
    ON CONFLICT (user_id, type, event_key) DO NOTHING
    RETURNING notification_id`);
  const kept = new Set(claimed.map((row) => row.notification_id));
  const dropped = rows.filter((row) => !kept.has(row.id)).map((row) => row.id);
  // A DELETE in the same WITH could not see its sibling's inserts: a second statement, if any.
  if (dropped.length > 0) {
    await tx
      .delete(notifications)
      .where(sql`${notifications.id} = ANY(${sql.param(dropped)}::uuid[])`);
  }
  items.forEach((item, ord) => {
    const { id } = rows[ord]!;
    const { userId } = item.input;
    outcomes[item.index] = kept.has(id)
      ? { kind: 'created', id, userId }
      : { kind: 'duplicate', userId };
  });
}

/**
 * The held params folded with the event's by the type's `merge`, or null when they cannot be: the
 * stored params no longer fit the type's current schema, the merge throws on them, or its result
 * does not fit. Stored data never fails the producer's event (the module doc's compatibility rule).
 */
function foldParams(checked: CheckedInput, stored: unknown): NotificationParamValues | null {
  const { definition } = checked;
  const held = definition.params.safeParse(stored);
  if (!held.success) return null;
  let folded: unknown;
  try {
    folded = definition.merge!(held.data, checked.params);
  } catch {
    return null;
  }
  const merged = definition.params.safeParse(folded);
  if (!merged.success || !notificationParamsSchema.safeParse(merged.data).success) return null;
  return merged.data;
}

/**
 * A mergeable input (52-6, 52-7, 134-2): joins the member's unread notification of its type and
 * merge key, or makes it. A concurrent writer of the same merge key either holds the unread row
 * (this waits for it, FOR UPDATE, and merges after it) or inserts it first (this one's insert finds
 * the partial unique index taken and reads the row again). A concurrent read (a mark-read) leaves
 * no unread row: the next round inserts a new one. Held params it cannot fold are replaced by the
 * event's (`paramsReset`), the count and the 발생 시각 moving as in any merge.
 */
async function mergeOne(tx: Tx, checked: CheckedInput, at: Date): Promise<NotificationOutcome> {
  const { userId, type } = checked.input;
  const mergeKey = checked.mergeKey!;
  const occurredAt = checked.input.occurredAt ?? at;
  for (let round = 0; round < MERGE_ROUNDS; round++) {
    const [held] = await tx
      .select({ id: notifications.id, params: notifications.params })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.type, type),
          eq(notifications.mergeKey, mergeKey),
          isNull(notifications.readAt),
        ),
      )
      .for('update');
    if (held !== undefined) {
      if (!(await claimKey(tx, checked, held.id))) return { kind: 'duplicate', userId };
      const merged = foldParams(checked, held.params);
      await tx
        .update(notifications)
        .set({
          params: { ...(merged ?? checked.params) },
          eventCount: sql`${notifications.eventCount} + 1`,
          occurredAt: sql`GREATEST(${notifications.occurredAt}, ${occurredAt.toISOString()}::timestamptz)`,
        })
        .where(eq(notifications.id, held.id));
      return { kind: 'merged', id: held.id, userId, paramsReset: merged === null };
    }
    const [row] = await tx
      .insert(notifications)
      .values(rowOf(checked, occurredAt, at))
      .onConflictDoNothing({
        target: [notifications.userId, notifications.type, notifications.mergeKey],
        where: sql`read_at IS NULL AND merge_key IS NOT NULL`,
      })
      .returning({ id: notifications.id });
    // A concurrent writer's unread row just committed: read it again.
    if (row === undefined) continue;
    if (!(await claimKey(tx, checked, row.id))) {
      await tx.delete(notifications).where(eq(notifications.id, row.id));
      return { kind: 'duplicate', userId };
    }
    return { kind: 'created', id: row.id, userId };
  }
  // Never the account: a failure here reaches job results and logs (NotificationWriteError).
  throw new Error(`notification ${type}: no merge after ${String(MERGE_ROUNDS)} rounds`);
}

/**
 * Delivers one event's notifications (#53, ADR-0157; the rules in the module doc above): one call
 * per transaction, after the event's other writes, with every recipient. Answers what became of
 * each input, in the inputs' order. Throws — and so rolls the event back — on an input its
 * definition refuses (NotificationInputError, before anything is written) or a failed statement
 * (NotificationWriteError: its SQLSTATE kept, no recipient in it); never on held params a merge
 * cannot fold (`merged` with `paramsReset`).
 */
export async function createNotifications(
  tx: Tx,
  inputs: readonly NotificationInput[],
  options: CreateNotificationsOptions = {},
): Promise<NotificationOutcome[]> {
  const definitions = options.definitions ?? NOTIFICATION_DEFINITIONS;
  const byType = new Map(definitions.map((definition) => [definition.type, definition]));
  // 1. Every input checked before anything is written: a producer bug rolls the event back.
  const checked = inputs.map((input, index) => check(input, index, byType)).sort(compareChecked);
  const outcomes = new Array<NotificationOutcome>(inputs.length);
  if (checked.length === 0) return outcomes;
  const userIds = [...new Set(checked.map((c) => c.input.userId))].sort();
  try {
    await deliver(tx, checked, userIds, outcomes);
  } catch (error) {
    // What the callers keep must never name the recipients (NotificationWriteError).
    throw writeFailure(error, userIds);
  }
  return outcomes;
}

/**
 * Steps 2–4 of `createNotifications`: every statement it runs, for its `userIds` (sorted). The
 * gate (step 2) is where a recipient is dropped: no inbox (53-5), or the input's category off
 * (#56, 52-22) — per input, after which only the inputs it reached are written.
 */
async function deliver(
  tx: Tx,
  checked: readonly CheckedInput[],
  userIds: readonly string[],
  outcomes: NotificationOutcome[],
): Promise<void> {
  // 2. The gate (53-5): the inboxes not taken by a closure, in one statement that never waits,
  // with each one's 수신 설정 (#56) — one more column, no statement or lock added.
  const rows = await tx
    .select({
      userId: notificationInboxes.userId,
      categoriesOff: notificationInboxes.categoriesOff,
    })
    .from(notificationInboxes)
    // One array parameter, however many recipients (a market's close may notify thousands).
    .where(sql`${notificationInboxes.userId} = ANY(${sql.param(userIds)}::text[])`)
    .orderBy(asc(notificationInboxes.userId))
    .for('key share', { skipLocked: true });
  const off = new Map(rows.map((row) => [row.userId, new Set<string>(row.categoriesOff)]));
  // 3. One instant: the default 발생 시각 and the creation of every row this call makes.
  const at = await clockTimestamp(tx);
  for (const item of checked) {
    const { userId } = item.input;
    const muted = off.get(userId);
    if (muted === undefined) outcomes[item.index] = { kind: 'skipped', userId, reason: 'no_inbox' };
    else if (muted.has(item.definition.category)) {
      // 52-22: nothing of an off category is made or merged; no key is claimed for it.
      outcomes[item.index] = { kind: 'skipped', userId, reason: 'category_off' };
    }
  }
  // After the skips: an input skipped for either reason never reaches an insert or a merge.
  const reached = checked.filter((item) => outcomes[item.index] === undefined);
  // 4. Every input that does not merge, in one statement (#54, ADR-0159); then the merges.
  await createMany(
    tx,
    reached.filter((item) => item.mergeKey === null),
    at,
    outcomes,
  );
  for (const item of reached) {
    if (item.mergeKey !== null) outcomes[item.index] = await mergeOne(tx, item, at);
  }
}

/** The accounts something reached (created or merged): publish `user:notification` to them. */
export function notifiedUserIds(outcomes: readonly NotificationOutcome[]): string[] {
  return [
    ...new Set(
      outcomes
        .filter((outcome) => outcome.kind === 'created' || outcome.kind === 'merged')
        .map((outcome) => outcome.userId),
    ),
  ];
}

/**
 * 수신 설정 (#56, ADR-0162; 52-21, 56-2): the categories the member turned off — empty when all
 * are on (the default) — or null when the account has no inbox (closed, the 운영 마켓메이커, none).
 * One statement, no lock.
 */
export async function notificationCategoriesOff(
  executor: Executor,
  userId: string,
): Promise<string[] | null> {
  const [row] = await executor
    .select({ categoriesOff: notificationInboxes.categoriesOff })
    .from(notificationInboxes)
    .where(eq(notificationInboxes.userId, userId));
  return row?.categoriesOff ?? null;
}

/**
 * Turns one of the member's categories on or off (#56, ADR-0162; 52-21, 52-22): the off-list after
 * it (sorted and distinct, so the stored value is canonical), or null when the account has no inbox
 * — including a closure that took it first (this waits for it, then updates nothing). Idempotent.
 *
 * ONE plain UPDATE (FOR NO KEY UPDATE), never a `SELECT … FOR UPDATE` of the inbox: the producers'
 * gate (FOR KEY SHARE SKIP LOCKED) neither waits for it nor skips the member, and would skip the
 * member as `no_inbox` behind a FOR UPDATE (the module doc). The new list is computed from the row
 * inside the statement, never read here and written back: of two writes at once the second waits
 * for the first's row lock and recomputes on its committed value (READ COMMITTED), so two tabs
 * switching two categories both stand. Nothing else changes: existing notifications stay (56-1).
 */
export async function setNotificationCategory(
  executor: Executor,
  userId: string,
  category: NotificationCategory,
  enabled: boolean,
): Promise<string[] | null> {
  const column = notificationInboxes.categoriesOff;
  const [row] = await executor
    .update(notificationInboxes)
    .set({
      categoriesOff: enabled
        ? sql`array_remove(${column}, ${category}::text)`
        : // Not `ORDER BY x COLLATE "C"`: with DISTINCT, PostgreSQL wants it in the select list.
          sql`ARRAY(SELECT DISTINCT x FROM unnest(array_append(${column}, ${category}::text)) AS x ORDER BY x)`,
    })
    .where(eq(notificationInboxes.userId, userId))
    .returning({ categoriesOff: notificationInboxes.categoriesOff });
  return row?.categoriesOff ?? null;
}

/** A keyset position of the member's list: a notification's 발생 시각 and id. */
export interface NotificationCursor {
  readonly at: Date;
  readonly id: string;
}

export interface NotificationPage {
  readonly items: NotificationRow[];
  /** Where the next page starts; null on the last one. */
  readonly next: NotificationCursor | null;
}

/**
 * `GET /me/notifications` (53-3): the member's notifications newest first — by 발생 시각, so a
 * merged one moves to the top — after `after` (the previous page's `next`), `limit` of them.
 */
export async function notificationPage(
  executor: Executor,
  userId: string,
  { after, limit }: { after: NotificationCursor | null; limit: number },
): Promise<NotificationPage> {
  const rows = await executor
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        after
          ? sql`(${notifications.occurredAt}, ${notifications.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(notifications.occurredAt), desc(notifications.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next: rows.length > limit && last ? { at: last.occurredAt, id: last.id } : null,
  };
}

/**
 * The member's unread notifications, counted up to NOTIFICATION_UNREAD_COUNT_CAP (the cap means
 * "the cap or more", 53-11 ①): a bounded read of the unread index whatever the inbox holds.
 */
export async function unreadNotificationCount(executor: Executor, userId: string): Promise<number> {
  const { rows } = await executor.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM (
      SELECT 1 FROM ${notifications}
      WHERE ${notifications.userId} = ${userId} AND ${notifications.readAt} IS NULL
      LIMIT ${NOTIFICATION_UNREAD_COUNT_CAP}
    ) unread`);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Marks one of the member's notifications read (53-2: opening it). Null when no notification of
 * that id is the member's — another account's answers as a missing one. Otherwise the row as it now
 * stands and whether this call read it: one already read keeps its first `read_at` (`changed`
 * false). A merge in flight on the row is waited for (its FOR UPDATE): read after it, the member
 * has read the merged row.
 */
export async function markNotificationRead(
  tx: Executor,
  userId: string,
  id: string,
): Promise<{ row: NotificationRow; changed: boolean } | null> {
  const now = await clockTimestamp(tx);
  const [updated] = await tx
    .update(notifications)
    .set({ readAt: now })
    .where(
      and(eq(notifications.id, id), eq(notifications.userId, userId), isNull(notifications.readAt)),
    )
    .returning();
  if (updated) return { row: updated, changed: true };
  const [row] = await tx
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
  return row ? { row, changed: false } : null;
}

/**
 * '모두 읽음' (53-2): every notification of the member unread when the statement runs is marked read
 * at one instant. How many it read; 0 when none was unread.
 *
 * The rows are locked in the order a producer's merges lock them — (type, merge key), byte order
 * as JavaScript compares the keys — so a producer merging two of the member's notifications in one
 * call and this statement wait for each other instead of deadlocking. A merge in flight is waited
 * for and its row then read; a row a merge has not reached yet is read first, and the merge then
 * makes a new notification (52-6: a read one is never a merge target).
 */
export async function markAllNotificationsRead(
  tx: Executor,
  userId: string,
): Promise<{ changed: number }> {
  const now = await clockTimestamp(tx);
  const { rows } = await tx.execute<{ count: number }>(sql`
    WITH unread AS MATERIALIZED (
      SELECT ${notifications.id} FROM ${notifications}
      WHERE ${notifications.userId} = ${userId} AND ${notifications.readAt} IS NULL
      ORDER BY ${notifications.type} COLLATE "C", ${notifications.mergeKey} COLLATE "C",
        ${notifications.id}
      FOR UPDATE
    ), marked AS (
      UPDATE ${notifications} SET read_at = ${now.toISOString()}::timestamptz
      FROM unread
      WHERE ${notifications.id} = unread.id AND ${notifications.readAt} IS NULL
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM marked`);
  return { changed: Number(rows[0]?.count ?? 0) };
}
