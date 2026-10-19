import { Injectable } from '@nestjs/common';
import { type Db } from '@buddha/db';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * HOOK — the restrictions that keep an account from proposing a market (ADR-0069 decision 4 #77,
 * 자격): an account restriction (#57-13, #139) and a writing restriction (#45-12, #185). Neither
 * exists yet; the PRs that bring them fill `assertMayPropose` here, and nothing else in the
 * proposal path changes:
 *
 * - #185 (작성 제한): refuse while the account's writing restriction runs, with the typed error and
 *   end time its own check gives every write path.
 * - #139 (계정 제한): refuse while the account restriction runs, likewise.
 *
 * Called once per submission, inside the submission's transaction (`ProposalsService.create`),
 * after the onboarding check and before anything is read for the limits or written — so a refusal
 * leaves nothing behind and is answered ahead of the limits, and a restriction that commits while
 * the submission runs is read as of the submission's own snapshot, like the onboarding. Only a new
 * proposal is refused: retracting one's own 접수 proposal stays open under a restriction, as
 * deleting one's own posts does (#45-12). A test replaces this with a stub that refuses
 * (proposals.controller.test.ts) to prove the path calls it and writes nothing after a refusal.
 */
@Injectable()
export class ProposalRestrictions {
  /** Resolves while the account may propose; rejects with the restriction's AppError otherwise. */
  assertMayPropose(tx: Tx, userId: string): Promise<void> {
    // Nothing restricts an account yet (#139, #185). The parameters are the ones those checks
    // read: the transaction to read the restriction in, and the proposing account.
    void tx;
    void userId;
    return Promise.resolve();
  }
}
