import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sellableQueryOptions } from '@/hooks/use-orders-place';
import { marketSellableKey } from '@/lib/market-keys';

/**
 * The order panel's wiring (#66, ADR-0140), pinned in its source as `use-instant-reached.test.ts`
 * pins its hook's: no component runs its effects under node. The decisions themselves are pure and
 * tested in lib/order-panel.test.ts and lib/market-detail.test.ts; the e2e (order-panel.spec.ts)
 * watches them on a page.
 */
describe('OrderPanelProvider', () => {
  const source = readFileSync(new URL('./order-panel-provider.tsx', import.meta.url), 'utf8');
  const recovery = readFileSync(new URL('./order-recovery.tsx', import.meta.url), 'utf8');

  it("turns the input off at the close instant on the server's clock (결정 2-16)", () => {
    // The close's own timer, from the server's `now`, ahead of the book read a second later.
    expect(source).toMatch(/useInstantReached\(closeAt, now\)/);
    expect(source).toContain(
      'const gap = orderInputClosedReason(market?.status, book, closeReached);',
    );
    // 주문 제출 reads it at the press too.
    expect(source).toContain('step.requote !== null || gapRef.current !== null) return;');
  });

  it('builds the order from the frozen quote alone, locked before it renders (결정 2-3·2-4)', () => {
    // The account is 확인's own, frozen as it opened: never the `me` of the press (결정 2-22).
    expect(source).toContain('body = placeBodyOf(step.frozen, step.accountId);');
    expect(source).toContain('if (step.accountId !== accountId) return;');
    expect(source).toMatch(
      /if \(accountId === undefined \|\| sendLocked\(sending\.current, accountId\)\) return;/,
    );
    // The request is kept just before it goes, under the account and the market.
    const start = source.indexOf('const submit = useCallback(');
    expect(start).toBeGreaterThanOrEqual(0);
    const submit = source.slice(start);
    const kept = submit.indexOf('keepSessionOrderRequest(accountId, marketId, request);');
    const sent = submit.indexOf('await send(request, accountId);');
    expect(kept).toBeGreaterThanOrEqual(0);
    expect(sent).toBeGreaterThan(kept);
  });

  it('touches the kept request after the send only under its own id', () => {
    // A late answer of an older request neither drops nor covers a newer one (order-requests.ts).
    expect(source).not.toMatch(/clearSessionOrderRequest\([^)]*marketId\)/);
    expect(recovery).not.toMatch(/clearSessionOrderRequest\([^)]*marketId\)/);
    expect(source).toContain(
      "updateSessionOrderRequest(account, marketId, { ...request, phase: 'unknown' });",
    );
  });

  it('lets a send settle the kept request only as the send that keeps it (결정 2-5)', () => {
    // The same id can be in flight twice: the POST of a page that was left, and the same request
    // sent again from the page come back to. Each send names itself...
    const submitStart = source.indexOf('const submit = useCallback(');
    const resendStart = source.indexOf('const resend = useCallback(');
    const recoveryStart = source.indexOf('useOrderRecovery({');
    expect(submitStart).toBeGreaterThanOrEqual(0);
    expect(resendStart).toBeGreaterThan(submitStart);
    expect(recoveryStart).toBeGreaterThan(resendStart);
    const submit = source.slice(submitStart, resendStart);
    expect(submit).toMatch(/requestId: step\.requestId,\s*sendId: newId\(\),/);
    // ...a resend with a new one, kept over the slot before it goes...
    const resend = source.slice(resendStart, recoveryStart);
    const made = resend.indexOf(
      "const request: PendingOrderRequest = { ...step.request, phase: 'unknown', sendId: newId() };",
    );
    const kept = resend.indexOf('keepSessionOrderRequest(accountId, marketId, request);');
    const sent = resend.indexOf('await send(request, accountId);');
    expect(made).toBeGreaterThanOrEqual(0);
    expect(kept).toBeGreaterThan(made);
    expect(sent).toBeGreaterThan(kept);
    // ...and a send's end, its order or its refusal, goes through the store's own check of the
    // send (`settleOrderRequest`), never the drop by the request id alone: an older send's late
    // refusal would drop the record the newer one is read back by after a reload.
    const sendStart = source.indexOf('const send = useCallback(');
    const send = source.slice(sendStart, submitStart);
    expect(send).not.toContain('clearSessionOrderRequest(');
    expect(send.match(/settleSessionOrderRequest\(account, marketId, request\);/g)).toHaveLength(2);
    const caught = send.slice(send.indexOf('} catch (error) {'));
    expect(caught).toMatch(
      /if \(outcome\.next === 'failed'\) \{\s*settleSessionOrderRequest\(account, marketId, request\);\s*\} else \{/,
    );
    // The request's own end — '버리기', the order read back by its id — drops it whichever send
    // keeps it; the read-back, which never sends, settles no send.
    expect(source).toContain(
      'clearSessionOrderRequest(accountId, marketId, step.request.requestId);',
    );
    expect(recovery).toContain('clearSessionOrderRequest(accountId, marketId, requestId);');
    expect(recovery).not.toContain('settleSessionOrderRequest');
  });

  it('reads one book for both places and never retries a quote', () => {
    expect(source.match(/useOrderBook\(/g)).toHaveLength(1);
    const hooks = readFileSync(new URL('../../hooks/use-orders-place.ts', import.meta.url), 'utf8');
    // The quote's own options, not the order mutation's `retry: false` further down.
    const start = hooks.indexOf('export function quoteQueryOptions(');
    const end = hooks.indexOf('\nexport ', start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(hooks.slice(start, end)).toContain('retry: false,');
  });

  it('gives a 다시 견적 a new request id (결정 2-4)', () => {
    const start = source.indexOf('const requote = useCallback(');
    expect(start).toBeGreaterThanOrEqual(0);
    const requote = source.slice(start, source.indexOf('\n  }, [', start));
    const done = requote.indexOf("type: 'requoteDone',");
    expect(done).toBeGreaterThanOrEqual(0);
    expect(requote.slice(done)).toMatch(/requestId: newId\(\),/);
    // A refused one goes back to 입력 only from the 확인 that asked (its token).
    expect(requote).toContain("dispatch({ type: 'requoteRefused', token });");
    expect(requote).not.toContain("type: 'back'");
  });

  it('hands nothing of one account to the next (결정 2-22)', () => {
    // The account on screen turning into another or none resets the panel while rendering.
    expect(source).toContain(
      "if (panelOwnerChanged(heldOwner, owner)) dispatch({ type: 'accountChanged', to: owner });",
    );
    // A late answer is shown only while its sender is still on screen.
    expect(source.match(/if \(ownerRef\.current !== account\) return;/g)).toHaveLength(2);
    // Another account's request is not sent again, kept or dropped in this one's name...
    expect(source).toContain(
      "if (step.name !== 'unsent' || !requestOwnedBy(step.request, accountId)) return;",
    );
    // ...nor read back with this one's cookie.
    expect(recovery).toContain(
      "if (step.name !== 'recovering' || !requestOwnedBy(step.request, accountId)) return;",
    );
  });

  it('checks D13 again after the reads 확인 opens on, and at the press (owner answer 66-Q3)', () => {
    const start = source.indexOf('const openConfirm = useCallback(');
    const open = source.slice(start, source.indexOf('\n  }, [', start));
    const check = open.indexOf("freshMe.profile.role === 'admin'");
    expect(check).toBeGreaterThan(open.indexOf('await Promise.all('));
    expect(open.indexOf("type: 'openConfirm',")).toBeGreaterThan(check);
    expect(source).toContain('if (accountBlockRef.current !== null) return;');
  });

  it('tells a refusal that ends where no panel shows it in a toast (결정 2-7)', () => {
    expect(source).toMatch(
      /outcome\.next === 'failed' && \(!areaRef\.current \|\| !visibleRef\.current\)/,
    );
    expect(source).toContain('failureToast(outcome.failure,');
  });

  it('keeps the input as a draft on 401 and onboarding, and gives one back once (D3·D4)', () => {
    const unauthenticated = source.indexOf("failure.code === 'UNAUTHENTICATED' ||");
    expect(unauthenticated).toBeGreaterThanOrEqual(0);
    expect(source.slice(unauthenticated)).toMatch(
      /^[\s\S]{0,300}keepSessionOrderDraft\(market, stateRef\.current\.input\)/,
    );
    // Read, cleared, then restored: a second read finds nothing.
    const read = source.indexOf('const input = readSessionOrderDraft(marketId);');
    const cleared = source.indexOf('clearSessionOrderDraft(marketId);', read);
    const restored = source.indexOf("dispatch({ type: 'restore',", read);
    expect(read).toBeGreaterThanOrEqual(0);
    expect(cleared).toBeGreaterThan(read);
    expect(restored).toBeGreaterThan(cleared);
  });

  it('gives no draft back past an 인증 링크 opened in the tab (D4)', () => {
    const setPassword = readFileSync(
      new URL('../../app/set-password/set-password-form.tsx', import.meta.url),
      'utf8',
    );
    expect(setPassword).toMatch(
      /useEffect\(\(\) => \{\s*clearSessionOrderDrafts\(\);\s*\}, \[\]\);/,
    );
  });

  it("reads a returning account's kept request again after a sign-out (결정 2-22)", () => {
    // The provider hands the account on screen (null for a visitor) to the read-back...
    const start = source.indexOf('useOrderRecovery({');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(source.slice(start, source.indexOf('});', start))).toMatch(/\n\s+owner,\n/);
    // ...which forgets which slot it read once no account is on screen, before the read's own
    // guard: A → signed out → A reads A's slot again instead of sending over it.
    const reset = recovery.indexOf('if (owner === null) started.current = null;');
    const latch = recovery.indexOf('if (started.current === key) return;');
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(latch).toBeGreaterThan(reset);
  });

  it("keeps the 매도 가능액 under the account on screen, never another's (결정 2-22)", () => {
    expect(source).toContain('useSellable(marketId, me?.id)');
    const a = sellableQueryOptions('M-1', 'user-a');
    const b = sellableQueryOptions('M-1', 'user-b');
    expect(a.queryKey).not.toEqual(b.queryKey);
    expect(a.queryKey.slice(0, 2)).toEqual([...marketSellableKey('m-1')]);
    expect(a.enabled).toBe(true);
    expect(sellableQueryOptions('M-1', undefined).enabled).toBe(false);
  });

  it('lets a term account restriction end at its endsAt on the server clock (결정 2-11)', () => {
    // On screen: `useAccountBlock` on the server's `now` (use-account-block.test.ts pins it).
    expect(source).toContain('useAccountBlock(me, now);');
    // 확인's own check of the cached restriction, on the same clock.
    const start = source.indexOf('const openConfirm = useCallback(');
    const open = source.slice(start, source.indexOf('\n  }, [', start));
    expect(open).toContain(
      'restrictionsShown(freshRestriction, serverNow(), ACCOUNT_RESTRICTION_KIND).length > 0',
    );
    expect(open).not.toContain('accountRestriction ?? null');
  });

  it('reads the restriction of the account on screen, under its id, never the last one’s (결정 2-26)', () => {
    // `me` may name B while the session (and SessionCacheGuard's reset) still says A: the
    // restriction is B's own entry, on screen (`useAccountBlock(me, …)`, a member's `me` only)
    // and in 확인's check alike.
    expect(source).toContain('const me = member ? meQuery.data : undefined;');
    const start = source.indexOf('const openConfirm = useCallback(');
    const open = source.slice(start, source.indexOf('\n  }, [', start));
    expect(open).toMatch(
      /queryClient\.getQueryData<MyRestriction>\(\s*myRestrictionKey\(accountId \?\? null\),?\s*\)/,
    );
    // No read of the bare key, which says nobody's.
    expect(source).not.toContain('MY_RESTRICTION_KEY');
  });

  it('reads a holding’s sell intent once, past the restore’s gates, and drops the draft (#67)', () => {
    expect(source).toContain('const [sellIntent] = useState(() => parseSellIntent(searchParams));');
    const start = source.indexOf('if (sellIntent === null || sellIntentDone.current');
    const effect = source.slice(start, source.indexOf('\n  }, [', start));
    // A member with the account and the width known and the market read: the restore's gates.
    expect(effect).toContain('(!accountKnown || mdUp === null || market === undefined)');
    // Written out of the address in place, never with the router (no RSC read again).
    expect(effect).toContain('window.history.replaceState(');
    expect(source).not.toMatch(/router\.replace\(/);
    // Opened only on a 거래 중 market, for a member: a paused one has no order area (D1).
    expect(effect).toContain("if (viewer !== 'member' || market?.status !== 'open') return;");
    // A request in flight is the reducer's (`openSell` keeps its terms), not dropped here.
    expect(effect).not.toContain('stepBusy');
    // That entry brings no draft back (D4 is the return after a sign-in), and drops it.
    const restore = source.slice(source.indexOf('if (skipRestore.current) {'));
    expect(restore.slice(0, restore.indexOf('}'))).toContain('clearSessionOrderDraft(marketId);');
  });

  it('gives the sheet’s focus back to the holding’s 매도 that opened it (#67)', () => {
    expect(source).toContain('sheetOrigin.current = wide ? null : (origin ?? null);');
    // The bar's own triggers are the dialog's: no origin of ours then.
    const openSheet = source.slice(source.indexOf('const openSheet = useCallback('));
    expect(openSheet.slice(0, openSheet.indexOf('}, []);'))).toContain(
      'sheetOrigin.current = null;',
    );
  });

  it('spaces book-driven quote reads from their start and keeps a held-back move (결정 2-13)', () => {
    // The gap counts from the last read STARTED, never from the last answer (`dataUpdatedAt`).
    // (`noteQuoteStart`, run on every read's start: the next test pins it.)
    expect(source).toMatch(/useEffect\(\(\) => \{\s*if \(quoteFetching\) noteQuoteStart\(\);/);
    expect(source).toContain('lastAttemptAt: lastQuoteAttempt.current,');
    expect(source).toContain('inFlight: facts.inFlight,');
    expect(source).not.toContain('lastQuotedAt');
    // A read in flight is never cancelled and started over by a book move.
    expect(source).toContain('void refetchQuote({ cancelRefetch: false });');
    // A move the gap holds back reads at its end; one a read holds back, at the read's end.
    expect(source).toContain('requoteTimer.current = setTimeout(requoteOnBook, decision.ms);');
    expect(source).toMatch(/if \(!quoteFetching && requotePending\.current\) requoteOnBook\(\);/);
    // Nothing waits out of 입력, off screen, or past an unmount.
    expect(source).toMatch(
      /if \(editing && panelVisible\) requoteOnBook\(\);\s*else cancelRequote\(\);/,
    );
    expect(source).toContain('useEffect(() => cancelRequote, [cancelRequote]);');
  });

  it('compares a book move with the side as the quote was asked, not as it answered (결정 2-13)', () => {
    // Taken at the read's start, so a move during a read in flight still differs at its end.
    expect(source).toMatch(
      /const noteQuoteStart = useCallback\(\(\) => \{\s*lastQuoteAttempt\.current = Date\.now\(\);\s*requestedLevels\.current = sideNow\(\);/,
    );
    // A read that ended — answered or failed — leaves the side its START saw, never the side at
    // its end: unknown when it started before the book did, so the first book reads it again.
    expect(source).toContain(
      'const quoteEndedAt = Math.max(quoteQuery.dataUpdatedAt, quoteQuery.errorUpdatedAt);',
    );
    expect(source).toMatch(
      /if \(quoteEndedAt === 0\) return;\s*quotedLevels\.current = requestedLevels\.current;\s*\}, \[quoteEndedAt\]\);/,
    );
    expect(source).not.toContain('requestedLevels.current ?? sideNow()');
    expect(source).toContain('sideChanged: sideMovedSinceQuote(before, levels),');
    // The first book known runs the same decision (`requoteNext`, its limits included).
    expect(source).toMatch(/if \(book !== undefined\) requoteOnBook\(\);/);
    expect(source).toMatch(
      /if \(quoteFetching\) noteQuoteStart\(\);\s*\}, \[quoteFetching, settledKey, noteQuoteStart\]\);/,
    );
    // A book-driven read notes its own start before it goes.
    expect(source).toMatch(
      /noteQuoteStart\(\);\s*\/\/[^\n]*\n\s*void refetchQuote\(\{ cancelRefetch: false \}\);/,
    );
  });

  it('decides a held-back move again when the panel or the tab is shown again (결정 2-13)', () => {
    expect(source).toMatch(
      /if \(editing && panelVisible\) requoteOnBook\(\);\s*else cancelRequote\(\);\s*\}, \[editing, panelVisible, requoteOnBook, cancelRequote\]\);/,
    );
    expect(source).toMatch(
      /if \(document\.visibilityState === 'visible'\) requoteOnBook\(\);[\s\S]{0,120}addEventListener\('visibilitychange', onShown\)/,
    );
  });

  it('says a failed quote read over older figures and keeps 주문 확인 off (결정 2-13)', () => {
    const panel = readFileSync(new URL('./order-panel.tsx', import.meta.url), 'utf8');
    // Not only where no figures are kept: TanStack keeps the last answer beside the error.
    expect(panel).toContain('const quoteFailedShown = !off && check.ok && panel.quoteFailed;');
    expect(panel).toMatch(/quoteWaiting\(panel\) \|\|\s*quoteFailedShown;/);
    const box = panel.slice(panel.indexOf('function QuoteBox('));
    expect(box).toContain('const failed = quoteFailed ? (');
    expect(box).toContain('{failed !== null && <Box mb="2">{failed}</Box>}');
  });

  it('reads the session again on any refusal that says so, before a resend is read back', () => {
    const start = source.indexOf('const send = useCallback(');
    const send = source.slice(start, source.indexOf('\n  const submit = useCallback(', start));
    const caught = send.slice(send.indexOf('} catch (error) {'));
    // Before the outcome's branches, so a resend's unknown 401 or 403 is read again too...
    const refresh = caught.indexOf('const refreshed = refreshAuth(error, account);');
    const awaited = caught.indexOf(
      "if (outcome.next === 'recover' && authRefreshOf(error).session) await refreshed;",
    );
    const owner = caught.indexOf('if (ownerRef.current !== account) return;');
    const branches = caught.indexOf("if (outcome.next === 'failed') {\n", owner);
    expect(refresh).toBeGreaterThanOrEqual(0);
    // ...and its read-back starts only once the session has answered (결정 2-22).
    expect(awaited).toBeGreaterThan(refresh);
    expect(owner).toBeGreaterThan(awaited);
    expect(branches).toBeGreaterThan(owner);
    // No refresh of its own is left inside the settled branch.
    expect(caught.slice(branches)).not.toMatch(
      /refetchSession\(|session\.refetch\(|refreshOwnMe\(/,
    );
    // A read-back's own 401 or 403 is never counted as '못 찾음', and reads the session again.
    expect(recovery).toMatch(
      /if \(isApiError\(error, 'NOT_FOUND'\)\) misses \+= 1;\s*(\/\/[^\n]*\n\s*)*else void refreshAuth\(error, accountId\);/,
    );
    expect(source).toMatch(/useOrderRecovery\(\{[\s\S]*?\n\s+refreshAuth,\n[\s\S]*?\}\);/);
  });

  it('looks for a draft again in each sign-in cycle, without a reload (결정 2-12)', () => {
    // Signed out: the next sign-in's draft is given back on this detail still mounted.
    const reset = source.indexOf("if (viewer === 'visitor') restoreChecked.current = false;");
    const latch = source.indexOf("if (restoreChecked.current || viewer === 'unknown') return;");
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(latch).toBeGreaterThan(reset);
    // A 401 or the onboarding gate at 주문 제출 keeps a draft: a cycle of its own.
    expect(source).toMatch(
      /keepSessionOrderDraft\(market, stateRef\.current\.input\);\s*(\/\/[^\n]*\n\s*)*restoreChecked\.current = false;/,
    );
  });

  it('scopes the 주문 제출 lock to its account and request (결정 2-4)', () => {
    expect(source).not.toMatch(/sending\.current = (true|false)/);
    expect(source.match(/sendLocked\(sending\.current, accountId\)/g)).toHaveLength(2);
    expect(source).toContain(
      'sending.current = { account: accountId, requestId: step.requestId };',
    );
    expect(source).toContain(
      'sending.current = { account: accountId, requestId: step.request.requestId };',
    );
    expect(
      source.match(/sending\.current = sendUnlocked\(sending\.current, request\.requestId\);/g),
    ).toHaveLength(2);
  });

  it('restarts the account reads an order moved, a first read in flight included (결정 2-15)', () => {
    const start = source.indexOf('const afterOrder = useCallback(');
    const after = source.slice(start, source.indexOf('\n  }, [', start));
    for (const key of [
      'marketSellableKey(marketId)',
      'POSITIONS_KEY',
      'ORDERS_KEY',
      'marketBookKey(marketId)',
    ]) {
      expect(after).toContain(`void restartQueries(queryClient, ${key});`);
    }
    expect(after).not.toMatch(
      /invalidateQueries\(\{ queryKey: (marketSellableKey|POSITIONS_KEY|ORDERS_KEY)/,
    );
  });

  it('leaves 로그인 안내 on a sign-in, a draft or none (D3·D4)', () => {
    expect(source).toMatch(
      /else if \(panelSignedIn\(heldOwner, owner\)\) dispatch\(\{ type: 'signedIn' \}\);/,
    );
  });

  it("says a member's failed `GET /me` with 다시 시도, never a skeleton for good (결정 2-21)", () => {
    expect(source).toContain("const accountFailed = accountView === 'failed';");
    const panel = readFileSync(new URL('./order-panel.tsx', import.meta.url), 'utf8');
    const failed = panel.indexOf("if (viewer === 'member' && panel.accountFailed) {");
    const pending = panel.indexOf("if (viewer === 'unknown' || !accountKnown) {");
    expect(failed).toBeGreaterThanOrEqual(0);
    expect(pending).toBeGreaterThan(failed);
    const view = panel.slice(failed, pending);
    expect(view).toContain('{copy.errProfileLoad}');
    expect(view).toContain('onClick={panel.retryAccount}');
  });

  it('lets a send that outlives the provider show nothing to anyone (결정 2-22)', () => {
    // Unmounted: the guard matches no account, so a late answer dispatches and toasts nothing in
    // whoever's session the global toaster now serves.
    expect(source).toMatch(
      /useEffect\(\s*\(\) => \(\) => \{\s*ownerRef\.current = undefined;\s*\},\s*\[\],\s*\);/,
    );
    // Both late paths pass the guard before any dispatch or toast; the slot is settled ahead of
    // it by the sender's own send, and the reads moved are restarted (a cache, not a screen).
    const start = source.indexOf('const send = useCallback(');
    const send = source.slice(start, source.indexOf('\n  const submit = useCallback(', start));
    const tried = send.slice(0, send.indexOf('} catch (error) {'));
    const cleared = tried.indexOf('settleSessionOrderRequest(account, marketId, request);');
    const reads = tried.indexOf('afterOrder();');
    const guard = tried.indexOf('if (ownerRef.current !== account) return;');
    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(reads).toBeGreaterThan(cleared);
    expect(guard).toBeGreaterThan(reads);
    expect(tried.indexOf("type: 'placed',")).toBeGreaterThan(guard);
    expect(tried.indexOf('toldWhereHidden(result.order, account);')).toBeGreaterThan(guard);
    const caught = send.slice(send.indexOf('} catch (error) {'));
    const caughtGuard = caught.indexOf('if (ownerRef.current !== account) return;');
    expect(caughtGuard).toBeGreaterThanOrEqual(0);
    expect(caught.indexOf('failureToast(')).toBeGreaterThan(caughtGuard);
    expect(caught.indexOf("type: 'placeFailed',")).toBeGreaterThan(caughtGuard);
  });

  it('reads a lost answer back and never sends from the read-back', () => {
    expect(recovery).toContain('fetchOrderByRequest(requestId)');
    expect(recovery).not.toMatch(/placeOrder|usePlaceOrder|mutate/);
    expect(recovery).toContain('export const RECOVERY_DELAYS_MS = [0, 2_000, 3_000] as const;');
  });

  it("sends the same id again only at the press of '같은 요청 다시 보내기' (결정 2-5·2-6, 66-Q2)", () => {
    // The POST has two callers, 주문 제출 and the resend: no effect and no read-back reaches it.
    expect(source.match(/\bsend\(/g)).toHaveLength(2);
    const submitStart = source.indexOf('const submit = useCallback(');
    const resendStart = source.indexOf('const resend = useCallback(');
    const recoveryStart = source.indexOf('useOrderRecovery({');
    expect(submitStart).toBeGreaterThanOrEqual(0);
    expect(resendStart).toBeGreaterThan(submitStart);
    expect(recoveryStart).toBeGreaterThan(resendStart);
    expect(source.slice(submitStart, resendStart).match(/\bsend\(/g)).toHaveLength(1);
    expect(source.slice(resendStart, recoveryStart).match(/\bsend\(/g)).toHaveLength(1);
    // The provider only hands `resend` out — it never calls it, after three misses or ever — and
    // a resend goes from the card of three misses alone.
    expect(source).not.toMatch(/\bresend\(/);
    expect(source.slice(resendStart, recoveryStart)).toMatch(/if \(step\.name !== 'unsent' \|\|/);
    // Three NOT_FOUNDs of the read-back only show that card: nothing goes by itself.
    expect(recovery).toContain("dispatch({ type: 'recoverMissed', attempt: recovering });");
    expect(recovery).not.toMatch(/\bresend\b|\bsend\(/);
    // One caller in the market's components: the card's first button, in its `onClick`.
    const callers = readdirSync(new URL('.', import.meta.url))
      .filter((name) => name.endsWith('.tsx'))
      .filter((name) =>
        /\bresend\(/.test(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')),
      );
    expect(callers).toEqual(['order-result.tsx']);
    const result = readFileSync(new URL('./order-result.tsx', import.meta.url), 'utf8');
    expect(result.match(/\bresend\(/g)).toHaveLength(1);
    expect(result).toMatch(
      /onClick=\{\(\) => \{\s*void panel\.resend\(\);\s*\}\}\s*data-testid="order-resend"\s*>\s*\{copy\.orderResend\}/,
    );
  });
});
