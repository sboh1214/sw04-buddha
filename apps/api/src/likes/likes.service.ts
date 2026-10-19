import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  type LikeNotAllowedDetails,
  type LikeNotAllowedReason,
  type LikeState,
  type MyPostLikes,
  type OnboardingRequiredDetails,
} from '@buddha/shared';
import { and, asc, eq, or, sql, type SQL } from 'drizzle-orm';
import { commentHasReplies, postHasComments } from '../comments/comment-queries.js';
import { AppError } from '../common/errors/app-error.js';
import { PhoneHasher } from '../identity/phone-hash.js';
import { DB } from '../infra/db/db.provider.js';
import { assertOnboarded } from '../onboarding/onboarded.guard.js';
import { publicStateOf } from '../posts/posts.service.js';
import { commentLikeCountSql, postLikeCountSql } from './like-queries.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/** Who likes: the account, and the keyed hash of its verified number (ADR-0071), when it has one. */
interface Liker {
  userId: string;
  phoneHash: string | null;
}

/**
 * 좋아요 (#49, ADR-0076; ADR-0069 decision 4 #49 rows, decision 7): an account's likes of posts and
 * comments, and what it liked on a post page. Display only: nothing here reads or writes a balance,
 * a ledger entry, an order or a position, sends a notification or ranks anything (D5, N05 §2).
 *
 * A like is a person's, once per target: the row carries the account and the keyed hash of its
 * verified number, and the database holds one per number and one per account (`post_likes`,
 * `comment_likes`). So a person's like is a row of the target with their account, or with their
 * number's hash when the account that made it has no 본인확인 record any more (it withdrew, #140):
 * an account that withdrew and came back on the same number sees its like and can take it back,
 * but cannot like again (decision 7; owner decision 2026-10-20, answer 3). An operator's change of
 * a member's number (#57-3) moves the account's rows to the new number's hash in the same
 * transaction (OPERATOR_PHONE_CHANGE_SQL, owner decision 2026-10-20, answer 2), so a live
 * account's own rows carry its current number and its likes no longer hold the old one. The likes
 * it inherited from a withdrawn account on its old number (that account's rows) are not moved:
 * they stay under the old hash and become the old number's next holder's, who sees them as its
 * own and cannot add one to those targets (ADR-0076 7-20, an owner question in 결과 4). A row of
 * an account that still holds its record is that account's alone all the same: should a number
 * ever change outside that procedure, its next holder neither sees nor takes back the live
 * account's likes, and its like of the same target hits the number's primary key and is answered
 * as not liked, nothing written (ADR-0076 7-3, kept as a guard).
 *
 * Writes and the target's state: a like is written under the target's row held shared
 * (`FOR SHARE`), as a new comment is (CommentsService), so the author's deletion and an operator's
 * hiding (#50), which update that row, wait for it or it for them — no like lands on, or leaves, a
 * target whose deletion or hiding committed. The liker's 본인확인 record is held before it
 * (ADR-0071's order: the record, then what is written for it), FOR KEY SHARE as the start Coin's
 * payment holds it (`isPhoneVerified`): the number the hash was made of stays the account's until
 * the like commits — an operator's change of it and a withdrawal's deletion wait — while the
 * member's edit of the real name does not.
 */
