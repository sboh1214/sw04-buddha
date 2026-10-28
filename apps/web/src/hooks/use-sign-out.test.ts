import { describe, expect, it } from 'vitest';
import { signOutInOrder } from './use-sign-out';

/**
 * 로그아웃's order (`signOutInOrder`): what the screen tells the server before the session ends
 * — /onboarding's leave report, whose skip needs the session (owner decision 2026-10-21 (2nd)
 * answer 2, ADR-0078) — then the sign-out, then the cache emptied and home, on success only.
 */
describe('signOutInOrder', () => {
  /** Each step's name as it ran; `beforeSignOut` ends only when the test lets it. */
  function recorder(signOut: () => Promise<{ error?: unknown }> = () => Promise.resolve({})) {
    const ran: string[] = [];
    let finish: () => void = () => undefined;
    return {
      ran,
      finish: () => finish(),
      steps: {
        beforeSignOut: () => {
          ran.push('beforeSignOut');
          return new Promise<void>((resolve) => {
            finish = () => {
              ran.push('beforeSignOut done');
              resolve();
            };
          });
        },
        signOut: () => {
          ran.push('signOut');
          return signOut();
        },
        onFailed: () => ran.push('onFailed'),
        onSignedOut: () => ran.push('onSignedOut'),
      },
    };
  }

  it('ends the session only once what comes before it has', async () => {
    const { ran, finish, steps } = recorder();
    const signingOut = signOutInOrder(steps);
    await Promise.resolve();
    expect(ran).toEqual(['beforeSignOut']);
    finish();
    await signingOut;
    expect(ran).toEqual(['beforeSignOut', 'beforeSignOut done', 'signOut', 'onSignedOut']);
  });

  it('signs out when what comes before it fails, and without one', async () => {
    const ran: string[] = [];
    await signOutInOrder({
      beforeSignOut: () => Promise.reject(new Error('offline')),
      signOut: () => {
        ran.push('signOut');
        return Promise.resolve({ error: null });
      },
      onFailed: () => ran.push('onFailed'),
      onSignedOut: () => ran.push('onSignedOut'),
    });
    await signOutInOrder({
      signOut: () => {
        ran.push('signOut');
        return Promise.resolve({});
      },
      onFailed: () => ran.push('onFailed'),
      onSignedOut: () => ran.push('onSignedOut'),
    });
    expect(ran).toEqual(['signOut', 'onSignedOut', 'signOut', 'onSignedOut']);
  });

  it('stays signed in on a failed sign-out: the toast, not home', async () => {
    const refused = recorder(() => Promise.resolve({ error: { status: 500 } }));
    const refusing = signOutInOrder(refused.steps);
    await Promise.resolve();
    refused.finish();
    await refusing;
    expect(refused.ran).toEqual(['beforeSignOut', 'beforeSignOut done', 'signOut', 'onFailed']);

    const thrown = recorder(() => Promise.reject(new Error('offline')));
    const throwing = signOutInOrder(thrown.steps);
    await Promise.resolve();
    thrown.finish();
    await throwing;
    expect(thrown.ran).toEqual(['beforeSignOut', 'beforeSignOut done', 'signOut', 'onFailed']);
  });
});
