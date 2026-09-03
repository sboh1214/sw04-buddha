import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

/**
 * PLAN 12 admin surface. Guards are instantiated in the module that declares the controller,
 * so DbModule and RedisModule must be resolvable here as well (AdminGuard reads the role from
 * Postgres through a Redis cache).
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule, WalletModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
