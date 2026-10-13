import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { AdminAccountsController } from './admin-accounts.controller.js';
import { AdminAccountsService } from './admin-accounts.service.js';

/**
 * Admin accounts (#171). The service writes the role cache through AuthModule's AdminGuard;
 * guards are instantiated in the module that declares the controller, so DbModule and
 * RedisModule are imported for it as well.
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule],
  controllers: [AdminAccountsController],
  providers: [AdminAccountsService],
})
export class AdminAccountsModule {}
