import { Inject, Injectable } from '@nestjs/common';
import { readOnboarding, schema, type Db } from '@buddha/db';
import {
  CONSENT_ITEMS,
  CONSENT_USER_AGENT_MAX_LENGTH,
  consentItemsToAsk,
  missingOnboardingSteps,
  type Me,
  type OnboardingRequiredDetails,
  type RecordConsentsBody,
  type ValidationIssue,
} from '@buddha/shared';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { MeService } from '../me/me.service.js';
import { NicknameService } from '../me/nickname.service.js';
import {
  assertPublicItemEdit,
  assertPublicItemOnboarding,
  type PublicItemEdit,
} from '../me/public-items.js';
import { StartGrantService } from '../start-grant/start-grant.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Where a consent came from: what the record keeps beside the answers (#57-5). */
export interface ConsentClient {
  /** `clientAddress` (rate-limit.tracker.ts), or null when the request names no client. */
  ip: string | null;
  /** The request's `User-Agent`, as sent; cut to CONSENT_USER_AGENT_MAX_LENGTH here. */
  userAgent: string | null;
}

/**
 * The onboarding's writes (#58, ADR-0069 decision 1 #57-4~#57-10 and decision 4 #58), in the
 * order the owner set: 약관 동의 → 본인확인 (#183's own routes, which ask for the consent first) →
 * 닉네임 설정, then the start Coin, then the interest categories. Each step refuses an account that
 * has not done the ones before it (ONBOARDING_REQUIRED), whatever screen sent it.
 *
 * The start Coin is granted in ONE place (#58's acceptance: '온보딩 안에서 #70의 지급 기능을
 * 부르는 곳은 이 세 단계 완료 확인 처리뿐이다'): the nickname step, the last of the three, in the
 * transaction that confirms the nickname, after it has read the consent and the 본인확인 (then it
 * takes the profile's row lock, and the grant holds the 본인확인 record FOR SHARE until it commits —
 * a record gone in between is VERIFICATION_REQUIRED). So an account whose onboarding is done always
 * had its grant asked for, a step repeated or sent twice at once grants once (#70's guarantee and
 * the row lock), and an account missing a step gets nothing however the request is made.
 */
