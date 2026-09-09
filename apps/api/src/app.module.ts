import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminModule } from './admin/admin.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CommonModule } from './common/common.module.js';
import { envFilePaths, envSchema } from './config/env.js';
import { DisputesModule } from './disputes/disputes.module.js';
import { HealthController } from './health/health.controller.js';
import { DbModule } from './infra/db/db.module.js';
import { RedisModule } from './infra/redis/redis.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { MarketsModule } from './markets/markets.module.js';
import { MeModule } from './me/me.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { TradesModule } from './trades/trades.module.js';
import { WalletModule } from './wallet/wallet.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Absolute paths (apps/api/.env, then the repo-root .env); first match wins per key.
      envFilePath: envFilePaths,
      validationSchema: envSchema,
    }),
    // Global pipe / envelope interceptor / error filter (PLAN 7).
    CommonModule,
    DbModule,
    RedisModule,
    AuthModule,
    MeModule,
    WalletModule,
    AdminModule,
    RealtimeModule,
    JobsModule,
    MarketsModule,
    TradesModule,
    DisputesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
