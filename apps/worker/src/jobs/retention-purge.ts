import { getReleaseSetting, schema, type Db } from '@buddha/db';
import {
  NICKNAME_HOLD_PURGE_DAYS,
  RELEASE_SETTINGS,
  RETENTION_PERIOD_SETTINGS,
  RETENTION_PURGE_KIND_PERIODS,
  retentionCutoffOf,
  type ReleaseSettingStatus,
  type RetentionPeriod,
  type RetentionPurgeKind,
} from '@buddha/shared';
import { type ObjectStorage } from '@buddha/storage';
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import { messageOf } from './scan.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * At most this many records of one kind per transaction. A kind with more due is processed over
 * several transactions of the same run, each recording what it deleted, so no transaction holds its
 * locks long; the run goes on until a batch finds fewer than this.
 */
export const RETENTION_PURGE_BATCH = 500;

/** One object the run could not remove from the store: its row is gone already. */
export interface RetentionStorageFailure {
  storageKey: string;
  /** `messageOf(err)`: the job result is JSON. */
  message: string;
  /** The thrown value itself, for the log line. */
  err: unknown;
}

/** What a run did with one kind. */
export interface RetentionKindOutcome {
  kind: RetentionPurgeKind;
  /** The period's status as the run read it; `fixed` for the nickname holds' 30 days. */
  status: ReleaseSettingStatus | 'fixed';
  /** The period applied, in days; null when the kind was not processed (not approved). */
  periodDays: number | null;
  /** Records deleted (0 when not processed). */
  deleted: number;
}

/** A kind the run gave up on: a batch's transaction rejected, and the run moved on. */
export interface RetentionKindFailure {
  kind: RetentionPurgeKind;
  /** `messageOf(err)`: the job result is JSON. */
  message: string;
  /** The thrown value itself, for the log line. */
  err: unknown;
}

export interface RetentionPurgeOutcome {
  /** The run's instant: the end of every period it applied. */
  ranAt: Date;
  kinds: RetentionKindOutcome[];
  /** Image objects the store would not remove (logged; nothing names them any more). */
  failed: number;
  failures: RetentionStorageFailure[];
  /** Kinds whose processing failed this run (logged; the next run tries again). */
  kindFailures: RetentionKindFailure[];
}

export interface RetentionPurgeOptions {
  /** The run's instant; default the database clock. Tests move it past a period. */
  now?: Date;
  batch?: number;
}

/** What one batch did: how many it took up, what it deleted by kind, and the objects to remove. */
interface Batch {
  /** Records the batch selected — fewer than the batch size means the kind is done. */
  selected: number;
  deleted: Partial<Record<RetentionPurgeKind, number>>;
  storageKeys: string[];
}

interface Window {
  /** Records whose period started at or before this are due (`retentionCutoffOf`). */
  cutoff: Date;
  /** The run's instant. */
  now: Date;
  limit: number;
}

type Step = (tx: Tx, window: Window) => Promise<Batch>;

const ts = (date: Date) => sql`${date.toISOString()}::timestamptz`;

/** No report about the item `column` names (a post's or a comment's id) is waiting to be processed. */
function noPendingReport(on: 'post' | 'comment', column: SQLWrapper): SQL {
  const { reports } = schema;
  const target = on === 'post' ? reports.postId : reports.commentId;
  return sql`NOT EXISTS (SELECT 1 FROM ${reports} WHERE ${target} = ${column} AND ${reports.status} = 'pending')`;
}

/**
 * The post images of `postIds` that no version of their post shows any more — not the post as it
 * stands (an emptied original shows none) nor an earlier version still kept — with their media rows:
 * an image belongs to one post (`post_images`), so nothing else can show it. Under the posts' locks,
 * taken first: an edit in flight that puts an earlier image back has committed by then, and its
 * post's `image_ids` names it. Returns the storage keys to remove after the commit.
 */
