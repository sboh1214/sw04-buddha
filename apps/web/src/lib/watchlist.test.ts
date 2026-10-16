import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError } from './api';
import { MY_PREVIEW_ROWS } from './my';
import {
  type WatchButtonInput,
  type WatchPress,
  watchButtonView,
  watchFailureMessage,
  watchPressAction,
  watchlistRows,
} from './watchlist';

/** A signed-in reader whose state has answered "not watched", nothing in flight. */
const settled: WatchButtonInput = {
  sessionPending: false,
  signedIn: true,
  state: { isFetched: true, data: { watched: false } },
  saving: false,
};

/** The state entry as `useQuery` reports it: answered or not, and what it holds. */
const answered = (watched: boolean | undefined) => ({
  isFetched: true,
  data: watched === undefined ? undefined : { watched },
});
const unanswered = { isFetched: false, data: undefined };

describe('watchButtonView (#89, ADR-0064)', () => {
  it('draws a placeholder until the session is known, whatever else the cache holds', () => {
    // The server render and the hydrating one are always here (`useSession`), so the HTML says
    // nothing about anybody's watchlist (#37).
    for (const state of [answered(true), answered(false), answered(undefined), unanswered]) {
      expect(watchButtonView({ ...settled, sessionPending: true, state })).toEqual({
        kind: 'placeholder',
      });
    }
  });

  it('sends a signed-out visitor to the login page, unpressed, and remembers nothing', () => {
    expect(watchButtonView({ ...settled, signedIn: false, state: unanswered })).toEqual({
      kind: 'toggle',
      pressed: false,
      press: 'login',
    });
    // Even a state left in the cache by a previous account does not show through.
    expect(watchButtonView({ ...settled, signedIn: false, state: answered(true) })).toEqual({
      kind: 'toggle',
      pressed: false,
      press: 'login',
    });
  });

  it('waits for the first read of a signed-in reader’s state', () => {
    expect(watchButtonView({ ...settled, state: unanswered })).toEqual({ kind: 'placeholder' });
  });

  it('toggles: an unpressed press watches, a pressed one unwatches', () => {
    expect(watchButtonView({ ...settled, state: answered(false) })).toEqual({
      kind: 'toggle',
      pressed: false,
      press: 'watch',
    });
    expect(watchButtonView({ ...settled, state: answered(true) })).toEqual({
      kind: 'toggle',
      pressed: true,
      press: 'unwatch',
    });
  });

  it('draws nothing while no read has succeeded: an unpressed toggle would misstate a watch', () => {
    // Owner decision 2026-10-16 (ADR-0064): hidden until a read succeeds, not drawn unpressed.
    expect(watchButtonView({ ...settled, state: answered(undefined) })).toEqual({ kind: 'hidden' });
    expect(watchButtonView({ ...settled, state: answered(undefined), saving: true })).toEqual({
      kind: 'hidden',
    });
  });

  it('keeps the toggle once a read has answered, whatever the reads after it are doing', () => {
    // A read again after a success — a refocus, or the read after a press — keeps the data it
    // had even if it fails, and `isFetched` stays: the toggle, which may hold the keyboard
    // focus, is not swapped for the placeholder or taken away.
    expect(watchButtonView({ ...settled, state: answered(false), saving: true })).toEqual({
      kind: 'toggle',
      pressed: false,
      press: 'wait',
    });
  });

  it('shows where a press in flight is going and lets no second press through', () => {
    // `saving` with the optimistic state already written (`updateWatchOptions`).
    expect(watchButtonView({ ...settled, state: answered(true), saving: true })).toEqual({
      kind: 'toggle',
      pressed: true,
      press: 'wait',
    });
    expect(watchButtonView({ ...settled, state: answered(false), saving: true })).toEqual({
      kind: 'toggle',
      pressed: false,
      press: 'wait',
    });
  });
});

