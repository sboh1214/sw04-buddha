import {
  MARKET_EVENT_WORK,
  MARKET_WORK_OPENED_ADMIN_SOURCES,
  MARKET_WORK_SOURCES,
  MARKET_WORK_STEP_TYPE,
  adminMarketWorkQuerySchema,
  decodeTupleCursor,
  encodeTupleCursor,
  isMarketEventType,
  marketWorkActionTypesOf,
  marketWorkDetailsOf,
  marketWorkEventTypesOf,
  marketWorkKindOf,
  marketWorkReasonOf,
  type AdminCategoryRef,
  type AdminMarketWorkEntry,
  type AdminMarketWorkPage,
  type AdminMarketWorkQuery,
  type MarketWorkActionType,
  type MarketWorkEntryType,
  type MarketWorkSource,
  type SettlementStepStatus,
} from '@buddha/shared';
import { inArray, sql, type SQL } from 'drizzle-orm';
import * as z from 'zod';
import type { Db } from './client.js';
import {
  adminActions,
  categories,
  fills,
  marketEvents,
  markets,
  marketSettlementSteps,
  profiles,
  reconciliationHolds,
} from './schema/index.js';

/*
 * 시장별 작업 이력 (#145 part 2, ADR-0164; 145-5, 145-6, 145-7, 145-12, 145-13, 145-16): one market's
 * operator work and the worker's processing, oldest first, in one UNION ALL statement (and one
 * lookup of the categories its changes name) in its own REPEATABLE READ, READ ONLY transaction (a GET writes nothing, AC 3). One source per fact — the
 * services write most status changes twice, an event and an admin action in one transaction — so:
 *
 * - (A) the market's own admin actions: `target_type = 'market' AND target_id = $id`
 *   (`admin_actions_market_target_idx`), the shown types only — bot controls are not (145-5);
 * - (B) the other end of a 관련 시장 link: `market_link`/`market_unlink` naming it in
 *   `payload.relatedMarketId` (the link is one row for the pair, ADR-0068);
 * - (C) its manual 대사 실행: `reconciliation_run` on `target_id = 'market:' || $id`;
 * - (D) its 대사 보류 복구: `reconciliation_recovery_*` on a hold (`target_type =
 *   'reconciliation_hold'`) whose `market_id` is it — driven from the type index and joined to
 *   the hold by its primary key, since `reconciliation_holds.market_id` has no index;
 * - (E) 비정상 체결 분류 of its fills: `fill_classification_*` on a fill (`target_id` its bigserial
 *   id as text) of the market, joined to `fills` by its primary key;
 * - (F) the linked 시장 제안: `proposal_adopt`/`proposal_link` whose `payload.marketId` is it;
 * - (G) its market events with no actor (145-6 '시스템'), and `opened` with an admin actor whose
 *   `source` is `approval`/`reschedule` (no admin action of its own; MARKET_EVENT_WORK);
 * - (H) the settlement step's failure record: a step whose `last_error` is set, at its last update
 *   (145-6 "시도 횟수와 마지막 오류"; ADR-0118 결정 8 — kept after a success as the past trail).
 *
 * A `categoryId` change names its categories by their current name, `{id, nameKo}` (one lookup of
 * the page's ids in the same transaction), as the category records do.
 *
 * 145-13 leaves out themes, bots and post/comment moderation: their types are in
 * MARKET_WORK_EXCLUDED_ACTIONS and no branch reads them. Every branch is keyed on the market (or
 * its holds, fills, the link or proposal naming it), so no other market's record can enter (AC 6);
 * an unknown market answers an empty page. B, D, E and F walk
 * `admin_actions_type_created_at_id_idx` over a few operator-paced types.
 *
 * Order: `at`, then `sourceOrder` (MARKET_WORK_SOURCES: an event before the admin action of its
 * transaction, which shares its `created_at`), then a text key — the event id zero-padded to 20
 * digits, the action uuid, the step name — compared under `COLLATE "C"`. The cursor is
 * `<at millis>_<sourceOrder>_<key>` and every branch carries its predicate before its own
 * `ORDER BY … LIMIT`, so a later page never re-reads a branch from its start. The step record's
 * `at` moves with each attempt (a cursor taken before one may show it twice or skip it — the
 * entry is a summary, read rarely; ADR-0164 구현의 선택).
 */

