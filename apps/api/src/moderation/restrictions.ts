import { schema, type Db } from '@buddha/db';
import { type RestrictedDetails } from '@buddha/shared';
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
export async function writingRestrictionOf(
  executor: Executor,
  userId: string,
): Promise<RestrictedDetails | null> {
  const { moderationActions } = schema;
  const standing = await executor
    .select({ endsAt: moderationActions.endsAt })
    .from(moderationActions)
    .where(
      and(
        eq(moderationActions.userId, userId),
        eq(moderationActions.type, 'writing_restriction'),
        isNull(moderationActions.cancelledAt),
        sql`(${moderationActions.endsAt} IS NULL OR ${moderationActions.endsAt} > clock_timestamp())`,
      ),
    );
  if (standing.length === 0) return null;
  if (standing.some((row) => row.endsAt === null)) return { kind: 'writing', endsAt: null };
  const latest = Math.max(...standing.map((row) => row.endsAt!.getTime()));
  return { kind: 'writing', endsAt: new Date(latest).toISOString() };
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
 * The public profile items' check point asks the same restriction and refuses with the same error
 * (`sanctionInForce` is `writingRestrictionOf`, then `restrictedError` — #41's
 * `assertPublicItemEdit`). #77's market proposals and #140's withdrawal ask the same once they are
 * stacked here (ADR-0069 decision 4 #77 and #140 rows).
 */
export async function assertNotWritingRestricted(
  executor: Executor,
  userId: string,
): Promise<void> {
  const restriction = await writingRestrictionOf(executor, userId);
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
 *    open under it.
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
