import { Module } from '@nestjs/common';
import { PhoneHasher } from './phone-hash.js';

/**
 * The keyed hash of a verified mobile number (phone-hash.ts, ADR-0071): the start grant (#70) and
 * every later issue that counts per number import this module rather than hashing on their own.
 * ConfigModule is global (AppModule).
 */
@Module({
  providers: [PhoneHasher],
  exports: [PhoneHasher],
})
export class IdentityModule {}
