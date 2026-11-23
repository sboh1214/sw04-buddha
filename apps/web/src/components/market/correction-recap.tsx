'use client';

import { Button, HStack, Link as ChakraLink, Stack, Text } from '@chakra-ui/react';
import { copy } from '@/copy';
import { useLedger } from '@/hooks/use-wallet';
import { type PublicMarketJudgementCorrection } from '@/lib/api';
import {
  type RecapCompensation,
  recapCompensationOf,
  recapCompensationText,
  recapCorrectedResultText,
} from '@/lib/judgement-correction';
import { JUDGING_RECORD_ANCHOR, scrollToJudgingRecord } from '@/lib/market-detail';

/**
 * The recap's 판정 정정 (#144 part 2, ADR-0166; owner answers 144-11, 144-19): under a paid-out
 * market's own settlement records — which stay as they are, the original result's — the
 * correction confirmed after the payout: '정정된 결과 {r}', what this account got ('내 보상 {n}
 * Coin', or '보상 없음' once paid with nothing for it; before the payout '보상 승인 대기' or '보상
 * 준비 중', never '보상 없음'), and '판정 기록 보기' to the public record's 판정 정정.
 *
 * The result and the public status are the market's (`judgingRecord.correction`, followed by the
 * same-key `market:status` repeat); the account's own amount is its JUDGEMENT_COMPENSATION entries
 * of the market (`GET /me/ledger?marketId=&kind=`, no route of its own — ADR-0166 T11), read only
 * once the status is 지급 완료 and under the ledger's key, so a `user:balance` reads it again.
 */
export function CorrectionRecap({
  marketId,
  correction,
  accountId,
}: {
  marketId: string;
  correction: PublicMarketJudgementCorrection;
  accountId: string | undefined;
}) {
  const paid = correction.compensation.status === 'paid';
  const ledger = useLedger(
    { kind: 'JUDGEMENT_COMPENSATION', market: marketId },
    paid ? accountId : undefined,
  );
  const compensation = recapCompensationOf(correction.compensation.status, {
    entries: ledger.data?.pages.flatMap((page) => page.items),
    failed: ledger.isLoadingError,
  });
  return (
    <CorrectionRecapView
      correction={correction}
      compensation={compensation}
      onRetry={() => void ledger.refetch()}
    />
  );
}

/** The block as drawn from what the container read (props alone: the unit test's subject). */
export function CorrectionRecapView({
  correction,
  compensation,
  onRetry,
}: {
  correction: Pick<PublicMarketJudgementCorrection, 'result'>;
  compensation: RecapCompensation;
  onRetry?: () => void;
}) {
  return (
    <Stack
      gap="1"
      borderTopWidth="1px"
      pt="4"
      minW="0"
      data-testid="market-settled-correction"
      data-compensation={compensation.kind}
    >
      <Text fontWeight="medium" fontSize="sm">
        {copy.recapCorrection}
      </Text>
      <Text fontSize="sm" data-testid="market-settled-corrected-result">
        {recapCorrectedResultText(correction.result)}
      </Text>
      <HStack gap="2" flexWrap="wrap">
        <Text fontSize="sm" data-testid="market-settled-compensation">
          {recapCompensationText(compensation)}
        </Text>
        {compensation.kind === 'failed' && onRetry !== undefined && (
          <Button size="xs" variant="outline" onClick={onRetry}>
            {copy.retry}
          </Button>
        )}
      </HStack>
      {/* The record is in the page once per width with no id (`data-anchor`): the drawn copy is
          scrolled to, the address a working link without script (the 결과 줄's mark's way). */}
      <ChakraLink
        href={`#${JUDGING_RECORD_ANCHOR}`}
        onClick={(event) => {
          event.preventDefault();
          scrollToJudgingRecord();
        }}
        fontSize="sm"
        colorPalette="brand"
        color="colorPalette.fg"
        alignSelf="flex-start"
        data-testid="market-settled-judging"
      >
        {copy.recapJudgingRecord}
      </ChakraLink>
    </Stack>
  );
}
