import { type MarketStatus } from '@buddha/shared';
import { showsOrderArea } from './market-detail';
import { type OrderInput, initialOrderInput } from './order-panel';
import { type DraftStorage, POST_DRAFT_TTL_MS } from './post-drafts';

/**
 * 로그인 뒤 주문 입력 복원 (#66, ADR-0140; ADR-0135 D3·D4, owner answer 66-Q4): what a visitor typed
 * into the order panel, kept in THIS tab's sessionStorage while they sign in, and given back once
 * when they come back to the same market within the hour — never submitted, never past a status
 * that has no order area. A new tab starts with an empty sessionStorage, so it restores nothing;
 * the 인증 링크 opened in the same tab clears it (`/set-password`). A tab duplicated or reopened by
 * the browser carries it, as every draft of this app.
 *
 * The first draft kept with no owner: a visitor has no account, so the key is the market's alone
 * and whoever signs in in this tab within the hour gets it — nothing is sent for them. 로그아웃 and
 * 탈퇴 clear it (`forgetAccountInTab`). Only the input: no quote, no book, nothing personal.
 *
 * Pure functions over a `DraftStorage` and a clock, plus the browser's binding at the end; none of
 * it throws.
 */

/** How long a kept input waits: the post drafts' hour (ADR-0135 P5, a code constant). */
export const ORDER_DRAFT_TTL_MS = POST_DRAFT_TTL_MS;

export const ORDER_DRAFT_PREFIX = 'buddha.orderDraft:';

const ORDER_DRAFT_VERSION = 1;

export function orderDraftStorageKey(marketId: string): string {
  return `${ORDER_DRAFT_PREFIX}${marketId.toLowerCase()}`;
}

interface StoredOrderDraft {
  version: typeof ORDER_DRAFT_VERSION;
  savedAt: number;
  marketId: string;
  slug: string;
  input: OrderInput;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32;
}

/** The input a stored value holds, or null for anything that is not one this version wrote. */
function inputOf(raw: unknown): OrderInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const base = initialOrderInput();
  if (value.outcome !== 'YES' && value.outcome !== 'NO') return null;
  if (value.side !== 'buy' && value.side !== 'sell') return null;
  if (value.kind !== 'ioc' && value.kind !== 'gtc') return null;
  if (value.size !== 'qty' && value.size !== 'budget') return null;
  if (!isText(value.qty) || !isText(value.budget) || !isText(value.limit)) return null;
  return {
    ...base,
    outcome: value.outcome,
    side: value.side,
    kind: value.kind,
    size: value.size,
    qty: value.qty,
    budget: value.budget,
    limit: value.limit,
  };
}

function parseStored(raw: string): StoredOrderDraft | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const stored = value as Record<string, unknown>;
  if (stored.version !== ORDER_DRAFT_VERSION) return null;
  if (typeof stored.savedAt !== 'number' || !Number.isFinite(stored.savedAt)) return null;
  if (typeof stored.marketId !== 'string' || typeof stored.slug !== 'string') return null;
  const input = inputOf(stored.input);
  if (input === null) return null;
  return {
    version: ORDER_DRAFT_VERSION,
    savedAt: stored.savedAt,
    marketId: stored.marketId,
    slug: stored.slug,
    input,
  };
}

function isExpired(stored: StoredOrderDraft, now: number): boolean {
  return now - stored.savedAt > ORDER_DRAFT_TTL_MS;
}

function tryRemove(storage: DraftStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // A storage that refuses leaves the item for the next sweep or the tab's end.
  }
}

function orderDraftKeys(storage: DraftStorage): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.startsWith(ORDER_DRAFT_PREFIX)) keys.push(key);
    }
  } catch {
    return keys;
  }
  return keys;
}

/** Removes every kept input past the hour, and every item under the prefix that is none. */
export function sweepOrderDrafts(storage: DraftStorage, now: number): void {
  for (const key of orderDraftKeys(storage)) {
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      return;
    }
    const stored = raw === null ? null : parseStored(raw);
    if (stored === null || isExpired(stored, now)) tryRemove(storage, key);
  }
}

/** Keeps the input typed on `marketId`, sweeping the expired ones first. False if refused. */
export function keepOrderDraft(
  storage: DraftStorage,
  market: { id: string; slug: string },
  input: OrderInput,
  now: number,
): boolean {
  sweepOrderDrafts(storage, now);
  const stored: StoredOrderDraft = {
    version: ORDER_DRAFT_VERSION,
    savedAt: now,
    marketId: market.id.toLowerCase(),
    slug: market.slug,
    input,
  };
  try {
    storage.setItem(orderDraftStorageKey(market.id), JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

/** The input kept for `marketId`, or null; an expired, broken or other version's is removed. */
export function readOrderDraft(
  storage: DraftStorage,
  marketId: string,
  now: number,
): OrderInput | null {
  const key = orderDraftStorageKey(marketId);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const stored = parseStored(raw);
  if (stored === null || isExpired(stored, now) || stored.marketId !== marketId.toLowerCase()) {
    tryRemove(storage, key);
    return null;
  }
  return stored.input;
}

export function clearOrderDraft(storage: DraftStorage, marketId: string): void {
  tryRemove(storage, orderDraftStorageKey(marketId));
}

export function clearOrderDrafts(storage: DraftStorage): void {
  for (const key of orderDraftKeys(storage)) tryRemove(storage, key);
}

/**
 * Whether a kept input comes back now (D4, ADR-0135 결과 4 'D4'): the reader is signed in with
 * `me` and the restriction known, the market has its order area (거래 중 — one paused and resumed
 * meanwhile too; the quote is read afresh), and the account may order (D13: one that may not
 * would get 주문 확인 off, so its input is dropped). Any other answer drops the input.
 */
export type DraftFate = 'wait' | 'restore' | 'drop';

export function orderDraftFate(facts: {
  signedIn: boolean | undefined;
  accountKnown: boolean;
  status: MarketStatus | undefined;
  mayOrder: boolean;
}): DraftFate {
  if (facts.signedIn !== true || !facts.accountKnown || facts.status === undefined) return 'wait';
  if (!showsOrderArea(facts.status) || !facts.mayOrder) return 'drop';
  return 'restore';
}

// ---- this tab's sessionStorage --------------------------------------------------------------

function sessionDrafts(): DraftStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function keepSessionOrderDraft(market: { id: string; slug: string }, input: OrderInput) {
  const storage = sessionDrafts();
  return storage === null ? false : keepOrderDraft(storage, market, input, Date.now());
}

export function readSessionOrderDraft(marketId: string): OrderInput | null {
  const storage = sessionDrafts();
  return storage === null ? null : readOrderDraft(storage, marketId, Date.now());
}

export function clearSessionOrderDraft(marketId: string): void {
  const storage = sessionDrafts();
  if (storage !== null) clearOrderDraft(storage, marketId);
}

export function clearSessionOrderDrafts(): void {
  const storage = sessionDrafts();
  if (storage !== null) clearOrderDrafts(storage);
}
