import { getReleaseSetting, schema, type Db } from '@buddha/db';
import {
  ACCOUNT_RESTRICTION_APPROVAL_KINDS,
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

/**
 * A kind the run gave up on: a batch's transaction rejected, and the run moved on. Recorded as a
 * `failed` purge record of 0 (owner decision 2026-10-24 14), unless that write failed too.
 */
export interface RetentionKindFailure {
  kind: RetentionPurgeKind;
  /** `messageOf(err)`: the job result is JSON. */
  message: string;
  /** The thrown value itself, for the log line. */
  err: unknown;
  /** Whether its `failed` record was written (`retention_purges.outcome`). */
  recorded: boolean;
  /** Why it was not: the thrown value, for its own log line; null when it was. */
  recordErr: unknown;
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

/**
 * The kinds of a request to change an account restriction that stands (#139): what it cites is the
 * restriction's.
 */
const RESTRICTION_CHANGE_KINDS = [
  ACCOUNT_RESTRICTION_APPROVAL_KINDS.shorten,
  ACCOUNT_RESTRICTION_APPROVAL_KINDS.lift,
  ACCOUNT_RESTRICTION_APPROVAL_KINDS.cancel,
];

/**
 * Nothing about the item `column` names (a post's or a comment's id) is waiting: no report about it
 * to be processed (ADR-0069 decision 7 «처리 전에는 지우지 않는다»; owner decision 2026-10-24 4), and
 * no account restriction request (#139) to be decided that cites it — an apply whose subject it is
 * (`payload.subject`, the member's post or comment as the API wrote it), or a shorten, lift or
 * cancellation of a restriction about it (`moderation_actions.post_id` / `comment_id`): owner
 * decision 2026-10-24 12 «결정될 때까지 남김». A decision or a retraction ends the wait (the request
 * is no longer `pending`); the period still counts from the deletion or the replacement.
 */
function nothingAwaits(on: 'post' | 'comment', column: SQLWrapper): SQL {
  const { reports, approvalRequests: requests, moderationActions: actions } = schema;
  const reported = on === 'post' ? reports.postId : reports.commentId;
  const cited = on === 'post' ? actions.postId : actions.commentId;
  const subjectId = on === 'post' ? 'postId' : 'commentId';
  return and(
    sql`NOT EXISTS (SELECT 1 FROM ${reports} WHERE ${reported} = ${column} AND ${reports.status} = 'pending')`,
    sql`NOT EXISTS (SELECT 1 FROM ${requests} WHERE ${requests.kind} = ${ACCOUNT_RESTRICTION_APPROVAL_KINDS.apply} AND ${requests.status} = 'pending' AND ${requests.payload} -> 'subject' ->> 'type' = ${on} AND ${requests.payload} -> 'subject' ->> ${subjectId} = ${column}::text)`,
    sql`NOT EXISTS (SELECT 1 FROM ${requests} JOIN ${actions} ON ${actions.id}::text = ${requests.targetId} WHERE ${inArray(requests.kind, RESTRICTION_CHANGE_KINDS)} AND ${requests.targetType} = 'moderation_action' AND ${requests.status} = 'pending' AND ${cited} = ${column})`,
  )!;
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
 * report about the post or an account restriction request citing it waits: its processing or its
 * decision reads them (`nothingAwaits`). buddha_app holds no UPDATE of the table, so no row lock:
 * nothing else ever changes or deletes a version, and the job runs one at a time.
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
          .where(and(lte(revisions.replacedAt, cutoff), nothingAwaits('post', revisions.postId)))
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
            and(lte(revisions.replacedAt, cutoff), nothingAwaits('comment', revisions.commentId)),
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
 * Empties `ids` in place (#184): no title, an empty document, text and image list, and when
 * (`purged_at`, the run's instant — migration 0042's CHECK holds the rest empty from then on).
 */
async function emptyPosts(tx: Tx, ids: string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  const { posts } = schema;
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

/** Empties the comments `ids` in place, as `emptyPosts`: an empty body and when. */
async function emptyComments(tx: Tx, ids: string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  const { postComments } = schema;
  await tx
    .update(postComments)
    .set({ body: '', purgedAt: now })
    .where(inArray(postComments.id, ids));
}

/**
 * Deleted posts (#45-5) whose period has passed since the deletion — since the withdrawal for a
 * withdrawn author (decision 4 #184: the later of the two, GREATEST ignoring a NULL `closed_at`) —
 * emptied in place, then the images only they used. The row stays: comments under it, likes,
 * reports and actions name it, and the public placeholder reads `deleted_at`. Not while a report
 * about it or an account restriction request citing it waits (`nothingAwaits`).
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
        nothingAwaits('post', posts.id),
      ),
    )
    .orderBy(asc(posts.deletedAt), asc(posts.id))
    .limit(limit)
    .for('update', { of: posts, skipLocked: true });
  const ids = due.map((row) => row.id);
  await emptyPosts(tx, ids, now);
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
        nothingAwaits('comment', postComments.id),
      ),
    )
    .orderBy(asc(postComments.deletedAt), asc(postComments.id))
    .limit(limit)
    .for('update', { of: postComments, skipLocked: true });
  const ids = due.map((row) => row.id);
  await emptyComments(tx, ids, now);
  return { selected: ids.length, deleted: { deleted_comments: ids.length }, storageKeys: [] };
};

/**
 * A withdrawn member's posts an operator still hides — hidden and not deleted by their author
 * (owner decision 2026-10-24 3: «기간이 지나면 지운 원문처럼 내용을 비우고(자리 행 남김) 숨김 조치도
 * 지움, 글은 계속 숨김») — once the 신고·제재 기록 period has passed since the later of the
 * withdrawal and the hiding (its standing `hide` action's time, which `hidden_at` precedes within
 * its transaction): emptied in place as a deleted original is (`emptyPosts`, then the images only
 * they used), and their hidings' actions deleted in the same transaction — so an emptied post never
 * has a standing hiding an operator could cancel to show it (migration 0042's CHECK keeps it hidden:
 * `hidden_at` stays). Not while a report about it or an account restriction request citing it
 * waits (`nothingAwaits`), nor while a report not yet due still names the hiding (it goes first,
 * in `reports`, under the same rule from its processing). Each action and its post are locked
 * together and skipped while either is taken (SKIP LOCKED waits for neither): a cancellation in
 * flight keeps both until it commits — the post shown again, the next run passes it by — and one
 * that comes after waits on the action and then finds it gone.
 */
const hiddenPosts: Step = async (tx, { cutoff, now, limit }) => {
  const { posts, profiles, moderationActions: actions, reports: reportsTable } = schema;
  const due = await tx
    .select({ id: posts.id, actionId: actions.id })
    .from(actions)
    .innerJoin(posts, eq(posts.id, actions.postId))
    .innerJoin(profiles, eq(profiles.userId, posts.authorId))
    .where(
      and(
        eq(actions.type, 'hide'),
        isNull(actions.cancelledAt),
        isNotNull(posts.hiddenAt),
        isNull(posts.deletedAt),
        isNull(posts.purgedAt),
        lte(profiles.closedAt, cutoff),
        lte(posts.hiddenAt, cutoff),
        lte(actions.createdAt, cutoff),
        nothingAwaits('post', posts.id),
        sql`NOT EXISTS (SELECT 1 FROM ${reportsTable} WHERE ${reportsTable.actionId} = ${actions.id})`,
      ),
    )
    .orderBy(asc(actions.createdAt), asc(actions.id))
    .limit(limit)
    .for('update', { of: [actions, posts], skipLocked: true });
  const ids = due.map((row) => row.id);
  await emptyPosts(tx, ids, now);
  if (due.length > 0) {
    await tx.delete(actions).where(
      inArray(
        actions.id,
        due.map((row) => row.actionId),
      ),
    );
  }
  const storageKeys = await dropUnusedPostImages(tx, ids);
  return {
    selected: ids.length,
    deleted: { hidden_posts: ids.length, moderation_actions: due.length },
    storageKeys,
  };
};

/** The same for a withdrawn member's 댓글 and 대댓글 an operator still hides (no images). */
const hiddenComments: Step = async (tx, { cutoff, now, limit }) => {
  const { postComments, profiles, moderationActions: actions, reports: reportsTable } = schema;
  const due = await tx
    .select({ id: postComments.id, actionId: actions.id })
    .from(actions)
    .innerJoin(postComments, eq(postComments.id, actions.commentId))
    .innerJoin(profiles, eq(profiles.userId, postComments.authorId))
    .where(
      and(
        eq(actions.type, 'hide'),
        isNull(actions.cancelledAt),
        isNotNull(postComments.hiddenAt),
        isNull(postComments.deletedAt),
        isNull(postComments.purgedAt),
        lte(profiles.closedAt, cutoff),
        lte(postComments.hiddenAt, cutoff),
        lte(actions.createdAt, cutoff),
        nothingAwaits('comment', postComments.id),
        sql`NOT EXISTS (SELECT 1 FROM ${reportsTable} WHERE ${reportsTable.actionId} = ${actions.id})`,
      ),
    )
    .orderBy(asc(actions.createdAt), asc(actions.id))
    .limit(limit)
    .for('update', { of: [actions, postComments], skipLocked: true });
  const ids = due.map((row) => row.id);
  await emptyComments(tx, ids, now);
  if (due.length > 0) {
    await tx.delete(actions).where(
      inArray(
        actions.id,
        due.map((row) => row.actionId),
      ),
    );
  }
  return {
    selected: ids.length,
    deleted: { hidden_comments: ids.length, moderation_actions: due.length },
    storageKeys: [],
  };
};

/**
 * Processed reports (#57-18 «신고 … 기록»; decision 7) a withdrawn account sent, or a withdrawn member
 * received from anyone (owner decision 2026-10-24 1: «탈퇴 뒤 기간이 지나면 지움» — a live reporter's
 * report about a member who withdrew goes from that reporter's own history too, `GET /me/reports`),
 * once the period has passed since the later of that party's withdrawal and the processing: either
 * party's rule makes it due. A pending one stays until it is processed (decision 7). A report
 * between two live accounts stays (owner decision 2026-10-24 2). The actions they name go after
 * them, by their own rule (`hiddenPosts`, `hiddenComments`, `moderationActions`).
 */
const reports: Step = async (tx, { cutoff, limit }) => {
  const { reports: table, profiles } = schema;
  const due = await tx
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        ne(table.status, 'pending'),
        lte(table.resolvedAt, cutoff),
        sql`EXISTS (SELECT 1 FROM ${profiles} WHERE ${profiles.userId} IN (${table.reporterId}, ${table.reportedUserId}) AND ${profiles.closedAt} <= ${ts(cutoff)})`,
      ),
    )
    .orderBy(asc(table.resolvedAt), asc(table.id))
    .limit(limit)
    .for('update', { skipLocked: true });
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
 * stays hidden by it, and only its cancellation shows it again: such a hiding goes with its item's
 * content instead, `hiddenPosts` and `hiddenComments`) or a restriction not cancelled whose end has
 * not come — while a request about it waits, and while anything still kept names it: a report not
 * due yet (processed after the action), what a profile action took away, or a nickname reset's hold
 * within its 30 days (each goes first, by its own rule). A live member's actions are kept.
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
 * a report before its action (a hiding's among them, which goes with its hidden item), a removed
 * profile item and an ended hold before theirs, an action before its requests — and the versions
 * before the originals, so an original's images are judged against the versions still kept.
 */
const STEPS: readonly { kind: RetentionPurgeKind; step: Step }[] = [
  { kind: 'nickname_holds', step: nicknameHolds },
  { kind: 'post_revisions', step: postRevisions },
  { kind: 'comment_revisions', step: commentRevisions },
  { kind: 'deleted_posts', step: deletedPosts },
  { kind: 'deleted_comments', step: deletedComments },
  { kind: 'reports', step: reports },
  { kind: 'hidden_posts', step: hiddenPosts },
  { kind: 'hidden_comments', step: hiddenComments },
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
 * - A kind whose batch fails is reported, recorded as `failed` with a count of 0 (owner decision
 *   2026-10-24 14 — its batch rolled back, its earlier batches stand recorded as `done`), and the
 *   run goes on to the next kind; the next run tries it again.
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
      // tries it again. Its record says so — `failed`, 0, at the run's instant (owner decision
      // 2026-10-24 14) — in place of the 0 of a kind that finished looking; a database that will
      // not take even that leaves the log line alone.
      let recordErr: unknown = null;
      try {
        await db
          .insert(schema.retentionPurges)
          .values({ kind, count: 0, periodDays: days, ranAt, outcome: 'failed' });
      } catch (error) {
        recordErr = error;
      }
      kindFailures.push({
        kind,
        message: messageOf(err),
        err,
        recorded: recordErr === null,
        recordErr,
      });
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
