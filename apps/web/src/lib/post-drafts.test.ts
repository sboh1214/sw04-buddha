import { describe, expect, it } from 'vitest';
import { type Onboarding } from './onboarding';
import {
  DRAFT_PREVIEW_MAX_SIDE,
  POST_DRAFT_PREFIX,
  POST_DRAFT_TTL_MS,
  type DraftStorage,
  type PostDraft,
  clearPostDraft,
  clearPostDrafts,
  hasDraftToKeep,
  keepPostDraft,
  postDraftLandedSince,
  postDraftMoment,
  postDraftStorageKey,
  previewSize,
  readPostDraft,
  postDraftLanded,
  shouldKeepPostDraft,
  sweepPostDrafts,
} from './post-drafts';

/**
 * The post drafts the onboarding gate keeps in this tab (오너 결정 2026-10-20, ADR-0073): kept and
 * taken back by screen and account, gone after POST_DRAFT_TTL_MS, cleared, and kept without the
 * previews when the storage is full.
 */

/** A Web Storage over a Map, with an optional quota in characters (key + value, as browsers count). */
class MemoryStorage implements DraftStorage {
  readonly items = new Map<string, string>();
  constructor(private readonly quota = Number.POSITIVE_INFINITY) {}
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
    let used = key.length + value.length;
    for (const [other, stored] of this.items) {
      if (other !== key) used += other.length + stored.length;
    }
    if (used > this.quota) throw new DOMException('quota', 'QuotaExceededError');
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

const ACCOUNT = '5b0d0c8e-6c2f-4f0a-9a43-2b8c1d7e9f10';
const OTHER_ACCOUNT = '9e1f7c3a-1d2b-4c5e-8f6a-0b1c2d3e4f5a';
const MARKET = 'A1B2C3D4-0000-4000-8000-000000000001';
const POST = 'b2c3d4e5-0000-4000-8000-000000000002';
const IMAGE = 'c3d4e5f6-0000-4000-8000-000000000003';
const NEW: { kind: 'new'; marketId: string } = { kind: 'new', marketId: MARKET };
const EDIT: { kind: 'edit'; postId: string } = { kind: 'edit', postId: POST };
const NOW = Date.UTC(2026, 9, 20, 3, 0, 0);
const PREVIEW = `data:image/webp;base64,${'A'.repeat(64)}`;

const DRAFT: PostDraft = {
  title: '쓰던 제목',
  body: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '쓰던 본문', marks: [{ type: 'bold' }] }],
      },
      { type: 'image', attrs: { mediaId: IMAGE } },
    ],
  },
  previews: { [IMAGE]: PREVIEW },
};

describe('where a draft is kept', () => {
  it('is one item per screen: a new post per market, an edit per post, ids lower-cased', () => {
    expect(postDraftStorageKey(NEW)).toBe(`${POST_DRAFT_PREFIX}new:${MARKET.toLowerCase()}`);
    expect(postDraftStorageKey(EDIT)).toBe(`${POST_DRAFT_PREFIX}edit:${POST}`);
    expect(postDraftStorageKey({ kind: 'new', marketId: POST })).not.toBe(
      postDraftStorageKey({ kind: 'edit', postId: POST }),
    );
  });
});

