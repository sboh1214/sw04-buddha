import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  isProposalDeadlineOpen,
  PENDING_PROPOSAL_STATUSES,
  PROPOSAL_LIMITS,
  type CreateProposalBody,
  type Proposal,
  type ProposalLimitedDetails,
} from '@buddha/shared';
import { and, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { PhoneHasher } from '../identity/phone-hash.js';
import { assertOnboarded } from '../onboarding/onboarded.guard.js';
import { type Page } from '../wallet/wallet.service.js';
import { ProposalRestrictions } from './proposal-restrictions.js';
import { proposalQuery, toProposal, type Executor } from './proposal-rows.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const { marketProposals } = schema;

/**
 * 시장 제안 (#77), the proposer's side: submitting a proposal, 내 제안 (the list and one proposal)
 * and the 철회 of a 접수 proposal. Every read and write is the session account's own: another
 * account's proposal is NOT_FOUND, as another account's payment is, and nothing here is read by a
 * public route (the `proposal` item of PRIVATE_DATA).
 *
 * A submission is one transaction (`create`):
 * 1. The onboarding (`assertOnboarded`, #57-8; OnboardedGuard asked it already, this holds it
 *    to the write's snapshot) and the restrictions (`ProposalRestrictions`: the profile row FOR KEY
 *    SHARE, then a writing or an account restriction refuses it — RESTRICTED, ADR-0069 decision 4
 *    #77 자격, #185 and #139).
 * 2. The account's 본인확인 record FOR SHARE, so its number cannot change or go until this
 *    commits, and the keyed hash of the number (PhoneHasher, ADR-0071): the limits count by it,
 *    across every account that verified the number (decision 7).
 * 3. The number's own lock (`buddha:proposal`, the hash), taken before the limits are counted:
 *    two submissions on one number — two tabs, or two accounts the number verified one after
 *    another — count one after the other, so neither limit is passed by a race.
 * 4. The date (today in Korea or later, at the database clock) and the category (active), then
 *    the limits (PROPOSAL_LIMITED) — for a member: an operator's account is exempt (owner decision
 *    2026-10-19, as from #187's frequency limits and the upload limit) — then the row, 접수.
 *
 * The form's checks come before the limits, so a refusal for the limits means the form itself
 * was fine; the onboarding and the restrictions come before both, as a guard's would. An
 * operator's proposal is stored like a member's, the number's hash included: it is a proposal of
 * that number, and a member account the number verifies later counts it (decision 7).
 */
@Injectable()
export class ProposalsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly hasher: PhoneHasher,
    private readonly restrictions: ProposalRestrictions,
  ) {}

  /** `POST /me/proposals`: the class doc's transaction; answers the proposal, 접수. */
  async create(userId: string, body: CreateProposalBody): Promise<Proposal> {
    const id = await this.db.transaction(async (tx) => {
      await assertOnboarded(tx, userId);
      // 작성 제한 (#185)·계정 제한 (#139): proposal-restrictions.ts — the profile row first.
      await this.restrictions.assertMayPropose(tx, userId);
      const phoneHash = await this.verifiedNumberHash(tx, userId);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('buddha:proposal'), hashtext(${phoneHash}))`,
      );
      // After the lock: the window and the stored time sort after whatever committed meanwhile.
      const now = await clockTimestamp(tx);
      if (!isProposalDeadlineOpen(body.deadline, now)) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'The date must be today in Korea or later',
          details: [{ path: ['deadline'], message: 'must be today or later (Korea)' }],
        });
      }
      const categoryId = body.categoryId ?? null;
      if (categoryId !== null) await this.requireActiveCategory(tx, categoryId);
      if (!(await this.isOperator(tx, userId))) await this.assertWithinLimits(tx, phoneHash, now);
      const background = body.background?.trim() ? body.background : null;
      const [row] = await tx
        .insert(marketProposals)
        .values({
          userId,
          phoneHash,
          question: body.question,
          deadline: body.deadline,
          yesCondition: body.yesCondition,
          expectedSources: body.expectedSources,
          background,
          categoryId,
          createdAt: now,
        })
        .returning({ id: marketProposals.id });
      if (!row) throw new AppError('INTERNAL', { message: 'Proposal insert failed' });
      return row.id;
    });
    return this.get(userId, id);
  }

  /** `GET /me/proposals`: the caller's proposals, newest first, keyset-paginated. */
  async list(userId: string, cursor: string | undefined, limit: number): Promise<Page<Proposal>> {
    const keyset = decodeKeyset(cursor, 'uuid');
    const rows = await proposalQuery(this.db)
      .where(
        and(
          eq(marketProposals.userId, userId),
          keyset
            ? keysetPredicate(marketProposals.createdAt, marketProposals.id, keyset, 'uuid')
            : undefined,
        ),
      )
      .orderBy(desc(marketProposals.createdAt), desc(marketProposals.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept.at(-1);
    return {
      items: kept.map(toProposal),
      nextCursor:
        hasMore && last
          ? encodeKeyset({ createdAt: last.proposal.createdAt, id: last.proposal.id })
          : null,
    };
  }

  /** `GET /me/proposals/:id`: one of the caller's proposals; anybody else's is NOT_FOUND. */
  get(userId: string, id: string): Promise<Proposal> {
    return this.read(this.db, userId, id);
  }

  /**
   * `POST /me/proposals/:id/retract`: 접수 → 철회, the proposer's one move (ADR-0069 decision 4
   * #77, 수정·철회). Under the row lock, so a review started meanwhile wins or waits: once 검토,
   * 채택 or 반려 — or 철회 already — it is refused naming `status`, as a market's wrong status is.
   * Signed in is enough (owner decision 2026-10-19): an account that has not finished the
   * onboarding, or that a terms revision sent back to agree again, still retracts its own 접수
   * proposal, as it still deletes its own post (#46, ADR-0073). Nor does a restriction refuse it
   * (proposal-restrictions.ts): it takes the caller's own proposal back and adds nothing, as
   * deleting one's own post does (#45-12).
   */
  async retract(userId: string, id: string): Promise<Proposal> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ status: marketProposals.status })
        .from(marketProposals)
        .where(and(eq(marketProposals.id, id), eq(marketProposals.userId, userId)))
        .limit(1)
        .for('update');
      if (!current) throw new AppError('NOT_FOUND', { message: 'Proposal not found' });
      if (current.status !== 'submitted') {
        throw new AppError('VALIDATION_ERROR', {
          message: `Proposal is ${current.status}`,
          details: [{ path: ['status'], message: `proposal is ${current.status}` }],
        });
      }
      const now = await clockTimestamp(tx);
      await tx
        .update(marketProposals)
        .set({ status: 'retracted', retractedAt: now })
        .where(eq(marketProposals.id, id));
      return this.read(tx, userId, id);
    });
  }

  private async read(executor: Executor, userId: string, id: string): Promise<Proposal> {
    const [row] = await proposalQuery(executor)
      .where(and(eq(marketProposals.id, id), eq(marketProposals.userId, userId)))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Proposal not found' });
    return toProposal(row);
  }

  /**
   * Whether the proposing account is an operator's (`profiles.role`), read in the submission's
   * transaction rather than through AdminGuard's 60-second cache: an account revoked a moment ago
   * is a member's again at once. Operators are exempt from the limits (owner decision 2026-10-19).
   */
  private async isOperator(tx: Tx, userId: string): Promise<boolean> {
    const [profile] = await tx
      .select({ role: schema.profiles.role })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId))
      .limit(1);
    return profile?.role === 'admin';
  }

  /**
   * The keyed hash of the account's verified number, its record held FOR SHARE until the
   * submission commits. The onboarding asked for the record already; one gone since (a withdrawal
   * between the two reads) is VERIFICATION_REQUIRED, as the start grant answers it.
   */
  private async verifiedNumberHash(tx: Tx, userId: string): Promise<string> {
    const [verified] = await tx
      .select({ phone: schema.phoneVerifications.phone })
      .from(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, userId))
      .limit(1)
      .for('share');
    if (!verified) {
      throw new AppError('VERIFICATION_REQUIRED', {
        message: 'A proposal needs a verified mobile number',
      });
    }
    return this.hasher.hash(verified.phone);
  }

  /**
   * An unknown or retired category is VALIDATION_ERROR naming `categoryId`, as the interest
   * categories answer (a member picks from the active list). FOR KEY SHARE so the row cannot go
   * before the proposal that references it is written.
   */
  private async requireActiveCategory(tx: Tx, categoryId: number): Promise<void> {
    const [category] = await tx
      .select({ isActive: schema.categories.isActive })
      .from(schema.categories)
      .where(eq(schema.categories.id, categoryId))
      .limit(1)
      .for('key share');
    if (!category?.isActive) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Unknown or inactive category',
        details: [{ path: ['categoryId'], message: 'not an active category' }],
      });
    }
  }

  /**
   * PROPOSAL_LIMITS, counted by the number's hash under its lock: the proposals waiting for the
   * operators (`pending`, refused with no time — it passes once one is decided or retracted),
   * then those of the last 24 hours whatever their status since (`daily`, refused until the
   * oldest of the newest `dailyProposals` leaves the window, rounded up to the minute: the count
   * takes in every account that verified the number, as the 본인확인's shared limits round theirs).
   */
  private async assertWithinLimits(tx: Tx, phoneHash: string, now: Date): Promise<void> {
    const [pending] = await tx
      .select({ count: count() })
      .from(marketProposals)
      .where(
        and(
          eq(marketProposals.phoneHash, phoneHash),
          inArray(marketProposals.status, [...PENDING_PROPOSAL_STATUSES]),
        ),
      );
    if ((pending?.count ?? 0) >= PROPOSAL_LIMITS.pendingProposals) {
      const details: ProposalLimitedDetails = {
        reason: 'pending',
        limit: PROPOSAL_LIMITS.pendingProposals,
        retryAfterSeconds: null,
      };
      throw new AppError('PROPOSAL_LIMITED', {
        message: 'Too many proposals are waiting for review',
        details,
      });
    }
    const windowMs = PROPOSAL_LIMITS.dailyWindowSeconds * 1_000;
    const recent = await tx
      .select({ createdAt: marketProposals.createdAt })
      .from(marketProposals)
      .where(
        and(
          eq(marketProposals.phoneHash, phoneHash),
          gt(marketProposals.createdAt, new Date(now.getTime() - windowMs)),
        ),
      )
      .orderBy(desc(marketProposals.createdAt))
      .limit(PROPOSAL_LIMITS.dailyProposals);
    if (recent.length < PROPOSAL_LIMITS.dailyProposals) return;
    // The oldest of the newest `dailyProposals`: once it leaves the window, one fewer is in it.
    const leaving = recent.at(-1)!.createdAt.getTime() + windowMs;
    const seconds = Math.max(1, Math.ceil((leaving - now.getTime()) / 1_000));
    const details: ProposalLimitedDetails = {
      reason: 'daily',
      limit: PROPOSAL_LIMITS.dailyProposals,
      retryAfterSeconds: Math.ceil(seconds / 60) * 60,
    };
    throw new AppError('PROPOSAL_LIMITED', {
      message: 'Too many proposals in the last 24 hours',
      details,
    });
  }
}
