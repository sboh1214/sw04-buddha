import { Inject, Injectable } from '@nestjs/common';
import { readOnboarding, schema, startGrantHoldsNumber, type Db } from '@buddha/db';
import {
  NICKNAME_CHANGE_INTERVAL_DAYS,
  onboardingState,
  serializeCoinAmount,
  type Me,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { PhoneHasher } from '../identity/phone-hash.js';
import { DB } from '../infra/db/db.provider.js';
import { NUMBER_USED_START_GRANT, toStartGrant } from '../start-grant/start-grant.service.js';
import { NicknameService } from './nickname.service.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

@Injectable()
export class MeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly nicknames: NicknameService,
    private readonly hasher: PhoneHasher,
  ) {}

  async getMe(userId: string): Promise<Me> {
    const [[row], accounts, onboarding, interests] = await Promise.all([
      this.db
        .select({
          id: schema.user.id,
          email: schema.user.email,
          emailVerified: schema.user.emailVerified,
          nickname: schema.profiles.nickname,
          role: schema.profiles.role,
          createdAt: schema.profiles.createdAt,
          timeZone: schema.profiles.timeZone,
          nicknameChangedAt: schema.profiles.nicknameChangedAt,
          availableCoin: schema.balances.availableCoin,
          lockedCoin: schema.balances.lockedCoin,
          realName: schema.phoneVerifications.realName,
          phone: schema.phoneVerifications.phone,
          verifiedAt: schema.phoneVerifications.verifiedAt,
          startGrantId: schema.startGrants.id,
          startGrantAmountCoin: schema.startGrants.amountCoin,
          startGrantedAt: schema.startGrants.grantedAt,
          startGrantCancelledAt: schema.startGrants.cancelledAt,
        })
        .from(schema.user)
        .innerJoin(schema.profiles, eq(schema.profiles.userId, schema.user.id))
        .innerJoin(schema.balances, eq(schema.balances.userId, schema.user.id))
        // At most one row per account (user_id is its primary key); none until the account
        // confirms an SMS code (ADR-0070).
        .leftJoin(schema.phoneVerifications, eq(schema.phoneVerifications.userId, schema.user.id))
        // At most one row per account (user_id is UNIQUE); none until the account is granted or
        // waits for its start Coin (#70, ADR-0071). A cancelled one reads as none (toStartGrant).
        .leftJoin(schema.startGrants, eq(schema.startGrants.userId, schema.user.id))
        .where(eq(schema.user.id, userId))
        .limit(1),
      // Read-only view of better-auth's account table (PLAN 6.1: never written by us).
      // `id` is what authClient.unlinkAccount({ accountId }) expects.
      this.db
        .select({
          id: schema.account.id,
          providerId: schema.account.providerId,
          accountId: schema.account.accountId,
          createdAt: schema.account.createdAt,
        })
        .from(schema.account)
        .where(eq(schema.account.userId, userId))
        .orderBy(asc(schema.account.createdAt), asc(schema.account.id)),
      // The onboarding (#58): its steps and the newest consent answers, read where every check of
      // it reads them (@buddha/db).
      readOnboarding(this.db, userId),
      this.db
        .select({ categoryId: schema.profileInterestCategories.categoryId })
        .from(schema.profileInterestCategories)
        .where(eq(schema.profileInterestCategories.userId, userId))
        .orderBy(asc(schema.profileInterestCategories.categoryId)),
    ]);
    // The "user" trigger (PLAN 10.4) guarantees both rows; missing means a broken account.
    if (!row || !onboarding) throw new AppError('NOT_FOUND', { message: 'Profile not found' });

    // The account's own grant, waiting or paid; a cancelled one (its account withdrew while it
    // waited) reads as none. No grant of its own although the nickname step asked for one: when
    // another account's grant holds the number (a live row of start_grant_numbers), the number's
    // start Coin is that grant's (#57-1), which the notice screen says (오너 결정 2026-10-19,
    // ADR-0072). Only the account's own `GET /me` asks, of its own number; asked only in that case,
    // so the usual `GET /me` hashes nothing. The reads above are separate statements, so this one
    // can land after a nickname step that committed between them (the row without the new grant,
    // the onboarding with the nickname done): `startGrantHoldsNumber` leaves the account's own
    // grant out, and such a read says `null`, never `number_used`.
    let startGrant: Me['startGrant'] = null;
    if (row.startGrantId !== null) {
      startGrant = toStartGrant({
        amountCoin: row.startGrantAmountCoin,
        grantedAt: row.startGrantedAt,
        cancelledAt: row.startGrantCancelledAt,
      });
    } else if (
      onboarding.progress.nickname &&
      row.phone !== null &&
      (await startGrantHoldsNumber(this.db, this.hasher.hash(row.phone), userId))
    ) {
      startGrant = NUMBER_USED_START_GRANT;
    }

    return {
      id: row.id,
      email: row.email,
      emailVerified: row.emailVerified,
      profile: {
        nickname: row.nickname,
        role: row.role,
        createdAt: row.createdAt.toISOString(),
        timeZone: row.timeZone,
        nicknameChangeAvailableAt:
          row.nicknameChangedAt === null
            ? null
            : new Date(
                row.nicknameChangedAt.getTime() + NICKNAME_CHANGE_INTERVAL_DAYS * DAY_MS,
              ).toISOString(),
        interestCategoryIds: interests.map((pick) => pick.categoryId),
      },
      balance: {
        availableCoin: serializeCoinAmount(row.availableCoin),
        lockedCoin: serializeCoinAmount(row.lockedCoin),
      },
      linkedAccounts: accounts.map((a) => ({
        id: a.id,
        providerId: a.providerId,
        accountId: a.accountId,
        createdAt: a.createdAt.toISOString(),
      })),
      verification:
        row.realName !== null && row.phone !== null && row.verifiedAt !== null
          ? { realName: row.realName, phone: row.phone, verifiedAt: row.verifiedAt.toISOString() }
          : null,
      startGrant,
      onboarding: onboardingState(onboarding.progress, onboarding.consents),
    };
  }

  /**
   * `PATCH /me`: the nickname change of MY 설정, under the rules and the interval of #57-6
   * (NicknameService) — no longer PLAN 17 Q4's unlimited changes.
   */
  async updateNickname(userId: string, nickname: string): Promise<Me> {
    await this.nicknames.change(userId, nickname);
    return this.getMe(userId);
  }

  /**
   * ADR-0063: the zone the member reads times in, or null to follow the browser again. The name
   * was checked by `timeZoneSchema` (Node's Intl) and is stored as given; `updated_at` follows
   * through drizzle's `$onUpdate`, as for the nickname.
   */
  async updateTimeZone(userId: string, timeZone: string | null): Promise<Me> {
    const updated = await this.db
      .update(schema.profiles)
      .set({ timeZone })
      .where(eq(schema.profiles.userId, userId))
      .returning({ userId: schema.profiles.userId });
    if (updated.length === 0) throw new AppError('NOT_FOUND', { message: 'Profile not found' });
    return this.getMe(userId);
  }
}
