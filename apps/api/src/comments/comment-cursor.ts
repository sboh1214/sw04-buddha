import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Keyset } from '@buddha/shared';
import { AppError } from '../common/errors/app-error.js';
import { type Env } from '../config/env.js';

/**
 * The page cursors of the comment lists (#48, ADR-0074, 오너 결정 2026-10-21 (2차) 답 3): opaque — the
 * keyset `(created_at, id)` of a page's last row sealed with AES-256-GCM — so no comment's time of
 * writing can be read from one. A page can end on a placeholder (a deleted 댓글 that 대댓글 hang
 * under, a hidden 대댓글 once #50 hides them), whose answer carries its id alone (#45-5); before
 * this, the plain cursor (`encodeKeyset`, `<epochMillis>_<id>`) gave its time to the millisecond.
 * Only these two lists — the post's 댓글 (`GET /posts/:postId/comments`) and a 댓글's 대댓글
 * (`GET /comments/:commentId/replies`), where placeholders appear; every other list keeps the plain
 * cursor.
 *
 * - The key is derived from BETTER_AUTH_SECRET (HMAC-SHA256 of a fixed label, as the verification
 *   codes' `deriveCodeKey`), not a new secret: a cursor lives as long as a screen holds it, so
 *   rotating the session secret — which signs everyone in again anyway — costs a held cursor one
 *   refusal (the screen, refused, reads its pages again from the first with fresh cursors and asks
 *   again: apps/web/src/hooks/use-comments.ts), and a deployment gains no secret to provision.
 *   Every API instance has the same secret, so any one opens what another sealed.
 * - Sealed for one list (the additional data names the list and its post or 댓글): a cursor carried
 *   to another thread or the other list does not open. Unbound, one placeholder's cursor sent to a
 *   thread whose 대댓글 show their times would tell its time by which of them come after it.
 * - Deterministic: the nonce is an HMAC of the list and the keyset under a second derived key (a
 *   synthetic IV), so one position of one list always has one cursor. The web compares cursors to
 *   tell whether a thread is still where a page was read from (`withMoreReplies`, the draft's read
 *   on), and a random nonce would make every read look like a move. Equal cursors say only that two
 *   reads ended at the same row, which the ids on the page say already; a nonce repeats only for the
 *   same plaintext, so GCM's one rule — never a nonce twice with two messages — holds.
 * - A cursor that does not open — tampered with, of another list, sealed under another secret, of
 *   another version, or no cursor at all — is a VALIDATION_ERROR naming `cursor` (400). The plain
 *   lists serve their first page instead (`decodeKeyset`); here the web would take that first page
 *   for the next one and draw its comments twice.
 */

/** Which list a cursor pages, and the post or the 댓글 whose list it is. */
export type CommentCursorScope =
  { list: 'comments'; postId: string } | { list: 'replies'; commentId: string };

/** The two keys derived from the secret: the cipher's and the synthetic nonce's. */
export interface CommentCursorKeys {
  cipher: Buffer;
  nonce: Buffer;
}

/** The format's version, the first byte of every cursor (and part of what it is sealed with). */
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** The keyset sealed: epoch milliseconds (8 bytes, big-endian) and the uuid's 16 bytes. */
const PLAIN_BYTES = 8 + 16;
const CURSOR_BYTES = 1 + NONCE_BYTES + PLAIN_BYTES + TAG_BYTES;
/** 9999-12-31T23:59:59.999Z, the last instant `decodeKeyset` takes, for the same reason. */
const CURSOR_MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function deriveCommentCursorKeys(secret: string): CommentCursorKeys {
  return {
    cipher: createHmac('sha256', secret).update('buddha:comment-cursor:aes-256-gcm').digest(),
    nonce: createHmac('sha256', secret).update('buddha:comment-cursor:nonce').digest(),
  };
}

/** What a cursor is sealed with besides its key: the format's version, the list and its owner. */
function associatedData(scope: CommentCursorScope): Buffer {
  const id = scope.list === 'comments' ? scope.postId : scope.commentId;
  return Buffer.from(`buddha:comment-cursor:v${String(VERSION)}:${scope.list}:${id.toLowerCase()}`);
}

