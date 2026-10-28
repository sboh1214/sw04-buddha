import * as z from 'zod';

/**
 * An account's public id (ADR-0069 decision 3 #37-2, decision 5): the short identifier public
 * answers name a person by — a post's author now, the `/u/<publicId>` profile address of #41 — so
 * the account id (better-auth's `user.id`) never leaves the server in a public answer. Random,
 * given once to every account by the database (`gen_public_id()`, migration 0033) and never
 * changed, so a link keeps pointing at the same person when the nickname changes.
 *
 * PUBLIC_ID_LENGTH characters of PUBLIC_ID_ALPHABET: lower-case letters and digits without the
 * look-alikes 0/o and 1/i (32 characters, 32^10 ≈ 10^15 ids), so it reads aloud and survives a
 * case-insensitive hand.
 */
export const PUBLIC_ID_ALPHABET = '23456789abcdefghjklmnpqrstuvwxyz';
export const PUBLIC_ID_LENGTH = 10;
export const PUBLIC_ID_PATTERN = /^[23456789abcdefghjklmnpqrstuvwxyz]{10}$/;

export const publicIdSchema = z
  .string()
  .regex(PUBLIC_ID_PATTERN)
  .describe('An account’s public id: 10 lower-case letters and digits, never the account id');

/**
 * A public id as the profile's address carries it (`GET /profiles/:publicId`, `/u/<publicId>`):
 * any string. Not `publicIdSchema`: a string that cannot be a public id is an unknown profile — a
 * 404, as a withdrawn account's is (#37-16) — not a malformed request, so the web's `/u/<anything>`
 * shows the same page for both. The API matches it in lower case.
 */
export const publicIdParamSchema = z
  .string()
  .describe(
    'A member’s public id (10 lower-case letters and digits, never the account id), matched ignoring case; anything else is NOT_FOUND',
  );
