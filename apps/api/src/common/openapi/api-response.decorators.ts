import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import {
  countedPageEnvelope,
  dataEnvelope,
  type ErrorCode,
  errorEnvelopeSchema,
  pageEnvelope,
} from '@buddha/shared';
import type * as z from 'zod';
import { HTTP_STATUS_BY_CODE } from '../errors/app-error.js';

/**
 * Documents a `{ data }` success response from the zod schema of `data`.
 * @nestjs/swagger 12 converts Standard JSON Schema (zod 4 `~standard.jsonSchema`) itself;
 * schemas carrying `.meta({ id })` become named components.
 */
export function ApiData(schema: z.ZodType, status = 200): MethodDecorator {
  return ApiResponse({ status, standardSchema: dataEnvelope(schema) });
}

/** Documents a `{ data: T[], meta: { nextCursor } }` cursor page. */
export function ApiPageOf(item: z.ZodType, status = 200): MethodDecorator {
  return ApiResponse({ status, standardSchema: pageEnvelope(item) });
}

/** Documents a `{ data: T[], meta: { nextCursor, total } }` cursor page that counts its list. */
export function ApiCountedPageOf(item: z.ZodType, status = 200): MethodDecorator {
  return ApiResponse({ status, standardSchema: countedPageEnvelope(item) });
}

/**
 * Documents the error envelope for each code a handler can produce, one response per
 * HTTP status (codes sharing a status are listed in the description).
 */
export function ApiErrors(...codes: ErrorCode[]): MethodDecorator {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const status = HTTP_STATUS_BY_CODE[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return applyDecorators(
    ...[...byStatus.entries()].map(([status, list]) =>
      ApiResponse({ status, description: list.join(' | '), standardSchema: errorEnvelopeSchema }),
    ),
  );
}
