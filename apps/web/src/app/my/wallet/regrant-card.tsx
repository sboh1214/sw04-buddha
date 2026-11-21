'use client';

import { Alert, Button, Card, DataList, Skeleton, Stack, Text } from '@chakra-ui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { RefusalText } from '@/components/moderation/refusal-text';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { useAccountBlock } from '@/hooks/use-account-block';
import { useMe } from '@/hooks/use-me';
import {
  regrantStatusReadAt,
  useApplyRegrant,
  useRegrantFollowsBalance,
  useRegrantRereadAt,
  useRegrantStatus,
} from '@/hooks/use-regrant';
import { type ApplyRegrantResult, type Me, type RegrantStatus } from '@/lib/api';
import { listView } from '@/lib/query-client';
import {
  canApplyRegrant,
  regrantFacts,
  regrantFailureKept,
  regrantFailureShown,
  type RegrantPressFailure,
  regrantPressFailure,
  regrantRefusals,
  regrantResultText,
  regrantWaitText,
} from '@/lib/regrant';
import { LoadFailed } from '../portfolio';

/**
 * 재지급 (#74, ADR-0155; N01 §2; owner answers 2026-11-21), MY 지갑's card under the balance — always
 * there (answer 10), never linked from the order screen's shortfall (answer 11). It reads whether a
 * re-grant would be given now (`GET /me/regrant`) and says, in its order:
 * - '준비 중' while any of the six release settings is undecided (answer 12), and nothing more;
 * - open: 1회 지급액, 신청 기준 (the 가용 코인 threshold, answer 1), 남은 횟수 in the period and 남은
 *   누적 한도 (answers 5·6), that a waiting order or a contract of an unsettled market keeps it
 *   from being given (answers 2·7) and, when there is one, the 대기기간;
 * - when a request now would be refused, every reason with its numbers — the threshold, when the
 *   wait ends and when the period frees one (absolute, in the member's zone), the cap left against
 *   the amount — the account restriction's with its end and the way to 조치·신고 내역 (answers 8·9);
 * - '재지급 신청', on only when nothing refuses it; off, it points at the line that says why
 *   (`aria-describedby`: the reasons, or '준비 중'). Pressed, the re-grant is given in that request
 *   (answer 3) and the card says '재지급 X Coin을 받았습니다.' (role="status") — or, when the API
 *   answered with the re-grant the request id had already given (`replayed`), when that one was
 *   received and that nothing more was given; the balance, the ledger and the status are read
 *   again. Refused, the card is drawn again from the status the refusing request read
 *   (REGRANT_NOT_ALLOWED's details) and says why under the button, announced (`regrantFailure`)
 *   — that line until a newer reading of the status says otherwise (`RegrantPressRefusal`).
 *
 * The status is read again when the wait or the period's slot it names runs out on screen
 * (`useRegrantRereadAt`), and when the balance moves (`useRegrantFollowsBalance`). A read again
 * that fails keeps the card drawn with a notice above it and 다시 시도, as MY's lists keep their
 * rows (`listView`'s `stale`); only a first read that failed shows the error rung.
 *
 * The account it applies for is the one of the `Me` the wallet was drawn from — the balance card's
 * — which the request names (`expectedAccountId`), never the session's (ADR-0091, ADR-0092); the
 * panel is keyed by it, so a `['me']` turned from A to B in place draws B's own status, and A's
 * success or refusal line goes with A's panel. Until `GET /me` answers, a skeleton; when it did not
 * (signed out, the profile not read), the intro alone — the balance card above says why and offers
 * the way back.
 */
