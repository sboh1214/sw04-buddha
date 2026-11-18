'use client';

import { Field, NativeSelect } from '@chakra-ui/react';
import { RECENT_PERIODS, type RecentPeriod } from '@buddha/shared';
import { copy } from '@/copy';
import { PILL_SELECT } from '../market-filters';

/** Each fixed choice's name (ADR-0135 G3 (a)): '최근 N일' is N × 24 hours back from the read. */
const PERIOD_LABEL: Record<RecentPeriod, string> = {
  '7d': copy.historyPeriod7d,
  '30d': copy.historyPeriod30d,
  '90d': copy.historyPeriod90d,
};

/**
 * 기간 (#124, ADR-0143 결정 6; ADR-0135 G3): 전체 기간 — the choice a list opens on — and the three
 * fixed ones, as the home's pill select (`PILL_SELECT`) with its label for screen readers only.
 * It hands the token up and nothing else: the server opens the window from its own clock at each
 * read, so no browser time is read here. 거래·정산 이력 uses it; the wallet (#69) is to share it.
 *
 * `pending` marks it busy while the address it wrote is still on its way — the list under it is
 * the old one until then.
 */
export function PeriodSelect({
  value,
  onChange,
  pending = false,
  testId,
}: {
  /** The period on, or undefined for 전체 기간. */
  value: RecentPeriod | undefined;
  onChange: (period: RecentPeriod | undefined) => void;
  pending?: boolean;
  testId: string;
}) {
  return (
    <Field.Root width="auto">
      <Field.Label srOnly>{copy.historyPeriodLabel}</Field.Label>
      <NativeSelect.Root size="md" opacity={pending ? 0.6 : undefined}>
        <NativeSelect.Field
          {...PILL_SELECT}
          value={value ?? ''}
          aria-busy={pending}
          onChange={(event) => {
            const picked = RECENT_PERIODS.find((period) => period === event.target.value);
            onChange(picked);
          }}
          data-testid={testId}
        >
          <option value="">{copy.historyPeriodAll}</option>
          {RECENT_PERIODS.map((period) => (
            <option key={period} value={period}>
              {PERIOD_LABEL[period]}
            </option>
          ))}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
    </Field.Root>
  );
}
