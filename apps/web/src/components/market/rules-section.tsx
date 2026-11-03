import { Box, Card, DataList, Heading, Link as ChakraLink } from '@chakra-ui/react';
import { type RuleItem } from '@buddha/shared';
import { type ReactNode } from 'react';
import { DateTimeText } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { type Market } from '@/lib/api';
import {
  type RuleSource,
  longDelayText,
  ruleText,
  sourceView,
  voidPayoutText,
} from '@/lib/market-detail';

/**
 * 규칙 (PLAN 11.4 RulesSection, PLAN 11.1's Kalshi principle): what counts as YES and as NO, by
 * when, where the answer comes from, what a delay, a cancelled event or VOID means, and when
 * trading closes — the market's rule items (#23, ADR-0097), one row each in the admin form's
 * order, then the fixed 무효 지급 line and 마감. 배경 is a rule item too, but it is its own section
 * before this one (ADR-0067; `LiveBackgroundSection`).
 *
 * Never collapsed, and there is no prop to collapse it — that is the whole principle (ADR-0093
 * decision 3 '#23 문장 길이와 표시'), and a `Collapsible` here would be one screen refactor away
 * from hiding the section a visitor is asked to trust before spending Coin.
 *
 * No directive, so the section renders inside the server's HTML: AC 2 reads a rules snippet
 * (the YES 조건) out of view-source, before any hydration. Every text is plain on a `pre-wrap`
 * row — no markdown renderer exists in this repo, and adding one for a paragraph would be a
 * dependency plus an HTML-injection surface.
 *
 * A source's name opens its address in a new tab (ADR-0093 decision 3 '#23 출처 주소'; `sourceView`
 * for a half-filled one). `nofollow` as on any outside address, but not `ugc`: the operator wrote
 * it. The fallbacks are numbered in priority order, or read '없음' (#172 item 9), and the switch
 * condition has a row only while there is a fallback to switch to.
 *
 * The event deadline and the close time are the client islands in it (`DateTimeText`): they read
 * the member's zone (ADR-0063), which the server's HTML and the first client render give as KST,
 * so view-source still holds them. In the admin preview the admin layout holds them at KST.
 */

/** The repo's placeholder for a field the market has not filled in (admin-market-detail.tsx). */
const EMPTY = '—';

/**
 * What 규칙 draws: every rule item but 배경 (`RULE_ITEMS`), and the close time. `Market` satisfies
 * it; so does the synthetic row the admin preview builds from the form.
 */
export type RulesSectionMarket = Pick<Market, Exclude<RuleItem, 'description'> | 'closeAt'>;

export interface RulesSectionProps {
  market: RulesSectionMarket;
  /**
   * The card's id; each row's is this with its suffix (`-yes`, `-close-at`…). No default: each
   * caller has its own — the admin preview's must not be the form's ids beside it, and the market
   * detail renders one copy per width, each under that copy's id (`copyTestId`).
   */
  'data-testid': string;
}

export function RulesSection({ market, 'data-testid': testId }: RulesSectionProps) {
  const hasFallback = market.fallbackSources.length > 0;
  return (
    <Card.Root data-testid={testId}>
      <Card.Header>
        <Heading as="h2" size="md">
          {copy.rulesSectionTitle}
        </Heading>
      </Card.Header>
      <Card.Body>
        {/* Label above value below md, where a label column would leave a 5,000-character text
            a third of a phone's width; beside it from md up. */}
        <DataList.Root orientation={{ base: 'vertical', md: 'horizontal' }} size="sm">
          <Item label={copy.rulesYes} testId={`${testId}-yes`}>
            {ruleText(market.yesCondition) ?? EMPTY}
          </Item>
          <Item label={copy.rulesNo} testId={`${testId}-no`}>
            {ruleText(market.noCondition) ?? EMPTY}
          </Item>
          <Item label={copy.rulesEventDeadline} testId={`${testId}-event-deadline`}>
            {market.eventDeadline === null ? EMPTY : <DateTimeText iso={market.eventDeadline} />}
          </Item>
          <Item label={copy.rulesPrimarySource} testId={`${testId}-primary-source`}>
            <Source source={market.primarySource} />
          </Item>
          <Item label={copy.rulesFallbackSources} testId={`${testId}-fallback-sources`}>
            {hasFallback ? (
              <Box as="ol" ps="5" listStyleType="decimal">
                {market.fallbackSources.map((source, index) => (
                  // A fallback's place is its priority, so its index is its identity.
                  <Box as="li" key={index}>
                    <Source source={source} />
                  </Box>
                ))}
              </Box>
            ) : (
              copy.rulesFallbackNone
            )}
          </Item>
          {hasFallback && (
            <Item label={copy.rulesFallbackCondition} testId={`${testId}-fallback-condition`}>
              {ruleText(market.fallbackCondition) ?? EMPTY}
            </Item>
          )}
          <Item label={copy.rulesLongDelay} testId={`${testId}-long-delay`}>
            {longDelayText(market.longDelayDays) ?? EMPTY}
          </Item>
          <Item label={copy.rulesDelayHandling} testId={`${testId}-delay-handling`}>
            {ruleText(market.delayHandling) ?? EMPTY}
          </Item>
          <Item label={copy.rulesVoidPayout} testId={`${testId}-void-payout`}>
            {voidPayoutText()}
          </Item>
          <Item label={copy.rulesCloseAt} testId={`${testId}-close-at`}>
            <DateTimeText iso={market.closeAt} />
          </Item>
        </DataList.Root>
      </Card.Body>
    </Card.Root>
  );
}

/** A source: its name as a link to its address, or what `sourceView` leaves of a half one. */
function Source({ source }: { source: RuleSource | null }) {
  const view = sourceView(source);
  if (view === null) return EMPTY;
  if (view.href === null) return view.text;
  return (
    <ChakraLink
      href={view.href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      colorPalette="brand"
      color="colorPalette.fg"
      textDecoration="underline"
    >
      {view.text}
    </ChakraLink>
  );
}

function Item({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    // The direction restated: the horizontal recipe sets none, so the vertical one's column would
    // last past md. Top-aligned: a value of several lines keeps its label on its first.
    <DataList.Item flexDirection={{ base: 'column', md: 'row' }} alignItems="flex-start">
      <DataList.ItemLabel minW={{ md: '10rem' }}>{label}</DataList.ItemLabel>
      <DataList.ItemValue whiteSpace="pre-wrap" wordBreak="break-word" data-testid={testId}>
        {children}
      </DataList.ItemValue>
    </DataList.Item>
  );
}
