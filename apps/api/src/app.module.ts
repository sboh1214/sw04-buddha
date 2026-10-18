import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminAccountsModule } from './admin-accounts/admin-accounts.module.js';
import { AdminModule } from './admin/admin.module.js';
import { ApprovalsModule } from './approvals/approvals.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CommonModule } from './common/common.module.js';
import { envFilePaths, envSchema } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { DbModule } from './infra/db/db.module.js';
import { RedisModule } from './infra/redis/redis.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { MarketsModule } from './markets/markets.module.js';
import { MeModule } from './me/me.module.js';
import { AdminSmsStatusModule } from './phone-verification/admin-sms-status.module.js';
import { PhoneVerificationModule } from './phone-verification/phone-verification.module.js';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { ReleaseSettingsModule } from './release-settings/release-settings.module.js';
import { SearchHistoryModule } from './search-history/search-history.module.js';
import { StartGrantModule } from './start-grant/start-grant.module.js';
import { TradesModule } from './trades/trades.module.js';
import { WalletModule } from './wallet/wallet.module.js';
import { WatchlistModule } from './watchlist/watchlist.module.js';

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
    // Global rate-limit guard (PLAN 7.5). After AuthModule: its `user` scope reads sessions
    // through the same better-auth instance, and a guard is only reachable once routing exists.
    RateLimitModule,
    MeModule,
    PhoneVerificationModule,
    WalletModule,
    AdminModule,
    RealtimeModule,
    JobsModule,
    MarketsModule,
    TradesModule,
    WatchlistModule,
    SearchHistoryModule,
    ReleaseSettingsModule,
    AdminAccountsModule,
    AdminSmsStatusModule,
    ApprovalsModule,
    // No routes (ADR-0071): the start grant is an internal service the onboarding (#58) calls.
    StartGrantModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
