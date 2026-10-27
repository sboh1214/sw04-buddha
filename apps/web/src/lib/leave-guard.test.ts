import { describe, expect, it } from 'vitest';
import {
  type AnchorLike,
  type ClickLike,
  ENTRY_INDEX_KEY,
  type FormLike,
  type HistoryLike,
  type LeaveGuardHost,
  createLeaveGuard,
  entryIndexOf,
  formDestination,
  isSamePage,
  linkDestination,
  numberHistoryEntries,
} from './leave-guard';

/**
 * The guard that asks before a draft is lost (owner decision 2026-10-19, ADR-0073), against a
 * window made of an EventTarget and a list of history entries. The "router" below is a listener
 * added after the guard — as the App Router's `popstate` listener is added after the guard that
 * src/instrumentation-client.ts installs before hydration, and React's click and submit listeners
 * sit on its root below `window` — so it sees exactly what the guard lets through.
 */

const ORIGIN = 'https://buddha.test';
const WRITE = `${ORIGIN}/community/write?market=m1`;
const LIST = `${ORIGIN}/community`;
const HOME = `${ORIGIN}/`;
const MARKET = `${ORIGIN}/markets/a`;
const MESSAGE = '쓰던 내용이 사라집니다. 나갈까요?';

const PLAIN_CLICK: ClickLike = {
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};

class FakeWindow implements LeaveGuardHost {
  readonly target = new EventTarget();
  readonly entries: { href: string; state: unknown }[];
  index: number;
  /** False for a browser without the Navigation API. */
  navigationApi = true;
  /** Without it, the entries' numbers (`numberHistoryEntries`), once installed (`numberEntries`). */
  numbered: (() => number | undefined) | undefined;
  /**
   * Whether `history.go` waits for `flushGo`, as a browser's traversal lands in a later task (the
   * page can render in between); the default lands at once.
   */
  deferGo = false;
  readonly pendingGo: number[] = [];
  /** What `confirm` answers, in order; an unexpected question fails the test. */
  answers: boolean[] = [];
  readonly asked: string[] = [];
  readonly replayed: unknown[] = [];
  /** Every `popstate` that reached the router, by the address it saw. */
  readonly routed: string[] = [];
  readonly clicked: string[] = [];
  readonly submitted: string[] = [];
  anchor: AnchorLike | null = null;
  form: FormLike | null = null;

  constructor(entries: string[], index = entries.length - 1) {
    this.entries = entries.map((href, i) => ({ href, state: { entry: i } }));
    this.index = index;
  }

  /** Registers the router's listeners: call after the guard is made, as the page does. */
  mountRouter(): void {
    this.target.addEventListener('popstate', () => {
      this.routed.push(this.location.href);
    });
    this.target.addEventListener('click', () => {
      this.clicked.push(this.location.href);
    });
    this.target.addEventListener('submit', () => {
      this.submitted.push(this.location.href);
    });
  }

  get location() {
    return { href: this.entries[this.index]!.href };
  }

  readonly history: HistoryLike & { go(delta: number): void } = createFakeHistory(this);

  /** The browser has no Navigation API, and the entries are numbered from here on. */
  numberEntries(): void {
    this.navigationApi = false;
    this.numbered = numberHistoryEntries(this.history, this);
  }

  /** Lands the traversals `history.go` queued (`deferGo`). */
  flushGo(): void {
    for (const delta of this.pendingGo.splice(0)) this.traverse(delta);
  }

  /** A link to a fragment of the page: an entry the browser makes itself, its state null. */
  fragment(href: string): void {
    this.entries.splice(this.index + 1, Infinity, { href, state: null });
    this.index += 1;
    this.target.dispatchEvent(popState(null));
    this.target.dispatchEvent(new Event('hashchange'));
  }

  // As objects: Node's EventTarget reads a boolean `capture` on add and not on remove.
  addEventListener(type: string, listener: (event: Event) => void, capture: boolean): void {
    this.target.addEventListener(type, listener, { capture });
  }

  removeEventListener(type: string, listener: (event: Event) => void, capture: boolean): void {
    this.target.removeEventListener(type, listener, { capture });
  }

  confirm(message: string): boolean {
    this.asked.push(message);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error(`asked without an answer: ${message}`);
    return answer;
  }

  historyIndex(): number | undefined {
    return this.navigationApi ? this.index : this.numbered?.();
  }

  replayPopState(state: unknown): void {
    this.replayed.push(state);
    this.target.dispatchEvent(popState(state));
  }

