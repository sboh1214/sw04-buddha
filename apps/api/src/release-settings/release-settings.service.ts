import { Inject, Injectable } from '@nestjs/common';
import {
  getReleaseSetting,
  lockAdminRoles,
  schema,
  storedReleaseSettingValue,
  type Db,
} from '@buddha/db';
import {
  classifyReleaseSettingChange,
  decodeKeyset,
  encodeKeyset,
  isReleaseSettingUnchanged,
  parseReleaseSettingChange,
  RELEASE_SETTING_CHANGE_APPROVAL_KIND,
  RELEASE_SETTING_STAGE_SLOTS,
  RELEASE_SETTING_UNCHANGED_MESSAGE,
  releaseSettingChangePayloadSchema,
  releaseSettingChangeRequestPayloadSchema,
  releaseSettingValueJsonSchema,
  type ApprovalStatus,
  type ReleaseSetting,
  type ReleaseSettingChange,
  type ReleaseSettingChangeBasis,
  type ReleaseSettingChangeBody,
  type ReleaseSettingChangePayload,
  type ReleaseSettingChangeRequest,
  type ReleaseSettingChangeRequestPayload,
  type ReleaseSettingChangeRequestWrite,
  type ReleaseSettingChangeResult,
  type ReleaseSettingDefinition,
  type ReleaseSettingNotAllowedDetails,
  type ReleaseSettingReading,
  type ReleaseSettingsRegistry,
  type ReleaseSettingStageSlot,
  type ReleaseSettingState,
  type ReleaseSettingStatus,
  type ReleaseSettingValue,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  ApprovalService,
  approvalNotAllowed,
  type ApprovalRequest,
} from '../approvals/approval.service.js';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { type Page } from '../wallet/wallet.service.js';
import { RELEASE_SETTINGS_REGISTRY } from './release-settings.registry.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Db | Tx;

/** admin_actions.target_type of a release setting's records, and approval_requests' too. */
const TARGET_TYPE = 'release_setting';

const { approvalRequests: requests } = schema;
const requester = alias(schema.profiles, 'release_setting_requester');
const decider = alias(schema.profiles, 'release_setting_decider');

const settingColumns = {
  key: schema.releaseSettings.key,
  status: schema.releaseSettings.status,
  // Not the bare column: drizzle would parse a JSON-looking string value a second time.
  value: storedReleaseSettingValue,
  updatedAt: schema.releaseSettings.updatedAt,
  updatedBy: schema.releaseSettings.updatedBy,
  nickname: schema.profiles.nickname,
};

interface SettingRow {
  key: string;
  status: ReleaseSettingStatus;
  value: unknown;
  updatedAt: Date;
  updatedBy: string;
  nickname: string | null;
}

/** A row as a change reads it under its key's lock. */
interface StoredState extends ReleaseSettingState {
  updatedAt: Date;
}

/** What a change record's payload adds to `{key, before, after}` beyond the state. */
type RecordExtra = Omit<ReleaseSettingChangePayload, 'key' | 'before' | 'after'>;

const ownKind = () =>
  and(
    eq(requests.kind, RELEASE_SETTING_CHANGE_APPROVAL_KIND),
    eq(requests.targetType, TARGET_TYPE),
  );

/** A stored state as the API answers it: no row reads as undecided with no value. */
function stateOf(row: ReleaseSettingState | undefined): ReleaseSettingState {
  return { status: row?.status ?? 'undecided', value: row?.value ?? null };
}

export function releaseSettingNotAllowed(
  reason: ReleaseSettingNotAllowedDetails['reason'],
): AppError {
  const messages = {
    request_pending: 'A change request of this release setting waits for its decision already',
    stale: 'The release setting changed since the request; reject or retract it',
    requester_ineligible: 'The requester is no longer an admin; reject the request',
  } as const satisfies Record<ReleaseSettingNotAllowedDetails['reason'], string>;
  return new AppError('RELEASE_SETTING_NOT_ALLOWED', {
    message: messages[reason],
    details: { reason },
  });
}

