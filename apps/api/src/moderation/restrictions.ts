import { schema, type Db } from '@buddha/db';
import { type RestrictedDetails, type RestrictionKind } from '@buddha/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { assertOnboarded } from '../onboarding/onboarded.guard.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/**
 * The writing restriction in force on the account (작성 제한, #185, ADR-0082), or null: its end —
 * null for 무기한 — read from the member's writing restrictions that are not cancelled and whose end
 * is still to come by the database clock (`clock_timestamp()`, not the transaction's start, so a
 * write that waited on a lock reads the time it writes at). Nothing runs when a term ends
 * (#45-12 «기간제는 끝나면 저절로 풀리고»): the time is compared here, on every ask.
 *
 * Restricted more than once, the one that ends later governs (#45-12 «더 늦게 끝나는 쪽을 남긴다»):
 * every restriction stays its own record (the reason, the operator, the time of each), and the
 * latest end among the standing ones is the member's — 무기한 over any term. So a shorter one given
 * while a longer one stands changes nothing, and a longer one takes over at once.
 */
export function writingRestrictionOf(
  executor: Executor,
  userId: string,
): Promise<RestrictedDetails | null> {
  return standingRestrictionOf(executor, userId, 'writing');
}

/**
 * The account restriction in force on the account (계정 제한, #139, ADR-0085), or null — read as the
 * writing restriction is (`writingRestrictionOf`): the member's account restrictions not cancelled
 * whose end is still to come by the database clock, 무기한 over any term, else the latest end. Each
 * came into force by another admin's approval (ADR-0056 decision 1-7, migration 0040); nothing runs
 * when one ends (#57-12 «기간제는 끝나면 저절로 풀리고»).
 */
export function accountRestrictionOf(
  executor: Executor,
  userId: string,
): Promise<RestrictedDetails | null> {
  return standingRestrictionOf(executor, userId, 'account');
}

/** The moderation_actions type of each restriction kind. */
const RESTRICTION_TYPES = {
  writing: 'writing_restriction',
  account: 'account_restriction',
} as const satisfies Record<RestrictionKind, string>;

async function standingRestrictionOf(
  executor: Executor,
  userId: string,
  kind: RestrictionKind,
): Promise<RestrictedDetails | null> {
  const { moderationActions } = schema;
  const standing = await executor
    .select({ endsAt: moderationActions.endsAt })
    .from(moderationActions)
    .where(
      and(
        eq(moderationActions.userId, userId),
        eq(moderationActions.type, RESTRICTION_TYPES[kind]),
        isNull(moderationActions.cancelledAt),
        sql`(${moderationActions.endsAt} IS NULL OR ${moderationActions.endsAt} > clock_timestamp())`,
      ),
    );
  if (standing.length === 0) return null;
  if (standing.some((row) => row.endsAt === null)) return { kind, endsAt: null };
  const latest = Math.max(...standing.map((row) => row.endsAt!.getTime()));
  return { kind, endsAt: new Date(latest).toISOString() };
}

/**
 * The restriction that keeps the account from what both restrictions refuse — a public profile
 * item's new value (#37-9), a market proposal (#77) and 탈퇴 (#140, ADR-0069 decision 4) — or null:
 * of the writing (#185) and the account restriction (#139) in force, the one the member waits for
 * longer, 무기한 over any term. Both ending together (both 무기한, or one instant), the account
 * restriction is named: the heavier of the two, and the one only another admin's approval lifts
 * (ADR-0085 7-6). Both are read in the caller's transaction and statement order — after the lock
 * that makes the answer hold (the caller's).
 */
export async function restrictionInForce(
  executor: Executor,
  userId: string,
): Promise<RestrictedDetails | null> {
  const writing = await writingRestrictionOf(executor, userId);
  const account = await accountRestrictionOf(executor, userId);
  if (account === null) return writing;
  if (writing === null) return account;
  if (account.endsAt === null) return account;
  if (writing.endsAt === null) return writing;
  return Date.parse(writing.endsAt) > Date.parse(account.endsAt) ? writing : account;
}

/** RESTRICTED for `restriction`: its kind and its end, the screen's «…까지» (null: 무기한). */
export function restrictedError(restriction: RestrictedDetails): AppError {
  return new AppError('RESTRICTED', {
    message: 'A restriction refuses this until it ends',
    details: restriction,
  });
}

/**
 * Refuses the account's write under a writing restriction (RESTRICTED, with its end). Without a
 * lock of its own: a caller whose answer must hold until its write commits holds the account's
 * profile row first (`assertWriter` does; a public profile item's write locks it for update),
 * which an operator's restriction takes FOR UPDATE before it is written (ModerationService).
 * Callers: every post, comment and edit (`assertWriter`) and a post's image upload — refused
 * before the conversion is paid for, as nothing can take the image while the account cannot write.
 * An account restriction refuses none of them (#57-12: «커뮤니티 작성은 막지 않는다»). The public
 * profile items' check point asks both restrictions (`sanctionInForce` is `restrictionInForce`,
 * then `restrictedError` — #41's `assertPublicItemEdit`), and so do #77's market proposals and
 * #140's 탈퇴 once they are stacked here (`assertNotRestricted`, ADR-0069 decision 4 #77 and #140).
 */