/** The keyset as the bytes sealed; undefined for one no comment row has (never one this API read). */
function plainOf({ createdAt, id }: Keyset): Buffer | undefined {
  const millis = createdAt.getTime();
  const uuid = id.toLowerCase();
  if (!Number.isSafeInteger(millis) || millis < 0 || millis > CURSOR_MAX_MS) return undefined;
  if (!UUID.test(uuid)) return undefined;
  const plain = Buffer.alloc(PLAIN_BYTES);
  plain.writeBigUInt64BE(BigInt(millis), 0);
  Buffer.from(uuid.replaceAll('-', ''), 'hex').copy(plain, 8);
  return plain;
}

function keysetOf(plain: Buffer): Keyset | undefined {
  const millis = Number(plain.readBigUInt64BE(0));
  if (!Number.isSafeInteger(millis) || millis > CURSOR_MAX_MS) return undefined;
  const hex = plain.subarray(8).toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { createdAt: new Date(millis), id };
}

/** The cursor of the page after `keyset` in the list `scope`: base64url, 71 characters. */
export function sealCommentCursor(
  keys: CommentCursorKeys,
  scope: CommentCursorScope,
  keyset: Keyset,
): string {
  const plain = plainOf(keyset);
  if (plain === undefined)
    throw new Error('A comment cursor names a stored row: a time and a uuid');
  const aad = associatedData(scope);
  const nonce = createHmac('sha256', keys.nonce)
    .update(aad)
    .update(plain)
    .digest()
    .subarray(0, NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keys.cipher, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.of(VERSION), nonce, sealed, cipher.getAuthTag()]).toString(
    'base64url',
  );
}

/**
 * The keyset `cursor` was sealed with for the list `scope`, or undefined when it does not open:
 * not base64url of the right length (in its one spelling), another version, tampered with, sealed
 * for another list or under another secret.
 */
export function openCommentCursor(
  keys: CommentCursorKeys,
  scope: CommentCursorScope,
  cursor: string,
): Keyset | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  const bytes = Buffer.from(cursor, 'base64url');
  // One spelling per cursor: base64url's unused low bits of the last character are not a second.
  if (bytes.length !== CURSOR_BYTES || bytes.toString('base64url') !== cursor) return undefined;
  if (bytes[0] !== VERSION) return undefined;
  const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
  const sealed = bytes.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + PLAIN_BYTES);
  const tag = bytes.subarray(1 + NONCE_BYTES + PLAIN_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', keys.cipher, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(associatedData(scope));
    decipher.setAuthTag(tag);
    return keysetOf(Buffer.concat([decipher.update(sealed), decipher.final()]));
  } catch {
    // The tag does not match: not a cursor this server sealed for this list.
    return undefined;
  }
}

/**
 * The comment lists' cursors with this deployment's keys (above): `seal` the page's last row,
 * `open` a request's cursor — nothing for no cursor (the first page), VALIDATION_ERROR naming
 * `cursor` for one that does not open.
 */
@Injectable()
export class CommentCursors {
  private readonly keys: CommentCursorKeys;

  constructor(config: ConfigService<Env, true>) {
    const secret = config.get('BETTER_AUTH_SECRET', { infer: true });
    // The env schema requires it outside NODE_ENV=test and createAuth refuses to start without it.
    if (!secret) throw new Error('BETTER_AUTH_SECRET is required to seal comment cursors');
    this.keys = deriveCommentCursorKeys(secret);
  }

  seal(scope: CommentCursorScope, keyset: Keyset): string {
    return sealCommentCursor(this.keys, scope, keyset);
  }

  open(scope: CommentCursorScope, cursor: string | undefined): Keyset | undefined {
    if (cursor === undefined) return undefined;
    const keyset = openCommentCursor(this.keys, scope, cursor);
    if (keyset === undefined) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Not a cursor of this list',
        details: [{ path: ['cursor'], message: 'Not a cursor of this list' }],
      });
    }
    return keyset;
  }
}
