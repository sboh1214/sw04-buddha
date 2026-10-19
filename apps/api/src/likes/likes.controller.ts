import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  likeStateSchema,
  myPostLikesSchema,
  updateLikeBodySchema,
  uuidParamSchema,
  type LikeState,
  type MyPostLikes,
  type UpdateLikeBody,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { LikesService } from './likes.service.js';

/*
 * 좋아요 (#49, ADR-0076). Liking and taking a like back are one route per target with the state in
 * the body, as the 관심 등록 is (`PUT /me/watchlist/:marketId`): idempotent either way, and the body
 * carries `expectedAccountId` (A-PG-24), which OpenAPI 3.0 leaves undefined on a DELETE. Both are
 * open to accounts that finished the onboarding (#57-8, OnboardedGuard) — and to a writing
 * restriction (#185, #45-12). Counted like the 관심 등록: the per-address bucket every route has.
 *
 * The counts ride on the public answers (`likeCount` of GET /posts, GET /posts/:postId and
 * GET /posts/:postId/comments), the same for everyone; whether the caller liked is the owner-only
 * `GET /me/likes/posts/:postId` — never a field of a public answer (PRIVATE_DATA `likers`).
 */

/** `PUT /api/v1/posts/:postId/like`: the caller likes a post, or takes the like back. */
@ApiTags('likes')
@Controller('posts')
export class PostLikesController {
  constructor(private readonly likes: LikesService) {}

  @Put(':postId/like')
  @UseGuards(SessionGuard, OnboardedGuard)
  @ApiCookieAuth(SESSION_SECURITY_SCHEME)
  @ApiOperation({
    operationId: 'updatePostLike',
    summary:
      'Like a post (liked: true) or take the like back (false); repeating either changes nothing. ' +
      'One like per person: per account and per verified number. One’s own post too, in any ' +
      'public market status. A deleted post’s placeholder and a hidden post take none ' +
      '(LIKE_NOT_ALLOWED). Answers the state and the post’s like count — not liked, nothing ' +
      'written, when another live account’s like holds the verified number’s place',
  })
  @ApiData(likeStateSchema)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field; nothing written).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'ONBOARDING_REQUIRED',
    'LIKE_NOT_ALLOWED',
  )
  update(
    @CurrentUser() user: SessionUser,
    @Param('postId', { schema: uuidParamSchema }) postId: string,
    @Body({ schema: updateLikeBodySchema }) body: UpdateLikeBody,
  ): Promise<LikeState> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.likes.setPostLike(user.id, postId, body.liked);
  }
}

/** `PUT /api/v1/comments/:commentId/like`: the caller likes a 댓글 or a 대댓글, or takes it back. */
@ApiTags('likes')
@Controller('comments')
export class CommentLikesController {
  constructor(private readonly likes: LikesService) {}

  @Put(':commentId/like')
  @UseGuards(SessionGuard, OnboardedGuard)
  @ApiCookieAuth(SESSION_SECURITY_SCHEME)
  @ApiOperation({
    operationId: 'updateCommentLike',
    summary:
      'Like a 댓글 or a 대댓글 (liked: true) or take the like back (false), as a post’s like. A ' +
      'deleted 댓글’s placeholder and a hidden comment take none (LIKE_NOT_ALLOWED). Answers the ' +
      'state and the comment’s like count',
  })
  @ApiData(likeStateSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'ONBOARDING_REQUIRED',
    'LIKE_NOT_ALLOWED',
  )
  update(
    @CurrentUser() user: SessionUser,
    @Param('commentId', { schema: uuidParamSchema }) commentId: string,
    @Body({ schema: updateLikeBodySchema }) body: UpdateLikeBody,
  ): Promise<LikeState> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.likes.setCommentLike(user.id, commentId, body.liked);
  }
}

/**
 * `GET /api/v1/me/likes/posts/:postId`: what the caller liked on one post page (the post, and the
 * comments under it). Owner-only: the session decides whose likes are read, and nothing here takes
 * another account (#49: nobody sees who liked).
 */
@ApiTags('likes')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me')
@UseGuards(SessionGuard)
export class MyLikesController {
  constructor(private readonly likes: LikesService) {}

  @Get('likes/posts/:postId')
  @ApiOperation({
    operationId: 'getMyPostLikes',
    summary:
      'Whether the account likes a post and which of the comments under it it likes (by its ' +
      'account, or by its verified number for a like a withdrawn account left); no count and ' +
      'nobody else’s',
  })
  @ApiData(myPostLikesSchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  get(
    @CurrentUser() user: SessionUser,
    @Param('postId', { schema: uuidParamSchema }) postId: string,
  ): Promise<MyPostLikes> {
    return this.likes.myPostLikes(user.id, postId);
  }
}