@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly me: MeService,
    private readonly nicknames: NicknameService,
    private readonly startGrant: StartGrantService,
  ) {}

  /**
   * `POST /me/consents`: answers to the consent items (the body has named at least one, each at its
   * current version, the required ones agreed), recorded with the time, the client address and the
   * browser (#57-5).
   *
   * The submission must answer every item the account's consent step asks now
   * (`consentItemsToAsk` on its newest answers, read under the lock): every item the first time,
   * after a revision that changed members' rights only the ones it left behind — so the marketing
   * answer is not asked again and stays as it was (오너 결정 2026-10-19 (2차) 1). One that leaves any
   * of them out is VALIDATION_ERROR naming each, and nothing is written: the required items cannot
   * be skipped, and the step leaves no item unanswered. Any other item named is recorded as well —
   * MY 설정's marketing switch sends that answer alone, at any time (2차 4).
   *
   * An item whose newest answer is the same — same version, same choice — is not written again, so
   * a repeated submission adds nothing; a changed one is a new row, the old one kept.
   */
  async recordConsents(
    userId: string,
    consents: RecordConsentsBody['consents'],
    client: ConsentClient,
  ): Promise<Me> {
    await this.db.transaction(async (tx) => {
      // One submission of an account at a time, so two at once do not both find the newest answer
      // different and write it twice. The two-key form, as the 본인확인's account lock.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('buddha:consent'), hashtext(${userId}))`,
      );
      const read = await readOnboarding(tx, userId);
      if (!read) throw new AppError('NOT_FOUND', { message: 'Profile not found' });
      const unanswered: ValidationIssue[] = consentItemsToAsk(read.consents)
        .filter((item) => consents[item] === undefined)
        .map((item) => ({ path: ['consents', item], message: 'this item is asked: answer it' }));
      if (unanswered.length > 0) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'The consent step asks these items',
          details: unanswered,
        });
      }
      const newest = new Map(read.consents.map((record) => [record.item, record]));
      const rows = CONSENT_ITEMS.flatMap((item) => {
        const answer = consents[item];
        if (answer === undefined) return [];
        const before = newest.get(item);
        if (before?.version === answer.version && before.agreed === answer.agreed) return [];
        return [
          {
            userId,
            item,
            version: answer.version,
            agreed: answer.agreed,
            clientIp: client.ip,
            userAgent: client.userAgent?.slice(0, CONSENT_USER_AGENT_MAX_LENGTH) ?? null,
          },
        ];
      });
      if (rows.length > 0) await tx.insert(schema.consentRecords).values(rows);
    });
    return this.me.getMe(userId);
  }

  /**
   * `POST /me/onboarding/nickname`: the nickname step and, with it, the start Coin (#70) — the one
   * place the onboarding grants it. Refused while the consent or the 본인확인 is not done. The
   * nickname is confirmed or chosen under the rules (NicknameService.confirmInOnboarding), then
   * `StartGrantService.grantIn` records and pays the grant in the same transaction — or leaves it
   * waiting while the amount is undecided (decision 4 #70), or records nothing when the verified
   * number's start Coin went to another account (#57-1). Its balance event goes out after the
   * commit. The answer is the whole `Me`: `startGrant` is what the notice screen shows (#57-10).
   *
   * The nickname is a public profile item, and this is the account's first choice of it, not a
   * change (#57-6): a writing or an account restriction lets it through (owner decision 2026-10-21
   * answer 4, `assertPublicItemEdit`'s `first`) — only MY 설정's change is kept back.
   */
  async setNickname(userId: string, nickname: string): Promise<Me> {
    const granted = await this.db.transaction(async (tx) => {
      await this.assertStepsBeforeNickname(tx, userId);
      await assertPublicItemEdit(tx, userId, 'first');
      await this.nicknames.confirmInOnboarding(tx, userId, nickname);
      return this.startGrant.grantIn(tx, userId);
    });
    await this.startGrant.announce(userId, granted);
    return this.me.getMe(userId);
  }

  /**
   * `POST /me/onboarding/interests`: the interests step's answer from its screen (#57-7) — some
   * categories, or none: the skip, which the screen also sends when the account leaves it, or the
   * start-Coin notice before it, without an answer (owner decision 2026-10-21 (2nd) answer 2,
   * ADR-0078). While the step is unanswered (`interests_answered_at` null) this is its first answer
   * (`first`): the onboarding's step after the start Coin, so for onboarded accounts only, and a
   * first choice, so a writing or an account restriction lets it through (owner decision 2026-10-21
   * answer 4) — picks and the skip alike. Either way the step is answered and never asked again.
   * Once it is answered — another tab answered it, or the account left and the screen came back
   * (the browser's back-forward cache) — a skip changes nothing, and picks are a change as MY 설정's
   * (`setInterests`): never a way back to the first answer.
   */
  answerInterestsStep(userId: string, categoryIds: readonly number[]): Promise<Me> {
    return this.writeInterests(userId, categoryIds, 'step');
  }

  /**
   * `PUT /me/interest-categories`: MY 설정's interest categories (#41), replacing what the account
   * had. Never the interests step's first answer, whether or not the step was answered (owner
   * decision 2026-10-21 (2nd) answer 2: an account that left the onboarding's screens skipped the
   * step, so its first pick here is a change like any later one). What it is, read under the
   * profile's lock:
   * - `replace` when it adds a category the account does not have: onboarded accounts only, and
   *   refused under a restriction (#37-9) — and, the step unanswered, it answers it (the account
   *   left the step to be here: the skip that the screen did not get to send);
   * - `clear` when it adds none and drops some or all: sign-in only, an account held back by a
   *   re-consent included (owner decision 2026-10-21 answer 2), and whatever the sanction
   *   (decision 7);
   * - nothing when it changes nothing — the same picks, or none for an account with none, which
   *   records nothing either: it may not have reached the step (a new account).
   */
  setInterests(userId: string, categoryIds: readonly number[]): Promise<Me> {
    return this.writeInterests(userId, categoryIds, 'settings');
  }

  /**
   * The interest categories (#57-7), replacing what the account had, from the active categories
   * only (top-level and sub-categories, D10: operators keep the list; the seeded one until #17), as
   * many as it likes, and the step answered (`interests_answered_at`, kept from its first answer).
   * They are a public profile item (#37-5), so a write is a `PublicItemEdit` asked of the onboarding
   * (`assertPublicItemOnboarding`, rather than OnboardedGuard: a dropping needs sign-in only) and
   * of the restriction (`assertPublicItemEdit`), in that order, under the profile's lock — and only
   * the onboarding screen's write while the step is unanswered is `first` (`from: 'step'`).
   */
  private async writeInterests(
    userId: string,
    categoryIds: readonly number[],
    from: 'step' | 'settings',
  ): Promise<Me> {
    const wanted = [...new Set(categoryIds)];
    await this.db.transaction(async (tx) => {
      const [profile] = await tx
        .select({ answeredAt: schema.profiles.interestsAnsweredAt })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, userId))
        .limit(1)
        .for('update');
      if (!profile) throw new AppError('NOT_FOUND', { message: 'Profile not found' });
      // The picks are read under the profile's lock, which every write of them takes.
      const current = await tx
        .select({ categoryId: schema.profileInterestCategories.categoryId })
        .from(schema.profileInterestCategories)
        .where(eq(schema.profileInterestCategories.userId, userId));
      const had = new Set(current.map((pick) => pick.categoryId));
      const adds = wanted.some((id) => !had.has(id));
      const first = from === 'step' && profile.answeredAt === null;
      // What changes nothing asks and writes nothing: the same picks, or the skip of a step already
      // answered — a skip never takes picks away.
      const skipsAgain = from === 'step' && wanted.length === 0;
      if (!first && (skipsAgain || (!adds && wanted.length === had.size))) return;
      let edit: PublicItemEdit = 'clear';
      if (first) edit = 'first';
      else if (adds) edit = 'replace';
      await assertPublicItemOnboarding(tx, userId, edit);
      await assertPublicItemEdit(tx, userId, edit);
      if (wanted.length > 0) {
        const active = await tx
          .select({ id: schema.categories.id })
          .from(schema.categories)
          .where(and(inArray(schema.categories.id, wanted), eq(schema.categories.isActive, true)));
        const known = new Set(active.map((row) => row.id));
        const unknown: ValidationIssue[] = categoryIds.flatMap((id, index) =>
          known.has(id)
            ? []
            : [{ path: ['categoryIds', index], message: 'not an active category' }],
        );
        if (unknown.length > 0) {
          throw new AppError('VALIDATION_ERROR', {
            message: 'Unknown or inactive category',
            details: unknown,
          });
        }
      }
      // What it keeps keeps its row (and when it was picked); what it dropped goes.
      await tx
        .delete(schema.profileInterestCategories)
        .where(
          wanted.length === 0
            ? eq(schema.profileInterestCategories.userId, userId)
            : and(
                eq(schema.profileInterestCategories.userId, userId),
                notInArray(schema.profileInterestCategories.categoryId, wanted),
              ),
        );
      if (wanted.length > 0) {
        await tx
          .insert(schema.profileInterestCategories)
          .values(wanted.map((categoryId) => ({ userId, categoryId })))
          .onConflictDoNothing();
      }
      await tx
        .update(schema.profiles)
        .set({ interestsAnsweredAt: sql`coalesce(${schema.profiles.interestsAnsweredAt}, now())` })
        .where(eq(schema.profiles.userId, userId));
    });
    return this.me.getMe(userId);
  }

  /** The nickname step's order (decision 4 #58): the consent and the 본인확인 come first. */
  private async assertStepsBeforeNickname(tx: Tx, userId: string): Promise<void> {
    const read = await readOnboarding(tx, userId);
    if (!read) throw new AppError('NOT_FOUND', { message: 'Profile not found' });
    const steps = missingOnboardingSteps({ ...read.progress, nickname: true });
    if (steps.length === 0) return;
    const details: OnboardingRequiredDetails = { steps };
    throw new AppError('ONBOARDING_REQUIRED', {
      message: 'The consent and the verification come before the nickname',
      details,
    });
  }
}
