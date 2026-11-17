'use client';

import { Box, Button, CloseButton, HStack, Text } from '@chakra-ui/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { MarketPicker } from '@/components/post/market-picker';
import { copy } from '@/copy';
import { PILL_BUTTON } from '../market-filters';

/**
 * The market filter of MY's filtered lists (ADR-0135 G3; #124's, ADR-0143 결정 6, shared with the
 * wallet since #69, ADR-0144 결정 2-9): the filter line — the screen's other controls first
 * (`children`), then '시장 고르기' or the chip of the market set with its 해제 — and under it, as
 * the line's sibling, the picker's panel while it is open. The screen owns the address: it hands
 * the market set (`market`, from the address it normalised) and takes a pick or a clear through
 * `onChange`, which writes the address. The words that differ between screens come as props
 * (`prompt`); the chip's and the clear's are the same everywhere.
 *
 * The picker is open only while no market is set, whichever way one was set: picked here, a row's
 * '이 시장만 보기', Back or Forward. The screen is not mounted again for a new address, so an open
 * picker left behind would come back open when the market is let go (React's
 * adjust-state-while-rendering pattern; no effect, no extra paint).
 *
 * The control swaps elements with the address: the chip replaces '시장 고르기' and the button comes
 * back when the chip is let go, so the element that had focus is removed and focus would fall to
 * the page. After a pick or a clear made HERE, the control that took its place takes focus once
 * the new address has rendered; a page load, a link or Back moves nothing.
 */
export function MarketFilterBar({
  market,
  marketTitle,
  onChange,
  prompt,
  testIdPrefix,
  rowTestId,
  children,
}: {
  /** The market the address sets (its lower-cased uuid), or undefined for none. */
  market: string | undefined;
  /** The title of `market`, read on the server; absent if it failed or is not public. */
  marketTitle: string | undefined;
  /** A market picked (its id) or let go (undefined) on this screen. */
  onChange: (market: string | undefined) => void;
  /** What the picker's panel says it is for, until a term is searched. */
  prompt: string;
  /** The controls' test ids: `<prefix>-pick`, `-chip`, `-clear` and `-picker`. */
  testIdPrefix: string;
  /** The filter line's own test id. */
  rowTestId: string;
  /** The screen's other filters, drawn first on the line. */
  children?: ReactNode;
}) {
  const [picking, setPicking] = useState(false);
  if (picking && market !== undefined) setPicking(false);
  const pickRef = useRef<HTMLButtonElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<'pick' | 'clear' | null>(null);
  useEffect(() => {
    const wanted = market === undefined ? 'pick' : 'clear';
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === wanted) (wanted === 'pick' ? pickRef : clearRef).current?.focus();
  }, [market]);

  return (
    <>
      <HStack gap="2" flexWrap="wrap" data-testid={rowTestId}>
        {children}
        {market === undefined ? (
          <Button
            ref={pickRef}
            {...PILL_BUTTON}
            variant="outline"
            aria-expanded={picking}
            onClick={() => setPicking((open) => !open)}
            data-testid={`${testIdPrefix}-pick`}
          >
            {copy.historyMarketPick}
          </Button>
        ) : (
          <HStack
            {...PILL_BUTTON}
            gap="1"
            pe="1"
            borderWidth="1px"
            borderColor="brand.border"
            maxW="100%"
            data-testid={`${testIdPrefix}-chip`}
          >
            <Text as="span" textStyle="emphasisSm" truncate>
              {`${copy.historyMarketChip}: ${marketTitle ?? copy.historyMarketUnknown}`}
            </Text>
            <CloseButton
              ref={clearRef}
              size="2xs"
              aria-label={copy.historyMarketClear}
              onClick={() => {
                focusAfter.current = 'pick';
                onChange(undefined);
              }}
              data-testid={`${testIdPrefix}-clear`}
            />
          </HStack>
        )}
      </HStack>

      {picking && market === undefined && (
        <Box borderWidth="1px" borderColor="border.subtle" borderRadius="card" p="4" maxW="640px">
          <MarketPicker
            prompt={prompt}
            onPick={(picked) => {
              // The picker (and the option that has focus) goes at once; the button holds focus
              // until the chip that replaces it has come.
              setPicking(false);
              pickRef.current?.focus();
              focusAfter.current = 'clear';
              onChange(picked.id);
            }}
            testId={`${testIdPrefix}-picker`}
          />
        </Box>
      )}
    </>
  );
}
