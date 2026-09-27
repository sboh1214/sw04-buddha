'use client';

import { Button, HStack, Stack } from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { ContactInputs } from '@/components/auth/contact-inputs';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useUpdateContact } from '@/hooks/use-contact';
import { useMe } from '@/hooks/use-me';
import type { Contact } from '@/lib/api';
import {
  contactFormSchema,
  contactFormValues,
  contactFieldError,
  type ContactFormValues,
} from '@/lib/contact-form';
import { ProfileUnavailable } from './profile-unavailable';
import { SettingsSection } from './section';

/**
 * 실명·연락처 (ADR-0043): what the account gave on /set-password or /onboarding, editable here.
 * The gate keeps an account without one off this screen, but the card still copes with `null`
 * (blank inputs) rather than assuming the gate ran first.
 */
export function ContactSection() {
  const { data: me, isPending } = useMe();
  return (
    <SettingsSection
      title={copy.settingsContact}
      hint={copy.settingsContactHint}
      testId="settings-contact"
    >
      {isPending || !me ? <ProfileUnavailable /> : <ContactFields contact={me.contact} />}
    </SettingsSection>
  );
}

/**
 * Seeded synchronously from the profile and kept in sync with later refetches without
 * discarding an edit in progress — the same arrangement as the nickname card.
 */
function ContactFields({ contact }: { contact: Contact | null }) {
  const update = useUpdateContact();
  // `['me']` is structurally shared, so `contact` keeps its identity across a refetch that
  // brought the same values back, and this memo (and the form's `values`) stays put.
  const values = useMemo(() => contactFormValues(contact), [contact]);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty },
  } = useForm<ContactFormValues>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: values,
    values,
    resetOptions: { keepDirtyValues: true },
  });

  const onSubmit = handleSubmit(async (form) => {
    try {
      const saved = await update.mutateAsync(form);
      reset(contactFormValues(saved));
      toaster.create({ type: 'success', title: copy.contactSaved });
    } catch (error) {
      const fieldError = contactFieldError(error);
      if (fieldError) {
        setError(fieldError.field, { message: fieldError.message });
        return;
      }
      toaster.create({ type: 'error', title: copy.errUnknown });
    }
  });

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate>
      <Stack gap="4">
        <ContactInputs
          realName={register('realName')}
          phone={register('phone')}
          errors={{ realName: errors.realName?.message, phone: errors.phone?.message }}
        />
        <HStack justify="flex-end">
          <Button
            type="submit"
            loading={update.isPending}
            disabled={!isDirty}
            data-testid="contact-save"
          >
            {copy.save}
          </Button>
        </HStack>
      </Stack>
    </form>
  );
}
