'use client';

import { Field, NativeSelect } from '@chakra-ui/react';
import { LEDGER_FILTER_KINDS, type LedgerFilterKind } from '@buddha/shared';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { copy } from '@/copy';
import {
  LEDGER_FILTER_OPTIONS,
  type WalletFilters as WalletFiltersValue,
  myWalletPath,
} from '@/lib/wallet';
import { PILL_SELECT } from '../../market-filters';
import { MarketFilterBar } from '../market-filter';
import { PeriodSelect } from '../period-select';

/**
 * 유형 (ADR-0135 H5): '전체' — the choice the ledger opens on — and one per name of the filter
 * (`LEDGER_FILTER_OPTIONS`), as the period's pill select, its label for screen readers only. A
 * select rather than a row of pills so the line keeps to one row at 375 (ADR-0144 결정 1). It
 * hands the kind up and nothing else.
 */
function LedgerKindSelect({
  value,
  onChange,
  pending,
}: {
  value: LedgerFilterKind | undefined;
  onChange: (kind: LedgerFilterKind | undefined) => void;
  pending: boolean;
}) {
  return (
    <Field.Root width="auto">
      <Field.Label srOnly>{copy.ledgerKindLabel}</Field.Label>
      <NativeSelect.Root size="md" opacity={pending ? 0.6 : undefined}>
        <NativeSelect.Field
          {...PILL_SELECT}
          value={value ?? ''}
          aria-busy={pending}
          onChange={(event) => {
            onChange(LEDGER_FILTER_KINDS.find((kind) => kind === event.target.value));
          }}
          data-testid="wallet-kind"
        >
          {LEDGER_FILTER_OPTIONS.map((option) => (
            <option key={option.kind ?? ''} value={option.kind ?? ''}>
              {option.label}
            </option>
          ))}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
    </Field.Root>
  );
}

/**
 * 이용 내역's filter line (#69, ADR-0144 결정 2-9·2-10; ADR-0135 H5·G3): 유형 → 기간 → 시장, the
 * shared `MarketFilterBar` with the other two first. Every control writes the address
 * (`myWalletPath`, which keeps a package `/charge` sent while sales are on) and reads its value
 * back out of the `filters` the server page normalised, as 거래·정산 이력's screen does: the
 * address is the one source of truth, so a filtered ledger is an address to come back to and Back
 * undoes a filter. Each push is marked busy until the page under the new address has come.
 */
export function WalletFilters({
  filters,
  marketTitle,
}: {
  filters: WalletFiltersValue;
  marketTitle?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = (next: WalletFiltersValue) => {
    startTransition(() => {
      router.push(myWalletPath(next) as Route);
    });
  };
  return (
    <MarketFilterBar
      market={filters.market}
      marketTitle={marketTitle}
      onChange={(market) => go({ ...filters, market })}
      prompt={copy.walletMarketPickerPrompt}
      testIdPrefix="wallet-market"
      rowTestId="wallet-filters"
    >
      <LedgerKindSelect
        value={filters.kind}
        pending={pending}
        onChange={(kind) => go({ ...filters, kind })}
      />
      <PeriodSelect
        value={filters.period}
        pending={pending}
        onChange={(period) => go({ ...filters, period })}
        testId="wallet-period"
      />
    </MarketFilterBar>
  );
}
