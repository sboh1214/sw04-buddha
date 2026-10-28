import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { Section } from './portfolio';

/**
 * A MY tab whose content its own issue brings (알림 #53): shown as 준비 중 rather than hidden (owner
 * decision 2026-10-13), as its tab page and as its preview on `/my`. 관심 시장 left this list with
 * #89 (ADR-0064), 내 글 with #51 (ADR-0080).
 */
export function ComingSoonTab({ title, testId }: { title: string; testId: string }) {
  return (
    <Section title={title} testId={testId}>
      <EmptyState message={copy.comingSoon} data-testid={`${testId}-coming-soon`} />
    </Section>
  );
}
