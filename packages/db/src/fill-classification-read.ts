import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/** Internal cutoff only: the public transport carries no classification identifiers. */
export const classificationCutoffSql = (): SQL =>
  sql`(SELECT coalesce(max(revision),0)::bigint FROM fill_classifications)`;
/** Exact immutable decision prefix. NULL cutoff means current committed state in this snapshot. */
export function isFillExcludedSql(
  fillId: SQLWrapper,
  cutoff: SQLWrapper = classificationCutoffSql(),
): SQL<boolean> {
  return sql<boolean>`coalesce((SELECT fc.action='mark' FROM fill_classifications fc
    WHERE fc.fill_id=${fillId} AND fc.revision<=${cutoff}
    ORDER BY fc.revision DESC LIMIT 1),false)`;
}
