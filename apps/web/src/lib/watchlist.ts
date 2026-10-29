import { copy } from '@/copy';
import { type WatchState, isForAnotherAccount } from './api';

/**
 * 관심 시장 (#89, ADR-0064): the decisions of the detail's watch button and of MY's list, kept out
 * of the components so the node test runner can reach them (the rule `use-admin-markets.ts`
 * states). The owner's part (ADR-0061 decision 3): the button is on the detail only, a signed-out
 * press goes to the login page and back to the same market with nothing registered (the visitor
 * presses again), and nobody but the member sees the state — so nothing of it is in the server's
 * HTML.
 */

/** What a press of the button does. */
export type WatchPress = 'login' | 'watch' | 'unwatch' | 'wait';

/** What the button draws: a placeholder of its size, or the toggle with its state and its press. */
export type WatchButtonView =
  | { kind: 'placeholder' }
  | { kind: 'hidden' }
  | { kind: 'toggle'; pressed: boolean; press: WatchPress };

export interface WatchButtonInput {
  /**
   * better-auth has not said who is signed in yet. Always true on the server and through
   * hydration (`useSession`), which is what keeps the detail's HTML the same for every visitor.
   */
  sessionPending: boolean;
  signedIn: boolean;
  /**
   * Signed in, and `GET /me` failed without ever answering: the account the screen shows — whose
   * state the toggle would draw, and whose a press would name — is unknown (ADR-0091).
   */
  profileFailed: boolean;
  /**
   * The caller's state (`GET /me/watchlist/:id`) as `useQuery` reports it, under the account the
   * screen shows (`watchStateKey`) — never read before `GET /me` answered. `isFetched`: a read
   * has answered — with the state or with a failure — since the entry was made; a session
   * change (SessionCacheGuard's `resetQueries`), or `['me']` turning to another account, makes a
   * new entry. `data` is `undefined` before the state is known and after its read failed.
   */
  state: { isFetched: boolean; data: WatchState | undefined };
  /** A press of this button is on the wire. */
  saving: boolean;
}

/**
 * The button's rung.
 *
 * - Until the session is known it is a placeholder: no state is drawn that the session could
 *   contradict, on the server or in the first client render.
 * - Signed out, it is the toggle, not pressed, and a press goes to the login page. Nothing is
 *   remembered for after the login (the owner: the visitor presses again).
 * - Signed in, the state is read for the account the screen shows (ADR-0091), so nothing is drawn
 *   while `GET /me` failed without answering — whose state it would be is unknown, the rule of a
 *   failed read below — and a placeholder while it is read.
 * - Signed in, a placeholder until the state's first read answers, then the toggle — and the
 *   toggle from then on: a later read is never a reason to take it away. TanStack puts an entry
 *   with no data back to `pending` whenever it is read again (a refocus, the read after a press),
 *   so `isPending` would swap the toggle for the placeholder while it holds the keyboard focus
 *   and drop the focus with it; `isFetched` stays true through those reads.
 * - A read that FAILED before any read succeeded leaves the state unknown, and the button is not
 *   drawn at all until a read succeeds (owner decision 2026-10-16, ADR-0064): a toggle drawn
 *   unpressed would tell a member who came to unwatch that the market is not watched. TanStack
 *   reads the entry again on a refocus or a reconnect, and the first answer brings the toggle.
 *   A refetch that fails AFTER a success keeps the data it had (TanStack keeps `data` on a
 *   failed refetch), so a toggle on screen is never taken away by a later failure.
 * - While a press is on the wire the toggle shows where it is going (the optimistic state) and a
 *   second press waits: two writes in flight could land in either order and leave the screen and
 *   the server disagreeing.
 */
export function watchButtonView(input: WatchButtonInput): WatchButtonView {
  if (input.sessionPending) return { kind: 'placeholder' };
  if (!input.signedIn) return { kind: 'toggle', pressed: false, press: 'login' };
  if (input.profileFailed) return { kind: 'hidden' };
  if (!input.state.isFetched) return { kind: 'placeholder' };
  if (input.state.data === undefined) return { kind: 'hidden' };
  const pressed = input.state.data.watched;
  if (input.saving) return { kind: 'toggle', pressed, press: 'wait' };
  return { kind: 'toggle', pressed, press: pressed ? 'unwatch' : 'watch' };
}

/** What a press asks for: the login page, or the state to send (`PUT /me/watchlist/:id`). */
export type WatchPressAction = { kind: 'login' } | { kind: 'put'; watched: boolean };

/**
 * What a press of the toggle does, from its `press`; `null` sends nothing. The component only
 * dispatches it, so the rule that a press while one is on the wire sends nothing is reachable
 * here: were `wait` read as "not `watch`", the second click of a double-click on 관심 등록 would
 * send an unwatch behind the watch.
 */
export function watchPressAction(press: WatchPress): WatchPressAction | null {
  switch (press) {
    case 'wait':
      return null;
    case 'login':
      return { kind: 'login' };
    case 'watch':
      return { kind: 'put', watched: true };
    case 'unwatch':
      return { kind: 'put', watched: false };
  }
}

/**
 * The toast of a press that failed. The optimistic state has been rolled back by then
 * (`updateWatchOptions`), so it says which change did not happen. A refusal as another account
 * (the cookie is somebody else's now, A-PG-24) says that instead, as the verification and the time
 * zone do; the hook has asked for the session again, and SessionCacheGuard puts the real account
 * on screen.
 */
export function watchFailureMessage(error: unknown, watched: boolean): string {
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  return watched ? copy.watchAddFailed : copy.watchRemoveFailed;
}

/**
 * What MY's 관심 시장 body draws from the pages it has (`WatchlistBody`): every row of the tab with
 * its 더 보기 while there is a next page — no cap (ADR-0061 decision 3), so the button is the only
 * way to a member's later watches — or, for the `/my` preview (`limit`, MY_PREVIEW_ROWS), the
 * newest `limit` rows and no 더 보기: the preview's way to the rest is its 전체 보기 to the tab
 * (ADR-0054 decision 2), and the summary must not grow into the tab.
 */
export function watchlistRows<Row>(
  pages: readonly { items: readonly Row[] }[] | undefined,
  hasNextPage: boolean,
  limit: number | undefined,
): { rows: Row[]; more: boolean } {
  const rows = (pages ?? []).flatMap((page) => page.items).slice(0, limit);
  return { rows, more: limit === undefined && hasNextPage };
}
