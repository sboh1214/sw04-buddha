'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isApiError, isForAnotherAccount, type SignupAllowlist, unwrap } from '@/lib/api';
import { useSession } from '@/lib/use-session';

/**
 * 가입 허용 목록 (#330, ADR-0174). Under the `admin` root (`PRIVATE_QUERY_ROOTS`): the list, its
 * summary and the clear that waits are one answer, and every write answers the list as it left it.
 */
export const SIGNUP_ALLOWLIST_KEY = ['admin', 'signup-allowlist'] as const;

/** `GET /admin/signup-allowlist`: the entries, the summary #149 reads and the waiting clear. */
export function useSignupAllowlist() {
  return useQuery({
    queryKey: SIGNUP_ALLOWLIST_KEY,
    queryFn: async ({ signal }): Promise<SignupAllowlist> =>
      unwrap(await api.GET('/api/v1/admin/signup-allowlist', { signal })).data,
  });
}

/**
 * What every write does with its answer: the list it left goes into the cache. A refusal reads the
 * list again — another admin may have changed it first — and the refusal that the cookie is another
 * account's (another tab signed in) refetches the session instead, so SessionCacheGuard empties
 * the cache. Toasts and field errors are the caller's.
 */
function useAllowlistWrite() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return {
    settle: (allowlist: SignupAllowlist) => {
      queryClient.setQueryData(SIGNUP_ALLOWLIST_KEY, allowlist);
    },
    onError: async (error: unknown) => {
      if (isForAnotherAccount(error)) {
        void refetchSession();
        return;
      }
      if (isApiError(error))
        await queryClient.invalidateQueries({ queryKey: SIGNUP_ALLOWLIST_KEY });
    },
  };
}

/** Every write names the admin on screen (`useOperatorId`, ADR-0091); the server checks it. */
interface Operator {
  expectedAccountId: string;
}

/** `POST /admin/signup-allowlist`: numbers (digits or as typed), one reason. */
export function useAddSignupAllowlist() {
  const { settle, onError } = useAllowlistWrite();
  return useMutation({
    mutationFn: async (body: Operator & { phones: string[]; reason: string }) =>
      unwrap(await api.POST('/api/v1/admin/signup-allowlist', { body })).data,
    onSuccess: (result) => settle(result.allowlist),
    onError,
  });
}

/** `POST /admin/signup-allowlist/remove`: one number, with a reason — never the last. */
export function useRemoveSignupAllowlist() {
  const { settle, onError } = useAllowlistWrite();
  return useMutation({
    mutationFn: async (body: Operator & { phone: string; reason: string }) =>
      unwrap(await api.POST('/api/v1/admin/signup-allowlist/remove', { body })).data,
    onSuccess: settle,
    onError,
  });
}

/** `POST /admin/signup-allowlist/clear-requests`: ask another admin to empty the list. */
export function useRequestSignupAllowlistClear() {
  const { settle, onError } = useAllowlistWrite();
  return useMutation({
    mutationFn: async (body: Operator & { reason: string; confirmation: string }) =>
      unwrap(await api.POST('/api/v1/admin/signup-allowlist/clear-requests', { body })).data,
    onSuccess: (result) => settle(result.allowlist),
    onError,
  });
}

export interface ClearDecisionVariables extends Operator {
  requestId: string;
  decision: 'approve' | 'reject';
  reason: string;
}

/** Another admin's approval (every entry goes) or 반려 of the waiting clear. */
export function useDecideSignupAllowlistClear() {
  const { settle, onError } = useAllowlistWrite();
  return useMutation({
    mutationFn: async ({
      requestId,
      decision,
      reason,
      expectedAccountId,
    }: ClearDecisionVariables) =>
      unwrap(
        decision === 'approve'
          ? await api.POST('/api/v1/admin/signup-allowlist/clear-requests/{requestId}/approve', {
              params: { path: { requestId } },
              body: { reason, expectedAccountId },
            })
          : await api.POST('/api/v1/admin/signup-allowlist/clear-requests/{requestId}/reject', {
              params: { path: { requestId } },
              body: { reason, expectedAccountId },
            }),
      ).data,
    onSuccess: (result) => settle(result.allowlist),
    onError,
  });
}

/** Its requester's retraction of the waiting clear. */
export function useRetractSignupAllowlistClear() {
  const { settle, onError } = useAllowlistWrite();
  return useMutation({
    mutationFn: async ({ requestId, expectedAccountId }: Operator & { requestId: string }) =>
      unwrap(
        await api.POST('/api/v1/admin/signup-allowlist/clear-requests/{requestId}/retract', {
          params: { path: { requestId } },
          body: { expectedAccountId },
        }),
      ).data,
    onSuccess: (result) => settle(result.allowlist),
    onError,
  });
}
