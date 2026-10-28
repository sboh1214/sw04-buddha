import { Card, Heading } from '@chakra-ui/react';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';

/**
 * A section of the market detail whose content its own issue brings — 호가창 (#179), 내 거래 (#121),
 * 내 대기 주문 (#123), 공개 판정 기록 (#24); 토론 was one until #47 filled it (ADR-0075) — drawn as
 * its title and '준비 중입니다.' rather than left out (owner decision, ADR-0061 decision 3, the #122
 * row): MY's `ComingSoonTab` on the detail's own card. The same card and `h2` as the sections
 * beside it (규칙, 최근 체결, 내 포지션), so each slot is already the heading a screen reader can jump
 * to, and the issue that fills it replaces the body, not the frame.
 *
 * No directive: it reads nothing, so the server renders it into the HTML like the rules. Whether a
 * personal slot is drawn at all is the caller's (`personalAreaView`, lib/market-detail.ts).
 */
export function ComingSoonSection({ title, testId }: { title: string; testId: string }) {
  return (
    <Card.Root data-testid={testId}>
      <Card.Header>
        <Heading as="h2" size="md">
          {title}
        </Heading>
      </Card.Header>
      <Card.Body>
        <EmptyState message={copy.comingSoon} data-testid={`${testId}-coming-soon`} />
      </Card.Body>
    </Card.Root>
  );
}
