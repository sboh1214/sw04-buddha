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
  NOTIFICATION_UNREAD_COUNT_CAP,
  cursorQuerySchema,
  expectedAccountBodySchema,
  notificationReadResultSchema,
  notificationSchema,
  notificationSettingCategoryParamSchema,
  notificationSettingsSchema,
  notificationUnreadCountSchema,
  updateNotificationSettingBodySchema,
  uuidParamSchema,
  type CursorQuery,
  type ExpectedAccountBody,
  type Notification,
  type NotificationCategory,
  type NotificationReadResult,
  type NotificationSettings,
  type NotificationUnreadCount,
  type UpdateNotificationSettingBody,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { NotificationsService } from './notifications.service.js';

const CAP = String(NOTIFICATION_UNREAD_COUNT_CAP);

/**
 * `/api/v1/me/notifications` (앱 내 알림함, #53, ADR-0157; N05 §4·§8): the member's own inbox — the
 * list, the unread count MY's 알림 marks show, and the read marks. Owner-only: the session decides
 * whose inbox is read or marked, and nothing here takes another account; another account's
 * notification answers as a missing one (404). No route here creates a notification: the producers
 * write them in their events' transactions (@buddha/db `createNotifications`).
 *
 * SessionGuard only, no OnboardedGuard: a restricted account receives every type and reads them
 * (53-6), and an account that has not finished the onboarding reads its own inbox like its
 * watchlist and search history — no write here is trading or writing. Counted by the per-address
 * bucket every route has, no named one.
 *
 * Each write names the account the screen shows (`expectedAccountId`, ADR-0091·0092): a window
 * still showing account A after another one signed in as B would otherwise mark B's notifications
 * read. `cursorQuerySchema` carries a component id, so its two parameters are declared by hand.
 *
 * 수신 설정 (#56, ADR-0162) lives here too: a private setting, so read and written under an account
 * or a writing restriction as the time zone is (ADR-0157 결과 6, ADR-0069 #37-9) — no RESTRICTED.
 */
@ApiTags('notifications')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me/notifications')
@UseGuards(SessionGuard)
export class MeNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    operationId: 'listMyNotifications',
    summary:
      'The account’s notifications (알림, #53), newest first by when they occurred — a merged one ' +
      'at its latest event: type, category, params, target, how many events it holds, when it ' +
      'occurred and when it was first read (null while unread). Listing marks nothing read',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(notificationSchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  async list(
    @CurrentUser() user: SessionUser,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<Notification>> {
    const { items, nextCursor } = await this.notifications.list(user.id, query);
    return new ApiPage(items, { nextCursor });
  }

  @Get('unread-count')
  @ApiOperation({
    operationId: 'getMyNotificationUnreadCount',
    summary:
      'How many of the account’s notifications are unread, counted up to ' +
      `${CAP} (${CAP} means ${CAP} or more)`,
  })
  @ApiData(notificationUnreadCountSchema)
  @ApiErrors('UNAUTHENTICATED')
  unreadCount(@CurrentUser() user: SessionUser): Promise<NotificationUnreadCount> {
    return this.notifications.unreadCount(user.id);
  }

  /**
   * Opening a notification marks it read (53-2: the web sends this when the member follows it).
   * Idempotent: one already read answers as it is, its first read kept.
   */
  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'readMyNotification',
    summary:
      'Mark one of the account’s notifications read (repeating it changes nothing; another ' +
      'account’s id is NOT_FOUND); answers it as it now stands and the unread count after it',
  })
  @ApiData(notificationReadResultSchema)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field; nothing written).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR', 'NOT_FOUND')
  read(
    @CurrentUser() user: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<NotificationReadResult> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.notifications.read(user.id, id);
  }

  /** '모두 읽음' (53-2): every notification unread when it runs. */
  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'readAllMyNotifications',
    summary:
      'Mark every unread notification of the account read (모두 읽음); answers the unread count ' +
      'after it',
  })
  @ApiData(notificationUnreadCountSchema)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field; nothing written).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  readAll(
    @CurrentUser() user: SessionUser,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<NotificationUnreadCount> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.notifications.readAll(user.id);
  }

  /** 수신 설정 (#56, 52-21·56-2): one switch per category that has a type, on until turned off. */
  @Get('settings')
  @ApiOperation({
    operationId: 'getMyNotificationSettings',
    summary:
      'The account’s notification settings (수신 설정, #56): whether each category (trade, ' +
      'market, community — those with a notification type) is on; every one starts on',
  })
  @ApiData(notificationSettingsSchema)
  @ApiErrors('UNAUTHENTICATED', 'NOT_FOUND')
  settings(@CurrentUser() user: SessionUser): Promise<NotificationSettings> {
    return this.notifications.settings(user.id);
  }

  /**
   * One category on or off (52-21: every one can be turned off, none is locked), idempotent; one
   * category per write so two tabs' switches never undo each other. While off, nothing of it is
   * made or merged (52-22); what the inbox already holds stays (56-1).
   */
  @Put('settings/:category')
  @ApiOperation({
    operationId: 'updateMyNotificationSetting',
    summary:
      'Turn one notification category on or off for the account (repeating it changes ' +
      'nothing); while off no notification of it is made, and those already received stay. ' +
      'Answers every setting after it',
  })
  @ApiData(notificationSettingsSchema)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field; nothing written).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR', 'NOT_FOUND')
  updateSetting(
    @CurrentUser() user: SessionUser,
    @Param('category', { schema: notificationSettingCategoryParamSchema })
    category: NotificationCategory,
    @Body({ schema: updateNotificationSettingBodySchema }) body: UpdateNotificationSettingBody,
  ): Promise<NotificationSettings> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.notifications.setCategory(user.id, category, body.enabled);
  }
}