type Transactional = Pick<Db, 'transaction'>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const READ_ONLY = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

/**
 * How each shown admin action type is bound to a market (145-13): by its target (`market`), by
 * its target and, for the other end, its payload (`link`), or through a reconciliation target
 * key, a hold, a fill or a proposal. A new shown type does not compile until it is placed here.
 */
type ActionBinding =
  'market' | 'link' | 'reconciliation_run' | 'reconciliation_hold' | 'fill' | 'market_proposal';

const ACTION_BINDING: Readonly<Record<MarketWorkActionType, ActionBinding>> = {
  market_create: 'market',
  market_update: 'market',
  market_supplement_request: 'market',
  market_supplement_approve: 'market',
  market_supplement_reject: 'market',
  market_supplement_retract: 'market',
  market_price_protection_change: 'market',
  market_pause: 'market',
  market_pause_decision_request: 'market',
  market_pause_decision_approve: 'market',
  market_pause_decision_reject: 'market',
  market_pause_decision_retract: 'market',
  market_judgement_request: 'market',
  market_judgement_approve: 'market',
  market_judgement_reject: 'market',
  market_judgement_retract: 'market',
  market_dispute_dismiss: 'market',
  market_dispute_accept: 'market',
  market_delay_record: 'market',
  market_conflict_declare: 'market',
  market_resolve: 'market',
  market_judgement_incident_register: 'market',
  market_judgement_incident_confirm: 'market',
  market_judgement_incident_dismiss: 'market',
  market_judgement_incident_retract: 'market',
  market_settlement_retry: 'market',
  market_judgement_compensation_request: 'market',
  market_judgement_compensation_approve: 'market',
  market_judgement_compensation_reject: 'market',
  market_judgement_compensation_retract: 'market',
  reconciliation_recovery_request: 'reconciliation_hold',
  reconciliation_recovery_approve: 'reconciliation_hold',
  reconciliation_recovery_reject: 'reconciliation_hold',
  reconciliation_recovery_retract: 'reconciliation_hold',
  market_submit: 'market',
  market_approve: 'market',
  market_reject: 'market',
  market_revert: 'market',
  market_reschedule: 'market',
  market_cancel_request: 'market',
  market_cancel_approve: 'market',
  market_cancel_reject: 'market',
  market_cancel_retract: 'market',
  market_link: 'link',
  market_unlink: 'link',
  reconciliation_run: 'reconciliation_run',
  fill_classification_request: 'fill',
  fill_classification_approve: 'fill',
  fill_classification_reject: 'fill',
  fill_classification_retract: 'fill',
  proposal_adopt: 'market_proposal',
  proposal_link: 'market_proposal',
  market_open: 'market',
  market_close: 'market',
};

interface WorkRow {
  source_order: number;
  sort_key: string;
  at_ms: string;
  type: string;
  actor_id: string | null;
  actor_nickname: string | null;
  payload: unknown;
  related_id: string | null;
  related_title: string | null;
  step_status: SettlementStepStatus | null;
  step_attempts: number | null;
  step_last_error: string | null;
  step_completed_ms: string | null;
}

const sourceOrderOf = (source: MarketWorkSource): number => MARKET_WORK_SOURCES.indexOf(source);

/** An instant as epoch millis text, so a raw row reads it without the driver's parsers. */
const millisOf = (column: SQL): SQL => sql`(extract(epoch FROM ${column}) * 1000)::bigint::text`;

const instant = (millis: string | null): string | null =>
  millis === null ? null : new Date(Number(millis)).toISOString();

/** A text id as a uuid, or NULL when it is not one (never a cast error). */
const uuidOrNull = (text: SQL): SQL =>
  sql`CASE WHEN ${text} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (${text})::uuid END`;

