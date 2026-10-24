'use client';

import {
  Alert,
  Box,
  Button,
  Card,
  Field,
  HStack,
  Heading,
  Input,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { RefusalText } from '@/components/moderation/refusal-text';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useClosureCheck, useCloseAccount } from '@/hooks/use-account-closure';
import { forgetAccountInTab } from '@/hooks/use-sign-out';
import {
  afterClosureInOrder,
  closureBlockers,
  closureCoinText,
  closureFailure,
  closureLines,
  isClosureConfirmed,
} from '@/lib/account-closure';
import { signOut } from '@/lib/auth-client';
import { MY_SETTINGS_PATH } from '@/lib/my';
import { type Refusal } from '@/lib/restriction';
import { LoadFailed, SessionEnded, useSessionEnded } from '../../portfolio';

/**
 * 탈퇴 (#140, ADR-0086; ADR-0069 decision 1 #57-15…#57-18, decision 3 #37-15…#37-17, decision 4
 * #140 rows): the one confirmation screen (decision 4 #140 «남은 Coin의 소멸과 되돌릴 수 없음을 한
 * 화면에 보이고 '탈퇴'를 직접 입력해 한 번 확인한다»). It reads what a closure would do now
 * (`GET /me/closure`): the Coin left, which the closure forfeits ('탈퇴 소멸', #57-16), and what
 * refuses it now — the admin role (#57-17), contracts not settled (#57-16), a payment in progress
 * (decision 7), waiting orders (#178's to cancel), a writing or an account restriction with its end
 * and the way to 조치·신고 내역 (decision 4 #140 «제재 중 탈퇴») — what goes and what stays
 * (`closureLines`: the 본인확인 record kept for the retention period, and the start Coin not given
 * again to the same number only for an account that received it — owner decision 2026-10-23 (3차)
 * 7 and 9 — and, only for an account with a market proposal 접수 or 검토, that the operators process
 * it as it is and the member will not see it once closed — #77's owner decision 2026-10-24) and
 * says that the closure is immediate and cannot be undone (#57-17). While something
 * refuses it, the field and the button are off and the screen says why. The onboarding gate leaves
 * this screen to an account that has not finished its onboarding (owner decision 2026-10-23 (2차)
 * 3), which comes here by the small link at the bottom of every onboarding screen ((4차) 1); its
 * way back to MY 설정, and to 조치·신고 내역, sends such an account through the steps it has
 * left as every MY screen does ((4차) 2). The button waits for '탈퇴' typed exactly
 * (`isClosureConfirmed`, the API's own rule) and for the session to say which account the screen
 * shows.
 *
 * Closed, the screen says so at once (the session is gone, so MY's signed-out rung must not take
 * its place), then the cookie is cleared — which tells the other tabs (`afterClosureInOrder`) —
 * the tab's caches and the drafts an onboarding step kept in it are emptied, as 로그아웃 empties
 * them (`forgetAccountInTab`), and it goes home with the toast '탈퇴했습니다.'. A refusal stays on
 * the screen under the button (`closureFailure`), the restriction's with the way to 조치·신고 내역.
 *
 * Not a MY tab: it names itself (`h3` under MY's `h2`). Personal and client-only like every MY
 * screen — nothing of it is in the HTML.
 */
export function AccountClosure() {
  const [closed, setClosed] = useState(false);
  const ended = useSessionEnded();
  if (closed) return <Closed />;
  if (ended) return <SessionEnded />;
  return <ClosureScreen onClosed={() => setClosed(true)} />;
}