async function dropUnusedPostImages(tx: Tx, postIds: string[]): Promise<string[]> {
  if (postIds.length === 0) return [];
  const { posts, postImages, postRevisions, mediaObjects } = schema;
  await tx
    .select({ id: posts.id })
    .from(posts)
    .where(inArray(posts.id, postIds))
    .orderBy(asc(posts.id))
    .for('update');
  const unused = await tx
    .delete(postImages)
    .where(
      and(
        inArray(postImages.postId, postIds),
        sql`NOT EXISTS (SELECT 1 FROM ${posts} WHERE ${posts.id} = ${postImages.postId} AND ${postImages.mediaId} = ANY(${posts.imageIds}))`,
        sql`NOT EXISTS (SELECT 1 FROM ${postRevisions} WHERE ${postRevisions.postId} = ${postImages.postId} AND ${postImages.mediaId} = ANY(${postRevisions.imageIds}))`,
      ),
    )
    .returning({ mediaId: postImages.mediaId });
  if (unused.length === 0) return [];
  const removed = await tx
    .delete(mediaObjects)
    .where(
      inArray(
        mediaObjects.id,
        unused.map((row) => row.mediaId),
      ),
    )
    .returning({ storageKey: mediaObjects.storageKey });
  return removed.map((row) => row.storageKey);
}

/**
 * The nickname holds past NICKNAME_HOLD_DAYS (#57-6 «30일 남는다»; nickname_holds' doc): they hold
 * nothing any more — `nickname_held()` and the take-back of a cancelled reset read only the last 30
 * days — so they go whatever the settings say. First, so an action whose reset's hold has ended can
 * go in the same run.
 */
const nicknameHolds: Step = async (tx, { cutoff, limit }) => {
  const { nicknameHolds: holds } = schema;
  const due = await tx
    .select({ id: holds.id })
    .from(holds)
    .where(lte(holds.releasedAt, cutoff))
    .orderBy(asc(holds.releasedAt), asc(holds.id))
    .limit(limit)
    .for('update', { skipLocked: true });
  if (due.length > 0) {
    await tx.delete(holds).where(
      inArray(
        holds.id,
        due.map((row) => row.id),
      ),
    );
  }
  return { selected: due.length, deleted: { nickname_holds: due.length }, storageKeys: [] };
};

/**
 * Earlier versions of posts (#45-4) replaced at or before the cutoff — counted from the replacement
 * whatever became of the author (ADR-0069 decision 7) — then the images only they used. Not while a
 * report about the post waits: its processing reads them (decision 7 «처리 전에는 지우지 않는다»).
 * buddha_app holds no UPDATE of the table, so no row lock: nothing else ever changes or deletes a
 * version, and the job runs one at a time.
 */
const postRevisions: Step = async (tx, { cutoff, limit }) => {
  const { postRevisions: revisions } = schema;
  const deleted = await tx
    .delete(revisions)
    .where(
      inArray(
        revisions.id,
        tx
          .select({ id: revisions.id })
          .from(revisions)
          .where(and(lte(revisions.replacedAt, cutoff), noPendingReport('post', revisions.postId)))
          .orderBy(asc(revisions.replacedAt), asc(revisions.id))
          .limit(limit),
      ),
    )
    .returning({ postId: revisions.postId });
  const storageKeys = await dropUnusedPostImages(tx, [
    ...new Set(deleted.map((row) => row.postId)),
  ]);
  return { selected: deleted.length, deleted: { post_revisions: deleted.length }, storageKeys };
};

/** The same for the earlier versions of comments, which have no images. */
const commentRevisions: Step = async (tx, { cutoff, limit }) => {
  const { postCommentRevisions: revisions } = schema;
  const deleted = await tx
    .delete(revisions)
    .where(
      inArray(
        revisions.id,
        tx
          .select({ id: revisions.id })
          .from(revisions)
          .where(
            and(lte(revisions.replacedAt, cutoff), noPendingReport('comment', revisions.commentId)),
          )
          .orderBy(asc(revisions.replacedAt), asc(revisions.id))
          .limit(limit),
      ),
    )
    .returning({ id: revisions.id });
  return {
    selected: deleted.length,
    deleted: { comment_revisions: deleted.length },
    storageKeys: [],
  };
};

