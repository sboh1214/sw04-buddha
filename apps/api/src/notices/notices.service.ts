import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  NOTICE_ACTION_TYPES,
  NOTICE_PIN_LIMIT,
  canonicalJson,
  decodeKeyset,
  decodeTupleCursor,
  encodeKeyset,
  encodeTupleCursor,
  postImageNotUsableMessage,
  type AdminAccountActor,
  type AdminNotice,
  type AdminNoticeAction,
  type AdminNoticeListQuery,
  type AdminNoticeRevision,
  type AdminNoticeRevisionSummary,
  type AdminNoticeSummary,
  type AdminNoticeUpdateResult,
  type CursorQuery,
  type Notice,
  type NoticeActionType,
  type NoticeContent,
  type NoticeEdit,
  type NoticeEditConflictDetails,
  type NoticePinLimitDetails,
  type NoticeSummary,
} from '@buddha/shared';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { PG_UNIQUE_VIOLATION, isPgError } from '../common/errors/pg-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { clockTimestamp, strictlyAfter } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { type Page } from '../wallet/wallet.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** `admin_actions.target_type` of a notice's records. */
const TARGET_TYPE = 'notice';
/** Reads that run either inside a transaction or on the pool. */
type Executor = Db | Tx;

type NoticeRow = typeof schema.notices.$inferSelect;
type AuditType = NoticeActionType;

