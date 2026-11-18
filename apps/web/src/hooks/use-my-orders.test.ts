import { readFileSync } from 'node:fs';
import path from 'node:path';
import { InfiniteQueryObserver, type QueryClient, QueryObserver } from '@tanstack/react-query';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountToastIds,
  dismissAccountToasts,
  dismissAccountToastsExcept,
} from '@/components/market/order-toasts';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { ApiError, type Me, type Order, api } from '@/lib/api';
import { myOrderKey, myOrdersLiveKey } from '@/lib/market-keys';
import {
  ENDED_CHECK_MAX,
  type OrderPages,
  endedCandidates,
  endedManyText,
  endedNotice,
  watchedReading,
} from '@/lib/my-orders';
import { getQueryClient } from '@/lib/query-client';
import { SRC, scriptKindOf, screenSources } from '@/test/screen-text';
import { ME_QUERY_KEY } from './use-me';
import {
  type CancelVars,
  cancelOrderOptions,
  confirmEnded,
  fetchMyOrder,
  liveOrdersQueryOptions,
  noticeEndedOnDetail,
} from './use-my-orders';
import { forgetAccountInTab } from './use-sign-out';

/**
 * 대기 주문과 주문 상세 (#123, ADR-0141 결정 5·6): the read back of an order that left a watched
 * list, the reading a list or the detail watches from, and whose toast each notice is.
 */

const A = 'account-a';
const B = 'account-b';
const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

function order(id: string, over: Partial<Order> = {}): Order {
  return {
    id,
    requestId: `request-${id}`,
    marketId: MARKET,
    marketSlug: 'rate-cut-2026',
    marketTitle: '기준금리 인하?',
    outcome: 'NO',
    side: 'buy',
    timeInForce: 'gtc',
    limitPriceCoin: 40,
    protectedLimitPriceCoin: 40,
    qty: 3,
    budgetCoin: null,
    filledQty: 0,
    filledAmountCoin: '0',
    cancelledQty: 0,
    unspentCoin: null,
    status: 'open',
    rejectReason: null,
    cancelReason: null,
    createdAt: '2026-11-16T00:00:00.000Z',
    endedAt: null,
    awaitingRecovery: false,
    ...over,
  };
}

const cancelled = (id: string) =>
  order(id, {
    status: 'cancelled',
    cancelReason: 'by_owner',
    cancelledQty: 3,
    endedAt: '2026-11-16T01:00:00.000Z',
  });

/** `GET /me/orders/:id` held open until the test answers it. */
function heldGet() {
  let answer: (order: Order) => void = () => undefined;
  const get = vi.spyOn(api, 'GET').mockReturnValue(
    new Promise((resolve) => {
      answer = (body) => resolve({ data: { data: body }, response: new Response(null) });
    }) as never,
  );
  return { get, answer: (body: Order) => answer(body) };
}

afterEach(() => {
  // The notices are kept under their account for the tab's life (order-toasts.ts): none carries
  // over to the next test.
  dismissAccountToastsExcept(null);
  vi.restoreAllMocks();
});