/**
 * Deleted posts (#45-5) whose period has passed since the deletion — since the withdrawal for a
 * withdrawn author (decision 4 #184: the later of the two, GREATEST ignoring a NULL `closed_at`) —
 * emptied in place, then the images only they used. The row stays: comments under it, likes,
 * reports and actions name it, and the public placeholder reads `deleted_at`. Not while a report
 * about it waits.
 */
const deletedPosts: Step = async (tx, { cutoff, now, limit }) => {
  const { posts, profiles } = schema;
  const due = await tx
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(profiles, eq(profiles.userId, posts.authorId))
    .where(
      and(
        isNotNull(posts.deletedAt),
        isNull(posts.purgedAt),
        lte(posts.deletedAt, cutoff),
        sql`GREATEST(${posts.deletedAt}, ${profiles.closedAt}) <= ${ts(cutoff)}`,
        noPendingReport('post', posts.id),
      ),
    )
    .orderBy(asc(posts.deletedAt), asc(posts.id))
    .limit(limit)
    .for('update', { of: posts, skipLocked: true });
  const ids = due.map((row) => row.id);
  if (ids.length > 0) {
    await tx
      .update(posts)
      .set({
        title: null,
        body: { type: 'doc', content: [] },
        bodyText: '',
        imageIds: [],
        purgedAt: now,
      })
      .where(inArray(posts.id, ids));
  }
  const storageKeys = await dropUnusedPostImages(tx, ids);
  return { selected: ids.length, deleted: { deleted_posts: ids.length }, storageKeys };
};

/** Deleted 댓글 and 대댓글, as deleted posts: emptied in place once their period has passed. */
const deletedComments: Step = async (tx, { cutoff, now, limit }) => {
  const { postComments, profiles } = schema;
  const due = await tx
    .select({ id: postComments.id })
    .from(postComments)
    .innerJoin(profiles, eq(profiles.userId, postComments.authorId))
    .where(
      and(
        isNotNull(postComments.deletedAt),
        isNull(postComments.purgedAt),
        lte(postComments.deletedAt, cutoff),
        sql`GREATEST(${postComments.deletedAt}, ${profiles.closedAt}) <= ${ts(cutoff)}`,
        noPendingReport('comment', postComments.id),
      ),
    )
    .orderBy(asc(postComments.deletedAt), asc(postComments.id))
    .limit(limit)
    .for('update', { of: postComments, skipLocked: true });
  const ids = due.map((row) => row.id);
  if (ids.length > 0) {
    await tx
      .update(postComments)
      .set({ body: '', purgedAt: now })
      .where(inArray(postComments.id, ids));
  }
  return { selected: ids.length, deleted: { deleted_comments: ids.length }, storageKeys: [] };
};

/**
 * Reports a withdrawn account sent (#57-18 «신고 … 기록»; decision 7 «탈퇴한 계정의 신고»), processed,
 * once the period has passed since the later of the withdrawal and the processing. A pending one
 * stays until it is processed (decision 7), and a live reporter's stay (its own record, read at
 * `GET /me/reports`).
 */
const reports: Step = async (tx, { cutoff, limit }) => {
  const { reports: table, profiles } = schema;
  const due = await tx
    .select({ id: table.id })
    .from(table)
    .innerJoin(profiles, eq(profiles.userId, table.reporterId))
    .where(
      and(
        ne(table.status, 'pending'),
        lte(profiles.closedAt, cutoff),
        lte(table.resolvedAt, cutoff),
      ),
    )
    .orderBy(asc(profiles.closedAt), asc(table.id))
    .limit(limit)
    .for('update', { of: table, skipLocked: true });
  const ids = due.map((row) => row.id);
  if (ids.length > 0) await tx.delete(table).where(inArray(table.id, ids));
  return { selected: ids.length, deleted: { reports: ids.length }, storageKeys: [] };
};

/**
 * What an operator took away from a profile (#37-10), once the period has passed since the action
 * — since the withdrawal for a withdrawn member — with the removed image's row and object. The
 * action itself is a 신고·제재 기록 of its own period (`moderationActions`). buddha_app holds no
 * UPDATE of the table: no row lock, as the versions.
 */