/**
 * Release settings (#170): the registry (what each item is) merged with `release_settings` (its
 * status and value); a registered key with no row is `undecided`. The only writer of that table —
 * every change appends its `release_setting_change` record in the same transaction, at an instant
 * later than the key's previous one, which migration 0020's constraint trigger also demands.
 *
 * Who changes an item is its approval rule's call (#331, ADR-0175; ADR-0171 결정 6, owner answers
 * 331-1…331-7): `classifyReleaseSettingChange` reads it against the row under the key's lock. A
 * one-admin change — a reduction or a stop in the item's direction, an observation value, closing
 * order intake, a status-only move away from 승인됨 — is written at once, whether or not another
 * admin exists (133-27 step 1). A two-admin one — anything else, and every change to 승인됨 — is a
 * `release_setting_change` approval request that another admin approves (written in the same
 * transaction, by the approver) or rejects, or its requester retracts: one waits per key, it is
 * refused when no other admin could decide it (`no_decider`), and its approval is refused when the
 * item changed since (`stale`) or its requester is no longer an open admin (`requester_ineligible`).
 * Every write re-reads the actor's role under the admin-roles lock first, then takes the key's
 * lock — the three risk stages' together, whose combination one change is judged by.
 */
@Injectable()
export class ReleaseSettingsService {
  /** The key of each risk stage slot (#129) in this registry, for their combination. */
  private readonly stageKeys: Partial<Record<ReleaseSettingStageSlot, string>>;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELEASE_SETTINGS_REGISTRY) private readonly registry: ReleaseSettingsRegistry,
    private readonly approvals: ApprovalService,
  ) {
    this.stageKeys = {};
    for (const definition of registry.values()) {
      const { approval } = definition;
      if ('stage' in approval && approval.stage !== undefined) {
        this.stageKeys[approval.stage] = definition.key;
      }
    }
  }

  /**
   * The reading server code uses: `undecided` with no value, or the value typed by the
   * definition's schema with its status — `test` and `proposal` included, in every environment:
   * the server only reports the status, and #149's launch check reviews every item that is not
   * approved (owner decision 2026-10-13~14; no deploy-tier switch). What an `undecided` item means
   * for the work is the registering issue's call. Only a definition registered in the registry is
   * read. A value applies to work started after it changed (owner decision 2026-10-13): read it
   * once when the work begins — inside that work's transaction (`executor`) when it has one —
   * and keep it for the work's whole life rather than reading it again later. The worker reads
   * through the same `getReleaseSetting` (@buddha/db) with RELEASE_SETTINGS; any failure is
   * INTERNAL here, with the reason as its cause.
   */
  async get<T extends ReleaseSettingValue>(
    definition: ReleaseSettingDefinition<T>,
    executor: Db | Tx = this.db,
  ): Promise<ReleaseSettingReading<T>> {
    try {
      return await getReleaseSetting(executor, this.registry, definition);
    } catch (error) {
      throw new AppError('INTERNAL', {
        message: `Release setting '${definition.key}' cannot be read`,
        cause: error,
      });
    }
  }

  /** Every registered item in registry order, or only those whose status is `status`. */
  async list(status?: ReleaseSettingStatus): Promise<ReleaseSetting[]> {
    const definitions = [...this.registry.values()];
    if (definitions.length === 0) return [];
    const keys = definitions.map((definition) => definition.key);
    const rows = await this.rows(this.db, keys);
    const pending = await this.pendingRequests(this.db, undefined, rows);
    return definitions
      .map((definition) =>
        this.toReleaseSetting(definition, rows.get(definition.key), pending.get(definition.key)),
      )
      .filter((item) => status === undefined || item.status === status);
  }

  /**
   * A change of one item: the status/value rule and the item's schema first (VALIDATION_ERROR
   * naming `value`), then, under the key's lock, its path (`classifyReleaseSettingChange`). A change
   * that keeps the status and value as they are is refused (VALIDATION_ERROR, path `[]`,
   * RELEASE_SETTING_UNCHANGED_MESSAGE; owner decision 2026-10-13~14), so a change another admin
   * made first counts. One admin's: the row and its `release_setting_change` record, with the state
   * before and after, the reason, the path and its basis, the admin and one instant (`applied`).
   * Two admins': a `release_setting_change` approval request and its `release_setting_change_request`
   * record, nothing else (`requested`) — refused when one waits for the key already
   * (`request_pending`) or no other admin could decide it (`no_decider`). Nothing is written when
   * any part fails.
   */
  async submit(
    adminId: string,
    key: string,
    body: WithoutExpectedAccount<ReleaseSettingChangeBody>,
  ): Promise<ReleaseSettingChangeResult> {
    const definition = this.definition(key);
    const parsed = parseReleaseSettingChange(definition, body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Request validation failed',
        details: parsed.issues,
      });
    }
    const after = parsed.state;

    const requestId = await this.db.transaction(async (tx) => {
      await this.currentAdmin(tx, adminId);
      const states = await this.lockAndRead(tx, definition);
      const current = states.get(key);
      const classification = classifyReleaseSettingChange(
        definition.approval,
        current,
        after,
        this.stages(definition, states),
      );
      if (classification.path === 'unchanged') {
        throw new AppError('VALIDATION_ERROR', {
          message: 'The status and value are already the current ones',
          details: [{ path: [], message: RELEASE_SETTING_UNCHANGED_MESSAGE }],
        });
      }
      const { basis } = classification;
      if (classification.path === 'one_admin') {
        await this.write(tx, adminId, key, current, after, {
          reason: body.reason,
          path: 'one_admin',
          basis,
        });
        return null;
      }
      if ((await this.pendingRow(tx, key)) !== undefined) {
        throw releaseSettingNotAllowed('request_pending');
      }
      if (!(await this.approvals.hasDecider([adminId], tx))) throw approvalNotAllowed('no_decider');
      const payload: ReleaseSettingChangeRequestPayload = {
        key,
        before: stateOf(current),
        after,
        reason: body.reason,
        basis,
      };
      const request = await this.approvals.request(
        {
          kind: RELEASE_SETTING_CHANGE_APPROVAL_KIND,
          targetType: TARGET_TYPE,
          targetId: key,
          requestedBy: adminId,
          reason: body.reason,
          payload,
        },
        tx,
      );
      await this.audit(tx, adminId, 'release_setting_change_request', key, request.requestedAt, {
        approvalId: request.id,
        ...payload,
      });
      return request.id;
    });

    const setting = await this.setting(this.db, definition);
    if (requestId === null) return { outcome: 'applied', setting, request: null };
    return { outcome: 'requested', setting, request: await this.requestById(this.db, requestId) };
  }

  /**
   * Another admin's approval of a two-admin change, which writes it in the same transaction: the
   * shared rule's refusals first (`requester`, `retracted`, `decided`), then `requester_ineligible`
   * and `stale`. Each refusal rolls the approval back, so the request still waits — to be rejected
   * or retracted. The row's writer (`updated_by`, the record's admin) is the approver; the record
   * keeps the request's reason and the approval (I-e).
   */
  async approve(
    adminId: string,
    id: string,
    reason: string,
  ): Promise<ReleaseSettingChangeRequestWrite> {
    const definition = await this.db.transaction(async (tx) => {
      await this.currentAdmin(tx, adminId);
      const { payload } = await this.ownRequest(tx, id);
      const definition = this.definition(payload.key);
      const states = await this.lockAndRead(tx, definition);
      const approved = await this.approvals.approve(adminId, id, reason, tx);
      if (!(await this.isOpenAdmin(tx, approved.requestedBy))) {
        throw releaseSettingNotAllowed('requester_ineligible');
      }
      const current = states.get(payload.key);
      if (this.isStale(definition, payload, states)) throw releaseSettingNotAllowed('stale');
      const parsed = parseReleaseSettingChange(definition, payload.after);
      if (!parsed.success) {
        throw new AppError('INTERNAL', { message: `Change request ${id} no longer fits its item` });
      }
      await this.write(tx, adminId, payload.key, current, parsed.state, {
        reason: payload.reason,
        path: 'two_admin',
        basis: payload.basis,
        approval: {
          id,
          requestedBy: approved.requestedBy,
          requestedAt: approved.requestedAt.toISOString(),
          decisionReason: approved.decisionReason!,
        },
      });
      return definition;
    });
    return this.requestWrite(id, definition);
  }

  /** Another admin's 반려: nothing changes; recorded as `release_setting_change_reject`. */
  async reject(
    adminId: string,
    id: string,
    reason: string,
  ): Promise<ReleaseSettingChangeRequestWrite> {
    const key = await this.db.transaction(async (tx) => {
      await this.currentAdmin(tx, adminId);
      const { payload } = await this.ownRequest(tx, id);
      const rejected = await this.approvals.reject(adminId, id, reason, tx);
      await this.audit(
        tx,
        adminId,
        'release_setting_change_reject',
        payload.key,
        rejected.decidedAt!,
        {
          approvalId: id,
          key: payload.key,
          reason: rejected.decisionReason,
        },
      );
      return payload.key;
    });
    return this.requestWrite(id, this.registry.get(key));
  }

  /** Its requester's retraction: nothing changes; recorded as `release_setting_change_retract`. */
  async retract(adminId: string, id: string): Promise<ReleaseSettingChangeRequestWrite> {
    const key = await this.db.transaction(async (tx) => {
      await this.currentAdmin(tx, adminId);
      const { payload } = await this.ownRequest(tx, id);
      const retracted = await this.approvals.retract(adminId, id, tx);
      await this.audit(
        tx,
        adminId,
        'release_setting_change_retract',
        payload.key,
        retracted.retractedAt!,
        { approvalId: id, key: payload.key },
      );
      return payload.key;
    });
    return this.requestWrite(id, this.registry.get(key));
  }

  /**
   * The change requests, newest first (keyset over approval_requests' `(requested_at, id)`), of
   * one status and one key when given. A waiting one is `stale` once its item no longer holds the
   * state it saw.
   */
  async listRequests(
    status: ApprovalStatus | undefined,
    key: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<ReleaseSettingChangeRequest>> {
    const keyset = decodeKeyset(cursor, 'uuid');
    const rows = await this.requestRows(
      this.db,
      and(
        status === undefined ? undefined : eq(requests.status, status),
        key === undefined ? undefined : eq(requests.targetId, key),
        keyset ? keysetPredicate(requests.requestedAt, requests.id, keyset, 'uuid') : undefined,
      ),
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    const current = await this.rows(this.db, this.keysOf(kept.map((row) => row.payload.key)));
    return {
      items: kept.map((row) => this.toRequest(row, current)),
      nextCursor:
        hasMore && last
          ? encodeKeyset({ createdAt: last.request.requestedAt, id: last.request.id })
          : null,
    };
  }

  /**
   * The change records, newest first (keyset over admin_actions' `(created_at, id)`), of one key
   * when `key` is given. A key no longer registered keeps its history, with no label. A record
   * says whether one admin made the change at once or another approved it (331-4), and the latter
   * names its requester and the approval.
   */
  async listChanges(
    key: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<ReleaseSettingChange>> {
    const keyset = decodeKeyset(cursor, 'uuid');
    const requestedById = sql<
      string | null
    >`${schema.adminActions.payload} -> 'approval' ->> 'requestedBy'`;
    const rows = await this.db
      .select({
        id: schema.adminActions.id,
        adminId: schema.adminActions.adminId,
        payload: schema.adminActions.payload,
        createdAt: schema.adminActions.createdAt,
        nickname: schema.profiles.nickname,
        requesterNickname: requester.nickname,
      })
      .from(schema.adminActions)
      .innerJoin(schema.profiles, eq(schema.profiles.userId, schema.adminActions.adminId))
      .leftJoin(requester, eq(requester.userId, requestedById))
      .where(
        and(
          eq(schema.adminActions.type, 'release_setting_change'),
          key === undefined
            ? undefined
            : and(
                eq(schema.adminActions.targetType, TARGET_TYPE),
                eq(schema.adminActions.targetId, key),
              ),
          keyset
            ? keysetPredicate(schema.adminActions.createdAt, schema.adminActions.id, keyset, 'uuid')
            : undefined,
        ),
      )
      .orderBy(desc(schema.adminActions.createdAt), desc(schema.adminActions.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => {
        const payload = releaseSettingChangePayloadSchema.safeParse(row.payload);
        if (!payload.success) {
          throw new AppError('INTERNAL', {
            message: `admin_actions ${row.id} is not a release setting change`,
            cause: payload.error,
          });
        }
        const { key: changedKey, before, after, reason, path, basis, approval } = payload.data;
        return {
          id: row.id,
          key: changedKey,
          label: this.registry.get(changedKey)?.label ?? null,
          before: stateOf(before),
          after: stateOf(after),
          reason,
          actor: { id: row.adminId, nickname: row.nickname },
          createdAt: row.createdAt.toISOString(),
          path: path ?? null,
          basis: basis ?? null,
          requestedBy: approval
            ? { id: approval.requestedBy, nickname: row.requesterNickname }
            : null,
          approvalId: approval?.id ?? null,
          approvalReason: approval?.decisionReason ?? null,
        };
      }),
      nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  // ---- internals ----------------------------------------------------------------------------

  private definition(key: string): ReleaseSettingDefinition {
    const definition = this.registry.get(key);
    if (!definition) throw new AppError('NOT_FOUND', { message: 'Release setting not found' });
    return definition;
  }

  private toReleaseSetting(
    definition: ReleaseSettingDefinition,
    row: SettingRow | undefined,
    pendingRequest: ReleaseSettingChangeRequest | undefined,
  ): ReleaseSetting {
    return {
      key: definition.key,
      label: definition.label,
      unit: definition.unit,
      description: definition.description,
      valueSchema: releaseSettingValueJsonSchema(definition),
      status: row?.status ?? 'undecided',
      // As stored, not re-parsed: a value a changed definition no longer accepts stays visible
      // here so an admin can replace it (`get` refuses to hand it to server code).
      value: row?.value ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      // Every account has a profile (trigger 0002); the join is LEFT only so that a missing one
      // could never hide a stored value behind `undecided`.
      updatedBy: row ? { id: row.updatedBy, nickname: row.nickname } : null,
      approval: definition.approval,
      pendingRequest: pendingRequest ?? null,
    };
  }

  private async setting(
    reader: Reader,
    definition: ReleaseSettingDefinition,
  ): Promise<ReleaseSetting> {
    const rows = await this.rows(reader, this.judgedKeys(definition));
    const pending = await this.pendingRequests(reader, definition.key, rows);
    return this.toReleaseSetting(definition, rows.get(definition.key), pending.get(definition.key));
  }

  /**
   * The keys one change of `definition` is judged by, locked in key order: its own, and all three
   * risk stages' for a stage (331-2: their combination). Two first changes of one key would both
   * find no row and collide on the primary key; two later ones would each record a `before` the
   * other overwrote. Transaction-scoped, like `lockMarket`, and taken before the clock is read.
   */
  private async lockAndRead(
    tx: Tx,
    definition: ReleaseSettingDefinition,
  ): Promise<Map<string, StoredState>> {
    const keys = this.judgedKeys(definition);
    for (const key of keys) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${TARGET_TYPE}:${key}`}::text))`,
      );
    }
    const rows = await tx
      .select({
        key: schema.releaseSettings.key,
        status: schema.releaseSettings.status,
        value: storedReleaseSettingValue,
        updatedAt: schema.releaseSettings.updatedAt,
      })
      .from(schema.releaseSettings)
      .where(inArray(schema.releaseSettings.key, keys));
    return new Map(rows.map(({ key, ...state }) => [key, state]));
  }

  /** The keys a change of `definition` is judged by, in key order (see `lockAndRead`). */
  private judgedKeys(definition: ReleaseSettingDefinition): string[] {
    const { approval } = definition;
    return 'stage' in approval && approval.stage !== undefined
      ? [...new Set([definition.key, ...Object.values(this.stageKeys)])].sort()
      : [definition.key];
  }

  /**
   * Whether a waiting request can no longer be approved as it was asked: its item no longer holds
   * the state the request saw, or — for a risk stage — the other stages moved so that the change
   * would now do something else (its basis differs: a raise that would now restart every bot, say,
   * after one admin stopped them through another stage). `states` must hold the judged keys.
   */
  private isStale(
    definition: ReleaseSettingDefinition | undefined,
    payload: ReleaseSettingChangeRequestPayload,
    states: ReadonlyMap<string, ReleaseSettingState>,
  ): boolean {
    const current = states.get(payload.key);
    if (!isReleaseSettingUnchanged(current, payload.before)) return true;
    if (definition === undefined) return false;
    const now = classifyReleaseSettingChange(
      definition.approval,
      current,
      stateOf(payload.after),
      this.stages(definition, states),
    );
    return now.path === 'unchanged' || now.basis !== payload.basis;
  }

  /** The three stages' current states, when `definition` is one of them. */
  private stages(
    definition: ReleaseSettingDefinition,
    states: ReadonlyMap<string, ReleaseSettingState>,
  ): Record<ReleaseSettingStageSlot, ReleaseSettingState | undefined> | undefined {
    const { approval } = definition;
    if (!('stage' in approval) || approval.stage === undefined) return undefined;
    const entries = RELEASE_SETTING_STAGE_SLOTS.map((slot) => {
      const key = this.stageKeys[slot];
      return [slot, key === undefined ? undefined : states.get(key)] as const;
    });
    return Object.fromEntries(entries) as Record<
      ReleaseSettingStageSlot,
      ReleaseSettingState | undefined
    >;
  }

  /**
   * The row and its `release_setting_change` record, by `actorId` (the one admin, or the approver),
   * strictly after the change this one waited for: the clock has millisecond precision, so a
   * change right behind another can read that change's instant again (or an earlier one, should
   * the clock step back). One key's records then sort in the order they were made — the change log
   * and each `before` → `after` chain — and migration 0020 refuses an UPDATE that does not move
   * `updated_at` forward.
   */
  private async write(
    tx: Tx,
    actorId: string,
    key: string,
    current: StoredState | undefined,
    after: ReleaseSettingState & { value: ReleaseSettingValue | null },
    extra: RecordExtra,
  ): Promise<void> {
    const clock = await clockTimestamp(tx);
    const changedAt = new Date(
      Math.max(clock.getTime(), (current?.updatedAt.getTime() ?? -Infinity) + 1),
    );
    const payload: ReleaseSettingChangePayload = {
      key,
      // The row this change replaces, or undecided with no value when there is none: migration
      // 0020 refuses, at commit, a record whose `before` is anything else.
      before: stateOf(current),
      after,
      // Trimmed, 1 to 500 characters (the request's, for a two-admin change): migration 0020
      // refuses, at commit, a record whose reason the body schema would not take.
      ...extra,
    };
    await tx.insert(schema.adminActions).values({
      adminId: actorId,
      type: 'release_setting_change',
      targetType: TARGET_TYPE,
      targetId: key,
      payload,
      createdAt: changedAt,
    });
    const written = {
      status: after.status,
      value: after.value,
      updatedAt: changedAt,
      updatedBy: actorId,
    };
    await tx
      .insert(schema.releaseSettings)
      .values({ key, ...written })
      .onConflictDoUpdate({ target: schema.releaseSettings.key, set: written });
  }

  /** `keys` with the keys each registered one is judged by, for `stale`. */
  private keysOf(keys: readonly string[]): string[] {
    return [
      ...new Set(
        keys.flatMap((key) => {
          const definition = this.registry.get(key);
          return definition ? this.judgedKeys(definition) : [key];
        }),
      ),
    ];
  }

  /** Stored rows of `keys` with the nickname of whoever changed each last. */
  private async rows(reader: Reader, keys: string[]): Promise<Map<string, SettingRow>> {
    if (keys.length === 0) return new Map();
    const rows = await reader
      .select(settingColumns)
      .from(schema.releaseSettings)
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.releaseSettings.updatedBy))
      .where(inArray(schema.releaseSettings.key, keys));
    return new Map(rows.map((row) => [row.key, row]));
  }

  /** The waiting request of `key` (or of every key), by key, with `stale` against `rows`. */
  private async pendingRequests(
    reader: Reader,
    key: string | undefined,
    rows: ReadonlyMap<string, SettingRow>,
  ): Promise<Map<string, ReleaseSettingChangeRequest>> {
    const pending = await this.requestRows(
      reader,
      and(
        eq(requests.status, 'pending'),
        key === undefined ? undefined : eq(requests.targetId, key),
      ),
    );
    return new Map(pending.map((row) => [row.payload.key, this.toRequest(row, rows)]));
  }

  /** The waiting request of `key`, read in the change's transaction under the key's lock. */
  private async pendingRow(tx: Tx, key: string): Promise<{ id: string } | undefined> {
    const [row] = await tx
      .select({ id: requests.id })
      .from(requests)
      .where(and(ownKind(), eq(requests.status, 'pending'), eq(requests.targetId, key)))
      .limit(1);
    return row;
  }

  private async requestRows(reader: Reader, where: SQL | undefined, limit?: number) {
    const query = reader
      .select({
        request: requests,
        requesterNickname: requester.nickname,
        deciderNickname: decider.nickname,
      })
      .from(requests)
      .leftJoin(requester, eq(requester.userId, requests.requestedBy))
      .leftJoin(decider, eq(decider.userId, requests.decidedBy))
      .where(and(ownKind(), where))
      .orderBy(desc(requests.requestedAt), desc(requests.id));
    const rows = await (limit === undefined ? query : query.limit(limit));
    return rows.map((row) => ({ ...row, payload: this.parsePayload(row.request) }));
  }

  private toRequest(
    row: Awaited<ReturnType<ReleaseSettingsService['requestRows']>>[number],
    current: ReadonlyMap<string, SettingRow>,
  ): ReleaseSettingChangeRequest {
    const { request, payload, requesterNickname, deciderNickname } = row;
    const pending = request.status === 'pending';
    return {
      id: request.id,
      key: payload.key,
      label: this.registry.get(payload.key)?.label ?? null,
      before: stateOf(payload.before),
      after: stateOf(payload.after),
      reason: request.requestReason,
      basis: payload.basis,
      requestedBy: { id: request.requestedBy, nickname: requesterNickname },
      requestedAt: request.requestedAt.toISOString(),
      status: request.status,
      decidedBy:
        request.decidedBy === null ? null : { id: request.decidedBy, nickname: deciderNickname },
      decisionReason: request.decisionReason,
      decidedAt: request.decidedAt?.toISOString() ?? null,
      retractedAt: request.retractedAt?.toISOString() ?? null,
      stale: pending && this.isStale(this.registry.get(payload.key), payload, current),
    };
  }

  private async requestById(reader: Reader, id: string): Promise<ReleaseSettingChangeRequest> {
    const [row] = await this.requestRows(reader, eq(requests.id, id));
    if (!row) throw new AppError('NOT_FOUND', { message: 'Change request not found' });
    return this.toRequest(row, await this.rows(reader, this.keysOf([row.payload.key])));
  }

  /**
   * The request after its decision or retraction, and its item — null when a release dropped the
   * key while the request waited: the decision committed, so the answer is not NOT_FOUND.
   */
  private async requestWrite(
    id: string,
    definition: ReleaseSettingDefinition | undefined,
  ): Promise<ReleaseSettingChangeRequestWrite> {
    const request = await this.requestById(this.db, id);
    return { request, setting: definition ? await this.setting(this.db, definition) : null };
  }

  private parsePayload(request: ApprovalRequest): ReleaseSettingChangeRequestPayload {
    const parsed = releaseSettingChangeRequestPayloadSchema.safeParse(request.payload);
    if (!parsed.success || request.targetId !== parsed.data.key) {
      throw new AppError('INTERNAL', { message: `Malformed change request ${request.id}` });
    }
    return parsed.data;
  }

  /** A `release_setting_change` request, or NOT_FOUND (another kind's id included). */
  private async ownRequest(
    tx: Tx,
    id: string,
  ): Promise<{ request: ApprovalRequest; payload: ReleaseSettingChangeRequestPayload }> {
    const [request] = await tx
      .select()
      .from(requests)
      .where(and(ownKind(), eq(requests.id, id)));
    if (!request) throw new AppError('NOT_FOUND', { message: 'Change request not found' });
    return { request, payload: this.parsePayload(request) };
  }

  private async isOpenAdmin(tx: Tx, id: string): Promise<boolean> {
    const [profile] = await tx
      .select({ role: schema.profiles.role, closedAt: schema.profiles.closedAt })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, id));
    return profile?.role === 'admin' && profile.closedAt === null;
  }

  /** The shared admin-roles lock, then FORBIDDEN unless `id` is an open admin now. */
  private async currentAdmin(tx: Tx, id: string): Promise<void> {
    await lockAdminRoles(tx, 'shared');
    if (!(await this.isOpenAdmin(tx, id))) {
      throw new AppError('FORBIDDEN', { message: 'Admin only' });
    }
  }

  private async audit(
    tx: Tx,
    adminId: string,
    type:
      | 'release_setting_change_request'
      | 'release_setting_change_reject'
      | 'release_setting_change_retract',
    key: string,
    at: Date,
    payload: Record<string, unknown> & { basis?: ReleaseSettingChangeBasis },
  ): Promise<void> {
    await tx.insert(schema.adminActions).values({
      adminId,
      type,
      targetType: TARGET_TYPE,
      targetId: key,
      payload,
      createdAt: at,
    });
  }
}
