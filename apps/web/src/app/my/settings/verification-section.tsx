'use client';

import { Button, Field, HStack, Input, Stack, Text } from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { RealNameField } from '@/components/auth/real-name-field';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { useUpdateRealName } from '@/hooks/use-phone-verification';
import type { PhoneVerification } from '@/lib/api';
import { MY_SETTINGS_PATH } from '@/lib/my';
import { onboardingPath } from '@/lib/onboarding';
import {
  formatPhone,
  realNameFormSchema,
  realNameSaveFailure,
  type RealNameFormValues,
} from '@/lib/phone-verification';
import { ProfileUnavailable } from './profile-unavailable';
import { SettingsSection } from './section';

/**
 * 본인확인 (ADR-0070): the number the account verified, read-only, and the real name it gave with
 * it, editable (ADR-0069 decision 1 #57-3: the member cannot change the number; operators change
 * it in the database on request). Took the place of ADR-0043's 실명·연락처 card, whose number was
 * never proven. The gate keeps an account that has not verified off this screen, but the card
 * still copes with `null` — it points to the verification step rather than assuming the gate
 * ran first.
 */
export function VerificationSection() {
  const { data: me, isPending } = useMe();
  let body;
  if (isPending || !me) body = <ProfileUnavailable />;
  else if (me.verification === null) body = <NotVerified />;
  // Keyed by account: a tab whose `['me']` turned to another account starts from that one's name.
  else body = <VerifiedFields key={me.id} verification={me.verification} accountId={me.id} />;
  return (
    <SettingsSection
      title={copy.settingsVerification}
      hint={copy.settingsVerificationHint}
      testId="settings-verification"
    >
      {body}
    </SettingsSection>
  );
}

function NotVerified() {
  return (
    <Stack gap="3" align="flex-start" data-testid="settings-verification-missing">
      <Text fontSize="sm">{copy.settingsNotVerified}</Text>
      <Button asChild size="sm" variant="outline">
        <NextLink href={onboardingPath(MY_SETTINGS_PATH) as Route}>
          {copy.settingsVerifyNow}
        </NextLink>
      </Button>
    </Stack>
  );
}

/**
 * The real name is seeded synchronously from the profile and kept in sync with later refetches
 * without discarding an edit in progress — the same arrangement as the nickname card. The
 * number is no input of any form: a read-only field showing it the way people write it.
 *
 * A save names the account the card was drawn for (`accountId`, its `Me`'s id), never the
 * session's: in the render between the session naming another account and SessionCacheGuard's
 * reset the session already says B while the card still shows A's record, and a name sent as B's
 * would rename B (ADR-0090). The server refuses it as another account's.
 *
 * Keyed by that account, as this screen's other cards that name their `Me`'s: `['me']` can also
 * turn from A to B in place, before the session does and so with no reset of SessionCacheGuard's
 * to empty it first — a window-focus refetch of `GET /me` answered with B's cookie ahead of
 * better-auth's session refetch (which skips a tab back within 5 s), a realtime resnapshot, any
 * later `GET /me` in a window beside one that signed in as B (no `visibilitychange` there).
 * Unkeyed, the form would keep the name typed for A over B's (`values` with `keepDirtyValues`),
 * 저장 still on, and send it naming B — B's `Me` — with B's cookie: B renamed with A's draft.
 * Keyed, it starts again from B's own name.
 */
function VerifiedFields({
  verification,
  accountId,
}: {
  verification: PhoneVerification;
  accountId: string;
}) {
  const update = useUpdateRealName();
  // `['me']` is structurally shared, so `realName` keeps its identity across a refetch that
  // brought the same value back, and this memo (and the form's `values`) stays put.
  const { realName } = verification;
  const values = useMemo(() => ({ realName }), [realName]);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty },
  } = useForm<RealNameFormValues>({
    resolver: zodResolver(realNameFormSchema),
    defaultValues: values,
    values,
    resetOptions: { keepDirtyValues: true },
  });

  const onSubmit = handleSubmit(async (form) => {
    // The account the card was drawn for rides along (`expectedAccountId`, A-PG-24).
    try {
      const saved = await update.mutateAsync({
        realName: form.realName,
        expectedAccountId: accountId,
      });
      // Explicitly not keepDirtyValues: react-hook-form merges the form's resetOptions into a
      // manual reset too, which would keep the typed ' 홍길동 ' instead of the saved name.
      reset({ realName: saved.realName }, { keepDirtyValues: false });
      toaster.create({ type: 'success', title: copy.realNameSaved });
    } catch (error) {
      const failure = realNameSaveFailure(error);
      if (failure.field) {
        setError(failure.field, { message: failure.message });
        return;
      }
      toaster.create({ type: 'error', title: failure.message });
    }
  });

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate>
      <Stack gap="4">
        <RealNameField registration={register('realName')} error={errors.realName?.message} />
        <Field.Root readOnly>
          <Field.Label>{copy.phone}</Field.Label>
          <Input
            type="tel"
            readOnly
            value={formatPhone(verification.phone)}
            data-testid="verification-phone"
          />
          <Field.HelperText>{copy.verifiedPhoneHint}</Field.HelperText>
        </Field.Root>
        <HStack justify="flex-end">
          <Button
            type="submit"
            loading={update.isPending}
            disabled={!isDirty}
            data-testid="verification-real-name-save"
          >
            {copy.save}
          </Button>
        </HStack>
      </Stack>
    </form>
  );
}
