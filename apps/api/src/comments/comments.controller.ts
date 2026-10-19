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
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  COMMENT_BODY_MAX_LENGTH,
  commentDeletionSchema,
  commentThreadSchema,
  createCommentBodySchema,
  cursorQuerySchema,
  deleteCommentBodySchema,
  publishedCommentSchema,
  updateCommentBodySchema,
  uuidParamSchema,
  type CommentDeletion,
  type CommentThread,
  type CursorQuery,
  type DeleteCommentBody,
  type PublishedComment,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { CommentsService } from './comments.service.js';

/** A write's body after the global pipe: the text normalised (trimmed, line breaks as `\n`). */
interface ParsedBody {
  body: string;
  expectedAccountId: string;
}

/**
 * `/api/v1/posts/:postId/comments` (#48, ADR-0074): a post's comments, public — anyone reads,
 * signed in or not (N05 §2) — naming each author by public id, nickname, image and 운영자 mark only
 * (ADR-0069 decision 5; registry.ts `showsPerson`); and a new comment, open to accounts that
 * finished the onboarding (#57-8, OnboardedGuard), naming the account the screen shows.
 */
@ApiTags('comments')
@Controller('posts/:postId/comments')
export class PostCommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get()
  @ApiOperation({
    operationId: 'listComments',
    summary:
      'A post’s comments: its 댓글 oldest first, a page at a time, each with every 대댓글 under it ' +
      'oldest first; a deleted 댓글 that 대댓글 hang under and a hidden comment are placeholders, ' +
      'other deleted ones are left out. A post that is gone is NOT_FOUND',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(commentThreadSchema)
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  async list(
    @Param('postId', { schema: uuidParamSchema }) postId: string,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<CommentThread>> {
    const { items, nextCursor } = await this.comments.list(postId, query);
    return new ApiPage(items, { nextCursor });
  }

  @Post()
  @UseGuards(SessionGuard, OnboardedGuard)
  @ApiCookieAuth(SESSION_SECURITY_SCHEME)
  @ApiOperation({
    operationId: 'createComment',
    summary:
      `A comment of plain text (at most ${String(COMMENT_BODY_MAX_LENGTH)} characters, line ` +
      'breaks kept): a 댓글, or with parentId a 대댓글 — under the 댓글 named, or under the 댓글 of ' +
      'the 대댓글 named. A hidden or deleted post or 댓글 takes none (COMMENT_NOT_ALLOWED)',
  })
  @ApiData(publishedCommentSchema, 201)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field; nothing written).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'ONBOARDING_REQUIRED',
    'COMMENT_NOT_ALLOWED',
  )
  create(
    @CurrentUser() user: SessionUser,
    @Param('postId', { schema: uuidParamSchema }) postId: string,
    @Body({ schema: createCommentBodySchema }) body: ParsedBody & { parentId: string | null },
  ): Promise<PublishedComment> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.comments.create(user.id, postId, body.parentId, body.body);
  }
}

/**
 * `/api/v1/comments/:commentId` (#48, ADR-0074): the author's edit and deletion of a comment, by
 * the comment's id alone (a comment knows its post). Editing is open to accounts that finished the
 * onboarding, as writing is; deleting one's own needs a session only (as a post's: deleting stays
 * open whatever the account's state). Both name the account the screen shows.
 */
@ApiTags('comments')
@Controller('comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Put(':commentId')
  @UseGuards(SessionGuard, OnboardedGuard)
  @ApiCookieAuth(SESSION_SECURITY_SCHEME)
  @ApiOperation({
    operationId: 'updateComment',
    summary:
      'The author replaces the body; the comment shows as edited and the earlier version is kept ' +
      'for operators. The same text changes nothing. A hidden comment cannot be edited ' +
      '(COMMENT_NOT_EDITABLE)',
  })
  @ApiData(publishedCommentSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'ONBOARDING_REQUIRED',
    'COMMENT_NOT_EDITABLE',
  )
  update(
    @CurrentUser() user: SessionUser,
    @Param('commentId', { schema: uuidParamSchema }) commentId: string,
    @Body({ schema: updateCommentBodySchema }) body: ParsedBody,
  ): Promise<PublishedComment> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.comments.update(user.id, commentId, body.body);
  }

  /**
   * A POST rather than a DELETE, as a post's deletion is: the body names the account the screen
   * shows, and OpenAPI 3.0 leaves a DELETE's body undefined.
   */
  @Post(':commentId/delete')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiCookieAuth(SESSION_SECURITY_SCHEME)
  @ApiOperation({
    operationId: 'deleteComment',
    summary:
      'The author deletes the comment (a hidden one too): a 댓글 stays as the placeholder 삭제된 ' +
      '글입니다 while 대댓글 hang under it, and anything else is gone from every view. Never restored',
  })
  @ApiData(commentDeletionSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR')
  delete(
    @CurrentUser() user: SessionUser,
    @Param('commentId', { schema: uuidParamSchema }) commentId: string,
    @Body({ schema: deleteCommentBodySchema }) body: DeleteCommentBody,
  ): Promise<CommentDeletion> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.comments.delete(user.id, commentId);
  }
}
