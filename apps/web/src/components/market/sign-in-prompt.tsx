'use client';

import { Button } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { loginPathBackTo } from '@/lib/next-path';

/**
 * A signed-out visitor's sign-in prompt on the market detail (#122, owner decisions 2026-10-17,
 * ADR-0067): one sentence saying what signing in shows or allows, and 로그인, which comes back to
 * this market (`loginPathBackTo`, the 관심 등록 button's way back). The same `EmptyState` the other
 * signed-out rungs draw (MY's `SessionEnded`, the home's 관심 시장 view).
 *
 * Two places use it: where the personal areas stand (`market-detail.tsx`, one prompt for 내 포지션,
 * 내 대기 주문 and 내 거래) and the mobile order sheet (`order-entry-bar.tsx`, since an order is
 * placed signed in — N02 §2). Neither is in the server's HTML: each is drawn only once the session
 * is known to be nobody's (`personalAreaView`), so the page is the same for every visitor.
 */
export function SignInPrompt({
  message,
  'data-testid': testId,
}: {
  /** Korean, from `copy`. */
  message: string;
  'data-testid'?: string;
}) {
  const pathname = usePathname();
  return (
    <EmptyState
      message={message}
      action={
        <Button asChild size="sm" variant="outline">
          <NextLink
            href={loginPathBackTo(pathname) as Route}
            data-testid={testId === undefined ? undefined : `${testId}-login`}
          >
            {copy.login}
          </NextLink>
        </Button>
      }
      data-testid={testId}
    />
  );
}
