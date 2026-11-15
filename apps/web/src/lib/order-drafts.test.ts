import { describe, expect, it } from 'vitest';
import {
  ORDER_DRAFT_TTL_MS,
  clearOrderDraft,
  clearOrderDrafts,
  keepOrderDraft,
  orderDraftFate,
  orderDraftStorageKey,
  readOrderDraft,
  sweepOrderDrafts,
} from './order-drafts';
import { type OrderInput, initialOrderInput } from './order-panel';
import { type DraftStorage, POST_DRAFT_TTL_MS } from './post-drafts';

/**
 * 로그인 뒤 주문 입력 복원 (#66, ADR-0140; ADR-0135 D3·D4, owner answer 66-Q4): a visitor's input,
 * kept in the tab for the hour (P5's constant) and given back once — never past a status with no
 * order area, never to an account that may not order.
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

/** A storage that refuses everything, as a private window may. */
const refusing: DraftStorage = {
  get length(): number {
    throw new Error('denied');
  },
  key: () => {
    throw new Error('denied');
  },
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

const MARKET = { id: '3F2504E0-4F89-11D3-9A0C-0305E82C3301', slug: 'rate-cut' };
const NOW = 1_800_000_000_000;
const INPUT: OrderInput = { ...initialOrderInput('NO'), kind: 'gtc', qty: '3', limit: '40' };

describe('keepOrderDraft and readOrderDraft', () => {
  it('keeps the hour of a post draft (P5)', () => {
    expect(ORDER_DRAFT_TTL_MS).toBe(POST_DRAFT_TTL_MS);
    expect(ORDER_DRAFT_TTL_MS).toBe(60 * 60 * 1000);
  });

  it('gives the input back on the same market, under the lower-cased id', () => {
    const storage = new MemoryStorage();
    expect(keepOrderDraft(storage, MARKET, INPUT, NOW)).toBe(true);
    expect([...storage.items.keys()]).toEqual([orderDraftStorageKey(MARKET.id)]);
    expect(orderDraftStorageKey(MARKET.id)).toBe(
      'buddha.orderDraft:3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    );
    expect(readOrderDraft(storage, MARKET.id.toLowerCase(), NOW + ORDER_DRAFT_TTL_MS)).toEqual(
      INPUT,
    );
    // Only the input: no quote, no book, nothing personal.
    const stored = JSON.parse(storage.items.get(orderDraftStorageKey(MARKET.id)) ?? '{}') as object;
    expect(Object.keys(stored).sort()).toEqual(['input', 'marketId', 'savedAt', 'slug', 'version']);
  });

  it('drops one past the hour', () => {
    const storage = new MemoryStorage();
    keepOrderDraft(storage, MARKET, INPUT, NOW);
    expect(readOrderDraft(storage, MARKET.id, NOW + ORDER_DRAFT_TTL_MS + 1)).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it('drops a broken one and one of another version', () => {
    const storage = new MemoryStorage();
    const key = orderDraftStorageKey(MARKET.id);
    storage.setItem(key, '{not json');
    expect(readOrderDraft(storage, MARKET.id, NOW)).toBeNull();
    expect(storage.items.size).toBe(0);
    storage.setItem(
      key,
      JSON.stringify({ version: 2, savedAt: NOW, marketId: MARKET.id, slug: 's', input: INPUT }),
    );
    expect(readOrderDraft(storage, MARKET.id, NOW)).toBeNull();
    expect(storage.items.size).toBe(0);
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        savedAt: NOW,
        marketId: MARKET.id.toLowerCase(),
        slug: 's',
        input: { ...INPUT, side: 'short' },
      }),
    );
    expect(readOrderDraft(storage, MARKET.id, NOW)).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it('sweeps the expired ones as it keeps another, and clears on request', () => {
    const storage = new MemoryStorage();
    const other = { id: '6f9619ff-8b86-4011-b42d-00c04fc964ff', slug: 'other' };
    keepOrderDraft(storage, other, INPUT, NOW);
    keepOrderDraft(storage, MARKET, INPUT, NOW + ORDER_DRAFT_TTL_MS + 1);
    expect([...storage.items.keys()]).toEqual([orderDraftStorageKey(MARKET.id)]);
    storage.setItem('elsewhere', 'kept');
    sweepOrderDrafts(storage, NOW + 3 * ORDER_DRAFT_TTL_MS);
    expect([...storage.items.keys()]).toEqual(['elsewhere']);
    keepOrderDraft(storage, MARKET, INPUT, NOW);
    keepOrderDraft(storage, other, INPUT, NOW);
    clearOrderDraft(storage, MARKET.id);
    expect(readOrderDraft(storage, MARKET.id, NOW)).toBeNull();
    clearOrderDrafts(storage);
    expect([...storage.items.keys()]).toEqual(['elsewhere']);
  });

  it('never throws on a storage that refuses', () => {
    expect(keepOrderDraft(refusing, MARKET, INPUT, NOW)).toBe(false);
    expect(readOrderDraft(refusing, MARKET.id, NOW)).toBeNull();
    expect(() => {
      clearOrderDrafts(refusing);
      sweepOrderDrafts(refusing, NOW);
    }).not.toThrow();
  });
});

describe('orderDraftFate (D4, 결과 4 "D4", 66-Q4)', () => {
  const facts = { signedIn: true, accountKnown: true, status: 'open', mayOrder: true } as const;

  it('restores on an open market for an account that may order', () => {
    expect(orderDraftFate(facts)).toBe('restore');
  });

  it('waits for the sign-in, the account and the market', () => {
    expect(orderDraftFate({ ...facts, signedIn: false })).toBe('wait');
    expect(orderDraftFate({ ...facts, signedIn: undefined })).toBe('wait');
    expect(orderDraftFate({ ...facts, accountKnown: false })).toBe('wait');
    expect(orderDraftFate({ ...facts, status: undefined })).toBe('wait');
  });

  it('drops it on a paused or closed market, and for an account that may not order (D13)', () => {
    expect(orderDraftFate({ ...facts, status: 'paused' })).toBe('drop');
    expect(orderDraftFate({ ...facts, status: 'closed' })).toBe('drop');
    expect(orderDraftFate({ ...facts, status: 'scheduled' })).toBe('drop');
    expect(orderDraftFate({ ...facts, mayOrder: false })).toBe('drop');
  });

  it('reads a kept input until it is cleared, and nothing after', () => {
    // That the provider clears what it read before it restores is pinned in its source
    // (order-panel-provider.test.ts): here, only that a clear empties the slot.
    const storage = new MemoryStorage();
    keepOrderDraft(storage, MARKET, INPUT, NOW);
    expect(readOrderDraft(storage, MARKET.id, NOW)).toEqual(INPUT);
    clearOrderDraft(storage, MARKET.id);
    expect(readOrderDraft(storage, MARKET.id, NOW)).toBeNull();
  });
});
