import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  NOTICE_PIN_LIMIT,
  canonicalJson,
  decodeKeyset,
  encodeKeyset,
  postImageNotUsableMessage,
  type AdminNotice,
  type AdminNoticeListQuery,
  type AdminNoticeSummary,
  type AdminNoticeUpdateResult,
  type Notice,
  type NoticeContent,
  type NoticePinLimitDetails,
  type NoticeSummary,
} from '@buddha/shared';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { PG_UNIQUE_VIOLATION, isPgError } from '../common/errors/pg-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { clockTimestamp, strictlyAfter } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { type Page } from '../wallet/wallet.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Reads that run either inside a transaction or on the pool. */
type Executor = Db | Tx;

type NoticeRow = typeof schema.notices.$inferSelect;
type AuditType = 'notice_create' | 'notice_update' | 'notice_pin' | 'notice_unpin';

/**
 * Serialises every change of the pinned set: a pin and an unpin take it before the notice's row
 * (in that order, always, so they never deadlock), and a pin then reads the free slots knowing no
 * other pin is choosing among them. Without it two pins racing for the last slot would both see
 * it free, and the second would fail on `notices_pin_slot_unique` — refused rightly when the
 * limit is reached, but also, wrongly, when it raced for a slot while another was free. The
 * two-key form keeps it apart from every single-key advisory lock (markets, admin roles), as the
 * 본인확인's and the nickname's locks are; the second key is the only pinned set there is.
 */
