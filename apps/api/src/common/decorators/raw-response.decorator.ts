import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_METADATA = 'buddha:rawResponse';

/**
 * Opts a handler (or a whole controller) out of the PLAN 7 envelope: the returned value
 * and any HttpException body are sent verbatim. Used by /api/health, whose body shape is
 * fixed by ADR-0015 and read by infrastructure, not by the API client.
 */
export const RawResponse = (): MethodDecorator & ClassDecorator =>
  SetMetadata(RAW_RESPONSE_METADATA, true);

/** Request-scoped flag set by ResponseEnvelopeInterceptor so the exception filter agrees. */
export const RAW_RESPONSE_REQUEST_FLAG: unique symbol = Symbol('buddha:rawResponse');

export interface RawFlaggedRequest {
  [RAW_RESPONSE_REQUEST_FLAG]?: true;
}

export function markRawResponse(request: object): void {
  (request as RawFlaggedRequest)[RAW_RESPONSE_REQUEST_FLAG] = true;
}

export function isRawResponse(request: object | undefined): boolean {
  return (
    request !== undefined && (request as RawFlaggedRequest)[RAW_RESPONSE_REQUEST_FLAG] === true
  );
}
