import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { decodeKeyset, encodeKeyset, type RetentionPurge } from '@buddha/shared';
import { and, desc, eq, lt } from 'drizzle-orm';
import { keysetPredicate } from '../common/keyset.js';
import { DB } from '../infra/db/db.provider.js';
import { type Page } from '../wallet/wallet.service.js';

/**
 * 경과 처리 기록 (#184, ADR-0087) for admins: what the worker's `retention.purge` runs deleted — the
 * kind, how many, the period applied, the run's instant and whether the kind was done or failed
 * (`retention_purges`; owner decision 2026-10-24 14). The API only reads them; the worker writes
 * them in the transactions that delete what they count, and a failure's after its rollback.
 */
@Injectable()
export class RetentionPurgesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Newest run first (`(ran_at, id)` descending — a run's rows share its instant, the id keeps
   * them in the order they were written, backwards), with the row-comparison cursor. A page holds
   * `limit` records and then the rest of the run the last of them belongs to: a run writes a
   * record per kind and per batch (eleven and more once every period is approved), so a page cut
   * at `limit` would end inside a run, and the screen would show that run with kinds missing and
   * counts short, looking whole until the next page came (ADR-0087 결정 5). So the cursor always
   * sits on a run's last record, and the next page starts with the next run. A run still being
   * written is read as far as it has gone.
   */
  async list(cursor: string | undefined, limit: number): Promise<Page<RetentionPurge>> {
    const { retentionPurges } = schema;
    const keyset = decodeKeyset(cursor, 'int');
    const rows = await this.db
      .select()
      .from(retentionPurges)
      .where(
        keyset
          ? keysetPredicate(retentionPurges.ranAt, retentionPurges.id, keyset, 'bigint')
          : undefined,
      )
      .orderBy(desc(retentionPurges.ranAt), desc(retentionPurges.id))
      .limit(limit + 1);
    let hasMore = rows.length > limit;
    let kept = hasMore ? rows.slice(0, limit) : rows;
    const cut = kept.at(-1);
    if (hasMore && cut && rows[limit]!.ranAt.getTime() === cut.ranAt.getTime()) {
      // The page would end inside a run: take the rest of it, then look past it for more.
      const rest = await this.db
        .select()
        .from(retentionPurges)
        .where(and(eq(retentionPurges.ranAt, cut.ranAt), lt(retentionPurges.id, cut.id)))
        .orderBy(desc(retentionPurges.id));
      kept = [...kept, ...rest];
      const [next] = await this.db
        .select({ id: retentionPurges.id })
        .from(retentionPurges)
        .where(lt(retentionPurges.ranAt, cut.ranAt))
        .limit(1);
      hasMore = next !== undefined;
    }
    const last = kept.at(-1);
    return {
      items: kept.map((row) => ({
        id: row.id.toString(),
        kind: row.kind as RetentionPurge['kind'],
        count: row.count,
        periodDays: row.periodDays,
        ranAt: row.ranAt.toISOString(),
        outcome: row.outcome as RetentionPurge['outcome'],
      })),
      nextCursor:
        hasMore && last ? encodeKeyset({ createdAt: last.ranAt, id: last.id.toString() }) : null,
    };
  }
}
