import { Inject, Injectable, Logger } from '@nestjs/common';
import { cancelStartGrant, lockAdminRoles, lockNicknames, schema, type Db } from '@buddha/db';
import {
  ACCOUNT_CLOSURE_DECISION_REASON,
  ACCOUNT_RESTRICTION_APPROVAL_KINDS,
  AUTH_USER_NAME,
  closedAccountEmail,
  serializeCoinAmount,
  type AccountClosureCheck,
  type AccountClosureRefusal,
  type AccountClosureResult,
  type Role,
} from '@buddha/shared';
import { type ObjectStorage } from '@buddha/storage';
import { and, eq, gt, inArray, isNotNull, like, or, sql } from 'drizzle-orm';
import { ApprovalService } from '../approvals/approval.service.js';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { OBJECT_STORAGE } from '../media/object-storage.provider.js';
import { assertNotRestricted, restrictionInForce } from '../moderation/restrictions.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/** CLOSURE_NOT_ALLOWED for `reason` (accountClosureNotAllowedDetailsSchema). */
export function closureNotAllowed(reason: AccountClosureRefusal): AppError {
  const messages: Record<AccountClosureRefusal, string> = {
    admin: 'An admin account closes only once its admin role is revoked',
    unsettled_contracts: 'The account holds contracts not settled yet',
    payment_in_progress: 'A payment of the account is pending or refunding',
    pending_orders: 'The account has orders waiting',
  };
  return new AppError('CLOSURE_NOT_ALLOWED', { message: messages[reason], details: { reason } });
}

/** The order statuses of an order still waiting (#178 cancels them before a closure). */
const WAITING_ORDER_STATUSES = ['open', 'partially_filled'] as const;

/** The payment statuses a closure waits for (ADR-0069 decision 7: «진행 중인 결제·환불»). */
const PAYMENT_IN_PROGRESS_STATUSES = ['pending', 'refunding'] as const;

/** The kinds of #139's requests about a member's account restriction, the one the closure closes. */
const CHANGE_KINDS = [
  ACCOUNT_RESTRICTION_APPROVAL_KINDS.shorten,
  ACCOUNT_RESTRICTION_APPROVAL_KINDS.lift,
  ACCOUNT_RESTRICTION_APPROVAL_KINDS.cancel,
];

/** What a closure's transaction leaves for after its commit, and its answer. */
interface Closed {
  closedAt: Date;
  forfeitedCoin: bigint;
  /** The profile image's object, its row deleted in the transaction; null when there was none. */
  imageKey: string | null;
}

