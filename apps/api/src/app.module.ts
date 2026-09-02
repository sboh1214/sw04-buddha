import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { DbModule } from './infra/db/db.module.js';
import { RedisModule } from './infra/redis/redis.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // First match wins per key: apps/api/.env (local override), then the repo-root .env.
      envFilePath: ['.env', '../../.env'],
      validationSchema: envSchema,
    }),
    DbModule,
    RedisModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
