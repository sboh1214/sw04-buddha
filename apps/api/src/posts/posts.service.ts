import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  POST_EXCERPT_MAX_LENGTH,
  TRIM_WHITESPACE_CLASS,
  canonicalJson,
  decodeKeyset,
  encodeKeyset,
  isPublicMarketStatus,
  mediaPath,
  postDocumentLinks,
  postExcerpt,
  postImageNotUsableMessage,
  type CursorQuery,
  type MarketStatus,
  type Post,
  type PostAuthor,
  type PostDeletion,
  type PostListQuery,
  type PostMarket,
  type PostNotEditableDetails,
  type PostSummary,
  type PublishedPost,
  type Role,
  type SanitizedPostDocument,
} from '@buddha/shared';
import {
  type AnyColumn,
  type SQL,
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  sql,
} from 'drizzle-orm';
import {
  postHasComments,
  postHasCommentsSql,
  visibleCommentCountSql,
} from '../comments/comment-queries.js';
import { AppError } from '../common/errors/app-error.js';
import { PG_UNIQUE_VIOLATION, isPgError } from '../common/errors/pg-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { DB } from '../infra/db/db.provider.js';
import { postLikeCountSql } from '../likes/like-queries.js';
import { LinkReviewService } from '../link-review/link-review.service.js';
import { inCategory, isPublicMarket, likePattern } from '../markets/market.service.js';
import { assertWriter } from '../moderation/restrictions.js';
import { type Page } from '../wallet/wallet.service.js';
import { WriteLimitsService, type Writer } from '../write-limits/write-limits.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Reads that run either inside a transaction or on the pool. */
type Executor = Db | Tx;

/** A page of cards and how many the whole list holds (`CountedPageMeta`). */
export interface CountedPage<T> extends Page<T> {
  total: number;
}

/** What a post write sends, the body normalised by `postDocumentInputSchema`. */
export interface PostContent {
  title: string | null;
  body: SanitizedPostDocument;
}

/**
 * How much of a post's text a list reads for its card (`cardText`): the excerpt's own length and as
 * much again, without moving whole bodies for a page of cards. Once the blank lines are out, any
 * start as long as the excerpt gives the whole text's excerpt — the line the cut ends in is trimmed
 * at its end, and so is the excerpt (`postExcerpt`) — and the rest is margin.
 */
const LIST_TEXT_HEAD = POST_EXCERPT_MAX_LENGTH * 2;

/** A run of what `postExcerpt` reads as blank around a line break: the breaks between lines it keeps. */
const BLANKS_AROUND_BREAKS = `${TRIM_WHITESPACE_CLASS}*\n${TRIM_WHITESPACE_CLASS}*`;
/** What `postExcerpt` reads as blank before the first non-empty line. */
const LEADING_BLANKS = `^${TRIM_WHITESPACE_CLASS}+`;

/**
 * The start of a post's text for its card, read in the database: the text with its blank lines and
 * the blanks around its line breaks taken out first — what `postExcerpt` drops anyway — and only then
 * cut to LIST_TEXT_HEAD, so the excerpt the API makes from it is the one the whole text gives.
 * Cutting first left nothing to show when a body opened with more blank lines than the cut kept
 * (a code block of empty lines is text; only the whole body must not be blank). What every list that
 * shows a post's start reads — the community list and, through #51, a member's posts and the posts
 * their comments sit under — so a post starts the same wherever it is listed.
 */
export function cardText(bodyText: AnyColumn): SQL<string> {
  return sql<string>`left(regexp_replace(regexp_replace(${bodyText}, ${BLANKS_AROUND_BREAKS}, ${'\n'}, 'g'), ${LEADING_BLANKS}, ''), ${LIST_TEXT_HEAD})`;
}

/** The account behind a post, as a query reads it (`authorColumns`). */
export interface AuthorRow {
  publicId: string;
  /** Null exactly once the member closed the account (#140). */
  nickname: string | null;
  role: Role;
  /** `profiles.image_id`: the profile image (#141), or null. */
  imageId: string | null;
  /** `profiles.closed_at`: when the member closed the account (#140), or null. */
  closedAt: Date | null;
}

/**
 * The columns of `profiles` a person's public face is made of (`postAuthorOf`): every query that
 * names a person selects these, so the face cannot be made from less — or more: the account id is
 * not even read on the public path.
 */
