import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  canonicalJson,
  decodeKeyset,
  encodeKeyset,
  mediaPath,
  postExcerpt,
  postImageNotUsableMessage,
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
import { and, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { PG_UNIQUE_VIOLATION, isPgError } from '../common/errors/pg-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { DB } from '../infra/db/db.provider.js';
import { inCategory, likePattern } from '../markets/market.service.js';
import { assertOnboarded } from '../onboarding/onboarded.guard.js';
import { type Page } from '../wallet/wallet.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/** What a post write sends, the body normalised by `postDocumentInputSchema`. */
export interface PostContent {
  title: string | null;
  body: SanitizedPostDocument;
}

/**
 * How much of a post's text a list reads for its card: the excerpt keeps POST_EXCERPT_MAX_LENGTH
 * characters of the non-empty lines, and this leaves room for blank lines before them without
 * moving whole bodies for a page of cards.
 */
const LIST_TEXT_HEAD = 2_000;

/** The account behind a post, as a query reads it. */
interface AuthorRow {
  publicId: string;
  nickname: string;
  role: Role;
}

/**
 * Who wrote a post, as every public answer names a person (ADR-0069 decision 5): the public id,
 * the CURRENT nickname (#37-3), the image and the 운영자 mark (#45-9: an admin account's every
 * post). Never the account id. The one place an author is shown, so #140 makes a withdrawn author
 * `{ kind: 'former_member' }` here ('탈퇴한 사용자', #37-16) and #141 fills `imageUrl` here.
 */
export function postAuthorOf(row: AuthorRow): PostAuthor {
  return {
    kind: 'member',
    publicId: row.publicId,
    nickname: row.nickname,
    imageUrl: null,
    isAdmin: row.role === 'admin',
  };
}

/** The market a post belongs to, as a card and the post page link to it. */
function postMarketOf(row: {
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
 * What the public sees of a post (#45-5), by its times and whether replies hang under it:
 * `published`; `deleted` — the author deleted it and replies hang under it, the placeholder
 * '삭제된 글입니다' with the author hidden; `gone` — deleted with nothing under it, out of every
 * view; `hidden` — an operator hid it, '운영 정책에 따라 숨긴 글입니다'. The author's deletion
 * comes first: a hidden post its author deleted is deleted.
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
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The columns both public reads select: the post, its author's public face, its market. */
  private readonly columns = {
    id: schema.posts.id,
    title: schema.posts.title,
    imageIds: schema.posts.imageIds,
    createdAt: schema.posts.createdAt,
    editedAt: schema.posts.editedAt,
    deletedAt: schema.posts.deletedAt,
    hiddenAt: schema.posts.hiddenAt,
    // The author's public face only: the account id is not even read on the public path.
    author: {
      publicId: schema.profiles.publicId,
      nickname: schema.profiles.nickname,
      role: schema.profiles.role,
    },
    market: {
      id: schema.markets.id,
      slug: schema.markets.slug,
      title: schema.markets.title,
      status: schema.markets.status,
      categorySlug: schema.categories.slug,
      categoryNameKo: schema.categories.nameKo,
    },
  };

  /**
   * `GET /posts`: the community list (#45-7), newest first — the only order — never a deleted or
   * a hidden post (the list's partial index holds exactly the rest). `marketId` narrows to one
   * market, `category` to a category on either level (a top-level slug includes its children, as
   * `GET /markets` reads it), `q` to a case-insensitive partial match in the title or the text
   * (`search_text`'s trigram index serves a term of three characters or more). A cursor that does
   * not decode serves the first page.
   */
  async list(query: PostListQuery): Promise<Page<PostSummary>> {
    const { posts, profiles, markets, categories } = schema;
    const cursor = decodeKeyset(query.cursor, 'uuid');
    const rows = await this.db
      .select({
        ...this.columns,
        textHead: sql<string>`left(${posts.bodyText}, ${LIST_TEXT_HEAD})`,
      })
      .from(posts)
      .innerJoin(profiles, eq(profiles.userId, posts.authorId))
      .innerJoin(markets, eq(markets.id, posts.marketId))
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .where(
        and(
          isNull(posts.deletedAt),
          isNull(posts.hiddenAt),
          query.marketId === undefined ? undefined : eq(posts.marketId, query.marketId),
          query.category === undefined ? undefined : inCategory(this.db, query.category),
          query.q === undefined ? undefined : ilike(posts.searchText, likePattern(query.q)),
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
      })),
      nextCursor: hasMore && last ? encodeKeyset({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  /**
   * `GET /posts/:postId`: the post page, in the state the public sees (`publicStateOf`). A post
   * that is gone — deleted with nothing under it, or never there — is NOT_FOUND.
   */
  async get(postId: string): Promise<Post> {
    const { posts, profiles, markets, categories } = schema;
    const [row] = await this.db
      .select({ ...this.columns, body: posts.body })
      .from(posts)
      .innerJoin(profiles, eq(profiles.userId, posts.authorId))
      .innerJoin(markets, eq(markets.id, posts.marketId))
      .innerJoin(categories, eq(categories.id, markets.categoryId))
      .where(eq(posts.id, postId))
      .limit(1);
    if (!row) throw postNotFound();
    const state = publicStateOf(row, await this.hasReplies(this.db, row.id));
    const market = postMarketOf(row.market);
    switch (state) {
      case 'gone':
        throw postNotFound();
      case 'deleted':
      case 'hidden':
        return { state, id: row.id, market };
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
        };
    }
  }

  /**
   * `POST /posts`: a post on a market in any public status (#45-6). The market must exist and not
   * be a draft (NOT_FOUND naming `marketId`, as the public never sees a draft); every image must be
   * the author's own upload, taken by no other post (`claimImages`). Nothing about the author's
   * trading is read or attached (N05 §2).
   */
  async create(authorId: string, marketId: string, content: PostContent): Promise<PublishedPost> {
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await this.checkWriter(tx, authorId);
      const { markets } = schema;
      const [market] = await tx
        .select({ status: markets.status })
        .from(markets)
        .where(eq(markets.id, marketId));
      if (!market || market.status === 'draft') {
        throw new AppError('NOT_FOUND', {
          message: 'Market not found',
          details: [{ path: ['marketId'], message: 'no such market' }],
        });
      }
      await this.claimImages(tx, authorId, content.body.imageIds, id);
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
    });
    return this.published(id);
  }

  /**
   * `PUT /posts/:postId`: the author replaces the title and the body (#45-4: any time, never the
   * market). The version replaced goes to the operators' history (`post_revisions`) and the post
   * is marked edited; sending what the post already says changes nothing. Refused for anyone but
   * the author (FORBIDDEN), a deleted or unknown post (NOT_FOUND) and a hidden one
   * (POST_NOT_EDITABLE, #45-5). An image the edit takes out stays attached for the history and is
   * no longer served (`GET /media/:mediaId` serves the current body's).
   */
  async update(authorId: string, postId: string, content: PostContent): Promise<PublishedPost> {
    await this.db.transaction(async (tx) => {
      const current = await this.lockOwnPost(tx, authorId, postId);
      if (current.hiddenAt !== null) {
        const details: PostNotEditableDetails = { reason: 'hidden' };
        throw new AppError('POST_NOT_EDITABLE', { message: 'The post is hidden', details });
      }
      await this.checkWriter(tx, authorId);
      if (
        current.title === content.title &&
        canonicalJson(current.body) === canonicalJson(content.body.document)
      ) {
        return;
      }
      await this.claimImages(tx, authorId, content.body.imageIds, postId);
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
    });
    return this.published(postId);
  }

  /**
   * `POST /posts/:postId/delete`: the author deletes the post (#45-5), a hidden one too. Its
   * content stays for operators (and #184's retention); the public sees the placeholder while
   * replies hang under it and nothing otherwise — never restored. A second deletion is NOT_FOUND.
   */
  async delete(authorId: string, postId: string): Promise<PostDeletion> {
    return this.db.transaction(async (tx) => {
      await this.lockOwnPost(tx, authorId, postId);
      await tx
        .update(schema.posts)
        .set({ deletedAt: sql`now()` })
        .where(eq(schema.posts.id, postId));
      return { id: postId, placeholder: await this.hasReplies(tx, postId) };
    });
  }

  /**
   * The checks every new post and every edit passes, in the write's transaction — the one place
   * the later rules plug in: #185's 작성 제한 (which blocks writing and editing, never deleting,
   * ADR-0069 decision 2 #45-12) and #187's frequency limits (posts 3 in 10 minutes and 20 a day,
   * edits 10 in 10 minutes and 50 a day, counted per verified number's keyed hash, admins exempt,
   * #45-15 and decision 7). Today: the onboarding, which OnboardedGuard checked before the body
   * was read, held to the commit here (#57-8).
   */
  private async checkWriter(tx: Tx, authorId: string): Promise<void> {
    await assertOnboarded(tx, authorId);
  }

  /**
   * Whether replies hang under a post, which keeps a deleted post as a placeholder (#45-5). There
   * are none before the comments (#48), which answers it here.
   */
  private hasReplies(_executor: Executor, _postId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * The author's own post, locked for the write: NOT_FOUND when it is unknown or deleted (gone
   * for its author too), FORBIDDEN when another account wrote it.
   */
  private async lockOwnPost(tx: Tx, authorId: string, postId: string) {
    const [current] = await tx
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.id, postId))
      .for('update');
    if (!current || current.deletedAt !== null) throw postNotFound();
    if (current.authorId !== authorId) {
      throw new AppError('FORBIDDEN', { message: 'Only its author changes a post' });
    }
    return current;
  }

  /**
   * The body's images, locked against the orphan clean-up (which skips locked rows) and against
   * another write taking the same upload: each must be an upload of the author's for a post, not
   * taken by another post. An image the clean-up removed meanwhile is no upload any more. Refused
   * as a VALIDATION_ERROR naming `body`, one issue per image (`postImageNotUsableMessage`, which
   * names it) — the editor uploads it again.
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
    const { mediaObjects, postImages } = schema;
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
      })
      .from(mediaObjects)
      .leftJoin(postImages, eq(postImages.mediaId, mediaObjects.id))
      .where(inArray(mediaObjects.id, ids));
    const usable = new Set(
      rows
        .filter(
          (row) =>
            row.ownerId === authorId &&
            row.kind === 'post_image' &&
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
