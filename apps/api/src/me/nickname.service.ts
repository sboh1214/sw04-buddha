import { Inject, Injectable } from '@nestjs/common';
import {
  clockTimestamp,
  isNicknameHeld,
  lockNicknames,
  missingOnboardingStepsOf,
  schema,
  type Db,
} from '@buddha/db';
import {
  NICKNAME_CHANGE_INTERVAL_DAYS,
  keptNicknameViolation,
  nicknameKey,
  nicknameRuleViolation,
  type NicknameNotAllowedDetails,
  type OnboardingRequiredDetails,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/errors/pg-error.js';
import { DB } from '../infra/db/db.provider.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The unique index drizzle names for nicknames ignoring case (`profiles_nickname_lower_unique`,
 * migration 0032). A violation is a nickname another account took at the same moment.
 */
export const NICKNAME_UNIQUE_INDEX = 'profiles_nickname_lower_unique';

const DAY_MS = 24 * 60 * 60 * 1_000;

function refused(details: NicknameNotAllowedDetails): AppError {
  return new AppError('NICKNAME_NOT_ALLOWED', {
    message: `Nickname not allowed: ${details.reason}`,
    details,
  });
}

/**
 * The nickname of an account (#58, ADR-0069 decision 1 #57-6 and #37-16): the onboarding's
 * nickname step and the change of MY 설정 (`PATCH /me`), under one set of rules.
 *
 * - The nickname the account has, confirmed in the onboarding's nickname step: the offered auto
 *   nickname is taken as it is (#57-6), and so is an admin's (the seed's 관리자, pending the
 *   owner); any other — one typed through MY 설정 before #58, when only the format held — meets
 *   the rules first (`keptNicknameViolation`, ADR-0072 7-25). Sending it again after the step, or
 *   to MY 설정, changes nothing.
 * - Any other nickname is one the member chose: never the auto nickname's prefix nor a reserved
 *   word (`nicknameRuleViolation`, the rule the web's forms apply too), never one another account
 *   has, ignoring case (the unique index on lower(nickname)), nor one another account — or a
 *   withdrawn one — gave up less than NICKNAME_HOLD_DAYS ago (`nickname_held()`).
 * - The nickname given up is held from other accounts from then on (`nickname_holds`).
 * - After the onboarding a change waits NICKNAME_CHANGE_INTERVAL_DAYS after the last change; the
 *   onboarding's choice is not a change.
 *
 * Every write takes the account's profile row FOR UPDATE first (one nickname write of an account at
 * a time), then the nickname locks (`lockNicknames`: the nickname given up and the one taken, in
 * one order), so the hold a change writes and the take another account makes cannot pass each
 * other. Times are the database clock.
 */
@Injectable()
export class NicknameService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * `PATCH /me`: the change of MY 설정. Refused (ONBOARDING_REQUIRED) before the onboarding's
   * nickname step: until then the account sets its nickname there, where the choice is not a
   * change.
   */
  async change(userId: string, nickname: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const profile = await this.lockProfile(tx, userId);
      if (profile.nicknameConfirmedAt === null) {
        const steps = await missingOnboardingStepsOf(tx, userId);
        const details: OnboardingRequiredDetails = {
          steps: steps.length > 0 ? steps : ['nickname'],
        };
        throw new AppError('ONBOARDING_REQUIRED', {
          message: 'The nickname is set in the onboarding first',
          details,
        });
      }
      if (nickname === profile.nickname) return;
      const now = await clockTimestamp(tx);
      if (profile.nicknameChangedAt !== null) {
        const next = new Date(
          profile.nicknameChangedAt.getTime() + NICKNAME_CHANGE_INTERVAL_DAYS * DAY_MS,
        );
        if (next > now) {
          throw refused({ reason: 'change_interval', nextChangeAt: next.toISOString() });
        }
      }
      await this.replace(tx, userId, profile.nickname, nickname, now, { nicknameChangedAt: now });
    });
  }

  /**
   * The onboarding's nickname step, inside the caller's transaction (which grants the start Coin
   * with it, #70): `nickname` unchanged confirms it — the auto nickname or an admin's as it is, any
   * other once it meets the rules — and another is held to the rules. Once the step is done the
   * same nickname is a no-op — a repeated or concurrent step — and another one is `already_set`: a
   * change is `PATCH /me`, under the interval.
   */
  async confirmInOnboarding(tx: Tx, userId: string, nickname: string): Promise<void> {
    const profile = await this.lockProfile(tx, userId);
    if (profile.nicknameConfirmedAt !== null) {
      if (nickname === profile.nickname) return;
      throw refused({ reason: 'already_set' });
    }
    const now = await clockTimestamp(tx);
    if (nickname === profile.nickname) {
      const violation = keptNicknameViolation(nickname, profile.role);
      if (violation !== null) throw refused({ reason: violation });
      await tx
        .update(schema.profiles)
        .set({ nicknameConfirmedAt: now })
        .where(eq(schema.profiles.userId, userId));
      return;
    }
    await this.replace(tx, userId, profile.nickname, nickname, now, { nicknameConfirmedAt: now });
  }

  /** The account's profile row, FOR UPDATE. NOT_FOUND for an account with none (broken). */
  private async lockProfile(tx: Tx, userId: string) {
    const [profile] = await tx
      .select({
        nickname: schema.profiles.nickname,
        role: schema.profiles.role,
        nicknameConfirmedAt: schema.profiles.nicknameConfirmedAt,
        nicknameChangedAt: schema.profiles.nicknameChangedAt,
      })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId))
      .limit(1)
      .for('update');
    if (!profile) throw new AppError('NOT_FOUND', { message: 'Profile not found' });
    return profile;
  }

  /**
   * `current` → `next`, a nickname the member chose: the rules, the locks, the hold, the write
   * (with `stamp`, the step's or the change's time) and the hold of the nickname given up.
   */
  private async replace(
    tx: Tx,
    userId: string,
    current: string,
    next: string,
    now: Date,
    stamp: { nicknameConfirmedAt: Date } | { nicknameChangedAt: Date },
  ): Promise<void> {
    const violation = nicknameRuleViolation(next);
    if (violation !== null) throw refused({ reason: violation });
    await lockNicknames(tx, [current, next]);
    if (await isNicknameHeld(tx, next, userId)) throw refused({ reason: 'taken' });
    try {
      await tx
        .update(schema.profiles)
        .set({ nickname: next, ...stamp })
        .where(eq(schema.profiles.userId, userId));
    } catch (error) {
      // Another account has it in some case: under the nickname lock this is one that took it
      // before, the check above having only looked at the holds.
      if (isPgError(error, PG_UNIQUE_VIOLATION, NICKNAME_UNIQUE_INDEX)) {
        throw new AppError('NICKNAME_NOT_ALLOWED', {
          message: 'Nickname not allowed: taken',
          details: { reason: 'taken' } satisfies NicknameNotAllowedDetails,
          cause: error,
        });
      }
      throw error;
    }
    // A change of case only gives nothing up: the nickname is still this account's.
    if (nicknameKey(current) !== nicknameKey(next)) {
      await tx.insert(schema.nicknameHolds).values({ nickname: current, userId, releasedAt: now });
    }
  }
}
