import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PHONE_PATTERN } from '@buddha/shared';
import { type Env, phoneHashKey } from '../config/env.js';

/**
 * The identity of a verified mobile number that outlives the number (#70, ADR-0071): the start
 * Coin is given once per number and never again after a withdrawal (ADR-0069 decision 1 #57-1·
 * #57-17·#57-18), and later issues count their limits per number rather than per account, so a
 * new account on the same number does not start them over (decision 7: frequency limits, report
 * dedup, like once, proposal limits). Withdrawal (#140) deletes the number; what stays is this
 * hash, so nothing can turn it back into the number without the key.
 *
 * THE STABLE API, in one place for every issue that keys something by a number: lower-case hex of
 * HMAC-SHA256 with the PHONE_HASH_KEY bytes (UTF-8) as the key and the number's digits as
 * `phoneSchema` yields them (`01012345678`) as the message — nothing else mixed in. A stored hash
 * only matches while all of that stays as it is; changing the key, the message or the encoding is
 * a rotation (ADR-0071): every stored hash stops recognising its number.
 *
 * Why a keyed hash and not a plain one: a mobile number has some 10^8–10^9 values, so SHA-256 of
 * one is reversed by trying them all in minutes. Without the key that search is useless.
 *
 * Not stored beside the number in `phone_verifications`: operators change a member's number in the
 * database by hand (#57-3), and a hash kept there would go stale with no way to recompute it there.
 * Computed from the live number when it is needed, it is always the number's own.
 */
export function phoneHash(key: string, phone: string): string {
  // The digits phoneSchema yields, and nothing else: `010-1234-5678` must not hash to a second
  // identity of the same number.
  if (!PHONE_PATTERN.test(phone)) {
    throw new Error('phoneHash takes the digits of a Korean mobile number (phoneSchema output)');
  }
  return createHmac('sha256', Buffer.from(key, 'utf8')).update(phone, 'utf8').digest('hex');
}

/** `phoneHash` with this deployment's PHONE_HASH_KEY (DEV_PHONE_HASH_KEY outside production). */
@Injectable()
export class PhoneHasher {
  private readonly key: string;

  constructor(config: ConfigService<Env, true>) {
    this.key = phoneHashKey({
      NODE_ENV: config.get('NODE_ENV', { infer: true }),
      PHONE_HASH_KEY: config.get('PHONE_HASH_KEY', { infer: true }),
    });
  }

  /** The keyed hash of a verified number's digits (64 lower-case hex characters). */
  hash(phone: string): string {
    return phoneHash(this.key, phone);
  }
}
