import { Badge, Box, Card, DataList, HStack, Heading, Stack, Text } from '@chakra-ui/react';
import { RULE_VERSION_ITEMS, type RuleVersionItem } from '@buddha/shared';
import { DateTimeText, TimeZoneNameText } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { type Market, type MarketRuleContent } from '@/lib/api';
import { backgroundText, ruleText } from '@/lib/market-detail';
import {
  RULE_VERSION_PUBLIC_LABEL,
  type RuleVersionView,
  ruleVersionName,
  ruleVersionViews,
} from '@/lib/rule-versions';
import { RuleLongDelay, RuleRow, RuleSourceLink, RuleTime } from './rules-section';

/**
 * 규칙 버전 (#80, ADR-0101; ADR-0093 decision 2 #172 items 6·7·15, decision 3 '#80 보충의 형태'): the
 * card after 규칙 on the public detail — '규칙 버전' with '현재 v3', then every version, the newest
 * first: when it began (the open for v1, '개장 때 고정'; an approved supplement's instant for a later
 * one), the supplement's reason, and each item it changed with that item's text in the version
 * before ('이전') and in this one ('새 문구'), as the rules area words it — the times in the viewer's
 * zone with the 판정 기준 시간대 line (`DateTimeText`), a source by its name linked. Every version
 * but the current one also opens its full text (a disclosure): the current one's is the rules
 * area above, which stays open (decision 3 '#23 문장 길이와 표시'); this card is apart from it, and
 * its disclosure is the owner's to confirm (ADR-0101 오너 확인). Nobody's name and no 정산 영향 검토:
 * the API sends neither (#172 item 15, #173 item 13's analogue).
 *
 * Nothing for a market with no version — before the open, or opened before #80 (D4). No directive:
 * it renders in the server's HTML, as 규칙 does, for a signed-out visitor and on a closed market
 * alike (N02 §2, N05 §3), and the disclosure is a native `details` that needs no script. Live
 * through `LiveRulesSection`, which reads the `['market', id]` row an approval's `market:status`
 * refetches.
 *
 * Ids under `data-testid` (the card's, a copy's per width): `-current` the current version,
 * `-version-<n>` each version (`data-current` on the newest) with `-at`, `-fixed` (v1), `-reason`,
 * `-changes` and per changed item `-change-<item>` with its `-before` and `-after`, and `-full`
 * the disclosure with a row `-full-<item>` per item.
 */
export type RuleVersionsMarket = Pick<Market, 'ruleVersion' | 'ruleVersions'>;

