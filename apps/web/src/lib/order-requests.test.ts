import { afterEach, describe, expect, it, vi } from 'vitest';
import { type PendingOrderRequest } from './order-panel';
import {
  clearOrderRequest,
  clearOrderRequests,
  clearSessionOrderRequest,
  clearSessionOrderRequests,
  keepOrderRequest,
  keepSessionOrderRequest,
  orderRequestStorageKey,
  readOrderRequest,
  readSessionOrderRequest,
  settleOrderRequest,
  settleSessionOrderRequest,
  updateOrderRequest,
  updateSessionOrderRequest,
} from './order-requests';
import { type DraftStorage } from './post-drafts';

/**
 * 미결 주문 요청 (#66, ADR-0140 결정 2): the request a tab sent and holds no settled answer for, under
 * the account and the market, so a reload reads the same id back instead of placing another order.
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

/**
 * A storage that refuses some of its operations and still does the others: one that is full
 * (quota) throws on `setItem` and keeps reading, and the reverse.
 */
type StorageOp = 'get' | 'set' | 'remove' | 'list';

class PartialStorage extends MemoryStorage {
  readonly refused = new Set<StorageOp>();
  private guard(op: StorageOp) {
    if (this.refused.has(op)) throw new Error(`denied: ${op}`);
  }
  override get length() {
    this.guard('list');
    return super.length;
  }
  override key(index: number) {
    this.guard('list');
    return super.key(index);
  }
  override getItem(key: string) {
    this.guard('get');
    return super.getItem(key);
  }
  override setItem(key: string, value: string) {
    this.guard('set');
    super.setItem(key, value);
  }
  override removeItem(key: string) {
    this.guard('remove');
    super.removeItem(key);
  }
}

const ACCOUNT_A = '0b1c2d3e-0000-4000-8000-000000000001';
const ACCOUNT_B = '0b1c2d3e-0000-4000-8000-000000000002';
const MARKET = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
const OTHER_MARKET = '6f9619ff-8b86-4011-b42d-00c04fc964ff';

const REQUEST: PendingOrderRequest = {
  requestId: '7a9619ff-8b86-4011-b42d-00c04fc964aa',
  sendId: '9c9619ff-8b86-4011-b42d-00c04fc964c1',
  body: {
    outcome: 'YES',
    side: 'buy',
    timeInForce: 'ioc',
    limitPriceCoin: 65,
    qty: 2,
    expectedAccountId: ACCOUNT_A,
  },
  savedAt: 1_800_000_000_000,
  phase: 'first',
};

