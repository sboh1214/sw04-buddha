import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from '@buddha/shared';

/**
 * PLAN 7.2 cursor query (`cursorQuerySchema`), documented by hand in one place so every
 * listing endpoint describes the same contract: `cursorQuerySchema` carries a component id
 * (`CursorQuery`), and @nestjs/swagger 12 emits NO parameters for a `@Query({ schema })`
 * object that has one. Bounds mirror packages/shared/src/api/pagination.ts. A query DTO
 * without an id (`marketListQuerySchema`, `positionsQuerySchema`, ...) is expanded by
 * swagger itself and must NOT be declared with `@ApiQuery` as well — the document would list
 * every name twice, which `openapi-export.ts` refuses.
 */
export const CURSOR_QUERY_PARAMS = [
  {
    name: 'cursor',
    required: false,
    description: 'Opaque; `meta.nextCursor` of the previous page.',
    schema: { type: 'string' as const, minLength: 1, maxLength: 200 },
  },
  {
    name: 'limit',
    required: false,
    schema: {
      type: 'integer' as const,
      minimum: 1,
      maximum: PAGE_LIMIT_MAX,
      default: PAGE_LIMIT_DEFAULT,
    },
  },
] as const;
