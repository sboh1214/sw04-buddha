import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

type RankedSort = 'recommended' | 'volume';
/** Like comment cursors, but a separate key/domain: internal decision cutoffs never leave in plaintext. */
export function rankingCursorCodec(secret: string) {
  const cipherKey = createHmac('sha256', secret)
    .update('buddha:market-ranking:aes-256-gcm:v1')
    .digest();
  const nonceKey = createHmac('sha256', secret).update('buddha:market-ranking:nonce:v1').digest();
  const aad = (sort: RankedSort) => Buffer.from(`buddha:market-ranking:v1:${sort}`);
  return {
    seal(sort: RankedSort, raw: string): string {
      const plain = Buffer.from(raw);
      if (plain.length > 120)
        throw new Error('Market ranking cursor exceeds its fixed keyset bounds');
      const associated = aad(sort);
      const nonce = createHmac('sha256', nonceKey)
        .update(associated)
        .update(plain)
        .digest()
        .subarray(0, 12);
      const cipher = createCipheriv('aes-256-gcm', cipherKey, nonce);
      cipher.setAAD(associated);
      return Buffer.concat([
        Buffer.of(1),
        nonce,
        cipher.update(plain),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString('base64url');
    },
    open(sort: RankedSort, encoded: string | undefined): string | undefined {
      if (!encoded || encoded.length > 200 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
      const bytes = Buffer.from(encoded, 'base64url');
      if (
        bytes.length < 30 ||
        bytes.length > 149 ||
        bytes[0] !== 1 ||
        bytes.toString('base64url') !== encoded
      )
        return undefined;
      try {
        const decipher = createDecipheriv('aes-256-gcm', cipherKey, bytes.subarray(1, 13));
        decipher.setAAD(aad(sort));
        decipher.setAuthTag(bytes.subarray(-16));
        return Buffer.concat([decipher.update(bytes.subarray(13, -16)), decipher.final()]).toString(
          'utf8',
        );
      } catch {
        return undefined;
      }
    },
  };
}
export type RankingCursorCodec = ReturnType<typeof rankingCursorCodec>;
@Injectable()
export class MarketRankingCursors {
  readonly codec: RankingCursorCodec;
  constructor(config: ConfigService<Env, true>) {
    const secret = config.get('BETTER_AUTH_SECRET', { infer: true });
    if (!secret) throw new Error('BETTER_AUTH_SECRET is required to seal market ranking cursors');
    this.codec = rankingCursorCodec(secret);
  }
}