export function RegrantCard() {
  const me = useMe();
  const balance =
    me.data === undefined
      ? undefined
      : `${me.data.balance.availableCoin}/${me.data.balance.lockedCoin}`;
  return (
    <Card.Root data-testid="regrant-card">
      <Card.Header>
        <Text fontWeight="semibold">{copy.regrantTitle}</Text>
      </Card.Header>
      <Card.Body>
        {me.data !== undefined ? (
          <RegrantPanel key={me.data.id} me={me.data} balance={balance} />
        ) : me.isPending || me.isFetching ? (
          <Skeleton height="16" />
        ) : (
          <Text fontSize="sm" color="fg.muted">
            {copy.regrantIntro}
          </Text>
        )}
      </Card.Body>
    </Card.Root>
  );
}

/**
 * The card's content for one account (`me`, the wallet's `Me`): the status, its facts and reasons,
 * the button and what the last press got. `balance` is that `Me`'s 가용/잠금 reading, which the
 * status follows (`useRegrantFollowsBalance`). The account restriction's end comes from the
 * restriction MY's holdings read (`useAccountBlock`: `accountRestriction`, the rule the status's
 * `restricted` asks; its `restricted`, so an admin's restriction says its end too) — read only
 * while the status names one, so a wallet with no restriction asks nothing more.
 */
