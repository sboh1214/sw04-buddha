'use client';

import {
  Alert,
  Badge,
  Button,
  DataList,
  Field,
  Heading,
  HStack,
  Input,
  Skeleton,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { SIGNUP_ALLOWLIST_CLEAR_CONFIRMATION } from '@buddha/shared';
import { useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  useAddSignupAllowlist,
  useDecideSignupAllowlistClear,
  useRemoveSignupAllowlist,
  useRequestSignupAllowlistClear,
  useRetractSignupAllowlistClear,
  useSignupAllowlist,
} from '@/hooks/use-admin-signup-allowlist';
import { useOperatorId } from '@/hooks/use-operator';
import { nicknameShown } from '@/lib/account-closure';
import { type SignupAllowlist, type SignupAllowlistClearRequest } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  clearRequestActions,
  signupAllowlistFailure,
  signupAllowlistLines,
  signupAllowlistPhoneError,
  signupAllowlistReasonError,
} from '@/lib/signup-allowlist';

/**
 * 가입 허용 목록 (#330, ADR-0174): whether the list applies (not empty, 330-3), the summary #149
 * checks (330-9: accounts verified off the list, members and admins apart), one admin's add and
 * removal with a reason (330-1), the clear of public launch — a request another admin approves or
 * rejects, or its requester retracts (330-2) — and the entries as ids and times only (330-8).
 * Every write names the admin on screen (`useOperatorId`) and waits for it.
 */
export function AdminSignupAllowlist() {
  const allowlist = useSignupAllowlist();
  return (
    <Stack gap="8" data-testid="admin-signup-allowlist">
      <Stack gap="3">
        <Heading as="h3" size="lg">
          {copy.adminSignupAllowlist}
        </Heading>
        <Text fontSize="sm" color="fg.muted">
          {copy.adminSignupAllowlistIntro}
        </Text>
        <Stack as="ul" gap="1" fontSize="sm" ps="5" listStyleType="disc">
          <li>{copy.adminSignupAllowlistRuleApplies}</li>
          <li>{copy.adminSignupAllowlistRuleHash}</li>
          <li>{copy.adminSignupAllowlistRuleWrites}</li>
          <li>{copy.adminSignupAllowlistRuleClear}</li>
        </Stack>
      </Stack>
      {allowlist.isPending ? (
        <Skeleton height="24" />
      ) : allowlist.isError ? (
        <ErrorAlert />
      ) : (
        <>
          <Summary allowlist={allowlist.data} />
          <AddForm />
          <RemoveForm />
          <ClearSection allowlist={allowlist.data} />
          <Entries allowlist={allowlist.data} />
        </>
      )}
    </Stack>
  );
}

function Summary({ allowlist }: { allowlist: SignupAllowlist }) {
  const { summary } = allowlist;
  const applies = summary.entryCount > 0;
  return (
    <Stack gap="3" p="4" borderWidth="1px" borderRadius="l2" data-testid="signup-allowlist-summary">
      <Badge
        alignSelf="start"
        colorPalette={applies ? 'green' : 'orange'}
        data-testid="signup-allowlist-status"
        data-applies={applies}
      >
        {applies ? copy.adminSignupAllowlistOn : copy.adminSignupAllowlistOff}
      </Badge>
      <DataList.Root orientation={{ base: 'vertical', md: 'horizontal' }}>
        <DataList.Item flexDirection={{ base: 'column', md: 'row' }}>
          <DataList.ItemLabel>{copy.adminSignupAllowlistCount}</DataList.ItemLabel>
          <DataList.ItemValue data-testid="signup-allowlist-count">
            {summary.entryCount.toLocaleString('ko-KR')}
          </DataList.ItemValue>
        </DataList.Item>
        <DataList.Item flexDirection={{ base: 'column', md: 'row' }}>
          <DataList.ItemLabel>{copy.adminSignupAllowlistOutside}</DataList.ItemLabel>
          <DataList.ItemValue>
            <HStack gap="3" flexWrap="wrap">
              <Text data-testid="signup-allowlist-outside-members">
                {copy.adminSignupAllowlistOutsideMembers}{' '}
                {summary.outsideVerifiedMembers.toLocaleString('ko-KR')}
              </Text>
              <Text data-testid="signup-allowlist-outside-admins">
                {copy.adminSignupAllowlistOutsideAdmins}{' '}
                {summary.outsideVerifiedAdmins.toLocaleString('ko-KR')}
              </Text>
            </HStack>
          </DataList.ItemValue>
        </DataList.Item>
      </DataList.Root>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminSignupAllowlistOutsideHint}
      </Text>
    </Stack>
  );
}

