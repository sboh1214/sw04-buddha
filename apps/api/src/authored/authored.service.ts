import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  mediaPath,
  postExcerpt,
  type AuthoredComment,
  type CommentedPost,
  type CursorQuery,
  type HiddenNotice,
  type MarketStatus,
  type MyComment,
  type MyPost,
  type PostSummary,
  type Role,
} from '@buddha/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { visibleCommentCountSql } from '../comments/comment-queries.js';
import { keysetPredicate } from '../common/keyset.js';
import { DB } from '../infra/db/db.provider.js';
import { commentLikeCountSql, postLikeCountSql } from '../likes/like-queries.js';
import {
  authorColumns,
  cardText,
  postAuthorOf,
  postMarketOf,
  publicStateOf,
} from '../posts/posts.service.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { type Page } from '../wallet/wallet.service.js';

/**
 * Who reads a member's list, which decides what it holds: `public` — anyone, on the member's
 * profile — never a hidden item (#37-14); `owner` — the member, on MY '내 글' — the hidden ones too,
 * marked (#45-5). Neither ever holds a deleted one.
 */
type Reader = 'public' | 'owner';

/** The market an item sits on, as a card links to it (`postMarketOf`). */
const marketColumns = {
  id: schema.markets.id,
  slug: schema.markets.slug,
  title: schema.markets.title,
  status: schema.markets.status,
  categorySlug: schema.categories.slug,
  categoryNameKo: schema.categories.nameKo,
};

interface MarketRow {
  id: string;
  slug: string;
  title: string;
  status: MarketStatus;
  categorySlug: string;
  categoryNameKo: string;
}

/** The account behind an item, as the queries read it (`authorColumns`): its public face only. */
interface AuthorRow {
  publicId: string;
  nickname: string;
  role: Role;
  imageId: string | null;
}

interface PostRow {
  id: string;
  title: string | null;
  imageIds: string[];
  textHead: string;
  createdAt: Date;
  editedAt: Date | null;
  hiddenAt: Date | null;
  author: AuthorRow;
  market: MarketRow;
  commentCount: number;
  likeCount: number;
}

interface CommentRow {
  id: string;
  parentId: string | null;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  hiddenAt: Date | null;
  author: AuthorRow;
  likeCount: number;
  post: {
    id: string;
    title: string | null;
    textHead: string;
    deletedAt: Date | null;
    hiddenAt: Date | null;
  };
  market: MarketRow;
}

/**
 * A member's post as the community list's card (`PostSummary`): the same fields, counted the same
 * way (`visibleCommentCountSql`, `postLikeCountSql`), so a post reads alike in every list. A hidden
 * post — the member's own, on MY — shows no thumbnail: `GET /media/:mediaId` serves no image of a
 * hidden post, so the card would point at nothing.
 */
function cardOf(row: PostRow): PostSummary {
  const thumbnail = row.hiddenAt === null ? row.imageIds[0] : undefined;
  return {
    id: row.id,
    title: row.title,
    excerpt: postExcerpt(row.textHead),
    thumbnailUrl: thumbnail === undefined ? null : mediaPath(thumbnail),
    author: postAuthorOf(row.author),
    market: postMarketOf(row.market),
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    commentCount: row.commentCount,
    likeCount: row.likeCount,
  };
}

/**
 * The post a listed comment sits under, as its page shows it to the public (`publicStateOf`): the
 * comment is not deleted, so it hangs under the post, and a deleted post is its placeholder —
 * never gone. A placeholder names the post by its id alone.
 */
function commentedPostOf(post: CommentRow['post']): CommentedPost {
  const state = publicStateOf(post, true);
  switch (state) {
    case 'published':
      return { state, id: post.id, title: post.title, excerpt: postExcerpt(post.textHead) };
    case 'deleted':
    case 'hidden':
      return { state, id: post.id };
    case 'gone':
      // Unreachable with replies under the post; the placeholder is the safe answer regardless.
      return { state: 'deleted', id: post.id };
  }
}

function commentOf(row: CommentRow): AuthoredComment {
  return {
    id: row.id,
    parentId: row.parentId,
    body: row.body,
    author: postAuthorOf(row.author),
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    likeCount: row.likeCount,
    post: commentedPostOf(row.post),
    market: postMarketOf(row.market),
  };
}

/**
 * What MY '내 글' says of a hidden item (#45-5): that it is hidden, and the reason. The reason is
 * #50's to record — its moderation records carry the hiding, its reason and its reversal, and it
 * reads the reason here — and nothing records one before them, so it is null today.
 */
function hiddenNoticeOf(row: { hiddenAt: Date | null }): HiddenNotice | null {
  return row.hiddenAt === null ? null : { reason: null };
}

/**
 * 작성자별 글·댓글 목록 (#51, ADR-0080): a member's posts and comments, newest first, a page at a
 * time — on the public profile (ADR-0069 decision 3 #37-14) and on the member's own MY '내 글'
 * (decision 4 #51, decision 2 #45-5). One rule for what a list holds, which the profile's counts
 * share (`readProfileCounts`): the member's items their author did not delete — on any market,
 * ended and voided ones too, and whether or not the member is under a restriction, now or when
 * writing (#37-14: «제재 중인 사람의 글…은 넣는다»; the lists read no restriction) — and, on the
 * profile, none an operator hid. A comment is listed whatever its post's state: a comment under a
 * hidden post, or under a deleted one that stays as the placeholder, is read in full on the post
 * page, and the profile counts it.
 *
 * The lists read nothing of the member's trading (N04 §2, N05 §2) and order by time alone (N05 §2:
 * no count is a score). Each walks the author's index (`posts_author_id_created_at_idx`,
 * `post_comments_author_id_created_at_idx`) for one member.
 */