describe('confirmEnded: the read back writes only the account on screen (결정 5·6)', () => {
  it('writes and tells an ended order while its account is still the one on screen', async () => {
    const client = getQueryClient();
    const id = '0b0b0b0b-0000-4000-8000-000000000001';
    client.setQueryData<Partial<Me>>(ME_QUERY_KEY, { id: A });
    const told = vi.spyOn(toaster, 'create').mockReturnValue('toast');
    const { answer } = heldGet();
    const done = confirmEnded(client, A, [id]);
    answer(cancelled(id));
    await done;
    expect(client.getQueryData<Order>(myOrderKey(id, A))?.status).toBe('cancelled');
    expect(told).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('writes nothing of A once the screen turned to B while the read back was out', async () => {
    const client = getQueryClient();
    const id = '0b0b0b0b-0000-4000-8000-000000000002';
    client.setQueryData<Partial<Me>>(ME_QUERY_KEY, { id: A });
    const told = vi.spyOn(toaster, 'create').mockReturnValue('toast');
    const { answer } = heldGet();
    const done = confirmEnded(client, A, [id]);
    // `['me']` turns to B and SessionCacheGuard resets the private queries; the detached request
    // for A's order is still out.
    client.setQueryData<Partial<Me>>(ME_QUERY_KEY, { id: B });
    await client.resetQueries({ queryKey: ['orders'] });
    answer(cancelled(id));
    await done;
    expect(client.getQueryData(myOrderKey(id, A))).toBeUndefined();
    expect(client.getQueryCache().findAll({ queryKey: ['orders'] })).toEqual([]);
    expect(told).not.toHaveBeenCalled();
    client.clear();
  });
});

/**
 * 결정 2-6 (리뷰, 2026-11-17), ADR-0140 결정 2-25: a notice that says an account's order facts — the
 * end of an order, a cancel that failed on one — is that account's toast, so the session turning
 * to another account or to nobody, the screen's account turning, and the tab's own sign-out or
 * 탈퇴 take it away. The global toaster outlives the account, and a notice of the default few
 * seconds outlives a fast turn.
 */
describe('the order notices are their account’s toasts (결정 2-6)', () => {
  const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
  const uuid = (n: number) => `0c0c0c0c-0000-4000-8000-${String(n).padStart(12, '0')}`;
  type Envelope = ConstructorParameters<typeof ApiError>[1];
  const refusal = (status: number, code: string, details?: unknown) =>
    new ApiError(status, {
      code,
      message: code,
      ...(details === undefined ? {} : { details }),
    } as Envelope);

  /** A client whose screen shows `accountId` (`['me']`). */
  function screenOf(accountId: string): QueryClient {
    const client = getQueryClient();
    client.setQueryData<Partial<Me>>(ME_QUERY_KEY, { id: accountId });
    return client;
  }

  /** The toasts stored since, each with the id the toaster gave it. */
  function stored() {
    const create = vi.spyOn(toaster, 'create');
    return {
      create,
      ids: () => create.mock.results.map((result) => result.value as string),
      options: () => create.mock.calls.map(([options]) => options),
    };
  }

  it('keeps the read back’s one notice under its account: gone when the session turns', async () => {
    const client = screenOf(A);
    const id = uuid(1);
    client.setQueryData(myOrderKey(id, A), cancelled(id));
    const toasts = stored();
    await confirmEnded(client, A, [id]);
    expect(toasts.options()).toMatchObject([{ type: 'info', ...endedNotice(cancelled(id)) }]);
    // The market, the contract and the quantities: A's, kept as A's.
    expect(toasts.options()[0]?.title).toContain('기준금리 인하?');
    expect(accountToastIds(A)).toEqual(toasts.ids());
    expect(accountToastIds(B)).toEqual([]);
    // SessionCacheGuard hears B: every other account's toasts go, a microtask later.
    const dismiss = vi.spyOn(toaster, 'dismiss');
    dismissAccountToastsExcept(B);
    await flush();
    expect(dismiss.mock.calls).toEqual([toasts.ids()]);
    expect(accountToastIds(A)).toEqual([]);
    client.clear();
  });

  it('keeps the count of several ended, with or without the number, under it too', async () => {
    const client = screenOf(A);
    const two = [uuid(11), uuid(12)];
    for (const id of two) client.setQueryData(myOrderKey(id, A), cancelled(id));
    const toasts = stored();
    await confirmEnded(client, A, two);
    expect(toasts.options()).toMatchObject([{ type: 'info', title: endedManyText(2) }]);
    // Past what is read back: the candidates not held are asked, and answer nothing here.
    vi.spyOn(api, 'GET').mockRejectedValue(new Error('not read'));
    const many = Array.from({ length: ENDED_CHECK_MAX + 1 }, (_, at) => uuid(20 + at));
    const first = many[0] ?? '';
    client.setQueryData(myOrderKey(first, A), cancelled(first));
    await confirmEnded(client, A, many);
    expect(toasts.options()[1]).toMatchObject({ type: 'info', title: endedManyText(null) });
    expect(accountToastIds(A)).toEqual(toasts.ids());
    expect(toasts.ids()).toHaveLength(2);
    // The tab's own sign-out or 탈퇴 (`forgetAccountInTab`): all of them.
    const dismiss = vi.spyOn(toaster, 'dismiss');
    forgetAccountInTab(client);
    await flush();
    expect(dismiss.mock.calls.flat().toSorted()).toEqual(toasts.ids().toSorted());
  });

  it('raises the detail’s notice a microtask later, as its account’s', async () => {
    const client = screenOf(A);
    const ended = cancelled(uuid(31));
    const toasts = stored();
    // Called from the detail's effect: nothing is stored while React runs effects (8-37).
    noticeEndedOnDetail(client, A, ended);
    expect(toasts.create).not.toHaveBeenCalled();
    await flush();
    expect(toasts.options()).toMatchObject([{ type: 'info', ...endedNotice(ended) }]);
    expect(accountToastIds(A)).toEqual(toasts.ids());
    // The screen's account turning (the order panel's provider, `useOrderToastsOf` on MY).
    const dismiss = vi.spyOn(toaster, 'dismiss');
    dismissAccountToasts(A);
    await flush();
    expect(dismiss.mock.calls).toEqual([toasts.ids()]);
    client.clear();
  });

  it('never raises the detail’s notice once its account left in the same commit', async () => {
    const client = screenOf(A);
    const toasts = stored();
    noticeEndedOnDetail(client, A, cancelled(uuid(32)));
    // SessionCacheGuard's effect, after the detail's in the same commit, heard B.
    dismissAccountToastsExcept(B);
    await flush();
    await flush();
    expect(toasts.create).not.toHaveBeenCalled();
    expect(accountToastIds(A)).toEqual([]);
    client.clear();
  });

  it('raises the cancel’s answer and its failures on the order as the account’s', async () => {
    const client = screenOf(A);
    const refetchSession = vi.fn();
    const options = cancelOrderOptions(client, refetchSession);
    const vars = (n: number): CancelVars => ({ orderId: uuid(n), accountId: A, marketId: MARKET });
    const toasts = stored();
    options.onSuccess(cancelled(uuid(41)), vars(41));
    await flush();
    const paused = [{ path: ['market'], message: 'paused' }];
    options.onError(refusal(409, 'MARKET_NOT_OPEN', paused), vars(42));
    options.onError(refusal(404, 'NOT_FOUND'), vars(43));
    options.onError(refusal(500, 'INTERNAL'), vars(44));
    options.onError(new TypeError('Failed to fetch'), vars(45));
    expect(toasts.options()).toMatchObject([
      { type: 'info', ...endedNotice(cancelled(uuid(41))) },
      { type: 'error', title: copy.orderHeldMarket },
      { type: 'error', title: copy.orderNotFound },
      { type: 'error', title: copy.orderCancelUnknown },
      { type: 'error', title: copy.orderCancelUnknown },
    ]);
    expect(accountToastIds(A)).toEqual(toasts.ids());
    expect(refetchSession).not.toHaveBeenCalled();
    // A sign-out heard from another tab (SessionCacheGuard, the session names nobody).
    const dismiss = vi.spyOn(toaster, 'dismiss');
    dismissAccountToastsExcept(null);
    await flush();
    expect(dismiss.mock.calls.flat().toSorted()).toEqual(toasts.ids().toSorted());
    client.clear();
  });

  it('leaves the three sentences about the session alone to the toaster', () => {
    const client = screenOf(A);
    const refetchSession = vi.fn();
    const options = cancelOrderOptions(client, refetchSession);
    const vars: CancelVars = { orderId: uuid(51), accountId: A, marketId: MARKET };
    const toasts = stored();
    const account = [{ path: ['expectedAccountId'], message: 'not the session' }];
    options.onError(refusal(403, 'FORBIDDEN', account), vars);
    options.onError(refusal(401, 'UNAUTHENTICATED'), vars);
    options.onError(refusal(403, 'FORBIDDEN'), vars);
    expect(toasts.options()).toEqual([
      { type: 'error', title: copy.sessionChanged },
      { type: 'error', title: copy.portfolioSignedOut },
      { type: 'error', title: copy.errUnknown },
    ]);
    // Said about the very turn that would dismiss them, to whoever is at the screen; none names
    // an order, a market or a quantity.
    expect(accountToastIds(A)).toEqual([]);
    for (const sentence of [copy.sessionChanged, copy.portfolioSignedOut, copy.errUnknown]) {
      expect(sentence).not.toMatch(/주문|시장|계약|취소/);
    }
    expect(refetchSession).toHaveBeenCalledTimes(2);
    for (const id of toasts.ids()) toaster.dismiss(id);
    client.clear();
  });

  it('says nothing of A’s order once the screen shows B', async () => {
    const client = screenOf(B);
    const options = cancelOrderOptions(client, vi.fn());
    const vars: CancelVars = { orderId: uuid(61), accountId: A, marketId: MARKET };
    const toasts = stored();
    options.onSuccess(cancelled(uuid(61)), vars);
    options.onError(refusal(404, 'NOT_FOUND'), vars);
    options.onError(refusal(500, 'INTERNAL'), vars);
    await flush();
    expect(toasts.create).not.toHaveBeenCalled();
    expect(accountToastIds(A)).toEqual([]);
    client.clear();
  });
});

/**
 * The same rule pinned in the sources (no component renders under node): in the modules of 대기
 * 주문 and 주문 상세 no toast is raised past the account's registry — the global `toaster` and
 * `toastAfterCommit` keep a toast under nobody, so nothing would take it away with its account.
 */

/** The three sentences about the session alone, the only toasts raised on the toaster itself. */
const SESSION_ONLY = ['sessionChanged', 'portfolioSignedOut', 'errUnknown'].map(
  (key) => `{ type: 'error', title: copy.${key} }`,
);

const ACCOUNT_TOASTS = new Set(['createAccountToast', 'accountToastAfterCommit']);

/** What raises a toast under no account (`components/ui/toaster`). */
const TOASTER_NAMES = new Set(['toaster', 'toastAfterCommit']);

interface ToastUses {
  /** The toasts raised as an account's: `[callee, account, options]`, in the source's order. */
  scoped: string[][];
  /** What keeps a toast under no account, or lets the toaster out under another name. */
  bypassing: string[];
}

/** Whether `node` is what a call calls (not one of its arguments). */
function isCalled(node: ts.Node): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

function toastUsesOf(file: string, source: string): ToastUses {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const uses: ToastUses = { scoped: [], bypassing: [] };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(tree);
      const args = node.arguments.map((argument) => argument.getText(tree));
      if (ACCOUNT_TOASTS.has(callee)) uses.scoped.push([callee, ...args]);
      const direct = callee === 'toastAfterCommit' || callee.startsWith('toaster.');
      const sessionOnly =
        callee === 'toaster.create' && args.length === 1 && SESSION_ONLY.includes(args[0] ?? '');
      if (direct && !sessionOnly) uses.bypassing.push(node.getText(tree));
    }
    // Renamed where it is imported (`import { toaster as say }`): no use of it carries the name
    // the two checks around this one read, so the import itself is what is caught.
    if (
      ts.isImportSpecifier(node) &&
      node.propertyName !== undefined &&
      TOASTER_NAMES.has(node.propertyName.text)
    ) {
      uses.bypassing.push(node.getText(tree));
    }
    // The toaster under another name, or handed on: only a call of it is read above.
    if (
      ts.isIdentifier(node) &&
      TOASTER_NAMES.has(node.text) &&
      !ts.isImportSpecifier(node.parent) &&
      !isCalled(node) &&
      !(
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.expression === node &&
        isCalled(node.parent)
      )
    ) {
      uses.bypassing.push(node.parent.getText(tree));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return uses;
}

describe('no order toast is raised past the account’s registry (결정 2-6)', () => {
  const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8');
  const relative = (file: string) => path.relative(SRC, file).split(path.sep).join('/');

  it('raises none on the toaster itself in the modules of 대기 주문 and 주문 상세', () => {
    const modules = [
      'hooks/use-my-orders.ts',
      'lib/my-orders.ts',
      'lib/order-join.ts',
      ...screenSources(path.join(SRC, 'components', 'orders')).map(relative),
      ...screenSources(path.join(SRC, 'app', 'my', 'orders')).map(relative),
    ];
    expect(modules).toContain('components/orders/pending-orders.tsx');
    expect(modules).toContain('components/orders/order-detail.tsx');
    expect(modules).toContain('components/orders/order-cancel-dialog.tsx');
    expect(modules).toContain('app/my/orders/[orderId]/page.tsx');
    const bypassing = modules.flatMap((file) =>
      toastUsesOf(file, read(file)).bypassing.map((text) => `${file}: ${text}`),
    );
    expect(bypassing).toEqual([]);
  });

  it('raises every notice of an order under the account it is of', () => {
    const { scoped } = toastUsesOf('hooks/use-my-orders.ts', read('hooks/use-my-orders.ts'));
    expect(scoped).toEqual([
      // The cancel's answer and the detail's effect: after the commit.
      ['accountToastAfterCommit', 'accountId', "{ type: 'info', ...endedNotice(order) }"],
      ['createAccountToast', 'vars.accountId', "{ type: 'error', title: copy.orderHeldMarket }"],
      ['createAccountToast', 'vars.accountId', "{ type: 'error', title: copy.orderNotFound }"],
      ['createAccountToast', 'vars.accountId', "{ type: 'error', title: copy.orderCancelUnknown }"],
      // The read back of the orders gone from a watched list.
      ['createAccountToast', 'accountId', "{ type: 'info', title: endedManyText(null) }"],
      ['createAccountToast', 'accountId', "{ type: 'info', ...endedNotice(told[0]) }"],
      ['createAccountToast', 'accountId', "{ type: 'info', title: endedManyText(told.length) }"],
    ]);
  });

  it('takes the other accounts’ order toasts away as a list or the detail mounts for one', () => {
    const hook = read('hooks/use-my-orders.ts');
    expect(hook).toMatch(
      /export function useOrderToastsOf\(accountId: string\): void \{\s*useEffect\(\(\) => \{\s*dismissAccountToastsExcept\(accountId\);\s*\}, \[accountId\]\);\s*\}/,
    );
    for (const screen of [
      'components/orders/pending-orders.tsx',
      'components/orders/order-detail.tsx',
    ]) {
      expect(read(screen), screen).toContain('useOrderToastsOf(accountId);');
    }
  });

  it('would catch a notice raised on the toaster, after the commit or under another name', () => {
    const uses = (body: string) =>
      toastUsesOf('hooks/example.ts', `export function f() {\n  ${body}\n}\n`);
    const notice = "{ type: 'info', ...endedNotice(order) }";
    expect(uses(`toaster.create(${notice});`).bypassing).toEqual([`toaster.create(${notice})`]);
    expect(uses(`toastAfterCommit(${notice});`).bypassing).toEqual([`toastAfterCommit(${notice})`]);
    expect(uses("toaster.create({ type: 'error', title: copy.orderNotFound });").bypassing).toEqual(
      ["toaster.create({ type: 'error', title: copy.orderNotFound })"],
    );
    expect(uses(`toaster.update(id, ${notice});`).bypassing).toHaveLength(1);
    expect(uses(`const say = toaster;\n  say.create(${notice});`).bypassing).toEqual([
      'say = toaster',
    ]);
    expect(uses(`const say = toaster.create;\n  say(${notice});`).bypassing).toEqual([
      'toaster.create',
    ]);
    expect(uses(`orders.forEach(toastAfterCommit);`).bypassing).toEqual([
      'orders.forEach(toastAfterCommit)',
    ]);
    // Renamed where it is imported: no later use carries the name.
    const imported = (names: string, body: string) =>
      toastUsesOf(
        'hooks/example.ts',
        `import { ${names} } from '@/components/ui/toaster';\nexport function f() {\n  ${body}\n}\n`,
      );
    expect(imported('toaster as say', `say.create(${notice});`).bypassing).toEqual([
      'toaster as say',
    ]);
    expect(imported('toastAfterCommit as later', `later(${notice});`).bypassing).toEqual([
      'toastAfterCommit as later',
    ]);
    expect(
      imported('toaster as say, toastAfterCommit as later', 'return [say, later];').bypassing,
    ).toEqual(['toaster as say', 'toastAfterCommit as later']);
    // Reached through the module's namespace: the name is there, behind another one.
    const namespaced = (body: string) =>
      toastUsesOf(
        'hooks/example.ts',
        `import * as ui from '@/components/ui/toaster';\nexport function f() {\n  ${body}\n}\n`,
      );
    expect(namespaced(`ui.toastAfterCommit(${notice});`).bypassing).toEqual([
      'ui.toastAfterCommit',
    ]);
    expect(namespaced(`ui.toaster.create(${notice});`).bypassing).toEqual(['ui.toaster']);
    // The import under its own name passes by itself; what is raised with it is read above.
    expect(imported('toaster, toastAfterCommit', 'return null;').bypassing).toEqual([]);
    expect(imported('toaster', `toaster.create(${notice});`).bypassing).toEqual([
      `toaster.create(${notice})`,
    ]);
    // The three sentences about the session alone, and an account's toast, pass.
    expect(
      uses("toaster.create({ type: 'error', title: copy.sessionChanged });").bypassing,
    ).toEqual([]);
    const account = uses(`createAccountToast(accountId, ${notice});`);
    expect(account.bypassing).toEqual([]);
    expect(account.scoped).toEqual([['createAccountToast', 'accountId', notice]]);
  });
});

/**
 * The detail's first render on a screen mounted now over what `client` holds (`useBaseQuery`'s
 * optimistic result of an observer made at mount).
 */
function detailAtMount(client: QueryClient, orderId: string) {
  const observer = new QueryObserver(client, {
    queryKey: myOrderKey(orderId, A),
    queryFn: () => fetchMyOrder(orderId),
  });
  const options = client.defaultQueryOptions(observer.options);
  options._optimisticResults = 'optimistic';
  return observer.getOptimisticResult(options);
}

/** The live list's first render on a screen mounted now over what `client` holds. */
function liveAtMount(client: QueryClient) {
  const observer = new InfiniteQueryObserver(
    client,
    liveOrdersQueryOptions(A, undefined, { user: {} }),
  );
  // The observer's options are already the client's defaulted ones (`setOptions`).
  return observer.getOptimisticResult({
    ...observer.options,
    _optimisticResults: 'optimistic',
  } as Parameters<typeof observer.getOptimisticResult>[0]);
}

describe('watchedReading: the reading a list or the detail watches from (결정 6)', () => {
  const ID1 = '0b0b0b0b-0000-4000-8000-000000000011';
  const ID2 = '0b0b0b0b-0000-4000-8000-000000000012';
  const pages = (...orders: Order[]): OrderPages => ({
    pages: [{ items: orders, nextCursor: null }],
    pageParams: [undefined],
  });

  it('takes the live rows a fresh cache draws at mount (MY to 대기 주문 within the stale time)', () => {
    const client = getQueryClient();
    client.setQueryData(myOrdersLiveKey(A), pages(order(ID1), order(ID2)));
    const first = liveAtMount(client);
    // Nothing is asked at mount, so no read after it comes until a realtime refetch: the fresh
    // rows drawn are the baseline, and that refetch's missing row is a candidate.
    expect(first.isFetching).toBe(false);
    expect(first.isFetchedAfterMount).toBe(false);
    expect(watchedReading(first)).toBe(true);
    const ids = (first.data?.pages ?? []).flatMap((page) => page.items.map((row) => row.id));
    expect(endedCandidates({ accountId: A, ids }, A, [ID1])).toEqual([ID2]);
    client.clear();
  });

  it('does not take held rows the mount reads again: what ended while away is not told', () => {
    const client = getQueryClient();
    client.setQueryData(myOrdersLiveKey(A), pages(order(ID1)), { updatedAt: Date.now() - 60_000 });
    const first = liveAtMount(client);
    expect(first.isFetching).toBe(true);
    expect(watchedReading(first)).toBe(false);
    client.clear();
  });

  it('takes the detail a fresh cache draws at mount, and not a stale one', () => {
    const client = getQueryClient();
    client.setQueryData(myOrderKey(ID1, A), order(ID1));
    expect(watchedReading(detailAtMount(client, ID1))).toBe(true);
    client.setQueryData(myOrderKey(ID2, A), order(ID2), { updatedAt: Date.now() - 60_000 });
    expect(watchedReading(detailAtMount(client, ID2))).toBe(false);
    client.clear();
  });

  it('is any read after mount', () => {
    const after = { data: undefined, isFetchedAfterMount: true, isFetching: false, isStale: true };
    expect(watchedReading(after)).toBe(true);
    expect(watchedReading({ ...after, isFetchedAfterMount: false })).toBe(false);
  });
});
