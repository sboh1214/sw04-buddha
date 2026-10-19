/**
 * Asking before a draft is lost (owner decision 2026-10-19, ADR-0073: «쓰던 글에서 나갈 때 →
 * 나가기 전에 묻는다»). The write and edit screens of a post hold a draft nothing else keeps; while
 * it holds something, leaving the screen asks first:
 *
 * - closing the tab, reloading, typing an address, or going back or forward to another document:
 *   the browser's own `beforeunload` dialog (a page may not word it);
 * - a click on a link that takes this tab elsewhere — a Next.js `<Link>` or any other anchor — and
 *   a form that navigates (the header's search, `next/form` with an `action`): our `confirm`,
 *   asked in the capture phase on `window`, ahead of React's listener on its root, so a refusal
 *   stops the event before `<Link>` or `next/form` ever sees it;
 * - the back and forward buttons within the app (`popstate`): the browser has already moved the
 *   address by then, so the guard holds the event back from the App Router (its listener is added
 *   before the router's and runs first — `createLeaveGuard` says why that takes installing it
 *   before hydration — and `stopImmediatePropagation` keeps the router's from running), asks, and
 *   either hands the event on to the router (`replayPopState`) or moves the address back to the
 *   page (`history.go`) — by the distance between the two entries' indexes: the Navigation API's,
 *   or where a browser has none, the ones `numberHistoryEntries` writes into each entry's state. A
 *   move whose distance cannot be measured is not held, and nothing is asked: the guard could not
 *   take the address back to the page, and a screen that no longer matched its address would be
 *   worse than the draft lost.
 *
 * No history entry is added: pushing a duplicate entry to catch the back button (the usual trap)
 * leaves that entry behind for every later Back, and Chrome skips entries pushed without a user
 * gesture anyway. Navigations the screen makes itself (`router.push` after a save, the write
 * screen's `router.replace` of its market) are neither clicks nor `popstate`, so they pass.
 *
 * The logic is here, against a `LeaveGuardHost` — the window, as far as the guard reads it — so it
 * is tested without a browser (leave-guard.test.ts); lib/leave-guard-window.ts binds it to the
 * window, src/instrumentation-client.ts installs it, and hooks/use-leave-guard.ts is how a screen
 * says what it would lose.
 */

