/**
 * The account the tab's session names, as SessionCacheGuard last heard it — for what is drawn for
 * one account (a notice's or a post's form, a comment box, the comment section) and goes while
 * `['me']` is empty (ADR-0092 결정 10, 오너 결정 2026-10-26 21:00 답 1 «정순서에서도 A의 초안으로»).
 *
 * The forward order: the session names another account first — another window signed in as B, and
 * this tab read its session again on `visibilitychange` — and SessionCacheGuard resets the cache
 * (`resetQueries`), so `['me']` is empty until `GET /me` answers for B. The screens drawn for the
 * account on screen put their placeholders in place of A's forms and boxes in that very render,
 * and what goes then cannot tell from `['me']` whose screen comes next. It hears it here: the guard
 * records each answer before it resets anything for it (components/auth/session-cache-guard.tsx).
 * The other order — `['me']` naming B before the session does (ADR-0090 결정 4-2) — needs none of
 * this: `['me']` says B itself. Nor does a mix of the two, which needs the reset under way: `['me']`
 * naming A again before the session does as A comes back, and the session's reset then taking away
 * what was just drawn for A (`goesWithAccountTurn`, ADR-0092 8-36).
 *
 * In memory, this tab's: the guard is the tab's one listener, and what goes reads it as it goes.
 */
let heard: string | null | undefined;

/**
 * SessionCacheGuard's reset for the session's turn to `identity`, from the guard's effect until
 * the reads it starts have settled (`sessionAccountTurned`) — or the tab forgets its account
 * (`accountForgottenInTab`). `['me']` is empty for that while, the render the reset causes and
 * after: what goes then goes with that turn.
 */
let resetting: { identity: string | null } | undefined;

/**
 * SessionCacheGuard heard the session name `identity` (null: nobody signed in), the same account
 * it heard before or the first it hears in this tab — it resets nothing for it.
 */
export function sessionAccountHeard(identity: string | null): void {
  heard = identity;
}

/**
 * SessionCacheGuard heard the session turn to `identity` (null: nobody signed in) and is about to
 * reset the cache for it — recorded before the reset. Returns what the guard calls once the reads
 * the reset starts have settled (`resetQueries`'s promise): the reset is over then, and `['me']` —
 * active wherever something is drawn for one account — has answered again, or failed.
 */
export function sessionAccountTurned(identity: string | null): () => void {
  heard = identity;
  const reset = { identity };
  resetting = reset;
  return () => {
    if (resetting === reset) resetting = undefined;
  };
}

/**
 * The tab's own sign-out or 탈퇴 empties it of the account (`forgetAccountInTab`): from then on the
 * tab is nobody's — what goes before SessionCacheGuard hears the session name nobody keeps nothing,
 * and no reset under way says otherwise.
 */
export function accountForgottenInTab(): void {
  heard = null;
  resetting = undefined;
}

/**
 * The account the tab is for as something drawn for one account goes, or is drawn again, given
 * `meId` — the account of `GET /me` as the cache holds it: `meId`; or, `['me']` empty, the account
 * the session names as SessionCacheGuard heard it — its reset empties `['me']` as the session turns
 * to that account (the forward order), and the screen is drawn for it next. Undefined: nobody — the
 * session names nobody (a sign-out: the tab keeps nothing for anybody, `forgetAccountInTab`), or
 * none was heard yet.
 */
export function accountNowOf(meId: string | undefined): string | undefined {
  return meId ?? (typeof heard === 'string' ? heard : undefined);
}

/**
 * Whether what was drawn for `writer` — a notice's or a post's form, a comment box, the texts the
 * comment section holds — goes with a turn of the tab's account, given `meId` (`GET /me`'s account
 * as the cache holds it now): it is then kept as `writer`'s for the hour and given back when
 * `writer` is on screen again (ADR-0092 결정 6·7·10, 오너 결정 2026-10-26 17:21 답 2·3, 21:00 답 1
 * «정순서에서도 A의 초안으로» — 어느 순서로 바뀌든).
 * - The tab is now for another account (`accountNowOf`): `['me']` turned to it in place (ADR-0090
 *   결정 4-2), or the session did first and SessionCacheGuard's reset emptied `['me']` (the forward
 *   order).
 * - Or `['me']` is empty in SessionCacheGuard's reset for the session's turn to `writer` itself:
 *   `['me']` named `writer` before the session did — as when `writer` comes back to the tab and
 *   one `visibilitychange` reads both again, `GET /me` answering first — and the reset takes away
 *   what was drawn for `writer`, to be drawn for it again once `GET /me` answers (8-36). What it
 *   holds then can be a draft it had just taken back, out of the tab already.
 *
 * Not when the session names nobody (a sign-out), nor for `writer` with no reset under way for it
 * (the tab's sign-out emptying the cache before the session says nobody, `forgetAccountInTab`), nor
 * with nothing heard yet.
 */
export function goesWithAccountTurn(writer: string, meId: string | undefined): boolean {
  const accountNow = accountNowOf(meId);
  if (accountNow === undefined) return false;
  if (accountNow !== writer) return true;
  return meId === undefined && resetting?.identity === writer;
}