async function lockNoticePins(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('buddha:notice-pins'), 0)`);
}

/**
 * 운영 공지 (#138). Owner decisions (ADR-0069 decision 2 #45-8, decision 4 #138): a required title
 * and a body in the posts' editor (`postDocumentInputSchema` — the same allow-list and limits,
 * links and images); edits show '수정됨' and keep the version they replaced for operators only
 * (`notice_revisions`, as `post_revisions`); pinned only above the community list, at most
 * NOTICE_PIN_LIMIT at a time, never unpinned automatically, and an unpinned notice stays on the
 * admin screen to be pinned again; any admin writes, edits, pins and unpins without a second
 * admin's approval; each of those records its admin and time in `admin_actions` (no reason), in
 * the transaction of the change and only when something changed — as the related markets do
 * (ADR-0068). Public answers name nobody: the web shows every notice as 운영팀's. Notices take
 * no comments, likes or reports, so nothing here reads or writes any.
 *
 * Every notice is readable at its address, pinned or not (`get`) — the owner did not say whether
 * an unpinned one should be; this takes the neutral reading that unpinning takes a notice out of
 * the fixed area only (ADR-0077 decision 8-1, an open question to the owner).
 */
@Injectable()
export class NoticesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * `GET /notices`: the pinned notices, as the community list's fixed area shows them — the latest
   * pinned first. `pin` stamps each pin strictly after the ones in place, so the time alone is the
   * order; the id only keeps one order should a row written past the API share a millisecond. At
   * most NOTICE_PIN_LIMIT, so never a page.
   */
  async listPinned(): Promise<NoticeSummary[]> {
    const { notices } = schema;
    const rows = await this.db
      .select({
        id: notices.id,
        title: notices.title,
        createdAt: notices.createdAt,
        editedAt: notices.editedAt,
      })
      .from(notices)
      .where(isNotNull(notices.pinnedAt))
      .orderBy(desc(notices.pinnedAt), desc(notices.id));
    return rows.map(summaryOf);
  }

  /** `GET /notices/:noticeId`: one notice, pinned or not. NOT_FOUND for an unknown id. */
  async get(noticeId: string): Promise<Notice> {
    const row = await this.find(this.db, noticeId);
    if (!row) throw noticeNotFound();
    return { ...summaryOf(row), body: row.body };
  }

  /**
   * `GET /admin/notices?state=`: `pinned` — what the fixed area shows, in its order (the latest
   * pinned first); `unpinned` — every other notice, the newest written first. Keyset pages on
   * (that time, id); a cursor that does not decode serves the first page.
   */
  async adminList(query: AdminNoticeListQuery): Promise<Page<AdminNoticeSummary>> {
    const { notices } = schema;
    const pinned = query.state === 'pinned';
    const sortColumn = pinned ? notices.pinnedAt : notices.createdAt;
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.db
      .select({
        id: notices.id,
        title: notices.title,
        createdAt: notices.createdAt,
        editedAt: notices.editedAt,
        pinnedAt: notices.pinnedAt,
      })
      .from(notices)
      .where(
        and(
          pinned ? isNotNull(notices.pinnedAt) : isNull(notices.pinnedAt),
          cursor === undefined
            ? undefined
            : keysetPredicate(sortColumn, notices.id, cursor, 'uuid'),
        ),
      )
      .orderBy(desc(sortColumn), desc(notices.id))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => ({
        ...summaryOf(row),
        pinnedAt: row.pinnedAt?.toISOString() ?? null,
      })),
      nextCursor:
        hasMore && last
          ? encodeKeyset({ createdAt: (pinned ? last.pinnedAt : last.createdAt)!, id: last.id })
          : null,
    };
  }

  /** `GET /admin/notices/:noticeId`: one notice as the edit screen loads it. */
  async adminGet(noticeId: string): Promise<AdminNotice> {
    const row = await this.find(this.db, noticeId);
    if (!row) throw noticeNotFound();
    return adminNoticeOf(row);
  }

  /**
   * `POST /admin/notices`: a new notice, not pinned (pinning is its own action and record). Every
   * image must be an upload of the writing admin's that no post or notice has taken
   * (`claimImages`). One `notice_create` record, at the notice's own creation time.
   */
  async create(adminId: string, content: NoticeContent): Promise<AdminNotice> {
    return this.db.transaction(async (tx) => {
      const id = randomUUID();
      await this.claimImages(tx, adminId, content.body.imageIds, id);
      const now = await clockTimestamp(tx);
      const [row] = await tx
        .insert(schema.notices)
        .values({
          id,
          title: content.title,
          body: content.body.document,
          bodyText: content.body.text,
          imageIds: content.body.imageIds,
          createdAt: now,
        })
        .returning();
      await this.attachImages(tx, id, content.body.imageIds);
      await this.audit(tx, adminId, 'notice_create', id, now, null);
      return adminNoticeOf(row!);
    });
  }

  /**
   * `PUT /admin/notices/:noticeId`: any admin replaces the title and the body (#45-8: every admin
   * writes, no approval). The version replaced goes to the operators' history (`notice_revisions`)
   * and the notice is marked edited, with one `notice_update` record naming that version; sending
   * what the notice already says changes, marks and records nothing. The answer says which
   * (`changed`): the screen cannot tell from `editedAt`, since another admin's edit it has not read
   * yet moves that too. A pinned notice stays pinned where it is. An image the edit takes out stays
   * attached for the history and is no longer served (`GET /media/:mediaId` serves the current
   * body's).
   *
   * The row lock is what keeps the history whole when two admins save at once: the second reads
   * the notice only after the first committed, so the version it replaces — and records — is the
   * first one's, never the one both started from. Nothing checks which version the editor opened:
   * the later save wins, the earlier one kept in the history (ADR-0077 decision 8-19, an open
   * question to the owner).
   */
  async update(
    adminId: string,
    noticeId: string,
    content: NoticeContent,
  ): Promise<AdminNoticeUpdateResult> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockNotice(tx, noticeId);
      if (
        current.title === content.title &&
        canonicalJson(current.body) === canonicalJson(content.body.document)
      ) {
        return { notice: adminNoticeOf(current), changed: false };
      }
      await this.claimImages(tx, adminId, content.body.imageIds, noticeId);
      const now = await clockTimestamp(tx);
      const [revision] = await tx
        .insert(schema.noticeRevisions)
        .values({
          noticeId,
          title: current.title,
          body: current.body,
          bodyText: current.bodyText,
          imageIds: current.imageIds,
          writtenAt: current.editedAt ?? current.createdAt,
          replacedAt: now,
        })
        .returning({ id: schema.noticeRevisions.id });
      const [row] = await tx
        .update(schema.notices)
        .set({
          title: content.title,
          body: content.body.document,
          bodyText: content.body.text,
          imageIds: content.body.imageIds,
          editedAt: now,
        })
        .where(eq(schema.notices.id, noticeId))
        .returning();
      await this.attachImages(tx, noticeId, content.body.imageIds);
      await this.audit(tx, adminId, 'notice_update', noticeId, now, {
        revisionId: revision!.id,
      });
      return { notice: adminNoticeOf(row!), changed: true };
    });
  }

  /**
   * `POST /admin/notices/:noticeId/pin`: puts the notice in the fixed area, on top (the latest
   * pinned first), in the lowest free slot. NOTICE_PIN_LIMIT_REACHED when every slot is taken —
   * nothing is unpinned to make room (#45-8). A notice pinned already changes nothing, keeps its
   * place and records nothing.
   *
   * On top means strictly after every pin in place: the clock has millisecond precision, so a pin
   * right behind another (the lock serialises them) can read the same instant, or an earlier one
   * should the clock step back, and the area would then order the two by their random ids. The
   * pin's time is 1 ms after the latest one's when the clock has not passed it (`strictlyAfter`),
   * as role changes and approvals keep their order; its record carries the same instant.
   */
  async pin(adminId: string, noticeId: string): Promise<AdminNotice> {
    return this.db.transaction(async (tx) => {
      await lockNoticePins(tx);
      const current = await this.lockNotice(tx, noticeId);
      if (current.pinnedAt !== null) return adminNoticeOf(current);
      const { notices } = schema;
      const pinned = await tx
        .select({ slot: notices.pinSlot, pinnedAt: notices.pinnedAt })
        .from(notices)
        .where(isNotNull(notices.pinSlot));
      const taken = new Set(pinned.map((row) => row.slot));
      const slot = Array.from({ length: NOTICE_PIN_LIMIT }, (_, index) => index + 1).find(
        (candidate) => !taken.has(candidate),
      );
      if (slot === undefined) {
        const details: NoticePinLimitDetails = { limit: NOTICE_PIN_LIMIT };
        throw new AppError('NOTICE_PIN_LIMIT_REACHED', {
          message: `At most ${String(NOTICE_PIN_LIMIT)} notices are pinned at a time`,
          details,
        });
      }
      const latest = pinned.reduce<Date | null>(
        (max, row) =>
          row.pinnedAt !== null && (max === null || row.pinnedAt > max) ? row.pinnedAt : max,
        null,
      );
      const now = strictlyAfter(await clockTimestamp(tx), latest);
      const [row] = await tx
        .update(notices)
        .set({ pinnedAt: now, pinSlot: slot })
        .where(eq(notices.id, noticeId))
        .returning();
      await this.audit(tx, adminId, 'notice_pin', noticeId, now, null);
      return adminNoticeOf(row!);
    });
  }

  /**
   * `POST /admin/notices/:noticeId/unpin`: takes the notice out of the fixed area; it stays on the
   * admin screen and at its address, and may be pinned again (#45-8). A notice that is not pinned
   * changes nothing and records nothing.
   */
  async unpin(adminId: string, noticeId: string): Promise<AdminNotice> {
    return this.db.transaction(async (tx) => {
      await lockNoticePins(tx);
      const current = await this.lockNotice(tx, noticeId);
      if (current.pinnedAt === null) return adminNoticeOf(current);
      const now = await clockTimestamp(tx);
      const [row] = await tx
        .update(schema.notices)
        .set({ pinnedAt: null, pinSlot: null })
        .where(eq(schema.notices.id, noticeId))
        .returning();
      await this.audit(tx, adminId, 'notice_unpin', noticeId, now, null);
      return adminNoticeOf(row!);
    });
  }

  private async find(executor: Executor, noticeId: string): Promise<NoticeRow | undefined> {
    const [row] = await executor
      .select()
      .from(schema.notices)
      .where(eq(schema.notices.id, noticeId))
      .limit(1);
    return row;
  }

  /**
   * The notice, locked for the write: NOT_FOUND when there is none. A pin and an unpin hold the
   * pinned set's lock first, so for them it only orders what follows; for an edit it is the one
   * thing that makes two saves of one notice take turns (`update`).
   */
  private async lockNotice(tx: Tx, noticeId: string): Promise<NoticeRow> {
    const [row] = await tx
      .select()
      .from(schema.notices)
      .where(eq(schema.notices.id, noticeId))
      .for('update');
    if (!row) throw noticeNotFound();
    return row;
  }

  /**
   * The body's images, locked against the orphan clean-up (which skips locked rows) and against a
   * post or another notice taking the same upload — PostsService locks the same rows the same way
   * first, so the two never both take one. Each must be an upload for a body (`post_image`, the
   * one kind the editor uploads) that no post holds and that is either this notice's already — an
   * edit keeps an image whichever admin uploaded it — or the writing admin's own, taken by no
   * other notice. Refused as a VALIDATION_ERROR naming `body`, one issue per image, with the
   * posts' message (`postImageNotUsableMessage`), which the editor already reads.
   *
   * Two statements, for the posts' reason (PostsService.claimImages): the lock first, in id
   * order, then a read with a new snapshot that sees what a write it waited for committed.
   */
  private async claimImages(
    tx: Tx,
    adminId: string,
    imageIds: readonly string[],
    noticeId: string,
  ): Promise<void> {
    if (imageIds.length === 0) return;
    const { mediaObjects, noticeImages, postImages } = schema;
    const ids = [...imageIds];
    await tx
      .select({ id: mediaObjects.id })
      .from(mediaObjects)
      .where(inArray(mediaObjects.id, ids))
      .orderBy(mediaObjects.id)
      .for('update');
    const rows = await tx
      .select({
        id: mediaObjects.id,
        ownerId: mediaObjects.ownerId,
        kind: mediaObjects.kind,
        postId: postImages.postId,
        noticeId: noticeImages.noticeId,
      })
      .from(mediaObjects)
      .leftJoin(postImages, eq(postImages.mediaId, mediaObjects.id))
      .leftJoin(noticeImages, eq(noticeImages.mediaId, mediaObjects.id))
      .where(inArray(mediaObjects.id, ids));
    const usable = new Set(
      rows
        .filter(
          (row) =>
            row.kind === 'post_image' &&
            row.postId === null &&
            (row.noticeId === noticeId || (row.noticeId === null && row.ownerId === adminId)),
        )
        .map((row) => row.id),
    );
    const refused = imageIds.filter((id) => !usable.has(id));
    if (refused.length > 0) throw imagesNotUsable(refused);
  }

  /**
   * Records the notice's images as its own (the first use stamps the upload's `attached_at`, so
   * the orphan clean-up never takes it). An image the notice already has is left as it is; one
   * another notice holds is `notice_images_media_id_unique`, which `claimImages` refused under its
   * lock and which is refused the same way here should it ever get past.
   */
  private async attachImages(tx: Tx, noticeId: string, imageIds: readonly string[]): Promise<void> {
    if (imageIds.length === 0) return;
    const { mediaObjects, noticeImages } = schema;
    try {
      await tx
        .insert(noticeImages)
        .values(imageIds.map((mediaId) => ({ noticeId, mediaId })))
        .onConflictDoNothing({ target: [noticeImages.noticeId, noticeImages.mediaId] });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION, 'notice_images_media_id_unique')) {
        throw imagesNotUsable(imageIds);
      }
      throw error;
    }
    await tx
      .update(mediaObjects)
      .set({ attachedAt: sql`now()` })
      .where(and(inArray(mediaObjects.id, [...imageIds]), isNull(mediaObjects.attachedAt)));
  }

  /**
   * The audit row of a change (#138: the admin and the time, no reason), at the instant the
   * change wrote, so the record and the notice agree to the millisecond.
   */
  private async audit(
    tx: Tx,
    adminId: string,
    type: AuditType,
    noticeId: string,
    now: Date,
    payload: Record<string, unknown> | null,
  ): Promise<void> {
    await tx.insert(schema.adminActions).values({
      adminId,
      type,
      targetType: 'notice',
      targetId: noticeId,
      payload,
      createdAt: now,
    });
  }
}

/** The public card of a notice. */
function summaryOf(row: {
  id: string;
  title: string;
  createdAt: Date;
  editedAt: Date | null;
}): NoticeSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
  };
}

/** A notice as the admin screen edits it, and as every admin write answers. */
function adminNoticeOf(row: NoticeRow): AdminNotice {
  return { ...summaryOf(row), body: row.body, pinnedAt: row.pinnedAt?.toISOString() ?? null };
}

function noticeNotFound(): AppError {
  return new AppError('NOT_FOUND', { message: 'Notice not found' });
}

/** The images a write cannot use, as the refusal names them (one issue each, under `body`). */
function imagesNotUsable(mediaIds: readonly string[]): AppError {
  return new AppError('VALIDATION_ERROR', {
    message: 'An image is not an upload of this account that no post or other notice has taken',
    details: mediaIds.map((id) => ({ path: ['body'], message: postImageNotUsableMessage(id) })),
  });
}
