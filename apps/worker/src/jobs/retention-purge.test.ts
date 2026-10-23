/**
 * `retention.purge` (#184, ADR-0087) on the docker `test` database: for each data kind, what is
 * deleted once its period has passed and what stays — the base times (the withdrawal for a
 * withdrawn account's records, the deletion for what a live account deleted, the replacement for an
 * earlier version, the later of the withdrawal and the processing for a processed record), the
 * boundary (a record exactly its period old is due), the records still being processed or still
 * named, a period that is not approved (nothing deleted, nothing recorded), the nickname holds' fixed
 * 30 days, the purge records (kind, count, period, run instant — per batch, or one 0), and that the
 * ledger, the watch events, likes, posts not deleted and the other operational records are never
 * touched. The release settings are changed the way the admin screen changes them (a row and its
 * record); the run's instant is moved past a period instead of backdating a closure (a closed
 * profile never changes, migration 0041). Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  closeAccount,
  connectTestDb,
  createApprovalRequest,
  createComment,
  createCommentLike,
  createConsents,
  createMarket,
  createMedia,
  createModerationAction,
  createPost,
  createPostLike,
  createProfileImage,
  createReport,
  createUser,
  createWatch,
  hasTestDb,
  randomPhone,
  setReleaseSetting,
  type TestDb,
} from '@buddha/db/test';
import {
  CONSENT_RECORDS_RETENTION_SETTING,
  DELETED_POSTS_RETENTION_SETTING,
  MODERATION_RECORDS_RETENTION_SETTING,
  PHONE_VERIFICATION_RECORDS_RETENTION_SETTING,
  REMOVED_PROFILE_ITEMS_RETENTION_SETTING,
  RETENTION_PURGE_KINDS,
  type ReleaseSettingDefinition,
  type ReleaseSettingStatus,
  type RetentionPurgeKind,
} from '@buddha/shared';
import { MemoryObjectStorage } from '@buddha/storage';
import { randomUUID } from 'node:crypto';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { purgeExpiredRecords } from './retention-purge.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const after = (at: Date, days: number, ms = 0) => new Date(at.getTime() + days * DAY_MS + ms);
const before = (at: Date, days: number) => new Date(at.getTime() - days * DAY_MS);

describe.skipIf(!hasTestDb())('retention.purge (integration)', () => {
  let t: TestDb;
  let storage: MemoryObjectStorage;
  let admin: string;
  let otherAdmin: string;
  let marketId: string;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    storage = new MemoryObjectStorage();
    admin = (await createUser(t.db, { role: 'admin' })).user.id;
    otherAdmin = (await createUser(t.db, { role: 'admin' })).user.id;
    marketId = (await createMarket(t.db, { createdBy: admin })).id;
  });

  const setPeriod = (
    definition: ReleaseSettingDefinition<number>,
    days: number | null,
    status: ReleaseSettingStatus = 'approved',
  ) =>
    setReleaseSetting(t.db, {
      adminId: admin,
      key: definition.key,
      status: days === null ? 'undecided' : status,
      value: days,
    });

  /**
   * A run at `now`, which no kind may fail: a step that selects what a foreign key still names (a
   * RESTRICT) rolls its batch back into `kindFailures` and deletes nothing, which a test of what
   * stays would otherwise read as kept on purpose.
   */
  async function run(now: Date, batch?: number) {
    const outcome = await purgeExpiredRecords(t.db, storage, {
      now,
      ...(batch === undefined ? {} : { batch }),
    });
    expect(outcome.kindFailures.map(({ kind, message }) => `${kind}: ${message}`)).toEqual([]);
    return outcome;
  }

  async function dbNow(): Promise<Date> {
    const { rows } = await t.db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
    return new Date(rows[0]!.now);
  }

  async function purgeRecords() {
    return t.db
      .select({
        kind: schema.retentionPurges.kind,
        count: schema.retentionPurges.count,
        periodDays: schema.retentionPurges.periodDays,
        ranAt: schema.retentionPurges.ranAt,
      })
      .from(schema.retentionPurges)
      .orderBy(asc(schema.retentionPurges.id));
  }

  /** The counts a run recorded by kind (summed over its batches), without the holds. */
  async function countsAt(ranAt: Date): Promise<Partial<Record<RetentionPurgeKind, number>>> {
    const counts: Partial<Record<RetentionPurgeKind, number>> = {};
    for (const row of await purgeRecords()) {
      if (row.ranAt.getTime() !== ranAt.getTime() || row.kind === 'nickname_holds') continue;
      const kind = row.kind as RetentionPurgeKind;
      counts[kind] = (counts[kind] ?? 0) + row.count;
    }
    return counts;
  }

  /** A 본인확인 code send of `userId`'s, as the API writes one (ADR-0070). */
  async function codeSend(userId: string) {
    const [row] = await t.db
      .insert(schema.phoneVerificationCodes)
      .values({
        id: randomUUID(),
        userId,
        phone: randomPhone(),
        realName: '홍길동',
        codeHash: 'a'.repeat(64),
        expiresAt: sql`now() + interval '3 minutes'`,
        clientIp: '203.0.113.7',
      })
      .returning();
    return row!;
  }

  /** An upload with its object in the store, attached by `createPost`. */
  async function image(ownerId: string) {
    const media = await createMedia(t.db, { ownerId });
    await storage.put(media.storageKey, new Uint8Array([1, 2, 3]), media.contentType);
    return media;
  }

  /** An earlier version of a post, replaced at `replacedAt`, showing `imageIds`. */
  async function postRevision(postId: string, replacedAt: Date, imageIds: string[] = []) {
    const [row] = await t.db
      .insert(schema.postRevisions)
      .values({
        postId,
        title: '이전 제목',
        body: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '이전 본문' }] },
            ...imageIds.map((mediaId) => ({ type: 'image' as const, attrs: { mediaId } })),
          ],
        },
        bodyText: '이전 본문',
        imageIds,
        writtenAt: before(replacedAt, 1),
        replacedAt,
      })
      .returning();
    return row!;
  }

  async function commentRevision(commentId: string, replacedAt: Date) {
    const [row] = await t.db
      .insert(schema.postCommentRevisions)
      .values({ commentId, body: '이전 댓글', writtenAt: before(replacedAt, 1), replacedAt })
      .returning();
    return row!;
  }

  const postOf = async (id: string) =>
    (await t.db.select().from(schema.posts).where(eq(schema.posts.id, id)))[0]!;
  const commentOf = async (id: string) =>
    (await t.db.select().from(schema.postComments).where(eq(schema.postComments.id, id)))[0]!;
  const mediaIds = async () =>
    (await t.db.select({ id: schema.mediaObjects.id }).from(schema.mediaObjects)).map(
      (row) => row.id,
    );

  it('deletes nothing while a period is undecided, a design proposal or a test value, and records nothing for it', async () => {
    const { user } = await createUser(t.db);
    const other = (await createUser(t.db)).user.id;
    await createConsents(t.db, { userId: user.id });
    await codeSend(user.id);
    const post = await createPost(t.db, { marketId, authorId: user.id, deletedAt: new Date() });
    const comment = await createComment(t.db, {
      postId: (await createPost(t.db, { marketId, authorId: other })).id,
      authorId: user.id,
      deletedAt: new Date(),
    });
    await postRevision(post.id, before(new Date(), 1));
    await commentRevision(comment.id, before(new Date(), 1));
    await createReport(t.db, {
      reporterId: user.id,
      reportedUserId: other,
      status: 'dismissed',
      resolvedAt: new Date(),
      resolvedBy: admin,
      dismissalReason: '기각',
    });
    await createModerationAction(t.db, { userId: user.id, createdBy: admin });
    await createModerationAction(t.db, { userId: user.id, createdBy: admin, type: 'bio_clear' });
    await createApprovalRequest(t.db, {
      kind: 'account_restriction',
      targetType: 'user',
      targetId: user.id,
      requestedBy: admin,
      decision: { status: 'rejected', by: otherAdmin },
    });
    const closedAt = await closeAccount(t.db, user.id);
    await setPeriod(CONSENT_RECORDS_RETENTION_SETTING, 1, 'test');
    await setPeriod(PHONE_VERIFICATION_RECORDS_RETENTION_SETTING, 1, 'proposal');
    await setPeriod(MODERATION_RECORDS_RETENTION_SETTING, 1, 'test');
    // A value set and then taken back to undecided; the other two never had one (no row).
    await setPeriod(DELETED_POSTS_RETENTION_SETTING, 1, 'approved');
    await setPeriod(DELETED_POSTS_RETENTION_SETTING, null);

    const now = after(closedAt, 3_650);
    const outcome = await run(now);

    expect(await t.db.select().from(schema.consentRecords)).toHaveLength(4);
    expect(await t.db.select().from(schema.phoneVerificationCodes)).toHaveLength(1);
    expect((await postOf(post.id)).purgedAt).toBeNull();
    expect((await commentOf(comment.id)).purgedAt).toBeNull();
    expect(await t.db.select().from(schema.postRevisions)).toHaveLength(1);
    expect(await t.db.select().from(schema.postCommentRevisions)).toHaveLength(1);
    expect(await t.db.select().from(schema.reports)).toHaveLength(1);
    expect(await t.db.select().from(schema.moderationActions)).toHaveLength(2);
    expect(await t.db.select().from(schema.profileItemRemovals)).toHaveLength(1);
    expect(await t.db.select().from(schema.approvalRequests)).toHaveLength(1);
    const byKind = Object.fromEntries(outcome.kinds.map((kind) => [kind.kind, kind]));
    expect(byKind.consent_records).toEqual({
      kind: 'consent_records',
      status: 'test',
      periodDays: null,
      deleted: 0,
    });
    expect(byKind.phone_verification_records).toMatchObject({ status: 'proposal', deleted: 0 });
    expect(byKind.reports).toMatchObject({ status: 'test', periodDays: null, deleted: 0 });
    expect(byKind.deleted_posts).toMatchObject({ status: 'undecided', periodDays: null });
    expect(byKind.removed_profile_items).toMatchObject({ status: 'undecided', periodDays: null });
    // Only the nickname holds' fixed 30 days applied: the closure's hold of the nickname is over.
    expect(await purgeRecords()).toEqual([
      { kind: 'nickname_holds', count: 1, periodDays: 30, ranAt: now },
    ]);
    expect(outcome.kinds.map((kind) => kind.kind)).toEqual([...RETENTION_PURGE_KINDS]);
  });

  it('deletes a withdrawn account’s consent records once the period has passed since the withdrawal, never a live account’s', async () => {
    const closing = (await createUser(t.db)).user.id;
    const live = (await createUser(t.db)).user.id;
    await createConsents(t.db, { userId: closing });
    await createConsents(t.db, { userId: live });
    const closedAt = await closeAccount(t.db, closing);
    await setPeriod(CONSENT_RECORDS_RETENTION_SETTING, 30);

    // A millisecond short of 30 days: kept, and the run says it looked (0).
    const early = after(closedAt, 30, -1);
    await run(early);
    expect(await t.db.select().from(schema.consentRecords)).toHaveLength(8);
    expect(await countsAt(early)).toEqual({ consent_records: 0 });

    // Exactly 30 days: due.
    const due = after(closedAt, 30);
    const outcome = await run(due);
    const left = await t.db.select().from(schema.consentRecords);
    expect(left.map((row) => row.userId)).toEqual([live, live, live, live]);
    expect(await countsAt(due)).toEqual({ consent_records: 4 });
    expect(outcome.kinds.find((kind) => kind.kind === 'consent_records')).toEqual({
      kind: 'consent_records',
      status: 'approved',
      periodDays: 30,
      deleted: 4,
    });
    const recorded = (await purgeRecords()).filter((row) => row.kind === 'consent_records');
    expect(recorded.at(-1)).toEqual({
      kind: 'consent_records',
      count: 4,
      periodDays: 30,
      ranAt: due,
    });
  });

  it('deletes a withdrawn account’s 본인확인 records (number, name, address) after the period since the withdrawal; a live account keeps them', async () => {
    const closing = (await createUser(t.db)).user.id;
    const live = (await createUser(t.db)).user.id;
    await codeSend(closing);
    await codeSend(closing);
    const kept = await codeSend(live);
    const closedAt = await closeAccount(t.db, closing);
    await setPeriod(PHONE_VERIFICATION_RECORDS_RETENTION_SETTING, 365);

    await run(after(closedAt, 365, -1));
    expect(await t.db.select().from(schema.phoneVerificationCodes)).toHaveLength(3);
    const due = after(closedAt, 365);
    await run(due);
    expect((await t.db.select().from(schema.phoneVerificationCodes)).map((row) => row.id)).toEqual([
      kept.id,
    ]);
    expect(await countsAt(due)).toEqual({ phone_verification_records: 2 });
  });

  it('empties a live author’s deleted post after the period since the deletion, with the images it alone used; a post not deleted stays whatever its age', async () => {
    const author = (await createUser(t.db)).user.id;
    const deletedAt = before(new Date(), 100);
    const picture = await image(author);
    const post = await createPost(t.db, {
      marketId,
      authorId: author,
      title: '지운 글',
      imageIds: [picture.id],
      createdAt: before(deletedAt, 1),
      deletedAt,
    });
    const old = await createPost(t.db, {
      marketId,
      authorId: author,
      title: '오래된 글',
      createdAt: before(deletedAt, 300),
    });
    const hidden = await createPost(t.db, {
      marketId,
      authorId: author,
      createdAt: before(deletedAt, 300),
      hiddenAt: before(deletedAt, 200),
    });
    await setPeriod(DELETED_POSTS_RETENTION_SETTING, 10);

    await run(after(deletedAt, 10, -1));
    expect((await postOf(post.id)).purgedAt).toBeNull();
    expect((await postOf(post.id)).title).toBe('지운 글');

    const due = after(deletedAt, 10);
    await run(due);
    const emptied = await postOf(post.id);
    expect(emptied).toMatchObject({
      title: null,
      body: { type: 'doc', content: [] },
      bodyText: '',
      imageIds: [],
      purgedAt: due,
      deletedAt,
    });
    expect(await mediaIds()).toEqual([]);
    expect(storage.objects.has(picture.storageKey)).toBe(false);
    expect(await t.db.select().from(schema.postImages)).toEqual([]);
    expect(await postOf(old.id)).toMatchObject({ title: '오래된 글', purgedAt: null });
    expect(await postOf(hidden.id)).toMatchObject({ purgedAt: null });
    expect(await countsAt(due)).toMatchObject({ deleted_posts: 1, deleted_comments: 0 });

    // An emptied original stays emptied (migration 0042).
    await expect(
      t.db.update(schema.posts).set({ purgedAt: null }).where(eq(schema.posts.id, post.id)),
    ).rejects.toThrow();
  });

  it('counts a withdrawn author’s deleted post from the withdrawal, and keeps one a pending report is about until it is processed', async () => {
    const author = (await createUser(t.db)).user.id;
    const reporter = (await createUser(t.db)).user.id;
    const deletedAt = before(new Date(), 400);
    const post = await createPost(t.db, { marketId, authorId: author, deletedAt });
    const reported = await createPost(t.db, { marketId, authorId: author, deletedAt });
    const report = await createReport(t.db, {
      reporterId: reporter,
      reportedUserId: author,
      postId: reported.id,
    });
    const closedAt = await closeAccount(t.db, author);
    await setPeriod(DELETED_POSTS_RETENTION_SETTING, 10);

    // 400 days since the deletion, but not 10 since the withdrawal.
    await run(after(closedAt, 10, -1));
    expect((await postOf(post.id)).purgedAt).toBeNull();
    const due = after(closedAt, 10);
    await run(due);
    expect((await postOf(post.id)).purgedAt).toEqual(due);
    expect((await postOf(reported.id)).purgedAt).toBeNull();

    await t.db
      .update(schema.reports)
      .set({
        status: 'dismissed',
        resolvedAt: new Date(),
        resolvedBy: admin,
        dismissalReason: '기각',
      })
      .where(eq(schema.reports.id, report.id));
    const later = after(closedAt, 11);
    await run(later);
    expect((await postOf(reported.id)).purgedAt).toEqual(later);
  });

  it('empties deleted comments in place: a deleted 댓글 keeps its row under its live 대댓글', async () => {
    const author = (await createUser(t.db)).user.id;
    const replier = (await createUser(t.db)).user.id;
    const post = await createPost(t.db, { marketId, authorId: author });
    const deletedAt = before(new Date(), 50);
    const thread = await createComment(t.db, {
      postId: post.id,
      authorId: author,
      body: '지운 댓글',
      deletedAt,
    });
    const reply = await createComment(t.db, {
      postId: post.id,
      authorId: replier,
      parentId: thread.id,
      body: '살아 있는 대댓글',
    });
    await createCommentLike(t.db, { commentId: thread.id, userId: replier });
    const live = await createComment(t.db, { postId: post.id, authorId: author, body: '그대로' });
    await setPeriod(DELETED_POSTS_RETENTION_SETTING, 30);

    // A millisecond short of 30 days since the deletion: kept, and the run says it looked (0).
    const early = after(deletedAt, 30, -1);
    await run(early);
    expect(await commentOf(thread.id)).toMatchObject({ body: '지운 댓글', purgedAt: null });
    expect(await countsAt(early)).toMatchObject({ deleted_comments: 0 });

    const due = after(deletedAt, 30);
    await run(due);
    expect(await commentOf(thread.id)).toMatchObject({ body: '', purgedAt: due, deletedAt });
    expect(await commentOf(reply.id)).toMatchObject({ body: '살아 있는 대댓글', purgedAt: null });
    expect(await commentOf(live.id)).toMatchObject({ body: '그대로', purgedAt: null });
    expect(await t.db.select().from(schema.commentLikes)).toHaveLength(1);
    expect(await countsAt(due)).toMatchObject({ deleted_comments: 1 });

    // The next run passes over what is emptied already: emptying it again would move `purged_at`,
    // which migration 0042 refuses — the kind would fail every day.
    const later = after(due, 1);
    await run(later);
    expect(await commentOf(thread.id)).toMatchObject({ body: '', purgedAt: due });
    expect(await countsAt(later)).toMatchObject({ deleted_comments: 0 });
  });

  it('counts a withdrawn author’s deleted comment from the withdrawal', async () => {
    const author = (await createUser(t.db)).user.id;
    const post = await createPost(t.db, {
      marketId,
      authorId: (await createUser(t.db)).user.id,
    });
    const comment = await createComment(t.db, {
      postId: post.id,
      authorId: author,
      body: '오래전에 지운 댓글',
      deletedAt: before(new Date(), 400),
    });
    const closedAt = await closeAccount(t.db, author);
    await setPeriod(DELETED_POSTS_RETENTION_SETTING, 10);

    // 400 days since the deletion, but not 10 since the withdrawal.
    const early = after(closedAt, 10, -1);
    await run(early);
    expect(await commentOf(comment.id)).toMatchObject({
      body: '오래전에 지운 댓글',
      purgedAt: null,
    });
    expect(await countsAt(early)).toMatchObject({ deleted_comments: 0 });
    const due = after(closedAt, 10);
    await run(due);
    expect(await commentOf(comment.id)).toMatchObject({ body: '', purgedAt: due });
    expect(await countsAt(due)).toMatchObject({ deleted_comments: 1 });
  });

  it('keeps a deleted comment, and a comment’s earlier versions, while a report about the comment waits, and empties them once it is processed', async () => {
    const author = (await createUser(t.db)).user.id;
    const reporter = (await createUser(t.db)).user.id;
    const post = await createPost(t.db, { marketId, authorId: author });
    const deletedAt = before(new Date(), 50);
    const reported = await createComment(t.db, {
      postId: post.id,
      authorId: author,
      body: '신고된 지운 댓글',
      deletedAt,
    });
    const unreported = await createComment(t.db, {
      postId: post.id,
      authorId: author,
      body: '신고 없는 지운 댓글',
      deletedAt,
    });
    const edited = await createComment(t.db, { postId: post.id, authorId: author });
    const editedRevision = await commentRevision(edited.id, deletedAt);
    const plain = await createComment(t.db, { postId: post.id, authorId: author });
    await commentRevision(plain.id, deletedAt);
    const reports = [
      await createReport(t.db, {
        reporterId: reporter,
        reportedUserId: author,
        commentId: reported.id,
      }),
      await createReport(t.db, {
        reporterId: reporter,
        reportedUserId: author,
        commentId: edited.id,
      }),
    ];
    await setPeriod(DELETED_POSTS_RETENTION_SETTING, 30);

    const due = after(deletedAt, 30);
    await run(due);
    expect(await commentOf(reported.id)).toMatchObject({
      body: '신고된 지운 댓글',
      purgedAt: null,
    });
    expect(await commentOf(unreported.id)).toMatchObject({ body: '', purgedAt: due });
    expect((await t.db.select().from(schema.postCommentRevisions)).map((row) => row.id)).toEqual([
      editedRevision.id,
    ]);
    expect(await countsAt(due)).toMatchObject({ deleted_comments: 1, comment_revisions: 1 });

    await t.db
      .update(schema.reports)
      .set({
        status: 'dismissed',
        resolvedAt: new Date(),
        resolvedBy: admin,
        dismissalReason: '기각',
      })
      .where(
        inArray(
          schema.reports.id,
          reports.map((report) => report.id),
        ),
      );
    const later = after(due, 1);
    await run(later);
    expect(await commentOf(reported.id)).toMatchObject({ body: '', purgedAt: later });
    expect(await t.db.select().from(schema.postCommentRevisions)).toEqual([]);
    expect(await countsAt(later)).toMatchObject({ deleted_comments: 1, comment_revisions: 1 });
  });

  it('deletes earlier versions after the period since they were replaced, whatever became of the author, with the images only they used', async () => {
    const author = (await createUser(t.db)).user.id;
    const reporter = (await createUser(t.db)).user.id;
    const kept = await image(author);
    const replacedOnly = await image(author);
    const post = await createPost(t.db, { marketId, authorId: author, imageIds: [kept.id] });
    // The earlier version showed both; its replacement shows only `kept`. createPost attached only
    // what the current body shows, so attach the other the way the first version did.
    await t.db.insert(schema.postImages).values({ postId: post.id, mediaId: replacedOnly.id });
    const replacedAt = before(new Date(), 20);
    const revision = await postRevision(post.id, replacedAt, [kept.id, replacedOnly.id]);
    // A later version, still within the period, showed `replacedOnly` too: it keeps the image.
    const newer = await postRevision(post.id, before(new Date(), 1), [replacedOnly.id]);
    const comment = await createComment(t.db, { postId: post.id, authorId: author });
    const commentRevisionRow = await commentRevision(comment.id, replacedAt);
    // A reported post's versions wait for the report.
    const reportedPost = await createPost(t.db, { marketId, authorId: author });
    const reportedRevision = await postRevision(reportedPost.id, replacedAt);
    await createReport(t.db, {
      reporterId: reporter,
      reportedUserId: author,
      postId: reportedPost.id,
    });
    // The author's withdrawal does not move a version's period (ADR-0069 decision 7).
    await closeAccount(t.db, author);
    await setPeriod(DELETED_POSTS_RETENTION_SETTING, 7);

    await run(after(replacedAt, 7, -1));
    expect(await t.db.select().from(schema.postRevisions)).toHaveLength(3);
    const due = after(replacedAt, 7);
    await run(due);
    const left = (await t.db.select().from(schema.postRevisions)).map((row) => row.id).sort();
    expect(left).toEqual([newer.id, reportedRevision.id].sort());
    expect(left).not.toContain(revision.id);
    expect(
      (await t.db.select().from(schema.postCommentRevisions)).map((row) => row.id),
    ).not.toContain(commentRevisionRow.id);
    // The image the deleted version showed stays while `newer` shows it.
    expect((await mediaIds()).sort()).toEqual([kept.id, replacedOnly.id].sort());
    expect(
      (await t.db.select().from(schema.postImages).where(eq(schema.postImages.postId, post.id)))
        .map((row) => row.mediaId)
        .sort(),
    ).toEqual([kept.id, replacedOnly.id].sort());
    expect(storage.objects.has(replacedOnly.storageKey)).toBe(true);
    expect(storage.objects.has(kept.storageKey)).toBe(true);
    expect(await countsAt(due)).toMatchObject({ post_revisions: 1, comment_revisions: 1 });

    // Once `newer`'s own period has passed, it goes and the image only versions showed with it.
    const newerDue = after(newer.replacedAt, 7);
    await run(newerDue);
    expect((await t.db.select().from(schema.postRevisions)).map((row) => row.id)).toEqual([
      reportedRevision.id,
    ]);
    expect(await mediaIds()).toEqual([kept.id]);
    expect(
      (
        await t.db.select().from(schema.postImages).where(eq(schema.postImages.postId, post.id))
      ).map((row) => row.mediaId),
    ).toEqual([kept.id]);
    expect(storage.objects.has(replacedOnly.storageKey)).toBe(false);
    expect(storage.objects.has(kept.storageKey)).toBe(true);
    expect(await countsAt(newerDue)).toMatchObject({ post_revisions: 1 });
  });

  it('deletes the reports a withdrawn account sent once processed, from the later of the withdrawal and the processing; pending and live reporters’ reports stay', async () => {
    const reporter = (await createUser(t.db)).user.id;
    const liveReporter = (await createUser(t.db)).user.id;
    const member = (await createUser(t.db)).user.id;
    // Processed well before the withdrawal: counted from the withdrawal all the same.
    const processed = await createReport(t.db, {
      reporterId: reporter,
      reportedUserId: member,
      status: 'dismissed',
      createdAt: before(new Date(), 41),
      resolvedAt: before(new Date(), 40),
      resolvedBy: admin,
      dismissalReason: '기각',
    });
    const pending = await createReport(t.db, {
      reporterId: reporter,
      reportedUserId: member,
      postId: (await createPost(t.db, { marketId, authorId: member })).id,
    });
    const livesOwn = await createReport(t.db, {
      reporterId: liveReporter,
      reportedUserId: member,
      status: 'dismissed',
      resolvedAt: new Date(),
      resolvedBy: admin,
      dismissalReason: '기각',
    });
    const closedAt = await closeAccount(t.db, reporter);
    // Processed after the withdrawal (decision 7: the later of the two).
    const resolvedLater = after(closedAt, 5);
    await t.db
      .update(schema.reports)
      .set({
        status: 'dismissed',
        resolvedAt: resolvedLater,
        resolvedBy: admin,
        dismissalReason: '기각',
      })
      .where(eq(schema.reports.id, pending.id));
    await setPeriod(MODERATION_RECORDS_RETENTION_SETTING, 30);

    // 40 days since its processing, but a millisecond short of 30 since the withdrawal: kept.
    const early = after(closedAt, 30, -1);
    await run(early);
    expect((await t.db.select().from(schema.reports)).map((row) => row.id).sort()).toEqual(
      [processed.id, pending.id, livesOwn.id].sort(),
    );
    expect(await countsAt(early)).toMatchObject({ reports: 0 });

    const first = after(closedAt, 30);
    await run(first);
    const left = (await t.db.select().from(schema.reports)).map((row) => row.id).sort();
    expect(left).toEqual([pending.id, livesOwn.id].sort());
    expect(left).not.toContain(processed.id);
    const second = after(resolvedLater, 30);
    await run(second);
    expect((await t.db.select().from(schema.reports)).map((row) => row.id)).toEqual([livesOwn.id]);
    expect(await countsAt(first)).toMatchObject({ reports: 1 });
    expect(await countsAt(second)).toMatchObject({ reports: 1 });
  });

  it('keeps a pending report of a withdrawn account however long', async () => {
    const reporter = (await createUser(t.db)).user.id;
    const member = (await createUser(t.db)).user.id;
    const pending = await createReport(t.db, { reporterId: reporter, reportedUserId: member });
    const closedAt = await closeAccount(t.db, reporter);
    await setPeriod(MODERATION_RECORDS_RETENTION_SETTING, 1);
    await run(after(closedAt, 3_650));
    expect((await t.db.select().from(schema.reports)).map((row) => row.id)).toEqual([pending.id]);
  });

  it('deletes the actions on a withdrawn member with their end changes and approvals, keeping what is in force or still named', async () => {
    const member = (await createUser(t.db)).user.id;
    const liveReporter = (await createUser(t.db)).user.id;
    const liveMember = (await createUser(t.db)).user.id;
    const post = await createPost(t.db, { marketId, authorId: member });
    const hiddenPost = await createPost(t.db, { marketId, authorId: member, hiddenAt: new Date() });
    const warning = await createModerationAction(t.db, { userId: member, createdBy: admin });
    const cancelledHide = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      postId: post.id,
      cancelled: { at: new Date(), by: admin, reason: '취소' },
    });
    const standingHide = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      postId: hiddenPost.id,
    });
    // A standing hiding of a post its author deleted afterwards no longer hides anything.
    const deletedHidden = await createPost(t.db, {
      marketId,
      authorId: member,
      hiddenAt: new Date(),
      deletedAt: new Date(),
    });
    const mootHide = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      postId: deletedHidden.id,
    });
    // The same for a 댓글: a standing hiding of a live one stays (the only way to show it again),
    // one of a 댓글 its author deleted goes.
    const hiddenComment = await createComment(t.db, {
      postId: post.id,
      authorId: member,
      hiddenAt: new Date(),
    });
    const standingCommentHide = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      commentId: hiddenComment.id,
    });
    const deletedHiddenComment = await createComment(t.db, {
      postId: post.id,
      authorId: member,
      hiddenAt: new Date(),
      deletedAt: new Date(),
    });
    const mootCommentHide = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      commentId: deletedHiddenComment.id,
    });
    // A hiding an operator cancels ten days after the withdrawal: counted from the cancellation.
    const lateCancelled = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      postId: (await createPost(t.db, { marketId, authorId: member })).id,
      cancelled: { at: after(new Date(), 10), by: admin, reason: '탈퇴 뒤 취소' },
    });
    const named = await createModerationAction(t.db, { userId: member, createdBy: admin });
    await createReport(t.db, {
      reporterId: liveReporter,
      reportedUserId: member,
      status: 'actioned',
      resolvedAt: new Date(),
      resolvedBy: admin,
      actionId: named.id,
    });
    const restriction = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      type: 'account_restriction',
      approvedBy: otherAdmin,
      endsAt: after(new Date(), 1),
      cancelled: { at: new Date(), by: admin, reason: '취소', approvedBy: otherAdmin },
    });
    // A request about the member that came to nothing (rejected), and a live member's action.
    const rejected = await createApprovalRequest(t.db, {
      kind: 'account_restriction',
      targetType: 'user',
      targetId: member,
      requestedBy: admin,
      decision: { status: 'rejected', by: otherAdmin },
    });
    const livesAction = await createModerationAction(t.db, {
      userId: liveMember,
      createdBy: admin,
    });
    // An admin grant's request (#171) is an operational record: never deleted.
    const grant = await createApprovalRequest(t.db, {
      kind: 'admin_grant',
      targetType: 'user',
      targetId: member,
      requestedBy: admin,
      decision: { status: 'rejected', by: otherAdmin },
    });
    const closedAt = await closeAccount(t.db, member);
    await setPeriod(MODERATION_RECORDS_RETENTION_SETTING, 90);

    await run(after(closedAt, 90, -1));
    expect(await t.db.select().from(schema.moderationActions)).toHaveLength(10);

    const due = after(closedAt, 90);
    await run(due);
    const actions = (await t.db.select().from(schema.moderationActions)).map((row) => row.id);
    expect(actions.sort()).toEqual(
      [standingHide.id, standingCommentHide.id, lateCancelled.id, named.id, livesAction.id].sort(),
    );
    expect(actions).not.toContain(warning.id);
    expect(actions).not.toContain(cancelledHide.id);
    expect(actions).not.toContain(restriction.id);
    expect(actions).not.toContain(mootHide.id);
    expect(actions).not.toContain(mootCommentHide.id);
    const requests = (await t.db.select().from(schema.approvalRequests)).map((row) => row.id);
    expect(requests).toEqual([grant.id]);
    expect(requests).not.toContain(rejected.id);
    // The restriction's apply and cancel approvals, and the rejected request.
    expect(await countsAt(due)).toMatchObject({ moderation_actions: 5, approval_requests: 3 });
    // The posts and comments the actions named stay as they are.
    expect((await postOf(hiddenPost.id)).hiddenAt).not.toBeNull();
    expect((await postOf(post.id)).purgedAt).toBeNull();
    expect((await commentOf(hiddenComment.id)).hiddenAt).not.toBeNull();

    // The late cancellation's period runs from the cancellation, not the withdrawal.
    const cancelledAt = lateCancelled.cancelledAt!;
    await run(after(cancelledAt, 90, -1));
    expect((await t.db.select().from(schema.moderationActions)).map((row) => row.id)).toContain(
      lateCancelled.id,
    );
    const cancelDue = after(cancelledAt, 90);
    await run(cancelDue);
    expect(
      (await t.db.select().from(schema.moderationActions)).map((row) => row.id).sort(),
    ).toEqual([standingHide.id, standingCommentHide.id, named.id, livesAction.id].sort());
    expect(await countsAt(cancelDue)).toMatchObject({ moderation_actions: 1 });
    expect((await commentOf(hiddenComment.id)).hiddenAt).not.toBeNull();
  });

  it('keeps every record of a live member however old', async () => {
    const member = (await createUser(t.db)).user.id;
    const reporter = (await createUser(t.db)).user.id;
    await createConsents(t.db, { userId: member });
    await codeSend(member);
    const action = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      createdAt: before(new Date(), 1_000),
    });
    const report = await createReport(t.db, {
      reporterId: member,
      reportedUserId: reporter,
      status: 'dismissed',
      createdAt: before(new Date(), 1_000),
      resolvedAt: before(new Date(), 999),
      resolvedBy: admin,
      dismissalReason: '기각',
    });
    for (const definition of [
      CONSENT_RECORDS_RETENTION_SETTING,
      PHONE_VERIFICATION_RECORDS_RETENTION_SETTING,
      MODERATION_RECORDS_RETENTION_SETTING,
    ]) {
      await setPeriod(definition, 1);
    }
    await run(after(new Date(), 1));
    expect(await t.db.select().from(schema.consentRecords)).toHaveLength(4);
    expect(await t.db.select().from(schema.phoneVerificationCodes)).toHaveLength(1);
    expect((await t.db.select().from(schema.moderationActions)).map((row) => row.id)).toEqual([
      action.id,
    ]);
    expect((await t.db.select().from(schema.reports)).map((row) => row.id)).toEqual([report.id]);
  });

  it('deletes what an operator took from a profile after the period since the action, with the image; the action is a record of its own period', async () => {
    const member = (await createUser(t.db)).user.id;
    const picture = await createProfileImage(t.db, { userId: member });
    await storage.put(picture.storageKey, new Uint8Array([1]), picture.contentType);
    await t.db
      .update(schema.profiles)
      .set({ imageId: null })
      .where(eq(schema.profiles.userId, member));
    const removedAt = before(new Date(), 40);
    const imageAction = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      type: 'image_remove',
      createdAt: removedAt,
      removed: { imageId: picture.id },
    });
    const bioAction = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      type: 'bio_clear',
      createdAt: removedAt,
    });
    await setPeriod(REMOVED_PROFILE_ITEMS_RETENTION_SETTING, 30);
    await setPeriod(MODERATION_RECORDS_RETENTION_SETTING, 30);

    await run(after(removedAt, 30, -1));
    expect(await t.db.select().from(schema.profileItemRemovals)).toHaveLength(2);
    const due = after(removedAt, 30);
    await run(due);
    expect(await t.db.select().from(schema.profileItemRemovals)).toEqual([]);
    expect(await mediaIds()).toEqual([]);
    expect(storage.objects.has(picture.storageKey)).toBe(false);
    // The member is live: the actions stay (신고·제재 기록 of a live account).
    expect(
      (await t.db.select().from(schema.moderationActions)).map((row) => row.id).sort(),
    ).toEqual([imageAction.id, bioAction.id].sort());
    expect(await countsAt(due)).toMatchObject({ removed_profile_items: 2, moderation_actions: 0 });
  });

  it('counts a withdrawn member’s removed profile items from the withdrawal, with the image', async () => {
    const member = (await createUser(t.db)).user.id;
    const picture = await createProfileImage(t.db, { userId: member });
    await storage.put(picture.storageKey, new Uint8Array([1]), picture.contentType);
    await t.db
      .update(schema.profiles)
      .set({ imageId: null })
      .where(eq(schema.profiles.userId, member));
    await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      type: 'image_remove',
      createdAt: before(new Date(), 40),
      removed: { imageId: picture.id },
    });
    const closedAt = await closeAccount(t.db, member);
    // The action's own period stays undecided: only the removed item is judged here.
    await setPeriod(REMOVED_PROFILE_ITEMS_RETENTION_SETTING, 30);

    // 40 days since the action, but a millisecond short of 30 since the withdrawal: kept.
    const early = after(closedAt, 30, -1);
    await run(early);
    expect(await t.db.select().from(schema.profileItemRemovals)).toHaveLength(1);
    expect(await mediaIds()).toEqual([picture.id]);
    expect(storage.objects.has(picture.storageKey)).toBe(true);
    expect(await countsAt(early)).toEqual({ removed_profile_items: 0 });
    const due = after(closedAt, 30);
    await run(due);
    expect(await t.db.select().from(schema.profileItemRemovals)).toEqual([]);
    expect(await mediaIds()).toEqual([]);
    expect(storage.objects.has(picture.storageKey)).toBe(false);
    expect(await countsAt(due)).toEqual({ removed_profile_items: 1 });
    expect(await t.db.select().from(schema.moderationActions)).toHaveLength(1);
  });

  it('keeps a withdrawn member’s profile action while what it took away is kept, deleting the rest of the member’s actions', async () => {
    const member = (await createUser(t.db)).user.id;
    const bioAction = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      type: 'bio_clear',
    });
    // A warning beside it, which goes.
    await createModerationAction(t.db, { userId: member, createdBy: admin });
    const closedAt = await closeAccount(t.db, member);
    // The removed items' period is undecided: the 소개 taken away stays, so its action must too —
    // the removal row names it (RESTRICT), and selecting it would fail the whole batch.
    await setPeriod(MODERATION_RECORDS_RETENTION_SETTING, 1);

    const due = after(closedAt, 1);
    await run(due);
    expect((await t.db.select().from(schema.moderationActions)).map((row) => row.id)).toEqual([
      bioAction.id,
    ]);
    expect(
      (await t.db.select().from(schema.profileItemRemovals)).map((row) => row.actionId),
    ).toEqual([bioAction.id]);
    expect(await countsAt(due)).toMatchObject({ moderation_actions: 1 });
  });

  it('deletes the nickname holds past their 30 days whatever the settings, and a reset’s action once its hold is gone', async () => {
    const member = (await createUser(t.db)).user.id;
    const resetAt = before(new Date(), 2);
    const reset = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      type: 'nickname_reset',
      createdAt: resetAt,
    });
    await t.db
      .insert(schema.nicknameHolds)
      .values({ nickname: 'old_name', userId: null, releasedAt: resetAt, actionId: reset.id });
    const closedAt = await closeAccount(t.db, member);
    await setPeriod(MODERATION_RECORDS_RETENTION_SETTING, 1);
    await setPeriod(REMOVED_PROFILE_ITEMS_RETENTION_SETTING, 1);

    // The period has passed, but the reset's hold stands (30 days from the reset): the action and
    // the closure's hold stay.
    await run(after(closedAt, 5));
    expect(await t.db.select().from(schema.nicknameHolds)).toHaveLength(2);
    expect((await t.db.select().from(schema.moderationActions)).map((row) => row.id)).toEqual([
      reset.id,
    ]);
    const due = after(closedAt, 30);
    await run(due);
    expect(await t.db.select().from(schema.nicknameHolds)).toEqual([]);
    expect(await t.db.select().from(schema.moderationActions)).toEqual([]);
    expect(await t.db.select().from(schema.profileItemRemovals)).toEqual([]);
  });

  it('records each batch in the transaction that deleted it, with the period and the run’s instant', async () => {
    const users = [];
    for (let i = 0; i < 2; i += 1) {
      const id = (await createUser(t.db)).user.id;
      await createConsents(t.db, { userId: id });
      users.push(id);
    }
    let closedAt = new Date(0);
    for (const id of users) closedAt = await closeAccount(t.db, id);
    await setPeriod(CONSENT_RECORDS_RETENTION_SETTING, 3);
    const due = after(closedAt, 3);
    await run(due, 3);
    expect((await purgeRecords()).filter((row) => row.kind === 'consent_records')).toEqual([
      { kind: 'consent_records', count: 3, periodDays: 3, ranAt: due },
      { kind: 'consent_records', count: 3, periodDays: 3, ranAt: due },
      { kind: 'consent_records', count: 2, periodDays: 3, ranAt: due },
    ]);
    expect(await t.db.select().from(schema.consentRecords)).toEqual([]);
  });

  it('applies a changed period from the next run', async () => {
    const id = (await createUser(t.db)).user.id;
    await createConsents(t.db, { userId: id });
    const closedAt = await closeAccount(t.db, id);
    await setPeriod(CONSENT_RECORDS_RETENTION_SETTING, 60);
    const now = after(closedAt, 30);
    await run(now);
    expect(await t.db.select().from(schema.consentRecords)).toHaveLength(4);
    await setPeriod(CONSENT_RECORDS_RETENTION_SETTING, 30);
    const next = after(now, 0, 1);
    await run(next);
    expect(await t.db.select().from(schema.consentRecords)).toEqual([]);
    const recorded = (await purgeRecords()).filter((row) => row.kind === 'consent_records');
    expect(recorded.map((row) => [row.count, row.periodDays])).toEqual([
      [0, 60],
      [4, 30],
    ]);
  });

  it('never touches the ledger, watch events, likes, start grants or operational records, every period approved', async () => {
    const member = (await createUser(t.db, { balanceCoin: 5_000n })).user.id;
    const other = (await createUser(t.db)).user.id;
    await createWatch(t.db, { userId: member, marketId });
    const post = await createPost(t.db, { marketId, authorId: member, deletedAt: new Date() });
    await createPostLike(t.db, { postId: post.id, userId: other });
    const live = await createPost(t.db, { marketId, authorId: member, title: '남는 글' });
    await createPostLike(t.db, { postId: live.id, userId: other });
    await createConsents(t.db, { userId: member });
    await codeSend(member);
    const closedAt = await closeAccount(t.db, member);
    for (const definition of [
      CONSENT_RECORDS_RETENTION_SETTING,
      PHONE_VERIFICATION_RECORDS_RETENTION_SETTING,
      DELETED_POSTS_RETENTION_SETTING,
      MODERATION_RECORDS_RETENTION_SETTING,
      REMOVED_PROFILE_ITEMS_RETENTION_SETTING,
    ]) {
      await setPeriod(definition, 1);
    }
    const count = async () => ({
      ledger: (await t.db.select().from(schema.ledgerEntries)).length,
      watchEvents: (await t.db.select().from(schema.marketWatchEvents)).length,
      likes: (await t.db.select().from(schema.postLikes)).length,
      adminActions: (await t.db.select().from(schema.adminActions)).length,
      startGrants: (await t.db.select().from(schema.startGrants)).length,
      posts: (await t.db.select().from(schema.posts)).length,
      users: (await t.db.select().from(schema.user)).length,
    });
    const beforeRun = await count();
    const ledger = await t.db.select().from(schema.ledgerEntries);
    await run(after(closedAt, 10));
    expect(await count()).toEqual(beforeRun);
    expect(await t.db.select().from(schema.ledgerEntries)).toEqual(ledger);
    expect(await postOf(live.id)).toMatchObject({ title: '남는 글', purgedAt: null });
    expect((await postOf(post.id)).purgedAt).not.toBeNull();
    expect(await t.db.select().from(schema.consentRecords)).toEqual([]);
    expect(await t.db.select().from(schema.phoneVerificationCodes)).toEqual([]);
    // The purge records name no person: kind, count, period and instant only.
    const columns = Object.keys((await t.db.select().from(schema.retentionPurges))[0]!);
    expect(columns.sort()).toEqual(['count', 'id', 'kind', 'periodDays', 'ranAt']);
  });

  it('reports an object the store would not remove and goes on (its row is gone)', async () => {
    const author = (await createUser(t.db)).user.id;
    const picture = await image(author);
    const post = await createPost(t.db, {
      marketId,
      authorId: author,
      imageIds: [picture.id],
      deletedAt: new Date(),
    });
    storage.delete = () => Promise.reject(new Error('AccessDenied'));
    await setPeriod(DELETED_POSTS_RETENTION_SETTING, 1);
    const outcome = await run(after(new Date(), 2));
    expect(outcome.failed).toBe(1);
    expect(outcome.failures[0]).toMatchObject({
      storageKey: picture.storageKey,
      message: 'AccessDenied',
    });
    expect((await postOf(post.id)).purgedAt).not.toBeNull();
    expect(await mediaIds()).toEqual([]);
  });

  it('goes on past a kind that fails, reporting it, and records no 0 for it', async () => {
    const id = (await createUser(t.db)).user.id;
    await createConsents(t.db, { userId: id });
    const closedAt = await closeAccount(t.db, id);
    await setPeriod(CONSENT_RECORDS_RETENTION_SETTING, 1);
    // The first transaction of the run — the nickname holds' — is refused.
    let calls = 0;
    const failing = new Proxy(t.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (...args: Parameters<typeof target.transaction>) => {
            calls += 1;
            return calls === 1
              ? Promise.reject(new Error('could not serialize access'))
              : target.transaction(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const now = after(closedAt, 1);
    const outcome = await purgeExpiredRecords(failing, storage, { now });
    expect(outcome.kindFailures.map(({ kind, message }) => ({ kind, message }))).toEqual([
      { kind: 'nickname_holds', message: 'could not serialize access' },
    ]);
    expect(await t.db.select().from(schema.consentRecords)).toEqual([]);
    expect((await purgeRecords()).map((row) => row.kind)).toEqual(['consent_records']);
  });

  it('runs on the database clock by default, not the worker’s', async () => {
    // The worker's clock a year ahead: a run that took its instant from it would land there.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(after(new Date(), 365));
      const start = await dbNow();
      const outcome = await purgeExpiredRecords(t.db, storage);
      const end = await dbNow();
      expect(outcome.ranAt.getTime()).toBeGreaterThanOrEqual(start.getTime());
      expect(outcome.ranAt.getTime()).toBeLessThanOrEqual(end.getTime());
      expect(await purgeRecords()).toEqual([
        { kind: 'nickname_holds', count: 0, periodDays: 30, ranAt: outcome.ranAt },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes through the function only an account restriction request about a withdrawn member', async () => {
    const live = (await createUser(t.db)).user.id;
    const request = await createApprovalRequest(t.db, {
      kind: 'account_restriction',
      targetType: 'user',
      targetId: live,
      requestedBy: admin,
      decision: { status: 'rejected', by: otherAdmin },
    });
    const { rows } = await t.db.execute<{ deleted: number }>(
      sql`SELECT retention_delete_approval_requests(ARRAY[${request.id}]::uuid[]) AS deleted`,
    );
    expect(rows[0]!.deleted).toBe(0);
    // And buddha_app still cannot delete a request itself.
    await expect(
      t.db.delete(schema.approvalRequests).where(inArray(schema.approvalRequests.id, [request.id])),
    ).rejects.toThrow();
  });
});
