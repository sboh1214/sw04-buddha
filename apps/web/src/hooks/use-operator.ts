'use client';

import { useState } from 'react';
import { useMe } from '@/hooks/use-me';
import { type OperatorHeld, heldForOperator, operatorHold } from '@/lib/admin-accounts';

/**
 * The admin on screen: the account of the `Me` the admin screens are drawn from — the header's
 * `GET /me` — once it has answered. Every operator write on 운영자 계정 (#171) and 신고·조치 (#50)
 * names it (`expectedAccountId`: a grant, a revoke, every moderation action), and it tells apart
 * what concerns the operator (the 나 badge and the own-revoke warning, the own-account notice, an
 * account restriction request's standing). Never the session's: in the render between the session
 * naming another account and SessionCacheGuard's reset the session already says B while the screen
 * is still A's, and a write naming B would be taken with B's cookie — what A picked and the reason
 * A typed, done as B (ADR-0091, as ADR-0090 did for the 본인확인 step). The server refuses the
 * mismatch as another account's.
 */
export function useOperatorId(): string | undefined {
  return useMe().data?.id;
}

/**
 * What an admin screen picked or opened — a dialog with its target — held for the admin on screen
 * when it was (`heldForOperator`): dropped, with whatever was typed in the dialog it opened, once
 * another admin or nobody known is on screen, so a grant, a revoke or an action picked on A's
 * screen is never sent as B. `['me']` can turn from A to B in place, before the session does
 * (ADR-0090 결정 4-2 — a window-focus refetch of `GET /me`, a realtime resnapshot: no reset then),
 * and the write would name B, the admin now drawn. The admin screens' equivalent of a card keyed by
 * account (ADR-0091): their lists are every admin's, so only what was picked is dropped. Nothing is
 * held while no admin is known (`operatorHold`): a pick then would be handed to whichever admin
 * `GET /me` names first, with whatever cookie the tab has by then.
 */
export function useHeldForOperator<T>(): readonly [T | null, (value: T | null) => void] {
  const operatorId = useOperatorId();
  const [held, setHeld] = useState<OperatorHeld<T> | null>(null);
  const current = heldForOperator(held, operatorId);
  // React's way of adjusting state to a value, during render (the 마케팅 정보 수신 switch's
  // `asked`): the screen never draws what was picked for another admin, not even for one render.
  if (current !== held) setHeld(current);
  const hold = (value: T | null) => {
    setHeld(operatorHold(value, operatorId));
  };
  return [current === null ? null : current.value, hold] as const;
}