export function RuleVersionsSection({
  market,
  'data-testid': testId,
}: {
  market: RuleVersionsMarket;
  'data-testid': string;
}) {
  if (market.ruleVersion === null || market.ruleVersions.length === 0) return null;
  const views = ruleVersionViews(market.ruleVersions);
  return (
    <Card.Root data-testid={testId}>
      <Card.Header>
        <Stack gap="1">
          <HStack gap="2" flexWrap="wrap" align="baseline">
            <Heading as="h2" size="md">
              {copy.ruleVersionsTitle}
            </Heading>
            <Badge colorPalette="brand" variant="subtle" data-testid={`${testId}-current`}>
              {copy.ruleVersionsCurrent} {ruleVersionName(market.ruleVersion)}
            </Badge>
          </HStack>
          <Text fontSize="sm" color="fg.muted">
            {copy.ruleVersionsIntro}
          </Text>
        </Stack>
      </Card.Header>
      <Card.Body>
        <Stack as="ol" gap="6" listStyleType="none">
          {views.map((view) => (
            <VersionEntry
              key={view.version}
              view={view}
              testId={`${testId}-version-${String(view.version)}`}
            />
          ))}
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

/** One version: its name, when it began, its reason, its changes and (not the current) its text. */
function VersionEntry({ view, testId }: { view: RuleVersionView; testId: string }) {
  const zone = view.content.judgementTimeZone;
  return (
    <Stack as="li" gap="3" data-testid={testId} data-current={view.current ? 'true' : undefined}>
      <HStack gap="2" flexWrap="wrap" align="baseline">
        <Text as="span" fontWeight="semibold">
          {ruleVersionName(view.version)}
        </Text>
        {view.current && (
          <Badge size="sm" variant="outline">
            {copy.ruleVersionsCurrent}
          </Badge>
        )}
        {view.fixedAtOpen && (
          <Text as="span" fontSize="sm" color="fg.muted" data-testid={`${testId}-fixed`}>
            {copy.ruleVersionsFixedAtOpen}
          </Text>
        )}
      </HStack>
      <DataList.Root orientation={{ base: 'vertical', md: 'horizontal' }} size="sm">
        <RuleRow label={copy.ruleVersionsCreatedAt} testId={`${testId}-at`}>
          <DateTimeText iso={view.createdAt} judgementTimeZone={zone} testId={`${testId}-at`} />
        </RuleRow>
        {view.reason !== null && (
          <RuleRow label={copy.ruleVersionsReason} testId={`${testId}-reason`}>
            {view.reason}
          </RuleRow>
        )}
      </DataList.Root>
      {view.changes.length > 0 && (
        <Stack gap="3" data-testid={`${testId}-changes`}>
          <Text fontSize="sm" fontWeight="medium">
            {copy.ruleVersionsChanges}
          </Text>
          {view.changes.map((item) => (
            <Stack
              key={item}
              gap="1"
              ps="3"
              borderStartWidth="2px"
              data-testid={`${testId}-change-${item}`}
            >
              <Text fontSize="sm" fontWeight="medium">
                {RULE_VERSION_PUBLIC_LABEL[item]}
              </Text>
              <DataList.Root orientation={{ base: 'vertical', md: 'horizontal' }} size="sm">
                {view.previous !== null && (
                  <RuleRow
                    label={copy.ruleVersionsBefore}
                    testId={`${testId}-change-${item}-before`}
                  >
                    <VersionItemValue
                      item={item}
                      content={view.previous}
                      testId={`${testId}-change-${item}-before`}
                    />
                  </RuleRow>
                )}
                <RuleRow label={copy.ruleVersionsAfter} testId={`${testId}-change-${item}-after`}>
                  <VersionItemValue
                    item={item}
                    content={view.content}
                    testId={`${testId}-change-${item}-after`}
                  />
                </RuleRow>
              </DataList.Root>
            </Stack>
          ))}
        </Stack>
      )}
      {!view.current && (
        <Box as="details" fontSize="sm" data-testid={`${testId}-full`}>
          <Box as="summary" cursor="pointer" color="fg.muted" width="fit-content">
            {copy.ruleVersionsFullText}
          </Box>
          <DataList.Root orientation={{ base: 'vertical', md: 'horizontal' }} size="sm" mt="3">
            {RULE_VERSION_ITEMS.filter((item) => shownInFullText(item, view.content)).map(
              (item) => (
                <RuleRow
                  key={item}
                  label={RULE_VERSION_PUBLIC_LABEL[item]}
                  testId={`${testId}-full-${item}`}
                >
                  <VersionItemValue
                    item={item}
                    content={view.content}
                    testId={`${testId}-full-${item}`}
                  />
                </RuleRow>
              ),
            )}
          </DataList.Root>
        </Box>
      )}
    </Stack>
  );
}

/**
 * Whether a version's full text has a row for `item`: every item, but the switch condition only
 * while there is a fallback to switch to — as the rules area draws it (#172 item 9).
 */
function shownInFullText(item: RuleVersionItem, content: MarketRuleContent): boolean {
  return item !== 'fallbackCondition' || content.fallbackSources.length > 0;
}

/** The placeholder of an item not filled in, as the rules area's. */
const EMPTY = '—';

/** One item's value in a version's text, as the rules area (rules-section.tsx) words it. */
function VersionItemValue({
  item,
  content,
  testId,
}: {
  item: RuleVersionItem;
  content: MarketRuleContent;
  testId: string;
}) {
  const zone = content.judgementTimeZone;
  switch (item) {
    case 'title':
      return ruleText(content.title) ?? EMPTY;
    case 'description':
      return backgroundText(content.description) ?? EMPTY;
    case 'yesCondition':
    case 'noCondition':
    case 'fallbackCondition':
    case 'delayHandling':
      return ruleText(content[item]) ?? EMPTY;
    case 'eventDeadline':
    case 'scheduledOpenAt':
    case 'closeAt':
    case 'scheduledJudgementAt':
      return <RuleTime iso={content[item]} zone={zone} testId={testId} />;
    case 'scheduledAnnouncementAt':
      // No announcement time is '없음', an event with no scheduled release (#172 item 13).
      return content.scheduledAnnouncementAt === null ? (
        copy.rulesAnnouncementNone
      ) : (
        <RuleTime iso={content.scheduledAnnouncementAt} zone={zone} testId={testId} />
      );
    case 'primarySource':
      return <RuleSourceLink source={content.primarySource} />;
    case 'fallbackSources':
      return content.fallbackSources.length === 0 ? (
        copy.rulesFallbackNone
      ) : (
        <Box as="ol" ps="5" listStyleType="decimal">
          {content.fallbackSources.map((source, index) => (
            // A fallback's place is its priority, so its index is its identity.
            <Box as="li" key={index}>
              <RuleSourceLink source={source} />
            </Box>
          ))}
        </Box>
      );
    case 'longDelayDays':
      return <RuleLongDelay market={content} testId={testId} />;
    case 'judgementTimeZone':
      return zone === null ? EMPTY : <TimeZoneNameText zone={zone} />;
  }
}