@Injectable()
export class AuthoredService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly profiles: ProfilesService,
  ) {}

  /** `GET /profiles/:publicId/posts`: the profile's 글 tab. */
  async profilePosts(publicId: string, query: CursorQuery): Promise<Page<PostSummary>> {
    const authorId = await this.profiles.memberIdOf(publicId);
    const { rows, nextCursor } = await this.posts(authorId, query, 'public');
    return { items: rows.map(cardOf), nextCursor };
  }

  /** `GET /profiles/:publicId/comments`: the profile's 댓글 tab, 대댓글 included. */
  async profileComments(publicId: string, query: CursorQuery): Promise<Page<AuthoredComment>> {
    const authorId = await this.profiles.memberIdOf(publicId);
    const { rows, nextCursor } = await this.comments(authorId, query, 'public');
    return { items: rows.map(commentOf), nextCursor };
  }

  /** `GET /me/posts`: MY '내 글''s 글 tab, the hidden posts marked. */
  async myPosts(userId: string, query: CursorQuery): Promise<Page<MyPost>> {
    const { rows, nextCursor } = await this.posts(userId, query, 'owner');
    return {
      items: rows.map((row) => ({ ...cardOf(row), hidden: hiddenNoticeOf(row) })),
      nextCursor,
    };
  }

  /** `GET /me/comments`: MY '내 글''s 댓글 tab, the hidden comments marked. */
  async myComments(userId: string, query: CursorQuery): Promise<Page<MyComment>> {
    const { rows, nextCursor } = await this.comments(userId, query, 'owner');
    return {
      items: rows.map((row) => ({ ...commentOf(row), hidden: hiddenNoticeOf(row) })),
      nextCursor,
    };
  }

  /**
   * One page of the member's posts, newest first on the (created at, id) keyset; one row past the
   * limit says whether a cursor follows, so a full last page has none and 더 보기 never loads an
   * empty page. A cursor that does not decode serves the first page.
   */
  private async posts(
    authorId: string,
    query: CursorQuery,
    reader: Reader,
  ): Promise<{ rows: PostRow[]; nextCursor: string | null }> {
    const { posts, profiles, markets, categories } = schema;
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.db
      .select({
        id: posts.id,
        title: posts.title,
        imageIds: posts.imageIds,
        textHead: cardText(posts.bodyText),
        createdAt: posts.createdAt,
        editedAt: posts.editedAt,
        hiddenAt: posts.hiddenAt,
        author: authorColumns,
        market: marketColumns,
        commentCount: visibleCommentCountSql(posts.id),
        likeCount: postLikeCountSql(posts.id),
      })
      .from(posts)
      .innerJoin(profiles, eq(profiles.userId, posts.authorId))
      .innerJoin(markets, eq(markets.id, posts.marketId))
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .where(
        and(
          eq(posts.authorId, authorId),
          isNull(posts.deletedAt),
          reader === 'public' ? isNull(posts.hiddenAt) : undefined,
          cursor === undefined
            ? undefined
            : keysetPredicate(posts.createdAt, posts.id, cursor, 'uuid'),
        ),
      )
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(query.limit + 1);
    return pageOf(rows, query.limit);
  }

  /**
   * One page of the member's comments, 댓글 and 대댓글 together, newest first, each with the post it
   * sits under and that post's market. Paged like `posts`.
   */
  private async comments(
    authorId: string,
    query: CursorQuery,
    reader: Reader,
  ): Promise<{ rows: CommentRow[]; nextCursor: string | null }> {
    const { postComments, posts, profiles, markets, categories } = schema;
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.db
      .select({
        id: postComments.id,
        parentId: postComments.parentId,
        body: postComments.body,
        createdAt: postComments.createdAt,
        editedAt: postComments.editedAt,
        hiddenAt: postComments.hiddenAt,
        author: authorColumns,
        likeCount: commentLikeCountSql(postComments.id),
        post: {
          id: posts.id,
          title: posts.title,
          textHead: cardText(posts.bodyText),
          deletedAt: posts.deletedAt,
          hiddenAt: posts.hiddenAt,
        },
        market: marketColumns,
      })
      .from(postComments)
      .innerJoin(profiles, eq(profiles.userId, postComments.authorId))
      .innerJoin(posts, eq(posts.id, postComments.postId))
      .innerJoin(markets, eq(markets.id, posts.marketId))
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .where(
        and(
          eq(postComments.authorId, authorId),
          isNull(postComments.deletedAt),
          reader === 'public' ? isNull(postComments.hiddenAt) : undefined,
          cursor === undefined
            ? undefined
            : keysetPredicate(postComments.createdAt, postComments.id, cursor, 'uuid'),
        ),
      )
      .orderBy(desc(postComments.createdAt), desc(postComments.id))
      .limit(query.limit + 1);
    return pageOf(rows, query.limit);
  }
}

/** The page a query read one row past the limit for, and the cursor of the next one. */
function pageOf<Row extends { createdAt: Date; id: string }>(
  rows: Row[],
  limit: number,
): { rows: Row[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const last = kept.at(-1);
  return {
    rows: kept,
    nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.createdAt, id: last.id }) : null,
  };
}
