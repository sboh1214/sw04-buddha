import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  authoredCommentSchema,
  cursorQuerySchema,
  myCommentSchema,
  myPostSchema,
  postSummarySchema,
  publicIdParamSchema,
  type AuthoredComment,
  type CursorQuery,
  type MyComment,
  type MyPost,
  type PostSummary,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { AuthoredService } from './authored.service.js';

/**
 * `/api/v1/profiles/:publicId/posts` and `/comments` (#51, ADR-0080): the public profile's 글 and
 * 댓글 tabs (ADR-0069 decision 3 #37-14). Public — anyone reads them, signed in or not, as the
 * profile (#37-1) — and the same answer for every reader. They name the member by the public face
 * alone (ADR-0069 decision 5; registry.ts `showsPerson`), as every byline does. Counted like every
 * public read: the per-address bucket every route has.
 *
 * `cursorQuerySchema` carries a component id, so its parameters are written out by hand
 * (`CURSOR_QUERY_PARAMS`, cursor-query.ts says why).
 */
@ApiTags('profiles')
@Controller('profiles')
export class ProfileAuthoredController {
  constructor(private readonly authored: AuthoredService) {}

  @Get(':publicId/posts')
  @ApiOperation({
    operationId: 'listProfilePosts',
    summary:
      'A member’s posts on their profile, newest first, as the community list’s cards: never a ' +
      'deleted or hidden one; those on ended and voided markets included, and all of them while ' +
      'the member is under a restriction. An unknown public id is NOT_FOUND, as the profile',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(postSummarySchema)
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  async posts(
    @Param('publicId', { schema: publicIdParamSchema }) publicId: string,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<PostSummary>> {
    const { items, nextCursor } = await this.authored.profilePosts(publicId, query);
    return new ApiPage(items, { nextCursor });
  }

  @Get(':publicId/comments')
  @ApiOperation({
    operationId: 'listProfileComments',
    summary:
      'A member’s 댓글 and 대댓글 on their profile, newest first, each with the post it sits under ' +
      '(a placeholder by its id alone) and its market: never a deleted or hidden one, those ' +
      'under a hidden or deleted post included. An unknown public id is NOT_FOUND',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(authoredCommentSchema)
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  async comments(
    @Param('publicId', { schema: publicIdParamSchema }) publicId: string,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AuthoredComment>> {
    const { items, nextCursor } = await this.authored.profileComments(publicId, query);
    return new ApiPage(items, { nextCursor });
  }
}

/**
 * `/api/v1/me/posts` and `/me/comments` (#51, ADR-0080): MY '내 글''s 글 and 댓글 tabs, newest
 * first with no filter (ADR-0069 decision 4 #51). Owner-only: the session decides whose items are
 * read, and nothing here takes another account. Signed in is enough — reading one's own writing
 * asks no onboarding, as a deletion asks none. The hidden items are there, marked with the reason
 * (#45-5; a report reason and the operator's note, owner decision 2026-10-22); the deleted ones are
 * not. MY's 삭제 on a hidden item uses the author's own delete routes (`POST /posts/:postId/delete`,
 * `POST /comments/:commentId/delete`), which take a hidden one (ADR-0080).
 */
@ApiTags('me')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me')
@UseGuards(SessionGuard)
export class MyAuthoredController {
  constructor(private readonly authored: AuthoredService) {}

  @Get('posts')
  @ApiOperation({
    operationId: 'listMyPosts',
    summary:
      'The account’s own posts, newest first, as the community list’s cards with `hidden` (and ' +
      'its reason) on one an operator hid; never a deleted one',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(myPostSchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  async posts(
    @CurrentUser() user: SessionUser,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<MyPost>> {
    const { items, nextCursor } = await this.authored.myPosts(user.id, query);
    return new ApiPage(items, { nextCursor });
  }

  @Get('comments')
  @ApiOperation({
    operationId: 'listMyComments',
    summary:
      'The account’s own 댓글 and 대댓글, newest first, each with its post and market, with ' +
      '`hidden` (and its reason) on one an operator hid; never a deleted one',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(myCommentSchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  async comments(
    @CurrentUser() user: SessionUser,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<MyComment>> {
    const { items, nextCursor } = await this.authored.myComments(user.id, query);
    return new ApiPage(items, { nextCursor });
  }
}
