import { describe, expect, it } from 'vitest';
import {
  ACTIVE_CHECKOUT_PHASES,
  CHECKOUT_START,
  type CheckoutEffect,
  type CheckoutEvent,
  type CheckoutPhase,
  type CheckoutState,
  SMARTRO_APPROVAL_TIMEOUT_MS,
  checkoutBelongsTo,
  checkoutOnAccount,
  checkoutStep,
  reservationToOpen,
  withCheckoutPhase,
} from './smartro-checkout';

/**
 * The events through one window, as `SmartroCheckout` feeds them: every phase that moved (what
 * it reports to the caller) and every step's effect (what it carries out).
 */
function run(events: CheckoutEvent[], from: CheckoutState = CHECKOUT_START) {
  let state = from;
  const reported: CheckoutPhase[] = [];
  const effects: (CheckoutEffect | undefined)[] = [];
  for (const event of events) {
    const step = checkoutStep(state, event);
    if (step.state.phase !== state.phase) reported.push(step.state.phase);
    effects.push(step.effect);
    state = step.state;
  }
  return { state, reported, effects };
}

const PC_OPENED: CheckoutEvent = { type: 'payment', wentAhead: true, mobile: false, layer: true };
const REMOVED: CheckoutEvent = { type: 'layer-removed' };
const GRACE: CheckoutEvent = { type: 'grace-elapsed' };
const CALLBACK: CheckoutEvent = { type: 'callback' };
const APPROVAL_TIMEOUT: CheckoutEvent = { type: 'approval-timeout' };
const RESTORED: CheckoutEvent = { type: 'restored' };

describe('the phases', () => {
  it('keeps the buttons while a window is on its way, open, leaving or approving', () => {
    for (const phase of ['loading', 'open', 'leaving', 'approving'] as const) {
      expect(ACTIVE_CHECKOUT_PHASES.has(phase), phase).toBe(true);
    }
    for (const phase of ['closed', 'failed'] as const) {
      expect(ACTIVE_CHECKOUT_PHASES.has(phase), phase).toBe(false);
    }
    expect(CHECKOUT_START).toEqual({ phase: 'loading', layerGone: false, answered: false });
  });
});

describe('opening the window', () => {
  it('opens the PC layer, or leaves the page on a phone', () => {
    expect(run([PC_OPENED]).reported).toEqual(['open']);
    // A phone has no layer to find: the SDK is submitting the page.
    for (const layer of [true, false]) {
      expect(run([{ type: 'payment', wentAhead: true, mobile: true, layer }]).reported).toEqual([
        'leaving',
      ]);
    }
  });

  it('closes at once when the SDK refused its own form, or went ahead with no layer', () => {
    // `payment()` answered nothing: its validation refused, and its `alert` said why.
    for (const mobile of [true, false]) {
      expect(run([{ type: 'payment', wentAhead: false, mobile, layer: false }]).reported).toEqual([
        'closed',
      ]);
    }
    expect(
      run([{ type: 'payment', wentAhead: true, mobile: false, layer: false }]).reported,
    ).toEqual(['closed']);
  });

  it('fails, with the buttons back, when the SDK is missing or threw — once', () => {
    for (const event of [{ type: 'unavailable' }, { type: 'threw' }] as const) {
      const { state, reported } = run([event]);
      expect(reported, event.type).toEqual(['failed']);
      expect(ACTIVE_CHECKOUT_PHASES.has(state.phase)).toBe(false);
    }
    // next/script's onError, then a ready callback finding no SDK: one failure, one report.
    expect(run([{ type: 'unavailable' }, { type: 'unavailable' }]).reported).toEqual(['failed']);
  });

  it('opens a window only once, and only while it is loading', () => {
    expect(run([PC_OPENED, PC_OPENED]).reported).toEqual(['open']);
    expect(run([{ type: 'unavailable' }, PC_OPENED]).reported).toEqual(['failed']);
    expect(run([PC_OPENED, { type: 'threw' }]).reported).toEqual(['open']);
  });
});

