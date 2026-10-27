import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  COMMENT_REPLIES_PAGE_SIZE,
  type CommentDeletion,
  type CommentNotAllowedDetails,
  type CommentNotAllowedReason,
  type CommentNotEditableDetails,
  type CommentRepliesQuery,
  type CommentsQuery,
  type CommentThread,
  type PostComment,
  type PublishedComment,
  type Role,
} from '@buddha/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { DB } from '../infra/db/db.provider.js';
import { assertOnboarded } from '../onboarding/onboarded.guard.js';
import { postAuthorOf, publicStateOf } from '../posts/posts.service.js';
import { type Page } from '../wallet/wallet.service.js';
import { CommentCursors } from './comment-cursor.js';
import {
  commentHasReplies,
  commentHasRepliesSql,
  commentPageIdsSql,
  postHasComments,
} from './comment-queries.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A comment row as the public reads select it: the comment and its author's public face. */
interface CommentRow {
  id: string;
  parentId: string | null;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  hiddenAt: Date | null;
  author: { publicId: string; nickname: string; role: Role };
}

/**
 * A comment as the public sees it (#45-5, `publicStateOf`): the comment, the placeholder of a
 * deleted 댓글 that 대댓글 hang under or of a hidden one, or nothing — a deleted 대댓글, a deleted
 * 댓글 with nothing under it. The placeholders carry the id alone: no author, no word of the body.
 */
function publicCommentOf(row: CommentRow, hasReplies: boolean): PostComment | undefined {
  const state = publicStateOf(row, hasReplies);
  switch (state) {
    case 'gone':
      return undefined;
    case 'deleted':
    case 'hidden':
      return { state, id: row.id };
    case 'published':
      return publishedOf(row);
  }
}

function publishedOf(row: CommentRow): PublishedComment {
  return {
    state: 'published',
    id: row.id,
    parentId: row.parentId,
    body: row.body,
    author: postAuthorOf(row.author),
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
  };
}

/**
 * A page of the 대댓글 of the 댓글 `threadId` from rows read oldest first with one row past
 * COMMENT_REPLIES_PAGE_SIZE: the first that many as the public sees them (`publicCommentOf` — a
 * deleted 대댓글 was never read), and the cursor after the last of them, sealed for that thread's
 * list (`CommentCursors`, 오너 결정 2026-10-21 (2차) 답 3), when the extra row says more follow.
 */
function replyPageOf(
  cursors: CommentCursors,
  threadId: string,
  rows: readonly CommentRow[],
): Page<PostComment> {
  const hasMore = rows.length > COMMENT_REPLIES_PAGE_SIZE;
  const kept = hasMore ? rows.slice(0, COMMENT_REPLIES_PAGE_SIZE) : rows;
  const last = kept.at(-1);
  return {
    items: kept.flatMap((row) => publicCommentOf(row, false) ?? []),
    nextCursor:
      hasMore && last
        ? cursors.seal(
            { list: 'replies', commentId: threadId },
            { createdAt: last.createdAt, id: last.id },
          )
        : null,
  };
}

/**
 * 댓글·대댓글 (#48, ADR-0074): a post's comments, and their authors' writes. Two layers under a post
 * (#45-2), both oldest first; plain text (#45-3); edits keep the operators' history (#45-4);
 * deletion and hiding as #45-5 says. Writing and trading are independent (N05 §2): no write reads
 * or touches a balance, an order or a position, and no answer carries one.
 *
 * Writes and the post's state: a comment is written under the post's row and, for a 대댓글, its
 * 댓글's row held shared (`FOR SHARE`), so the author's deletion and an operator's hiding (#50),
 * which update those rows, wait for it or it for them — a comment never lands under a post or a
 * 댓글 whose deletion or hiding committed, and a deletion's answer (`placeholder`) counts every
 * comment written before it.
 */
