import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ApiExceptionFilter } from './filters/api-exception.filter.js';
import { ResponseEnvelopeInterceptor } from './interceptors/response-envelope.interceptor.js';
import { createValidationPipe } from './pipes/validation.pipe.js';

/**
 * PLAN 7 conventions as global providers (not `app.useGlobal*` in main.ts) so that
 * `Test.createTestingModule({ imports: [AppModule] })` exercises the same pipeline.
 */
@Module({
  providers: [
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class CommonModule {}