function ReasonField({
  value,
  onChange,
  error,
  testId,
  label = copy.adminSignupAllowlistReason,
}: {
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
  testId: string;
  label?: string;
}) {
  return (
    <Field.Root invalid={error !== undefined} required>
      <Field.Label>{label}</Field.Label>
      <Textarea
        rows={2}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      />
      {error !== undefined ? (
        <Field.ErrorText>{error}</Field.ErrorText>
      ) : (
        <Field.HelperText>{copy.adminSignupAllowlistReasonHint}</Field.HelperText>
      )}
    </Field.Root>
  );
}

function FormAlert({ message, testId }: { message: string | null; testId: string }) {
  if (message === null) return null;
  return (
    <Alert.Root status="error" role="alert" data-testid={testId}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{message}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}

/** Pasted lines, one number each (I1): one bad line sends nothing, and the screen names it. */
function AddForm() {
  const add = useAddSignupAllowlist();
  const operatorId = useOperatorId();
  const [phones, setPhones] = useState('');
  const [reason, setReason] = useState('');
  const [phonesError, setPhonesError] = useState<string | undefined>();
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);

  const submit = () => {
    if (operatorId === undefined) return;
    setFailure(null);
    const lines = signupAllowlistLines(phones);
    const badReason = signupAllowlistReasonError(reason);
    setPhonesError('error' in lines ? lines.error : undefined);
    setReasonError(badReason);
    if ('error' in lines || badReason !== undefined) return;
    add.mutate(
      { phones: lines.phones, reason: reason.trim(), expectedAccountId: operatorId },
      {
        onSuccess: ({ addedCount, skippedCount }) => {
          toaster.create({
            type: 'success',
            title: `${copy.adminSignupAllowlistAdded}: ${String(addedCount)}`,
            description:
              skippedCount > 0
                ? `${copy.adminSignupAllowlistSkipped}: ${String(skippedCount)}`
                : undefined,
          });
          setPhones('');
          setReason('');
        },
        onError: (error) => {
          const outcome = signupAllowlistFailure(error, 'entries');
          if ('field' in outcome && outcome.field === 'reason') setReasonError(outcome.message);
          else if ('field' in outcome && outcome.field === 'phones') {
            setPhonesError(outcome.message);
          } else setFailure(outcome.message);
        },
      },
    );
  };

  return (
    <Stack gap="3" data-testid="signup-allowlist-add">
      <Heading as="h4" size="md">
        {copy.adminSignupAllowlistAddTitle}
      </Heading>
      <FormAlert message={failure} testId="signup-allowlist-add-error" />
      <Field.Root invalid={phonesError !== undefined} required>
        <Field.Label>{copy.adminSignupAllowlistPhones}</Field.Label>
        <Textarea
          rows={5}
          value={phones}
          onChange={(event) => setPhones(event.target.value)}
          autoComplete="off"
          data-testid="signup-allowlist-add-phones"
        />
        {phonesError !== undefined ? (
          <Field.ErrorText data-testid="signup-allowlist-add-phones-error">
            {phonesError}
          </Field.ErrorText>
        ) : (
          <Field.HelperText>{copy.adminSignupAllowlistPhonesHint}</Field.HelperText>
        )}
      </Field.Root>
      <ReasonField
        value={reason}
        onChange={setReason}
        error={reasonError}
        testId="signup-allowlist-add-reason"
      />
      <Button
        alignSelf="start"
        size="sm"
        loading={add.isPending}
        disabled={operatorId === undefined}
        onClick={submit}
        data-testid="signup-allowlist-add-submit"
      >
        {copy.adminSignupAllowlistAdd}
      </Button>
    </Stack>
  );
}

/** One number, typed: the screen shows no number to pick (330-8). Never the last (I2). */
function RemoveForm() {
  const remove = useRemoveSignupAllowlist();
  const operatorId = useOperatorId();
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [phoneError, setPhoneError] = useState<string | undefined>();
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);

  const submit = () => {
    if (operatorId === undefined) return;
    setFailure(null);
    const badPhone = signupAllowlistPhoneError(phone);
    const badReason = signupAllowlistReasonError(reason);
    setPhoneError(badPhone);
    setReasonError(badReason);
    if (badPhone !== undefined || badReason !== undefined) return;
    remove.mutate(
      { phone, reason: reason.trim(), expectedAccountId: operatorId },
      {
        onSuccess: () => {
          toaster.create({ type: 'success', title: copy.adminSignupAllowlistRemoved });
          setPhone('');
          setReason('');
        },
        onError: (error) => {
          const outcome = signupAllowlistFailure(error, 'entries');
          if ('field' in outcome && outcome.field === 'reason') setReasonError(outcome.message);
          else if ('field' in outcome && outcome.field === 'phone') setPhoneError(outcome.message);
          else setFailure(outcome.message);
        },
      },
    );
  };

  return (
    <Stack gap="3" data-testid="signup-allowlist-remove">
      <Heading as="h4" size="md">
        {copy.adminSignupAllowlistRemoveTitle}
      </Heading>
      <FormAlert message={failure} testId="signup-allowlist-remove-error" />
      <Field.Root invalid={phoneError !== undefined} required>
        <Field.Label>{copy.adminSignupAllowlistPhone}</Field.Label>
        <Input
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          inputMode="tel"
          autoComplete="off"
          data-testid="signup-allowlist-remove-phone"
        />
        {phoneError !== undefined && <Field.ErrorText>{phoneError}</Field.ErrorText>}
      </Field.Root>
      <ReasonField
        value={reason}
        onChange={setReason}
        error={reasonError}
        testId="signup-allowlist-remove-reason"
      />
      <Button
        alignSelf="start"
        size="sm"
        variant="outline"
        colorPalette="red"
        loading={remove.isPending}
        disabled={operatorId === undefined}
        onClick={submit}
        data-testid="signup-allowlist-remove-submit"
      >
        {copy.adminSignupAllowlistRemove}
      </Button>
    </Stack>
  );
}

