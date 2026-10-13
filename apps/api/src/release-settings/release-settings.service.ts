import { Inject, Injectable } from '@nestjs/common';
import { getReleaseSetting, schema, storedReleaseSettingValue, type Db } from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  isReleaseSettingUnchanged,
  parseReleaseSettingChange,
  RELEASE_SETTING_UNCHANGED_MESSAGE,
  releaseSettingChangePayloadSchema,
  releaseSettingValueJsonSchema,
  type ReleaseSetting,
  type ReleaseSettingChange,
  type ReleaseSettingChangeBody,
  type ReleaseSettingChangePayload,
  type ReleaseSettingDefinition,
  type ReleaseSettingReading,
  type ReleaseSettingsRegistry,
  type ReleaseSettingStatus,
  type ReleaseSettingValue,
} from '@buddha/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { type Page } from '../wallet/wallet.service.js';
import { RELEASE_SETTINGS_REGISTRY } from './release-settings.registry.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** admin_actions.target_type of a release setting's record. */
const TARGET_TYPE = 'release_setting';

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

function toReleaseSetting(
  definition: ReleaseSettingDefinition,
  row: SettingRow | undefined,
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
    updatedBy: row ? { id: row.updatedBy, nickname: row.nickname ?? '' } : null,
  };
}

/**
 * Release settings (#170): the registry (what each item is) merged with `release_settings` (its
 * status and value); a registered key with no row is `undecided`. The only writer of that table —
 * every change appends its `release_setting_change` record in the same transaction, at an instant
 * later than the key's previous one, which migration 0020's constraint trigger also demands.
 */
@Injectable()
export class ReleaseSettingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELEASE_SETTINGS_REGISTRY) private readonly registry: ReleaseSettingsRegistry,
  ) {}

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
    const rows = await this.rows(definitions.map((definition) => definition.key));
    return definitions
      .map((definition) => toReleaseSetting(definition, rows.get(definition.key)))
      .filter((item) => status === undefined || item.status === status);
  }

  /**
   * Changes one item: the status/value rule and the item's schema first (VALIDATION_ERROR naming
   * `value`), then, under a lock on the key, the row and its `release_setting_change` record with
   * the state before and after, the reason, the admin and one instant. A change that keeps the
   * status and value as they are is refused under that lock (VALIDATION_ERROR, path `[]`,
   * RELEASE_SETTING_UNCHANGED_MESSAGE; owner decision 2026-10-13~14), so a change another admin
   * made first counts. Nothing is written when any part fails.
   */
  async change(
    adminId: string,
    key: string,
    body: ReleaseSettingChangeBody,
  ): Promise<ReleaseSetting> {
    const definition = this.registry.get(key);
    if (!definition) throw new AppError('NOT_FOUND', { message: 'Release setting not found' });
    const parsed = parseReleaseSettingChange(definition, body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Request validation failed',
        details: parsed.issues,
      });
    }
    const after = parsed.state;

    await this.db.transaction(async (tx) => {
      // Two first changes of one key would both find no row and collide on the primary key;
      // two later ones would each record a `before` the other overwrote. Transaction-scoped,
      // like `lockMarket`, and taken before the clock is read.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${TARGET_TYPE}:${key}`}::text))`,
      );
      const [current] = await tx
        .select({
          status: schema.releaseSettings.status,
          value: storedReleaseSettingValue,
          updatedAt: schema.releaseSettings.updatedAt,
        })
        .from(schema.releaseSettings)
        .where(eq(schema.releaseSettings.key, key))
        .limit(1);
      if (isReleaseSettingUnchanged(current, after)) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'The status and value are already the current ones',
          details: [{ path: [], message: RELEASE_SETTING_UNCHANGED_MESSAGE }],
        });
      }
      // Strictly after the change this one waited for: the clock has millisecond precision, so
      // a change right behind another can read that change's instant again (or an earlier one,
      // should the clock step back). One key's records then sort in the order they were made —
      // the change log and each `before` → `after` chain — and migration 0020 refuses an UPDATE
      // that does not move `updated_at` forward.
      const clock = await clockTimestamp(tx);
      const changedAt = new Date(
        Math.max(clock.getTime(), (current?.updatedAt.getTime() ?? -Infinity) + 1),
      );
      const payload: ReleaseSettingChangePayload = {
        key,
        // The row this change replaces, or undecided with no value when there is none: migration
        // 0020 refuses, at commit, a record whose `before` is anything else.
        before: { status: current?.status ?? 'undecided', value: current?.value ?? null },
        after,
        reason: body.reason,
      };

      await tx.insert(schema.adminActions).values({
        adminId,
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
        updatedBy: adminId,
      };
      await tx
        .insert(schema.releaseSettings)
        .values({ key, ...written })
        .onConflictDoUpdate({ target: schema.releaseSettings.key, set: written });
    });

    const rows = await this.rows([key]);
    return toReleaseSetting(definition, rows.get(key));
  }

  /**
   * The change records, newest first (keyset over admin_actions' `(created_at, id)`), of one key
   * when `key` is given. A key no longer registered keeps its history, with no label.
   */
  async listChanges(
    key: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<ReleaseSettingChange>> {
    const keyset = decodeKeyset(cursor, 'uuid');
    const rows = await this.db
      .select({
        id: schema.adminActions.id,
        adminId: schema.adminActions.adminId,
        payload: schema.adminActions.payload,
        createdAt: schema.adminActions.createdAt,
        nickname: schema.profiles.nickname,
      })
      .from(schema.adminActions)
      .innerJoin(schema.profiles, eq(schema.profiles.userId, schema.adminActions.adminId))
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
        const { key: changedKey, before, after, reason } = payload.data;
        return {
          id: row.id,
          key: changedKey,
          label: this.registry.get(changedKey)?.label ?? null,
          before: { status: before.status, value: before.value ?? null },
          after: { status: after.status, value: after.value ?? null },
          reason,
          actor: { id: row.adminId, nickname: row.nickname },
          createdAt: row.createdAt.toISOString(),
        };
      }),
      nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  /** Stored rows of `keys` with the nickname of whoever changed each last. */
  private async rows(keys: string[]): Promise<Map<string, SettingRow>> {
    const rows = await this.db
      .select(settingColumns)
      .from(schema.releaseSettings)
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.releaseSettings.updatedBy))
      .where(inArray(schema.releaseSettings.key, keys));
    return new Map(rows.map((row) => [row.key, row]));
  }
}
