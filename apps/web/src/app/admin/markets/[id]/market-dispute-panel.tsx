'use client';

import { Alert, Button, HStack, Stack, Text } from '@chakra-ui/react';
import { type RefObject, useEffect, useRef } from 'react';
import { copy } from '@/copy';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { disputeDecisionUnavailable, disputeHoldingText } from '@/lib/admin-disputes';
import { type AdminMarket } from '@/lib/api';
import { DisputeRecord } from '../../disputes/dispute-record';
import { type DisputeAction, DisputeDecisionDialog } from './market-dispute-dialogs';

/**
 * '판정 이의' in the 판정 panel (#175, ADR-0104; ADR-0093 decision 1 #173 items 1·2·7·12·13), right
 * after the current judgement it disputes: what it asks of the admin on screen
 * (`MarketDisputesBody`) and the 기각 or 수용 it opened, held for that admin
 * (`useHeldForOperator`, ADR-0092 answer 1) — once `['me']` turns from A to B in place, the dialog
 * closes with the reason A typed. Drawn on any market with a current judgement (its version's
 * disputes, in every status, the record staying once confirmed); before one, nothing. Focus comes
 * back to its heading once a decision went through and took the button away (WCAG 2.4.3).
 */
export function MarketDisputes({ market }: { market: AdminMarket }) {
  const operatorId = useOperatorId();
  const [action, setAction] = useHeldForOperator<DisputeAction>();
  const heading = useRef<HTMLParagraphElement>(null);
  const closed = useRef<{ market: AdminMarket } | null>(null);
  useEffect(() => {
    const from = closed.current;
    // Wait for the market the write answered: the button goes with it.
    if (from === null || action !== null || from.market === market) return;
    closed.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    heading.current?.focus();
  }, [action, market]);
  if (market.judgement.current === null) return null;
  return (
    <>
      <MarketDisputesBody
        market={market}
        operatorId={operatorId}
        onOpen={setAction}
        headingRef={heading}
      />
      {action !== null && (
        <DisputeDecisionDialog
          action={action}
          market={market}
          onClose={(sent) => {
            if (sent) closed.current = { market };
            setAction(null);
          }}
        />
      )}
    </>
  );
}

/**
 * The block as drawn for `operatorId` (undefined until `GET /me` answers): the current version's
 * disputes, the oldest first (`AdminMarket.disputes.items`), each as the operators read it
 * (`DisputeRecord`: the submitter, the links, the reason, how it ended), and how many hold the
 * confirmation (`holding` — pending, or accepted and waiting for its correction, #176). A pending
 * one offers 기각 and 수용 to any admin who did not register the judgement (#173 item 2: the approver
 * may), off until the admin on screen is known; for the registrant both are off, with the note why
 * (`disputeDecisionUnavailable`), and so for an admin who submitted it. No market price, volume,
 * count or majority is drawn (N03 §5, #152 AC 8). `headingRef` is what focus comes back to.
 */
export function MarketDisputesBody({
  market,
  operatorId,
  onOpen,
  headingRef,
}: {
  market: AdminMarket;
  operatorId: string | undefined;
  onOpen: (action: DisputeAction) => void;
  headingRef?: RefObject<HTMLParagraphElement | null>;
}) {
  const { holding, items } = market.disputes;
  const pending = items.filter((dispute) => dispute.status === 'pending');
  const unavailable = pending.map((dispute) =>
    disputeDecisionUnavailable(dispute, market, operatorId),
  );
  const registrant = unavailable.includes('registrant');
  const own = unavailable.includes('own');
  return (
    <Stack
      gap="3"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      data-testid="market-judgement-disputes"
      data-holding={holding}
    >
      <Text
        ref={headingRef}
        tabIndex={headingRef === undefined ? undefined : -1}
        fontWeight="medium"
        fontSize="sm"
        data-testid="market-judgement-disputes-title"
      >
        {copy.adminMarketDisputes}
      </Text>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminMarketDisputesIntro}
      </Text>
      {holding > 0 && (
        <Text fontSize="sm" fontWeight="medium" data-testid="market-judgement-disputes-holding">
          {disputeHoldingText(holding)}
        </Text>
      )}
      {registrant && (
        <Alert.Root
          status="warning"
          role="status"
          data-testid="market-judgement-disputes-registrant-note"
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.adminMarketDisputesRegistrant}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {own && (
        <Alert.Root status="warning" role="status" data-testid="market-judgement-disputes-own-note">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.adminMarketDisputesOwn}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {items.length === 0 ? (
        <Text fontSize="sm" color="fg.muted" data-testid="market-judgement-disputes-empty">
          {copy.adminMarketDisputesEmpty}
        </Text>
      ) : (
        <Stack gap="3" data-testid="market-judgement-disputes-list">
          {items.map((dispute) => {
            const prefix = `market-judgement-dispute-${dispute.id}`;
            const unavailable = disputeDecisionUnavailable(dispute, market, operatorId);
            return (
              <DisputeRecord
                key={dispute.id}
                dispute={dispute}
                prefix={prefix}
                actions={
                  dispute.status === 'pending' && (
                    <HStack gap="2" flexWrap="wrap" data-testid={`${prefix}-actions`}>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={operatorId === undefined || unavailable !== null}
                        onClick={() => onOpen({ kind: 'dismiss', disputeId: dispute.id })}
                        data-testid={`${prefix}-dismiss`}
                      >
                        {copy.adminMarketDisputeDismiss}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={operatorId === undefined || unavailable !== null}
                        onClick={() => onOpen({ kind: 'accept', disputeId: dispute.id })}
                        data-testid={`${prefix}-accept`}
                      >
                        {copy.adminMarketDisputeAccept}
                      </Button>
                    </HStack>
                  )
                }
              />
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
