import { idempotencyKeySchema } from '@buddha/shared';
import { type DraftStorage } from './post-drafts';
import { type PendingOrderRequest } from './order-panel';

/**
 * 미결 주문 요청 (#66, ADR-0140 결정 2): the one order request a tab sent on a market and holds no
 * settled answer for — its id, the body as sent, when, and whether its answer was lost — in this
 * tab's sessionStorage under the account and the market, so a reload (the natural answer to a
 * request that never came back) reads the same id back instead of placing another order. Kept just
 * before the send; dropped on a settled answer, on '버리기', and on 로그아웃·탈퇴. No deadline: it
 * stays until the tab closes (owner answer 66-Q2). A tab the browser duplicates carries it, and
 * its id then replays the same order rather than a second.
 *
 * One slot per account and market, so every write after the send names its request id and
 * touches the slot only while it still holds that id: a late answer of an older request (its page
 * left and came back, and a newer one sent since) neither drops nor covers the newer one.
 *
 * The same id can be in flight twice — the POST of a page that was left, and the same request sent
 * again from the page come back to — so a send's own end (`settleOrderRequest`,
 * `updateOrderRequest`) names its send as well (`sendId`) and touches the slot only while it holds
 * that send: an older send that ends, in an order, a refusal or a lost answer, leaves the record
 * of the newer one, which a reload still reads back. What ends the request itself — the order
 * read back by its id, '버리기' — drops the slot whichever send holds it (`clearOrderRequest`).
 *
 * A storage that throws (private mode, quota) falls back to this page's memory: a request kept for
 * the mounted page beats none. The slot still has ONE current text — the latest write or removal,
 * wherever it landed (`rawOf`): a storage that is full refuses writes while it still reads, and
 * the older text it holds is not the slot's once a newer one went to memory. Nothing here throws.
 */

export const ORDER_REQUEST_PREFIX = 'buddha:order-request:';

export function orderRequestStorageKey(accountId: string, marketId: string): string {
  return `${ORDER_REQUEST_PREFIX}${accountId}:${marketId.toLowerCase()}`;
}

/** The storage of a page that has none (`sessionRequests`: no window, or a browser without it). */
const pageItems = new Map<string, string>();

const memoryStorage: DraftStorage = {
  get length() {
    return pageItems.size;
  },
  key: (index) => [...pageItems.keys()][index] ?? null,
  getItem: (key) => pageItems.get(key) ?? null,
  setItem: (key, value) => {
    pageItems.set(key, value);
  },
  removeItem: (key) => {
    pageItems.delete(key);
  },
};

/**
 * What this page last did to a key of a storage: the text it wrote (null for a removal), and
 * whether the storage took it. One that the storage did not take is the slot's text until a
 * later write or removal lands: a storage that refuses writes may still read, and what it reads
 * is then older than the slot.
 */
interface PageWrite {
  readonly value: string | null;
  readonly landed: boolean;
}

/** Per storage, for this page's life: the keys are this module's only (`orderRequestStorageKey`). */
const pageWrites = new WeakMap<DraftStorage, Map<string, PageWrite>>();

function writesOf(storage: DraftStorage): Map<string, PageWrite> {
  let writes = pageWrites.get(storage);
  if (writes === undefined) {
    writes = new Map();
    pageWrites.set(storage, writes);
  }
  return writes;
}

function parseRequest(raw: string): PendingOrderRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const stored = value as Record<string, unknown>;
  if (typeof stored.requestId !== 'string') return null;
  if (!idempotencyKeySchema.safeParse(stored.requestId).success) return null;
  if (typeof stored.sendId !== 'string' || stored.sendId === '') return null;
  if (typeof stored.savedAt !== 'number' || !Number.isFinite(stored.savedAt)) return null;
  if (stored.phase !== 'first' && stored.phase !== 'unknown') return null;
  if (typeof stored.body !== 'object' || stored.body === null) return null;
  return {
    requestId: stored.requestId,
    sendId: stored.sendId,
    body: stored.body as PendingOrderRequest['body'],
    savedAt: stored.savedAt,
    phase: stored.phase,
  };
}

/**
 * The slot's one current text, the latest write wherever it landed: this page's own while the
 * storage did not take it (a write it refused, a removal it refused — null), else the storage's;
 * and a storage whose read throws answers with what this page last wrote to it.
 */
function rawOf(storage: DraftStorage, key: string): string | null {
  const last = writesOf(storage).get(key);
  if (last !== undefined && !last.landed) return last.value;
  try {
    return storage.getItem(key);
  } catch {
    return last?.value ?? null;
  }
}

/**
 * Writes the slot: to the storage, or to this page's memory, which then answers for the key. The
 * older text a refused write leaves in the storage stays there: memory ends with the page, and a
 * reload then still reads the request id back when it is the same request sent again.
 */
function writeKey(storage: DraftStorage, key: string, value: string): void {
  let landed = true;
  try {
    storage.setItem(key, value);
  } catch {
    landed = false;
  }
  // A write that landed replaces what memory held: nothing older shadows the storage.
  writesOf(storage).set(key, { value, landed });
}

/**
 * Empties the slot in both places: the storage's text (an older one a refused write left there
 * too) and this page's. A removal the storage refuses is kept as one, so the text it still reads
 * does not come back.
 */
function removeKey(storage: DraftStorage, key: string): void {
  const writes = writesOf(storage);
  try {
    storage.removeItem(key);
    writes.delete(key);
  } catch {
    writes.set(key, { value: null, landed: false });
  }
}

