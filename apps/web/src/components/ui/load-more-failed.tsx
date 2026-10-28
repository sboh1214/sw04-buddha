import { Alert } from '@chakra-ui/react';
import { moreFailed } from '@/lib/query-client';

/**
 * The notice above a 더 보기 that failed (owner decision 2026-10-20 7, ADR-0075): every 더 보기 list
 * draws this right before its button, inside the same condition, so the two come and go together —
 * where no 더 보기 is offered (the MY summary's 관심 시장 preview, a page with nothing after it) it
 * says nothing about one. The MY summary's 대기 주문 and 주문 이력 previews DO offer 더 보기 until
 * they hold their rows (`showMoreOrders`), so this shows under the one that still lacks them — only
 * ever one: both split one `GET /me/orders` list, a page with another after it holds 20 orders, so
 * one side then holds 10 or more, past the preview's 3, and offers no 더 보기 (ADR-0075 5-14(c)).
 *
 * It shows while `moreFailed` holds (lib/query-client.ts): the next page refused through the
 * client's retries and not being asked again — kept through a cache write such as the socket's on
 * the market grids and 관심 시장, which resets the query's own error flags (`moreFailures`). The
 * rows stay above it and the button below it is the way to ask again, so it has no button of its
 * own.
 *
 * The message is the list's own first-read failure — an unreachable server told apart where that
 * list tells it apart (`postReadErrorMessage`, `searchErrorMessage`), `copy.errUnknown` ('문제가
 * 발생했습니다. 잠시 후 다시 시도해 주세요.') elsewhere — so no new copy: nothing more came, for the
 * reason a first read would have given. Not the refresh notice (`copy.marketRefreshFailed`), which
 * says what is shown may be old. `role="alert"`, as a first read's failure: it answers the reader's
 * press.
 */
export function LoadMoreFailed({
  list,
  message,
  'data-testid': testId,
}: {
  list: { isFetchNextPageError: boolean; isFetchingNextPage: boolean; failureReason: unknown };
  /** Korean, from `copy` — the list's first-read failure. */
  message: string;
  'data-testid': string;
}) {
  if (!moreFailed(list)) return null;
  return (
    <Alert.Root status="error" role="alert" data-testid={testId}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{message}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}