  anchorOf(): AnchorLike | null {
    return this.anchor;
  }

  formOf(): FormLike | null {
    return this.form;
  }

  /** The browser's back or forward within the document: the address moves, then `popstate`. */
  traverse(delta: number): void {
    this.index += delta;
    this.target.dispatchEvent(popState(this.entries[this.index]!.state));
  }

  /** A click on `href` in this tab. */
  click(href: string, extra: Partial<ClickLike> & { target?: string } = {}): Event {
    const { target = '', ...click } = extra;
    this.anchor = { href, target, download: false };
    // `defaultPrevented` is the event's own; the rest are what a mouse event carries.
    const { defaultPrevented: _, ...keys } = { ...PLAIN_CLICK, ...click };
    const event = Object.assign(new Event('click', { cancelable: true }), keys);
    this.target.dispatchEvent(event);
    return event;
  }

  submit(form: FormLike): Event {
    this.form = form;
    const event = new Event('submit', { cancelable: true });
    this.target.dispatchEvent(event);
    return event;
  }

  unload(): Event {
    const event = new Event('beforeunload', { cancelable: true });
    this.target.dispatchEvent(event);
    return event;
  }
}

function popState(state: unknown): Event {
  return Object.assign(new Event('popstate'), { state });
}

/** The window's `History` over the fake's entries: `go` traverses, the other two write entries. */
function createFakeHistory(win: FakeWindow): HistoryLike & { go(delta: number): void } {
  return {
    get state() {
      return win.entries[win.index]!.state;
    },
    go(delta) {
      if (win.deferGo) win.pendingGo.push(delta);
      else win.traverse(delta);
    },
    pushState(data, _unused, url) {
      const href = url === undefined || url === null ? win.location.href : String(url);
      win.entries.splice(win.index + 1, Infinity, { href, state: data });
      win.index += 1;
    },
    replaceState(data, _unused, url) {
      const href = url === undefined || url === null ? win.location.href : String(url);
      win.entries[win.index] = { href, state: data };
    },
  };
}

/** The write screen opened from the list (one document), its guard made, the router mounted. */
function writeScreen(entries = [LIST, WRITE]) {
  const win = new FakeWindow(entries);
  const guard = createLeaveGuard(win);
  win.mountRouter();
  return { win, guard };
}

describe('linkDestination', () => {
  it('names where a plain click on a link takes this tab', () => {
    expect(linkDestination(PLAIN_CLICK, { href: '/', target: '', download: false }, WRITE)).toBe(
      HOME,
    );
    expect(
      linkDestination(
        PLAIN_CLICK,
        { href: `${LIST}?q=a`, target: '_self', download: false },
        WRITE,
      ),
    ).toBe(`${LIST}?q=a`);
    // Another site in this tab leaves the page too.
    expect(
      linkDestination(
        PLAIN_CLICK,
        { href: 'https://example.com/a', target: '', download: false },
        WRITE,
      ),
    ).toBe('https://example.com/a');
    // The same screen with another query is another page (another market's write screen).
    expect(
      linkDestination(
        PLAIN_CLICK,
        { href: '/community/write', target: '', download: false },
        WRITE,
      ),
    ).toBe(`${ORIGIN}/community/write`);
  });

  it('is null for a click that leaves this tab where it is', () => {
    const link: AnchorLike = { href: HOME, target: '', download: false };
    expect(linkDestination({ ...PLAIN_CLICK, defaultPrevented: true }, link, WRITE)).toBeNull();
    expect(linkDestination({ ...PLAIN_CLICK, button: 1 }, link, WRITE)).toBeNull();
    for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      expect(linkDestination({ ...PLAIN_CLICK, [key]: true }, link, WRITE)).toBeNull();
    }
    expect(linkDestination(PLAIN_CLICK, { ...link, target: '_blank' }, WRITE)).toBeNull();
    expect(linkDestination(PLAIN_CLICK, { ...link, download: true }, WRITE)).toBeNull();
    expect(
      linkDestination(PLAIN_CLICK, { href: 'mailto:a@b.test', target: '', download: false }, WRITE),
    ).toBeNull();
    // A fragment of the page itself.
    expect(
      linkDestination(PLAIN_CLICK, { href: `${WRITE}#body`, target: '', download: false }, WRITE),
    ).toBeNull();
  });
});

