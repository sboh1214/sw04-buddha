import { MARKET_SLUG_MAX } from '@buddha/shared';

/**
 * Longest path parameter the router accepts, in code units after percent-decoding (Fastify's
 * `maxParamLength`, 100 by default; anything longer is a 404 before any handler or schema
 * runs). The longest parameter this API takes is a market slug, MARKET_SLUG_MAX characters
 * when NFC-normalised — but a decomposed (NFD) spelling of a Korean slug carries up to three
 * code units per syllable, and `GET /markets/:idOrSlug` normalises before matching, so the
 * router must let such a spelling through for the schema to bound it.
 */
export const MAX_PARAM_LENGTH = MARKET_SLUG_MAX * 3;
