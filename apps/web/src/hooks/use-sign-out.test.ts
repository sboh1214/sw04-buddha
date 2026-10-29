import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepSessionCommentDraft } from '@/lib/comment-drafts';
import { type DraftStorage, keepSessionPostDraft } from '@/lib/post-drafts';
import { keepSessionProfileDraft } from '@/lib/profile-drafts';
import { accountNowOf, goesWithAccountTurn, sessionAccountTurned } from '@/lib/session-account';
import { forgetAccountInTab, signOutInOrder } from './use-sign-out';

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

/** A tab's sessionStorage over a Map. */
class MemoryStorage implements DraftStorage {
  readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

/**
 * What 로그아웃 and 탈퇴 (#140, ADR-0086 7-20) leave of the account in the tab: nothing — the query
 * cache and the drafts an onboarding step kept here (lib/post-drafts.ts, lib/comment-drafts.ts,
 * lib/profile-drafts.ts) alike.
 */
describe('forgetAccountInTab', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('empties the query cache and every draft kept in the tab, and nothing else of the tab', () => {
    const storage = new MemoryStorage();
    vi.stubGlobal('window', { sessionStorage: storage });
    const account = '0b1c2d3e-0000-4000-8000-000000000001';
    const elsewhere = 'not-a-draft';
    storage.setItem(elsewhere, 'kept');
    expect(
      keepSessionPostDraft(
        { kind: 'new', marketId: '0b1c2d3e-0000-4000-8000-000000000002' },
        account,
        {
          title: '쓰던 제목',
          body: { type: 'doc', content: [] },
          previews: {},
        },
      ),
    ).toBe(true);
    expect(
      keepSessionPostDraft({ kind: 'notice-new' }, account, {
        title: '쓰던 공지',
        body: { type: 'doc', content: [] },
        previews: {},
      }),
    ).toBe(true);
    expect(
      keepSessionCommentDraft(
        { kind: 'comment', postId: '0b1c2d3e-0000-4000-8000-000000000003' },
        account,
        '쓰던 댓글',
      ),
    ).toBe(true);
    expect(keepSessionProfileDraft(account, { kind: 'bio', text: '쓰던 소개' })).toBe(true);
    expect(keepSessionProfileDraft(account, { kind: 'nickname', text: '쓰던닉네임' })).toBe(true);
    const queryClient = new QueryClient();
    queryClient.setQueryData(['me'], { id: account });
    queryClient.setQueryData(['me', 'closure'], { coin: 0 });
    expect(storage.items.size).toBe(6);

    forgetAccountInTab(queryClient);

    expect(queryClient.getQueryCache().getAll()).toEqual([]);
    expect([...storage.items.keys()]).toEqual([elsewhere]);
  });

  it('leaves the tab nobody’s for what goes before SessionCacheGuard hears the session name nobody — even with a reset for the account under way (ADR-0092 8-32·8-36)', () => {
    // The guard reset the cache as the session turned to A, its reads not settled yet; A signs out
    // in this tab. A form or a comment box drawn for A going after this — the cache emptied, the
    // session still A's for a moment — keeps nothing: the tab's drafts are all gone.
    sessionAccountTurned('account-a');
    expect(goesWithAccountTurn('account-a', undefined)).toBe(true);
    forgetAccountInTab(new QueryClient());
    expect(accountNowOf(undefined)).toBeUndefined();
    expect(goesWithAccountTurn('account-a', undefined)).toBe(false);
  });

  it('empties what every account kept in the tab, as 로그아웃 does — not the one account a save clears', () => {
    // A save clears what its own account kept, whoever the tab shows by then (ADR-0078 7-30,
    // ADR-0073 9-48); the tab's sign-out — 탈퇴's too — clears every draft in it: the tab is
    // nobody's after it (ADR-0086 결과 5, 다시 쌓기(2026-10-25)).
    const storage = new MemoryStorage();
    vi.stubGlobal('window', { sessionStorage: storage });
    const closing = '0b1c2d3e-0000-4000-8000-000000000001';
    const earlier = '0b1c2d3e-0000-4000-8000-000000000004';
    const postId = '0b1c2d3e-0000-4000-8000-000000000003';
    const draft = { title: '쓰던 제목', body: { type: 'doc', content: [] }, previews: {} };
    expect(keepSessionPostDraft({ kind: 'edit', postId }, earlier, draft)).toBe(true);
    expect(
      keepSessionPostDraft(
        { kind: 'new', marketId: '0b1c2d3e-0000-4000-8000-000000000002' },
        closing,
        draft,
      ),
    ).toBe(true);
    expect(
      keepSessionCommentDraft(
        { kind: 'reply', postId, parentId: '0b1c2d3e-0000-4000-8000-000000000005' },
        earlier,
        '쓰던 답글',
      ),
    ).toBe(true);
    expect(keepSessionProfileDraft(earlier, { kind: 'interests', categoryIds: [3] })).toBe(true);
    expect(keepSessionProfileDraft(closing, { kind: 'bio', text: '쓰던 소개' })).toBe(true);
    expect(storage.items.size).toBe(5);

    forgetAccountInTab(new QueryClient());

    expect([...storage.items.keys()]).toEqual([]);
  });
});