const listOf = (values: readonly string[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

const COLLATE_C = sql.raw('COLLATE "C"');

/**
 * `GET /admin/markets/:id/work-history`: the market's history, oldest first (145-5 "시각 순"),
 * every kind or one. An id that is no uuid or no market answers an empty page.
 */
export async function readMarketWorkHistory(
  db: Transactional,
  marketId: string,
  input: Partial<AdminMarketWorkQuery> = {},
): Promise<AdminMarketWorkPage> {
  const query = adminMarketWorkQuerySchema.parse(input);
  if (!z.uuid().safeParse(marketId).success) return { data: [], meta: { nextCursor: null } };
  const cursor = decodeTupleCursor(query.cursor, ['millis', 'int'], 'text');
  const limit = query.limit + 1;
  const id = sql`${marketId}::text`;
  const marketUuid = sql`${marketId}::uuid`;

  const actionTypes = marketWorkActionTypesOf(query.kind);
  const typesBound = (...bindings: ActionBinding[]) =>
    actionTypes.filter((type) => bindings.includes(ACTION_BINDING[type]));
  const eventTypes = marketWorkEventTypesOf(query.kind);
  const alwaysEvents = eventTypes.filter((type) => MARKET_EVENT_WORK[type].shown === 'always');
  const withStep = query.kind === undefined || query.kind === 'settlement';

  /** `(at, sourceOrder, key) > cursor` for one branch, or nothing on the first page. */
  const after = (at: SQL, source: MarketWorkSource, key: SQL): SQL =>
    cursor
      ? sql`AND (${at}, ${sql.raw(String(sourceOrderOf(source)))}::bigint, ${key})
          > (${new Date(Number(cursor.values[0])).toISOString()}::timestamptz,
             ${cursor.values[1]}::bigint, ${cursor.id}::text ${COLLATE_C})`
      : sql``;
  const order = sql`ORDER BY at, sort_key LIMIT ${limit}`;
  const noStep = sql`NULL::text AS step_status, NULL::int AS step_attempts,
      NULL::text AS step_last_error, NULL::text AS step_completed_ms`;

  const actionKey = sql`a.id::text ${COLLATE_C}`;
  const actionBranch = (types: readonly string[], relatedId: SQL, from: SQL, where: SQL): SQL =>
    sql`(SELECT ${sql.raw(String(sourceOrderOf('admin_action')))} AS source_order,
          ${actionKey} AS sort_key, a.created_at AS at, a.type::text AS type,
          a.admin_id AS actor_id, a.payload AS payload, ${relatedId} AS related_id, ${noStep}
        FROM ${from}
        WHERE a.type IN (${listOf(types)}) AND ${where}
          ${after(sql`a.created_at`, 'admin_action', actionKey)}
        ${order})`;
  const actions = sql`${adminActions} a`;

  const branches: SQL[] = [];
  const own = typesBound('market', 'link');
  if (own.length > 0) {
    // (A) the market's own rows; a link row names its other end in the payload.
    branches.push(
      actionBranch(
        own,
        sql`CASE WHEN a.type IN ('market_link', 'market_unlink')
          THEN a.payload->>'relatedMarketId' END`,
        actions,
        sql`a.target_type = 'market' AND a.target_id = ${id}`,
      ),
    );
  }
  const links = typesBound('link');
  if (links.length > 0) {
    // (B) a link made from the other market: the other end is the row's target.
    branches.push(
      actionBranch(
        links,
        sql`a.target_id`,
        actions,
        sql`a.target_type = 'market' AND a.payload->>'relatedMarketId' = ${id}`,
      ),
    );
  }
  const runs = typesBound('reconciliation_run');
  if (runs.length > 0) {
    // (C) a manual reconciliation run of the market (its target key, reconciliation-audit.ts).
    branches.push(
      actionBranch(
        runs,
        sql`NULL::text`,
        actions,
        sql`a.target_type = 'market' AND a.target_id = 'market:' || ${id}`,
      ),
    );
  }
  const recoveries = typesBound('reconciliation_hold');
  if (recoveries.length > 0) {
    // (D) a recovery of one of the market's holds.
    branches.push(
      actionBranch(
        recoveries,
        sql`NULL::text`,
        sql`${actions} JOIN ${reconciliationHolds} h ON h.id = ${uuidOrNull(sql`a.target_id`)}`,
        sql`a.target_type = 'reconciliation_hold' AND h.market_id = ${marketUuid}`,
      ),
    );
  }
  const classifications = typesBound('fill');
  if (classifications.length > 0) {
    // (E) a classification of one of the market's fills (the id guarded before the cast).
    branches.push(
      actionBranch(
        classifications,
        sql`NULL::text`,
        sql`${actions} JOIN ${fills} f ON f.id = CASE WHEN a.target_id ~ '^[0-9]{1,18}$'
          THEN a.target_id::bigint END`,
        sql`a.target_type = 'fill' AND f.market_id = ${marketUuid}`,
      ),
    );
  }
  const proposals = typesBound('market_proposal');
  if (proposals.length > 0) {
    // (F) a proposal adopted with, or linked later to, the market.
    branches.push(
      actionBranch(
        proposals,
        sql`NULL::text`,
        actions,
        sql`a.target_type = 'market_proposal' AND a.payload->>'marketId' = ${id}`,
      ),
    );
  }
  if (eventTypes.length > 0) {
    // (G) the worker's processing, and an `opened` an approval or a reschedule wrote at once.
    const eventKey = sql`lpad(e.id::text, 20, '0') ${COLLATE_C}`;
    const adminOpened =
      alwaysEvents.length > 0
        ? sql`OR (e.type IN (${listOf(alwaysEvents)})
            AND e.payload->>'source' IN (${listOf(MARKET_WORK_OPENED_ADMIN_SOURCES)}))`
        : sql``;
    branches.push(sql`(SELECT ${sql.raw(String(sourceOrderOf('market_event')))} AS source_order,
          ${eventKey} AS sort_key, e.created_at AS at, e.type::text AS type,
          e.actor_id AS actor_id, e.payload AS payload, NULL::text AS related_id, ${noStep}
        FROM ${marketEvents} e
        WHERE e.market_id = ${marketUuid} AND e.type IN (${listOf(eventTypes)})
          AND (e.actor_id IS NULL ${adminOpened})
          ${after(sql`e.created_at`, 'market_event', eventKey)}
        ${order})`);
  }
  if (withStep) {
    // (H) the settlement step's failure record (145-6).
    const stepKey = sql`s.step::text ${COLLATE_C}`;
    branches.push(sql`(SELECT ${sql.raw(String(sourceOrderOf('settlement_step')))} AS source_order,
          ${stepKey} AS sort_key, s.updated_at AS at, ${MARKET_WORK_STEP_TYPE}::text AS type,
          NULL::text AS actor_id, NULL::jsonb AS payload, NULL::text AS related_id,
          s.status::text AS step_status, s.attempts AS step_attempts,
          s.last_error AS step_last_error, ${millisOf(sql`s.completed_at`)} AS step_completed_ms
        FROM ${marketSettlementSteps} s
        WHERE s.market_id = ${marketUuid} AND s.last_error IS NOT NULL
          ${after(sql`s.updated_at`, 'settlement_step', stepKey)}
        ${order})`);
  }

  const statement = sql`
    SELECT u.source_order, u.sort_key, ${millisOf(sql`u.at`)} AS at_ms, u.type, u.actor_id,
        p.nickname AS actor_nickname, u.payload, u.related_id, rm.title AS related_title,
        u.step_status, u.step_attempts, u.step_last_error, u.step_completed_ms
      FROM (${sql.join(branches, sql` UNION ALL `)}) u
      LEFT JOIN ${profiles} p ON p.user_id = u.actor_id
      LEFT JOIN ${markets} rm ON rm.id = ${uuidOrNull(sql`u.related_id`)}
      ORDER BY u.at, u.source_order, u.sort_key ${COLLATE_C}
      LIMIT ${limit}`;
  const { rows, entries } = await db.transaction(async (tx: Tx) => {
    const read = ((await tx.execute(statement)) as unknown as { rows: WorkRow[] }).rows;
    return {
      rows: read,
      entries: await withCategoryNames(tx, read.slice(0, query.limit).map(entryOf)),
    };
  }, READ_ONLY);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: entries,
    meta: {
      nextCursor:
        rows.length > query.limit && last
          ? encodeTupleCursor([last.at_ms, String(last.source_order)], last.sort_key)
          : null,
    },
  };
}

/** A snapshot's stored category id (a serial), or null for none or anything else. */
const categoryIdOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

/**
 * A page's `categoryId` changes with their ids as categories by their CURRENT name (145-16
 * '항목: 이전 → 새' — no screen shows a category's id): one lookup of every id the page names, in
 * the page's transaction, as the category records' (`category-changes.ts`). A category is never
 * deleted; an id the table no longer holds keeps `nameKo: null`.
 */
async function withCategoryNames(
  tx: Tx,
  entries: AdminMarketWorkEntry[],
): Promise<AdminMarketWorkEntry[]> {
  const ids = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.changes
          .filter((change) => change.field === 'categoryId')
          .flatMap((change) => [categoryIdOf(change.before), categoryIdOf(change.after)])
          .filter((id): id is number => id !== null),
      ),
    ),
  ];
  if (ids.length === 0) return entries;
  const names = new Map(
    (
      await tx
        .select({ id: categories.id, nameKo: categories.nameKo })
        .from(categories)
        .where(inArray(categories.id, ids))
    ).map((row) => [row.id, row.nameKo]),
  );
  const ref = (value: unknown): AdminCategoryRef | null => {
    const id = categoryIdOf(value);
    return id === null ? null : { id, nameKo: names.get(id) ?? null };
  };
  return entries.map((entry) =>
    entry.changes.some((change) => change.field === 'categoryId')
      ? {
          ...entry,
          changes: entry.changes.map((change) =>
            change.field === 'categoryId'
              ? { ...change, before: ref(change.before), after: ref(change.after) }
              : change,
          ),
        }
      : entry,
  );
}

