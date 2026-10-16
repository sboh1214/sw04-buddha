import { Card, DataList, Heading, Stack, Text } from '@chakra-ui/react';
import { type ReactNode } from 'react';
import { DateTimeText } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';

/**
 * 규칙 (PLAN 11.4 RulesSection, PLAN 11.1's Kalshi principle): what counts as YES, where
 * the answer comes from, and when it is decided.
 *
 * Never collapsed, and there is no prop to collapse it — that is the whole principle, and a
 * `Collapsible` here would be one screen refactor away from hiding the section a visitor is
 * asked to trust before spending Coin.
 *
 * No directive, so the section renders inside the server's HTML: AC 2 reads a rules snippet
 * out of view-source, before any hydration. The rules are plain text on a `pre-wrap` block —
 * the admin form's help text calls them 마크다운, but no markdown renderer exists in this repo
 * and adding one for a paragraph would be a dependency plus an HTML-injection surface.
 *
 * The close time is the one client island in it (`DateTimeText`): it reads the member's zone
 * (ADR-0063), which the server's HTML and the first client render give as KST, so view-source
 * still holds it. In the admin preview the admin layout holds it at KST.
 */

/** The repo's placeholder for a field the market has not filled in (admin-market-detail.tsx). */
const EMPTY = '—';

export interface RulesSectionProps {
  /** `Market` satisfies this; so does the synthetic row the admin preview builds. */
  market: { rules: string; resolutionSource: string | null; closeAt: string };
  /**
   * Defaults to `market-rules`. The admin form's 규칙 textarea already owns that id, so
   * the preview beside it must pass its own.
   */
  'data-testid'?: string;
}

export function RulesSection({
  market,
  'data-testid': testId = 'market-rules',
}: RulesSectionProps) {
  return (
    <Card.Root data-testid={testId}>
      <Card.Header>
        <Heading as="h2" size="md">
          {copy.rulesSectionTitle}
        </Heading>
      </Card.Header>
      <Card.Body>
        <Stack gap="4">
          <Text whiteSpace="pre-wrap" wordBreak="break-word">
            {market.rules || EMPTY}
          </Text>
          <DataList.Root orientation="horizontal" size="sm">
            <Item label={copy.rulesSource}>
              {/* `||`, not `??`: the API sends an unset source as null and a cleared one as an
                  empty string, and both mean the same thing to a reader. */}
              {market.resolutionSource || copy.rulesNone}
            </Item>
            <Item label={copy.rulesCloseAt} testId={`${testId}-close-at`}>
              <DateTimeText iso={market.closeAt} />
            </Item>
          </DataList.Root>
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

function Item({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue whiteSpace="pre-wrap" wordBreak="break-word" data-testid={testId}>
        {children}
      </DataList.ItemValue>
    </DataList.Item>
  );
}