export async function assertNotWritingRestricted(
  executor: Executor,
  userId: string,
): Promise<void> {
  const restriction = await writingRestrictionOf(executor, userId);
  if (restriction !== null) throw restrictedError(restriction);
}

/**
 * Refuses what both restrictions refuse while either stands (RESTRICTED with the one that ends
 * later, `restrictionInForce`): #77's market proposal (ADR-0069 decision 4 #77 «계정 제한과 작성 제한
 * 중에는 낼 수 없다») and #140's 탈퇴 (decision 4 #140 «작성 제한·계정 제한이 끝날 때까지 막는다») call
 * it once they are stacked here, in their transaction after locking the account's profile row (an
 * operator's writing restriction and an approved account restriction lock it FOR UPDATE before
 * they are written, so the answer holds until the caller commits). #77's branch has the hook
 * already — `ProposalRestrictions.assertMayPropose`, which lets everything through until then —
 * and its restack onto this fills it with this call (ADR-0085 결과 5). The public profile items ask
 * the same through their own check point (`assertPublicItemEdit`).
 */
export async function assertNotRestricted(executor: Executor, userId: string): Promise<void> {
  const restriction = await restrictionInForce(executor, userId);
  if (restriction !== null) throw restrictedError(restriction);
}

/**
 * The trading check (#139, ADR-0069 decision 1 #57-12 «거래를 막고»; N02 §9 «계정 제한 시 신규 주문은
 * 막되 잔액·기록·이의제기 경로는 유지한다»): RESTRICTED (kind `account`, with its end) while an account
 * restriction stands. #119's order intake calls it — every new order, from the screen or not —
 * inside the order's transaction and before it locks any balance or market row, so a refused
 * order writes nothing and is never matched:
 *
 * 1. The account's profile row, held FOR KEY SHARE until the order commits — the lock
 *    `assertWriter` takes for a post: an approved account restriction locks that row FOR UPDATE
 *    before it is written (AccountRestrictionService), so an order in flight commits before the
 *    restriction and one that comes after reads it. Taken first, so every lock order is the
 *    profile's and then the order's.
 * 2. The account restriction: the writing restriction does not stop trading (#57-12: 작성 제한은
 *    커뮤니티 작성만), nor does anything else here — the balance, the holdings and every record stay
 *    readable and untouched (N02 §9).
 *
 * What #57-13 left unasked stays with M9: pending orders when a restriction comes into force,
 * selling a holding and the limited re-grant (#74). Nothing here cancels or changes an order.
 */
export async function assertCanTrade(tx: Tx, userId: string): Promise<void> {
  await tx
    .select({ one: sql`1` })
    .from(schema.profiles)
    .where(eq(schema.profiles.userId, userId))
    .for('key share');
  const restriction = await accountRestrictionOf(tx, userId);
  if (restriction !== null) throw restrictedError(restriction);
}

/**
 * The one check every new post, 댓글 and 대댓글 and every edit of one's own makes, in the write's
 * transaction and before any row of the write is locked (PostsService and CommentsService call it
 * from their `checkWriter` — the place #187's frequency limits extend):
 *
 * 1. The writer's profile row, held FOR KEY SHARE until the write commits: an operator's writing
 *    restriction locks that row FOR UPDATE before it writes the restriction (ModerationService),
 *    so a write in flight commits before the restriction and one that comes after reads it — the
 *    restriction holds from its commit, with no write slipping past it. The lightest lock that
 *    does so: an ordinary update of the profile (NO KEY UPDATE) does not wait for it. Taken first,
 *    so every lock order is the profile's and then the item's, the order an operator's restriction
 *    or warning takes them in (no deadlock with an edit of the item it names).
 * 2. The onboarding (#57-8), which OnboardedGuard checked before the body was read, held to the
 *    commit here.
 * 3. The writing restriction (#185, ADR-0069 decision 2 #45-12: «글·댓글 쓰기와 자기 글·댓글 수정»):
 *    RESTRICTED with its end. Deleting one's own, likes and reports never come here — they stay
 *    open under it. An account restriction is not asked (#57-12: community writing stays open).
 */
export async function assertWriter(tx: Tx, userId: string): Promise<void> {
  await tx
    .select({ one: sql`1` })
    .from(schema.profiles)
    .where(eq(schema.profiles.userId, userId))
    .for('key share');
  await assertOnboarded(tx, userId);
  await assertNotWritingRestricted(tx, userId);
}
