'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useInstantReached } from '@/hooks/use-instant-reached';
import { useMyRestriction } from '@/hooks/use-reports';
import type { Me } from '@/lib/api';
import { myRestrictionKey } from '@/lib/moderation';

/** D13's account that may not order (ADR-0135): an admin, or one under an account restriction. */
export type AccountBlock = 'admin' | 'restricted' | null;

/**
 * Whether the account on screen may order (ADR-0135 D13; #66 ADR-0140 결정 2-11·2-26, taken out of
 * the order panel by #67, ADR-0142, so MY's holdings say the same): an admin is told so, and an
 * account restriction with its end. The restriction is read under the account's id — `me` can
 * name another account before the session does, and the last account's restriction is never read
 * as this one's. A term restriction ends by itself at its `endsAt` (#45-12) on `now`'s clock (the
 * server's instant at the read, when the screen has one; the browser's otherwise): from that
 * instant it holds nothing, and the restriction is read again — nothing is published when a term
 * runs out. `me` undefined (a visitor, or not answered yet) reads nothing and blocks nothing.
 */
export function useAccountBlock(me: Me | undefined, now?: number) {
  const queryClient = useQueryClient();
  const restrictionOwner = me?.id ?? null;
  const restriction = useMyRestriction(restrictionOwner);
  const admin = me?.profile.role === 'admin';
  const heldRestriction = me === undefined ? null : (restriction.data?.accountRestriction ?? null);
  const refreshRestriction = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: myRestrictionKey(restrictionOwner),
      exact: true,
    });
  }, [queryClient, restrictionOwner]);
  const restrictionEnded = useInstantReached(
    heldRestriction?.endsAt ?? null,
    now,
    refreshRestriction,
  );
  const restrictedDetails = restrictionEnded ? null : heldRestriction;
  const account: AccountBlock = admin ? 'admin' : restrictedDetails !== null ? 'restricted' : null;
  return {
    /** The restriction read itself: whether it answered or failed is the caller's ladder. */
    restriction,
    account,
    restrictionEndsAt: restrictedDetails?.endsAt ?? null,
    /** The restriction answered or failed: a failed read holds nothing (the server refuses). */
    restrictionSettled: restriction.data !== undefined || restriction.isError,
  };
}