/**
 * 탈퇴 (#140, ADR-0069 decision 1 #57-15…#57-18, decision 3 #37-15…#37-17, decision 4 #140 rows,
 * decision 7; ADR-0086): the member closes their own account, at once, on one confirmation. Nobody
 * else closes it and nothing restores it (#57-17), so there is no admin route here.
 *
 * One transaction does it all, under the locks every writer of the same rows takes first — the
 * admin-roles lock shared (a role grant takes it exclusively, then the grantee's profile; the
 * closure closes the account's requests under it too), the profile row FOR UPDATE (an operator's
 * restriction and a request about the member, a public item's write and a nickname's change hold
 * it before they write — so no request it would close commits after it looked for them), then
 * #70's order: the 본인확인 record, the start grant, the balance (ADR-0071 7-18) — so whatever was
 * in flight commits first and is seen, and whatever comes later finds the account closed. The
 * writers that take none of these locks — a session or a sign-in method, a nickname hold, a
 * watch, a recorded search, a code send or a 본인확인 record, a password-reset token — meet the
 * same order in migration 0043's insert triggers, which read the profile FOR KEY SHARE and refuse
 * a closed account (the API answers that refusal as UNAUTHENTICATED, `closedAccountRefusal`):
 *
 * 1. Refused while the account holds the admin role (`admin`, #57-17), a writing or an account
 *    restriction stands (RESTRICTED, `assertNotRestricted` — decision 4 #140 «제재 중 탈퇴»; a
 *    request waiting for approval does not refuse it, owner decision 2026-10-23), a contract it
 *    holds is not settled (`unsettled_contracts`, #57-16), a payment is pending or refunding
 *    (`payment_in_progress`, decision 7) or an order waits (`pending_orders` — cancelling them
 *    first, N02 §9, is #178's; until then the closure never runs past an order's reserved Coin).
 * 2. A start grant still waiting for its amount is cancelled (`cancelStartGrant`, owner decision
 *    2026-10-18 on #70: the number did not receive it, so the next account verifying it may), and
 *    the 본인확인 record — the verified number and real name — is deleted. The code-send records
 *    stay for #184's retention (ADR-0070 2차 답 1), and so do the numbers that received the start
 *    Coin (#57-1: no second grant on re-signup) and the keyed hashes of likes and reports (decision
 *    7: the limits go on by number).
 * 3. The Coin left is forfeited ('탈퇴 소멸', `CLOSURE_FORFEIT`, #57-16): one ledger entry of the
 *    whole balance, never an overwrite (N01 §9), so the ledger still sums to the balance.
 * 4. The public face goes (#37-16): the nickname — held from every account for NICKNAME_HOLD_DAYS
 *    with no link to this one (#57-6, #57-18), and every hold naming the account loses that link —
 *    the 소개, the image (row now, object after the commit), the interest categories; the profile is
 *    marked closed, so every byline is '탈퇴한 사용자' and the profile and its lists answer 404
 *    (`postAuthorOf`). Posts, comments and likes stay as they are (#37-17).
 * 5. The current watchlist goes, each watch ended by its unwatch event in the watch history, which
 *    stays (ADR-0064; owner decision 2026-10-23 (2차) 2), and the search history goes (#57-18).
 *    So does the profile's time zone (point 4; owner decision 2026-10-23 (3차) 6).
 * 6. Signing in ends: every session, every sign-in method (password and social links), better-auth's
 *    password-reset tokens for the account; the address is replaced by `closedAccountEmail` (freed
 *    for a new sign-up at once, #57-17), the name and photo emptied (decision 7). Migration 0043
 *    refuses a session or a sign-in method for a closed account from then on.
 * 7. The account restriction requests about the member still waiting are closed as rejected by no
 *    admin, reason '탈퇴' (owner decision 2026-10-23, ADR-0085 결과 5); those decided or retracted
 *    stay as they are. Requests the member made as an operator are left to the other operators:
 *    an admin closes only once the role is revoked, and a request outlives its requester's role.
 *
 * What stays (#57-18): the ledger, orders, fills and positions, the watch events, the consent
 * records, posts and comments with their histories, likes, reports filed and received and actions
 * — reports still waiting are processed as any (decision 4 #140 «처리 중인 신고 … 그대로 검토»), the
 * member no longer seeing them. Migration 0043 checks at the commit that nothing of the deletions
 * was left (`profiles_closed_completely`).
 *
 * Asked twice at once (two tabs), the second waits for the first and answers what it did: the
 * closure runs once. After the commit the sessions are gone, so every later request is
 * UNAUTHENTICATED.
 */
@Injectable()
export class AccountClosureService {
  private readonly logger = new Logger(AccountClosureService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly approvals: ApprovalService,
  ) {}

  /**
   * `GET /me/closure`: what the confirmation screen says before anything is typed — the Coin a
   * closure would forfeit now and what refuses it now (the reasons in the order the closure asks
   * them, and the restriction it would name). Read without locks: the closure asks it all again.
   */
  async check(userId: string): Promise<AccountClosureCheck> {
    const [account] = await this.db
      .select({ role: schema.profiles.role, availableCoin: schema.balances.availableCoin })
      .from(schema.profiles)
      .innerJoin(schema.balances, eq(schema.balances.userId, schema.profiles.userId))
      .where(eq(schema.profiles.userId, userId))
      .limit(1);
    if (!account) throw new AppError('NOT_FOUND', { message: 'Profile not found' });
    return {
      availableCoin: serializeCoinAmount(account.availableCoin),
      refusals: await this.refusalsOf(this.db, userId, account.role),
      restriction: await restrictionInForce(this.db, userId),
      startGrantReceived: await this.startGrantReceived(userId),
    };
  }

  /**
   * Whether the account's start Coin was paid (owner decision 2026-10-23 (3차) 9): only then is its
   * number one that never gets the start Coin again (#57-1), and the screen says so. A grant still
   * waiting is not — the closure cancels it and the number may receive it with the next account
   * (owner decision 2026-10-18 on #70) — nor is none at all (not asked yet, or `number_used`: the
   * number's start Coin is another account's).
   */
  private async startGrantReceived(userId: string): Promise<boolean> {
    const [grant] = await this.db
      .select({ one: sql`1` })
      .from(schema.startGrants)
      .where(and(eq(schema.startGrants.userId, userId), isNotNull(schema.startGrants.grantedAt)))
      .limit(1);
    return grant !== undefined;
  }

