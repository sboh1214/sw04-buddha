import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  INT4_MAX,
  adminCategoryChangeSchema,
  adminCategoryChangesQuerySchema,
  adminCategorySchema,
  createCategoryBodySchema,
  expectedAccountBodySchema,
  renameCategoryBodySchema,
  reorderCategoriesBodySchema,
  type AdminCategory,
  type AdminCategoryChange,
  type AdminCategoryChangesQuery,
  type CreateCategoryBody,
  type ExpectedAccountBody,
  type RenameCategoryBody,
  type ReorderCategoriesBody,
} from '@buddha/shared';
import * as z from 'zod';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { CategoryAdminService } from './category-admin.service.js';

/**
 * A category's id in a path: a positive integer within int4 (`categories.id` is a serial), so
 * anything else is malformed (400) and never reaches the database as a 500. An id no category has
 * is NOT_FOUND.
 */
export const categoryIdParamSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,9}$/)
  .refine((id) => Number(id) <= INT4_MAX, 'must be at most 2147483647')
  .transform(Number)
  .describe('A category’s id: a positive integer');

/**
 * 카테고리 관리 (#17) for admins. Guards run in order, as on every admin route: SessionGuard (401
 * without a session, 403 for a foreign Origin on a mutation), AdminGuard (403 for a member), then
 * OnboardedGuard (409 for an admin that has not finished the onboarding, ADR-0072). Every write
 * records the admin, the time and the value before and after in `admin_actions` when it changes
 * something (admin-audit.test.ts's AUDITED); none asks a reason or a second admin (ADR-0093
 * decision 2 #172 item 1). There is no DELETE: a category is hidden, and shown again. Those
 * records are read back as 변경 기록 (`GET changes`, 145-10, ADR-0164), declared right after the
 * list GET and before the `:id` routes.
 *
 * Every write names the admin the screen shows (`expectedAccountId` in the body;
 * assertExpectedAccount, ADR-0092): a mismatch with the cookie is refused (403 FORBIDDEN naming the
 * field) before anything is read, locked or written. The service is handed the rest of the body.
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/categories')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminCategoriesController {
  constructor(private readonly categories: CategoryAdminService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListCategories',
    summary:
      'Every category, hidden ones too, in the public order (top-level first, siblings by ' +
      'sortOrder then id), each with the markets filed under it in any status',
  })
  @ApiData(adminCategorySchema.array())
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED')
  adminListCategories(): Promise<AdminCategory[]> {
    return this.categories.list();
  }

  @Get('changes')
  @ApiOperation({
    operationId: 'adminListCategoryChanges',
    summary:
      '카테고리 변경 기록 (145-10): every add, rename, reorder, hide and show, newest first, with ' +
      'its admin, its time and the values before and after; categories by their current names',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminCategoryChangeSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListCategoryChanges(
    @Query({ schema: adminCategoryChangesQuerySchema }) query: AdminCategoryChangesQuery,
  ): Promise<ApiPage<AdminCategoryChange>> {
    const page = await this.categories.changes(query);
    return new ApiPage(page.data, page.meta);
  }

  @Post()
  @ApiOperation({
    operationId: 'adminCreateCategory',
    summary:
      'Add a top-level category (parentId null) or a sub-category of an active top-level one, ' +
      'last among its siblings; the slug is fixed from here. A slug any category has or a name a ' +
      'sibling has is refused naming the field, and so is a parent that is a sub-category or ' +
      'hidden; an unknown parent is NOT_FOUND naming parentId',
  })
  @ApiData(adminCategorySchema, 201)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminCreateCategory(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: createCategoryBodySchema }) body: CreateCategoryBody,
  ): Promise<AdminCategory> {
    const { expectedAccountId, ...fields } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.categories.create(admin.id, fields);
  }

  @Put('order')
  @ApiOperation({
    operationId: 'adminReorderCategories',
    summary:
      'Set the order of one group, the top-level categories (parentId null) or one parent’s ' +
      'sub-categories: every id of the group, hidden ones included, once each, first to last ' +
      '(else refused naming ids). Answers the group in its new order',
  })
  @ApiData(adminCategorySchema.array())
  // NOT_FOUND names `parentId` for an unknown parent.
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminReorderCategories(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: reorderCategoriesBodySchema }) body: ReorderCategoriesBody,
  ): Promise<AdminCategory[]> {
    const { expectedAccountId, ...order } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.categories.reorder(admin.id, order);
  }

  @Patch(':id')
  @ApiOperation({
    operationId: 'adminRenameCategory',
    summary:
      'Rename a category (its slug never changes); a name a sibling has is refused naming nameKo',
  })
  @ApiData(adminCategorySchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminRenameCategory(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: categoryIdParamSchema }) id: number,
    @Body({ schema: renameCategoryBodySchema }) body: RenameCategoryBody,
  ): Promise<AdminCategory> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.categories.rename(admin.id, id, body.nameKo);
  }

  @Post(':id/hide')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminHideCategory',
    summary:
      'Take a category out of new-market entry, the explore categories and the interest pick ' +
      '(never deleted; its markets keep it). A top-level category’s sub-categories go with it, ' +
      'their own state untouched',
  })
  @ApiData(adminCategorySchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminHideCategory(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: categoryIdParamSchema }) id: number,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<AdminCategory> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.categories.hide(admin.id, id);
  }

  @Post(':id/show')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminShowCategory',
    summary: 'Show a hidden category again',
  })
  @ApiData(adminCategorySchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminShowCategory(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: categoryIdParamSchema }) id: number,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<AdminCategory> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.categories.show(admin.id, id);
  }
}