/** An earlier version and the one before it (null: it is the notice's first). */
interface VersionLink {
  id: number;
  previousId: number | null;
}

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
 * The owner's answers of 2026-10-21 (ADR-0077): only a pinned notice is public (`get` answers any
 * other like a missing one, and MediaService.findShown its images); the admin screens read every
 * notice, its operation records (`adminActions`) and its earlier versions (`adminRevisions`,
 * `adminRevision`), which are kept with no retention period; and an edit names the version it was
 * opened from, refused when another admin saved since (`update`, NOTICE_EDIT_CONFLICT).
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

  /**
   * `GET /notices/:noticeId`: one PINNED notice (owner decision 2026-10-21: «고정하지 않았거나 푼
   * 공지 → 공개 안 함, 주소로도 없는 공지처럼»). NOT_FOUND for a notice never pinned or unpinned, as
   * for an unknown id — the answer does not tell them apart.
   */
  async get(noticeId: string): Promise<Notice> {
    const row = await this.find(this.db, noticeId);
    if (!row || row.pinnedAt === null) throw noticeNotFound();
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

  /** `GET /admin/notices/:noticeId`: one notice as the edit screen loads it, pinned or not. */
  async adminGet(noticeId: string): Promise<AdminNotice> {
    const row = await this.find(this.db, noticeId);
    if (!row) throw noticeNotFound();
    return adminNoticeOf(row);
  }

  /**
   * `GET /admin/notices/:noticeId/actions` (owner decision 2026-10-21: «운영 기록(운영자·시각·동작)»):
   * the notice's records — each write, edit, pin and unpin that changed something, with its admin
   * (id and current nickname) — newest first, keyset pages on `(created_at, id)`. An edit names the
   * version it replaced. An unknown notice has no records: an empty page, as the release settings'
   * changes of a key no record names.
   *
   * The `admin_actions_type_created_at_id_idx` index bounds the read to the notices' records (the
   * four types): operators write them, a few per notice, so no index of its own. Two records of
   * one millisecond — a write and a pin sent at once — keep one order, by id, not their own.
   */
  async adminActions(noticeId: string, query: CursorQuery): Promise<Page<AdminNoticeAction>> {
    const { adminActions, profiles } = schema;
    const keyset = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.db
      .select({
        id: adminActions.id,
        type: adminActions.type,
        adminId: adminActions.adminId,
        nickname: profiles.nickname,
        payload: adminActions.payload,
        createdAt: adminActions.createdAt,
      })
      .from(adminActions)
      // LEFT, as the related markets' `linkedBy`: every account has a profile (trigger 0002), and a
      // missing one must never hide a record from the screen that shows them.
      .leftJoin(profiles, eq(profiles.userId, adminActions.adminId))
      .where(
        and(
          inArray(adminActions.type, [...NOTICE_ACTION_TYPES]),
          eq(adminActions.targetType, TARGET_TYPE),
          eq(adminActions.targetId, noticeId),
          keyset === undefined
            ? undefined
            : keysetPredicate(adminActions.createdAt, adminActions.id, keyset, 'uuid'),
        ),
      )
      .orderBy(desc(adminActions.createdAt), desc(adminActions.id))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => {
        const type = row.type as NoticeActionType;
        return {
          id: row.id,
          type,
          actor: { id: row.adminId, nickname: row.nickname ?? '' },
          createdAt: row.createdAt.toISOString(),
          revisionId: type === 'notice_update' ? revisionIdOf(row.id, row.payload) : null,
        };
      }),
      nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  /**
   * `GET /admin/notices/:noticeId/revisions` (owner decision 2026-10-21: «이전 판을 보임»): the
   * notice's earlier versions, the newest first (their ids grow with each edit, which the notice's
   * row lock serialises), a page of `limit` per cursor — the id of the last one. Each with who
   * wrote it and who replaced it (`versionActors`). An unknown notice has none: an empty page.
   *
   * The row past the page, read anyway to tell whether there is a next one, is the version before
   * the page's oldest: so every version's predecessor is in hand without another read.
   */
  async adminRevisions(
    noticeId: string,
    query: CursorQuery,
  ): Promise<Page<AdminNoticeRevisionSummary>> {
    const { noticeRevisions } = schema;
    const cursor = decodeTupleCursor(query.cursor, [], 'int');
    const rows = await this.db
      .select({
        id: noticeRevisions.id,
        title: noticeRevisions.title,
        writtenAt: noticeRevisions.writtenAt,
        replacedAt: noticeRevisions.replacedAt,
      })
      .from(noticeRevisions)
      .where(
        and(
          eq(noticeRevisions.noticeId, noticeId),
          cursor === undefined ? undefined : lt(noticeRevisions.id, Number(cursor.id)),
        ),
      )
      .orderBy(desc(noticeRevisions.id))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const links = kept.map((row, index) => ({
      id: row.id,
      previousId: rows[index + 1]?.id ?? null,
    }));
    const actors = await this.versionActors(noticeId, links);
    const last = kept.at(-1);
    return {
      items: kept.map((row, index) => ({
        id: row.id,
        title: row.title,
        writtenAt: row.writtenAt.toISOString(),
        replacedAt: row.replacedAt.toISOString(),
        ...actors(links[index]!),
      })),
      nextCursor: hasMore && last ? encodeTupleCursor([], String(last.id)) : null,
    };
  }

  /**
   * `GET /admin/notices/:noticeId/revisions/:revisionId`: one earlier version of this notice, whole,
   * read-only. NOT_FOUND for a version that is not this notice's.
   */
  async adminRevision(noticeId: string, revisionId: number): Promise<AdminNoticeRevision> {
    const { noticeRevisions } = schema;
    const [row] = await this.db
      .select()
      .from(noticeRevisions)
      .where(and(eq(noticeRevisions.noticeId, noticeId), eq(noticeRevisions.id, revisionId)));
    if (!row) throw new AppError('NOT_FOUND', { message: 'Notice version not found' });
    const [previous] = await this.db
      .select({ id: noticeRevisions.id })
      .from(noticeRevisions)
      .where(and(eq(noticeRevisions.noticeId, noticeId), lt(noticeRevisions.id, revisionId)))
      .orderBy(desc(noticeRevisions.id))
      .limit(1);
    const link = { id: row.id, previousId: previous?.id ?? null };
    const actors = await this.versionActors(noticeId, [link]);
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      writtenAt: row.writtenAt.toISOString(),
      replacedAt: row.replacedAt.toISOString(),
      ...actors(link),
    };
  }

  /**
   * Who wrote and who replaced each of `versions`, from the records (`admin_actions`): an edit's
   * record names the version it replaced (`{ revisionId }`), so the admin who replaced version V is
   * the one of the edit naming V, and the admin who wrote it the one of the edit naming the version
   * before it — or of the notice's writing, for its first. One read, of those records only. An
   * operator is null where no record names the version (a row written past the API).
   */
  private async versionActors(
    noticeId: string,
    versions: readonly VersionLink[],
  ): Promise<
    (version: VersionLink) => Pick<AdminNoticeRevisionSummary, 'writtenBy' | 'replacedBy'>
  > {
    const { adminActions, profiles } = schema;
    const named = [
      ...new Set(
        versions.flatMap(({ id, previousId }) => [
          id,
          ...(previousId === null ? [] : [previousId]),
        ]),
      ),
    ];
    const needsCreate = versions.some((version) => version.previousId === null);
    const rows =
      versions.length === 0
        ? []
        : await this.db
            .select({
              id: adminActions.id,
              type: adminActions.type,
              adminId: adminActions.adminId,
              nickname: profiles.nickname,
              payload: adminActions.payload,
            })
            .from(adminActions)
            .leftJoin(profiles, eq(profiles.userId, adminActions.adminId))
            .where(
              and(
                eq(adminActions.targetType, TARGET_TYPE),
                eq(adminActions.targetId, noticeId),
                or(
                  and(
                    eq(adminActions.type, 'notice_update'),
                    inArray(
                      sql`${adminActions.payload} ->> 'revisionId'`,
                      named.map((id) => String(id)),
                    ),
                  ),
                  needsCreate ? eq(adminActions.type, 'notice_create') : undefined,
                ),
              ),
            );
    let created: AdminAccountActor | null = null;
    const replacedBy = new Map<number, AdminAccountActor>();
    for (const row of rows) {
      const actor = { id: row.adminId, nickname: row.nickname ?? '' };
      if (row.type === 'notice_create') created = actor;
      else replacedBy.set(revisionIdOf(row.id, row.payload), actor);
    }
    return ({ id, previousId }) => ({
      writtenBy: previousId === null ? created : (replacedBy.get(previousId) ?? null),
      replacedBy: replacedBy.get(id) ?? null,
    });
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
   * (`changed`). A pinned notice stays pinned where it is. An image the edit takes out stays
   * attached for the history (served to admins only, MediaService.findNoticeImage).
   *
   * The edit names the version its screen was opened from (`expectedEditedAt`, the notice's
   * `editedAt` then): when another admin's save has replaced it since, nothing is written and the
   * answer is NOTICE_EDIT_CONFLICT with the version now (owner decision 2026-10-21: «연 뒤 다른
   * 운영자가 고쳤으면 저장을 막고 '다른 운영자가 먼저 고쳤습니다'»). The row lock makes the check and
   * the write one step: of two saves opened from one version, the second reads the notice only
   * after the first committed and finds its version gone. An edit is stamped strictly after the
   * version it replaces (`strictlyAfter`), so a version's `editedAt` names it alone even should the
   * clock repeat or step back.
   */
  async update(
    adminId: string,
    noticeId: string,
    edit: NoticeEdit,
  ): Promise<AdminNoticeUpdateResult> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockNotice(tx, noticeId);
      const opened =
        edit.expectedEditedAt === null ? null : new Date(edit.expectedEditedAt).getTime();
      if (opened !== (current.editedAt?.getTime() ?? null)) {
        const details: NoticeEditConflictDetails = {
          editedAt: current.editedAt?.toISOString() ?? null,
        };
        throw new AppError('NOTICE_EDIT_CONFLICT', {
          message: 'Another admin edited the notice since this edit was opened',
          details,
        });
      }
      if (
        current.title === edit.title &&
        canonicalJson(current.body) === canonicalJson(edit.body.document)
      ) {
        return { notice: adminNoticeOf(current), changed: false };
      }
      await this.claimImages(tx, adminId, edit.body.imageIds, noticeId);
      const now = strictlyAfter(await clockTimestamp(tx), current.editedAt ?? current.createdAt);
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
          title: edit.title,
          body: edit.body.document,
          bodyText: edit.body.text,
          imageIds: edit.body.imageIds,
          editedAt: now,
        })
        .where(eq(schema.notices.id, noticeId))
        .returning();
      await this.attachImages(tx, noticeId, edit.body.imageIds);
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
   * `POST /admin/notices/:noticeId/unpin`: takes the notice out of the fixed area and out of the
   * public — its address and images answer like a missing notice's (owner decision 2026-10-21) —
   * while it stays on the admin screen and may be pinned again (#45-8). A notice that is not pinned
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
   * thing that makes two saves of one notice take turns, the second seeing the first's version
   * (`update`).
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
      targetType: TARGET_TYPE,
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

/**
 * The version a `notice_update` record names (`{ revisionId }`, as `update` writes it). A record
 * that does not is a broken invariant, not a request's fault: INTERNAL, naming the row.
 */
function revisionIdOf(recordId: string, payload: Record<string, unknown> | null): number {
  const revisionId = payload?.revisionId;
  if (typeof revisionId !== 'number' || !Number.isSafeInteger(revisionId) || revisionId < 1) {
    throw new AppError('INTERNAL', {
      message: `admin_actions ${recordId} is a notice edit naming no version`,
    });
  }
  return revisionId;
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