export function RegrantPanel({ me, balance }: { me: Me; balance: string | undefined }) {
  const accountId = me.id;
  const status = useRegrantStatus(accountId);
  const apply = useApplyRegrant();
  const queryClient = useQueryClient();
  const format = useFormatDateTime();
  useRegrantFollowsBalance(accountId, balance);
  useRegrantRereadAt(accountId, status.data);
  const block = useAccountBlock(status.data?.refusals.includes('restricted') ? me : undefined);
  // What the button points at while it is off for the status (`aria-describedby`).
  const blockedId = useId();
  const notReadyId = useId();
  const [granted, setGranted] = useState<ApplyRegrantResult | null>(null);
  const [failure, setFailure] = useState<RegrantPressFailure | null>(null);
  // Locked before anything renders: a second press in the same frame sends nothing (the request id
  // would be the same one, and the server grants it once — this spares the second request).
  const sending = useRef(false);

  const view = listView(status);
  if (status.data === undefined) {
    return view === 'failed' ? (
      // MY's error rung: announced (role="alert"), its 다시 시도 outside the announcement.
      <Stack data-testid="regrant-status-failed">
        <LoadFailed message={copy.regrantStatusFailed} onRetry={() => void status.refetch()} />
      </Stack>
    ) : (
      <Skeleton height="16" />
    );
  }

  const current = status.data;
  // A REGRANT_NOT_ALLOWED line a newer reading withdrew is dropped for good, adjusting the state
  // while rendering (React re-renders at once): a later reading saying the same sentence again
  // announces no refusal that no press caused.
  const keptFailure = regrantFailureKept(failure, current, status.dataUpdatedAt, format);
  if (keptFailure !== failure) setFailure(keptFailure);
  const facts = regrantFacts(current);
  // The end only while the restriction read holds one (`restricted`, an admin's too): unknown
  // otherwise.
  const restrictionEndsAt = block.restricted ? block.restrictionEndsAt : undefined;
  const refusals = regrantRefusals(current, format, restrictionEndsAt);
  const wait = regrantWaitText(current);
  const canApply = canApplyRegrant(current) && !apply.isPending;
  // Off for the status: '준비 중', or the reasons (an open status lists one exactly while it is not
  // eligible). Nothing while it is on, or off only for a press in flight.
  const describedBy = !current.open ? notReadyId : refusals.length > 0 ? blockedId : undefined;

  async function submit() {
    if (sending.current || !canApplyRegrant(current)) return;
    sending.current = true;
    setGranted(null);
    setFailure(null);
    try {
      setGranted(await apply.mutateAsync({ expectedAccountId: accountId }));
    } catch (error) {
      // After the hook's onError: REGRANT_NOT_ALLOWED's details are the status's reading by now.
      setFailure(regrantPressFailure(error, format, regrantStatusReadAt(queryClient, accountId)));
    } finally {
      sending.current = false;
    }
  }

  return (
    <Stack
      gap="4"
      data-testid="regrant-panel"
      data-open={String(current.open)}
      data-eligible={String(current.eligible)}
    >
      {view === 'stale' && (
        // A read again that failed: the last reading stays drawn under the notice, as MY's lists
        // keep their rows (`listSection`'s `stale`) — a grant's line included.
        <Alert.Root status="warning" role="status" data-testid="regrant-stale">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void status.refetch()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      <Text fontSize="sm" color="fg.muted" data-testid="regrant-intro">
        {copy.regrantIntro}
      </Text>
      {!current.open ? (
        <Text id={notReadyId} fontWeight="medium" data-testid="regrant-not-ready">
          {copy.regrantNotReady}
        </Text>
      ) : (
        <Stack gap="3">
          <DataList.Root orientation="horizontal" size="sm">
            {facts.map((fact) => (
              <DataList.Item key={fact.testId}>
                <DataList.ItemLabel>{fact.label}</DataList.ItemLabel>
                <DataList.ItemValue
                  fontVariantNumeric="tabular-nums"
                  overflowWrap="anywhere"
                  data-testid={fact.testId}
                >
                  {fact.value}
                </DataList.ItemValue>
              </DataList.Item>
            ))}
          </DataList.Root>
          <Stack gap="1" fontSize="sm" color="fg.muted">
            <Text data-testid="regrant-conditions">{copy.regrantConditions}</Text>
            {wait !== null && <Text data-testid="regrant-wait">{wait}</Text>}
          </Stack>
        </Stack>
      )}
      {refusals.length > 0 && (
        <Alert.Root id={blockedId} status="warning" data-testid="regrant-blocked">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{copy.regrantBlocked}</Alert.Title>
            <Stack as="ul" gap="1" listStyleType="none">
              {refusals.map((line) => (
                <Alert.Description
                  as="li"
                  key={line.reason}
                  data-testid="regrant-refusal"
                  data-reason={line.reason}
                >
                  <RefusalText message={line.message} restricted={line.restricted} />
                </Alert.Description>
              ))}
            </Stack>
          </Alert.Content>
        </Alert.Root>
      )}
      {granted !== null && (
        <Alert.Root
          status="success"
          role="status"
          data-testid={granted.replayed ? 'regrant-replayed' : 'regrant-granted'}
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{regrantResultText(granted, format)}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      <RegrantPressRefusal
        failure={failure}
        status={current}
        statusUpdatedAt={status.dataUpdatedAt}
      />
      <Button
        alignSelf="flex-start"
        disabled={!canApply}
        loading={apply.isPending}
        onClick={() => void submit()}
        aria-describedby={describedBy}
        data-testid="regrant-apply"
      >
        {copy.regrantApply}
      </Button>
    </Stack>
  );
}

/**
 * What the last refused press says under the button (role="alert", `regrantFailure`), while it
 * holds (`regrantFailureShown`): REGRANT_NOT_ALLOWED's line comes from the status its details
 * became, and goes once a newer reading (`status` and its `dataUpdatedAt`, `statusUpdatedAt`) says
 * anything else — the reasons above and the button follow that one — for good: the panel then
 * drops the press (`regrantFailureKept`). Any other stays until the next press. Its sentence is
 * said in full, as the closure's refusal says its reason (`account-closure.tsx`): the list above
 * is redrawn without an announcement.
 */
export function RegrantPressRefusal({
  failure,
  status,
  statusUpdatedAt,
}: {
  failure: RegrantPressFailure | null;
  status: RegrantStatus;
  statusUpdatedAt: number;
}) {
  const format = useFormatDateTime();
  const refusal = regrantFailureShown(failure, status, statusUpdatedAt, format);
  if (refusal === null) return null;
  return (
    <Alert.Root status="error" role="alert" data-testid="regrant-error">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>
          <RefusalText message={refusal.message} restricted={refusal.restricted} />
        </Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}