describe('the kept order request', () => {
  it('is kept per account and market, the market lower-cased', () => {
    const storage = new MemoryStorage();
    keepOrderRequest(storage, ACCOUNT_A, MARKET, REQUEST);
    expect([...storage.items.keys()]).toEqual([
      'buddha:order-request:0b1c2d3e-0000-4000-8000-000000000001:3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    ]);
    expect(orderRequestStorageKey(ACCOUNT_A, MARKET)).toBe([...storage.items.keys()][0]);
    expect(readOrderRequest(storage, ACCOUNT_A, MARKET.toLowerCase())).toEqual(REQUEST);
    // Another account's tab, another market: nothing.
    expect(readOrderRequest(storage, ACCOUNT_B, MARKET)).toBeNull();
    expect(readOrderRequest(storage, ACCOUNT_A, OTHER_MARKET)).toBeNull();
  });

  it('keeps its phase, so a lost answer is read back as one after a reload', () => {
    const storage = new MemoryStorage();
    keepOrderRequest(storage, ACCOUNT_A, MARKET, { ...REQUEST, phase: 'unknown' });
    expect(readOrderRequest(storage, ACCOUNT_A, MARKET)?.phase).toBe('unknown');
  });

  it('drops one that does not read', () => {
    const storage = new MemoryStorage();
    const key = orderRequestStorageKey(ACCOUNT_A, MARKET);
    storage.setItem(key, '{broken');
    expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
    expect(storage.items.size).toBe(0);
    storage.setItem(key, JSON.stringify({ ...REQUEST, requestId: 'has spaces' }));
    expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
    storage.setItem(key, JSON.stringify({ ...REQUEST, phase: 'sent' }));
    expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
    // One that names no send: no send's end could be told from another's.
    const { sendId: _sendId, ...sendless } = REQUEST;
    storage.setItem(key, JSON.stringify(sendless));
    expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
    storage.setItem(key, JSON.stringify({ ...REQUEST, sendId: '' }));
    expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it('clears one, or every account’s on 로그아웃 and 탈퇴', () => {
    const storage = new MemoryStorage();
    storage.setItem('elsewhere', 'kept');
    keepOrderRequest(storage, ACCOUNT_A, MARKET, REQUEST);
    keepOrderRequest(storage, ACCOUNT_B, OTHER_MARKET, REQUEST);
    clearOrderRequest(storage, ACCOUNT_A, MARKET, REQUEST.requestId);
    expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
    expect(readOrderRequest(storage, ACCOUNT_B, OTHER_MARKET)).toEqual(REQUEST);
    clearOrderRequests(storage);
    expect([...storage.items.keys()]).toEqual(['elsewhere']);
  });

  it('neither drops nor covers another request’s id: a late answer of an older one', () => {
    const storage = new MemoryStorage();
    const newer: PendingOrderRequest = {
      ...REQUEST,
      requestId: '8b9619ff-8b86-4011-b42d-00c04fc964bb',
      savedAt: REQUEST.savedAt + 60_000,
    };
    keepOrderRequest(storage, ACCOUNT_A, MARKET, newer);
    // The older request's settled end (its send is the same, its id is not), its read-back or
    // '버리기', and its lost answer: the newer one stays as it was.
    settleOrderRequest(storage, ACCOUNT_A, MARKET, REQUEST);
    clearOrderRequest(storage, ACCOUNT_A, MARKET, REQUEST.requestId);
    updateOrderRequest(storage, ACCOUNT_A, MARKET, { ...REQUEST, phase: 'unknown' });
    expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toEqual(newer);
    // Its own id: written again, then dropped.
    updateOrderRequest(storage, ACCOUNT_A, MARKET, { ...newer, phase: 'unknown' });
    expect(readOrderRequest(storage, ACCOUNT_A, MARKET)?.phase).toBe('unknown');
    clearOrderRequest(storage, ACCOUNT_A, MARKET, newer.requestId);
    expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
    // An empty slot ('버리기', 로그아웃) is not filled again by a late answer.
    updateOrderRequest(storage, ACCOUNT_A, MARKET, { ...REQUEST, phase: 'unknown' });
    expect(storage.items.size).toBe(0);
  });

  /**
   * The same id in flight twice (결정 2-5): the first POST still pending on a page that was left,
   * the request read back three times as not found on the page come back to, and sent again with
   * the same id — a send of its own. Whatever the older send ends in, the record the newer one
   * is read back by after a reload stays, or a fresh order would be offered beside its order.
   */
  describe('sent again with the same id while an older send is in flight', () => {
    const first: PendingOrderRequest = REQUEST;
    const again: PendingOrderRequest = {
      ...REQUEST,
      sendId: '9c9619ff-8b86-4011-b42d-00c04fc964c2',
      phase: 'unknown',
    };
    const resent = () => {
      const storage = new MemoryStorage();
      keepOrderRequest(storage, ACCOUNT_A, MARKET, first);
      keepOrderRequest(storage, ACCOUNT_A, MARKET, again);
      return storage;
    };

    it('keeps the newer send’s record when the older one is refused', () => {
      const storage = resent();
      // The first POST's late definite refusal (an enveloped 429, say).
      settleOrderRequest(storage, ACCOUNT_A, MARKET, first);
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toEqual(again);
      // The resend's own answer is then lost: still there for a reload to read back.
      updateOrderRequest(storage, ACCOUNT_A, MARKET, { ...again, phase: 'unknown' });
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toEqual(again);
    });

    it('keeps it when the older one answers with the order, or loses its answer', () => {
      const storage = resent();
      // The same call ends a success and a refusal: the newer send settles its own record.
      settleOrderRequest(storage, ACCOUNT_A, MARKET, first);
      // A lost answer of the older send writes nothing over it either (`sendId`, `savedAt`).
      updateOrderRequest(storage, ACCOUNT_A, MARKET, {
        ...first,
        savedAt: first.savedAt - 1,
        phase: 'unknown',
      });
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toEqual(again);
    });

    it('is settled by the newer send, and stays empty for the older one after it', () => {
      const storage = resent();
      settleOrderRequest(storage, ACCOUNT_A, MARKET, again);
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
      updateOrderRequest(storage, ACCOUNT_A, MARKET, { ...first, phase: 'unknown' });
      settleOrderRequest(storage, ACCOUNT_A, MARKET, first);
      expect(storage.items.size).toBe(0);
    });

    it('is dropped by the request’s own end whichever send keeps it', () => {
      // The order read back by its id, or '버리기': the request, not one send of it.
      const storage = resent();
      clearOrderRequest(storage, ACCOUNT_A, MARKET, first.requestId);
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
    });

    it('lets a send that still holds the slot settle it or mark its answer lost', () => {
      // No resend yet: the page was left and come back to, and the first send ends.
      const storage = new MemoryStorage();
      keepOrderRequest(storage, ACCOUNT_A, MARKET, first);
      updateOrderRequest(storage, ACCOUNT_A, MARKET, { ...first, phase: 'unknown' });
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toEqual({ ...first, phase: 'unknown' });
      settleOrderRequest(storage, ACCOUNT_A, MARKET, first);
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
    });

    it('holds in the page’s memory too', () => {
      keepOrderRequest(refusing, ACCOUNT_A, MARKET, first);
      keepOrderRequest(refusing, ACCOUNT_A, MARKET, again);
      settleOrderRequest(refusing, ACCOUNT_A, MARKET, first);
      expect(readOrderRequest(refusing, ACCOUNT_A, MARKET)).toEqual(again);
      settleOrderRequest(refusing, ACCOUNT_A, MARKET, again);
      expect(readOrderRequest(refusing, ACCOUNT_A, MARKET)).toBeNull();
    });
  });

  it('falls back to the page’s memory when the storage refuses', () => {
    keepOrderRequest(refusing, ACCOUNT_A, MARKET, REQUEST);
    expect(readOrderRequest(refusing, ACCOUNT_A, MARKET)).toEqual(REQUEST);
    clearOrderRequest(refusing, ACCOUNT_A, MARKET, REQUEST.requestId);
    expect(readOrderRequest(refusing, ACCOUNT_A, MARKET)).toBeNull();
    keepOrderRequest(refusing, ACCOUNT_A, MARKET, REQUEST);
    clearOrderRequests(refusing);
    expect(readOrderRequest(refusing, ACCOUNT_A, MARKET)).toBeNull();
  });

  /**
   * One current value per slot (결정 2-5): the latest write or removal, wherever it landed. A
   * storage refuses one operation and still does another — a full one (quota) throws on `setItem`
   * and reads on — so the text it reads can be older than what this page kept in memory, and
   * memory can be older than what the storage took since. Neither answers for the slot then.
   */
  describe('a storage that refuses some operations', () => {
    const KEY = orderRequestStorageKey(ACCOUNT_A, MARKET);
    const first: PendingOrderRequest = REQUEST;
    const again: PendingOrderRequest = {
      ...REQUEST,
      sendId: '9c9619ff-8b86-4011-b42d-00c04fc964c2',
      phase: 'unknown',
    };
    const storedText = (storage: MemoryStorage) => storage.items.get(KEY);

    /** The first send kept while the storage wrote; full by the time the same id is sent again. */
    const resentWhileFull = () => {
      const storage = new PartialStorage();
      keepOrderRequest(storage, ACCOUNT_A, MARKET, first);
      storage.refused.add('set');
      keepOrderRequest(storage, ACCOUNT_A, MARKET, again);
      return storage;
    };

    it('reads the newer send from memory, not the older one the full storage still holds', () => {
      const storage = resentWhileFull();
      expect(storedText(storage)).toBe(JSON.stringify(first));
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toEqual(again);
    });

    it('keeps the newer send in memory through the older send’s late end', () => {
      const storage = resentWhileFull();
      // The first POST's late order or refusal, then its lost answer: not this send's slot.
      settleOrderRequest(storage, ACCOUNT_A, MARKET, first);
      updateOrderRequest(storage, ACCOUNT_A, MARKET, { ...first, phase: 'unknown' });
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toEqual(again);
      // The resend's own lost answer is written (to memory again) and read back.
      const lost: PendingOrderRequest = { ...again, savedAt: again.savedAt + 1 };
      updateOrderRequest(storage, ACCOUNT_A, MARKET, lost);
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toEqual(lost);
    });

    it('empties memory and the storage’s older text when the newer send settles', () => {
      const storage = resentWhileFull();
      settleOrderRequest(storage, ACCOUNT_A, MARKET, again);
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
      expect(storage.items.size).toBe(0);
      // The older send's late answer finds an empty slot and leaves it so.
      updateOrderRequest(storage, ACCOUNT_A, MARKET, { ...first, phase: 'unknown' });
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
    });

    it('empties both by the request’s own end, and on 로그아웃', () => {
      const cleared = resentWhileFull();
      clearOrderRequest(cleared, ACCOUNT_A, MARKET, again.requestId);
      expect(readOrderRequest(cleared, ACCOUNT_A, MARKET)).toBeNull();
      expect(cleared.items.size).toBe(0);

      const signedOut = resentWhileFull();
      signedOut.items.set('elsewhere', 'kept');
      // A market whose only record is in memory (the storage was full at its first send).
      keepOrderRequest(signedOut, ACCOUNT_B, OTHER_MARKET, first);
      expect(readOrderRequest(signedOut, ACCOUNT_B, OTHER_MARKET)).toEqual(first);
      clearOrderRequests(signedOut);
      expect(readOrderRequest(signedOut, ACCOUNT_A, MARKET)).toBeNull();
      expect(readOrderRequest(signedOut, ACCOUNT_B, OTHER_MARKET)).toBeNull();
      expect([...signedOut.items.keys()]).toEqual(['elsewhere']);
    });

    it('lets a later write that lands replace memory: nothing older shadows the storage', () => {
      const storage = resentWhileFull();
      storage.refused.delete('set');
      const lost: PendingOrderRequest = { ...again, savedAt: again.savedAt + 1 };
      updateOrderRequest(storage, ACCOUNT_A, MARKET, lost);
      expect(storedText(storage)).toBe(JSON.stringify(lost));
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toEqual(lost);
      // The storage answers for the slot again: emptied there, memory's `again` is not read.
      storage.items.delete(KEY);
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
      // And a send's end settles the storage's record, not a memory one.
      keepOrderRequest(storage, ACCOUNT_A, MARKET, first);
      settleOrderRequest(storage, ACCOUNT_A, MARKET, again);
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toEqual(first);
      settleOrderRequest(storage, ACCOUNT_A, MARKET, first);
      expect(storage.items.size).toBe(0);
    });

    it('keeps a removal the storage refuses: the text it still reads does not come back', () => {
      const storage = new PartialStorage();
      keepOrderRequest(storage, ACCOUNT_A, MARKET, first);
      storage.refused.add('remove');
      settleOrderRequest(storage, ACCOUNT_A, MARKET, first);
      expect(storedText(storage)).toBe(JSON.stringify(first));
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
      // A late lost answer of that send does not fill the emptied slot from the stored text.
      updateOrderRequest(storage, ACCOUNT_A, MARKET, { ...first, phase: 'unknown' });
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
      // 로그아웃 and the request's end while it is refused: still empty, nothing thrown.
      clearOrderRequest(storage, ACCOUNT_A, MARKET, first.requestId);
      clearOrderRequests(storage);
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
      // The next request's write lands over it and is the slot's.
      keepOrderRequest(storage, ACCOUNT_A, MARKET, again);
      expect(storedText(storage)).toBe(JSON.stringify(again));
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toEqual(again);
    });

    it('drops text that does not read even when the storage refuses the removal', () => {
      const storage = new PartialStorage();
      storage.items.set(KEY, '{broken');
      storage.refused.add('remove');
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
    });

    it('answers a storage whose reads throw with what this page last wrote to it', () => {
      // The reverse: `setItem` works, `getItem` throws.
      const storage = new PartialStorage();
      storage.refused.add('get');
      keepOrderRequest(storage, ACCOUNT_A, MARKET, first);
      expect(storedText(storage)).toBe(JSON.stringify(first));
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toEqual(first);
      keepOrderRequest(storage, ACCOUNT_A, MARKET, again);
      settleOrderRequest(storage, ACCOUNT_A, MARKET, first);
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toEqual(again);
      expect(storedText(storage)).toBe(JSON.stringify(again));
      // The send's own end removes it from the storage too; nothing is left to read later.
      settleOrderRequest(storage, ACCOUNT_A, MARKET, again);
      expect(storage.items.size).toBe(0);
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
      storage.refused.delete('get');
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
    });

    it('takes the storage’s text over this page’s last write once its reads work', () => {
      const storage = new PartialStorage();
      keepOrderRequest(storage, ACCOUNT_A, MARKET, first);
      storage.refused.add('get');
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toEqual(first);
      storage.refused.delete('get');
      storage.items.set(KEY, JSON.stringify(again));
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toEqual(again);
    });

    it('clears on 로그아웃 the records of a storage that does not list its keys', () => {
      const storage = new PartialStorage();
      keepOrderRequest(storage, ACCOUNT_A, MARKET, first);
      keepOrderRequest(storage, ACCOUNT_B, OTHER_MARKET, first);
      storage.refused.add('list');
      clearOrderRequests(storage);
      expect(readOrderRequest(storage, ACCOUNT_A, MARKET)).toBeNull();
      expect(readOrderRequest(storage, ACCOUNT_B, OTHER_MARKET)).toBeNull();
      expect(storage.items.size).toBe(0);
    });

    it('keeps memory per storage: a refused write is not read through another storage', () => {
      const full = new PartialStorage();
      full.refused.add('set');
      keepOrderRequest(full, ACCOUNT_A, MARKET, first);
      expect(readOrderRequest(full, ACCOUNT_A, MARKET)).toEqual(first);
      expect(readOrderRequest(new MemoryStorage(), ACCOUNT_A, MARKET)).toBeNull();
    });

    it('never throws, whatever the storage refuses', () => {
      const ops: StorageOp[] = ['get', 'set', 'remove', 'list'];
      // Every subset of the four operations.
      for (let mask = 0; mask < 1 << ops.length; mask += 1) {
        const storage = new PartialStorage();
        keepOrderRequest(storage, ACCOUNT_A, MARKET, first);
        ops.forEach((op, bit) => {
          if ((mask & (1 << bit)) !== 0) storage.refused.add(op);
        });
        expect(() => {
          keepOrderRequest(storage, ACCOUNT_A, MARKET, again);
          updateOrderRequest(storage, ACCOUNT_A, MARKET, again);
          readOrderRequest(storage, ACCOUNT_A, MARKET);
          settleOrderRequest(storage, ACCOUNT_A, MARKET, first);
        }, `mask ${mask}`).not.toThrow();
        // Whatever is refused, the slot's one value is the resend, and its end empties the slot.
        expect(readOrderRequest(storage, ACCOUNT_A, MARKET), `mask ${mask}`).toEqual(again);
        expect(() => {
          settleOrderRequest(storage, ACCOUNT_A, MARKET, again);
          clearOrderRequest(storage, ACCOUNT_A, MARKET, again.requestId);
          clearOrderRequests(storage);
        }, `mask ${mask}`).not.toThrow();
        expect(readOrderRequest(storage, ACCOUNT_A, MARKET), `mask ${mask}`).toBeNull();
      }
    });
  });

  /**
   * The tab's binding (결정 2-5): the page's own storage wherever the browser gives none — no
   * window, a property that throws, and a property that is null (a WebView with DOM storage off).
   * The store keeps its record of the page's writes by the storage object, so a null one must
   * never reach it: the submit calls `keepSessionOrderRequest` between taking the send lock and
   * the send, and a throw there would leave the lock taken.
   */
  describe('this tab’s sessionStorage', () => {
    const lost: PendingOrderRequest = { ...REQUEST, phase: 'unknown' };

    afterEach(() => {
      vi.unstubAllGlobals();
      // The page's memory is the module's: nothing of one test is left for the next.
      clearSessionOrderRequests();
    });

    /** Every wrapper once, as a send, its lost answer, a reload and its end call them. */
    const roundTrip = () => {
      keepSessionOrderRequest(ACCOUNT_A, MARKET, REQUEST);
      expect(readSessionOrderRequest(ACCOUNT_A, MARKET)).toEqual(REQUEST);
      updateSessionOrderRequest(ACCOUNT_A, MARKET, lost);
      expect(readSessionOrderRequest(ACCOUNT_A, MARKET)).toEqual(lost);
      settleSessionOrderRequest(ACCOUNT_A, MARKET, lost);
      expect(readSessionOrderRequest(ACCOUNT_A, MARKET)).toBeNull();
      keepSessionOrderRequest(ACCOUNT_A, MARKET, REQUEST);
      clearSessionOrderRequest(ACCOUNT_A, MARKET, REQUEST.requestId);
      expect(readSessionOrderRequest(ACCOUNT_A, MARKET)).toBeNull();
      keepSessionOrderRequest(ACCOUNT_A, MARKET, REQUEST);
      keepSessionOrderRequest(ACCOUNT_B, OTHER_MARKET, REQUEST);
      clearSessionOrderRequests();
      expect(readSessionOrderRequest(ACCOUNT_A, MARKET)).toBeNull();
      expect(readSessionOrderRequest(ACCOUNT_B, OTHER_MARKET)).toBeNull();
    };

    it('keeps in the browser’s storage where there is one', () => {
      const storage = new MemoryStorage();
      vi.stubGlobal('window', { sessionStorage: storage });
      keepSessionOrderRequest(ACCOUNT_A, MARKET, REQUEST);
      expect(storage.items.get(orderRequestStorageKey(ACCOUNT_A, MARKET))).toBe(
        JSON.stringify(REQUEST),
      );
      expect(roundTrip).not.toThrow();
      expect(storage.items.size).toBe(0);
    });

    it('keeps in the page’s memory with no window', () => {
      expect(typeof window).toBe('undefined');
      expect(roundTrip).not.toThrow();
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
    ])('keeps in the page’s memory where the property is %s, and never throws', (_, none) => {
      vi.stubGlobal('window', { sessionStorage: none });
      expect(roundTrip).not.toThrow();
      // The same memory the page has without a window: one request kept, read back by the next call.
      keepSessionOrderRequest(ACCOUNT_A, MARKET, REQUEST);
      vi.unstubAllGlobals();
      expect(readSessionOrderRequest(ACCOUNT_A, MARKET)).toEqual(REQUEST);
    });

    it('keeps in the page’s memory where touching the property throws', () => {
      vi.stubGlobal('window', {
        get sessionStorage(): never {
          throw new Error('denied');
        },
      });
      expect(roundTrip).not.toThrow();
    });
  });
});