/** The request the slot holds now, or null for none (or one that does not read). */
function held(storage: DraftStorage, key: string): PendingOrderRequest | null {
  const raw = rawOf(storage, key);
  return raw === null ? null : parseRequest(raw);
}

/** A send as its own end names it: the request id and the send. */
type SentRequest = Pick<PendingOrderRequest, 'requestId' | 'sendId'>;

/** Whether the slot holds `sent`'s request as that very send keeps it. */
function holdsSend(storage: DraftStorage, key: string, sent: SentRequest): boolean {
  const now = held(storage, key);
  return now !== null && now.requestId === sent.requestId && now.sendId === sent.sendId;
}

/** Keeps `request` in the slot, over whatever it held: the send, just before it goes. */
export function keepOrderRequest(
  storage: DraftStorage,
  accountId: string,
  marketId: string,
  request: PendingOrderRequest,
): void {
  writeKey(storage, orderRequestStorageKey(accountId, marketId), JSON.stringify(request));
}

/**
 * Writes `request` again (its answer lost: `phase: 'unknown'`) only while the slot holds its id
 * as this send keeps it: the same id sent again since has its own record, left as it is.
 * An empty slot stays empty: '버리기' or 로그아웃 emptied it, and a late answer does not bring it back.
 */
export function updateOrderRequest(
  storage: DraftStorage,
  accountId: string,
  marketId: string,
  request: PendingOrderRequest,
): void {
  const key = orderRequestStorageKey(accountId, marketId);
  if (holdsSend(storage, key, request)) {
    keepOrderRequest(storage, accountId, marketId, request);
  }
}

export function readOrderRequest(
  storage: DraftStorage,
  accountId: string,
  marketId: string,
): PendingOrderRequest | null {
  const key = orderRequestStorageKey(accountId, marketId);
  const raw = rawOf(storage, key);
  if (raw === null) return null;
  const request = parseRequest(raw);
  if (request === null) removeKey(storage, key);
  return request;
}

/**
 * A send's own settled end — its order, or a refusal that made none: drops the slot only while it
 * holds `sent`'s id as that very send keeps it. The same id sent again since is another send's to
 * settle: its order may be made after this one was refused, and its answer lost — the record a
 * reload reads it back by, instead of offering a fresh order, stays.
 */
export function settleOrderRequest(
  storage: DraftStorage,
  accountId: string,
  marketId: string,
  sent: SentRequest,
): void {
  const key = orderRequestStorageKey(accountId, marketId);
  if (holdsSend(storage, key, sent)) removeKey(storage, key);
}

/**
 * The request's own end, whichever send keeps it — its order read back by the id, or '버리기':
 * drops the slot only while it holds `requestId`; another request's stays. Never a send's end
 * (`settleOrderRequest`).
 */
export function clearOrderRequest(
  storage: DraftStorage,
  accountId: string,
  marketId: string,
  requestId: string,
): void {
  const key = orderRequestStorageKey(accountId, marketId);
  if (held(storage, key)?.requestId === requestId) removeKey(storage, key);
}

/**
 * Every request kept in the tab, any account's: 로그아웃 and 탈퇴. The keys are the storage's and
 * the ones this page wrote (a storage that does not list them, or that refused the write).
 */
export function clearOrderRequests(storage: DraftStorage): void {
  const keys = new Set(writesOf(storage).keys());
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.startsWith(ORDER_REQUEST_PREFIX)) keys.add(key);
    }
  } catch {
    // The keys read so far, and this page's own.
  }
  for (const key of keys) removeKey(storage, key);
}

// ---- this tab's sessionStorage --------------------------------------------------------------

/**
 * This tab's sessionStorage, or this page's memory where the browser gives none: no window, a
 * property that throws, and a property that is null (a WebView with DOM storage off). Never null
 * itself: the store keeps the page's writes by the storage object (`pageWrites`), and a null one
 * would throw there — out of the submit too, between its send lock and the send.
 */
function sessionRequests(): DraftStorage {
  if (typeof window === 'undefined') return memoryStorage;
  try {
    // Typed as always there; what the browser hands back is not.
    const storage = window.sessionStorage as DraftStorage | null | undefined;
    return storage ?? memoryStorage;
  } catch {
    return memoryStorage;
  }
}

export function keepSessionOrderRequest(
  accountId: string,
  marketId: string,
  request: PendingOrderRequest,
): void {
  keepOrderRequest(sessionRequests(), accountId, marketId, request);
}

export function readSessionOrderRequest(
  accountId: string,
  marketId: string,
): PendingOrderRequest | null {
  return readOrderRequest(sessionRequests(), accountId, marketId);
}

export function updateSessionOrderRequest(
  accountId: string,
  marketId: string,
  request: PendingOrderRequest,
): void {
  updateOrderRequest(sessionRequests(), accountId, marketId, request);
}

export function settleSessionOrderRequest(
  accountId: string,
  marketId: string,
  sent: SentRequest,
): void {
  settleOrderRequest(sessionRequests(), accountId, marketId, sent);
}

export function clearSessionOrderRequest(
  accountId: string,
  marketId: string,
  requestId: string,
): void {
  clearOrderRequest(sessionRequests(), accountId, marketId, requestId);
}

export function clearSessionOrderRequests(): void {
  clearOrderRequests(sessionRequests());
}