@Injectable()
export class LikesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly hasher: PhoneHasher,
  ) {}

  /**
   * `PUT /posts/:postId/like`: `liked` likes the post, or takes the caller's like back. A second
   * like and an unlike of nothing change nothing. One's own post too (#49). A post of a market in
   * any public status, ended ones included (#49). Refused: a post that is gone or unknown
   * (NOT_FOUND), and a deleted post's placeholder or a hidden post (LIKE_NOT_ALLOWED).
   */
  async setPostLike(userId: string, postId: string, liked: boolean): Promise<LikeState> {
    const { posts, postLikes } = schema;
    return this.db.transaction(async (tx) => {
      const liker = await this.lockLiker(tx, userId);
      const [post] = await tx
        .select({ deletedAt: posts.deletedAt, hiddenAt: posts.hiddenAt })
        .from(posts)
        .where(eq(posts.id, postId))
        .for('share');
      if (!post) throw notFound('Post');
      this.assertTakesLikes(publicStateOf(post, await postHasComments(tx, postId)), 'Post');
      const mine = and(eq(postLikes.postId, postId), likedBy(postLikes, liker));
      const stands = await writeLike(liked, {
        held: async () =>
          (
            await tx
              .select({ one: sql`1` })
              .from(postLikes)
              .where(mine)
              .limit(1)
          ).length > 0,
        insert: async () =>
          (
            await tx
              .insert(postLikes)
              .values({ postId, userId, phoneHash: liker.phoneHash })
              .onConflictDoNothing()
              .returning({ one: sql`1` })
          ).length > 0,
        remove: async () => {
          await tx.delete(postLikes).where(mine);
        },
      });
      const [count] = await tx
        .select({ n: postLikeCountSql(posts.id) })
        .from(posts)
        .where(eq(posts.id, postId));
      return { liked: stands, likeCount: count?.n ?? 0 };
    });
  }

  /**
   * `PUT /comments/:commentId/like`: the same for a 댓글 or a 대댓글 (#49: «근거 글과 댓글·대댓글»).
   * Refused: a comment that is gone (a deleted 대댓글, a deleted 댓글 with nothing under it) or
   * unknown (NOT_FOUND), and a deleted 댓글's placeholder or a hidden comment (LIKE_NOT_ALLOWED).
   * Whether the post above it is hidden or deleted does not matter: the comment is read in full
   * there (ADR-0074 7-5) and the rule names the target (owner decision 2026-10-20, answer 4).
   */
  async setCommentLike(userId: string, commentId: string, liked: boolean): Promise<LikeState> {
    const { postComments, commentLikes } = schema;
    return this.db.transaction(async (tx) => {
      const liker = await this.lockLiker(tx, userId);
      const [comment] = await tx
        .select({ deletedAt: postComments.deletedAt, hiddenAt: postComments.hiddenAt })
        .from(postComments)
        .where(eq(postComments.id, commentId))
        .for('share');
      if (!comment) throw notFound('Comment');
      this.assertTakesLikes(
        publicStateOf(comment, await commentHasReplies(tx, commentId)),
        'Comment',
      );
      const mine = and(eq(commentLikes.commentId, commentId), likedBy(commentLikes, liker));
      const stands = await writeLike(liked, {
        held: async () =>
          (
            await tx
              .select({ one: sql`1` })
              .from(commentLikes)
              .where(mine)
              .limit(1)
          ).length > 0,
        insert: async () =>
          (
            await tx
              .insert(commentLikes)
              .values({ commentId, userId, phoneHash: liker.phoneHash })
              .onConflictDoNothing()
              .returning({ one: sql`1` })
          ).length > 0,
        remove: async () => {
          await tx.delete(commentLikes).where(mine);
        },
      });
      const [count] = await tx
        .select({ n: commentLikeCountSql(postComments.id) })
        .from(postComments)
        .where(eq(postComments.id, commentId));
      return { liked: stands, likeCount: count?.n ?? 0 };
    });
  }

  /**
   * `GET /me/likes/posts/:postId`: whether the caller likes the post, and which of the comments
   * under it — every 댓글 and 대댓글 of the post, whichever page of the thread it is on, in id
   * order. The caller's own likes and nothing about the post: an unknown post, or one out of view,
   * answers what the caller's rows say (nothing, for a post never liked), so the answer tells
   * nobody whether a post exists. Signed in is enough — an account that has not finished the
   * onboarding has liked nothing it could not see.
   */
  async myPostLikes(userId: string, postId: string): Promise<MyPostLikes> {
    const { postLikes, commentLikes, postComments } = schema;
    const liker = await this.likerOf(this.db, userId);
    const [post] = await this.db
      .select({ one: sql`1` })
      .from(postLikes)
      .where(and(eq(postLikes.postId, postId), likedBy(postLikes, liker)))
      .limit(1);
    const comments = await this.db
      .selectDistinct({ id: commentLikes.commentId })
      .from(commentLikes)
      .innerJoin(postComments, eq(postComments.id, commentLikes.commentId))
      .where(and(eq(postComments.postId, postId), likedBy(commentLikes, liker)))
      .orderBy(asc(commentLikes.commentId));
    return { postLiked: post !== undefined, likedCommentIds: comments.map((row) => row.id) };
  }

  /**
   * The checks every like and unlike passes, in its transaction, and the liker it answers: the
   * account's 본인확인 record held FOR KEY SHARE — `phone` is UNIQUE, so changing it waits, and the
   * hash is of the number the account has until the commit — and the onboarding (#57-8), which
   * OnboardedGuard checked before the body was read, held to the commit here. Deliberately not
   * CommentsService's `checkWriter` or PostsService's: a writing restriction (#185) does not stop
   * a like (#45-12), and #187's frequency limits are the writers'. Bot and system accounts (#115)
   * do not exist yet; the check that keeps their likes out of a count goes here when they do
   * (ADR-0069 decision 4 #49: «아직 없어 묻지 않았다»).
   */
  private async lockLiker(tx: Tx, userId: string): Promise<Liker & { phoneHash: string }> {
    const [verified] = await tx
      .select({ phone: schema.phoneVerifications.phone })
      .from(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, userId))
      .limit(1)
      .for('key share');
    await assertOnboarded(tx, userId);
    // The onboarding includes 본인확인, so the record is there unless one was written between the
    // read above and the onboarding's check: the same refusal as if the check had seen it missing.
    if (!verified) {
      const details: OnboardingRequiredDetails = { steps: ['verification'] };
      throw new AppError('ONBOARDING_REQUIRED', { message: 'The onboarding is not done', details });
    }
    return { userId, phoneHash: this.hasher.hash(verified.phone) };
  }

  /** The caller as a read matches its likes: by account, and by number when it has one. */
  private async likerOf(executor: Executor, userId: string): Promise<Liker> {
    const [verified] = await executor
      .select({ phone: schema.phoneVerifications.phone })
      .from(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, userId))
      .limit(1);
    return { userId, phoneHash: verified ? this.hasher.hash(verified.phone) : null };
  }

  /**
   * A target takes likes while the public sees it in full (#49: «지운·숨긴 글은 받지 않고»): one
   * gone from every view is NOT_FOUND, as to the public; a placeholder shows no count to change.
   */
  private assertTakesLikes(
    state: ReturnType<typeof publicStateOf>,
    target: 'Post' | 'Comment',
  ): void {
    switch (state) {
      case 'gone':
        throw notFound(target);
      case 'deleted':
      case 'hidden':
        throw likeNotAllowed(state);
      case 'published':
        return;
    }
  }
}

