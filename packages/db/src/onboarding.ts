import {
  CONSENT_ITEMS,
  missingConsents,
  missingOnboardingSteps,
  type ConsentItem,
  type ConsentRecord,
  type OnboardingProgress,
  type RequiredOnboardingStep,
} from '@buddha/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { isPhoneVerified } from './phone-verification.js';
import { consentRecords } from './schema/consent-records.js';
import { profiles } from './schema/profiles.js';
import type { StatementExecutor } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** What `readOnboarding` found: the progress and the newest answer to each item. */
export interface OnboardingRead {
  readonly progress: OnboardingProgress;
  /** The newest answer to each item the account answered, in CONSENT_ITEMS order. */
  readonly consents: ConsentRecord[];
}

/**
 * Whether the account's consent step stands: every required item agreed at a version that still
 * holds (`missingConsents`, @buddha/shared). The 본인확인's code request asks it before it takes a
 * number (#58, decision 4 #58: the consent comes first).
 */
export async function hasStandingConsent(executor: Db | Tx, userId: string): Promise<boolean> {
  return missingConsents(await newestConsentRowsOf(executor, userId)).length === 0;
}

/**
 * The onboarding of an account (#58), the one place server code reads it: the consent step from
 * `consent_records` (standing only if no revision since asked again, #57-5), the 본인확인 from
 * `isPhoneVerified` (ADR-0070), the nickname step and the interests step from the profile. Null
 * for an account with no profile (none, or a broken one). `GET /me` shows it, the onboarding's
 * writes check it, and `missingOnboardingStepsOf` is what an action open to onboarded accounts only
 * asks (#57-8).
 *
 * Pass the transaction handle when the answer must hold until a write commits — after the lock that
 * write takes (the consent step reads it under the account's consent lock, so two submissions do
 * not both write the same changed answer).
 */
export async function readOnboarding(
  executor: Db | Tx,
  userId: string,
): Promise<OnboardingRead | null> {
  const [profile] = await executor
    .select({
      nicknameConfirmedAt: profiles.nicknameConfirmedAt,
      interestsAnsweredAt: profiles.interestsAnsweredAt,
    })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  if (!profile) return null;
  const rows = await newestConsentRowsOf(executor, userId);
  const newest = new Map<ConsentItem, ConsentRecord>();
  for (const row of rows) {
    newest.set(row.item, {
      item: row.item,
      version: row.version,
      agreed: row.agreed,
      recordedAt: row.createdAt.toISOString(),
    });
  }
  return {
    progress: {
      consent: missingConsents(rows).length === 0,
      verification: await isPhoneVerified(executor, userId),
      nickname: profile.nicknameConfirmedAt !== null,
      interests: profile.interestsAnsweredAt !== null,
    },
    consents: CONSENT_ITEMS.flatMap((item) => {
      const record = newest.get(item);
      return record === undefined ? [] : [record];
    }),
  };
}

/**
 * The required onboarding steps (consent, 본인확인, nickname) the account has not done, in order;
 * empty once it may do what #57-8 keeps from the rest (writes, likes, reports, proposals, orders).
 * An account with no profile has done none.
 */
export async function missingOnboardingStepsOf(
  executor: Db | Tx,
  userId: string,
): Promise<RequiredOnboardingStep[]> {
  const read = await readOnboarding(executor, userId);
  return missingOnboardingSteps(
    read?.progress ?? { consent: false, verification: false, nickname: false, interests: false },
  );
}

/**
 * An account's newest answer to each item it answered, oldest first: at most one row per item,
 * each found by one lookup on `consent_records_user_id_item_id_idx` from the end of the account's
 * entries — so what every `GET /me`, every onboarding check and the consent write itself read does
 * not grow with the history (an optional answer flipped a thousand times is still one row).
 *
 * The newest row is all `missingConsents` needs: the consent step records only the current version
 * of each item, and versions are only ever appended (CONSENT_DOCUMENTS), so an item's newest
 * agreement is to its latest version the account saw — when that one no longer holds, no earlier
 * one does — and a required item is only ever recorded agreed.
 */
export async function newestConsentRowsOf(executor: Db | Tx, userId: string) {
  const newestIds = CONSENT_ITEMS.map(
    (item) =>
      sql`(${executor
        .select({ id: consentRecords.id })
        .from(consentRecords)
        .where(and(eq(consentRecords.userId, userId), eq(consentRecords.item, item)))
        .orderBy(desc(consentRecords.id))
        .limit(1)})`,
  );
  const rows = await executor
    .select({
      item: consentRecords.item,
      version: consentRecords.version,
      agreed: consentRecords.agreed,
      createdAt: consentRecords.createdAt,
    })
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.userId, userId),
        sql`${consentRecords.id} IN (${sql.join(newestIds, sql`, `)})`,
      ),
    )
    .orderBy(asc(consentRecords.id));
  // The CHECK keeps `item` to CONSENT_ITEMS; a row it let through otherwise would be a bug there.
  return rows.map((row) => ({ ...row, item: row.item as ConsentItem }));
}

/**
 * Takes the lock on a nickname, ignoring case, until the transaction ends (`lock_nickname()`,
 * migration 0032): whoever gives a nickname up and whoever takes one hold it, the auto nickname's
 * generator included, so a nickname is not taken while its hold is being written. A change locks
 * both the nickname it gives up and the one it takes; pass them together, and they are locked in
 * one order whoever asks, so two changes swapping nicknames wait instead of deadlocking.
 */
export async function lockNicknames(
  tx: StatementExecutor,
  nicknames: readonly string[],
): Promise<void> {
  const keys = [...new Set(nicknames.map((nickname) => nickname.toLowerCase()))].sort();
  for (const key of keys) await tx.execute(sql`SELECT lock_nickname(${key})`);
}

/**
 * Whether `nickname` is held from `userId` (`nickname_held()`, migration 0032): another account —
 * or a withdrawn one — gave it up less than NICKNAME_HOLD_DAYS ago, ignoring case (#57-6, #37-16).
 * Read under `lockNicknames` of the same nickname.
 */
export async function isNicknameHeld(
  tx: StatementExecutor,
  nickname: string,
  userId: string,
): Promise<boolean> {
  const result = await tx.execute(sql`SELECT nickname_held(${nickname}, ${userId}) AS held`);
  const rows = (result as { rows?: { held?: unknown }[] }).rows;
  return rows?.[0]?.held === true;
}
