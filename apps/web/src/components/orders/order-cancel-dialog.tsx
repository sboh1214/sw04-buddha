'use client';

import { DataList, Stack, Text } from '@chakra-ui/react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { copy } from '@/copy';
import { useHeldOrder } from '@/hooks/use-my-orders';
import { type Order } from '@/lib/api';
import { formatContracts } from '@/lib/market-admin';
import { cancelTargetOrder, isLiveOrder, remainingQty } from '@/lib/my-orders';
import { contractSideLabel, formatContractPrice } from '@/lib/order-confirm';
import { orderStatusLabel } from '@/lib/order-reasons';

/**
 * The confirmation's words beside its two buttons (ADR-0135 E1, ADR-0141 결정 4): '닫기', never
 * '취소' beside '주문 취소', and the focus on it as it opens — the other button ends the order.
 */
export const ORDER_CANCEL_DIALOG = {
  testId: 'order-cancel',
  dismissLabel: copy.close,
  initialFocus: 'dismiss',
} as const;

/**
 * 주문 취소's one confirmation (ADR-0135 E1; ADR-0141 결정 4): the market, the contract and side,
 * 한도가격, 남은 수량 and that it cannot be undone — drawn from the freshest reading the tab holds
 * (`order`, the list's row, joined with the detail key's), so a fill while it is open shows the
 * new 남은 수량. An order that ended meanwhile turns 주문 취소 off and says so. One per list or
 * detail, opened on an order's id: the row it was opened from may leave the list without taking
 * the dialog with it — the row as it opened stands in (`opened`) and the order's detail is asked
 * (`useHeldOrder`) until that answers (`cancelTargetOrder`). The parent keys it by the account
 * (`me.id`), so another account's `['me']` closes it.
 *
 * 주문 취소 closes it at once and sends the cancel (the parent's `onConfirm`): '취소 요청 중' is
 * drawn on the row and the detail, which a modal held open would cover.
 */
export function OrderCancelDialog({
  orderId,
  accountId,
  order: listed,
  opened,
  onClose,
  onConfirm,
  finalFocusEl,
}: {
  /** The order the dialog is open on, or null while closed. */
  orderId: string | null;
  accountId: string;
  /** The order as the list or the detail draws it now, if it still does. */
  order: Order | undefined;
  /** The row as it was drawn when the dialog opened: what stands once the list no longer draws it. */
  opened?: Order | undefined;
  onClose: () => void;
  onConfirm: (order: Order) => void;
  finalFocusEl?: () => HTMLElement | null;
}) {
  // Its list no longer draws it (ended, or slid past the loaded pages): its detail is asked.
  const held = useHeldOrder(
    orderId ?? undefined,
    accountId,
    orderId !== null && listed === undefined,
  );
  const order = cancelTargetOrder(orderId, listed, opened, held);
  const ended = order !== undefined && !isLiveOrder(order);
  const remaining = order === undefined ? null : remainingQty(order);
  return (
    <ConfirmDialog
      {...ORDER_CANCEL_DIALOG}
      {...(finalFocusEl === undefined ? {} : { finalFocusEl })}
      open={orderId !== null}
      onClose={onClose}
      title={copy.orderCancelTitle}
      confirmLabel={copy.orderCancel}
      loading={false}
      // A market that came to wait for a recovery while it was open is the server's to refuse:
      // the 409 says so and the row turns its button off (결정 5).
      confirmDisabled={order === undefined || ended}
      onConfirm={() => {
        if (order !== undefined) onConfirm(order);
      }}
    >
      {order !== undefined && (
        <Stack gap="3">
          <DataList.Root orientation="horizontal" size="sm" data-testid="order-cancel-terms">
            <DataList.Item>
              <DataList.ItemLabel>{copy.orderMarket}</DataList.ItemLabel>
              <DataList.ItemValue>
                {order.marketTitle ?? copy.postMarketNotPublic}
              </DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>{copy.orderContract}</DataList.ItemLabel>
              <DataList.ItemValue>
                {contractSideLabel(order.outcome, order.side)}
              </DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>{copy.orderLimit}</DataList.ItemLabel>
              <DataList.ItemValue fontVariantNumeric="tabular-nums">
                {formatContractPrice(order.limitPriceCoin)}
              </DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>{copy.orderRemainingQty}</DataList.ItemLabel>
              <DataList.ItemValue
                fontVariantNumeric="tabular-nums"
                data-testid="order-cancel-remaining"
              >
                {remaining === null ? copy.orderNone : formatContracts(remaining)}
              </DataList.ItemValue>
            </DataList.Item>
          </DataList.Root>
          {ended ? (
            <Text fontSize="sm" color="fg.warning" data-testid="order-cancel-ended">
              {copy.orderCancelEndedMeanwhile} {orderStatusLabel(order.status)}
            </Text>
          ) : (
            <Text fontSize="sm" data-testid="order-cancel-irreversible">
              {copy.orderCancelIrreversible}
            </Text>
          )}
        </Stack>
      )}
    </ConfirmDialog>
  );
}