describe('watchPressAction', () => {
  it('sends nothing for a press while one is on the wire', () => {
    // The second click of a double-click on 관심 등록: were it read as "not watch", it would send
    // an unwatch behind the watch and leave the market unwatched.
    expect(watchPressAction('wait')).toBeNull();
  });

  it('sends the state the press asks for, and a signed-out press to the login page', () => {
    expect(watchPressAction('watch')).toEqual({ kind: 'put', watched: true });
    expect(watchPressAction('unwatch')).toEqual({ kind: 'put', watched: false });
    expect(watchPressAction('login')).toEqual({ kind: 'login' });
  });

  it('takes every press the view can draw to what it says, end to end', () => {
    const presses: [WatchButtonInput, WatchPress, ReturnType<typeof watchPressAction>][] = [
      [settled, 'watch', { kind: 'put', watched: true }],
      [{ ...settled, state: answered(true) }, 'unwatch', { kind: 'put', watched: false }],
      [{ ...settled, saving: true }, 'wait', null],
      [{ ...settled, state: answered(true), saving: true }, 'wait', null],
      [{ ...settled, signedIn: false }, 'login', { kind: 'login' }],
    ];
    for (const [input, press, action] of presses) {
      const view = watchButtonView(input);
      expect(view).toMatchObject({ kind: 'toggle', press });
      if (view.kind === 'toggle') expect(watchPressAction(view.press)).toEqual(action);
    }
  });
});

describe('watchFailureMessage', () => {
  it('names the change that did not happen', () => {
    const outage = new ApiError(503, { code: 'INTERNAL', message: 'x' } as never);
    expect(watchFailureMessage(outage, true)).toBe(copy.watchAddFailed);
    expect(watchFailureMessage(outage, false)).toBe(copy.watchRemoveFailed);
    expect(watchFailureMessage(new Error('network'), true)).toBe(copy.watchAddFailed);
  });

  it('says the account changed when the cookie is somebody else’s (A-PG-24)', () => {
    const forAnother = new ApiError(403, {
      code: 'FORBIDDEN',
      message: 'x',
      details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
    });
    expect(watchFailureMessage(forAnother, true)).toBe(copy.sessionChanged);
    expect(watchFailureMessage(forAnother, false)).toBe(copy.sessionChanged);
    // The CSRF refusal names no field: an ordinary failure.
    const csrf = new ApiError(403, { code: 'FORBIDDEN', message: 'x' } as never);
    expect(watchFailureMessage(csrf, false)).toBe(copy.watchRemoveFailed);
  });
});

describe('watchlistRows (MY 관심 시장)', () => {
  // Two pages as `useInfiniteQuery` holds them: newest watch first, page by page.
  const pages = [{ items: ['m5', 'm4'] }, { items: ['m3', 'm2', 'm1'] }];

  it('draws every row the tab has, and 더 보기 while there is a next page (no cap)', () => {
    expect(watchlistRows(pages, true, undefined)).toEqual({
      rows: ['m5', 'm4', 'm3', 'm2', 'm1'],
      more: true,
    });
    expect(watchlistRows(pages, false, undefined)).toEqual({
      rows: ['m5', 'm4', 'm3', 'm2', 'm1'],
      more: false,
    });
  });

  it('previews the newest three on /my with no 더 보기 — the way on is 전체 보기 (ADR-0054)', () => {
    expect(watchlistRows(pages, true, MY_PREVIEW_ROWS)).toEqual({
      rows: ['m5', 'm4', 'm3'],
      more: false,
    });
    expect(watchlistRows([{ items: ['m1'] }], false, MY_PREVIEW_ROWS)).toEqual({
      rows: ['m1'],
      more: false,
    });
  });

  it('has no rows before the first page', () => {
    expect(watchlistRows(undefined, false, undefined)).toEqual({ rows: [], more: false });
    expect(watchlistRows(undefined, false, MY_PREVIEW_ROWS)).toEqual({ rows: [], more: false });
  });
});
