import * as z from 'zod';

/**
 * The account the screen shows (better-auth `user.id`, text), which the cookie must be (A-PG-24):
 * a tab whose session switched to another account before SessionCacheGuard reset its cache still
 * draws the first account's screen, and a write from it would otherwise be done as the second. The
 * API refuses a mismatch before anything is read, locked or written (403 FORBIDDEN naming the
 * field, `assertExpectedAccount`). Every owner write carries it, and so do the admin writes —
 * the admin on screen (`useOperatorId`), so a change is never recorded under an admin the user is
 * not looking at (ADR-0092; the balance adjustment and the refund wait on Q-PG-8 ①, whose third
 * route, the manual settlement, ADR-0049 removed).
 */
export const expectedAccountIdSchema = z.string().min(1).max(255);

/**
 * The body of an admin write that takes nothing else — a transition named by its path (a market's
 * 공개·마감, a theme's 공개·내리기, a theme notice's 숨기기·보이기, a notice's 고정·고정 해제, a
 * proposal's 검토 시작): the admin on screen, and nothing else.
 */
export const expectedAccountBodySchema = z
  .object({ expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'ExpectedAccountBody' });
export type ExpectedAccountBody = z.infer<typeof expectedAccountBodySchema>;

/**
 * `?expectedAccountId=…` of an admin DELETE (a related market's, a theme's market's, a charge
 * package's): OpenAPI 3.0 leaves a DELETE's body undefined, so the account rides in the query, as
 * an upload's does (`uploadImageQuerySchema` — its body is the file). An admin's id, which the
 * admin record names anyway. No `.meta`: swagger expands it into the one parameter.
 */
export const expectedAccountQuerySchema = z.object({
  expectedAccountId: expectedAccountIdSchema,
});
export type ExpectedAccountQuery = z.infer<typeof expectedAccountQuerySchema>;

/**
 * What a write hands its service: the body without the account it named. The controller checks
 * the account and drops it, so it is never stored with what the write records (a market's
 * `created` event keeps its body).
 */
export type WithoutExpectedAccount<T> = Omit<T, 'expectedAccountId'>;

/**
 * Whether a parsed partial body (a PATCH) names any field beside the account — the 'at least one
 * field' rule of every update, which the always-present `expectedAccountId` must not satisfy.
 */
export function namesAFieldBesideAccount(value: Record<string, unknown>): boolean {
  return Object.entries(value).some(
    ([name, field]) => name !== 'expectedAccountId' && field !== undefined,
  );
}
