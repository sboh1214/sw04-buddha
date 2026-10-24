/**
 * `retention.purge` (#184, ADR-0087) on the docker `test` database: for each data kind, what is
 * deleted once its period has passed and what stays — the base times (the withdrawal for a
 * withdrawn account's records, the deletion for what a live account deleted, the replacement for an
 * earlier version, the later of the withdrawal and the processing for a processed record), the
 * boundary (a record exactly its period old is due), the records still being processed or still
 * named, a period that is not approved (nothing deleted, nothing recorded), the nickname holds' fixed
 * 30 days, the purge records (kind, count, period, run instant and outcome — per batch, one 0, or
 * one `failed`), and that the ledger, the watch events, likes, posts not deleted and the other
 * operational records are never touched. The owner's answers of 2026-10-24 (ADR-0087) each have
 * their case: the reports a withdrawn member received (1), a withdrawn member's items still hidden
 * (3 — a post and a comment each, under every guard of their steps), what a pending account
 * restriction request cites (12 — each kind of request and both columns a restriction cites) and a
 * failed kind's record (14). The release settings are changed the way the admin screen changes
 * them (a row and its record); the run's instant is moved past a period instead of backdating a
 * closure (a closed profile never changes, migration 0041). Skips when TEST_* are unset.
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
        outcome: schema.retentionPurges.outcome,
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
      { kind: 'nickname_holds', count: 1, periodDays: 30, ranAt: now, outcome: 'done' },
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
      outcome: 'done',
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

  it('deletes the reports a withdrawn member received from live reporters, and the actions they name, from the later of the withdrawal and the processing (owner decision 2026-10-24 1)', async () => {
    const member = (await createUser(t.db)).user.id;
    const reporter = (await createUser(t.db)).user.id;
    const liveMember = (await createUser(t.db)).user.id;
    const post = await createPost(t.db, { marketId, authorId: member });
    // A report on the member's post that a warning resolved, before the withdrawal.
    const warning = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      postId: post.id,
      type: 'warning',
    });
    const actioned = await createReport(t.db, {
      reporterId: reporter,
      reportedUserId: member,
      postId: post.id,
      status: 'actioned',
      resolvedAt: warning.createdAt,
      resolvedBy: admin,
      actionId: warning.id,
    });
    // One on the member's profile, dismissed five days after the withdrawal (the later of the two).
    const dismissedLater = await createReport(t.db, {
      reporterId: reporter,
      reportedUserId: member,
    });
    // Still pending: kept however long.
    const pending = await createReport(t.db, {
      reporterId: reporter,
      reportedUserId: member,
      commentId: (await createComment(t.db, { postId: post.id, authorId: member })).id,
    });
    // Between two live accounts: kept (owner decision 2026-10-24 2).
    const livesReport = await createReport(t.db, {
      reporterId: reporter,
      reportedUserId: liveMember,
      status: 'dismissed',
      resolvedAt: before(new Date(), 400),
      resolvedBy: admin,
      dismissalReason: '기각',
    });
    const closedAt = await closeAccount(t.db, member);
    const resolvedLater = after(closedAt, 5);
    await t.db
      .update(schema.reports)
      .set({
        status: 'dismissed',
        resolvedAt: resolvedLater,
        resolvedBy: admin,
        dismissalReason: '기각',
      })
      .where(eq(schema.reports.id, dismissedLater.id));
    await setPeriod(MODERATION_RECORDS_RETENTION_SETTING, 30);
    const reportIds = async () =>
      (await t.db.select({ id: schema.reports.id }).from(schema.reports))
        .map((row) => row.id)
        .sort();

    const early = after(closedAt, 30, -1);
    await run(early);
    expect(await reportIds()).toEqual(
      [actioned.id, dismissedLater.id, pending.id, livesReport.id].sort(),
    );
    expect(await countsAt(early)).toMatchObject({ reports: 0, moderation_actions: 0 });

    // The reporter is live, the member reported withdrew: the report and the warning it names go —
    // from the reporter's own 조치·신고 내역 too (GET /me/reports reads these rows).
    const due = after(closedAt, 30);
    await run(due);
    expect(await reportIds()).toEqual([dismissedLater.id, pending.id, livesReport.id].sort());
    expect(await t.db.select().from(schema.moderationActions)).toEqual([]);
    expect(await countsAt(due)).toMatchObject({ reports: 1, moderation_actions: 1 });

    const later = after(resolvedLater, 30);
    await run(later);
    expect(await reportIds()).toEqual([pending.id, livesReport.id].sort());
    expect(await countsAt(later)).toMatchObject({ reports: 1 });
    await run(after(closedAt, 3_650));
    expect(await reportIds()).toEqual([pending.id, livesReport.id].sort());
  });

  it('empties a withdrawn member’s post and comment an operator still hides once the 신고·제재 period has passed since the later of the withdrawal and the hiding, deleting the hidings; they stay hidden (owner decision 2026-10-24 3)', async () => {
    const member = (await createUser(t.db)).user.id;
    const reporter = (await createUser(t.db)).user.id;
    const liveMember = (await createUser(t.db)).user.id;
    const hiddenAt = before(new Date(), 200);
    const picture = await image(member);
    const post = await createPost(t.db, {
      marketId,
      authorId: member,
      title: '숨긴 글',
      imageIds: [picture.id],
      createdAt: before(hiddenAt, 1),
      hiddenAt,
    });
    const hide = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      postId: post.id,
      createdAt: hiddenAt,
    });
    // The report the hiding resolved: a report the member received, which goes first.
    await createReport(t.db, {
      reporterId: reporter,
      reportedUserId: member,
      postId: post.id,
      status: 'actioned',
      resolvedAt: hiddenAt,
      resolvedBy: admin,
      actionId: hide.id,
    });
    const comment = await createComment(t.db, {
      postId: (await createPost(t.db, { marketId, authorId: liveMember })).id,
      authorId: member,
      body: '숨긴 댓글',
      hiddenAt,
    });
    const commentHide = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      commentId: comment.id,
      createdAt: hiddenAt,
    });
    // A hidden post a report still waits about: kept, and its hiding (in force) with it.
    const reportedPost = await createPost(t.db, {
      marketId,
      authorId: member,
      title: '신고 대기 중인 숨긴 글',
      hiddenAt,
    });
    const reportedHide = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      postId: reportedPost.id,
      createdAt: hiddenAt,
    });
    await createReport(t.db, {
      reporterId: reporter,
      reportedUserId: member,
      postId: reportedPost.id,
    });
    // The same for a hidden comment a report still waits about.
    const reportedComment = await createComment(t.db, {
      postId: (await createPost(t.db, { marketId, authorId: liveMember })).id,
      authorId: member,
      body: '신고 대기 중인 숨긴 댓글',
      hiddenAt,
    });
    const reportedCommentHide = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      commentId: reportedComment.id,
      createdAt: hiddenAt,
    });
    await createReport(t.db, {
      reporterId: reporter,
      reportedUserId: member,
      commentId: reportedComment.id,
    });
    // A live member's hidden post and comment: theirs, kept however old (owner decision
    // 2026-10-24 2).
    const livesPost = await createPost(t.db, {
      marketId,
      authorId: liveMember,
      title: '살아 있는 회원의 숨긴 글',
      hiddenAt,
    });
    const livesHide = await createModerationAction(t.db, {
      userId: liveMember,
      createdBy: admin,
      postId: livesPost.id,
      createdAt: hiddenAt,
    });
    const livesComment = await createComment(t.db, {
      postId: livesPost.id,
      authorId: liveMember,
      body: '살아 있는 회원의 숨긴 댓글',
      hiddenAt,
    });
    const livesCommentHide = await createModerationAction(t.db, {
      userId: liveMember,
      createdBy: admin,
      commentId: livesComment.id,
      createdAt: hiddenAt,
    });
    const closedAt = await closeAccount(t.db, member);
    // Only the 신고·제재 period: the deleted originals' is undecided.
    await setPeriod(MODERATION_RECORDS_RETENTION_SETTING, 30);

    // 200 days since the hiding, a millisecond short of 30 since the withdrawal: kept.
    const early = after(closedAt, 30, -1);
    await run(early);
    expect(await postOf(post.id)).toMatchObject({ title: '숨긴 글', purgedAt: null });
    expect(await commentOf(comment.id)).toMatchObject({ body: '숨긴 댓글', purgedAt: null });
    expect(await countsAt(early)).toMatchObject({ hidden_posts: 0, hidden_comments: 0 });

    const due = after(closedAt, 30);
    await run(due);
    // Emptied as a deleted original is, the row kept and still hidden; the hiding gone.
    expect(await postOf(post.id)).toMatchObject({
      title: null,
      body: { type: 'doc', content: [] },
      bodyText: '',
      imageIds: [],
      purgedAt: due,
      hiddenAt,
      deletedAt: null,
    });
    expect(await commentOf(comment.id)).toMatchObject({
      body: '',
      purgedAt: due,
      hiddenAt,
      deletedAt: null,
    });
    expect(await mediaIds()).toEqual([]);
    expect(storage.objects.has(picture.storageKey)).toBe(false);
    const actions = (await t.db.select().from(schema.moderationActions)).map((row) => row.id);
    expect(actions.sort()).toEqual(
      [reportedHide.id, reportedCommentHide.id, livesHide.id, livesCommentHide.id].sort(),
    );
    expect(actions).not.toContain(hide.id);
    expect(actions).not.toContain(commentHide.id);
    expect(await postOf(reportedPost.id)).toMatchObject({
      title: '신고 대기 중인 숨긴 글',
      purgedAt: null,
    });
    expect(await commentOf(reportedComment.id)).toMatchObject({
      body: '신고 대기 중인 숨긴 댓글',
      purgedAt: null,
    });
    expect(await postOf(livesPost.id)).toMatchObject({
      title: '살아 있는 회원의 숨긴 글',
      purgedAt: null,
    });
    expect(await commentOf(livesComment.id)).toMatchObject({
      body: '살아 있는 회원의 숨긴 댓글',
      purgedAt: null,
    });
    expect(await countsAt(due)).toMatchObject({
      reports: 1,
      hidden_posts: 1,
      hidden_comments: 1,
      moderation_actions: 2,
    });
    // It stays hidden whoever writes (migration 0042's CHECK): showing it again is refused.
    await expect(
      t.db.update(schema.posts).set({ hiddenAt: null }).where(eq(schema.posts.id, post.id)),
    ).rejects.toThrow();
    await expect(
      t.db
        .update(schema.postComments)
        .set({ hiddenAt: null })
        .where(eq(schema.postComments.id, comment.id)),
    ).rejects.toThrow();
  });

  it('counts a withdrawn member’s hidden item from the hiding when it came after the withdrawal', async () => {
    const member = (await createUser(t.db)).user.id;
    const post = await createPost(t.db, { marketId, authorId: member, title: '늦게 숨긴 글' });
    const comment = await createComment(t.db, {
      postId: post.id,
      authorId: member,
      body: '늦게 숨긴 댓글',
    });
    const closedAt = await closeAccount(t.db, member);
    const hiddenAt = after(closedAt, 10);
    await t.db.update(schema.posts).set({ hiddenAt }).where(eq(schema.posts.id, post.id));
    await t.db
      .update(schema.postComments)
      .set({ hiddenAt })
      .where(eq(schema.postComments.id, comment.id));
    for (const item of [{ postId: post.id }, { commentId: comment.id }]) {
      await createModerationAction(t.db, {
        userId: member,
        createdBy: admin,
        ...item,
        createdAt: hiddenAt,
      });
    }
    await setPeriod(MODERATION_RECORDS_RETENTION_SETTING, 30);

    // Forty days since the withdrawal, a millisecond short of thirty since the hiding: kept.
    await run(after(hiddenAt, 30, -1));
    expect((await postOf(post.id)).purgedAt).toBeNull();
    expect(await commentOf(comment.id)).toMatchObject({ body: '늦게 숨긴 댓글', purgedAt: null });
    expect(await t.db.select().from(schema.moderationActions)).toHaveLength(2);
    const due = after(hiddenAt, 30);
    await run(due);
    expect(await postOf(post.id)).toMatchObject({ title: null, purgedAt: due, hiddenAt });
    expect(await commentOf(comment.id)).toMatchObject({ body: '', purgedAt: due, hiddenAt });
    expect(await t.db.select().from(schema.moderationActions)).toEqual([]);
  });

  it('deletes a withdrawn member’s hidden post’s and comment’s edit history, with the images only those versions used, when it empties them — not by the versions’ own period (owner decision 2026-10-24 (2차) 2)', async () => {
    const member = (await createUser(t.db)).user.id;
    const liveMember = (await createUser(t.db)).user.id;
    const reporter = (await createUser(t.db)).user.id;
    const hiddenAt = before(new Date(), 200);
    // The post shows one image; its earlier versions showed another, theirs alone (createPost
    // attached what the current body shows, so attach the other the way the first version did).
    const shown = await image(member);
    const versionsOnly = await image(member);
    const post = await createPost(t.db, {
      marketId,
      authorId: member,
      title: '숨긴 글',
      imageIds: [shown.id],
      createdAt: before(hiddenAt, 3),
      hiddenAt,
    });
    await t.db.insert(schema.postImages).values({ postId: post.id, mediaId: versionsOnly.id });
    await postRevision(post.id, before(hiddenAt, 2), [versionsOnly.id]);
    await postRevision(post.id, before(hiddenAt, 1), [versionsOnly.id, shown.id]);
    const thread = (await createPost(t.db, { marketId, authorId: liveMember })).id;
    const comment = await createComment(t.db, {
      postId: thread,
      authorId: member,
      body: '숨긴 댓글',
      hiddenAt,
    });
    await commentRevision(comment.id, before(hiddenAt, 1));
    for (const item of [{ postId: post.id }, { commentId: comment.id }]) {
      await createModerationAction(t.db, {
        userId: member,
        createdBy: admin,
        ...item,
        createdAt: hiddenAt,
      });
    }
    // Kept with their content, each with its earlier version: the member's hidden post and comment
    // a report still waits about, a live member's hidden post and comment, and the member's post
    // and comment neither hidden nor deleted — whose versions wait for their own period.
    const reportedPost = await createPost(t.db, {
      marketId,
      authorId: member,
      title: '신고 대기 중인 숨긴 글',
      hiddenAt,
    });
    await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      postId: reportedPost.id,
      createdAt: hiddenAt,
    });
    await createReport(t.db, {
      reporterId: reporter,
      reportedUserId: member,
      postId: reportedPost.id,
    });
    const reportedRevision = await postRevision(reportedPost.id, before(hiddenAt, 1));
    const livesPost = await createPost(t.db, {
      marketId,
      authorId: liveMember,
      title: '살아 있는 회원의 숨긴 글',
      hiddenAt,
    });
    await createModerationAction(t.db, {
      userId: liveMember,
      createdBy: admin,
      postId: livesPost.id,
      createdAt: hiddenAt,
    });
    const livesRevision = await postRevision(livesPost.id, before(hiddenAt, 1));
    const shownPost = await createPost(t.db, { marketId, authorId: member, title: '보이는 글' });
    const shownRevision = await postRevision(shownPost.id, before(hiddenAt, 1));
    const reportedComment = await createComment(t.db, {
      postId: thread,
      authorId: member,
      body: '신고 대기 중인 숨긴 댓글',
      hiddenAt,
    });
    await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      commentId: reportedComment.id,
      createdAt: hiddenAt,
    });
    await createReport(t.db, {
      reporterId: reporter,
      reportedUserId: member,
      commentId: reportedComment.id,
    });
    const reportedCommentRevision = await commentRevision(reportedComment.id, before(hiddenAt, 1));
    const livesComment = await createComment(t.db, {
      postId: thread,
      authorId: liveMember,
      body: '살아 있는 회원의 숨긴 댓글',
      hiddenAt,
    });
    await createModerationAction(t.db, {
      userId: liveMember,
      createdBy: admin,
      commentId: livesComment.id,
      createdAt: hiddenAt,
    });
    const livesCommentRevision = await commentRevision(livesComment.id, before(hiddenAt, 1));
    const shownComment = await createComment(t.db, {
      postId: thread,
      authorId: member,
      body: '보이는 댓글',
    });
    const shownCommentRevision = await commentRevision(shownComment.id, before(hiddenAt, 1));
    const closedAt = await closeAccount(t.db, member);
    // The 신고·제재 period, and the versions' own one far longer: by their own rule none would go
    // for years.
    await setPeriod(MODERATION_RECORDS_RETENTION_SETTING, 30);
    await setPeriod(DELETED_POSTS_RETENTION_SETTING, 3_650);
    const postRevisionIds = async () =>
      (await t.db.select({ id: schema.postRevisions.id }).from(schema.postRevisions))
        .map((row) => row.id)
        .sort();
    const commentRevisionIds = async () =>
      (await t.db.select({ id: schema.postCommentRevisions.id }).from(schema.postCommentRevisions))
        .map((row) => row.id)
        .sort();

    // A millisecond short of the period since the withdrawal: the content and every version stay.
    await run(after(closedAt, 30, -1));
    expect(await postOf(post.id)).toMatchObject({ title: '숨긴 글', purgedAt: null });
    expect(await t.db.select().from(schema.postRevisions)).toHaveLength(5);
    expect(await t.db.select().from(schema.postCommentRevisions)).toHaveLength(4);

    const due = after(closedAt, 30);
    await run(due);
    expect(await postOf(post.id)).toMatchObject({
      title: null,
      imageIds: [],
      purgedAt: due,
      hiddenAt,
    });
    expect(await commentOf(comment.id)).toMatchObject({ body: '', purgedAt: due, hiddenAt });
    // Their earlier versions went with them, and the images the content or the versions alone
    // showed — rows and objects. Only theirs: every other post's and comment's stay.
    expect(await postRevisionIds()).toEqual(
      [reportedRevision.id, livesRevision.id, shownRevision.id].sort(),
    );
    expect(await commentRevisionIds()).toEqual(
      [reportedCommentRevision.id, livesCommentRevision.id, shownCommentRevision.id].sort(),
    );
    expect(
      await t.db.select().from(schema.postImages).where(eq(schema.postImages.postId, post.id)),
    ).toEqual([]);
    expect(await mediaIds()).toEqual([]);
    expect(storage.objects.has(shown.storageKey)).toBe(false);
    expect(storage.objects.has(versionsOnly.storageKey)).toBe(false);
    // Recorded as edit history under the 신고·제재 period applied, in the rows of the step that
    // emptied them, beside the 0 the versions' own step found under theirs.
    const revisionRecords = (await purgeRecords())
      .filter(
        (row) =>
          row.ranAt.getTime() === due.getTime() &&
          (row.kind === 'post_revisions' || row.kind === 'comment_revisions'),
      )
      .map(({ kind, count, periodDays, outcome }) => ({ kind, count, periodDays, outcome }));
    expect(revisionRecords).toEqual([
      { kind: 'post_revisions', count: 0, periodDays: 3_650, outcome: 'done' },
      { kind: 'comment_revisions', count: 0, periodDays: 3_650, outcome: 'done' },
      { kind: 'post_revisions', count: 2, periodDays: 30, outcome: 'done' },
      { kind: 'comment_revisions', count: 1, periodDays: 30, outcome: 'done' },
    ]);
    expect(await countsAt(due)).toMatchObject({
      hidden_posts: 1,
      hidden_comments: 1,
      moderation_actions: 2,
    });
    expect(await postOf(reportedPost.id)).toMatchObject({
      title: '신고 대기 중인 숨긴 글',
      purgedAt: null,
    });
    expect(await postOf(livesPost.id)).toMatchObject({
      title: '살아 있는 회원의 숨긴 글',
      purgedAt: null,
    });
    expect(await commentOf(reportedComment.id)).toMatchObject({
      body: '신고 대기 중인 숨긴 댓글',
      purgedAt: null,
    });
    expect(await commentOf(livesComment.id)).toMatchObject({
      body: '살아 있는 회원의 숨긴 댓글',
      purgedAt: null,
    });
    // Their hidings stand; only the emptied post's and comment's went.
    expect(
      (
        await t.db
          .select({
            postId: schema.moderationActions.postId,
            commentId: schema.moderationActions.commentId,
          })
          .from(schema.moderationActions)
          .where(eq(schema.moderationActions.type, 'hide'))
      )
        .map((row) => row.postId ?? row.commentId)
        .sort(),
    ).toEqual([reportedPost.id, livesPost.id, reportedComment.id, livesComment.id].sort());
  });

  it.each([
    ['the hidings’', schema.moderationActions, ['hidden_posts', 'hidden_comments']],
    ['the post versions’', schema.postRevisions, ['hidden_posts']],
    ['the comment versions’', schema.postCommentRevisions, ['hidden_comments']],
  ] as const)(
    'empties a withdrawn member’s hidden post and comment, deletes their edit history and hidings and drops their images in one transaction: with %s delete refused, a batch keeps it all for the next run (owner decision 2026-10-24 (2차) 2)',
    async (_refused, table, failed: readonly string[]) => {
      const member = (await createUser(t.db)).user.id;
      const liveMember = (await createUser(t.db)).user.id;
      const hiddenAt = before(new Date(), 200);
      const versionsOnly = await image(member);
      const post = await createPost(t.db, {
        marketId,
        authorId: member,
        title: '숨긴 글',
        createdAt: before(hiddenAt, 2),
        hiddenAt,
      });
      await t.db.insert(schema.postImages).values({ postId: post.id, mediaId: versionsOnly.id });
      const revision = await postRevision(post.id, before(hiddenAt, 1), [versionsOnly.id]);
      const comment = await createComment(t.db, {
        postId: (await createPost(t.db, { marketId, authorId: liveMember })).id,
        authorId: member,
        body: '숨긴 댓글',
        hiddenAt,
      });
      const commentRevisionRow = await commentRevision(comment.id, before(hiddenAt, 1));
      for (const item of [{ postId: post.id }, { commentId: comment.id }]) {
        await createModerationAction(t.db, {
          userId: member,
          createdBy: admin,
          ...item,
          createdAt: hiddenAt,
        });
      }
      const closedAt = await closeAccount(t.db, member);
      await setPeriod(MODERATION_RECORDS_RETENTION_SETTING, 30);
      const hidings = async () =>
        (
          await t.db
            .select({
              postId: schema.moderationActions.postId,
              commentId: schema.moderationActions.commentId,
            })
            .from(schema.moderationActions)
        )
          .map((row) => row.postId ?? row.commentId)
          .sort();

      // One statement of a batch refused — the hidings' after the content was emptied and the
      // versions deleted, or the versions' between the two: the batch rolls back whole, its record
      // with it, and the other kind's goes through. Were the versions deleted in a transaction of
      // their own, a failure of theirs would leave an emptied item with its old content in them.
      const now = after(closedAt, 30);
      const outcome = await purgeExpiredRecords(failingDelete(table), storage, { now });
      expect(outcome.kindFailures.map(({ kind }) => kind)).toEqual(failed);
      const postFailed = failed.includes('hidden_posts');
      const commentFailed = failed.includes('hidden_comments');
      expect(await postOf(post.id)).toMatchObject(
        postFailed
          ? { title: '숨긴 글', purgedAt: null }
          : { title: null, imageIds: [], purgedAt: now, hiddenAt },
      );
      expect((await t.db.select().from(schema.postRevisions)).map((row) => row.id)).toEqual(
        postFailed ? [revision.id] : [],
      );
      expect(await mediaIds()).toEqual(postFailed ? [versionsOnly.id] : []);
      expect(storage.objects.has(versionsOnly.storageKey)).toBe(postFailed);
      expect(await commentOf(comment.id)).toMatchObject(
        commentFailed
          ? { body: '숨긴 댓글', purgedAt: null }
          : { body: '', purgedAt: now, hiddenAt },
      );
      expect((await t.db.select().from(schema.postCommentRevisions)).map((row) => row.id)).toEqual(
        commentFailed ? [commentRevisionRow.id] : [],
      );
      expect(await hidings()).toEqual(
        [...(postFailed ? [post.id] : []), ...(commentFailed ? [comment.id] : [])].sort(),
      );
      // The failed kind recorded as such, with nothing of what its batch would have deleted.
      expect(
        (await purgeRecords())
          .filter((row) => row.ranAt.getTime() === now.getTime() && row.outcome === 'failed')
          .map((row) => row.kind),
      ).toEqual(failed);
      const failedRun = await countsAt(now);
      expect(failedRun.hidden_posts).toBe(postFailed ? 0 : 1);
      expect(failedRun.post_revisions).toBe(postFailed ? undefined : 1);
      expect(failedRun.hidden_comments).toBe(commentFailed ? 0 : 1);
      expect(failedRun.comment_revisions).toBe(commentFailed ? undefined : 1);
      expect(failedRun.moderation_actions).toBe(2 - failed.length);

      // The next run does what the failed batch did not.
      const next = after(now, 1);
      await run(next);
      expect(await postOf(post.id)).toMatchObject({
        title: null,
        purgedAt: postFailed ? next : now,
        hiddenAt,
      });
      expect(await commentOf(comment.id)).toMatchObject({
        body: '',
        purgedAt: commentFailed ? next : now,
        hiddenAt,
      });
      expect(await t.db.select().from(schema.postRevisions)).toEqual([]);
      expect(await t.db.select().from(schema.postCommentRevisions)).toEqual([]);
      expect(await hidings()).toEqual([]);
      expect(await mediaIds()).toEqual([]);
      expect(storage.objects.has(versionsOnly.storageKey)).toBe(false);
      const nextRun = await countsAt(next);
      expect(nextRun.hidden_posts).toBe(postFailed ? 1 : 0);
      expect(nextRun.post_revisions ?? 0).toBe(postFailed ? 1 : 0);
      expect(nextRun.hidden_comments).toBe(commentFailed ? 1 : 0);
      expect(nextRun.comment_revisions ?? 0).toBe(commentFailed ? 1 : 0);
      expect(nextRun.moderation_actions).toBe(failed.length);
    },
  );

  it('records the edit history a hidden post lost with its content after the versions’ own step failed under the same period, after that failure: the failure counts none of it (owner decisions 2026-10-24 14 and (2차) 2)', async () => {
    const member = (await createUser(t.db)).user.id;
    const hiddenAt = before(new Date(), 200);
    const post = await createPost(t.db, {
      marketId,
      authorId: member,
      title: '숨긴 글',
      createdAt: before(hiddenAt, 3),
      hiddenAt,
    });
    await postRevision(post.id, before(hiddenAt, 2));
    await postRevision(post.id, before(hiddenAt, 1));
    await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      postId: post.id,
      createdAt: hiddenAt,
    });
    const closedAt = await closeAccount(t.db, member);
    // Both periods approved at one value: the run records the two steps' edit history under it.
    await setPeriod(MODERATION_RECORDS_RETENTION_SETTING, 30);
    await setPeriod(DELETED_POSTS_RETENTION_SETTING, 30);
    // Transactions: the nickname holds' (1), then the post versions' first batch (2), refused.
    const now = after(closedAt, 30);
    const outcome = await purgeExpiredRecords(failingTransaction(2), storage, { now });
    expect(outcome.kindFailures.map(({ kind }) => kind)).toEqual(['post_revisions']);
    expect(await postOf(post.id)).toMatchObject({ title: null, purgedAt: now, hiddenAt });
    expect(await t.db.select().from(schema.postRevisions)).toEqual([]);
    // In the order written (the records' ids): the failure first, then the hidden posts' batch's —
    // so the screen tells what the versions' step deleted before its error (none) from what the
    // hidden posts' step deleted after it (lib/retention.ts, ADR-0087 7-18).
    expect((await purgeRecords()).filter((row) => row.kind === 'post_revisions')).toEqual([
      { kind: 'post_revisions', count: 0, periodDays: 30, ranAt: now, outcome: 'failed' },
      { kind: 'post_revisions', count: 2, periodDays: 30, ranAt: now, outcome: 'done' },
    ]);
    expect(await countsAt(now)).toMatchObject({ hidden_posts: 1, moderation_actions: 1 });
    // The run's outcome for the kind is its own step's: none, failed.
    expect(outcome.kinds.find(({ kind }) => kind === 'post_revisions')).toMatchObject({
      periodDays: 30,
      deleted: 0,
    });
  });

  it('keeps a withdrawn member’s hidden post and comment, and their hidings, while a report processed after the withdrawal still names the hiding, and empties them once that report has gone (ADR-0087 7-23)', async () => {
    const member = (await createUser(t.db)).user.id;
    const reporter = (await createUser(t.db)).user.id;
    const hiddenAt = before(new Date(), 10);
    const picture = await image(member);
    const post = await createPost(t.db, {
      marketId,
      authorId: member,
      title: '숨긴 글',
      imageIds: [picture.id],
      createdAt: before(hiddenAt, 1),
      hiddenAt,
    });
    const postHide = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      postId: post.id,
      createdAt: hiddenAt,
    });
    const comment = await createComment(t.db, {
      postId: (await createPost(t.db, { marketId, authorId: reporter })).id,
      authorId: member,
      body: '숨긴 댓글',
      hiddenAt,
    });
    const commentHide = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      commentId: comment.id,
      createdAt: hiddenAt,
    });
    // Each hiding named by a live reporter's report processed twenty days on — after the
    // withdrawal. The API does not write one (a hiding closes its item's pending reports at its own
    // instant); the factory does, and the foreign key would refuse the hiding's delete.
    const resolvedAt = after(new Date(), 20);
    for (const [item, hide] of [
      [{ postId: post.id }, postHide],
      [{ commentId: comment.id }, commentHide],
    ] as const) {
      await createReport(t.db, {
        reporterId: reporter,
        reportedUserId: member,
        ...item,
        status: 'actioned',
        resolvedAt,
        resolvedBy: admin,
        actionId: hide.id,
      });
    }
    const closedAt = await closeAccount(t.db, member);
    await setPeriod(MODERATION_RECORDS_RETENTION_SETTING, 30);
    const actionIds = async () =>
      (await t.db.select({ id: schema.moderationActions.id }).from(schema.moderationActions))
        .map((row) => row.id)
        .sort();

    // The hidings are due from the withdrawal, the reports naming them are not: nothing goes, and
    // no kind fails on the foreign key (`run`).
    const hidingsDue = after(closedAt, 30);
    await run(hidingsDue);
    expect(await postOf(post.id)).toMatchObject({ title: '숨긴 글', purgedAt: null });
    expect(await commentOf(comment.id)).toMatchObject({ body: '숨긴 댓글', purgedAt: null });
    expect(storage.objects.has(picture.storageKey)).toBe(true);
    expect(await actionIds()).toEqual([postHide.id, commentHide.id].sort());
    expect(await countsAt(hidingsDue)).toMatchObject({
      reports: 0,
      hidden_posts: 0,
      hidden_comments: 0,
      moderation_actions: 0,
    });

    // The reports' own period has passed: they go first, then the items are emptied and their
    // hidings deleted, in the same run.
    const due = after(resolvedAt, 30);
    await run(due);
    expect(await t.db.select().from(schema.reports)).toEqual([]);
    expect(await actionIds()).toEqual([]);
    expect(await postOf(post.id)).toMatchObject({ title: null, purgedAt: due, hiddenAt });
    expect(await commentOf(comment.id)).toMatchObject({ body: '', purgedAt: due, hiddenAt });
    expect(storage.objects.has(picture.storageKey)).toBe(false);
    expect(await countsAt(due)).toMatchObject({
      reports: 2,
      hidden_posts: 1,
      hidden_comments: 1,
      moderation_actions: 2,
    });
  });

  it('keeps a withdrawn member’s hidden post and its hiding when the reports kind fails in the same run, and empties it on the next (ADR-0087 7-23)', async () => {
    const member = (await createUser(t.db)).user.id;
    const reporter = (await createUser(t.db)).user.id;
    const hiddenAt = before(new Date(), 200);
    const post = await createPost(t.db, { marketId, authorId: member, title: '숨긴 글', hiddenAt });
    const hide = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      postId: post.id,
      createdAt: hiddenAt,
    });
    // As the API leaves it: the hiding resolved the post's report at its own instant.
    await createReport(t.db, {
      reporterId: reporter,
      reportedUserId: member,
      postId: post.id,
      status: 'actioned',
      resolvedAt: hiddenAt,
      resolvedBy: admin,
      actionId: hide.id,
    });
    const closedAt = await closeAccount(t.db, member);
    await setPeriod(MODERATION_RECORDS_RETENTION_SETTING, 30);

    // Only the 신고·제재 period is approved: the nickname holds' transaction (1), then the reports'
    // (2), refused — the report that names the hiding stays this run, and so do the hiding and the
    // post it hides.
    const now = after(closedAt, 30);
    const outcome = await purgeExpiredRecords(failingTransaction(2), storage, { now });
    expect(outcome.kindFailures.map(({ kind }) => kind)).toEqual(['reports']);
    expect(await postOf(post.id)).toMatchObject({ title: '숨긴 글', purgedAt: null });
    expect((await t.db.select().from(schema.moderationActions)).map((row) => row.id)).toEqual([
      hide.id,
    ]);
    expect(await countsAt(now)).toMatchObject({ reports: 0, hidden_posts: 0 });

    const next = after(now, 1);
    await run(next);
    expect(await t.db.select().from(schema.reports)).toEqual([]);
    expect(await t.db.select().from(schema.moderationActions)).toEqual([]);
    expect(await postOf(post.id)).toMatchObject({ title: null, purgedAt: next, hiddenAt });
    expect(await countsAt(next)).toMatchObject({
      reports: 1,
      hidden_posts: 1,
      moderation_actions: 1,
    });
  });

  it('keeps a deleted original and its edit history while an account restriction request citing it waits, and empties them once it is decided or retracted (owner decision 2026-10-24 12)', async () => {
    const member = (await createUser(t.db)).user.id;
    const deletedAt = before(new Date(), 50);
    // The apply's subject: a post the member deleted, with an earlier version.
    const cited = await createPost(t.db, {
      marketId,
      authorId: member,
      title: '요청의 근거 글',
      deletedAt,
    });
    const citedRevision = await postRevision(cited.id, deletedAt);
    const apply = await createApprovalRequest(t.db, {
      kind: 'account_restriction',
      targetType: 'user',
      targetId: member,
      payload: {
        userId: member,
        reason: 'abuse',
        note: '설명',
        days: 7,
        subject: { type: 'post', postId: cited.id },
        memo: null,
      },
      requestedBy: admin,
    });
    // A restriction that stands, about a comment the member deleted, with a lift asked for.
    const comment = await createComment(t.db, {
      postId: (await createPost(t.db, { marketId, authorId: otherAdmin })).id,
      authorId: member,
      body: '제한의 근거 댓글',
      deletedAt,
    });
    const commentRevisionRow = await commentRevision(comment.id, deletedAt);
    const restriction = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      type: 'account_restriction',
      approvedBy: otherAdmin,
      commentId: comment.id,
      createdAt: before(deletedAt, -1),
      endsAt: after(new Date(), 30),
    });
    const lift = await createApprovalRequest(t.db, {
      kind: 'account_restriction_lift',
      targetType: 'moderation_action',
      targetId: restriction.id,
      payload: { userId: member, actionId: restriction.id },
      requestedBy: admin,
    });
    // Nothing waits about this one: emptied on time.
    const uncited = await createPost(t.db, { marketId, authorId: member, deletedAt });
    await setPeriod(DELETED_POSTS_RETENTION_SETTING, 10);

    const due = after(deletedAt, 10);
    await run(due);
    expect((await postOf(uncited.id)).purgedAt).toEqual(due);
    expect(await postOf(cited.id)).toMatchObject({ title: '요청의 근거 글', purgedAt: null });
    expect(await commentOf(comment.id)).toMatchObject({ body: '제한의 근거 댓글', purgedAt: null });
    expect((await t.db.select().from(schema.postRevisions)).map((row) => row.id)).toEqual([
      citedRevision.id,
    ]);
    expect((await t.db.select().from(schema.postCommentRevisions)).map((row) => row.id)).toEqual([
      commentRevisionRow.id,
    ]);
    expect(await countsAt(due)).toMatchObject({
      deleted_posts: 1,
      deleted_comments: 0,
      post_revisions: 0,
      comment_revisions: 0,
    });

    // The apply rejected, the lift retracted by its requester: nothing waits any more, and the
    // period still counts from the deletion — the next run empties them.
    await t.db
      .update(schema.approvalRequests)
      .set({
        status: 'rejected',
        decidedBy: otherAdmin,
        decisionReason: '거절',
        decidedAt: new Date(),
      })
      .where(eq(schema.approvalRequests.id, apply.id));
    await t.db
      .update(schema.approvalRequests)
      .set({ status: 'retracted', retractedAt: new Date() })
      .where(eq(schema.approvalRequests.id, lift.id));
    const next = after(due, 1);
    await run(next);
    expect(await postOf(cited.id)).toMatchObject({ title: null, purgedAt: next });
    expect(await commentOf(comment.id)).toMatchObject({ body: '', purgedAt: next });
    expect(await t.db.select().from(schema.postRevisions)).toEqual([]);
    expect(await t.db.select().from(schema.postCommentRevisions)).toEqual([]);
    expect(await countsAt(next)).toMatchObject({
      deleted_posts: 1,
      deleted_comments: 1,
      post_revisions: 1,
      comment_revisions: 1,
    });
  });

  it('holds, for a pending apply citing a comment, that comment alone, and for a pending shorten or cancellation, the post the restriction cites, until it is decided or retracted (owner decision 2026-10-24 12)', async () => {
    const member = (await createUser(t.db)).user.id;
    const deletedAt = before(new Date(), 50);
    // The apply's subject: a comment the member deleted, under a post they deleted too, each with
    // an earlier version. The request cites the comment alone (ADR-0087 결정 7의 6).
    const parent = await createPost(t.db, {
      marketId,
      authorId: member,
      title: '근거 댓글이 달린 글',
      deletedAt,
    });
    await postRevision(parent.id, deletedAt);
    const comment = await createComment(t.db, {
      postId: parent.id,
      authorId: member,
      body: '요청의 근거 댓글',
      deletedAt,
    });
    const commentRevisionRow = await commentRevision(comment.id, deletedAt);
    const apply = await createApprovalRequest(t.db, {
      kind: 'account_restriction',
      targetType: 'user',
      targetId: member,
      payload: {
        userId: member,
        reason: 'abuse',
        note: '설명',
        days: 7,
        // As the API writes a comment's subject (account-restrictions.service.ts, `targetOf`).
        subject: { type: 'comment', commentId: comment.id, postId: parent.id },
        memo: null,
      },
      requestedBy: admin,
    });
    // Two restrictions that stand, each about a post the member deleted: a shorten asked for on
    // one, a cancellation on the other.
    const changes = [];
    for (const [kind, title] of [
      ['account_restriction_shorten', '감경을 기다리는 제한의 근거 글'],
      ['account_restriction_cancel', '취소를 기다리는 제한의 근거 글'],
    ] as const) {
      const post = await createPost(t.db, { marketId, authorId: member, title, deletedAt });
      const revision = await postRevision(post.id, deletedAt);
      const restriction = await createModerationAction(t.db, {
        userId: member,
        createdBy: admin,
        type: 'account_restriction',
        approvedBy: otherAdmin,
        postId: post.id,
        createdAt: before(deletedAt, -1),
        endsAt: after(new Date(), 30),
      });
      const request = await createApprovalRequest(t.db, {
        kind,
        targetType: 'moderation_action',
        targetId: restriction.id,
        payload: {
          userId: member,
          actionId: restriction.id,
          ...(kind === 'account_restriction_shorten'
            ? { endsAt: after(new Date(), 10).toISOString() }
            : {}),
        },
        requestedBy: admin,
      });
      changes.push({ post, revision, request });
    }
    await setPeriod(DELETED_POSTS_RETENTION_SETTING, 10);
    const revisionIds = async () =>
      (await t.db.select({ id: schema.postRevisions.id }).from(schema.postRevisions))
        .map((row) => row.id)
        .sort();

    const due = after(deletedAt, 10);
    await run(due);
    // The comment's post, which nothing cites, is emptied on time with its earlier version.
    expect(await postOf(parent.id)).toMatchObject({ title: null, purgedAt: due });
    expect(await commentOf(comment.id)).toMatchObject({ body: '요청의 근거 댓글', purgedAt: null });
    expect((await t.db.select().from(schema.postCommentRevisions)).map((row) => row.id)).toEqual([
      commentRevisionRow.id,
    ]);
    for (const { post } of changes) {
      expect(await postOf(post.id)).toMatchObject({ title: post.title, purgedAt: null });
    }
    expect(await revisionIds()).toEqual(changes.map(({ revision }) => revision.id).sort());
    expect(await countsAt(due)).toMatchObject({
      deleted_posts: 1,
      deleted_comments: 0,
      post_revisions: 1,
      comment_revisions: 0,
    });

    // The apply and the shorten rejected, the cancellation retracted: the next run empties them.
    for (const request of [apply, changes[0]!.request]) {
      await t.db
        .update(schema.approvalRequests)
        .set({
          status: 'rejected',
          decidedBy: otherAdmin,
          decisionReason: '거절',
          decidedAt: new Date(),
        })
        .where(eq(schema.approvalRequests.id, request.id));
    }
    await t.db
      .update(schema.approvalRequests)
      .set({ status: 'retracted', retractedAt: new Date() })
      .where(eq(schema.approvalRequests.id, changes[1]!.request.id));
    const next = after(due, 1);
    await run(next);
    expect(await commentOf(comment.id)).toMatchObject({ body: '', purgedAt: next });
    for (const { post } of changes) {
      expect(await postOf(post.id)).toMatchObject({ title: null, purgedAt: next });
    }
    expect(await revisionIds()).toEqual([]);
    expect(await t.db.select().from(schema.postCommentRevisions)).toEqual([]);
    expect(await countsAt(next)).toMatchObject({
      deleted_posts: 2,
      deleted_comments: 1,
      post_revisions: 2,
      comment_revisions: 1,
    });
  });

  it('deletes the actions on a withdrawn member with their end changes and approvals, keeping what is in force or still named', async () => {
    // Owner decision 2026-10-24 3 empties the items a standing hiding still hides and deletes the
    // hiding with them (`hidden_posts`, `hidden_comments` — their own case below); owner decision
    // 2026-10-24 1 deletes the reports the member received, so an action a report names goes with
    // it — kept only while a report processed later than the action still names it.
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
      createdAt: hiddenPost.hiddenAt!,
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
    // The same for a 댓글: a standing hiding of one its author did not delete goes with its emptied
    // item (owner decision 2026-10-24 3, `hidden_comments`), one of a 댓글 its author deleted goes
    // as a moot hiding.
    const hiddenComment = await createComment(t.db, {
      postId: post.id,
      authorId: member,
      hiddenAt: new Date(),
    });
    const standingCommentHide = await createModerationAction(t.db, {
      userId: member,
      createdBy: admin,
      commentId: hiddenComment.id,
      createdAt: hiddenComment.hiddenAt!,
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
    // A live reporter's report the warning resolved: a report the member received, which goes at
    // the same time (owner decision 2026-10-24 1), and the warning after it in the same run.
    const reported = await createModerationAction(t.db, { userId: member, createdBy: admin });
    await createReport(t.db, {
      reporterId: liveReporter,
      reportedUserId: member,
      status: 'actioned',
      resolvedAt: new Date(),
      resolvedBy: admin,
      actionId: reported.id,
    });
    // One whose report was processed twenty days after the withdrawal names it until that report's
    // own period has passed (the foreign key's guard).
    const named = await createModerationAction(t.db, { userId: member, createdBy: admin });
    const namingReport = await createReport(t.db, {
      reporterId: liveReporter,
      reportedUserId: member,
      status: 'actioned',
      resolvedAt: after(new Date(), 20),
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
    expect(await t.db.select().from(schema.moderationActions)).toHaveLength(11);

    const due = after(closedAt, 90);
    await run(due);
    const actions = (await t.db.select().from(schema.moderationActions)).map((row) => row.id);
    expect(actions.sort()).toEqual([lateCancelled.id, named.id, livesAction.id].sort());
    for (const gone of [
      warning,
      cancelledHide,
      restriction,
      mootHide,
      mootCommentHide,
      reported,
      standingHide,
      standingCommentHide,
    ]) {
      expect(actions).not.toContain(gone.id);
    }
    const requests = (await t.db.select().from(schema.approvalRequests)).map((row) => row.id);
    expect(requests).toEqual([grant.id]);
    expect(requests).not.toContain(rejected.id);
    // Six actions of the step and the two hidings that went with their items; the restriction's
    // apply and cancel approvals, and the rejected request.
    expect(await countsAt(due)).toMatchObject({
      moderation_actions: 8,
      approval_requests: 3,
      hidden_posts: 1,
      hidden_comments: 1,
      reports: 1,
    });
    // The items the standing hidings hid stay hidden, emptied; the rest stay as they are.
    expect(await postOf(hiddenPost.id)).toMatchObject({
      hiddenAt: hiddenPost.hiddenAt,
      purgedAt: due,
      title: null,
    });
    expect(await commentOf(hiddenComment.id)).toMatchObject({
      hiddenAt: hiddenComment.hiddenAt,
      purgedAt: due,
      body: '',
    });
    expect((await postOf(post.id)).purgedAt).toBeNull();
    expect((await postOf(deletedHidden.id)).purgedAt).toBeNull();

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
    ).toEqual([named.id, livesAction.id].sort());
    expect(await countsAt(cancelDue)).toMatchObject({ moderation_actions: 1 });

    // The report processed later goes once its own period has passed, and the warning it named
    // with it.
    const namedDue = after(namingReport.resolvedAt!, 90);
    await run(namedDue);
    expect((await t.db.select().from(schema.moderationActions)).map((row) => row.id)).toEqual([
      livesAction.id,
    ]);
    expect(await countsAt(namedDue)).toMatchObject({ reports: 1, moderation_actions: 1 });
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
      { kind: 'consent_records', count: 3, periodDays: 3, ranAt: due, outcome: 'done' },
      { kind: 'consent_records', count: 3, periodDays: 3, ranAt: due, outcome: 'done' },
      { kind: 'consent_records', count: 2, periodDays: 3, ranAt: due, outcome: 'done' },
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
    // The purge records name no person: kind, count, period, instant and outcome only.
    const columns = Object.keys((await t.db.select().from(schema.retentionPurges))[0]!);
    expect(columns.sort()).toEqual(['count', 'id', 'kind', 'outcome', 'periodDays', 'ranAt']);
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

  /**
   * `t.db` whose transactions have every delete from `table` refused — thrown when the statement is
   * built, after the statements before it in the same transaction ran — and the rest as they are.
   */
  function failingDelete(table: unknown) {
    return new Proxy(t.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (...[callback, config]: Parameters<typeof target.transaction>) =>
            target.transaction(
              (tx) =>
                callback(
                  new Proxy(tx, {
                    get(txTarget, txProperty, txReceiver) {
                      if (txProperty === 'delete') {
                        return (deleted: Parameters<typeof txTarget.delete>[0]) => {
                          if (deleted === table) throw new Error('could not serialize access');
                          return txTarget.delete(deleted);
                        };
                      }
                      return Reflect.get(txTarget, txProperty, txReceiver) as unknown;
                    },
                  }),
                ),
              config,
            );
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  }

  /** `t.db` with its `failing`-th transaction refused (counted from 1), the others as they are. */
  function failingTransaction(failing: number) {
    let calls = 0;
    return new Proxy(t.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (...args: Parameters<typeof target.transaction>) => {
            calls += 1;
            return calls === failing
              ? Promise.reject(new Error('could not serialize access'))
              : target.transaction(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  }

  it('goes on past a kind that fails, reporting it and recording it as failed (0, the run’s instant) in place of its 0', async () => {
    const id = (await createUser(t.db)).user.id;
    await createConsents(t.db, { userId: id });
    const closedAt = await closeAccount(t.db, id);
    await setPeriod(CONSENT_RECORDS_RETENTION_SETTING, 1);
    // The first transaction of the run — the nickname holds' — is refused.
    const now = after(closedAt, 1);
    const outcome = await purgeExpiredRecords(failingTransaction(1), storage, { now });
    expect(
      outcome.kindFailures.map(({ kind, message, recorded }) => ({ kind, message, recorded })),
    ).toEqual([{ kind: 'nickname_holds', message: 'could not serialize access', recorded: true }]);
    expect(await t.db.select().from(schema.consentRecords)).toEqual([]);
    // Owner decision 2026-10-24 14: the failure is in the records, with the period, the run's
    // instant and no count, where a kind that finished looking has its 0.
    expect(await purgeRecords()).toEqual([
      { kind: 'nickname_holds', count: 0, periodDays: 30, ranAt: now, outcome: 'failed' },
      { kind: 'consent_records', count: 4, periodDays: 1, ranAt: now, outcome: 'done' },
    ]);
  });

  it('records a kind that fails after a batch committed: the batch as done, then the failure', async () => {
    const users = [];
    for (let i = 0; i < 2; i += 1) {
      const id = (await createUser(t.db)).user.id;
      await createConsents(t.db, { userId: id });
      users.push(id);
    }
    let closedAt = new Date(0);
    for (const id of users) closedAt = await closeAccount(t.db, id);
    await setPeriod(CONSENT_RECORDS_RETENTION_SETTING, 3);
    const now = after(closedAt, 3);
    // Transactions: the nickname holds' (1), then the consent records' first batch of 3 (2) and
    // its second (3), refused.
    const outcome = await purgeExpiredRecords(failingTransaction(3), storage, { now, batch: 3 });
    expect(outcome.kindFailures.map(({ kind }) => kind)).toEqual(['consent_records']);
    expect((await purgeRecords()).filter((row) => row.kind === 'consent_records')).toEqual([
      { kind: 'consent_records', count: 3, periodDays: 3, ranAt: now, outcome: 'done' },
      { kind: 'consent_records', count: 0, periodDays: 3, ranAt: now, outcome: 'failed' },
    ]);
    expect(await t.db.select().from(schema.consentRecords)).toHaveLength(5);
    expect(outcome.kinds.find((kind) => kind.kind === 'consent_records')).toMatchObject({
      deleted: 3,
    });
    // The next run tries again and finishes it.
    const next = after(now, 1);
    await run(next);
    expect(await t.db.select().from(schema.consentRecords)).toEqual([]);
    expect(await countsAt(next)).toEqual({ consent_records: 5 });
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
        { kind: 'nickname_holds', count: 0, periodDays: 30, ranAt: outcome.ranAt, outcome: 'done' },
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
