import { Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { eq, sql } from 'drizzle-orm';
import { assertNotRestricted } from '../moderation/restrictions.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The restrictions that keep an account from proposing a market (ADR-0069 decision 4 #77, 자격 —
 * «계정 제한과 작성 제한 중에는 낼 수 없다»): an account restriction (#57-13, #139, ADR-0085) and a
 * writing restriction (#45-12, #185, ADR-0082). Both refuse a new proposal, so the refusal is
 * RESTRICTED with the one that ends later — 무기한 winning, the account restriction when both end
 * together (`restrictionInForce`, ADR-0085 7-6) — the end the member waits for, as for a public
 * profile item's new value and the closure (#140):
 *
 * 1. The proposer's profile row, held FOR KEY SHARE until the submission commits — the lock
 *    `assertWriter` and `assertCanTrade` take: an operator's restriction (and its approval, #139)
 *    locks that row FOR UPDATE before it is written, so a submission in flight commits before the
 *    restriction and one that comes after reads it. Taken before anything else of the submission
 *    is locked (the 본인확인 record, the number's lock, the category), so every lock order is the
 *    profile's first — the closure's (#140) too, which locks that row before it deletes the
 *    본인확인 record the submission reads FOR SHARE.
 * 2. The restrictions (`assertNotRestricted`): RESTRICTED with the kind and the end, null for 무기한.
 *
 * Called once per submission, inside the submission's transaction (`ProposalsService.create`),
 * after the onboarding check and before anything is read for the limits or written — so a refusal
 * leaves nothing behind and is answered ahead of the limits. Only a new proposal is refused:
 * retracting one's own 접수 proposal stays open under either restriction, as deleting one's own
 * posts does (#45-12). An injectable of its own so a test can replace it with a stub that refuses
 * (proposals.controller.test.ts), proving the path calls it and writes nothing after a refusal;
 * the real restrictions are tested there too.
 */
@Injectable()
export class ProposalRestrictions {
  /** Resolves while the account may propose; rejects with RESTRICTED otherwise. */
  async assertMayPropose(tx: Tx, userId: string): Promise<void> {
    await tx
      .select({ one: sql`1` })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId))
      .for('key share');
    await assertNotRestricted(tx, userId);
  }
}
