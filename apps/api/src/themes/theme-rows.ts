import { schema } from '@buddha/db';
import {
  decodeTupleCursor,
  encodeTupleCursor,
  koreanDateAt,
  themeStatusAt,
  type ThemeStatus,
  type ThemeSummary,
} from '@buddha/shared';
import { and, asc, gt, gte, lt, lte, sql, type SQL } from 'drizzle-orm';
import { tupleKeysetPredicate } from '../common/keyset.js';

export type ThemeRow = typeof schema.themes.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1_000;

/** A `YYYY-MM-DD` date as days since 1970-01-01, the integer `date - DATE '1970-01-01'` gives. */
export function epochDayOf(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00.000Z`) / DAY_MS);
}

/** The date `day` days after 1970-01-01, `YYYY-MM-DD`. */
export function dateOfEpochDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The themes of one status on the Korean date `today`, as a predicate: the SQL side of
 * `themeStatusAt` (@buddha/shared), which labels every answer. Both days of the period are in it
 * (owner decision 2026-10-19), so a theme is 진행 중 on its start date and on its end date and 종료
 * from the day after; both sides compare against the one Korean date the request read from the
 * database clock.
 */
export function themeStatusWhere(status: ThemeStatus, today: string): SQL | undefined {
  const { themes } = schema;
  switch (status) {
    case 'upcoming':
      return gt(themes.startDate, today);
    case 'ongoing':
      return and(lte(themes.startDate, today), gte(themes.endDate, today));
    case 'ended':
      return lt(themes.endDate, today);
  }
}

/**
 * The public order of themes on `today` (owner decision 2026-10-19, `THEME_LIST_STATUS_ORDER`):
 * 진행 중 first, the soonest to end first; then 예정, the soonest to start first; then 종료, the most
 * recently ended first; the id last, so the order is total. One ascending row `(rank, key, id)`:
 * the rank is the status's place, the key the date that orders it, negated for 종료 so a later
 * end comes first. `GET /themes` pages on it and a market detail's links take it whole.
 */
export function themeListOrder(today: string) {
  const { themes } = schema;
  const day = sql`${today}::date`;
  const rank = sql<number>`(CASE WHEN ${themes.startDate} > ${day} THEN 1 WHEN ${themes.endDate} >= ${day} THEN 0 ELSE 2 END)`;
  const key = sql<number>`(CASE WHEN ${themes.startDate} > ${day} THEN ${themes.startDate} - DATE '1970-01-01' WHEN ${themes.endDate} >= ${day} THEN ${themes.endDate} - DATE '1970-01-01' ELSE DATE '1970-01-01' - ${themes.endDate} END)`;
  return {
    fields: { rank: rank.mapWith(Number), key: key.mapWith(Number) },
    orderBy: [asc(rank), asc(key), asc(themes.id)],
    rank,
    key,
  };
}

/** The value shapes of the public list's cursor: the first page's day, the rank, the key. */
const THEME_CURSOR_SHAPES = ['epochDay', 'themeRank', 'signedEpochDay'] as const;

/**
 * A page of the public list after `cursor`, ordered on the Korean date its first page was read
 * at: a list read across a Korean midnight keeps sorting its later pages by the statuses of that
 * day, so no theme moves between groups under a reader and is skipped or shown twice (the window
 * idea of the recommended cursor, ADR-0065). The labels still say each theme's status now. A
 * cursor of another shape — or none — is a first page on the date `now` is.
 */
export function themeListPage(
  cursor: string | undefined,
  now: Date,
): { today: string; after: SQL | undefined } {
  // The day is the database clock's, six digits (`epochDay`); the key is a stored date, up to
  // seven (`signedEpochDay`: the column stores up to 9999-12-31, past the API's 2100-12-31).
  // Both are integers Postgres takes.
  const decoded = decodeTupleCursor(cursor, THEME_CURSOR_SHAPES, 'uuid');
  if (decoded === undefined) return { today: koreanDateAt(now), after: undefined };
  const today = dateOfEpochDay(Number(decoded.values[0]));
  const order = themeListOrder(today);
  const [, rank, key] = decoded.values as [string, string, string];
  return {
    today,
    after: tupleKeysetPredicate(
      [
        { key: order.rank, value: rank, cast: 'bigint' },
        { key: order.key, value: key, cast: 'bigint' },
        { key: schema.themes.id, value: decoded.id, cast: 'uuid' },
      ],
      'after',
    ),
  };
}

/** The cursor after `last`, read in the order of `today`. */
export function themeListCursor(today: string, last: { rank: number; key: number; id: string }) {
  return encodeTupleCursor(
    [String(epochDayOf(today)), String(last.rank), String(last.key)],
    last.id,
  );
}

/** The public list row: what is public of a theme, its status at `now`. */
export function toThemeSummary(row: ThemeRow, now: Date): ThemeSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    startDate: row.startDate,
    endDate: row.endDate,
    status: themeStatusAt(row, now),
  };
}
