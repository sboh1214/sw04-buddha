import { Stack, Text } from '@chakra-ui/react';

/**
 * The one muted "아직 없습니다" block every M4 list uses (PLAN 11.4): the home grid, 최근 체결,
 * 내 포지션 and each of MY's lists (보유 계약, 대기 주문, 주문 이력, 정산 이력).
 *
 * Deliberately not Chakra's `EmptyState.Root`/`Indicator`/`Title`/`Description`. The repo
 * already says this in one muted line (`ledger-list.tsx`), an icon would be the only new thing
 * the namespace brings, and a component with four slots invites four different empty states
 * across the screens that share this one. The action is a node rather than a label plus a
 * handler, so a caller can pass either a `Button` or a `Button asChild` wrapping a `NextLink`
 * without this file learning about routing.
 *
 * No `role="status"` and no `aria-live`: an empty list is the page's initial content, not a
 * change to announce, and a live region here would fire on every filter switch.
 */
export interface EmptyStateProps {
  /** Korean, from `copy` — never assembled here. */
  message: string;
  /** Optional single next step, e.g. 로그인 or 검색 지우기. */
  action?: React.ReactNode;
  'data-testid'?: string;
}

export function EmptyState({ message, action, 'data-testid': testId }: EmptyStateProps) {
  return (
    <Stack align="center" gap="3" py="8" px="4" textAlign="center" data-testid={testId}>
      {/* `fg.muted` is 7.73:1 light / 8.19:1 dark — muted to the eye, still AA (AC 6). */}
      <Text color="fg.muted">{message}</Text>
      {action}
    </Stack>
  );
}