const removedProfileItems: Step = async (tx, { cutoff, limit }) => {
  const { profileItemRemovals, moderationActions, profiles, mediaObjects } = schema;
  const deleted = await tx
    .delete(profileItemRemovals)
    .where(
      inArray(
        profileItemRemovals.actionId,
        tx
          .select({ actionId: profileItemRemovals.actionId })
          .from(profileItemRemovals)
          .innerJoin(moderationActions, eq(moderationActions.id, profileItemRemovals.actionId))
          .innerJoin(profiles, eq(profiles.userId, moderationActions.userId))
          .where(
            and(
              lte(moderationActions.createdAt, cutoff),
              or(isNull(profiles.closedAt), lte(profiles.closedAt, cutoff)),
            ),
          )
          .orderBy(asc(moderationActions.createdAt), asc(profileItemRemovals.actionId))
          .limit(limit),
      ),
    )
    .returning({ imageId: profileItemRemovals.imageId });
  const imageIds = deleted.flatMap((row) => (row.imageId === null ? [] : [row.imageId]));
  const removed =
    imageIds.length === 0
      ? []
      : await tx
          .delete(mediaObjects)
          .where(inArray(mediaObjects.id, imageIds))
          .returning({ storageKey: mediaObjects.storageKey });
  return {
    selected: deleted.length,
    deleted: { removed_profile_items: deleted.length },
    storageKeys: removed.map((row) => row.storageKey),
  };
};

/**
 * The approval requests to delete with `actionIds` (#139): the approvals the actions and their end
 * changes came in by, and every request about those actions (a rejected or retracted change too).
 */
async function requestsOf(tx: Tx, actionIds: string[]): Promise<string[]> {
  const { approvalRequests, moderationActions, restrictionEndChanges } = schema;
  const linked = await tx
    .select({
      approvalId: moderationActions.approvalId,
      cancelId: moderationActions.cancelApprovalId,
    })
    .from(moderationActions)
    .where(inArray(moderationActions.id, actionIds));
  const changes = await tx
    .select({ approvalId: restrictionEndChanges.approvalId })
    .from(restrictionEndChanges)
    .where(inArray(restrictionEndChanges.actionId, actionIds));
  const about = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.targetType, 'moderation_action'),
        inArray(approvalRequests.targetId, actionIds),
      ),
    );
  return [
    ...new Set(
      [
        ...linked.flatMap((row) => [row.approvalId, row.cancelId]),
        ...changes.map((row) => row.approvalId),
        ...about.map((row) => row.id),
      ].filter((id): id is string => id !== null),
    ),
  ];
}

/**
 * Deletes, of `ids`, the account restriction requests about withdrawn members that nothing names any
 * more, through migration 0042's `retention_delete_approval_requests` (buddha_app holds no DELETE of
 * the table). Returns how many it deleted.
 */
async function deleteRequests(tx: Tx, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { rows } = await tx.execute<{ deleted: number }>(
    sql`SELECT retention_delete_approval_requests(ARRAY[${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[]) AS deleted`,
  );
  return Number(rows[0]?.deleted ?? 0);
}

/**
 * The actions on a withdrawn member (#57-18 «제재 … 기록»): warnings, hidings, the profile actions,
 * writing and account restrictions — with their end changes (감경·조기 해제) and the approval requests
 * they came in by — once the period has passed since the later of the withdrawal and the last of
 * the action's processing (its time, its cancellation, a restriction's end, its last end change).
 * Kept while it is in force — a hiding not cancelled whose item its author has not deleted (the item
 * stays hidden by it, and only its cancellation shows it again) or a restriction not cancelled whose
 * end has not come — while a request about it waits, and while anything still
 * kept names it: a report (a live reporter's), what a profile action took away, or a nickname
 * reset's hold within its 30 days (each goes first, by its own rule). A live member's actions are
 * kept.
 */
