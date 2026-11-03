import { Box, Card, DataList, Heading, Link as ChakraLink } from '@chakra-ui/react';
import { type RuleItem, type TimeItem, longDelayDeadline } from '@buddha/shared';
import { type ReactNode } from 'react';
import { DateTimeText, TimeZoneNameText } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { type Market } from '@/lib/api';
import {
  LONG_DELAY_SEPARATOR,
  type RuleSource,
  longDelayText,
  ruleText,
  showsScheduledOpen,
  sourceView,
  voidPayoutText,
} from '@/lib/market-detail';

/**
 * 규칙 (PLAN 11.4 RulesSection, PLAN 11.1's Kalshi principle): what counts as YES and as NO, by
 * when, where the answer comes from, what a delay, a cancelled event or VOID means, and when
 * trading closes and the market is judged — the market's rule items (#23, ADR-0097), one row each
 * in the admin form's order, then the fixed 무효 지급 line, then its times (#22, ADR-0098, in the
 * form's order too): 예정 개장 시각 while it has not opened (`showsScheduledOpen`), 거래 마감 시각,
 * 발표 예정 시각 ('없음' for an event with no scheduled release, #172 item 13), 예정 판정 시각 and
 * 판정 기준 시간대. The times are rules: #172 item 7 puts them in the rule version. 배경 is a rule
 * item too, but it is its own section before this one (ADR-0067; `LiveBackgroundSection`).
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
 * Every time — 사건 기한, the 장기 지연 기한 instant and the times — is a client island in it
 * (`DateTimeText`): it reads the member's zone (ADR-0063), which the server's HTML and the first
 * client render give as KST, so view-source still holds it. Once the zone is settled, a time also
 * reads in the market's 판정 기준 시간대 on a second line when that is another zone (ADR-0093
 * decision 3 '#22 시간대'); the zone row's Korean name follows hydration too (`TimeZoneNameText`).
 * In the admin preview the admin layout holds them all at KST, with no second line.
 */

/** The repo's placeholder for a field the market has not filled in (admin-market-detail.tsx). */
const EMPTY = '—';

/**
 * What 규칙 draws: every rule item but 배경 (`RULE_ITEMS`), the times and the 판정 기준 시간대
 * (`TIME_ITEMS`), and the status, which says whether the 예정 개장 시각 row is drawn. `Market`
 * satisfies it; so does the synthetic row the admin preview builds from the form.
 */
export type RulesSectionMarket = Pick<
  Market,
  Exclude<RuleItem, 'description'> | TimeItem | 'status'
>;

export interface RulesSectionProps {
  market: RulesSectionMarket;
  /**
   * The card's id; each row's is this with its suffix (`-yes`, `-close-at`…), and a time's two
   * lines that with `-viewer-zone` and `-judgement-zone` (`DateTimeText`). No default: each
   * caller has its own — the admin preview's must not be the form's ids beside it, and the market
   * detail renders one copy per width, each under that copy's id (`copyTestId`).
   */
  'data-testid': string;
}

export function RulesSection({ market, 'data-testid': testId }: RulesSectionProps) {
  const hasFallback = market.fallbackSources.length > 0;
  const zone = market.judgementTimeZone;
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
            <Time iso={market.eventDeadline} zone={zone} testId={`${testId}-event-deadline`} />
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
            <LongDelay market={market} testId={`${testId}-long-delay`} />
          </Item>
          <Item label={copy.rulesDelayHandling} testId={`${testId}-delay-handling`}>
            {ruleText(market.delayHandling) ?? EMPTY}
          </Item>
          <Item label={copy.rulesVoidPayout} testId={`${testId}-void-payout`}>
            {voidPayoutText()}
          </Item>
          {showsScheduledOpen(market.status) && (
            <Item label={copy.rulesScheduledOpenAt} testId={`${testId}-scheduled-open-at`}>
              <Time
                iso={market.scheduledOpenAt}
                zone={zone}
                testId={`${testId}-scheduled-open-at`}
              />
            </Item>
          )}
          <Item label={copy.rulesCloseAt} testId={`${testId}-close-at`}>
            <Time iso={market.closeAt} zone={zone} testId={`${testId}-close-at`} />
          </Item>
          <Item label={copy.rulesAnnouncementAt} testId={`${testId}-announcement-at`}>
            {/* No announcement time is '없음', an event with no scheduled release (#172 item 13). */}
            {market.scheduledAnnouncementAt === null ? (
              copy.rulesAnnouncementNone
            ) : (
              <Time
                iso={market.scheduledAnnouncementAt}
                zone={zone}
                testId={`${testId}-announcement-at`}
              />
            )}
          </Item>
          <Item label={copy.rulesJudgementAt} testId={`${testId}-judgement-at`}>
            <Time iso={market.scheduledJudgementAt} zone={zone} testId={`${testId}-judgement-at`} />
          </Item>
          <Item label={copy.rulesJudgementTimeZone} testId={`${testId}-judgement-time-zone`}>
            {zone === null ? EMPTY : <TimeZoneNameText zone={zone} />}
          </Item>
        </DataList.Root>
      </Card.Body>
    </Card.Root>
  );
}

/**
 * A time of the rules: `DateTimeText` in the viewer's zone, with the market's 판정 기준 시간대 as
 * its second line when that differs, or '—' for one not filled in (a draft's, or a market's opened
 * before #22).
 */
function Time({ iso, zone, testId }: { iso: string | null; zone: string | null; testId: string }) {
  if (iso === null) return EMPTY;
  return <DateTimeText iso={iso} judgementTimeZone={zone} testId={testId} />;
}

/**
 * 장기 지연 기한: '예정 판정 시각에서 N일 뒤' (`longDelayText`), and once the market has a scheduled
 * judgement the instant itself (`longDelayDeadline`, #172 item 10: N×24 hours) — the one #142 and
 * #145 act on — so the reader adds no days (#22, ADR-0098). '—' while the days are not set.
 */
function LongDelay({ market, testId }: { market: RulesSectionMarket; testId: string }) {
  const text = longDelayText(market.longDelayDays);
  if (text === null) return EMPTY;
  const deadline = longDelayDeadline(market.scheduledJudgementAt, market.longDelayDays);
  if (deadline === null) return text;
  return (
    <>
      {text}
      {LONG_DELAY_SEPARATOR}
      <DateTimeText iso={deadline} judgementTimeZone={market.judgementTimeZone} testId={testId} />
    </>
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
    // last past md. Top-aligned: a value of several lines keeps its label on its first. The value
    // is a block, not the recipe's flex row: a time's judgement zone line (`DateTimeText`, #22)
    // goes under the time, and text runs on as text.
    <DataList.Item flexDirection={{ base: 'column', md: 'row' }} alignItems="flex-start">
      <DataList.ItemLabel minW={{ md: '10rem' }}>{label}</DataList.ItemLabel>
      <DataList.ItemValue
        display="block"
        whiteSpace="pre-wrap"
        wordBreak="break-word"
        data-testid={testId}
      >
        {children}
      </DataList.ItemValue>
    </DataList.Item>
  );
}