/** The clear of public launch (330-2): asked here, decided by another admin here too. */
function ClearSection({ allowlist }: { allowlist: SignupAllowlist }) {
  return (
    <Stack gap="3" data-testid="signup-allowlist-clear">
      <Heading as="h4" size="md">
        {copy.adminSignupAllowlistClearTitle}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminSignupAllowlistClearIntro}
      </Text>
      {allowlist.pendingClear === null ? (
        <ClearRequestForm disabled={allowlist.summary.entryCount === 0} />
      ) : (
        <PendingClear request={allowlist.pendingClear} />
      )}
    </Stack>
  );
}

function ClearRequestForm({ disabled }: { disabled: boolean }) {
  const request = useRequestSignupAllowlistClear();
  const operatorId = useOperatorId();
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [confirmationError, setConfirmationError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);

  const submit = () => {
    if (operatorId === undefined) return;
    setFailure(null);
    const badReason = signupAllowlistReasonError(reason);
    const badConfirmation =
      confirmation.trim() === SIGNUP_ALLOWLIST_CLEAR_CONFIRMATION
        ? undefined
        : copy.errSignupAllowlistConfirmation;
    setReasonError(badReason);
    setConfirmationError(badConfirmation);
    if (badReason !== undefined || badConfirmation !== undefined) return;
    request.mutate(
      { reason: reason.trim(), confirmation: confirmation.trim(), expectedAccountId: operatorId },
      {
        onSuccess: () => {
          toaster.create({ type: 'success', title: copy.adminSignupAllowlistClearRequested });
          setReason('');
          setConfirmation('');
        },
        onError: (error) => {
          const outcome = signupAllowlistFailure(error, 'entries');
          if ('field' in outcome && outcome.field === 'reason') setReasonError(outcome.message);
          else if ('field' in outcome && outcome.field === 'confirmation') {
            setConfirmationError(outcome.message);
          } else setFailure(outcome.message);
        },
      },
    );
  };

  return (
    <Stack gap="3">
      <FormAlert message={failure} testId="signup-allowlist-clear-error" />
      <ReasonField
        value={reason}
        onChange={setReason}
        error={reasonError}
        testId="signup-allowlist-clear-reason"
      />
      <Field.Root invalid={confirmationError !== undefined} required>
        <Field.Label>{copy.adminSignupAllowlistConfirmation}</Field.Label>
        <Input
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
          data-testid="signup-allowlist-clear-confirmation"
        />
        {confirmationError !== undefined ? (
          <Field.ErrorText>{confirmationError}</Field.ErrorText>
        ) : (
          <Field.HelperText>{copy.adminSignupAllowlistConfirmationHint}</Field.HelperText>
        )}
      </Field.Root>
      <Button
        alignSelf="start"
        size="sm"
        variant="outline"
        colorPalette="red"
        loading={request.isPending}
        disabled={disabled || operatorId === undefined}
        onClick={submit}
        data-testid="signup-allowlist-clear-submit"
      >
        {copy.adminSignupAllowlistClearRequest}
      </Button>
    </Stack>
  );
}