/** What of a click decides whether it navigates this tab. */
export interface ClickLike {
  readonly defaultPrevented: boolean;
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** What of the anchor a click landed in decides where it goes. */
export interface AnchorLike {
  /** The resolved address (`HTMLAnchorElement.href`). */
  readonly href: string;
  readonly target: string;
  readonly download: boolean;
}

/** What of a submitted form decides whether it navigates (its attributes, not the properties). */
export interface FormLike {
  /** The `action` attribute: null when the form has none, which submits in place. */
  readonly action: string | null;
  readonly method: string | null;
  readonly target: string | null;
}

/** The page's address without its fragment: a jump within the page is no leaving. */
function withoutHash(href: string): string {
  const hash = href.indexOf('#');
  return hash < 0 ? href : href.slice(0, hash);
}

/** Whether two addresses are the same page (the fragment aside). */
export function isSamePage(a: string, b: string): boolean {
  return withoutHash(a) === withoutHash(b);
}

/** Whether a link or form `target` opens in this tab. */
function opensHere(target: string | null): boolean {
  return target === null || target === '' || target.toLowerCase() === '_self';
}

/**
 * Where a click on `anchor` takes this tab, or null when it does not leave the page: a click the
 * page already handled, another button than the main one, a modifier (a new tab or window, a
 * download), a link to another tab, a download, an address that is not http(s) (`mailto:`), or the
 * page itself (a fragment).
 */
export function linkDestination(click: ClickLike, anchor: AnchorLike, here: string): string | null {
  if (click.defaultPrevented || click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if (!opensHere(anchor.target) || anchor.download) return null;
  let url: URL;
  try {
    url = new URL(anchor.href, here);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (isSamePage(url.href, here)) return null;
  return url.href;
}

/**
 * Where a submitted form takes this tab, or null when it stays: a form with no `action` submits in
 * place (the screen's own forms — the post form, the market picker — have none and handle their
 * submit), a dialog form closes a dialog, and a form aimed at another tab leaves this one alone.
 */
export function formDestination(form: FormLike, here: string): string | null {
  if (form.action === null) return null;
  if ((form.method ?? '').toLowerCase() === 'dialog' || !opensHere(form.target)) return null;
  try {
    return new URL(form.action, here).href;
  } catch {
    return null;
  }
}

/** The window, as far as the guard reads and drives it. */
export interface LeaveGuardHost {
  readonly location: { readonly href: string };
  readonly history: { go(delta: number): void };
  addEventListener(type: string, listener: (event: Event) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (event: Event) => void, capture: boolean): void;
  confirm(message: string): boolean;
  /**
   * The index of the current history entry within the document: the Navigation API's, or where the
   * browser has none, `numberHistoryEntries`'s; undefined when the entry has none.
   */
  historyIndex(): number | undefined;
  /** Hands a `popstate` the guard held back to the app's router, as if it had not been held. */
  replayPopState(state: unknown): void;
  /** The anchor a click landed in, if any. */
  anchorOf(event: Event): AnchorLike | null;
  /** The form a submit came from, if any. */
  formOf(event: Event): FormLike | null;
}

export interface LeaveGuard {
  /**
   * What leaving would lose now: the question to ask, or null when there is nothing to lose — which
   * also ends a leave the writer allowed, so the next draft is guarded afresh.
   */
  ask(message: string | null): void;
  /**
   * Notes the page's address and history entry, after every render of the screen: its own
   * `router.replace` moves them without leaving it. Nothing once a leave was allowed — the router
   * may still be loading the destination while the page renders again — nor while the guard is
   * taking the address back to the page: until that move lands the address is the entry the writer
   * refused, which is not the page.
   */
  sync(): void;
  dispose(): void;
}

const EVENTS = ['click', 'submit', 'popstate', 'beforeunload', 'pageshow'] as const;

/**
 * One guard for the window, installed before the app hydrates (instrumentation-client.ts), so its
 * `popstate` listener is registered — and runs — ahead of the App Router's: Chromium calls the
 * listeners of `window` in the order they were added, capture or not, and the router re-renders
 * synchronously inside its own, unmounting the screen (and a listener the screen added) before a
 * later listener would see the event. The screens tell it what they would lose (`ask`).
 */
export function createLeaveGuard(host: LeaveGuardHost): LeaveGuard {
  let message: string | null = null;
  /** A leave was allowed: nothing more is asked until there is nothing to lose. */
  let leaving = false;
  /** The `popstate` of the guard's own `history.go` back to the page, still to come. */
  let reverting = false;
  /** The guard is handing a held `popstate` to the router. */
  let replaying = false;
  let pageHref = host.location.href;
  let pageIndex = host.historyIndex();

  /** Asks; true when the writer chose to leave (and then nothing more is asked). */
  const allowLeave = (question: string): boolean => {
    if (!host.confirm(question)) return false;
    leaving = true;
    return true;
  };
  const refuse = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const listeners: Record<(typeof EVENTS)[number], (event: Event) => void> = {
    click(event) {
      if (message === null || leaving) return;
      const anchor = host.anchorOf(event);
      if (anchor === null) return;
      if (linkDestination(event as unknown as ClickLike, anchor, host.location.href) === null) {
        return;
      }
      if (!allowLeave(message)) refuse(event);
    },
    submit(event) {
      if (message === null || leaving || event.defaultPrevented) return;
      const form = host.formOf(event);
      if (form === null || formDestination(form, host.location.href) === null) return;
      if (!allowLeave(message)) refuse(event);
    },
    popstate(event) {
      if (replaying) return;
      if (reverting) {
        reverting = false;
        // Back on the page: the router never moved, so it must not move now either.
        if (isSamePage(host.location.href, pageHref)) {
          event.stopImmediatePropagation();
          return;
        }
        // Elsewhere: the move back never came, or another overtook it — a move of its own.
      }
      if (message === null || leaving || isSamePage(host.location.href, pageHref)) return;
      const now = host.historyIndex();
      // How far the browser moved, or nothing held: without it the address could not come back.
      if (now === undefined || pageIndex === undefined) return;
      const delta = now - pageIndex;
      event.stopImmediatePropagation();
      if (allowLeave(message)) {
        replaying = true;
        try {
          host.replayPopState((event as PopStateEvent).state);
        } finally {
          replaying = false;
        }
        return;
      }
      if (delta !== 0) {
        reverting = true;
        host.history.go(-delta);
      }
    },
    beforeunload(event) {
      if (message === null || leaving) return;
      // `preventDefault` is the standard ask; `returnValue` is what older browsers read.
      event.preventDefault();
      (event as unknown as { returnValue: string }).returnValue = '';
    },
    pageshow(event) {
      // Restored from the back-forward cache after a leave it allowed: the draft is on screen again.
      if ((event as PageTransitionEvent).persisted) leaving = false;
    },
  };

  for (const type of EVENTS) host.addEventListener(type, listeners[type], true);

  return {
    ask(next) {
      message = next;
      if (next === null) {
        // The screen is gone: what it allowed or was waiting for is over.
        leaving = false;
        reverting = false;
      }
    },
    sync() {
      if (leaving || reverting) return;
      pageHref = host.location.href;
      pageIndex = host.historyIndex();
    },
    dispose() {
      for (const type of EVENTS) host.removeEventListener(type, listeners[type], true);
    },
  };
}

/** The part of the window's `History` that `numberHistoryEntries` numbers the entries through. */
export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/** Where an entry's state carries its index (beside the App Router's own `__NA` and tree). */
export const ENTRY_INDEX_KEY = '__buddhaEntryIndex';

function isStateObject(state: unknown): state is Record<string, unknown> {
  return typeof state === 'object' && state !== null && !Array.isArray(state);
}

/** The index `numberHistoryEntries` wrote into an entry's state, if it wrote one. */
export function entryIndexOf(state: unknown): number | undefined {
  if (!isStateObject(state)) return undefined;
  const index = state[ENTRY_INDEX_KEY];
  return typeof index === 'number' && Number.isInteger(index) ? index : undefined;
}

/**
 * Where the browser has no Navigation API (older Safari and Firefox — an iPhone that cannot update
 * keeps its Safari), the guard's measure of how far Back or Forward moved: every history entry this
 * document makes is numbered in its own state, one more than the entry it was pushed from, so the
 * entry a `popstate` arrives at names its distance from the page. Installed with the guard, before the app hydrates — the App
 * Router's own `pushState`/`replaceState` (and its wrapping of them) go through these, and it keeps
 * what else an entry's state holds when it replaces it after a traversal.
 *
 * Only a state that is an object is numbered: the router reloads the page for an entry whose state
 * is an object without its own mark, and a fragment link's entry has none (null). An entry it
 * cannot number — and the entries pushed while it stands on one — have no index, and the guard
 * does not hold a move to them. Entries of earlier documents need none: going back to them loads a
 * document, which `beforeunload` covers. Answers the current entry's index.
 */
export function numberHistoryEntries(
  history: HistoryLike,
  target: Pick<LeaveGuardHost, 'addEventListener'>,
): () => number | undefined {
  /** The index of the entry the browser is on, as far as this document knows it. */
  let current: number | undefined = entryIndexOf(history.state) ?? 0;
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  const numbered = (data: unknown, index: number | undefined): unknown =>
    index !== undefined && isStateObject(data) ? { ...data, [ENTRY_INDEX_KEY]: index } : data;

  history.pushState = (data, unused, url) => {
    current = current === undefined ? undefined : current + 1;
    push(numbered(data, current), unused, url);
  };
  history.replaceState = (data, unused, url) => {
    replace(numbered(data, current), unused, url);
  };
  // The entry the document opened on, where its state is already the router's (a reload).
  if (isStateObject(history.state) && entryIndexOf(history.state) === undefined) {
    replace(numbered(history.state, current), '');
  }
  // A traversal lands on a numbered entry, or on one with no number — a fragment link's, which the
  // browser made without a push — from which nothing pushed can be numbered either.
  const arrived = () => {
    current = entryIndexOf(history.state);
  };
  target.addEventListener('popstate', arrived, true);
  target.addEventListener('hashchange', arrived, true);
  return () => entryIndexOf(history.state);
}
