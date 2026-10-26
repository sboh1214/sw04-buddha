import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  PUBLIC_MARKET_STATUSES,
  THEME_REFUSALS,
  decodeKeyset,
  encodeKeyset,
  type AdminActionType,
  type AdminTheme,
  type AdminThemeMarket,
  type AdminThemeNotice,
  type AdminThemeSummary,
  type CreateThemeBody,
  type CreateThemeNoticeBody,
  type CursorQuery,
  type UpdateThemeBody,
  type UpdateThemeNoticeBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { keysetPredicate } from '../common/keyset.js';
import { AppError } from '../common/errors/app-error.js';
import { PG_UNIQUE_VIOLATION, isPgError } from '../common/errors/pg-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { marketWithCategory, toMarketSummary } from '../markets/market.service.js';
import { type Page } from '../wallet/wallet.service.js';
import { toThemeSummary, type ThemeRow } from './theme-rows.js';

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Reads that run either inside a transaction or on the pool. */
type Executor = Db | Tx;

type NoticeRow = typeof schema.themeNotices.$inferSelect;

/** The theme fields an edit can change, as the audit payload writes them (dates as stored). */
type ThemeFields = Pick<ThemeRow, 'slug' | 'name' | 'intro' | 'startDate' | 'endDate'>;
const THEME_FIELDS = ['slug', 'name', 'intro', 'startDate', 'endDate'] as const;

/** A notice's text, the fields an edit can change. */
const NOTICE_FIELDS = ['title', 'body'] as const;

/** UNIQUE (slug) on themes (migration 0045). */
export const THEME_SLUG_UNIQUE = 'themes_slug_unique';