/**
 * A like row of `liker`'s: their account's, or their number's when the account that made it holds
 * no 본인확인 record any more — it withdrew (#140 deletes the record and keeps the likes, #37-17),
 * and the number's like carries on to whoever verifies it next (decision 7; owner decision
 * 2026-10-20, answer 3). Never another live account's (ADR-0069 decision 4 #49: «본인은 자기가
 * 눌렀는지 본다»). The operator's number change moves a live account's rows to its new number
 * (owner decision 2026-10-20, answer 2), so no live account's row carries another account's
 * number and matching the hash alone would answer the same; the check stays as a guard for a
 * number changed outside that procedure (ADR-0076 7-3). `phone_verifications` is keyed by the
 * account, so it is one probe of its primary key per row.
 */
function likedBy(table: typeof schema.postLikes | typeof schema.commentLikes, liker: Liker): SQL {
  const byAccount = eq(table.userId, liker.userId);
  if (liker.phoneHash === null) return byAccount;
  const { phoneVerifications } = schema;
  const withdrawn = sql`NOT EXISTS (SELECT 1 FROM ${phoneVerifications} WHERE ${phoneVerifications.userId} = ${table.userId})`;
  return or(byAccount, and(eq(table.phoneHash, liker.phoneHash), withdrawn)) ?? byAccount;
}

/**
 * One like or unlike, and whether the caller's like stands after it. An unlike removes the
 * caller's rows. A like adds one unless the caller's is there; the insert names no conflict
 * target, so either key's conflict leaves it unwritten — the same account's twin request that
 * committed meanwhile (the UNIQUE), or another account's like under the same number's hash (the
 * primary key). Read again then (READ COMMITTED: the read sees what committed before it): the
 * twin's row is the caller's like, so it stands; a live account's row on the caller's number —
 * which only a number changed outside the operator's procedure leaves — is not, so the answer
 * says not liked and nothing was written (decision 7-3).
 */
async function writeLike(
  liked: boolean,
  rows: {
    held: () => Promise<boolean>;
    insert: () => Promise<boolean>;
    remove: () => Promise<void>;
  },
): Promise<boolean> {
  if (!liked) {
    await rows.remove();
    return false;
  }
  if (await rows.held()) return true;
  if (await rows.insert()) return true;
  return rows.held();
}

function notFound(target: 'Post' | 'Comment'): AppError {
  return new AppError('NOT_FOUND', { message: `${target} not found` });
}

function likeNotAllowed(reason: LikeNotAllowedReason): AppError {
  const details: LikeNotAllowedDetails = { reason };
  return new AppError('LIKE_NOT_ALLOWED', {
    message: 'This post or comment takes no like now',
    details,
  });
}