/** What the screen says between the closure's answer and home. */
function Closed() {
  return (
    <Card.Root data-testid="closure-done">
      <Card.Body>
        <Stack gap="3" align="start">
          <Text>{copy.closureDone}</Text>
          <Button asChild size="sm" variant="outline">
            <NextLink href="/">{copy.goHome}</NextLink>
          </Button>
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}

function ClosureScreen({ onClosed }: { onClosed: () => void }) {
  const check = useClosureCheck();
  const close = useCloseAccount();
  const format = useFormatDateTime();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [typed, setTyped] = useState('');
  const [failure, setFailure] = useState<Refusal | null>(null);

  const blockers = check.data === undefined ? [] : closureBlockers(check.data, format);
  const blocked = blockers.length > 0;
  const confirmed = isClosureConfirmed(typed);
  const canSubmit =
    check.data !== undefined && !blocked && confirmed && close.ready && !close.isPending;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setFailure(null);
    try {
      await close.mutateAsync(typed);
    } catch (error) {
      setFailure(closureFailure(error, format));
      return;
    }
    onClosed();
    await afterClosureInOrder({
      signOut,
      onClosed: () => {
        // Everything, as 로그아웃 does (`forgetAccountInTab`, use-sign-out.ts): the browser's
        // QueryClient outlives the account and none of its keys carries whose it was, and the
        // post, comment and MY 설정 drafts an onboarding step kept in this tab — the step's
        // '탈퇴하기' leads here — go with the account that wrote them (ADR-0086 7-20).
        forgetAccountInTab(queryClient);
        toaster.create({ type: 'success', title: copy.closureDone });
        router.push('/');
        router.refresh();
      },
    });
  }

  return (
    <Stack gap="6" data-testid="account-closure">
      <Heading as="h3" size="lg">
        {copy.closureTitle}
      </Heading>
      {check.data === undefined ? (
        check.isError ? (
          // MY's error rung: announced (role="alert"), its 다시 시도 outside the announcement.
          <Box data-testid="closure-check-failed">
            <LoadFailed message={copy.closureCheckFailed} onRetry={() => void check.refetch()} />
          </Box>
        ) : (
          <Skeleton height="48" />
        )
      ) : (
        <Card.Root>
          <Card.Body>
            <Stack gap="5">
              <Stack gap="1">
                <Text fontSize="sm" color="fg.muted">
                  {copy.closureCoinLabel}
                </Text>
                <Text fontSize="2xl" fontWeight="bold" data-testid="closure-coin">
                  {closureCoinText(check.data)}
                </Text>
                <Text data-testid="closure-forfeit">{copy.closureForfeit}</Text>
              </Stack>
              <Stack gap="1" fontSize="sm" color="fg.muted">
                {closureLines(check.data).map((line) => (
                  <Text key={line.testId} data-testid={line.testId}>
                    {line.text}
                  </Text>
                ))}
              </Stack>
              <Text fontWeight="semibold" data-testid="closure-irreversible">
                {copy.closureIrreversible}
              </Text>
              {blocked && (
                <Alert.Root status="warning" data-testid="closure-blocked">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>{copy.closureBlocked}</Alert.Title>
                    <Stack as="ul" gap="1" listStyleType="none">
                      {blockers.map((blocker) => (
                        <Alert.Description
                          as="li"
                          key={blocker.message}
                          data-testid="closure-blocker"
                        >
                          <RefusalText message={blocker.message} restricted={blocker.restricted} />
                        </Alert.Description>
                      ))}
                    </Stack>
                  </Alert.Content>
                </Alert.Root>
              )}
              <form onSubmit={(event) => void submit(event)} noValidate>
                <Stack gap="4">
                  <Field.Root disabled={blocked}>
                    <Field.Label>{copy.closureConfirmLabel}</Field.Label>
                    <Input
                      value={typed}
                      onChange={(event) => setTyped(event.target.value)}
                      autoComplete="off"
                      maxW="xs"
                      data-testid="closure-confirmation"
                    />
                  </Field.Root>
                  {failure !== null && (
                    <Alert.Root status="error" role="alert" data-testid="closure-error">
                      <Alert.Indicator />
                      <Alert.Content>
                        <Alert.Description>
                          <RefusalText message={failure.message} restricted={failure.restricted} />
                        </Alert.Description>
                      </Alert.Content>
                    </Alert.Root>
                  )}
                  <HStack gap="2" flexWrap="wrap">
                    <Button
                      type="submit"
                      colorPalette="no"
                      disabled={!canSubmit}
                      loading={close.isPending}
                      data-testid="closure-submit"
                    >
                      {copy.closureSubmit}
                    </Button>
                    <Button asChild variant="ghost">
                      <NextLink href={MY_SETTINGS_PATH} data-testid="closure-back">
                        {copy.closureBack}
                      </NextLink>
                    </Button>
                  </HStack>
                </Stack>
              </form>
            </Stack>
          </Card.Body>
        </Card.Root>
      )}
    </Stack>
  );
}
