import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  POST_BODY_MAX_LENGTH,
  POST_IMAGES_MAX,
  createPostBodySchema,
  deletePostBodySchema,
  postDeletionSchema,
  postListQuerySchema,
  postSchema,
  postSummarySchema,
  updatePostBodySchema,
  uuidParamSchema,
  type DeletePostBody,
  type Post as PostShape,
  type PostDeletion,
  type PostListQuery,
  type PostSummary,
  type PublishedPost,
  type SanitizedPostDocument,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { PostsService } from './posts.service.js';

/** A write's body after the global pipe: the title trimmed or null, the body normalised. */
interface ParsedContent {
  title: string | null;
  body: SanitizedPostDocument;
  expectedAccountId: string;
}

/**
 * `/api/v1/posts` (#46, ADR-0073): 근거 글. The list and a post are public — anyone reads, signed in
 * or not (N05 §2) — and name the author by public id, nickname, image and 운영자 mark only
 * (ADR-0069 decision 5; registry.ts `showsPerson`). Writing and editing are open to accounts that
 * finished the onboarding (#57-8, OnboardedGuard), deleting one's own post to any signed-in author
 * (owner decision 2026-10-19), each naming the account the screen shows (`expectedAccountId`).
 *
 * `postListQuerySchema` carries no `.meta({ id })`, so swagger expands it into one parameter per
 * field by itself (markets.controller.ts says why no `@ApiQuery` sits beside it).
 */
@ApiTags('posts')
@Controller('posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get()
  @ApiOperation({
    operationId: 'listPosts',
    summary:
      'The community list: every market’s posts, newest first (the only order), never a deleted ' +
      'or hidden one; narrowed by market, by category (either level, like GET /markets) and by q, ' +
      'a case-insensitive partial match in the title or the text',
  })
  @ApiPageOf(postSummarySchema)
  @ApiErrors('VALIDATION_ERROR')
  async list(
    @Query({ schema: postListQuerySchema }) query: PostListQuery,
  ): Promise<ApiPage<PostSummary>> {
    const { items, nextCursor } = await this.posts.list(query);
    return new ApiPage(items, { nextCursor });
  }

  @Get(':postId')
  @ApiOperation({
    operationId: 'getPost',
    summary:
      'A post page: the whole post, or a placeholder for a hidden post and for a deleted one ' +
      'that comments not deleted (hidden ones too) still hang under; a deleted post with none ' +
      'is NOT_FOUND',
  })
  @ApiData(postSchema)
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  get(@Param('postId', { schema: uuidParamSchema }) postId: string): Promise<PostShape> {
    return this.posts.get(postId);
  }

  @Post()
  @UseGuards(SessionGuard, OnboardedGuard)
  @ApiCookieAuth(SESSION_SECURITY_SCHEME)
  @ApiOperation({
    operationId: 'createPost',
    summary:
      'A post on a market in any public status: an optional title and a formatted body (at most ' +
      `${String(POST_BODY_MAX_LENGTH)} characters of text and ${String(POST_IMAGES_MAX)} images, ` +
      'each an upload of the author’s own); formatting outside the allow-list is removed',
  })
  @ApiData(postSchema, 201)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field; nothing written).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR', 'ONBOARDING_REQUIRED')
  create(
    @CurrentUser() user: SessionUser,
    @Body({ schema: createPostBodySchema }) body: ParsedContent & { marketId: string },
  ): Promise<PublishedPost> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.posts.create(user.id, body.marketId, { title: body.title, body: body.body });
  }

  @Put(':postId')
  @UseGuards(SessionGuard, OnboardedGuard)
  @ApiCookieAuth(SESSION_SECURITY_SCHEME)
  @ApiOperation({
    operationId: 'updatePost',
    summary:
      'The author replaces the title and the body (never the market); the post shows as edited ' +
      'and the earlier version is kept for operators. The same content changes nothing. A ' +
      'hidden post cannot be edited (POST_NOT_EDITABLE)',
  })
  @ApiData(postSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'ONBOARDING_REQUIRED',
    'POST_NOT_EDITABLE',
  )
  update(
    @CurrentUser() user: SessionUser,
    @Param('postId', { schema: uuidParamSchema }) postId: string,
    @Body({ schema: updatePostBodySchema }) body: ParsedContent,
  ): Promise<PublishedPost> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.posts.update(user.id, postId, { title: body.title, body: body.body });
  }

  /**
   * A POST rather than a DELETE, as the search history's deletes are: the body names the account
   * the screen shows, and OpenAPI 3.0 leaves a DELETE's body undefined.
   *
   * Signed in is enough — no OnboardedGuard (owner decision 2026-10-19, ADR-0073): an author whose
   * consent a revision asks for again, or who has not finished the onboarding for any other reason,
   * still deletes their own post, as a restriction from writing (#185) leaves deleting open
   * (ADR-0069 decision 2 #45-12).
   */
  @Post(':postId/delete')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiCookieAuth(SESSION_SECURITY_SCHEME)
  @ApiOperation({
    operationId: 'deletePost',
    summary:
      'The author deletes the post (a hidden one too), signed in whatever their onboarding: it ' +
      'stays as the placeholder 삭제된 글입니다 while comments not deleted (hidden ones too) hang ' +
      'under it, and is gone from every view otherwise. Never restored',
  })
  @ApiData(postDeletionSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR')
  delete(
    @CurrentUser() user: SessionUser,
    @Param('postId', { schema: uuidParamSchema }) postId: string,
    @Body({ schema: deletePostBodySchema }) body: DeletePostBody,
  ): Promise<PostDeletion> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.posts.delete(user.id, postId);
  }
}
