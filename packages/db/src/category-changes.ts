import {
  CATEGORY_CHANGE_TYPES,
  adminCategoryChangesQuerySchema,
  decodeKeyset,
  encodeKeyset,
  type AdminCategoryChange,
  type AdminCategoryChangePage,
  type AdminCategoryChangesQuery,
  type AdminCategoryRef,
  type CategoryChangeType,
} from '@buddha/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { adminActions, categories, profiles } from './schema/index.js';

/*
 * 카테고리 변경 기록 (#145 part 2, ADR-0164; 145-10 "/admin/categories 아래에 변경 기록을 최신순으로
 * 보인다"; ADR-0096 결과 5): the `category_*` admin actions, newest first, with the actor, the time
 * and the values before and after. Two statements in one REPEATABLE READ, READ ONLY transaction:
 * the page (`admin_actions_type_created_at_id_idx`, five types — category writes are
 * operator-paced, so no partial index; ADR-0164 구현의 선택), then one lookup of every category
 * id the page names, so a reorder's ids and a creation's parent read as names. Names are the
 * CURRENT ones: a category renamed since shows its new name there (a rename's own before and
 * after are the stored names).
 */

type Transactional = Pick<Db, 'transaction'>;

const READ_ONLY = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A stored category id (number, or text from `target_id`), or null for none or a bad value. */
function categoryIdOf(value: unknown): number | null {
  const id = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : value;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

const idsOf = (value: unknown): number[] =>
  Array.isArray(value) ? value.map(categoryIdOf).filter((id): id is number => id !== null) : [];

/** Every category id a record names. */
function namedIds(targetId: string | null, payload: Record<string, unknown>): number[] {
  return [
    categoryIdOf(targetId),
    categoryIdOf(record(payload.after).parentId),
    categoryIdOf(payload.parentId),
    ...idsOf(payload.before),
    ...idsOf(payload.after),
  ].filter((id): id is number => id !== null);
}

/** `GET /admin/categories/changes`: the category records, newest first. */
export async function readCategoryChanges(
  db: Transactional,
  input: Partial<AdminCategoryChangesQuery> = {},
): Promise<AdminCategoryChangePage> {
  const query = adminCategoryChangesQuerySchema.parse(input);
  const cursor = decodeKeyset(query.cursor, 'uuid');
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: adminActions.id,
        type: adminActions.type,
        createdAt: adminActions.createdAt,
        adminId: adminActions.adminId,
        nickname: profiles.nickname,
        targetId: adminActions.targetId,
        payload: adminActions.payload,
      })
      .from(adminActions)
      .leftJoin(profiles, eq(profiles.userId, adminActions.adminId))
      .where(
        and(
          inArray(adminActions.type, [...CATEGORY_CHANGE_TYPES]),
          cursor
            ? sql`(${adminActions.createdAt}, ${adminActions.id}) <
                (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(adminActions.createdAt), desc(adminActions.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const ids = [...new Set(page.flatMap((row) => namedIds(row.targetId, record(row.payload))))];
    const names = new Map<number, string>(
      ids.length === 0
        ? []
        : (
            await tx
              .select({ id: categories.id, nameKo: categories.nameKo })
              .from(categories)
              .where(inArray(categories.id, ids))
          ).map((row) => [row.id, row.nameKo]),
    );
    const ref = (id: number | null): AdminCategoryRef | null =>
      id === null ? null : { id, nameKo: names.get(id) ?? null };
    const last = page.at(-1);
    return {
      data: page.map((row) => changeOf(row, ref)),
      meta: {
        nextCursor:
          rows.length > query.limit && last
            ? encodeKeyset({ createdAt: last.createdAt, id: last.id })
            : null,
      },
    };
  }, READ_ONLY);
}

interface ChangeRow {
  id: string;
  type: string;
  createdAt: Date;
  adminId: string;
  nickname: string | null;
  targetId: string | null;
  payload: Record<string, unknown> | null;
}

function changeOf(
  row: ChangeRow,
  ref: (id: number | null) => AdminCategoryRef | null,
): AdminCategoryChange {
  const payload = record(row.payload);
  const before = record(payload.before);
  const after = record(payload.after);
  const base = {
    id: row.id,
    at: row.createdAt.toISOString(),
    actor: { id: row.adminId, nickname: row.nickname },
    category: ref(categoryIdOf(row.targetId)),
  };
  const refs = (value: unknown): AdminCategoryRef[] =>
    idsOf(value).map((id) => ref(id) ?? { id, nameKo: null });
  const type = row.type as CategoryChangeType;
  switch (type) {
    case 'category_create':
      return {
        ...base,
        type,
        details: {
          nameKo: textOf(after.nameKo),
          parent: ref(categoryIdOf(after.parentId)),
        },
      };
    case 'category_rename':
      return {
        ...base,
        type,
        details: { before: textOf(before.nameKo), after: textOf(after.nameKo) },
      };
    case 'category_reorder':
      return {
        ...base,
        type,
        details: {
          parent: ref(categoryIdOf(payload.parentId)),
          before: refs(payload.before),
          after: refs(payload.after),
        },
      };
    case 'category_hide':
    case 'category_show':
      return {
        ...base,
        type,
        details: { before: before.isActive === true, after: after.isActive === true },
      };
  }
}