describe('closing the PC layer', () => {
  it('calls the window closed when the layer went and no callback came within the grace', () => {
    const { state, reported, effects } = run([PC_OPENED, REMOVED, GRACE]);
    expect(effects).toEqual([undefined, 'await-callback', undefined]);
    expect(reported).toEqual(['open', 'closed']);
    expect(state).toEqual({ phase: 'closed', layerGone: true, answered: false });
  });

  it('keeps the window open between the removal and the end of the grace', () => {
    expect(run([PC_OPENED, REMOVED]).state.phase).toBe('open');
  });

  it('posts the callback that follows the removal, and the grace then changes nothing', () => {
    const { state, reported, effects } = run([PC_OPENED, REMOVED, CALLBACK, GRACE]);
    expect(reported).toEqual(['open', 'approving']);
    expect(effects).toEqual([undefined, 'await-callback', 'post-approval', undefined]);
    expect(state).toEqual({ phase: 'approving', layerGone: true, answered: true });
  });

  it('still posts a callback that comes after the grace ran out, but a window approves once', () => {
    // A main thread busy enough to run the grace out first: the payer did approve.
    const late = run([PC_OPENED, REMOVED, GRACE, CALLBACK]);
    expect(late.reported).toEqual(['open', 'closed', 'approving']);
    expect(late.effects.at(-1)).toBe('post-approval');
    const twice = run([CALLBACK, CALLBACK], late.state);
    expect(twice.effects).toEqual([undefined, undefined]);
    expect(twice.reported).toEqual([]);
  });

  it('starts the grace clock once, and only for an open layer', () => {
    expect(run([PC_OPENED, REMOVED, REMOVED]).effects).toEqual([
      undefined,
      'await-callback',
      undefined,
    ]);
    // The page came back from the cache first: nothing is waiting for a callback any more.
    expect(run([PC_OPENED, RESTORED, REMOVED]).effects).toEqual([undefined, undefined, undefined]);
    // A grace with no removal before it closes nothing.
    expect(run([PC_OPENED, GRACE]).reported).toEqual(['open']);
  });
});

describe('the approval post', () => {
  it('gives the buttons back when the page is still here after the approval clock', () => {
    const { state, reported } = run([PC_OPENED, REMOVED, CALLBACK, APPROVAL_TIMEOUT]);
    expect(reported).toEqual(['open', 'approving', 'closed']);
    // The window has still answered: a second callback does not post again.
    expect(checkoutStep(state, CALLBACK)).toEqual({ state });
  });

  it('lets the approval clock end nothing but an approval', () => {
    expect(run([PC_OPENED, APPROVAL_TIMEOUT]).reported).toEqual(['open']);
    expect(run([PC_OPENED, REMOVED, GRACE, APPROVAL_TIMEOUT]).reported).toEqual(['open', 'closed']);
  });

  it("outlasts the API's bound on one PG call, so a slow approval is not taken for a lost one", () => {
    // apps/api smartro-client `SMARTRO_TIMEOUT_MS`.
    // Approval (≤ 25 s) and then the result inquiry (≤ 25 s): both fit.
    expect(SMARTRO_APPROVAL_TIMEOUT_MS).toBeGreaterThan(2 * 25_000);
  });
});

describe('the back/forward cache', () => {
  it('closes a window the cache hands back while it still holds the buttons', () => {
    const phone = run([{ type: 'payment', wentAhead: true, mobile: true, layer: false }, RESTORED]);
    expect(phone.reported).toEqual(['leaving', 'closed']);
    const approved = run([PC_OPENED, REMOVED, CALLBACK, RESTORED]);
    expect(approved.reported).toEqual(['open', 'approving', 'closed']);
    expect(run([PC_OPENED, RESTORED]).reported).toEqual(['open', 'closed']);
    expect(run([RESTORED]).reported).toEqual(['closed']);
  });

  it('leaves a window that already gave the buttons back as it is', () => {
    expect(run([{ type: 'unavailable' }, RESTORED]).reported).toEqual(['failed']);
    expect(run([PC_OPENED, REMOVED, GRACE, RESTORED]).reported).toEqual(['open', 'closed']);
  });
});