const moderationActions: Step = async (tx, { cutoff, now, limit }) => {
  const {
    moderationActions: actions,
    profiles,
    reports: reportsTable,
    profileItemRemovals,
    nicknameHolds: holds,
    approvalRequests,
    restrictionEndChanges,
    posts,
    postComments,
  } = schema;
  const due = await tx
    .select({ id: actions.id })
    .from(actions)
    .innerJoin(profiles, eq(profiles.userId, actions.userId))
    .where(
      and(
        lte(profiles.closedAt, cutoff),
        lte(actions.createdAt, cutoff),
        or(isNull(actions.cancelledAt), lte(actions.cancelledAt, cutoff)),
        or(isNotNull(actions.cancelledAt), isNull(actions.endsAt), lte(actions.endsAt, cutoff)),
        sql`NOT EXISTS (SELECT 1 FROM ${restrictionEndChanges} WHERE ${restrictionEndChanges.actionId} = ${actions.id} AND ${restrictionEndChanges.createdAt} > ${ts(cutoff)})`,
        // In force: a hiding not cancelled of an item its author has not deleted (a deleted one
        // shows as deleted whatever hid it), a restriction not cancelled whose end has not come.
        sql`NOT (${actions.cancelledAt} IS NULL AND ((${actions.type} = 'hide' AND (EXISTS (SELECT 1 FROM ${posts} WHERE ${posts.id} = ${actions.postId} AND ${posts.deletedAt} IS NULL) OR EXISTS (SELECT 1 FROM ${postComments} WHERE ${postComments.id} = ${actions.commentId} AND ${postComments.deletedAt} IS NULL))) OR (${actions.type} IN ('writing_restriction', 'account_restriction') AND (${actions.endsAt} IS NULL OR ${actions.endsAt} > ${ts(now)}))))`,
        sql`NOT EXISTS (SELECT 1 FROM ${reportsTable} WHERE ${reportsTable.actionId} = ${actions.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${profileItemRemovals} WHERE ${profileItemRemovals.actionId} = ${actions.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${holds} WHERE ${holds.actionId} = ${actions.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${approvalRequests} WHERE ${approvalRequests.targetType} = 'moderation_action' AND ${approvalRequests.targetId} = ${actions.id}::text AND ${approvalRequests.status} = 'pending')`,
      ),
    )
    .orderBy(asc(profiles.closedAt), asc(actions.id))
    .limit(limit)
    .for('update', { of: actions, skipLocked: true });
  const ids = due.map((row) => row.id);
  if (ids.length === 0) {
    return { selected: 0, deleted: { moderation_actions: 0 }, storageKeys: [] };
  }
  const requestIds = await requestsOf(tx, ids);
  await tx.delete(restrictionEndChanges).where(inArray(restrictionEndChanges.actionId, ids));
  await tx.delete(actions).where(inArray(actions.id, ids));
  const requests = await deleteRequests(tx, requestIds);
  return {
    selected: ids.length,
    deleted: { moderation_actions: ids.length, approval_requests: requests },
    storageKeys: [],
  };
};

/**
 * The account restriction requests about a withdrawn member that no action came of — rejected
 * (the closure's '탈퇴' among them) or retracted — once the period has passed since the later of
 * the withdrawal and the decision. A pending one waits (decision 7); an approved one goes with its
 * action (`moderationActions`). An admin grant's requests (#171) are operational records: never.
 */
const approvalRequests: Step = async (tx, { cutoff, limit }) => {
  const { approvalRequests: requests, profiles, moderationActions: actions } = schema;
  const due = await tx
    .select({ id: requests.id })
    .from(requests)
    .innerJoin(profiles, eq(profiles.userId, requests.targetId))
    .where(
      and(
        eq(requests.kind, 'account_restriction'),
        eq(requests.targetType, 'user'),
        ne(requests.status, 'pending'),
        lte(profiles.closedAt, cutoff),
        sql`COALESCE(${requests.decidedAt}, ${requests.retractedAt}) <= ${ts(cutoff)}`,
        sql`NOT EXISTS (SELECT 1 FROM ${actions} WHERE ${actions.approvalId} = ${requests.id} OR ${actions.cancelApprovalId} = ${requests.id})`,
      ),
    )
    .orderBy(asc(profiles.closedAt), asc(requests.id))
    .limit(limit)
    .for('update', { of: requests, skipLocked: true });
  const deleted = await deleteRequests(
    tx,
    due.map((row) => row.id),
  );
  // The function deletes only what it may, and a row it left would be selected again: the run goes
  // on while a full batch deletes something and stops at one that deletes nothing
  // (`purgeExpiredRecords`), so it never loops on rows the function keeps. The WHERE above asks
  // what the function asks of an apply, so in practice it keeps none of them.
  return { selected: due.length, deleted: { approval_requests: deleted }, storageKeys: [] };
};