describe('formDestination', () => {
  it('names where a form with an action goes, as the header search does', () => {
    expect(formDestination({ action: '/search', method: null, target: null }, WRITE)).toBe(
      `${ORIGIN}/search`,
    );
    expect(formDestination({ action: '/search', method: 'GET', target: '_self' }, WRITE)).toBe(
      `${ORIGIN}/search`,
    );
  });

  it('is null for a form that submits in place, closes a dialog or aims at another tab', () => {
    // The post form and the market picker have no action: they handle their submit themselves.
    expect(formDestination({ action: null, method: null, target: null }, WRITE)).toBeNull();
    expect(formDestination({ action: '/x', method: 'dialog', target: null }, WRITE)).toBeNull();
    expect(formDestination({ action: '/x', method: null, target: '_blank' }, WRITE)).toBeNull();
  });
});

describe('isSamePage', () => {
  it('ignores the fragment and nothing else', () => {
    expect(isSamePage(WRITE, `${WRITE}#x`)).toBe(true);
    expect(isSamePage(WRITE, `${ORIGIN}/community/write?market=m2`)).toBe(false);
  });
});

describe('createLeaveGuard', () => {
  it('asks nothing while the form holds nothing to lose', () => {
    const { win } = writeScreen();
    win.click('/');
    win.submit({ action: '/search', method: null, target: null });
    expect(win.unload().defaultPrevented).toBe(false);
    win.traverse(-1);
    expect(win.asked).toEqual([]);
    expect(win.clicked).toHaveLength(1);
    expect(win.submitted).toHaveLength(1);
    expect(win.routed).toEqual([LIST]);
  });

  it('asks before a link leaves: refused, the click never reaches the router', () => {
    const { win, guard } = writeScreen();
    guard.ask(MESSAGE);
    win.answers = [false];
    const refused = win.click('/');
    expect(win.asked).toEqual([MESSAGE]);
    expect(refused.defaultPrevented).toBe(true);
    expect(win.clicked).toEqual([]);

    // Allowed: the click goes on to the router, and nothing more is asked on the way out.
    win.answers = [true];
    const allowed = win.click('/');
    expect(allowed.defaultPrevented).toBe(false);
    expect(win.clicked).toEqual([WRITE]);
    expect(win.unload().defaultPrevented).toBe(false);
    expect(win.asked).toEqual([MESSAGE, MESSAGE]);
  });

  it('lets a click through unasked when it does not leave the page', () => {
    const { win, guard } = writeScreen();
    guard.ask(MESSAGE);
    win.click('/', { metaKey: true });
    win.click('/', { target: '_blank' });
    win.click(`${WRITE}#top`);
    expect(win.asked).toEqual([]);
    expect(win.clicked).toHaveLength(3);
  });

  it('asks before a navigating form, and never for the screen’s own forms', () => {
    const { win, guard } = writeScreen();
    guard.ask(MESSAGE);
    win.submit({ action: null, method: null, target: null });
    expect(win.asked).toEqual([]);
    win.answers = [false];
    const refused = win.submit({ action: '/search', method: null, target: null });
    expect(refused.defaultPrevented).toBe(true);
    expect(win.submitted).toHaveLength(1);
    win.answers = [true];
    win.submit({ action: '/search', method: null, target: null });
    expect(win.submitted).toHaveLength(2);
    expect(win.asked).toEqual([MESSAGE, MESSAGE]);
  });

  it('asks on Back: refused, the router never moves and the address returns to the page', () => {
    const { win, guard } = writeScreen();
    guard.sync();
    guard.ask(MESSAGE);
    win.answers = [false];
    win.traverse(-1);
    expect(win.asked).toEqual([MESSAGE]);
    // The guard went forward again by the step Back took; neither popstate reached the router.
    expect(win.location.href).toBe(WRITE);
    expect(win.routed).toEqual([]);
    // And it still guards.
    win.answers = [false];
    win.traverse(-1);
    expect(win.asked).toEqual([MESSAGE, MESSAGE]);
    expect(win.location.href).toBe(WRITE);
  });

  it('hands an allowed Back to the router, with the state the browser gave', () => {
    const { win, guard } = writeScreen();
    guard.sync();
    guard.ask(MESSAGE);
    win.answers = [true];
    win.traverse(-1);
    expect(win.replayed).toEqual([{ entry: 0 }]);
    expect(win.routed).toEqual([LIST]);
    expect(win.location.href).toBe(LIST);
  });

  it('measures a jump of several entries, and Forward, by the Navigation API’s index', () => {
    const { win, guard } = writeScreen([HOME, LIST, WRITE, `${ORIGIN}/markets/a`]);
    win.index = 2;
    guard.sync();
    guard.ask(MESSAGE);
    win.answers = [false, false];
    win.traverse(-2);
    expect(win.location.href).toBe(WRITE);
    win.traverse(1);
    expect(win.location.href).toBe(WRITE);
    expect(win.asked).toEqual([MESSAGE, MESSAGE]);
    expect(win.routed).toEqual([]);
  });

  it('measures Back, a jump and Forward by the entries’ own numbers where the browser has no Navigation API', () => {
    // The document opens on the home screen; the router pushes the list, the write screen and a
    // market; the writer comes back to the write screen.
    const win = new FakeWindow([HOME]);
    win.numberEntries();
    for (const href of [LIST, WRITE, MARKET]) win.history.pushState({ __NA: true }, '', href);
    win.traverse(-1);
    const guard = createLeaveGuard(win);
    win.mountRouter();
    guard.sync();
    guard.ask(MESSAGE);
    win.answers = [false, false, false];
    win.traverse(-1);
    expect(win.location.href).toBe(WRITE);
    win.traverse(-2);
    expect(win.location.href).toBe(WRITE);
    // Forward, to the last entry: back by one, not further forward (there is nothing further).
    win.traverse(1);
    expect(win.location.href).toBe(WRITE);
    expect(win.asked).toEqual([MESSAGE, MESSAGE, MESSAGE]);
    expect(win.routed).toEqual([]);
    // And allowed, the router takes the move.
    win.answers = [true];
    win.traverse(-1);
    expect(win.routed).toEqual([LIST]);
  });

  it('holds no move whose distance it cannot measure: nothing asked, the router takes it', () => {
    const { win, guard } = writeScreen();
    // No Navigation API and no numbers: the address could not be brought back.
    win.navigationApi = false;
    guard.sync();
    guard.ask(MESSAGE);
    win.traverse(-1);
    expect(win.asked).toEqual([]);
    expect(win.routed).toEqual([LIST]);
  });

  it('keeps the page while its move back is on the way, so the next Back still asks', () => {
    const { win, guard } = writeScreen();
    guard.sync();
    guard.ask(MESSAGE);
    win.deferGo = true;
    win.answers = [false];
    win.traverse(-1);
    expect(win.location.href).toBe(LIST);
    // The screen renders before the browser lands the move back (an upload ending while asked).
    guard.sync();
    win.flushGo();
    expect(win.location.href).toBe(WRITE);
    expect(win.routed).toEqual([]);
    win.answers = [false];
    win.traverse(-1);
    expect(win.asked).toEqual([MESSAGE, MESSAGE]);
    win.flushGo();
    expect(win.location.href).toBe(WRITE);
    expect(win.routed).toEqual([]);
  });

  it('takes a move for one of its own when the move back never came', () => {
    const { win, guard } = writeScreen([HOME, LIST, WRITE]);
    guard.sync();
    guard.ask(MESSAGE);
    win.deferGo = true;
    win.answers = [false];
    win.traverse(-1);
    // The browser never lands it; the writer goes back again — asked, not swallowed.
    win.pendingGo.length = 0;
    win.answers = [false];
    win.traverse(-1);
    expect(win.asked).toEqual([MESSAGE, MESSAGE]);
    win.flushGo();
    expect(win.location.href).toBe(WRITE);
    expect(win.routed).toEqual([]);
  });

  it('forgets a move back that never came once the screen is gone', () => {
    const win = new FakeWindow([LIST, WRITE, HOME], 1);
    const guard = createLeaveGuard(win);
    win.mountRouter();
    guard.sync();
    guard.ask(MESSAGE);
    win.deferGo = true;
    win.answers = [false];
    win.traverse(1);
    win.pendingGo.length = 0;
    // The screen is gone; a later Back onto its old entry is the router's.
    guard.ask(null);
    win.traverse(-1);
    expect(win.routed).toEqual([WRITE]);
  });

  it('follows the page through its own replace, and lets an entry of the same page pass', () => {
    const { win, guard } = writeScreen([LIST, WRITE, `${WRITE}#a`]);
    guard.ask(MESSAGE);
    // The write screen's `router.replace` of its market: the same entry, another address.
    const moved = `${ORIGIN}/community/write?market=m2`;
    win.entries[2] = { href: moved, state: { entry: 2 } };
    guard.sync();
    win.answers = [false];
    win.traverse(-1);
    expect(win.asked).toEqual([MESSAGE]);
    expect(win.location.href).toBe(moved);
    // A fragment of the page is the page.
    win.entries[1] = { href: `${moved}#x`, state: { entry: 1 } };
    win.traverse(-1);
    expect(win.asked).toEqual([MESSAGE]);
    expect(win.routed).toEqual([`${moved}#x`]);
  });

  it('asks the browser before the document is unloaded, while there is something to lose', () => {
    const { win, guard } = writeScreen();
    guard.ask(MESSAGE);
    expect(win.unload().defaultPrevented).toBe(true);
    guard.ask(null);
    expect(win.unload().defaultPrevented).toBe(false);
  });

  it('guards again after the back-forward cache brings the page back', () => {
    const { win, guard } = writeScreen();
    guard.ask(MESSAGE);
    win.answers = [true];
    win.click('/');
    expect(win.unload().defaultPrevented).toBe(false);
    win.target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(win.unload().defaultPrevented).toBe(true);
  });

  it('lasts an allowed leave until nothing is asked, then guards the next draft', () => {
    const { win, guard } = writeScreen();
    guard.ask(MESSAGE);
    win.answers = [true];
    win.click('/');
    // The screen is still rendering while the router loads the destination: nothing is asked.
    guard.sync();
    win.click('/');
    expect(win.asked).toEqual([MESSAGE]);
    // The screen is gone (nothing to lose), and a new draft on another screen is guarded.
    guard.ask(null);
    guard.ask(MESSAGE);
    win.answers = [false];
    expect(win.click('/').defaultPrevented).toBe(true);
    expect(win.asked).toEqual([MESSAGE, MESSAGE]);
  });

  it('stops listening once disposed', () => {
    const { win, guard } = writeScreen();
    guard.ask(MESSAGE);
    guard.dispose();
    win.click('/');
    win.traverse(-1);
    expect(win.unload().defaultPrevented).toBe(false);
    expect(win.asked).toEqual([]);
    expect(win.routed).toEqual([LIST]);
  });
});