export const authorColumns = {
  publicId: schema.profiles.publicId,
  nickname: schema.profiles.nickname,
  role: schema.profiles.role,
  imageId: schema.profiles.imageId,
  closedAt: schema.profiles.closedAt,
};

/**
 * Who wrote a post, as every public answer names a person (ADR-0069 decision 5): the public id,
 * the CURRENT nickname (#37-3), the profile image (#141, #37-6: the one the member uploaded, as its
 * address — a new upload is a new address — or null, and the web draws the nickname's first
 * letter; never a social login's photo) and the 운영자 mark (#45-9: an admin account's every post).
 * Never the account id. The one place a person is shown — a post's, a comment's author and the
 * public profile's member — so an account its member closed (#140, ADR-0069 decision 3 #37-16) is
 * `{ kind: 'former_member' }` here and nothing else, '탈퇴한 사용자' with no profile link: not even
 * the public id, which would link the closed account's posts to one another. Every reader that
 * finds a member through it — the profile, its lists, a report on the profile — answers such an
 * account as none (404).
 */
export function postAuthorOf(row: AuthorRow): PostAuthor {
  if (row.closedAt !== null || row.nickname === null) return { kind: 'former_member' };
  return {
    kind: 'member',
    publicId: row.publicId,
    nickname: row.nickname,
    imageUrl: row.imageId === null ? null : mediaPath(row.imageId),
    isAdmin: row.role === 'admin',
  };
}

/** The market a post belongs to, as a card and the post page link to it. */
export function postMarketOf(row: {
  id: string;
  slug: string;
  title: string;
  status: MarketStatus;
  categorySlug: string;
  categoryNameKo: string;
}): PostMarket {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    category: { slug: row.categorySlug, nameKo: row.categoryNameKo },
  };
}

/**
 * What the public sees of a post (#45-5), by its times and whether anything hangs under it — for
 * a post, comments not deleted (hidden ones too, `postHasComments`): `published`; `deleted` — the
 * author deleted it and such comments hang under it, the placeholder '삭제된 글입니다' with the
 * author hidden; `gone` — deleted with nothing under it, out of every view; `hidden` — an operator
 * hid it, '운영 정책에 따라 숨긴 글입니다'. The author's deletion comes first: a hidden post its
 * author deleted is deleted. A comment (#48) is seen the same way, its 대댓글 not deleted being
 * what hangs under a 댓글 (a 대댓글 has none, so a deleted one is gone).
 */
export function publicStateOf(
  post: { deletedAt: Date | null; hiddenAt: Date | null },
  hasReplies: boolean,
): 'published' | 'deleted' | 'gone' | 'hidden' {
  if (post.deletedAt !== null) return hasReplies ? 'deleted' : 'gone';
  if (post.hiddenAt !== null) return 'hidden';
  return 'published';
}

/**
 * 근거 글 (#46, ADR-0073): the community list, a post page, and the author's writes. Writing and
 * trading are independent (N05 §2): no write reads or touches a balance, an order or a position,
 * and no answer carries one.
 */