/**
 * A withdrawn account's consent records (#57-18 «동의 기록»), once the period has passed since the
 * withdrawal. A live account's are its standing consent: never. No row lock (no UPDATE of the
 * table for buddha_app, and nothing changes a record).
 */
const consentRecords: Step = async (tx, { cutoff, limit }) => {
  const { consentRecords: records, profiles } = schema;
  const deleted = await tx
    .delete(records)
    .where(
      inArray(
        records.id,
        tx
          .select({ id: records.id })
          .from(records)
          .innerJoin(profiles, eq(profiles.userId, records.userId))
          .where(lte(profiles.closedAt, cutoff))
          .orderBy(asc(profiles.closedAt), asc(records.id))
          .limit(limit),
      ),
    )
    .returning({ id: records.id });
  return {
    selected: deleted.length,
    deleted: { consent_records: deleted.length },
    storageKeys: [],
  };
};

/**
 * A withdrawn account's 본인확인 기록 — its code sends, number, real name and client address in plain
 * text (ADR-0070 2차 답 1) — once the period has passed since the withdrawal. A live account keeps
 * them. A closed account sends no more (migration 0041), so nothing is written to them meanwhile.
 */
const phoneVerificationRecords: Step = async (tx, { cutoff, limit }) => {
  const { phoneVerificationCodes: codes, profiles } = schema;
  const deleted = await tx
    .delete(codes)
    .where(
      inArray(
        codes.id,
        tx
          .select({ id: codes.id })
          .from(codes)
          .innerJoin(profiles, eq(profiles.userId, codes.userId))
          .where(lte(profiles.closedAt, cutoff))
          .orderBy(asc(profiles.closedAt), asc(codes.id))
          .limit(limit),
      ),
    )
    .returning({ id: codes.id });
  return {
    selected: deleted.length,
    deleted: { phone_verification_records: deleted.length },
    storageKeys: [],
  };
};

/**
 * The steps in the order a run takes them (RETENTION_PURGE_KINDS): each kind before what it names —
 * a report before its action, a removed profile item and an ended hold before theirs, an action
 * before its requests — and the versions before the originals, so an original's images are judged
 * against the versions still kept.
 */
const STEPS: readonly { kind: RetentionPurgeKind; step: Step }[] = [
  { kind: 'nickname_holds', step: nicknameHolds },
  { kind: 'post_revisions', step: postRevisions },
  { kind: 'comment_revisions', step: commentRevisions },
  { kind: 'deleted_posts', step: deletedPosts },
  { kind: 'deleted_comments', step: deletedComments },
  { kind: 'reports', step: reports },
  { kind: 'removed_profile_items', step: removedProfileItems },
  { kind: 'moderation_actions', step: moderationActions },
  { kind: 'approval_requests', step: approvalRequests },
  { kind: 'consent_records', step: consentRecords },
  { kind: 'phone_verification_records', step: phoneVerificationRecords },
];

