import { describe, expect, it } from 'vitest';
import { COMMENT_DRAFT_PREFIX, keepCommentDraft, readCommentDrafts } from './comment-drafts';
import { POST_DRAFT_PREFIX, POST_DRAFT_TTL_MS, type DraftStorage } from './post-drafts';
import {
  PROFILE_DRAFT_PREFIX,
  PROFILE_DRAFT_TTL_MS,
  bioDraftToKeep,
  bioToRestore,
  clearProfileDraft,
  clearProfileDrafts,
  interestsDraftToKeep,
  interestsToRestore,
  keepProfileDraft,
  nicknameDraftToKeep,
  nicknameToRestore,
  profileDraftStorageKey,
  readProfileDraft,
  sweepProfileDrafts,
} from './profile-drafts';

/**
 * MY 설정's 소개, interest categories and nickname kept in this tab across the onboarding step (오너
 * 결정 2026-10-22 답 3·2026-10-22 (2차) 답 2, ADR-0078 7-25): what each card keeps as the page goes
 * there, kept and taken back by card and account, gone after the posts' hour, cleared, and never
 * thrown on by a storage the browser refuses.
 */

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

/** A storage the browser refuses: every call throws (blocked site data). */
const refusing: DraftStorage = {
  get length(): number {
    throw new DOMException('denied', 'SecurityError');
  },
  key() {
    throw new DOMException('denied', 'SecurityError');
  },
  getItem() {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem() {
    throw new DOMException('denied', 'SecurityError');
  },
  removeItem() {
    throw new DOMException('denied', 'SecurityError');
  },
};

const A = 'account-a';
const B = 'account-b';
const NOW = Date.UTC(2026, 9, 22, 8, 0);

describe('what a card keeps as MY 설정 goes to the step', () => {
  it('keeps the 소개 typed when saving it would change the account’s — a new text, or an empty box over one not yet cleared', () => {
    expect(bioDraftToKeep('새 소개', null)).toBe('새 소개');
    expect(bioDraftToKeep('새 소개', '옛 소개')).toBe('새 소개');
    // As typed: spaces and line endings are the box's, the save would normalise them.
    expect(bioDraftToKeep('  두 줄\r\n소개 ', '옛 소개')).toBe('  두 줄\r\n소개 ');
    expect(bioDraftToKeep('', '옛 소개')).toBe('');
    expect(bioDraftToKeep('   ', '옛 소개')).toBe('   ');
  });

  it('keeps nothing of a box holding what the account has, spaces at either end aside', () => {
    expect(bioDraftToKeep('옛 소개', '옛 소개')).toBeNull();
    expect(bioDraftToKeep(' 옛 소개\n', '옛 소개')).toBeNull();
    expect(bioDraftToKeep('', null)).toBeNull();
    expect(bioDraftToKeep('  ', null)).toBeNull();
  });

  it('keeps the categories picked when they differ from the account’s — added, dropped or both — in id order', () => {
    const offered = [1, 2, 3, 4].map((id) => ({ id }));
    expect(interestsDraftToKeep([3, 1], [1], offered)).toEqual([1, 3]);
    expect(interestsDraftToKeep([], [1, 2], offered)).toEqual([]);
    expect(interestsDraftToKeep([2, 4], [1, 2], offered)).toEqual([2, 4]);
    expect(interestsDraftToKeep([2, 1], [1, 2], offered)).toBeNull();
    expect(interestsDraftToKeep([], [], offered)).toBeNull();
  });

  it('reads the categories among those offered, as 저장 does: a retired one the account holds is no change', () => {
    // The account holds 7 and 12; operators retired 12, so the list offers 7 (and 8) alone.
    const offered = [7, 8].map((id) => ({ id }));
    expect(interestsDraftToKeep([7], [7, 12], offered)).toBeNull();
    // A change among those offered is kept — without the retired one, which is not on screen.
    expect(interestsDraftToKeep([7, 8], [7, 12], offered)).toEqual([7, 8]);
    expect(interestsDraftToKeep([], [7, 12], offered)).toEqual([]);
  });

  it('keeps no categories while the list has not loaded: nothing on screen was picked or unpicked', () => {
    // Read among no categories, every account’s picks would look dropped — and a save of them clears.
    expect(interestsDraftToKeep([], [1, 2], undefined)).toBeNull();
    expect(interestsDraftToKeep([1, 3], [1], undefined)).toBeNull();
  });

  it('puts back only what still differs from the account’s now (another tab may have saved the same)', () => {
    expect(bioToRestore({ kind: 'bio', text: '새 소개' }, '옛 소개', '옛 소개')).toBe('새 소개');
    expect(bioToRestore({ kind: 'bio', text: '새 소개' }, '새 소개', '새 소개')).toBeNull();
    expect(bioToRestore({ kind: 'bio', text: '' }, '옛 소개', '옛 소개')).toBe('');
    const offered = [1, 2, 3].map((id) => ({ id }));
    expect(
      interestsToRestore({ kind: 'interests', categoryIds: [1, 3] }, [1], offered, [1]),
    ).toEqual([1, 3]);
    expect(
      interestsToRestore({ kind: 'interests', categoryIds: [3, 1] }, [1, 3], offered, [1, 3]),
    ).toBeNull();
  });

  it('reads what it puts back among the categories offered now: a retired one is neither news nor put back', () => {
    // The account holds 7 and 12, and 12 is retired: an untouched card’s picks are no draft.
    const offered = [7, 8, 9].map((id) => ({ id }));
    expect(
      interestsToRestore({ kind: 'interests', categoryIds: [7] }, [7, 12], offered, [7]),
    ).toBeNull();
    // A pick kept, then retired before the return: nothing left to put back.
    expect(
      interestsToRestore({ kind: 'interests', categoryIds: [7, 10] }, [7], offered, [7]),
    ).toBeNull();
    // What is still offered of a real change comes back, the retired pick left out.
    expect(
      interestsToRestore({ kind: 'interests', categoryIds: [7, 8, 10] }, [7, 12], offered, [7]),
    ).toEqual([7, 8]);
  });

  it('never writes over what the card holds of the member’s own since it was drawn (a step done in another tab, learned late)', () => {
    // The 소개 box holds a text of its own — typed after coming back by the step’s link.
    expect(
      bioToRestore({ kind: 'bio', text: '두었던 소개' }, '옛 소개', '지금 쓰는 소개'),
    ).toBeNull();
    // …or emptied over the account’s 소개: clearing it, not yet saved, is the member’s too.
    expect(bioToRestore({ kind: 'bio', text: '두었던 소개' }, '옛 소개', '')).toBeNull();
    // Spaces at either end are no text of its own: the box still holds the account’s.
    expect(bioToRestore({ kind: 'bio', text: '두었던 소개' }, '옛 소개', ' 옛 소개\n')).toBe(
      '두었던 소개',
    );
    // Categories picked or unpicked since, among those offered, are left as they are.
    const offered = [1, 2, 3].map((id) => ({ id }));
    const kept = { kind: 'interests', categoryIds: [1, 3] } as const;
    expect(interestsToRestore(kept, [1], offered, [1, 2])).toBeNull();
    expect(interestsToRestore(kept, [1], offered, [])).toBeNull();
  });

  it('keeps the nickname typed when it names another than the account’s, as typed — not the account’s, nor an empty box', () => {
    expect(nicknameDraftToKeep('새닉네임', '옛닉네임')).toBe('새닉네임');
    // As typed: the spaces are the box's, the form trims them as it sends.
    expect(nicknameDraftToKeep(' 새닉네임 ', '옛닉네임')).toBe(' 새닉네임 ');
    // Case is a change: the form and the server compare the nickname as it is.
    expect(nicknameDraftToKeep('Buddha_fan', 'buddha_fan')).toBe('Buddha_fan');
    // What the rules would refuse is still what was typed: 저장 checks it again on return.
    expect(nicknameDraftToKeep('user_ABCD', '옛닉네임')).toBe('user_ABCD');
    expect(nicknameDraftToKeep('옛닉네임', '옛닉네임')).toBeNull();
    expect(nicknameDraftToKeep(' 옛닉네임\t', '옛닉네임')).toBeNull();
    // No nickname is cleared: an emptied box is no change to keep.
    expect(nicknameDraftToKeep('', '옛닉네임')).toBeNull();
    expect(nicknameDraftToKeep('   ', '옛닉네임')).toBeNull();
  });

  it('puts the nickname back only over the account’s own, and only while it still names another', () => {
    const kept = { kind: 'nickname', text: '새닉네임' } as const;
    expect(nicknameToRestore(kept, '옛닉네임', '옛닉네임')).toBe('새닉네임');
    // Spaces at either end are no nickname of the box's own.
    expect(nicknameToRestore(kept, '옛닉네임', ' 옛닉네임 ')).toBe('새닉네임');
    // Another tab changed it to the same meanwhile: nothing to put back.
    expect(nicknameToRestore(kept, '새닉네임', '새닉네임')).toBeNull();
    // The newer typing wins (a step done in another tab, learned late) — emptied included.
    expect(nicknameToRestore(kept, '옛닉네임', '지금쓰는닉')).toBeNull();
    expect(nicknameToRestore(kept, '옛닉네임', '')).toBeNull();
  });
});

describe('the profile drafts in the tab', () => {
  it('waits the posts’ and comments’ hour, under its own prefix', () => {
    expect(PROFILE_DRAFT_TTL_MS).toBe(POST_DRAFT_TTL_MS);
    expect(PROFILE_DRAFT_TTL_MS).toBe(60 * 60 * 1000);
    expect(profileDraftStorageKey('bio')).toBe(`${PROFILE_DRAFT_PREFIX}bio`);
    expect(profileDraftStorageKey('interests')).toBe(`${PROFILE_DRAFT_PREFIX}interests`);
    expect(profileDraftStorageKey('nickname')).toBe(`${PROFILE_DRAFT_PREFIX}nickname`);
    for (const prefix of [POST_DRAFT_PREFIX, COMMENT_DRAFT_PREFIX]) {
      expect(PROFILE_DRAFT_PREFIX.startsWith(prefix)).toBe(false);
      expect(prefix.startsWith(PROFILE_DRAFT_PREFIX)).toBe(false);
    }
  });

  it('keeps each card’s draft for its writer, and gives it back by card', () => {
    const storage = new MemoryStorage();
    expect(keepProfileDraft(storage, A, { kind: 'bio', text: '쓰던 소개\n둘째 줄' }, NOW)).toBe(
      true,
    );
    expect(keepProfileDraft(storage, A, { kind: 'interests', categoryIds: [5, 2, 5] }, NOW)).toBe(
      true,
    );
    expect(readProfileDraft(storage, 'bio', A, NOW + 1_000)).toEqual({
      kind: 'bio',
      text: '쓰던 소개\n둘째 줄',
    });
    expect(readProfileDraft(storage, 'interests', A, NOW + 1_000)).toEqual({
      kind: 'interests',
      categoryIds: [2, 5],
    });
    // Reading leaves it: the card that takes it back removes it.
    expect(readProfileDraft(storage, 'bio', A, NOW + 2_000)).not.toBeNull();
    // A later trip replaces what was kept for the card.
    keepProfileDraft(storage, A, { kind: 'bio', text: '다시 쓴 소개' }, NOW + 3_000);
    expect(readProfileDraft(storage, 'bio', A, NOW + 4_000)).toEqual({
      kind: 'bio',
      text: '다시 쓴 소개',
    });
    // The nickname's card keeps its own, beside the 소개's.
    expect(keepProfileDraft(storage, A, { kind: 'nickname', text: ' 새닉네임' }, NOW)).toBe(true);
    expect(readProfileDraft(storage, 'nickname', A, NOW + 1_000)).toEqual({
      kind: 'nickname',
      text: ' 새닉네임',
    });
    expect(readProfileDraft(storage, 'bio', A, NOW + 1_000)).toEqual({
      kind: 'bio',
      text: '다시 쓴 소개',
    });
  });

  it('never shows one account’s draft to another, and removes it when asked for it', () => {
    const storage = new MemoryStorage();
    keepProfileDraft(storage, A, { kind: 'bio', text: 'A의 소개' }, NOW);
    expect(readProfileDraft(storage, 'bio', B, NOW)).toBeNull();
    expect(readProfileDraft(storage, 'bio', A, NOW)).toBeNull();
    keepProfileDraft(storage, A, { kind: 'nickname', text: 'A의닉네임' }, NOW);
    expect(readProfileDraft(storage, 'nickname', B, NOW)).toBeNull();
    expect(readProfileDraft(storage, 'nickname', A, NOW)).toBeNull();
  });

  it('is gone an hour after it was kept, and sweeps what is past it or no draft', () => {
    const storage = new MemoryStorage();
    keepProfileDraft(storage, A, { kind: 'bio', text: '한 시간' }, NOW);
    expect(readProfileDraft(storage, 'bio', A, NOW + PROFILE_DRAFT_TTL_MS)).not.toBeNull();
    expect(readProfileDraft(storage, 'bio', A, NOW + PROFILE_DRAFT_TTL_MS + 1)).toBeNull();
    expect(storage.items.size).toBe(0);

    keepProfileDraft(storage, A, { kind: 'interests', categoryIds: [1] }, NOW);
    keepProfileDraft(storage, A, { kind: 'nickname', text: '한시간' }, NOW);
    storage.setItem(`${PROFILE_DRAFT_PREFIX}bio`, '{"version":2}');
    storage.setItem(`${PROFILE_DRAFT_PREFIX}image`, '{}');
    storage.setItem('unrelated', 'kept');
    sweepProfileDrafts(storage, NOW + 1_000);
    expect([...storage.items.keys()].sort()).toEqual([
      `${PROFILE_DRAFT_PREFIX}interests`,
      `${PROFILE_DRAFT_PREFIX}nickname`,
      'unrelated',
    ]);
    expect(readProfileDraft(storage, 'nickname', A, NOW + PROFILE_DRAFT_TTL_MS)).not.toBeNull();
    sweepProfileDrafts(storage, NOW + PROFILE_DRAFT_TTL_MS + 1);
    expect([...storage.items.keys()]).toEqual(['unrelated']);
  });

  it('takes nothing that is not a draft of that card: a broken item, wrong ids, a bio without text', () => {
    const storage = new MemoryStorage();
    const put = (kind: 'bio' | 'interests' | 'nickname', value: unknown) =>
      storage.setItem(profileDraftStorageKey(kind), JSON.stringify(value));
    put('bio', { version: 1, accountId: A, savedAt: NOW, categoryIds: [1] });
    expect(readProfileDraft(storage, 'bio', A, NOW)).toBeNull();
    for (const text of [undefined, 7, null, ['닉네임']]) {
      put('nickname', { version: 1, accountId: A, savedAt: NOW, text });
      expect(readProfileDraft(storage, 'nickname', A, NOW), JSON.stringify(text)).toBeNull();
    }
    for (const categoryIds of [[0], [-1], [1.5], ['1'], 'x', null]) {
      put('interests', { version: 1, accountId: A, savedAt: NOW, categoryIds });
      expect(
        readProfileDraft(storage, 'interests', A, NOW),
        JSON.stringify(categoryIds),
      ).toBeNull();
    }
    storage.setItem(profileDraftStorageKey('bio'), 'not json');
    expect(readProfileDraft(storage, 'bio', A, NOW)).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it('clears one card’s draft, or all of them at sign-out — never the posts’ or comments’', () => {
    const storage = new MemoryStorage();
    keepProfileDraft(storage, A, { kind: 'bio', text: '소개' }, NOW);
    keepProfileDraft(storage, A, { kind: 'interests', categoryIds: [1] }, NOW);
    keepProfileDraft(storage, A, { kind: 'nickname', text: '새닉네임' }, NOW);
    keepCommentDraft(storage, { kind: 'comment', postId: 'p' }, A, '댓글', NOW);
    clearProfileDraft(storage, 'bio');
    expect(readProfileDraft(storage, 'bio', A, NOW)).toBeNull();
    expect(readProfileDraft(storage, 'interests', A, NOW)).not.toBeNull();
    clearProfileDraft(storage, 'nickname');
    expect(readProfileDraft(storage, 'nickname', A, NOW)).toBeNull();
    expect(readProfileDraft(storage, 'interests', A, NOW)).not.toBeNull();
    keepProfileDraft(storage, A, { kind: 'nickname', text: '새닉네임' }, NOW);
    clearProfileDrafts(storage);
    expect(readProfileDraft(storage, 'interests', A, NOW)).toBeNull();
    expect(readProfileDraft(storage, 'nickname', A, NOW)).toBeNull();
    expect(readCommentDrafts(storage, 'p', A, NOW).comment).toBe('댓글');
  });

  it('never throws on a storage the browser refuses: it keeps and restores nothing', () => {
    expect(keepProfileDraft(refusing, A, { kind: 'bio', text: '소개' }, NOW)).toBe(false);
    expect(readProfileDraft(refusing, 'bio', A, NOW)).toBeNull();
    expect(keepProfileDraft(refusing, A, { kind: 'nickname', text: '닉네임' }, NOW)).toBe(false);
    expect(readProfileDraft(refusing, 'nickname', A, NOW)).toBeNull();
    expect(() => {
      clearProfileDraft(refusing, 'bio');
      clearProfileDrafts(refusing);
      sweepProfileDrafts(refusing, NOW);
    }).not.toThrow();
  });
});
