'use client';

import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { type AdminPayment, type RefundPaymentBody, api, isApiError, unwrap } from '@/lib/api';
import { type AdminPaymentPage, replacePaymentRow } from '@/lib/payments';

/** PLAN 12 결제 목록. Under the `admin` root (`PRIVATE_QUERY_ROOTS`). */
export const ADMIN_PAYMENTS_KEY = ['admin', 'payments'] as const;

/**
 * The whole admin root: a refund can move the member's balance (the 사용자 list shows it) as
 * well as the payment row, and the row is all the answer carries. Only the lists on screen
 * refetch; the rest are marked stale and reload when next shown.
 */
const ADMIN_ROOT_KEY = ['admin'] as const;

/** Every charge, newest first, 20 per page with 더 보기 (A-M2-5). */
export function useAdminPayments() {
  return useInfiniteQuery({
    queryKey: ADMIN_PAYMENTS_KEY,
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<AdminPaymentPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/payments', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AdminPaymentPage) => last.nextCursor ?? undefined,
  });
}

export interface RefundPaymentVariables {
  id: string;
  body: RefundPaymentBody;
}

/**
 * The cache writes of an answered refund — it hands back the row as it now is: seed it over its
 * copy, then confirm against the server. The whole admin root is refreshed, not only the list:
 * a refund can move the member's balance (the 사용자 list shows it) as well as the payment row.
 * A refusal refreshes too, awaited like a success: most of them mean the row is not what the
 * screen shows any more — a PG refusal put it back to `succeeded`, no answer left it
 * `refunding`, another admin got there first — and the toast must not land on the old row. A
 * request that never came back refreshes nothing.
 */
function useRefundCache() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ADMIN_ROOT_KEY });
  return {
    onSuccess: (fresh: AdminPayment) => {
      // Seed first, then confirm against the server, in one synchronous block: a list GET
      // already in flight cannot land between the two and put the old status back.
      queryClient.setQueriesData<InfiniteData<AdminPaymentPage>>(
        { queryKey: ADMIN_PAYMENTS_KEY },
        (old) => replacePaymentRow(old, fresh),
      );
      return refresh();
    },
    onError: async (error: unknown) => {
      if (isApiError(error)) await refresh();
    },
  };
}

/**
 * `POST /admin/payments/:id/refund` (ADR-0042 「관리자 환불」): take the P back, cancel the whole
 * KRW at the PG, or retry a `refunding` one. The toast and the dialog are the caller's, per
 * `mutate` call; the cache writes happen here, once (`useRefundCache`). A refusal after another
 * attempt refunded the payment answers 200 with the row `refunded`: a success like any other.
 * Closed while paid Coin is off (ADR-0049): the list offers no button then.
 */
export function useRefundPayment() {
  const cache = useRefundCache();
  return useMutation({
    mutationFn: async ({ id, body }: RefundPaymentVariables) =>
      unwrap(
        await api.POST('/api/v1/admin/payments/{id}/refund', { params: { path: { id } }, body }),
      ).data,
    ...cache,
  });
}
