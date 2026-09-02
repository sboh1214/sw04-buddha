import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envFilePaths, envSchema } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { DbModule } from './infra/db/db.module.js';
import { RedisModule } from './infra/redis/redis.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Absolute paths (apps/api/.env, then the repo-root .env); first match wins per key.
      envFilePath: envFilePaths,
      validationSchema: envSchema,
    }),
    DbModule,
    RedisModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