function entryOf(row: WorkRow): AdminMarketWorkEntry {
  const source = MARKET_WORK_SOURCES[row.source_order]!;
  const type = row.type as MarketWorkEntryType;
  const at = instant(row.at_ms)!;
  const actor = row.actor_id === null ? null : { id: row.actor_id, nickname: row.actor_nickname };
  const base = {
    kind: marketWorkKindOf(type),
    at,
    actor,
    ...marketWorkReasonOf(type, row.payload),
  };
  if (source === 'settlement_step') {
    return {
      ...base,
      id: `s:${row.sort_key}`,
      source,
      type,
      details: { step: row.sort_key },
      changes: [],
      relatedMarket: null,
      settlement: {
        stepStatus: row.step_status!,
        settlementAttempts: row.step_attempts ?? 0,
        settlementLastError: row.step_last_error!,
        completedAt: instant(row.step_completed_ms),
      },
      retryOutcome: null,
    };
  }
  const { details, changes } = marketWorkDetailsOf(row.payload);
  const outcome = details.outcome;
  return {
    ...base,
    id: source === 'market_event' ? `e:${String(Number(row.sort_key))}` : `a:${row.sort_key}`,
    source,
    type,
    details,
    // Event payloads carry no market snapshot worth comparing; only actions list changes.
    changes: isMarketEventType(type) ? [] : changes,
    relatedMarket:
      row.related_id !== null && row.related_title !== null
        ? { id: row.related_id, title: row.related_title }
        : null,
    settlement: null,
    retryOutcome:
      type === 'market_settlement_retry' && (outcome === 'settled' || outcome === 'failed')
        ? outcome
        : null,
  };
}