@Injectable()
export class PostsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly limits: WriteLimitsService,
    private readonly links: LinkReviewService,
  ) {}

  /**
   * The columns both public reads select: the post, its author's public face, its market, how
   * many comments it shows (#48) and how many like it (#49). The same for every reader: whether
   * the reader liked it is `GET /me/likes/posts/:postId`'s.
   */
  private readonly columns = {
    id: schema.posts.id,
    title: schema.posts.title,
    imageIds: schema.posts.imageIds,
    createdAt: schema.posts.createdAt,
    editedAt: schema.posts.editedAt,
    deletedAt: schema.posts.deletedAt,
    hiddenAt: schema.posts.hiddenAt,
    // The author's public face only: the account id is not even read on the public path.
    author: authorColumns,
    market: {
      id: schema.markets.id,
      slug: schema.markets.slug,
      title: schema.markets.title,
      status: schema.markets.status,
      categorySlug: schema.categories.slug,
      categoryNameKo: schema.categories.nameKo,
    },
    commentCount: visibleCommentCountSql(schema.posts.id),
    likeCount: postLikeCountSql(schema.posts.id),
  };

  /**
   * `GET /posts`: the community list (#45-7), newest first — the only order — never a deleted or
   * a hidden post (`listed`). `marketId` narrows to one market, `category` to a category on either
   * level (a top-level slug includes its children, as `GET /markets` reads it), `q` to a
   * case-insensitive partial match in the title or the text (`search_text`'s trigram index serves
   * a term of three characters or more). A cursor that does not decode serves the first page.
   */
  async list(query: PostListQuery): Promise<Page<PostSummary>> {
    const { posts } = schema;
    return this.cards(
      this.db,
      and(
        query.marketId === undefined ? undefined : eq(posts.marketId, query.marketId),
        query.category === undefined ? undefined : inCategory(this.db, query.category),
        query.q === undefined ? undefined : ilike(posts.searchText, likePattern(query.q)),
      ),
      query,
    );
  }

  /**
   * `GET /markets/:id/posts`: the market detail's 토론 (#47, ADR-0069 decision 4 — every post in
   * the detail, 20 more per 더 보기, and the count shown). The community list narrowed to the
   * market — the same cards, newest first, never a deleted or a hidden post — and `total`, how many
   * the whole list holds, which is what the section counts. Readable in every public status, ended
   * markets too (N05 §3; #45-6 takes posts on all of them; ADR-0093 decision 3: SCHEDULED, PAUSED
   * and CANCELLED included); NOT_FOUND for a DRAFT or REVIEW market and an unknown one, as the
   * detail and its other sub-resources answer.
   *
   * One read-only REPEATABLE READ transaction, so the count and the page come from one snapshot,
   * the one its first statement takes: a post committed between two statements cannot make one
   * answer's count disagree with its cards (under READ COMMITTED each statement reads anew, and a
   * post committed while the cards wait — on a lock, say — would be a card the count missed).
   */
  async listForMarket(marketId: string, query: CursorQuery): Promise<CountedPage<PostSummary>> {
    const { markets, posts } = schema;
    return this.db.transaction(
      async (tx) => {
        const [market] = await tx
          .select({ id: markets.id })
          .from(markets)
          .where(and(eq(markets.id, marketId), isPublicMarket()))
          .limit(1);
        if (!market) throw new AppError('NOT_FOUND', { message: 'Market not found' });
        const inMarket = eq(posts.marketId, marketId);
        const [counted] = await tx
          .select({ total: count() })
          .from(posts)
          .where(and(listed(), inMarket));
        const page = await this.cards(tx, inMarket, query);
        return { ...page, total: counted?.total ?? 0 };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  /**
   * One page of cards of the posts the public lists (`listed`) that `where` keeps, newest first on
   * the (created at, id) keyset. One row past the limit says whether a cursor follows, so a full
   * last page has none and 더 보기 never loads an empty page.
   */
  private async cards(
    executor: Executor,
    where: SQL | undefined,
    query: CursorQuery,
  ): Promise<Page<PostSummary>> {
    const { posts, profiles, markets, categories } = schema;
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await executor
      .select({
        ...this.columns,
        textHead: cardText(posts.bodyText),
      })
      .from(posts)
      .innerJoin(profiles, eq(profiles.userId, posts.authorId))
      .innerJoin(markets, eq(markets.id, posts.marketId))
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .where(
        and(
          listed(),
          where,
          cursor === undefined
            ? undefined
            : keysetPredicate(posts.createdAt, posts.id, cursor, 'uuid'),
        ),
      )
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const kept = hasMore ? rows.slice(0, query.limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map((row) => ({
        id: row.id,
        title: row.title,
        excerpt: postExcerpt(row.textHead),
        thumbnailUrl: row.imageIds[0] === undefined ? null : mediaPath(row.imageIds[0]),
        author: postAuthorOf(row.author),
        market: postMarketOf(row.market),
        createdAt: row.createdAt.toISOString(),
        editedAt: row.editedAt?.toISOString() ?? null,
        commentCount: row.commentCount,
        likeCount: row.likeCount,
      })),
      nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  /**
   * `GET /posts/:postId`: the post page, in the state the public sees (`publicStateOf`). A post
   * that is gone — deleted with nothing under it, or never there — is NOT_FOUND. A placeholder
   * carries no like count (#49: a deleted or hidden post takes no like).
   */
  async get(postId: string): Promise<Post> {
    const { posts, profiles, markets, categories } = schema;
    const [row] = await this.db
      .select({ ...this.columns, body: posts.body, hasComments: postHasCommentsSql(posts.id) })
      .from(posts)
      .innerJoin(profiles, eq(profiles.userId, posts.authorId))
      .innerJoin(markets, eq(markets.id, posts.marketId))
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .where(eq(posts.id, postId))
      .limit(1);
    if (!row) throw postNotFound();
    const state = publicStateOf(row, row.hasComments);
    const market = postMarketOf(row.market);
    const { commentCount } = row;
    switch (state) {
      case 'gone':
        throw postNotFound();
      case 'deleted':
      case 'hidden':
        return { state, id: row.id, market, commentCount };
      case 'published':
        return {
          state,
          id: row.id,
          title: row.title,
          body: row.body,
          author: postAuthorOf(row.author),
          market,
          createdAt: row.createdAt.toISOString(),
          editedAt: row.editedAt?.toISOString() ?? null,
          commentCount,
          likeCount: row.likeCount,
        };
    }
  }

  /**
   * `POST /posts`: a post on a market in any public status (#45-6; ADR-0093 decision 3: SCHEDULED,
   * PAUSED and CANCELLED included). The market must exist and be public — not DRAFT or REVIEW
   * (NOT_FOUND naming `marketId`, as the public never sees one); every image must be
   * the author's own upload, taken by no other post (`claimImages`). An author under a writing
   * restriction is refused before anything is read (RESTRICTED, `checkWriter`, #185). Then the post
   * counts against the person's limits (#187: 3 in 10 minutes, 20 a day — WRITE_LIMITED, nothing
   * written) and its links — the first 20 in body order (owner decision 2026-10-22) — go to the
   * repetition rules (#187: a flag on the operators' review list at most, never a refusal). Nothing
   * about the author's trading is read or attached (N05 §2).
   */
  async create(authorId: string, marketId: string, content: PostContent): Promise<PublishedPost> {
    const id = randomUUID();
    const links = postDocumentLinks(content.body.document);
    await this.db.transaction(async (tx) => {
      const writer = await this.checkWriter(tx, authorId);
      const { markets } = schema;
      const [market] = await tx
        .select({ status: markets.status })
        .from(markets)
        .where(eq(markets.id, marketId));
      if (!market || !isPublicMarketStatus(market.status)) {
        throw new AppError('NOT_FOUND', {
          message: 'Market not found',
          details: [{ path: ['marketId'], message: 'no such market' }],
        });
      }
      await this.claimImages(tx, authorId, content.body.imageIds, id);
      await this.limits.take(tx, writer, 'post');
      await tx.insert(schema.posts).values({
        id,
        marketId,
        authorId,
        title: content.title,
        body: content.body.document,
        bodyText: content.body.text,
        imageIds: content.body.imageIds,
      });
      await this.attachImages(tx, id, content.body.imageIds);
      await this.links.record(tx, writer, { postId: id }, marketId, links);
    });
    return this.published(id);
  }

  /**
   * `PUT /posts/:postId`: the author replaces the title and the body (#45-4: any time, never the
   * market). The version replaced goes to the operators' history (`post_revisions`) and the post
   * is marked edited; sending what the post already says changes nothing. Refused for anyone but
   * the author (FORBIDDEN), a deleted or unknown post (NOT_FOUND) and a hidden one
   * (POST_NOT_EDITABLE, #45-5) — and, asked first, any under the author's writing restriction
   * (RESTRICTED, #185: «자기 글·댓글 수정», deleting stays open). An image the edit takes out stays
   * attached for the history and is no longer served (`GET /media/:mediaId` serves the current
   * body's). An edit that changes something counts against the person's edit limits (#187: posts'
   * and comments' edits together, 10 in 10 minutes and 50 a day — WRITE_LIMITED, nothing written),
   * and the links it puts in that the post did not have go to the repetition rules (#187 «수정으로
   * 넣거나 바꾼 링크도 본다») — of the body's first 20 in body order, those not among the previous
   * body's first 20 (owner decision 2026-10-22).
   */
  async update(authorId: string, postId: string, content: PostContent): Promise<PublishedPost> {
    const links = postDocumentLinks(content.body.document);
    await this.db.transaction(async (tx) => {
      // The writer before the post's row (`checkWriter`): the profile's lock comes first, as in an
      // operator's restriction that names the post — and the writer's refusal before the post's —
      // and the writer's number lock next, as in every counted write.
      const writer = await this.checkWriter(tx, authorId);
      const current = await this.lockOwnPost(tx, authorId, postId);
      if (current.hiddenAt !== null) {
        const details: PostNotEditableDetails = { reason: 'hidden' };
        throw new AppError('POST_NOT_EDITABLE', { message: 'The post is hidden', details });
      }
      if (
        current.title === content.title &&
        canonicalJson(current.body) === canonicalJson(content.body.document)
      ) {
        return;
      }
      await this.claimImages(tx, authorId, content.body.imageIds, postId);
      await this.limits.take(tx, writer, 'edit');
      await tx.insert(schema.postRevisions).values({
        postId,
        title: current.title,
        body: current.body,
        bodyText: current.bodyText,
        imageIds: current.imageIds,
        writtenAt: current.editedAt ?? current.createdAt,
      });
      await tx
        .update(schema.posts)
        .set({
          title: content.title,
          body: content.body.document,
          bodyText: content.body.text,
          imageIds: content.body.imageIds,
          editedAt: sql`now()`,
        })
        .where(eq(schema.posts.id, postId));
      await this.attachImages(tx, postId, content.body.imageIds);
      const had = new Set(postDocumentLinks(current.body));
      const added = links.filter((link) => !had.has(link));
      await this.links.record(tx, writer, { postId }, current.marketId, added);
    });
    return this.published(postId);
  }

  /**
   * `POST /posts/:postId/delete`: the author deletes the post (#45-5), a hidden one too. Its
   * content stays for operators (and #184's retention); the public sees the placeholder while
   * comments hang under it and nothing otherwise — never restored. A second deletion is NOT_FOUND.
   * It never passes `checkWriter`: deleting one's own post asks for a session and nothing more — not
   * the onboarding, not a consent a revision asks for again (owner decision 2026-10-19, ADR-0073),
   * and not #185's 작성 제한 either (#45-12: 자기 글 삭제는 제재 중에도 할 수 있다).
   * The post's row lock (`lockOwnPost`) waits for a comment being written under it, which holds
   * the row shared (CommentsService), so the answer counts that comment, and no comment lands
   * under the post once the deletion commits.
   */
  async delete(authorId: string, postId: string): Promise<PostDeletion> {
    return this.db.transaction(async (tx) => {
      await this.lockOwnPost(tx, authorId, postId);
      await tx
        .update(schema.posts)
        .set({ deletedAt: sql`now()` })
        .where(eq(schema.posts.id, postId));
      return { id: postId, placeholder: await postHasComments(tx, postId) };
    });
  }

  /**
   * The checks every new post and every edit passes, in the write's transaction and before any row
   * of the write is locked — the one place the rules on the writer plug in: `assertWriter` — the
   * writer's profile held until the commit, the onboarding (#57-8) and #185's 작성 제한 (RESTRICTED
   * with its end; it blocks writing and editing, never deleting, ADR-0069 decision 2 #45-12) — and
   * then #187's: the writer's number held (WriteLimitsService.lockWriter — the limits count the
   * person, decision 7). Answers the writer, whose write the caller counts
   * (`WriteLimitsService.take`: posts 3 in 10 minutes and 20 a day, edits 10 in 10 minutes and 50
   * a day, admins exempt, #45-15 and decision 7) once it is certain, and whose links it records.
   */
  private async checkWriter(tx: Tx, authorId: string): Promise<Writer> {
    await assertWriter(tx, authorId);
    return this.limits.lockWriter(tx, authorId);
  }

  /**
   * The author's own post, locked for the write: NOT_FOUND when it is unknown or deleted (gone
   * for its author too), FORBIDDEN when another account wrote it.
   *
   * FOR NO KEY UPDATE, the lock the write's own UPDATE takes (no key changes): it waits for, and
   * holds off, a comment or a like being written under the post (FOR SHARE) as FOR UPDATE did, but
   * not the foreign-key check of another write naming the post — #187's review list and link uses
   * (`link_flags`, `link_uses`, FOR KEY SHARE). An edit holds this row while it waits for its links'
   * lock (LinkReviewService.record), and the write holding that lock may put this post on the
   * review list: with FOR UPDATE the two would wait for each other (ADR-0083 7-13).
   */
  private async lockOwnPost(tx: Tx, authorId: string, postId: string) {
    const [current] = await tx
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.id, postId))
      .for('no key update');
    if (!current || current.deletedAt !== null) throw postNotFound();
    if (current.authorId !== authorId) {
      throw new AppError('FORBIDDEN', { message: 'Only its author changes a post' });
    }
    return current;
  }

  /**
   * The body's images, locked against the orphan clean-up (which skips locked rows) and against
   * another write taking the same upload: each must be an upload of the author's for a post, not
   * taken by another post nor by a notice (#138: an admin uploads a notice's images through the
   * same editor, and NoticesService locks them the same way). An image the clean-up removed
   * meanwhile is no upload any more. Refused as a VALIDATION_ERROR naming `body`, one issue per
   * image (`postImageNotUsableMessage`, which names it) — the editor uploads it again.
   *
   * Two statements, on purpose. Under READ COMMITTED a locking statement that waited for another
   * transaction re-reads only the rows it locked: a `post_images` row joined into it would still
   * come from the snapshot taken before the wait, so a write that waited on an upload another post
   * had just taken would read it as free. The lock comes first (in id order, so two writes with
   * overlapping images take them in the same order), and the read after it is a new statement
   * with a new snapshot, which sees what the write it waited for committed.
   */
  private async claimImages(
    tx: Tx,
    authorId: string,
    imageIds: readonly string[],
    postId: string,
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
            row.ownerId === authorId &&
            row.kind === 'post_image' &&
            row.noticeId === null &&
            (row.postId === null || row.postId === postId),
        )
        .map((row) => row.id),
    );
    const refused = imageIds.filter((id) => !usable.has(id));
    if (refused.length > 0) throw imagesNotUsable(refused);
  }

  /**
   * Records the post's images as its own (the first use stamps the upload's `attached_at`). An
   * image the post already has (an edit that keeps it) is left as it is — only that conflict, the
   * primary key: an image another post holds is `post_images_media_id_unique`, which `claimImages`
   * already refused under its lock, and which is refused the same way here should it ever get past.
   */
  private async attachImages(tx: Tx, postId: string, imageIds: readonly string[]): Promise<void> {
    if (imageIds.length === 0) return;
    const { mediaObjects, postImages } = schema;
    try {
      await tx
        .insert(postImages)
        .values(imageIds.map((mediaId) => ({ postId, mediaId })))
        .onConflictDoNothing({ target: [postImages.postId, postImages.mediaId] });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION, 'post_images_media_id_unique')) {
        throw imagesNotUsable(imageIds);
      }
      throw error;
    }
    await tx
      .update(mediaObjects)
      .set({ attachedAt: sql`now()` })
      .where(and(inArray(mediaObjects.id, [...imageIds]), isNull(mediaObjects.attachedAt)));
  }

  /** A post just written, as its author's screen shows it next. */
  private async published(postId: string): Promise<PublishedPost> {
    const post = await this.get(postId);
    if (post.state !== 'published') throw postNotFound();
    return post;
  }
}

/**
 * The posts a list shows (#45-5, #45-7): neither deleted nor hidden — the rows the community list's
 * partial index holds. A deleted post with comments under it stays a placeholder on its own page
 * and out of the community list («이대로», ADR-0074 decision 1 — the owner's answer was about that
 * list). The market detail's 토론 follows the same rule, card and count alike, as this PR's choice
 * until the owner says whether such a post should stand there as a placeholder card (ADR-0075 5-4,
 * 결과 4).
 */
function listed(): SQL | undefined {
  const { posts } = schema;
  return and(isNull(posts.deletedAt), isNull(posts.hiddenAt));
}

function postNotFound(): AppError {
  return new AppError('NOT_FOUND', { message: 'Post not found' });
}

/** The images a write cannot use, as the refusal names them (one issue each, under `body`). */
function imagesNotUsable(mediaIds: readonly string[]): AppError {
  return new AppError('VALIDATION_ERROR', {
    message: 'An image is not an upload of this account that another post has not taken',
    details: mediaIds.map((id) => ({ path: ['body'], message: postImageNotUsableMessage(id) })),
  });
}
