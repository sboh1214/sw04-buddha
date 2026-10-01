import { type RawBodyRequest } from '@nestjs/common';
import { type FastifyRequest } from 'fastify';

/**
 * The fields of a SmartroPay callback: a form-urlencoded body (the ReturnUrl, StopUrl and
 * 재통보 posts) and, for the stop, whatever the query carried.
 *
 * The API's urlencoded parser stays OFF (auth.module.ts — a form body is what a cross-site
 * forgery submits, and every other route must keep answering it with 400), so these three
 * handlers read the raw bytes the parser kept (`bodyParser.rawBody`) and decode them here.
 * UTF-8 is SmartroPay's charset ("스마트로페이 PC, Mobile 모듈의 기본 Charset은 UTF-8").
 *
 * A Map, not an object: the keys are chosen by whoever posts, and `__proto__` is a key.
 */
export type CallbackFields = ReadonlyMap<string, string>;

export interface CallbackRequest {
  /** `m` from the query: the Moid we put into ReturnUrl/StopUrl ourselves. */
  moid: string | undefined;
  fields: CallbackFields;
}

/** More fields than any SmartroPay answer has; the rest are ignored, never stored. */
const MAX_FIELDS = 100;

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

export function readCallback(request: RawBodyRequest<FastifyRequest>): CallbackRequest {
  const fields = new Map<string, string>();
  const add = (key: string, value: unknown): void => {
    if (typeof value !== 'string' || fields.size >= MAX_FIELDS || fields.has(key)) return;
    // Postgres refuses U+0000 in text and jsonb; a field carrying one is not worth a 500.
    fields.set(key, value.replaceAll('\u0000', ''));
  };

  const contentType = request.headers['content-type']?.toLowerCase() ?? '';
  if (request.rawBody && contentType.startsWith(FORM_CONTENT_TYPE)) {
    for (const [key, value] of new URLSearchParams(request.rawBody.toString('utf8'))) {
      add(key, value);
    }
  }
  const query = (request.query ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(query)) {
    if (key !== 'm') add(key, Array.isArray(value) ? value[0] : value);
  }
  const m = Array.isArray(query.m) ? (query.m as unknown[])[0] : query.m;
  return { moid: typeof m === 'string' ? m : undefined, fields };
}

/** The first of `names` the callback carries (SmartroPay's 신통보 and 구통보 name fields differently). */
export function field(fields: CallbackFields, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = fields.get(name);
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}