  /** `POST /me/closure`: closes the account (see the class); the confirmation was checked. */
  async close(userId: string): Promise<AccountClosureResult> {
    const closed = await this.db.transaction((tx) => this.closeIn(tx, userId));
    if (closed.imageKey !== null) await this.removeObject(closed.imageKey);
    return {
      closedAt: closed.closedAt.toISOString(),
      forfeitedCoin: serializeCoinAmount(closed.forfeitedCoin),
    };
  }

  private async closeIn(tx: Tx, userId: string): Promise<Closed> {
    const { profiles, balances, phoneVerifications } = schema;
    await lockAdminRoles(tx, 'shared');
    const [profile] = await tx
      .select({
        role: profiles.role,
        nickname: profiles.nickname,
        imageId: profiles.imageId,
        closedAt: profiles.closedAt,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1)
      .for('update');
    if (!profile) throw new AppError('NOT_FOUND', { message: 'Profile not found' });
    // The same request a moment later (another tab): it waited on the row and finds it closed.
    if (profile.closedAt !== null) {
      return {
        closedAt: profile.closedAt,
        forfeitedCoin: await this.forfeitedBy(tx, userId),
        imageKey: null,
      };
    }

    // #70's lock order (ADR-0071 7-18) before anything is asked: the 본인확인 record, then the
    // start grant (`cancelStartGrant` takes both again), then the balance — a payment of the start
    // Coin in flight commits first and is forfeited with the rest.
    await tx
      .select({ held: sql`1` })
      .from(phoneVerifications)
      .where(eq(phoneVerifications.userId, userId))
      .for('update');
    await tx
      .select({ held: sql`1` })
      .from(schema.startGrants)
      .where(eq(schema.startGrants.userId, userId))
      .for('update');
    const [balance] = await tx
      .select({ availableCoin: balances.availableCoin, lockedCoin: balances.lockedCoin })
      .from(balances)
      .where(eq(balances.userId, userId))
      .limit(1)
      .for('update');
    if (!balance) throw new AppError('NOT_FOUND', { message: 'Balance not found' });

    if (profile.role === 'admin') throw closureNotAllowed('admin');
    await assertNotRestricted(tx, userId);
    // #178's hook: N02 §9 cancels the waiting orders first («대기 주문을 취소하고 … 계정 폐쇄») — its
    // cancellation, under the order's own locks, goes here and `pending_orders` leaves the refusals.
    // Until the cancellation exists a waiting order refuses the closure instead.
    const [refusal] = await this.refusalsOf(tx, userId, profile.role);
    if (refusal !== undefined) throw closureNotAllowed(refusal);
    // Reserved Coin exists only for a waiting order, refused above: nothing a closure may forfeit
    // or leave behind (#178 cancels the orders and frees it first).
    if (balance.lockedCoin !== 0n) {
      throw new AppError('INTERNAL', { message: 'Reserved Coin with no order waiting' });
    }

    const closedAt = await clockTimestamp(tx);
    await cancelStartGrant(tx, userId);
    await tx.delete(phoneVerifications).where(eq(phoneVerifications.userId, userId));
    const forfeitedCoin = await this.forfeit(tx, userId, balance.availableCoin, closedAt);
    const imageKey = await this.anonymise(tx, userId, profile.nickname!, profile.imageId, closedAt);
    await this.unwatchAll(tx, userId, closedAt);
    await tx.delete(schema.marketSearches).where(eq(schema.marketSearches.userId, userId));
    await this.endSignIn(tx, userId);
    await this.closeRequests(tx, userId, closedAt);
    return { closedAt, forfeitedCoin, imageKey };
  }

  /**
   * What refuses a closure now besides the admin role and a restriction, in the order it is asked
   * (ACCOUNT_CLOSURE_REFUSALS): the admin role, then a contract not settled — a position holding
   * contracts in a market not settled yet (#57-16; none can exist before trading, M9) — a payment
   * pending or refunding (decision 7; none while paid Coin is closed, D9) and an order waiting
   * (#178's to cancel; none before the order intake, #119).
   */
  private async refusalsOf(
    executor: Executor,
    userId: string,
    role: Role,
  ): Promise<AccountClosureRefusal[]> {
    const { positions, payments, orders } = schema;
    const exists = async (rows: Promise<unknown[]>) => (await rows).length > 0;
    const unsettled = await exists(
      executor
        .select({ one: sql`1` })
        .from(positions)
        .where(
          and(eq(positions.userId, userId), gt(positions.qty, 0), eq(positions.settled, false)),
        )
        .limit(1),
    );
    const paying = await exists(
      executor
        .select({ one: sql`1` })
        .from(payments)
        .where(
          and(
            eq(payments.userId, userId),
            inArray(payments.status, [...PAYMENT_IN_PROGRESS_STATUSES]),
          ),
        )
        .limit(1),
    );
    const ordering = await exists(
      executor
        .select({ one: sql`1` })
        .from(orders)
        .where(and(eq(orders.userId, userId), inArray(orders.status, [...WAITING_ORDER_STATUSES])))
        .limit(1),
    );
    const refusals: AccountClosureRefusal[] = [];
    if (role === 'admin') refusals.push('admin');
    if (unsettled) refusals.push('unsettled_contracts');
    if (paying) refusals.push('payment_in_progress');
    if (ordering) refusals.push('pending_orders');
    return refusals;
  }

  /**
   * '탈퇴 소멸' (#57-16): the whole available balance forfeited by one CLOSURE_FORFEIT entry that
   * refers to the account itself, and the balance taken to 0 with it — an entry and its balance in
   * one transaction, never an overwrite (PLAN 5.6). Nothing is written when nothing is left.
   */
  private async forfeit(
    tx: Tx,
    userId: string,
    availableCoin: bigint,
    closedAt: Date,
  ): Promise<bigint> {
    if (availableCoin === 0n) return 0n;
    await tx.insert(schema.ledgerEntries).values({
      userId,
      type: 'CLOSURE_FORFEIT',
      amountCoin: -availableCoin,
      balanceAfterCoin: 0n,
      refType: 'account_closure',
      refId: userId,
      createdAt: closedAt,
    });
    await tx
      .update(schema.balances)
      .set({ availableCoin: 0n })
      .where(eq(schema.balances.userId, userId));
    return availableCoin;
  }

  /** What an earlier closure of the account forfeited: its entry's amount, or 0 for none. */
  private async forfeitedBy(executor: Executor, userId: string): Promise<bigint> {
    const [entry] = await executor
      .select({ amountCoin: schema.ledgerEntries.amountCoin })
      .from(schema.ledgerEntries)
      .where(
        and(
          eq(schema.ledgerEntries.refType, 'account_closure'),
          eq(schema.ledgerEntries.refId, userId),
        ),
      )
      .limit(1);
    return entry === undefined ? 0n : -entry.amountCoin;
  }

  /**
   * The public face goes (#37-16, #57-18): the nickname is given up and held for NICKNAME_HOLD_DAYS
   * from every account, linked to none (#57-6, #57-18 «계정과의 연결을 끊은 채»), under its lock as
   * every nickname write takes it; the holds that named the account — a change's, one an operator's
   * cancelled reset handed it (ADR-0081) — lose that link and hold the nickname from everybody for
   * what is left of their 30 days. Then the profile is marked closed with no nickname, 소개 or image
   * (one UPDATE, profiles_closed_check) and no time zone either — the private setting of MY 설정
   * goes with the rest (owner decision 2026-10-23 (3차) 6: NULL, "follow the browser", as for an
   * account that never picked one) — the interest categories are deleted, and the profile image's
   * row with them — its object after the commit. Returns that object's key, or null.
   */
  private async anonymise(
    tx: Tx,
    userId: string,
    nickname: string,
    imageId: string | null,
    closedAt: Date,
  ): Promise<string | null> {
    const { profiles, nicknameHolds } = schema;
    await lockNicknames(tx, [nickname]);
    await tx.update(nicknameHolds).set({ userId: null }).where(eq(nicknameHolds.userId, userId));
    await tx.insert(nicknameHolds).values({ nickname, userId: null, releasedAt: closedAt });
    await tx
      .update(profiles)
      .set({ closedAt, nickname: null, bio: null, imageId: null, timeZone: null })
      .where(eq(profiles.userId, userId));
    await tx
      .delete(schema.profileInterestCategories)
      .where(eq(schema.profileInterestCategories.userId, userId));
    if (imageId === null) return null;
    const [image] = await tx
      .delete(schema.mediaObjects)
      .where(eq(schema.mediaObjects.id, imageId))
      .returning({ storageKey: schema.mediaObjects.storageKey });
    return image?.storageKey ?? null;
  }

  /**
   * The watchlist goes (#57-18 «관심 시장»), each watch ended in the watch history as an unwatch
   * would end it (owner decision 2026-10-23 (2차) 2): one `unwatch` event per watch deleted, at the
   * closure's instant, so the history kept for metrics (ADR-0064, #95 — the account linked) counts
   * no watch the closed account no longer has. The watch row's primary key orders this with a
   * watch or an unwatch of the same pair in flight, as WatchlistService's own writes are ordered:
   * one committed first is deleted here with its event, and a later one is refused (migration
   * 0043's `market_watches_open_account`) or finds nothing to delete. Migration 0043 checks at the
   * commit that no watch of the account is left without its unwatch.
   */
  private async unwatchAll(tx: Tx, userId: string, closedAt: Date): Promise<void> {
    const { marketWatches, marketWatchEvents } = schema;
    const deleted = await tx
      .delete(marketWatches)
      .where(eq(marketWatches.userId, userId))
      .returning({ marketId: marketWatches.marketId });
    if (deleted.length === 0) return;
    await tx
      .insert(marketWatchEvents)
      .values(
        deleted
          .sort((a, b) => a.marketId.localeCompare(b.marketId))
          .map(({ marketId }) => ({ userId, marketId, action: 'unwatch', createdAt: closedAt })),
      );
  }

  /**
   * Signing in ends (#57-18 «로그인 수단·세션», decision 7): every session and sign-in method of the
   * account, and better-auth's password-reset tokens naming it (`reset-password:<token>`, whose
   * value is the account id — one followed later would give the account a password again). The
   * `user` row stays (the ledger and every record name it): its address becomes the closed
   * placeholder (`closedAccountEmail`), unverified, so the real one is free for a new sign-up at
   * once (#57-17), and the name and photo are emptied — better-auth's AUTH_USER_NAME and no image,
   * as the service keeps them anyway (ADR-0072).
   */
  private async endSignIn(tx: Tx, userId: string): Promise<void> {
    const { session, account, verification, user } = schema;
    await tx.delete(session).where(eq(session.userId, userId));
    await tx.delete(account).where(eq(account.userId, userId));
    await tx
      .delete(verification)
      .where(
        and(like(verification.identifier, 'reset-password:%'), eq(verification.value, userId)),
      );
    await tx
      .update(user)
      .set({
        email: closedAccountEmail(userId),
        emailVerified: false,
        name: AUTH_USER_NAME,
        image: null,
      })
      .where(eq(user.id, userId));
  }

  /**
   * The account restriction requests about the member still waiting (#139's four kinds — one to
   * restrict the member, one to shorten, lift or cancel a restriction of theirs) are closed as
   * rejected by no admin, with the reason '탈퇴' and the closure's instant (owner decision
   * 2026-10-23, ADR-0085 결과 5) — through ApprovalService, the one writer of requests. The operators
   * see them among the decided ones; the member never saw any. Not an operator's work, so no
   * `admin_actions` row: the request itself records how it closed.
   */
  private async closeRequests(tx: Tx, userId: string, closedAt: Date): Promise<void> {
    const { approvalRequests, moderationActions } = schema;
    const requests = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.status, 'pending'),
          or(
            and(
              eq(approvalRequests.kind, ACCOUNT_RESTRICTION_APPROVAL_KINDS.apply),
              eq(approvalRequests.targetType, 'user'),
              eq(approvalRequests.targetId, userId),
            ),
            and(
              inArray(approvalRequests.kind, CHANGE_KINDS),
              eq(approvalRequests.targetType, 'moderation_action'),
              inArray(
                approvalRequests.targetId,
                tx
                  .select({ id: sql<string>`${moderationActions.id}::text` })
                  .from(moderationActions)
                  .where(eq(moderationActions.userId, userId)),
              ),
            ),
          ),
        ),
      )
      .orderBy(approvalRequests.requestedAt, approvalRequests.id);
    for (const { id } of requests) {
      await this.approvals.rejectByClosure(id, ACCOUNT_CLOSURE_DECISION_REASON, closedAt, tx);
    }
  }

  /**
   * Removes the profile image's object after the commit that deleted its row, as ProfileImageService
   * does a replaced one: never inside the transaction (a slow store would hold the profile's lock),
   * and a commit lost after the object went can never leave a profile naming an image without
   * bytes. Best effort: a store that will not remove it leaves bytes nothing names, which no reader
   * can reach — logged with the key for an operator. Queueing the retry (#46's `media_deletions`)
   * comes with the restack onto #46's last commit (ADR-0086).
   */
  private async removeObject(storageKey: string): Promise<void> {
    await this.storage.delete(storageKey).catch((error: unknown) => {
      this.logger.error({ err: error, storageKey }, 'could not remove a closed account’s image');
    });
  }
}
