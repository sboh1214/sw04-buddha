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
  NICKNAME_HOLD_DAYS,
  keptNicknameViolation,
  nicknameKey,
  nicknameRuleViolation,
  type NicknameNotAllowedDetails,
  type OnboardingRequiredDetails,
} from '@buddha/shared';
import { and, eq, gt, gte, isNotNull, isNull, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AppError } from '../common/errors/app-error.js';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/errors/pg-error.js';
import { DB } from '../infra/db/db.provider.js';
import { assertPublicItemEdit } from './public-items.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The unique index drizzle names for nicknames ignoring case (`profiles_nickname_lower_unique`,
 * migration 0032). A violation is a nickname another account took at the same moment.
 */
export const NICKNAME_UNIQUE_INDEX = 'profiles_nickname_lower_unique';

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * The member's own holds of a nickname (`handedBack`): what a take-back of a handed-back nickname
 * leaves once the member gives it up again.
 */
const givenUpAgain = alias(schema.nicknameHolds, 'given_up_again');

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
 *   nickname is taken as it is (#57-6); any other — one typed through MY 설정 before #58, when
 *   only the format held, or an admin's, the seed's 관리자 included (오너 결정 2026-10-19 (2차) 2) —
 *   meets the rules first (`keptNicknameViolation`, ADR-0072 7-25), and one that breaks them is
 *   refused: the member types another. Sending it again after the step, or to MY 설정, changes
 *   nothing.
 * - Any other nickname is one the member chose: never the auto nickname's prefix nor a reserved
 *   word (`nicknameRuleViolation`, the rule the web's forms apply too), never one another account
 *   has, ignoring case (the unique index on lower(nickname)), nor one another account — or a
 *   withdrawn one — gave up less than NICKNAME_HOLD_DAYS ago (`nickname_held()`).
 * - The nickname given up is held from other accounts from then on (`nickname_holds`); a change
 *   of case only gives nothing up, save from a nickname handed back (`replace`).
 * - After the onboarding a change waits NICKNAME_CHANGE_INTERVAL_DAYS after the last change; the
 *   onboarding's choice is not a change, and an operator's reset to an auto nickname clears the
 *   last change (ModerationService, owner decision 2026-10-21, ADR-0081): the member picks a new
 *   one at once, and that pick is the change the next interval counts from. The nickname the reset
 *   took away is held from the member too (a hold naming no account) — until an operator cancels
 *   the reset, which hands that hold to the member (owner decision 2026-10-22): theirs to pick
 *   again, every other account's still held. While that handed-back hold stands the member picks
 *   that nickname — exactly as it was taken away (owner decision 2026-10-22 (3차) 1) — with no
 *   interval, even after changing to another since the reset, once per handed-back hold (owner
 *   decision 2026-10-22 (4차) 1): after taking it back and giving it up again — for another case
 *   of it too — it waits the interval as any; any other nickname keeps the interval (`handedBack`,
 *   owner decision 2026-10-22 (2차) 1, ADR-0081 7-13).
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
   * `PATCH /me`: the change of MY 설정, for an account that has done the onboarding's three steps
   * (ONBOARDING_REQUIRED naming those left otherwise). Before the nickname step the account sets
   * its nickname there, where the choice is not a change; and an account the consent step holds
   * back after a revision that changed members' rights (재동의) changes it once it has agreed again
   * — the server's side of MY 설정 sending the change to the remaining step (owner decision
   * 2026-10-22 answer 1, ADR-0078). `OnboardedGuard` on the route said so before the body was
   * read; this holds it until the write commits (docs/GUARDS.md, step 4). Refused too under a
   * writing or an account restriction (`assertPublicItemEdit`, #41).
   */
  async change(userId: string, nickname: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const profile = await this.lockProfile(tx, userId);
      const steps = await missingOnboardingStepsOf(tx, userId);
      if (steps.length > 0 || profile.nicknameConfirmedAt === null) {
        const details: OnboardingRequiredDetails = {
          steps: steps.length > 0 ? steps : ['nickname'],
        };
        throw new AppError('ONBOARDING_REQUIRED', {
          message: 'The onboarding is not done: the nickname changes once it is',
          details,
        });
      }
      if (nickname === profile.nickname) return;
      // A public item (#37-9): no change of the nickname under a writing or an account restriction.
      await assertPublicItemEdit(tx, userId, 'replace');
      const now = await clockTimestamp(tx);
      if (profile.nicknameChangedAt !== null) {
        const next = new Date(
          profile.nicknameChangedAt.getTime() + NICKNAME_CHANGE_INTERVAL_DAYS * DAY_MS,
        );
        if (next > now && !(await this.handedBack(tx, userId, profile.nickname, nickname, now))) {
          throw refused({ reason: 'change_interval', nextChangeAt: next.toISOString() });
        }
      }
      await this.replace(tx, userId, profile.nickname, nickname, now, { nicknameChangedAt: now });
    });
  }

  /**
   * Whether `next` is the nickname a cancelled operator's reset handed back to the member, its hold
   * still stands at `now` and the member has not used it yet (owner decisions 2026-10-22 (2차) 1:
   * «넘겨받은 보류가 서 있는 동안 그 닉네임만 간격 없이 고른다», and (4차) 1: once per handed-back hold):
   * the hold a reset wrote (`action_id`) naming the member — which only the reset's cancellation
   * makes it (`ModerationService.cancel`; until then it names nobody, and the member's own holds
   * name no action) — released less than NICKNAME_HOLD_DAYS ago, for that nickname exactly, as it
   * was taken away (owner decision 2026-10-22 (3차) 1, ADR-0081 7-13), with no hold of the member's
   * own of that nickname exactly (naming no action) released at or after the cancellation: one is
   * there once the member took it back and gave it up again — for another case of it too
   * (`replace`) — the take-back is used, and from then on that nickname waits the interval as
   * any. (Between the reset and its cancellation the nickname is held from the member, so nothing
   * of theirs gives it up then; one they gave up before the reset is earlier still. At or after,
   * not after: the times are the database clock's milliseconds.) Only the interval is waived: the
   * pick is a change like any other, held to the rules, and the next interval counts from it.
   * Read under the nickname locks the change takes (`lockNicknames`, re-taken by `replace` in the
   * same order), the lock the cancellation hands the hold over under: a pick that comes while a
   * cancellation runs waits for it and reads the hold as handed. The member's own earlier holds
   * were written under their profile's lock, which this change holds.
   */
  private async handedBack(
    tx: Tx,
    userId: string,
    current: string,
    next: string,
    now: Date,
  ): Promise<boolean> {
    const { moderationActions, nicknameHolds } = schema;
    await lockNicknames(tx, [current, next]);
    const [hold] = await tx
      .select({ id: nicknameHolds.id })
      .from(nicknameHolds)
      .innerJoin(moderationActions, eq(moderationActions.id, nicknameHolds.actionId))
      .where(
        and(
          eq(nicknameHolds.userId, userId),
          eq(nicknameHolds.nickname, next),
          gt(nicknameHolds.releasedAt, new Date(now.getTime() - NICKNAME_HOLD_DAYS * DAY_MS)),
          isNotNull(moderationActions.cancelledAt),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(givenUpAgain)
              .where(
                and(
                  eq(givenUpAgain.userId, userId),
                  isNull(givenUpAgain.actionId),
                  eq(givenUpAgain.nickname, next),
                  gte(givenUpAgain.releasedAt, moderationActions.cancelledAt),
                ),
              ),
          ),
        ),
      )
      .limit(1);
    return hold !== undefined;
  }

  /**
   * The onboarding's nickname step, inside the caller's transaction (which grants the start Coin
   * with it, #70): `nickname` unchanged confirms it — the auto nickname as it is, any other once it
   * meets the rules — and another is held to the rules. Once the step is done the
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
      const violation = keptNicknameViolation(nickname);
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
        nicknameConfirmedAt: schema.profiles.nicknameConfirmedAt,
        nicknameChangedAt: schema.profiles.nicknameChangedAt,
      })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId))
      .limit(1)
      .for('update');
    // A closed account (#140) has no nickname — and no session to ask with: no account here.
    if (!profile || profile.nickname === null) {
      throw new AppError('NOT_FOUND', { message: 'Profile not found' });
    }
    return { ...profile, nickname: profile.nickname };
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
    // A change of case only gives nothing up — the nickname is still this account's (ADR-0072
    // decision 4) — save from a nickname a cancelled reset handed back to the member, exactly as
    // it was taken away: giving that up, for another case of it too, uses its take-back
    // (`handedBack`, owner decision 2026-10-22 (4차) 1, ADR-0081 7-13). Without that hold, two
    // cancelled resets of two cases of one nickname would let the member switch between them with
    // no interval while both holds stand. It is the member's own hold, which keeps nothing from
    // other accounts that the unique index on lower(nickname) does not already keep while the
    // account has the nickname — and giving the nickname up later writes a later hold.
    if (
      nicknameKey(current) !== nicknameKey(next) ||
      (await this.isHandedBackNickname(tx, userId, current))
    ) {
      await tx.insert(schema.nicknameHolds).values({ nickname: current, userId, releasedAt: now });
    }
  }

  /**
   * Whether a cancelled operator's reset handed `nickname`, exactly, back to the member: a hold
   * naming a reset (`action_id`) that names the member, which only the reset's cancellation makes
   * it (`handedBack`). Whether that hold still stands does not matter: once it has ended the hold
   * of `nickname` written for it changes nothing — `handedBack` no longer reads that one, and
   * `nickname_held()` never holds the member's own. Read under the nickname's lock (`replace`),
   * the lock the cancellation hands the hold over under.
   */
  private async isHandedBackNickname(tx: Tx, userId: string, nickname: string): Promise<boolean> {
    const { nicknameHolds } = schema;
    const [hold] = await tx
      .select({ id: nicknameHolds.id })
      .from(nicknameHolds)
      .where(
        and(
          eq(nicknameHolds.userId, userId),
          isNotNull(nicknameHolds.actionId),
          eq(nicknameHolds.nickname, nickname),
        ),
      )
      .limit(1);
    return hold !== undefined;
  }
}