describe('keeping and taking back', () => {
  it('takes back what was kept — title, the editor JSON and the previews — for its screen and writer', () => {
    const storage = new MemoryStorage();
    expect(keepPostDraft(storage, NEW, ACCOUNT, DRAFT, NOW)).toBe(true);
    expect(readPostDraft(storage, NEW, ACCOUNT, NOW + 1_000)).toEqual(DRAFT);
    // The same market however its id is spelled; never another screen.
    expect(
      readPostDraft(storage, { kind: 'new', marketId: MARKET.toLowerCase() }, ACCOUNT, NOW),
    ).toEqual(DRAFT);
    expect(readPostDraft(storage, EDIT, ACCOUNT, NOW)).toBeNull();
    // Reading takes nothing away: the screen removes it once it holds it.
    expect(storage.items.size).toBe(1);
  });

  it('replaces what the same screen kept before', () => {
    const storage = new MemoryStorage();
    keepPostDraft(storage, EDIT, ACCOUNT, DRAFT, NOW);
    keepPostDraft(storage, EDIT, ACCOUNT, { ...DRAFT, title: '다시 쓴 제목' }, NOW + 5);
    expect(readPostDraft(storage, EDIT, ACCOUNT, NOW + 10)?.title).toBe('다시 쓴 제목');
    expect(storage.items.size).toBe(1);
  });

  it('never shows one account the draft of another, and drops it', () => {
    const storage = new MemoryStorage();
    keepPostDraft(storage, NEW, ACCOUNT, DRAFT, NOW);
    expect(readPostDraft(storage, NEW, OTHER_ACCOUNT, NOW)).toBeNull();
    expect(storage.items.size).toBe(0);
    expect(readPostDraft(storage, NEW, ACCOUNT, NOW)).toBeNull();
  });

  it('expires POST_DRAFT_TTL_MS after it was kept, and is dropped then', () => {
    expect(POST_DRAFT_TTL_MS).toBe(60 * 60 * 1000);
    const storage = new MemoryStorage();
    keepPostDraft(storage, NEW, ACCOUNT, DRAFT, NOW);
    expect(readPostDraft(storage, NEW, ACCOUNT, NOW + POST_DRAFT_TTL_MS)).toEqual(DRAFT);
    expect(readPostDraft(storage, NEW, ACCOUNT, NOW + POST_DRAFT_TTL_MS + 1)).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it('sweeps every expired draft, and items under the prefix that are none, keeping the rest', () => {
    const storage = new MemoryStorage();
    keepPostDraft(storage, NEW, ACCOUNT, DRAFT, NOW);
    keepPostDraft(storage, EDIT, ACCOUNT, DRAFT, NOW + POST_DRAFT_TTL_MS);
    storage.setItem(`${POST_DRAFT_PREFIX}new:garbage`, '{not json');
    storage.setItem('another.app.item', 'kept');
    sweepPostDrafts(storage, NOW + POST_DRAFT_TTL_MS + 1);
    expect([...storage.items.keys()].sort()).toEqual(
      ['another.app.item', postDraftStorageKey(EDIT)].sort(),
    );
    // Keeping sweeps too.
    keepPostDraft(storage, NEW, ACCOUNT, DRAFT, NOW + 3 * POST_DRAFT_TTL_MS);
    expect([...storage.items.keys()].sort()).toEqual(
      ['another.app.item', postDraftStorageKey(NEW)].sort(),
    );
  });

  it('is cleared for one screen, or all of them (signing out), and nothing else', () => {
    const storage = new MemoryStorage();
    keepPostDraft(storage, NEW, ACCOUNT, DRAFT, NOW);
    keepPostDraft(storage, EDIT, ACCOUNT, DRAFT, NOW);
    storage.setItem('another.app.item', 'kept');
    clearPostDraft(storage, EDIT);
    expect(readPostDraft(storage, EDIT, ACCOUNT, NOW)).toBeNull();
    expect(readPostDraft(storage, NEW, ACCOUNT, NOW)).toEqual(DRAFT);
    clearPostDrafts(storage);
    expect([...storage.items.keys()]).toEqual(['another.app.item']);
  });
});

describe('what is not a draft', () => {
  it('reads nothing from an item it did not write, and drops it', () => {
    for (const raw of [
      '{not json',
      'null',
      '[]',
      JSON.stringify({ version: 2, accountId: ACCOUNT, savedAt: NOW, title: '', body: {} }),
      JSON.stringify({ version: 1, accountId: ACCOUNT, savedAt: NOW, title: 1, body: {} }),
      JSON.stringify({ version: 1, accountId: ACCOUNT, savedAt: '0', title: '', body: {} }),
      JSON.stringify({
        version: 1,
        accountId: ACCOUNT,
        savedAt: NOW,
        title: '',
        body: { type: 'paragraph' },
      }),
    ]) {
      const storage = new MemoryStorage();
      storage.setItem(postDraftStorageKey(NEW), raw);
      expect(readPostDraft(storage, NEW, ACCOUNT, NOW), raw).toBeNull();
      expect(storage.items.size, raw).toBe(0);
    }
  });

  it('keeps only previews that are image data URLs under media ids: nothing a page could run', () => {
    const storage = new MemoryStorage();
    keepPostDraft(
      storage,
      NEW,
      ACCOUNT,
      {
        ...DRAFT,
        previews: {
          [IMAGE]: PREVIEW,
          'not-a-uuid': PREVIEW,
          'd4e5f6a7-0000-4000-8000-000000000004': 'javascript:alert(1)',
          'e5f6a7b8-0000-4000-8000-000000000005': 'data:image/svg+xml;base64,PHN2Zz4=',
          'f6a7b8c9-0000-4000-8000-000000000006': 'https://evil.example/x.png',
          'a7b8c9d0-0000-4000-8000-000000000007': 'data:text/html;base64,PGI+',
        },
      },
      NOW,
    );
    expect(readPostDraft(storage, NEW, ACCOUNT, NOW)?.previews).toEqual({ [IMAGE]: PREVIEW });
    // And so for an item written by hand.
    const raw = JSON.parse(storage.getItem(postDraftStorageKey(NEW)) ?? '{}') as Record<
      string,
      unknown
    >;
    storage.setItem(
      postDraftStorageKey(NEW),
      JSON.stringify({ ...raw, previews: { [IMAGE]: 'data:image/png;base64,AA"><script>' } }),
    );
    expect(readPostDraft(storage, NEW, ACCOUNT, NOW)?.previews).toEqual({});
  });
});

describe('a storage that is full or refused', () => {
  it('keeps the draft without its previews when they do not fit, and nothing when the text does not', () => {
    const withoutPreviews = JSON.stringify({
      version: 1,
      accountId: ACCOUNT,
      savedAt: NOW,
      title: DRAFT.title,
      body: DRAFT.body,
      previews: {},
    });
    const fits = postDraftStorageKey(NEW).length + withoutPreviews.length;
    const storage = new MemoryStorage(fits);
    expect(keepPostDraft(storage, NEW, ACCOUNT, DRAFT, NOW)).toBe(true);
    expect(readPostDraft(storage, NEW, ACCOUNT, NOW)).toEqual({ ...DRAFT, previews: {} });

    const tiny = new MemoryStorage(fits - 1);
    expect(keepPostDraft(tiny, NEW, ACCOUNT, DRAFT, NOW)).toBe(false);
    expect(tiny.items.size).toBe(0);
  });

  it('neither throws nor keeps nor reads where the browser refuses the storage', () => {
    expect(keepPostDraft(refusing, NEW, ACCOUNT, DRAFT, NOW)).toBe(false);
    expect(readPostDraft(refusing, NEW, ACCOUNT, NOW)).toBeNull();
    expect(() => {
      clearPostDraft(refusing, NEW);
      clearPostDrafts(refusing);
      sweepPostDrafts(refusing, NOW);
    }).not.toThrow();
  });
});

describe('when a screen going away keeps its draft', () => {
  const stepLeft = { nextStep: 'consent' } as Onboarding;
  const nothingLeft = { nextStep: null } as Onboarding;

  it('keeps a draft with something to lose when the account has a step left: the gate', () => {
    expect(shouldKeepPostDraft({ hasDraft: true, saved: false, onboarding: stepLeft })).toBe(true);
    for (const nextStep of ['verification', 'nickname'] as const) {
      expect(
        shouldKeepPostDraft({
          hasDraft: true,
          saved: false,
          onboarding: { nextStep } as Onboarding,
        }),
      ).toBe(true);
    }
  });

  it('keeps nothing on any other leave — a link or Back asked first — nor once the write is saved', () => {
    expect(shouldKeepPostDraft({ hasDraft: true, saved: false, onboarding: nothingLeft })).toBe(
      false,
    );
    expect(shouldKeepPostDraft({ hasDraft: true, saved: false, onboarding: undefined })).toBe(
      false,
    );
    expect(shouldKeepPostDraft({ hasDraft: false, saved: false, onboarding: stepLeft })).toBe(
      false,
    );
    expect(shouldKeepPostDraft({ hasDraft: true, saved: true, onboarding: stepLeft })).toBe(false);
  });
});

describe('what a form has to keep', () => {
  const blank = { title: '', initialTitle: null, bodyChanged: false, restored: false };

  it('is a changed title or body, or a draft taken back', () => {
    expect(hasDraftToKeep({ ...blank, title: '새 제목' })).toBe(true);
    expect(hasDraftToKeep({ ...blank, bodyChanged: true })).toBe(true);
    expect(hasDraftToKeep({ ...blank, restored: true })).toBe(true);
    // The edit screen: a title changed from the saved one.
    expect(hasDraftToKeep({ ...blank, title: '고친 제목', initialTitle: '저장된 제목' })).toBe(
      true,
    );
  });

  it('is nothing for a form whose only change is an image still uploading — the draft cannot carry it', () => {
    // The blank write screen and the untouched edit screen: `draftChanged` asks before leaving
    // them while an upload is in flight, but there is nothing here to keep, nor to "restore".
    expect(hasDraftToKeep(blank)).toBe(false);
    expect(hasDraftToKeep({ ...blank, title: '저장된 제목', initialTitle: '저장된 제목' })).toBe(
      false,
    );
    // Spaces at either end are no change, as the leave guard and the server count them.
    expect(hasDraftToKeep({ ...blank, title: '  저장된 제목 ', initialTitle: '저장된 제목' })).toBe(
      false,
    );
    expect(hasDraftToKeep({ ...blank, title: '   ' })).toBe(false);
  });
});

describe('a write that landed', () => {
  it('counts for the forms of its screen rendered before it, not after, nor for another screen', () => {
    const before = postDraftMoment();
    expect(postDraftLandedSince(NEW, before)).toBe(false);
    postDraftLanded(NEW);
    expect(postDraftLandedSince(NEW, before)).toBe(true);
    expect(postDraftLandedSince({ kind: 'new', marketId: MARKET.toLowerCase() }, before)).toBe(
      true,
    );
    expect(postDraftLandedSince(EDIT, before)).toBe(false);
    // A form of that screen drawn afterwards — another post on the same market — keeps again.
    expect(postDraftLandedSince(NEW, postDraftMoment())).toBe(false);
  });
});

describe('the size of a kept preview', () => {
  it('fits the longer side in DRAFT_PREVIEW_MAX_SIDE, keeping the shape', () => {
    expect(DRAFT_PREVIEW_MAX_SIDE).toBe(640);
    expect(previewSize(4032, 3024)).toEqual({ width: 640, height: 480 });
    expect(previewSize(1080, 1920)).toEqual({ width: 360, height: 640 });
    expect(previewSize(2048, 2048, 512)).toEqual({ width: 512, height: 512 });
  });

  it('never enlarges, and keeps at least a pixel on each side', () => {
    expect(previewSize(1, 1)).toEqual({ width: 1, height: 1 });
    expect(previewSize(300, 200)).toEqual({ width: 300, height: 200 });
    expect(previewSize(20_000, 10)).toEqual({ width: 640, height: 1 });
    expect(previewSize(0, 0)).toEqual({ width: 1, height: 1 });
  });
});