/** Each period's reading at the run's start: the days when approved, else null (not processed). */
async function readPeriods(
  db: Db,
): Promise<Record<RetentionPeriod, { status: ReleaseSettingStatus; days: number | null }>> {
  const entries = await Promise.all(
    Object.entries(RETENTION_PERIOD_SETTINGS).map(async ([period, definition]) => {
      const reading = await getReleaseSetting(db, RELEASE_SETTINGS, definition);
      // ADR-0069 decision 7: only an approved value deletes; undecided, proposal and test keep.
      const days = reading.status === 'approved' ? reading.value : null;
      return [period, { status: reading.status, days }] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<
    RetentionPeriod,
    { status: ReleaseSettingStatus; days: number | null }
  >;
}

/**
 * `retention.purge` (#184, ADR-0069 decision 1 #57-18, decision 4 #184 and decision 7): deletes
 * what has kept its retention period, kind by kind (STEPS), and records each kind's count. Daily
 * (JOB_SCHEDULES).
 *
 * - The run's instant is read once (the database clock), and each period's release setting once
 *   when the run starts (ADR-0055: a value applies to the work that starts after it changed). A
 *   period whose status is not `approved` is not applied: its kinds are left as they are and get
 *   no record (decision 7). The nickname holds' 30 days are fixed (#57-6).
 * - A kind is processed in transactions of at most `batch` records; each writes a
 *   `retention_purges` row for each kind it deleted from, in the same transaction, and a kind the
 *   run found nothing due in gets one row of 0 — the record says the run looked.
 * - A kind whose batch fails is reported and the run goes on to the next kind (its earlier batches
 *   stand, recorded); the next run tries it again.
 * - Image objects go after their transaction commits; one the store will not remove is logged and
 *   left, named by nothing (the rows are gone). #46's `media_deletions` queue takes them once the
 *   branch is restacked onto it (ADR-0087 결과 5).
 * - The ledger, orders, watch events, likes, posts not deleted, start grants and the operational
 *   records are never touched: no step names them.
 */
export async function purgeExpiredRecords(
  db: Db,
  storage: ObjectStorage,
  options: RetentionPurgeOptions = {},
): Promise<RetentionPurgeOutcome> {
  const limit = options.batch ?? RETENTION_PURGE_BATCH;
  const now =
    options.now ??
    (await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`)).rows[0]!.now;
  const ranAt = new Date(now);
  const periods = await readPeriods(db);
  const failures: RetentionStorageFailure[] = [];
  const kindFailures: RetentionKindFailure[] = [];
  const totals: Partial<Record<RetentionPurgeKind, number>> = {};
  const outcomes: RetentionKindOutcome[] = [];

  for (const { kind, step } of STEPS) {
    const period = RETENTION_PURGE_KIND_PERIODS[kind];
    const reading =
      period === null
        ? { status: 'fixed' as const, days: NICKNAME_HOLD_PURGE_DAYS }
        : periods[period];
    if (reading.days === null) {
      outcomes.push({ kind, status: reading.status, periodDays: null, deleted: 0 });
      continue;
    }
    const days = reading.days;
    const window: Window = { cutoff: retentionCutoffOf(ranAt, days), now: ranAt, limit };
    try {
      for (;;) {
        const batch = await db.transaction(async (tx) => {
          const done = await step(tx, window);
          const rows = Object.entries(done.deleted).flatMap(([deletedKind, count]) =>
            count && count > 0 ? [{ kind: deletedKind, count, periodDays: days, ranAt }] : [],
          );
          if (rows.length > 0) await tx.insert(schema.retentionPurges).values(rows);
          return done;
        });
        for (const [deletedKind, count] of Object.entries(batch.deleted)) {
          const key = deletedKind as RetentionPurgeKind;
          totals[key] = (totals[key] ?? 0) + (count ?? 0);
        }
        for (const storageKey of batch.storageKeys) {
          try {
            await storage.delete(storageKey);
          } catch (err) {
            failures.push({ storageKey, message: messageOf(err), err });
          }
        }
        const deleted = batch.deleted[kind] ?? 0;
        if (batch.selected < limit || deleted === 0) break;
      }
      if ((totals[kind] ?? 0) === 0) {
        await db.insert(schema.retentionPurges).values({ kind, count: 0, periodDays: days, ranAt });
      }
    } catch (err) {
      // A kind that fails does not hold the others back, as a scan's market does not (scan.ts): its
      // batch rolled back with its record, the batches before it stand recorded, and the next run
      // tries it again. No row of 0: the run did not finish looking.
      kindFailures.push({ kind, message: messageOf(err), err });
    }
    outcomes.push({ kind, status: reading.status, periodDays: days, deleted: totals[kind] ?? 0 });
  }
  return {
    ranAt,
    kinds: outcomes,
    failed: failures.length,
    failures,
    kindFailures,
  };
}