/** The waiting clear: its requester retracts it; another admin approves or rejects it. */
function PendingClear({ request }: { request: SignupAllowlistClearRequest }) {
  const decide = useDecideSignupAllowlistClear();
  const retract = useRetractSignupAllowlistClear();
  const operatorId = useOperatorId();
  const actions = clearRequestActions(request, operatorId);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const loading = decide.isPending || retract.isPending;

  // A refusal reads the list again first (useAllowlistWrite), and a request another admin decided
  // or its requester retracted comes back gone — this box unmounts with it, so the refusal is a
  // toast, which outlives it.
  const onError = (error: unknown) => {
    const outcome = signupAllowlistFailure(error, 'decision');
    if ('field' in outcome && outcome.field === 'reason') setReasonError(outcome.message);
    else toaster.create({ type: 'error', title: outcome.message });
  };
  const onDecide = (decision: 'approve' | 'reject') => {
    if (operatorId === undefined) return;
    const badReason = signupAllowlistReasonError(reason);
    setReasonError(badReason);
    if (badReason !== undefined) return;
    decide.mutate(
      { requestId: request.id, decision, reason: reason.trim(), expectedAccountId: operatorId },
      {
        onSuccess: () => {
          toaster.create({
            type: 'success',
            title:
              decision === 'approve'
                ? copy.adminSignupAllowlistApproved
                : copy.adminSignupAllowlistRejected,
          });
        },
        onError,
      },
    );
  };
  const onRetract = () => {
    if (operatorId === undefined) return;
    retract.mutate(
      { requestId: request.id, expectedAccountId: operatorId },
      {
        onSuccess: () => {
          toaster.create({ type: 'success', title: copy.adminSignupAllowlistRetracted });
        },
        onError,
      },
    );
  };

  return (
    <Stack
      gap="3"
      p="4"
      borderWidth="1px"
      borderRadius="l2"
      data-testid="signup-allowlist-pending"
      data-request-id={request.id}
    >
      <Badge alignSelf="start" colorPalette="orange">
        {copy.adminSignupAllowlistClearPending}
      </Badge>
      <Stack gap="1" fontSize="sm">
        <Text>
          <Text as="span" color="fg.muted">
            {copy.adminSignupAllowlistClearRequester}
          </Text>{' '}
          {nicknameShown(request.requestedBy.nickname)} · {formatKst(request.requestedAt)}
        </Text>
        <Text wordBreak="break-word" data-testid="signup-allowlist-pending-reason">
          <Text as="span" color="fg.muted">
            {copy.adminSignupAllowlistClearRequestReason}
          </Text>{' '}
          {request.reason}
        </Text>
      </Stack>
      {actions.own ? (
        <>
          <Text fontSize="sm" color="fg.muted">
            {copy.adminSignupAllowlistClearOwn}
          </Text>
          <Button
            alignSelf="start"
            size="sm"
            variant="outline"
            loading={retract.isPending}
            disabled={!actions.canRetract || loading}
            onClick={onRetract}
            data-testid="signup-allowlist-retract"
          >
            {copy.adminSignupAllowlistRetract}
          </Button>
        </>
      ) : (
        <>
          <ReasonField
            value={reason}
            onChange={setReason}
            error={reasonError}
            testId="signup-allowlist-decision-reason"
            label={copy.adminSignupAllowlistDecisionReason}
          />
          <HStack gap="2" flexWrap="wrap">
            <Button
              size="sm"
              colorPalette="red"
              loading={decide.isPending && decide.variables?.decision === 'approve'}
              disabled={!actions.canDecide || loading}
              onClick={() => onDecide('approve')}
              data-testid="signup-allowlist-approve"
            >
              {copy.adminSignupAllowlistApprove}
            </Button>
            <Button
              size="sm"
              variant="outline"
              loading={decide.isPending && decide.variables?.decision === 'reject'}
              disabled={!actions.canDecide || loading}
              onClick={() => onDecide('reject')}
              data-testid="signup-allowlist-reject"
            >
              {copy.adminSignupAllowlistReject}
            </Button>
          </HStack>
        </>
      )}
    </Stack>
  );
}

/** The entries, newest first: an id and when it was added, never a number (330-8). */
function Entries({ allowlist }: { allowlist: SignupAllowlist }) {
  return (
    <Stack gap="3" data-testid="signup-allowlist-entries">
      <Heading as="h4" size="md">
        {copy.adminSignupAllowlistEntries}
      </Heading>
      {allowlist.entries.length === 0 ? (
        <Text color="fg.muted" data-testid="signup-allowlist-entries-empty">
          {copy.adminSignupAllowlistEntriesEmpty}
        </Text>
      ) : (
        <Stack as="ul" gap="1" fontSize="sm">
          {allowlist.entries.map((entry) => (
            <HStack
              as="li"
              key={entry.id}
              justify="space-between"
              gap="3"
              flexWrap="wrap"
              borderBottomWidth="1px"
              py="1"
              data-testid="signup-allowlist-entry"
            >
              <Text fontFamily="mono" wordBreak="break-all">
                {entry.id}
              </Text>
              <Text color="fg.muted">
                {copy.adminSignupAllowlistAddedAt} {formatKst(entry.createdAt)}
              </Text>
            </HStack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function ErrorAlert() {
  return (
    <Alert.Root status="error" role="alert">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{copy.errUnknown}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}