describe('unmounting', () => {
  const UNMOUNTED: CheckoutEvent = { type: 'unmounted' };

  it('closes a PC layer that is still up, so no approval can call back into nothing', () => {
    const { state, reported, effects } = run([PC_OPENED, UNMOUNTED]);
    expect(effects).toEqual([undefined, 'close-layer']);
    expect(reported).toEqual(['open', 'closed']);
    // The SDK's removal of the layer that follows starts no grace clock, and closes it once.
    const after = run([REMOVED, GRACE, UNMOUNTED], state);
    expect(after.effects).toEqual([undefined, undefined, undefined]);
    expect(after.reported).toEqual([]);
  });

  it('leaves alone a layer already gone, and every window with no layer up', () => {
    // Gone: the approval's callback may be on its way, and there is nothing left to close.
    expect(run([PC_OPENED, REMOVED, UNMOUNTED]).effects.at(-1)).toBeUndefined();
    expect(run([PC_OPENED, REMOVED, CALLBACK, UNMOUNTED]).effects.at(-1)).toBeUndefined();
    const noLayer: CheckoutEvent[][] = [
      [{ type: 'payment', wentAhead: true, mobile: true, layer: false }],
      [{ type: 'payment', wentAhead: false, mobile: false, layer: false }],
      [{ type: 'unavailable' }],
      [PC_OPENED, RESTORED],
    ];
    for (const before of noLayer) {
      const { effects, reported } = run([...before, UNMOUNTED]);
      expect(effects.at(-1), JSON.stringify(before)).toBeUndefined();
      expect(reported).toEqual(run(before).reported);
    }
  });

  it('ends a window still loading, so a load that settles afterwards opens and reports nothing', () => {
    const { state, reported, effects } = run([UNMOUNTED]);
    expect(effects).toEqual([undefined]);
    expect(reported).toEqual(['closed']);
    // next/script's onError, or a ready callback, after the page has moved on: no 'failed' —
    // the caller's toast would tell the payer on another page about a window they left.
    const late: CheckoutEvent[] = [
      { type: 'unavailable' },
      { type: 'threw' },
      PC_OPENED,
      { type: 'payment', wentAhead: true, mobile: true, layer: false },
    ];
    for (const event of late) {
      const after = run([event], state);
      expect(after.reported, event.type).toEqual([]);
      expect(after.effects, event.type).toEqual([undefined]);
    }
  });
});

describe('withCheckoutPhase', () => {
  const current: { packageId: string; prepared: { paymentId: string }; phase: CheckoutPhase } = {
    packageId: 'pack-1',
    prepared: { paymentId: 'pay-new' },
    phase: 'open',
  };

  it("moves the window on screen when the report is that payment's", () => {
    expect(withCheckoutPhase(current, 'pay-new', 'closed')).toEqual({
      ...current,
      phase: 'closed',
    });
  });

  it('ignores a report from a window a newer purchase replaced', () => {
    // The replaced window's clock runs out after the newer window opened.
    expect(withCheckoutPhase(current, 'pay-old', 'closed')).toBe(current);
    expect(withCheckoutPhase(current, 'pay-old', 'failed')).toBe(current);
    expect(withCheckoutPhase(null, 'pay-old', 'closed')).toBeNull();
  });

  it('answers the same object for an unchanged phase, so nothing re-renders', () => {
    expect(withCheckoutPhase(current, 'pay-new', 'open')).toBe(current);
  });
});

describe('checkoutBelongsTo', () => {
  it('opens and keeps a window only for the account the payment was reserved for', () => {
    expect(checkoutBelongsTo({ sent: 'user-a', account: 'user-a' })).toBe(true);
    // A's prepare answered after another tab signed this one in as B: the payment is A's and
    // the ReturnUrl would credit A, so B's wallet must not open it.
    expect(checkoutBelongsTo({ sent: 'user-a', account: 'user-b' })).toBe(false);
    // Signed out in another tab: nobody on screen is A any more.
    expect(checkoutBelongsTo({ sent: 'user-a', account: null })).toBe(false);
  });

  it('lets the window through while nobody has said whose tab this is', () => {
    expect(checkoutBelongsTo({ sent: 'user-a', account: undefined })).toBe(true);
  });
});