@Injectable()
export class CommentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly cursors: CommentCursors,
  ) {}

  /** What the public reads select: the comment and its author's public face, never the id. */
  private readonly columns = {
    id: schema.postComments.id,
    parentId: schema.postComments.parentId,
    body: schema.postComments.body,
    createdAt: schema.postComments.createdAt,
    editedAt: schema.postComments.editedAt,
    deletedAt: schema.postComments.deletedAt,
    hiddenAt: schema.postComments.hiddenAt,
    author: {
      publicId: schema.profiles.publicId,
      nickname: schema.profiles.nickname,
      role: schema.profiles.role,
    },
  };

  /**
   * `GET /posts/:postId/comments`: the post's 댓글 oldest first (#45-2: 작성 순), a page of them at
   * a time (`limit`, at most COMMENT_PAGE_LIMIT), each with its first COMMENT_REPLIES_PAGE_SIZE
   * 대댓글, oldest first too, and the cursor of the rest (`repliesNextCursor`, read by `replies` —
   * 오너 결정 2026-10-21: '답글 더 보기'로 50개씩). A page counts 댓글 only and holds no 댓글 that
   * left every view (deleted, nothing under it), so a page is full while more follow. The comments
   * of a post in any state are read: a hidden post's and a deleted post's placeholder keep their
   * comments in view (N04 §6: the replies keep their context). A post that is gone — deleted with
   * nothing under it, or never there — is NOT_FOUND, as on its page. The cursors, the page's and
   * each thread's, are sealed for their list (`CommentCursors`, 오너 결정 2026-10-21 (2차) 답 3): a page
   * may end on a placeholder, and no cursor tells its time; one that does not open is a
   * VALIDATION_ERROR.
   *
   * Bounded whatever a thread holds and whatever was deleted (Codex reviews on PR #220): one query
   * for the page's 댓글 — which 댓글 it holds is `commentPageIdsSql`'s two walks, neither of which
   * reads a deleted 댓글 out of view — one for their 대댓글 — a LATERAL read of at most
   * COMMENT_REPLIES_PAGE_SIZE + 1 per 댓글 down `post_comments_live_parent_id_created_at_id_idx`,
   * which holds no deleted 대댓글 — and one pass that appends each 대댓글 to its 댓글's list.
   */
  async list(postId: string, query: CommentsQuery): Promise<Page<CommentThread>> {
    const { posts, postComments, profiles } = schema;
    const [post] = await this.db
      .select({ deletedAt: posts.deletedAt, hiddenAt: posts.hiddenAt })
      .from(posts)
      .where(eq(posts.id, postId));
    if (!post || publicStateOf(post, await postHasComments(this.db, postId)) === 'gone') {
      throw postNotFound();
    }
    const scope = { list: 'comments', postId } as const;
    const cursor = this.cursors.open(scope, query.cursor);
    const rows = await this.db
      .select({ ...this.columns, hasReplies: commentHasRepliesSql(postComments.id) })
      .from(postComments)
      .innerJoin(profiles, eq(profiles.userId, postComments.authorId))
      .where(sql`${postComments.id} = ANY (${commentPageIdsSql(postId, cursor, query.limit + 1)})`)
      .orderBy(asc(postComments.createdAt), asc(postComments.id));
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const byParent = new Map<string, CommentRow[]>();
    for (const reply of await this.firstReplies(kept.map((row) => row.id))) {
      if (reply.parentId === null) continue;
      const held = byParent.get(reply.parentId);
      if (held === undefined) byParent.set(reply.parentId, [reply]);
      else held.push(reply);
    }
    const last = kept.at(-1);
    return {
      items: kept.flatMap((row) => {
        const comment = publicCommentOf(row, row.hasReplies);
        if (comment === undefined) return [];
        const { items, nextCursor } = replyPageOf(this.cursors, row.id, byParent.get(row.id) ?? []);
        return [{ comment, replies: items, repliesNextCursor: nextCursor }];
      }),
      nextCursor:
        hasMore && last
          ? this.cursors.seal(scope, { createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  /**
   * `GET /comments/:commentId/replies`: the 대댓글 of one 댓글 after `cursor`, oldest first,
   * COMMENT_REPLIES_PAGE_SIZE a page — '답글 더 보기' (오너 결정 2026-10-21). The first page (no
   * cursor) is the one its post's comment page carries. A deleted 대댓글 is in no page, a hidden one
   * is its placeholder. NOT_FOUND for what is no thread in view: an unknown comment, a 대댓글 (it
   * has no replies of its own, #45-2), a deleted 댓글 with nothing under it — and so for every
   * comment of a post that left every view: a 댓글 still in view means an undeleted comment on its
   * post, itself or a 대댓글 under it, which keeps the post in view too. The cursor is sealed for
   * this 댓글's list: another thread's, the comment page's, or one tampered with is a
   * VALIDATION_ERROR (`CommentCursors`). The page walks 51 rows from the cursor down the index of
   * the undeleted 대댓글 (`post_comments_live_parent_id_created_at_id_idx`), which holds no deleted
   * one however many were written and deleted (Codex review on PR #220).
   */
  async replies(commentId: string, query: CommentRepliesQuery): Promise<Page<PostComment>> {
    const { postComments, profiles } = schema;
    const [thread] = await this.db
      .select({
        parentId: postComments.parentId,
        deletedAt: postComments.deletedAt,
        hiddenAt: postComments.hiddenAt,
      })
      .from(postComments)
      .where(eq(postComments.id, commentId));
    if (
      !thread ||
      thread.parentId !== null ||
      publicStateOf(thread, await commentHasReplies(this.db, commentId)) === 'gone'
    ) {
      throw commentNotFound();
    }
    const cursor = this.cursors.open({ list: 'replies', commentId }, query.cursor);
    const rows = await this.db
      .select(this.columns)
      .from(postComments)
      .innerJoin(profiles, eq(profiles.userId, postComments.authorId))
      .where(
        and(
          eq(postComments.parentId, commentId),
          isNull(postComments.deletedAt),
          cursor === undefined
            ? undefined
            : keysetPredicate(postComments.createdAt, postComments.id, cursor, 'uuid', 'after'),
        ),
      )
      .orderBy(asc(postComments.createdAt), asc(postComments.id))
      .limit(COMMENT_REPLIES_PAGE_SIZE + 1);
    return replyPageOf(this.cursors, commentId, rows);
  }

  /**
   * The first COMMENT_REPLIES_PAGE_SIZE + 1 undeleted 대댓글 of each 댓글 `threadIds` names, oldest
   * first within each: a LATERAL subquery per 댓글 that walks its undeleted replies' index
   * (`post_comments_live_parent_id_created_at_id_idx`) and stops at the limit, so a thread of any
   * size — and any number of 대댓글 deleted in it — costs its first page and one row more (whether
   * more follow).
   */
  private async firstReplies(threadIds: string[]): Promise<CommentRow[]> {
    if (threadIds.length === 0) return [];
    const { postComments, profiles } = schema;
    const thread = alias(postComments, 'thread');
    const reply = this.db
      .select({
        id: postComments.id,
        parentId: postComments.parentId,
        body: postComments.body,
        createdAt: postComments.createdAt,
        editedAt: postComments.editedAt,
        deletedAt: postComments.deletedAt,
        hiddenAt: postComments.hiddenAt,
        publicId: profiles.publicId,
        nickname: profiles.nickname,
        role: profiles.role,
      })
      .from(postComments)
      .innerJoin(profiles, eq(profiles.userId, postComments.authorId))
      .where(and(eq(postComments.parentId, thread.id), isNull(postComments.deletedAt)))
      .orderBy(asc(postComments.createdAt), asc(postComments.id))
      .limit(COMMENT_REPLIES_PAGE_SIZE + 1)
      .as('reply');
    return this.db
      .select({
        id: reply.id,
        parentId: reply.parentId,
        body: reply.body,
        createdAt: reply.createdAt,
        editedAt: reply.editedAt,
        deletedAt: reply.deletedAt,
        hiddenAt: reply.hiddenAt,
        author: { publicId: reply.publicId, nickname: reply.nickname, role: reply.role },
      })
      .from(thread)
      .crossJoinLateral(reply)
      .where(inArray(thread.id, threadIds))
      .orderBy(asc(reply.createdAt), asc(reply.id));
  }

  /**
   * `POST /posts/:postId/comments`: a 댓글, or with `parentId` a 대댓글 (#45-2). A `parentId` that
   * names a 대댓글 makes the new one a 대댓글 of that 대댓글's 댓글, so a reply to a reply stays in
   * its thread and no third layer exists. Refused: a post or a parent that is gone or unknown
   * (NOT_FOUND, naming `parentId` for the parent), a hidden or deleted post (#45-5: no new comment)
   * and a hidden or deleted 댓글 to hang under (no new 대댓글) — COMMENT_NOT_ALLOWED with the
   * reason. Comments are taken on posts of markets in every public status (#45-6, the post's own
   * rule). Nothing about the author's trading is read or attached (N05 §2).
   */
  async create(
    authorId: string,
    postId: string,
    parentId: string | null,
    body: string,
  ): Promise<PublishedComment> {
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await this.checkWriter(tx, authorId);
      const { posts, postComments } = schema;
      const [post] = await tx
        .select({ deletedAt: posts.deletedAt, hiddenAt: posts.hiddenAt })
        .from(posts)
        .where(eq(posts.id, postId))
        .for('share');
      if (!post) throw postNotFound();
      switch (publicStateOf(post, await postHasComments(tx, postId))) {
        case 'gone':
          throw postNotFound();
        case 'deleted':
          throw commentNotAllowed('post_deleted');
        case 'hidden':
          throw commentNotAllowed('post_hidden');
        case 'published':
          break;
      }
      const parent = parentId === null ? null : await this.lockParent(tx, postId, parentId);
      await tx.insert(postComments).values({
        id,
        postId,
        parentId: parent?.id ?? null,
        parentCreatedAt: parent?.createdAt ?? null,
        authorId,
        body,
      });
    });
    return this.published(id);
  }

  /**
   * `PUT /comments/:commentId`: the author replaces the body (#45-4: any time). The version
   * replaced goes to the operators' history (`post_comment_revisions`) and the comment is marked
   * edited; sending what it already says changes nothing. Refused for anyone but the author
   * (FORBIDDEN), a deleted or unknown comment (NOT_FOUND) and a hidden one (COMMENT_NOT_EDITABLE,
   * #45-5). A comment under a hidden or deleted post, and a 대댓글 under a hidden 댓글 or under a
   * deleted 댓글's placeholder, stays its author's to edit: only new comments are refused there
   * (오너 결정 2026-10-20, ADR-0074 7-6).
   */
  async update(authorId: string, commentId: string, body: string): Promise<PublishedComment> {
    await this.db.transaction(async (tx) => {
      const current = await this.lockOwnComment(tx, authorId, commentId);
      if (current.hiddenAt !== null) {
        const details: CommentNotEditableDetails = { reason: 'hidden' };
        throw new AppError('COMMENT_NOT_EDITABLE', { message: 'The comment is hidden', details });
      }
      await this.checkWriter(tx, authorId);
      if (current.body === body) return;
      await tx.insert(schema.postCommentRevisions).values({
        commentId,
        body: current.body,
        writtenAt: current.editedAt ?? current.createdAt,
      });
      await tx
        .update(schema.postComments)
        .set({ body, editedAt: sql`now()` })
        .where(eq(schema.postComments.id, commentId));
    });
    return this.published(commentId);
  }

  /**
   * `POST /comments/:commentId/delete`: the author deletes the comment (#45-5), a hidden one too,
   * signed in and nothing more — not the onboarding, not a writing restriction (#45-12: deleting
   * one's own stays open under any). Its body stays for operators (and #184's retention); the
   * public sees '삭제된 글입니다' for a 댓글 while 대댓글 hang under it and nothing otherwise — never
   * restored. A second deletion is NOT_FOUND. The row lock waits for a 대댓글 being written under
   * it (which holds the row shared), so the answer counts that 대댓글.
   */
  async delete(authorId: string, commentId: string): Promise<CommentDeletion> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockOwnComment(tx, authorId, commentId);
      await tx
        .update(schema.postComments)
        .set({ deletedAt: sql`now()` })
        .where(eq(schema.postComments.id, commentId));
      const placeholder = current.parentId === null && (await commentHasReplies(tx, commentId));
      return { id: commentId, placeholder };
    });
  }

  /**
   * The checks every new comment and every edit passes, in the write's transaction — the one place
   * the later rules plug in: #185's 작성 제한 (which blocks writing and editing, never deleting,
   * ADR-0069 decision 2 #45-12) and #187's frequency limits (comments 5 a minute and 200 a day,
   * edits 10 in 10 minutes and 50 a day, counted per verified number's keyed hash, admins exempt,
   * #45-15 and decision 7) and its repeated-link review list. Today: the onboarding, which
   * OnboardedGuard checked before the body was read, held to the commit here (#57-8).
   */
  private async checkWriter(tx: Tx, authorId: string): Promise<void> {
    await assertOnboarded(tx, authorId);
  }

  /**
   * The 댓글 a new 대댓글 hangs under, held shared for the write: the comment `parentId` names on
   * this post, or — when that is a 대댓글 — its 댓글 (#45-2). The named comment must be in view and
   * open: one that left every view, or is on another post, is NOT_FOUND naming `parentId`; a hidden
   * one, or a 댓글 hidden or deleted to its placeholder, takes no 대댓글 (COMMENT_NOT_ALLOWED).
   * Locks the named comment, then its 댓글: a deletion or a hiding locks one row only, so the order
   * cannot deadlock against them. Its `created_at` goes with it: the new 대댓글 carries it
   * (`parent_created_at`, which the parent's foreign key holds to it).
   */
  private async lockParent(
    tx: Tx,
    postId: string,
    parentId: string,
  ): Promise<{ id: string; createdAt: Date }> {
    const target = await this.lockComment(tx, parentId);
    if (!target || target.postId !== postId) throw parentNotFound();
    let comment = target;
    if (target.parentId !== null) {
      // A 대댓글 named: it must be in view itself (a deleted one is gone), and its 댓글 is the parent.
      if (target.deletedAt !== null) throw parentNotFound();
      if (target.hiddenAt !== null) throw commentNotAllowed('parent_hidden');
      const thread = await this.lockComment(tx, target.parentId);
      if (!thread) throw parentNotFound();
      comment = thread;
    }
    switch (publicStateOf(comment, await commentHasReplies(tx, comment.id))) {
      case 'gone':
        throw parentNotFound();
      case 'deleted':
        throw commentNotAllowed('parent_deleted');
      case 'hidden':
        throw commentNotAllowed('parent_hidden');
      case 'published':
        return { id: comment.id, createdAt: comment.createdAt };
    }
  }

  private async lockComment(tx: Tx, commentId: string) {
    const { postComments } = schema;
    const [row] = await tx
      .select({
        id: postComments.id,
        postId: postComments.postId,
        parentId: postComments.parentId,
        createdAt: postComments.createdAt,
        deletedAt: postComments.deletedAt,
        hiddenAt: postComments.hiddenAt,
      })
      .from(postComments)
      .where(eq(postComments.id, commentId))
      .for('share');
    return row;
  }

  /**
   * The author's own comment, locked for the write: NOT_FOUND when it is unknown or deleted (gone
   * for its author too, even as a placeholder), FORBIDDEN when another account wrote it.
   */
  private async lockOwnComment(tx: Tx, authorId: string, commentId: string) {
    const [current] = await tx
      .select()
      .from(schema.postComments)
      .where(eq(schema.postComments.id, commentId))
      .for('update');
    if (!current || current.deletedAt !== null) throw commentNotFound();
    if (current.authorId !== authorId) {
      throw new AppError('FORBIDDEN', { message: 'Only its author changes a comment' });
    }
    return current;
  }

  /** A comment just written, as its author's screen shows it next. */
  private async published(commentId: string): Promise<PublishedComment> {
    const { postComments, profiles } = schema;
    const [row] = await this.db
      .select(this.columns)
      .from(postComments)
      .innerJoin(profiles, eq(profiles.userId, postComments.authorId))
      .where(eq(postComments.id, commentId));
    if (!row || row.deletedAt !== null) throw commentNotFound();
    return publishedOf(row);
  }
}

function postNotFound(): AppError {
  return new AppError('NOT_FOUND', { message: 'Post not found' });
}

function commentNotFound(): AppError {
  return new AppError('NOT_FOUND', { message: 'Comment not found' });
}

function parentNotFound(): AppError {
  return new AppError('NOT_FOUND', {
    message: 'Comment not found',
    details: [{ path: ['parentId'], message: 'no such comment on this post' }],
  });
}

function commentNotAllowed(reason: CommentNotAllowedReason): AppError {
  const details: CommentNotAllowedDetails = { reason };
  return new AppError('COMMENT_NOT_ALLOWED', {
    message: 'This post or comment takes no new comments',
    details,
  });
}
