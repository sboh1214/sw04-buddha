import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  WRITE_LIMITS,
  type OnboardingRequiredDetails,
  type WriteLimitAction,
  type WriteLimitWindow,
  type WriteLimitedDetails,
} from '@buddha/shared';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { PhoneHasher } from '../identity/phone-hash.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/**
 * Who writes, as the write limits (#187) and the repeated-link rules count: the account, the keyed
 * hash of its verified number (ADR-0071) — the person the limits count, not the account (ADR-0069
 * decision 7) — and whether it is an operator's account, which neither applies to (decision 4
 * #187 «운영 계정 → 빈도 제한과 반복 링크 탐지 모두 적용하지 않는다»).
 */
export interface Writer {
  readonly userId: string;
  readonly phoneHash: string;
  readonly isAdmin: boolean;
}

/** A refusal of one window: its reason and limit, and how long until it lets the write through. */
interface Refusal {
  readonly window: WriteLimitWindow;
  readonly waitMs: number;
}

/**
 * 작성 빈도 제한 (#187, ADR-0083; ADR-0069 decision 2 #45-15, decision 4 #187, decision 7): the
 * owner's fixed limits on posts, comments, edits and image uploads (WRITE_LIMITS in @buddha/shared),
 * held by the server whatever sends the write («화면에서만 막지 않고 작성 처리에서 막는다»).
 *
 * A counted write is one transaction with its record:
 * 1. `lockWriter`, first of the write's locks: the account's 본인확인 record FOR KEY SHARE (its
 *    number cannot change or go until the write commits, as a like holds it — ADR-0076), the hash
 *    of that number, and the number's own lock (`buddha:writes`, the hash): two writes of one person
 *    — two tabs, two requests at once, or the accounts a number verified one after another — count
 *    one after the other, so no window is passed by a race. Taken before any row of the write is
 *    locked, by every counted path but the profile image's, so the number's lock never waits
 *    behind a row lock held by another write of the same person. ProfileImageService takes it
 *    after the profile's row, which no other counted write locks, so neither waits on the other
 *    in turn (ADR-0083 decision 4).
 * 2. `take`, where the write is certain to happen (after the checks of what is written, so a
 *    refusal for a limit means the write was otherwise fine): the database clock read after the
 *    locks, every window of the action counted at it, and the record (`write_limit_events`) at that
 *    instant — or WRITE_LIMITED, nothing written. An operator's account is not counted against
 *    the limits; its writes are recorded all the same (a number that loses the role carries on from
 *    them, as #77's proposals do, owner decision 2026-10-20 — ADR-0089).
 *
 * The record is the count: a deleted post or comment still counts (#45-15), an upload the worker
 * removed unused still counts, and a write that rolls back never did. 'A day' is the last 24 hours.
 */
@Injectable()
export class WriteLimitsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly hasher: PhoneHasher,
  ) {}

  /**
   * The writer of a counted write, its number held for the transaction (step 1 of the class doc).
   * An account without a 본인확인 record has not done the onboarding (#58): the same refusal
   * OnboardedGuard gives, naming the step — the guard asked already, so only a record gone in
   * between (a withdrawal) reaches it.
   */
  async lockWriter(tx: Tx, userId: string): Promise<Writer> {
    const writer = await this.writerOf(tx, userId, true);
    if (writer === null) throw verificationMissing();
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('buddha:writes'), hashtext(${writer.phoneHash}))`,
    );
    return writer;
  }

  /**
   * Step 2 of the class doc: counts `action` against its windows for a member and records it.
   * Answers the instant it was recorded at.
   */
  async take(tx: Tx, writer: Writer, action: WriteLimitAction): Promise<Date> {
    const now = await clockTimestamp(tx);
    if (!writer.isAdmin) await this.assertWithin(tx, writer.phoneHash, action, now);
    await tx
      .insert(schema.writeLimitEvents)
      .values({ phoneHash: writer.phoneHash, action, createdAt: now });
    return now;
  }

  /**
   * The same count without the lock or a record, before work too dear to do for a write that will
   * be refused — an image's conversion (MediaService, ProfileImageService). `take` asks again under
   * the lock, which is what holds; this only spares the conversion. An account without a 본인확인
   * record passes here and is refused there.
   */
  async precheck(userId: string, action: WriteLimitAction): Promise<void> {
    const writer = await this.writerOf(this.db, userId, false);
    if (writer === null || writer.isAdmin) return;
    await this.assertWithin(this.db, writer.phoneHash, action, await clockTimestamp(this.db));
  }

  private async writerOf(
    executor: Executor,
    userId: string,
    lock: boolean,
  ): Promise<Writer | null> {
    const { phoneVerifications, profiles } = schema;
    const query = executor
      .select({ phone: phoneVerifications.phone })
      .from(phoneVerifications)
      .where(eq(phoneVerifications.userId, userId))
      .limit(1);
    const [verified] = await (lock ? query.for('key share') : query);
    if (!verified) return null;
    const [profile] = await executor
      .select({ role: profiles.role })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);
    return {
      userId,
      phoneHash: this.hasher.hash(verified.phone),
      isAdmin: profile?.role === 'admin',
    };
  }

  /**
   * Every window of `action` at `now`: a window is full when it holds `limit` records newer than
   * `now - seconds` (a record exactly `seconds` old has left it). WRITE_LIMITED when one is, with
   * the wait until every full one has room again — the longest, as counts only fall while nothing
   * is written.
   */
  private async assertWithin(
    executor: Executor,
    phoneHash: string,
    action: WriteLimitAction,
    now: Date,
  ): Promise<void> {
    const { writeLimitEvents } = schema;
    const refusals: Refusal[] = [];
    for (const window of WRITE_LIMITS[action]) {
      const windowMs = window.seconds * 1_000;
      // The `limit`-th newest record in the window, if there are that many: when it leaves the
      // window, one fewer than the limit is left in it.
      const [nth] = await executor
        .select({ createdAt: writeLimitEvents.createdAt })
        .from(writeLimitEvents)
        .where(
          and(
            eq(writeLimitEvents.phoneHash, phoneHash),
            eq(writeLimitEvents.action, action),
            gt(writeLimitEvents.createdAt, new Date(now.getTime() - windowMs)),
          ),
        )
        .orderBy(desc(writeLimitEvents.createdAt))
        .offset(window.limit - 1)
        .limit(1);
      if (nth)
        refusals.push({ window, waitMs: nth.createdAt.getTime() + windowMs - now.getTime() });
    }
    const longest = refusals.reduce<Refusal | undefined>(
      (kept, refusal) => (kept === undefined || refusal.waitMs > kept.waitMs ? refusal : kept),
      undefined,
    );
    if (longest === undefined) return;
    throw writeLimited({
      reason: longest.window.reason,
      limit: longest.window.limit,
      retryAfterSeconds: retryAfterSeconds(longest.waitMs),
    });
  }
}

/**
 * The wait answered (WriteLimitedDetails): whole minutes, rounded up and at least one — never
 * sooner than the write passes, and never another account's write time to the second (the count
 * takes in every account the number verified, as the proposals' daily limit answers, ADR-0089).
 */
export function retryAfterSeconds(waitMs: number): number {
  return Math.max(1, Math.ceil(waitMs / 60_000)) * 60;
}

function writeLimited(details: WriteLimitedDetails): AppError {
  return new AppError('WRITE_LIMITED', {
    message: `Too many writes: ${details.reason} (retry after ${String(details.retryAfterSeconds)} s)`,
    details,
  });
}

function verificationMissing(): AppError {
  const details: OnboardingRequiredDetails = { steps: ['verification'] };
  return new AppError('ONBOARDING_REQUIRED', { message: 'The onboarding is not done', details });
}