describe('numberHistoryEntries', () => {
  it('numbers each entry one past the one it was pushed from, keeping what else its state holds', () => {
    const win = new FakeWindow([HOME]);
    const index = numberHistoryEntries(win.history, win);
    // The entry the document opened on, its state already an object (a reload): numbered at once.
    expect(index()).toBe(0);
    expect(win.history.state).toEqual({ entry: 0, [ENTRY_INDEX_KEY]: 0 });
    win.history.pushState({ __NA: true, tree: 'a' }, '', LIST);
    expect(win.history.state).toEqual({ __NA: true, tree: 'a', [ENTRY_INDEX_KEY]: 1 });
    // The router replaces an entry's state with a fresh one of its own: the number stays.
    win.history.replaceState({ __NA: true, tree: 'b' }, '', WRITE);
    expect(index()).toBe(1);
    expect(win.location.href).toBe(WRITE);
    win.history.pushState({ __NA: true }, '', MARKET);
    expect(index()).toBe(2);
    // Back two, then a push: it takes the place of the entries ahead, and the next number.
    win.traverse(-2);
    expect(index()).toBe(0);
    win.history.pushState({ __NA: true }, '', LIST);
    expect(index()).toBe(1);
    expect(win.entries.map((entry) => entryIndexOf(entry.state))).toEqual([0, 1]);
  });

  it('numbers the first entry when the router first writes its state, and no state that is not an object', () => {
    const win = new FakeWindow([HOME]);
    win.entries[0]!.state = null;
    const index = numberHistoryEntries(win.history, win);
    // A fresh document: null until the router hydrates and writes its own.
    expect(win.history.state).toBeNull();
    expect(index()).toBeUndefined();
    win.history.replaceState({ __NA: true }, '', HOME);
    expect(index()).toBe(0);
    // The router reloads the page for an object state without its mark: a null stays null.
    win.history.pushState(null, '', LIST);
    expect(win.history.state).toBeNull();
    expect(index()).toBeUndefined();
  });

  it('numbers nothing from an entry the browser made itself, until a traversal lands on a numbered one', () => {
    const win = new FakeWindow([HOME]);
    const index = numberHistoryEntries(win.history, win);
    win.history.pushState({ __NA: true }, '', WRITE);
    win.fragment(`${WRITE}#a`);
    expect(index()).toBeUndefined();
    // What is pushed from it cannot be placed either.
    win.history.pushState({ __NA: true }, '', LIST);
    expect(index()).toBeUndefined();
    win.traverse(-2);
    expect(index()).toBe(1);
    win.history.pushState({ __NA: true }, '', MARKET);
    expect(index()).toBe(2);
  });
});
