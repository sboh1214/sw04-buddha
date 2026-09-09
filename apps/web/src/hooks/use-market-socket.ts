'use client';

import { useEffect, useMemo } from 'react';
import { useRealtime } from '@/components/realtime/realtime-provider';

/**
 * Joins the `market:<id>` room of every given market for as long as this component is mounted
 * (PLAN 11.5 names the hook). Home passes `rows.map((m) => m.id)`, the detail passes
 * `[marketId]`, and the provider refcounts the overlap, so the two screens sharing one market
 * neither subscribe twice nor unsubscribe each other.
 *
 * Every id must be the market's canonical uuid: it is what the gateway re-validates with
 * `uuidSchema` before joining (A-M3-17, the third request boundary — an upper-case id would
 * join a room no publisher ever writes to and the socket would sit silent rather than fail),
 * and it is the `['market', id]` key the provider's handlers write.
 *
 * Nothing is debounced or coalesced. The ordering keys are the correctness mechanism, and a
 * coalescing window here would blur PLAN 11.1's "1초 내 갱신"; the 200~300ms roll is
 * RollingNumber's job, not the cache's.
 */
export function useMarketSocket(marketIds: readonly string[]): void {
  const realtime = useRealtime();
  // The join key, not the array: `rows.map(...)` builds a new array on every render, so an
  // effect keyed on the array itself would leave and re-join every room on every render —
  // which, with the socket emitting per transition, is the one way this hook could cost more
  // than it saves. Sorted and de-duplicated so the same set in a different order is the same
  // key, and a repeated id cannot inflate the refcount past what the cleanup gives back.
  const ids = useMemo(() => [...new Set(marketIds)].sort().join(','), [marketIds]);

  useEffect(() => {
    if (realtime === null || ids === '') return;
    const list = ids.split(',');
    // Read once, so the cleanup leaves the SAME registry it joined. The handle itself never
    // changes identity (realtime-provider.tsx), so a reconnect or a new session's handshake
    // does not re-run this effect: the provider re-emits every held room on `connect`.
    const rooms = realtime.current;
    rooms.join(list);
    return () => {
      rooms.leave(list);
    };
  }, [realtime, ids]);
}