/** A VALIDATION_ERROR naming one field, with one of the `THEME_REFUSALS`. */
function refusal(
  which: (typeof THEME_REFUSALS)[keyof typeof THEME_REFUSALS],
  message: string,
  cause?: unknown,
): AppError {
  return new AppError('VALIDATION_ERROR', {
    message,
    details: [{ path: [which.field], message: which.message }],
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * 테마 (#81) for admins: making and editing a theme, putting markets in and taking them out,
 * publishing and unpublishing, and the page's notices. Owner decisions (ADR-0069 decision 4, the
 * #81 rows): every admin may do all of it, any time — before, during or after the period,
 * published or not — with no cap on markets and any market status; a theme is unpublished and
 * never deleted; every change records the admin and the time and nothing else. And of 2026-10-19
 * (ADR-0088): a notice is hidden and never deleted; the slug is the operator's at creation and
 * fixed once the theme has been published — through an unpublish too (second round); a theme is
 * published only with a public market in it — a draft does not count (second round) — and every
 * market may be taken out afterwards.
 *
 * Each write that changes something writes one `admin_actions` row (a `theme_*` type, target
 * `theme` / the theme's id) in the same transaction, at the same clock reading as the change; a
 * write that changes nothing — the same name again, a market already in, publishing a published
 * theme — writes none, as 관련 시장 does (ADR-0068). A write that changes a row locks it first
 * (`FOR UPDATE`), so two admins racing for one change are ordered and the second sees the first's
 * result; two links of one market wait on the primary key, as a 관련 시장 link does.
 *
 * Nothing here touches a market: no market row, event, job or setting is written, and no rule,
 * order, judgement or settlement path reads the theme tables (N05 §7).
 */
@Injectable()
export class ThemeAdminService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** `GET /admin/themes`: every theme, published or not, the newest first. */
  async list(query: CursorQuery): Promise<Page<AdminThemeSummary>> {
    const { themes } = schema;
    const now = await clockTimestamp(this.db);
    const keyset = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.db
      .select()
      .from(themes)
      .where(keyset ? keysetPredicate(themes.createdAt, themes.id, keyset, 'uuid') : undefined)
      .orderBy(desc(themes.createdAt), desc(themes.id))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => toAdminThemeSummary(row, now)),
      nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  /** `GET /admin/themes/:id`: the theme with every notice, hidden ones too. */
  async get(themeId: string): Promise<AdminTheme> {
    return this.adminTheme(this.db, themeId, await clockTimestamp(this.db));
  }

  /**
   * `POST /admin/themes`: a new theme, unpublished, and its `theme_create` record. A slug another
   * theme has is VALIDATION_ERROR naming `slug` (the unique index decides).
   */
  async create(
    adminId: string,
    body: WithoutExpectedAccount<CreateThemeBody>,
  ): Promise<AdminTheme> {
    try {
      return await this.db.transaction(async (tx) => {
        const now = await clockTimestamp(tx);
        const [row] = await tx
          .insert(schema.themes)
          .values({
            slug: body.slug,
            name: body.name,
            intro: body.intro,
            startDate: body.startDate,
            endDate: body.endDate,
            createdBy: adminId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const theme = row!;
        await this.audit(tx, adminId, 'theme_create', theme.id, auditFields(theme), now);
        return this.adminTheme(tx, theme.id, now);
      });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION, THEME_SLUG_UNIQUE)) throw slugTaken(error);
      throw error;
    }
  }

  /**
   * `PATCH /admin/themes/:id`: the address, the name, the introduction or the period, at any
   * time — but the slug only until the theme is first published (owner decision 2026-10-19): a
   * different slug after that is VALIDATION_ERROR naming `slug`, while the same slug again is no
   * change, so a form that sends every field still saves. The period is checked as it would be
   * stored — a half sent alone against the other half on the row — and a period that would end
   * before it starts is refused naming the half the body sent (`endDate` when it sent both).
   * Only the fields that change are written and recorded, before and after.
   */
  async update(
    adminId: string,
    themeId: string,
    body: WithoutExpectedAccount<UpdateThemeBody>,
  ): Promise<AdminTheme> {
    try {
      return await this.db.transaction(async (tx) => {
        const current = await this.lockTheme(tx, themeId);
        const next: ThemeFields = {
          slug: body.slug ?? current.slug,
          name: body.name ?? current.name,
          intro: body.intro ?? current.intro,
          startDate: body.startDate ?? current.startDate,
          endDate: body.endDate ?? current.endDate,
        };
        if (next.slug !== current.slug && current.firstPublishedAt !== null) {
          throw refusal(THEME_REFUSALS.slugFixed, 'The slug cannot change once published');
        }
        if (next.endDate < next.startDate) {
          throw refusal(
            body.endDate === undefined
              ? THEME_REFUSALS.startAfterEnd
              : THEME_REFUSALS.endBeforeStart,
            'endDate must not be before startDate',
          );
        }
        const changed = THEME_FIELDS.filter((field) => next[field] !== current[field]);
        const now = await clockTimestamp(tx);
        if (changed.length > 0) {
          await tx
            .update(schema.themes)
            .set({ ...pick(next, changed), updatedAt: now })
            .where(eq(schema.themes.id, themeId));
          await this.audit(
            tx,
            adminId,
            'theme_update',
            themeId,
            { before: auditFields(current, changed), after: auditFields(next, changed) },
            now,
          );
        }
        return this.adminTheme(tx, themeId, now);
      });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION, THEME_SLUG_UNIQUE)) throw slugTaken(error);
      throw error;
    }
  }

  /**
   * `POST /admin/themes/:id/publish`: public from now; a published theme stays as it is. A theme
   * with no public market in it is VALIDATION_ERROR naming `markets` (owner decisions 2026-10-19:
   * a market at least, and of the second round, one that is not a draft — a draft is on no public
   * page, so a theme of drafts alone would go public as an empty page). The first publish fixes
   * the slug (`first_published_at`).
   */
  async publish(adminId: string, themeId: string): Promise<AdminTheme> {
    return this.setPublished(adminId, themeId, true);
  }

  /**
   * `POST /admin/themes/:id/unpublish`: off every public answer, kept with its markets and
   * notices for the admin; an unpublished theme stays as it is. There is no delete.
   */
  async unpublish(adminId: string, themeId: string): Promise<AdminTheme> {
    return this.setPublished(adminId, themeId, false);
  }

  /**
   * `GET /admin/themes/:id/markets`: every market in the theme, any status (drafts included —
   * the public answers leave them out), the latest put in first, with who put it in.
   */
  async listMarkets(themeId: string): Promise<AdminThemeMarket[]> {
    await this.requireTheme(this.db, themeId);
    return this.marketRows(this.db, themeId);
  }

  /**
   * `POST /admin/themes/:id/markets`: puts a market in the theme, in any status, and answers the
   * theme's markets as they now stand. An unknown market is NOT_FOUND naming `marketId`; a market
   * already in changes nothing and writes no record.
   */
  async link(adminId: string, themeId: string, marketId: string): Promise<AdminThemeMarket[]> {
    return this.db.transaction(async (tx) => {
      await this.requireTheme(tx, themeId);
      await this.requireMarket(tx, marketId);
      const now = await clockTimestamp(tx);
      const inserted = await tx
        .insert(schema.themeMarkets)
        .values({ themeId, marketId, createdBy: adminId, createdAt: now })
        .onConflictDoNothing()
        .returning({ marketId: schema.themeMarkets.marketId });
      if (inserted.length > 0) {
        await this.audit(tx, adminId, 'theme_market_link', themeId, { themeId, marketId }, now);
      }
      return this.marketRows(tx, themeId);
    });
  }

  /**
   * `DELETE /admin/themes/:id/markets/:marketId`: takes a market out of the theme. The same
   * refusals as `link`, naming the path's `marketId`; a market not in changes nothing.
   */
  async unlink(adminId: string, themeId: string, marketId: string): Promise<AdminThemeMarket[]> {
    const { themeMarkets } = schema;
    return this.db.transaction(async (tx) => {
      await this.requireTheme(tx, themeId);
      await this.requireMarket(tx, marketId);
      const now = await clockTimestamp(tx);
      const deleted = await tx
        .delete(themeMarkets)
        .where(and(eq(themeMarkets.themeId, themeId), eq(themeMarkets.marketId, marketId)))
        .returning({ marketId: themeMarkets.marketId });
      if (deleted.length > 0) {
        await this.audit(tx, adminId, 'theme_market_unlink', themeId, { themeId, marketId }, now);
      }
      return this.marketRows(tx, themeId);
    });
  }

  /**
   * `POST /admin/themes/:id/notices`: a notice on the theme's page, shown at once (to the public
   * once the theme is published). The record keeps its text.
   */
  async createNotice(
    adminId: string,
    themeId: string,
    body: WithoutExpectedAccount<CreateThemeNoticeBody>,
  ): Promise<AdminTheme> {
    return this.db.transaction(async (tx) => {
      await this.requireTheme(tx, themeId);
      const now = await clockTimestamp(tx);
      const [row] = await tx
        .insert(schema.themeNotices)
        .values({ themeId, title: body.title, body: body.body, createdBy: adminId, createdAt: now })
        .returning({ id: schema.themeNotices.id });
      await this.audit(
        tx,
        adminId,
        'theme_notice_create',
        themeId,
        { noticeId: row!.id, title: body.title, body: body.body },
        now,
      );
      return this.adminTheme(tx, themeId, now);
    });
  }

  /**
   * `PATCH /admin/themes/:id/notices/:noticeId`: the title, the body or both. A change sets
   * `edited_at` and records the text before and after (the earlier text stays for admins only);
   * the same text again changes nothing. A notice of another theme is NOT_FOUND naming `noticeId`.
   */
  async updateNotice(
    adminId: string,
    themeId: string,
    noticeId: string,
    body: WithoutExpectedAccount<UpdateThemeNoticeBody>,
  ): Promise<AdminTheme> {
    return this.db.transaction(async (tx) => {
      const notice = await this.lockNotice(tx, themeId, noticeId);
      const next = { title: body.title ?? notice.title, body: body.body ?? notice.body };
      const changed = NOTICE_FIELDS.filter((field) => next[field] !== notice[field]);
      const now = await clockTimestamp(tx);
      if (changed.length > 0) {
        await tx
          .update(schema.themeNotices)
          .set({ ...pick(next, changed), editedAt: now })
          .where(eq(schema.themeNotices.id, noticeId));
        await this.audit(
          tx,
          adminId,
          'theme_notice_update',
          themeId,
          { noticeId, before: pick(notice, changed), after: pick(next, changed) },
          now,
        );
      }
      return this.adminTheme(tx, themeId, now);
    });
  }

  /** `POST /admin/themes/:id/notices/:noticeId/hide`: off the public page, kept; never deleted. */
  async hideNotice(adminId: string, themeId: string, noticeId: string): Promise<AdminTheme> {
    return this.setNoticeHidden(adminId, themeId, noticeId, true);
  }

  /** `POST /admin/themes/:id/notices/:noticeId/show`: a hidden notice back on the page. */
  async showNotice(adminId: string, themeId: string, noticeId: string): Promise<AdminTheme> {
    return this.setNoticeHidden(adminId, themeId, noticeId, false);
  }

  private async setPublished(
    adminId: string,
    themeId: string,
    published: boolean,
  ): Promise<AdminTheme> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockTheme(tx, themeId);
      const now = await clockTimestamp(tx);
      if ((current.publishedAt !== null) !== published) {
        // Counted under the theme's row lock: a link or unlink of this theme takes no such lock,
        // so a market taken out in the same instant may leave a theme just published empty — as
        // taking every market out after publishing may, which the owner allows. A market counted
        // stays public: no path takes a market back to draft.
        if (published && (await this.publicMarketCount(tx, themeId)) === 0) {
          throw refusal(
            THEME_REFUSALS.noPublicMarket,
            'A theme is published with a market that is not a draft in it',
          );
        }
        await tx
          .update(schema.themes)
          .set({
            publishedAt: published ? now : null,
            ...(published && current.firstPublishedAt === null ? { firstPublishedAt: now } : {}),
            updatedAt: now,
          })
          .where(eq(schema.themes.id, themeId));
        await this.audit(
          tx,
          adminId,
          published ? 'theme_publish' : 'theme_unpublish',
          themeId,
          null,
          now,
        );
      }
      return this.adminTheme(tx, themeId, now);
    });
  }

  private async setNoticeHidden(
    adminId: string,
    themeId: string,
    noticeId: string,
    hidden: boolean,
  ): Promise<AdminTheme> {
    return this.db.transaction(async (tx) => {
      const notice = await this.lockNotice(tx, themeId, noticeId);
      const now = await clockTimestamp(tx);
      if ((notice.hiddenAt !== null) !== hidden) {
        await tx
          .update(schema.themeNotices)
          .set({ hiddenAt: hidden ? now : null })
          .where(eq(schema.themeNotices.id, noticeId));
        await this.audit(
          tx,
          adminId,
          hidden ? 'theme_notice_hide' : 'theme_notice_show',
          themeId,
          { noticeId },
          now,
        );
      }
      return this.adminTheme(tx, themeId, now);
    });
  }

  /** The theme row, locked for the rest of the transaction, or NOT_FOUND. */
  private async lockTheme(tx: Tx, themeId: string): Promise<ThemeRow> {
    const [row] = await tx
      .select()
      .from(schema.themes)
      .where(eq(schema.themes.id, themeId))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND', { message: 'Theme not found' });
    return row;
  }

  /**
   * The notice row, locked, when it is one of the theme's: NOT_FOUND for an unknown theme first
   * (the plain one of every theme route), then NOT_FOUND naming `noticeId` for a notice that is
   * not the theme's.
   */
  private async lockNotice(tx: Tx, themeId: string, noticeId: string): Promise<NoticeRow> {
    await this.requireTheme(tx, themeId);
    const { themeNotices } = schema;
    const [row] = await tx
      .select()
      .from(themeNotices)
      .where(and(eq(themeNotices.id, noticeId), eq(themeNotices.themeId, themeId)))
      .for('update');
    if (!row) {
      throw new AppError('NOT_FOUND', {
        message: 'Notice not found',
        details: [{ path: ['noticeId'], message: 'not found' }],
      });
    }
    return row;
  }

  /**
   * How many of the theme's markets the public pages show: every status but a draft, the set the
   * theme's public cards are (`ThemesService.listMarkets`, `PUBLIC_MARKET_STATUSES`).
   */
  private async publicMarketCount(executor: Executor, themeId: string): Promise<number> {
    const { themeMarkets, markets } = schema;
    const [row] = await executor
      .select({ n: count() })
      .from(themeMarkets)
      .innerJoin(markets, eq(markets.id, themeMarkets.marketId))
      .where(
        and(
          eq(themeMarkets.themeId, themeId),
          inArray(markets.status, [...PUBLIC_MARKET_STATUSES]),
        ),
      );
    return row?.n ?? 0;
  }

  private async requireTheme(executor: Executor, themeId: string): Promise<void> {
    const [row] = await executor
      .select({ id: schema.themes.id })
      .from(schema.themes)
      .where(eq(schema.themes.id, themeId));
    if (!row) throw new AppError('NOT_FOUND', { message: 'Theme not found' });
  }

  /** Any market, in any status; NOT_FOUND naming `marketId`, the field that carried it. */
  private async requireMarket(executor: Executor, marketId: string): Promise<void> {
    const [row] = await executor
      .select({ id: schema.markets.id })
      .from(schema.markets)
      .where(eq(schema.markets.id, marketId));
    if (!row) {
      throw new AppError('NOT_FOUND', {
        message: 'Market not found',
        details: [{ path: ['marketId'], message: 'not found' }],
      });
    }
  }

  /** The record of a change (actor and time; ADR-0069 decision 4, the #81 '기록·승인' row). */
  private async audit(
    tx: Tx,
    adminId: string,
    type: Extract<AdminActionType, `theme_${string}`>,
    themeId: string,
    payload: Record<string, unknown> | null,
    now: Date,
  ): Promise<void> {
    await tx.insert(schema.adminActions).values({
      adminId,
      type,
      targetType: 'theme',
      targetId: themeId,
      payload,
      createdAt: now,
    });
  }

  /**
   * The theme as the admin sees it, read through `executor` so a write answers the state it just
   * wrote: who made it and every notice with its writer, by id and current nickname (as the
   * admin's 관련 시장 names who linked, ADR-0068) — null for a former admin who closed the account
   * since (#140, `AdminAccountActor`). LEFT joins on `profiles` only so that a missing profile
   * could never hide a row from the screen that manages it (every account has one).
   */
  private async adminTheme(executor: Executor, themeId: string, now: Date): Promise<AdminTheme> {
    const { themes, themeNotices, profiles } = schema;
    const [row] = await executor
      .select({ theme: themes, nickname: profiles.nickname })
      .from(themes)
      .leftJoin(profiles, eq(profiles.userId, themes.createdBy))
      .where(eq(themes.id, themeId));
    if (!row) throw new AppError('NOT_FOUND', { message: 'Theme not found' });
    const notices = await executor
      .select({ notice: themeNotices, nickname: profiles.nickname })
      .from(themeNotices)
      .leftJoin(profiles, eq(profiles.userId, themeNotices.createdBy))
      .where(eq(themeNotices.themeId, themeId))
      .orderBy(desc(themeNotices.createdAt), desc(themeNotices.id));
    return {
      ...toAdminThemeSummary(row.theme, now),
      intro: row.theme.intro,
      createdBy: { id: row.theme.createdBy, nickname: row.nickname },
      notices: notices.map(({ notice, nickname }) => toAdminNotice(notice, nickname)),
    };
  }

  /** The theme's markets for the admin, the latest put in first (then the market id). */
  private async marketRows(executor: Executor, themeId: string): Promise<AdminThemeMarket[]> {
    const { themeMarkets, markets, categories, profiles } = schema;
    const rows = await executor
      .select({
        ...marketWithCategory,
        linkedBy: themeMarkets.createdBy,
        linkedByNickname: profiles.nickname,
        linkedAt: themeMarkets.createdAt,
      })
      .from(themeMarkets)
      .innerJoin(markets, eq(markets.id, themeMarkets.marketId))
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .leftJoin(profiles, eq(profiles.userId, themeMarkets.createdBy))
      .where(eq(themeMarkets.themeId, themeId))
      .orderBy(desc(themeMarkets.createdAt), desc(markets.id));
    return rows.map((row) => ({
      ...toMarketSummary(row.market, row.category),
      linkedBy: { id: row.linkedBy, nickname: row.linkedByNickname },
      linkedAt: row.linkedAt.toISOString(),
    }));
  }
}

function toAdminThemeSummary(row: ThemeRow, now: Date): AdminThemeSummary {
  return {
    ...toThemeSummary(row, now),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    firstPublishedAt: row.firstPublishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAdminNotice(notice: NoticeRow, nickname: string | null): AdminThemeNotice {
  return {
    id: notice.id,
    title: notice.title,
    body: notice.body,
    createdAt: notice.createdAt.toISOString(),
    editedAt: notice.editedAt?.toISOString() ?? null,
    hiddenAt: notice.hiddenAt?.toISOString() ?? null,
    createdBy: { id: notice.createdBy, nickname },
  };
}

/** The named fields of `source`. */
function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, source[key]])) as Pick<T, K>;
}

/** Theme fields as a record writes them: the named ones (every one by default). */
function auditFields(
  fields: ThemeFields,
  keys: readonly (typeof THEME_FIELDS)[number][] = THEME_FIELDS,
): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, fields[key]]));
}

/** The unique slug's violation (`THEME_SLUG_UNIQUE`) as the refusal naming `slug`. */
function slugTaken(cause: unknown): AppError {
  return refusal(THEME_REFUSALS.slugTaken, 'This slug is already taken', cause);
}
