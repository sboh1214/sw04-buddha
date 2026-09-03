import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type PageMeta } from '@buddha/shared';
import { type Observable, map } from 'rxjs';
import { RAW_RESPONSE_METADATA, markRawResponse } from '../decorators/raw-response.decorator.js';

/**
 * Return an ApiPage from a handler to emit `{ data: items, meta: { nextCursor } }`
 * (PLAN 7 cursor pagination). Plain return values become `{ data }`.
 */
export class ApiPage<T> {
  constructor(
    readonly items: readonly T[],
    readonly meta: PageMeta,
  ) {}
}

export interface DataEnvelope<T> {
  data: T;
  meta?: PageMeta;
}

/**
 * Wraps every successful handler result in the PLAN 7 success envelope, except handlers
 * marked with @RawResponse(). For those it also flags the request so ApiExceptionFilter
 * leaves their error bodies untouched (filters cannot read handler metadata themselves).
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw) {
      markRawResponse(context.switchToHttp().getRequest<object>());
      return next.handle();
    }
    return next.handle().pipe(
      map((body: unknown): DataEnvelope<unknown> => {
        if (body instanceof ApiPage) return { data: body.items, meta: body.meta };
        return { data: body ?? null };
      }),
    );
  }
}
