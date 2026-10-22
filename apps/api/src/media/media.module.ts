import { Inject, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { type Db } from '@buddha/db';
import { fromNodeHeaders } from 'better-auth/node';
import { type FastifyInstance } from 'fastify';
import { AUTH, type Auth } from '../auth/auth.js';
import { AuthModule } from '../auth/auth.module.js';
import { type Env, webOrigins } from '../config/env.js';
import { DbModule } from '../infra/db/db.module.js';
import { DB } from '../infra/db/db.provider.js';
import { assertOnboarded } from '../onboarding/onboarded.guard.js';
import { installImageBodyParser } from './image-body.js';
import { MediaController } from './media.controller.js';
import { MediaService } from './media.service.js';
import {
  type RefusalLog,
  memoryAdmission,
  nestAdmissionLogger,
  processMemoryLimit,
  startMemoryAdmission,
} from './memory-admission.js';
import { OBJECT_STORAGE, objectStorageProvider } from './object-storage.provider.js';

/**
 * 올린 이미지 (#46, ADR-0073): `POST /media/images` and `GET /media/:mediaId`, the media store
 * (OBJECT_STORAGE) and the parser that lets an image body through. Exports the service and the
 * store for the posts, which attach uploads, and for #141's profile images.
 */
@Module({
  imports: [DbModule, AuthModule],
  controllers: [MediaController],
  // DbModule and AuthModule also serve the guards (SessionGuard, OnboardedGuard).
  providers: [MediaService, objectStorageProvider],
  exports: [MediaService, OBJECT_STORAGE],
})
export class MediaModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('MemoryAdmission');
  private refusals: RefusalLog | undefined;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly config: ConfigService<Env, true>,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Db,
  ) {}

  /**
   * Before the server starts, which is when Fastify still takes a content-type parser and hooks.
   * First the API's memory admission (owner decision 2026-10-22 answer 3, ADR-0073 9-46):
   * API_MEMORY_CEILING_MIB, or the container's limit less a margin, or none — said in the log at
   * start, with the process's RSS then, and its refusals at most once a minute
   * (`startMemoryAdmission`).
   */
  onModuleInit(): void {
    // Typed number | undefined, but an empty value comes back as the raw '' (memoryCeilingBytes).
    const configured: unknown = this.config.get('API_MEMORY_CEILING_MIB', { infer: true });
    this.refusals = startMemoryAdmission(memoryAdmission, {
      configured,
      limitBytes: processMemoryLimit(),
      logger: nestAdmissionLogger(this.logger),
    });
    const { httpAdapter } = this.adapterHost;
    // No HTTP adapter when the module graph is compiled without an app (the route registry's walk).
    if (httpAdapter === undefined) return;
    // What SessionGuard and OnboardedGuard ask, for the gate that refuses an upload before its body.
    installImageBodyParser(httpAdapter.getInstance<FastifyInstance>(), {
      trustedOrigins: new Set(
        webOrigins({
          WEB_ORIGIN: this.config.get('WEB_ORIGIN', { infer: true }),
          BETTER_AUTH_URL: this.config.get('BETTER_AUTH_URL', { infer: true }),
        }),
      ),
      sessionOf: (request) =>
        this.auth.api.getSession({ headers: fromNodeHeaders(request.headers) }),
      assertOnboarded: (userId) => assertOnboarded(this.db, userId),
    });
  }

  /** Writes the refusals pending in the log and stops its timer. */
  onModuleDestroy(): void {
    this.refusals?.close();
  }
}
