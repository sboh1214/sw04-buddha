import {
  type AnchorLike,
  type FormLike,
  type LeaveGuard,
  type LeaveGuardHost,
  createLeaveGuard,
  numberHistoryEntries,
} from './leave-guard';

/** The Navigation API's part the guard reads (not in every browser, nor in TypeScript's DOM lib). */
interface WithNavigation {
  navigation?: { currentEntry?: { index: number } | null };
}

/**
 * The window as `createLeaveGuard` reads it: the DOM reading stays here, the decisions there. Where
 * the browser has no Navigation API, its history entries are numbered from here on
 * (`numberHistoryEntries` — before the guard's own listeners, so an entry's number is known before
 * the guard reads it).
 */
function windowHost(): LeaveGuardHost {
  const navigation = (window as WithNavigation).navigation;
  const listen: LeaveGuardHost['addEventListener'] = (type, listener, capture) => {
    window.addEventListener(type, listener, capture);
  };
  const numbered =
    navigation === undefined
      ? numberHistoryEntries(window.history, { addEventListener: listen })
      : undefined;
  return {
    location: window.location,
    history: window.history,
    addEventListener: listen,
    removeEventListener: (type, listener, capture) => {
      window.removeEventListener(type, listener, capture);
    },
    confirm: (message) => window.confirm(message),
    historyIndex: numbered ?? (() => navigation?.currentEntry?.index),
    replayPopState: (state) => {
      window.dispatchEvent(new PopStateEvent('popstate', { state }));
    },
    anchorOf: (event): AnchorLike | null => {
      const target = event.target;
      if (!(target instanceof Element)) return null;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return null;
      return {
        href: anchor.href,
        target: anchor.target,
        download: anchor.hasAttribute('download'),
      };
    },
    formOf: (event): FormLike | null => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return null;
      return {
        action: form.getAttribute('action'),
        method: form.getAttribute('method'),
        target: form.getAttribute('target'),
      };
    },
  };
}

/** Where the window's one guard is kept: on the window, so every bundle that asks gets the same. */
const GUARD = Symbol.for('buddha.leaveGuard');

/**
 * The window's leave guard (lib/leave-guard.ts), made — and its listeners added — on the first
 * call. src/instrumentation-client.ts makes that call before the app hydrates, which is what puts
 * its `popstate` listener ahead of the App Router's; a screen that asks later gets the same guard.
 * Browser only.
 */
export function windowLeaveGuard(): LeaveGuard {
  const holder = window as unknown as { [GUARD]?: LeaveGuard };
  holder[GUARD] ??= createLeaveGuard(windowHost());
  return holder[GUARD];
}