describe('checkoutOnAccount', () => {
  const windowIn = (phase: CheckoutPhase) => ({ account: 'user-a', phase });

  it("keeps no window, and the account's own window, as they are", () => {
    expect(checkoutOnAccount(null, 'user-b')).toBe('keep');
    for (const phase of ['loading', 'open', 'leaving', 'approving', 'closed', 'failed'] as const) {
      expect(checkoutOnAccount(windowIn(phase), 'user-a'), phase).toBe('keep');
      // better-auth has not answered: nothing says the window is somebody else's.
      expect(checkoutOnAccount(windowIn(phase), undefined), phase).toBe('keep');
    }
  });

  it('stops a window of the previous account that is still loading or open', () => {
    // A's layer was open when the payer signed in as B in another tab and came back.
    expect(checkoutOnAccount(windowIn('open'), 'user-b')).toBe('stop');
    expect(checkoutOnAccount(windowIn('loading'), 'user-b')).toBe('stop');
    expect(checkoutOnAccount(windowIn('open'), null)).toBe('stop');
    // What the unmount then does with each: the load ends, the layer is taken down.
    expect(checkoutStep({ ...CHECKOUT_START }, { type: 'unmounted' }).state.phase).toBe('closed');
    const open = run([PC_OPENED]).state;
    expect(checkoutStep(open, { type: 'unmounted' }).effect).toBe('close-layer');
  });

  it('lets a window whose page is on its way out depart, holding the buttons', () => {
    // A's approval has posted (or the phone is being sent to tmpay): too late to stop, and the
    // navigation still lands on this page — B's buttons must not come back before it does.
    for (const phase of ['approving', 'leaving'] as const) {
      expect(checkoutOnAccount(windowIn(phase), 'user-b'), phase).toBe('depart');
      expect(checkoutOnAccount(windowIn(phase), null), phase).toBe('depart');
    }
  });

  it('drops, silently, a window already over', () => {
    for (const phase of ['closed', 'failed'] as const) {
      expect(checkoutOnAccount(windowIn(phase), 'user-b'), phase).toBe('drop');
      expect(checkoutOnAccount(windowIn(phase), null), phase).toBe('drop');
    }
  });

  it('takes every window of another account off the screen: none is only hidden', () => {
    // A switch back to A must not remount the same payment's window under its old key.
    for (const phase of ['loading', 'open', 'leaving', 'approving', 'closed', 'failed'] as const) {
      expect(checkoutOnAccount(windowIn(phase), 'user-b'), phase).not.toBe('keep');
    }
  });
});

describe('reservationToOpen', () => {
  /** A prepare the test answers itself, and a tab whose owner it moves in between. */
  function pending() {
    let answer: (account: string) => void = () => undefined;
    const reserve = new Promise<{ account: string; paymentId: string }>((resolve) => {
      answer = (account) => resolve({ account, paymentId: 'pay-1' });
    });
    return { reserve, answer };
  }
  function tab(owner: string | null | undefined) {
    const reads: (string | null | undefined)[] = [];
    return {
      switchTo: (next: string | null | undefined) => {
        owner = next;
      },
      readOwner: () => {
        reads.push(owner);
        return owner;
      },
      reads,
    };
  }

  it("opens the reservation of the tab's own account", async () => {
    const prepare = pending();
    const owner = tab('user-a');
    const opening = reservationToOpen(prepare.reserve, owner.readOwner);
    prepare.answer('user-a');
    await expect(opening).resolves.toEqual({ account: 'user-a', paymentId: 'pay-1' });
  });

  it('reads the owner when the answer lands, not at the click: a switch in between opens nothing', async () => {
    // THE REVIEWED RACE: A clicked, another tab signed this one in as B while the POST ran.
    const prepare = pending();
    const owner = tab('user-a');
    const opening = reservationToOpen(prepare.reserve, owner.readOwner);
    await Promise.resolve();
    expect(owner.reads).toEqual([]);

    owner.switchTo('user-b');
    prepare.answer('user-a');

    await expect(opening).resolves.toBeNull();
    expect(owner.reads).toEqual(['user-b']);
  });

  it('opens nothing after a sign-out, and lets it through while nobody has said whose tab it is', async () => {
    const signedOut = pending();
    const gone = tab('user-a');
    const refused = reservationToOpen(signedOut.reserve, gone.readOwner);
    gone.switchTo(null);
    signedOut.answer('user-a');
    await expect(refused).resolves.toBeNull();

    const unknown = pending();
    const opening = reservationToOpen(unknown.reserve, tab(undefined).readOwner);
    unknown.answer('user-a');
    await expect(opening).resolves.toEqual({ account: 'user-a', paymentId: 'pay-1' });
  });

  it('passes a failed prepare through without asking whose tab it is', async () => {
    const owner = tab('user-a');
    const failure = new Error('refused');
    await expect(reservationToOpen(Promise.reject(failure), owner.readOwner)).rejects.toBe(failure);
    expect(owner.reads).toEqual([]);
  });
});
