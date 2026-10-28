import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { PUBLIC_ID_PATTERN, type PublicProfile } from '@buddha/shared';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { authorColumns, postAuthorOf } from '../posts/posts.service.js';
import { readProfileCounts } from './profile-queries.js';

/** Unknown, malformed and withdrawn alike (#37-16: «없는 계정처럼 응답한다»). */
function profileNotFound(): AppError {
  return new AppError('NOT_FOUND', { message: 'Profile not found' });
}

/**
 * 공개 프로필 (#41, ADR-0078; ADR-0069 decision 3 #37): what anyone reads of a member at
 * `/u/<publicId>`. Reads the profile's public items and nothing else of the account — no balance,
 * order, holding, fill, PnL, watch, proposal, verification, restriction or contact (#37-8,
 * #37-11~13) — and names the member through `postAuthorOf`, the one place a person's public face is
 * made (ADR-0069 decision 5), so the profile and a byline say the same and #140's withdrawn member
 * reaches both from there.
 */
@Injectable()
export class ProfilesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * `GET /profiles/:publicId`. The id is matched in lower case — the public id's alphabet is, and it
   * is meant to survive a hand that types it in capitals (public-id.ts) — and anything that cannot
   * be one answers 404 without a query, as an unknown id does.
   */
  async getProfile(publicId: string): Promise<PublicProfile> {
    const id = publicId.toLowerCase();
    if (!PUBLIC_ID_PATTERN.test(id)) throw profileNotFound();
    const { profiles } = schema;
    const [row] = await this.db
      .select({
        userId: profiles.userId,
        // The member's public face (`postAuthorOf`), its profile image (#141) included.
        ...authorColumns,
        bio: profiles.bio,
        // #37-3: the year and month, nothing finer, so the answer carries no more than the screen
        // shows. In Korea time for every reader (owner decision 2026-10-21 answer 1: «한국 시간으로
        // 모두에게('YYYY-MM'만)») — an exception to ADR-0063, where member screens show times in
        // the member's chosen zone, else the browser's: near a month's boundary a reader elsewhere
        // sees Korea's month, not their own (ADR-0078 7-2).
        joinedMonth: sql<string>`to_char(${profiles.createdAt} AT TIME ZONE 'Asia/Seoul', 'YYYY-MM')`,
      })
      .from(profiles)
      .where(eq(profiles.publicId, id))
      .limit(1);
    if (!row) throw profileNotFound();
    const member = postAuthorOf(row);
    // A withdrawn account's profile answers like an unknown one (#37-16): when #140 makes
    // `postAuthorOf` name it a former member, this line is the rule.
    if (member.kind !== 'member') throw profileNotFound();
    const [counts, interestCategories] = await Promise.all([
      readProfileCounts(this.db, row.userId),
      this.interestCategoriesOf(row.userId),
    ]);
    return {
      member,
      bio: row.bio,
      interestCategories,
      joinedMonth: row.joinedMonth,
      ...counts,
    };
  }

  /**
   * Every interest category the member picked (#37-5), top-level and sub-categories alike (#57-7),
   * that the category list still offers — active, under an active parent: what `GET /categories`
   * lists and MY 설정 can show (a category operators retire leaves the profile with it). In that
   * list's order, a top-level category before its sub-categories and each group where its
   * top-level one stands, each with the top-level category it sits under.
   */
  private async interestCategoriesOf(userId: string) {
    const { categories, profileInterestCategories } = schema;
    const parent = alias(categories, 'parent');
    const rows = await this.db
      .select({
        slug: categories.slug,
        nameKo: categories.nameKo,
        parentSlug: parent.slug,
        parentNameKo: parent.nameKo,
      })
      .from(profileInterestCategories)
      .innerJoin(categories, eq(categories.id, profileInterestCategories.categoryId))
      .leftJoin(parent, eq(parent.id, categories.parentId))
      .where(
        and(
          eq(profileInterestCategories.userId, userId),
          eq(categories.isActive, true),
          or(isNull(categories.parentId), eq(parent.isActive, true)),
        ),
      )
      .orderBy(
        sql`coalesce(${parent.sortOrder}, ${categories.sortOrder})`,
        sql`coalesce(${parent.id}, ${categories.id})`,
        sql`${categories.parentId} nulls first`,
        asc(categories.sortOrder),
        asc(categories.id),
      );
    return rows.map((row) => ({
      slug: row.slug,
      nameKo: row.nameKo,
      parent:
        row.parentSlug === null || row.parentNameKo === null
          ? null
          : { slug: row.parentSlug, nameKo: row.parentNameKo },
    }));
  }
}
