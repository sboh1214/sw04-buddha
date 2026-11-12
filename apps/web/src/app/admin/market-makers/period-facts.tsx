'use client';

import { Heading, Stack, Text } from '@chakra-ui/react';
import type { MarketMakerPeriodMetrics } from '@buddha/shared';
import { copy } from '@/copy';
import { formatKst } from '@/lib/datetime';
import { metricsCount, metricsPercent, metricsSeconds } from '@/lib/market-maker-metrics';
import { MetricsFields } from './metrics-facts';

/** The latest request's immutable facts; parent query guards the administrator and freshness. */
export function MakerPeriodFacts({ period }: { period: MarketMakerPeriodMetrics }) {
  const { activity, supply } = period;
  const ratio = (value: string | null) => (value === null ? '—' : metricsPercent(value));
  return (
    <Stack gap="4" data-testid="maker-period-metrics">
      <Heading as="h4" size="sm">
        {copy.makerPeriodTitle}
      </Heading>
      <Text fontSize="sm">
        {period.window.from
          ? `${formatKst(period.window.from)} – ${formatKst(period.window.to)}`
          : copy.makerPeriodNotOpened}
      </Text>
      <Text fontSize="sm">{copy.makerPeriodOrdersGuide}</Text>
      {activity.coverage !== 'complete' && (
        <Text role="status" fontSize="sm">
          {activity.coverage === 'unavailable'
            ? copy.makerPeriodUnobserved
            : copy.makerPeriodPartialOrders}
        </Text>
      )}
      <MetricsFields
        fields={[
          [copy.makerPeriodPosted, activity.bot ? metricsCount(activity.bot.postedQty) : '—'],
          [copy.makerPeriodFilled, activity.bot ? metricsCount(activity.bot.filledQty) : '—'],
          [copy.makerPeriodFillRate, activity.bot ? ratio(activity.bot.fillBp) : '—'],
          [
            copy.makerPeriodIocOrders,
            activity.humanIoc ? metricsCount(activity.humanIoc.orders) : '—',
          ],
          [
            copy.makerPeriodIocFilled,
            activity.humanIoc ? metricsCount(activity.humanIoc.filledOrders) : '—',
          ],
          [copy.makerPeriodIocRate, activity.humanIoc ? ratio(activity.humanIoc.fillBp) : '—'],
        ]}
      />
      <Heading as="h4" size="sm">
        {copy.makerPeriodSupply}
      </Heading>
      <Text fontSize="sm">{copy.makerPeriodSupplyGuide}</Text>
      <Text fontSize="sm">{copy.makerPeriodSupplyLimits}</Text>
      {supply.coverage === 'unavailable' ? (
        <Text role="status">{copy.makerPeriodUnobserved}</Text>
      ) : (
        <>
          {supply.coverage === 'partial' && (
            <Text role="status" fontSize="sm">
              {copy.makerPeriodPartialSupply}
            </Text>
          )}
          <Text fontSize="sm">
            {copy.makerPeriodObserved}: {formatKst(supply.observedFrom!)} –{' '}
            {formatKst(supply.observedTo!)}
          </Text>
          <MetricsFields
            fields={[
              [copy.makerPeriodOpenSeconds, metricsSeconds(supply.openMs)],
              [copy.makerPeriodBotGap, metricsSeconds(supply.botGapMs)],
              [copy.makerPeriodCombinedGap, metricsSeconds(supply.combinedGapMs)],
            ]}
          />
        </>
      )}
    </Stack>
  );
}
