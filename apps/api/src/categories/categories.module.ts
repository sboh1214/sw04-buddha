import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { AdminCategoriesController } from './admin-categories.controller.js';
import { CategoryAdminService } from './category-admin.service.js';

/**
 * 카테고리 관리 (#17): the admins' writes of the category tree (`/admin/categories`). The public read
 * (`GET /categories`) stays the markets module's, which answers the tree as these writes leave it.
 * DbModule and RedisModule are imported for AdminGuard, which reads the role through the Redis
 * cache and is instantiated in the module that declares the controller.
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule],
  controllers: [AdminCategoriesController],
  providers: [CategoryAdminService],
})
export class CategoriesModule {}
