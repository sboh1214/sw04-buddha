import { schema, type Db } from '@buddha/db';
import { LINK_REPEAT_WINDOW_SECONDS, WRITE_LIMIT_DAY_SECONDS } from '@buddha/shared';
import { lt, sql } from 'drizzle-orm';

/**
 * How long past its window a record is kept before it is deleted. A write's count reads the
 * database clock in one statement and counts in later ones (the API's WriteLimitsService.take,
 * LinkReviewService.record), each under READ COMMITTED with a snapshot of its own: a deletion cut
 * exactly at the window's edge that commits between the two would take out a record the running
 * count still includes. No transaction spends anywhere near an hour between the two, and the
 * records are a hash and a time (a link use also its address and item): keeping them an hour
 * longer costs nothing.
 */
export const COMMUNITY_RECORDS_PURGE_MARGIN_SECONDS = 60 * 60;

export interface CommunityRecordsPurgeOutcome {
  /** `write_limit_events` rows deleted: counted writes older than the longest window. */
  writeLimitEvents: number;
  /** `link_uses` rows deleted: link uses older than the repetition rules' window. */
  linkUses: number;
}

/**
 * `community.records_purge` (#187, ADR-0083): deletes the working records nothing reads any more —
 * a counted write (`write_limit_events`) once it is older than the longest window of the write
 * limits (WRITE_LIMIT_DAY_SECONDS: 24 hours), and a link use (`link_uses`) once it is older than
 * the repetition rules' window (LINK_REPEAT_WINDOW_SECONDS), each with a margin of
 * COMMUNITY_RECORDS_PURGE_MARGIN_SECONDS past it. A window counts the records newer than
 * `now - window`, so a record past it never counts again, and the margin keeps every record a
 * count running meanwhile may still include. They are kept no longer than that. The review list
 * (`link_flags`) is not touched (ADR-0083 7-20: kept with no period, a question for the owner).
 * Hourly (JOB_SCHEDULES), two short statements: an hour's worth of records at a time once it runs.
 */
export async function purgeCommunityRecords(db: Db): Promise<CommunityRecordsPurgeOutcome> {
  const { writeLimitEvents, linkUses } = schema;
  const before = (windowSeconds: number) =>
    sql`now() - make_interval(secs => ${windowSeconds + COMMUNITY_RECORDS_PURGE_MARGIN_SECONDS})`;
  const events = await db
    .delete(writeLimitEvents)
    .where(lt(writeLimitEvents.createdAt, before(WRITE_LIMIT_DAY_SECONDS)));
  const uses = await db
    .delete(linkUses)
    .where(lt(linkUses.usedAt, before(LINK_REPEAT_WINDOW_SECONDS)));
  return { writeLimitEvents: events.rowCount ?? 0, linkUses: uses.rowCount ?? 0 };
}
