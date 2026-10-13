'use client';

import { Alert, Button, Skeleton, Stack } from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { ContactInputs } from '@/components/auth/contact-inputs';
import { EmptyState } from '@/components/ui/empty-state';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useUpdateContact } from '@/hooks/use-contact';
import { useMe } from '@/hooks/use-me';
import {
  contactFormSchema,
  contactFieldError,
  contactSaveFailureMessage,
  type ContactFormValues,
} from '@/lib/contact-form';
import { onboardingPath } from '@/lib/onboarding';
import { profileView } from '@/lib/query-client';

/**
 * `next` is already validated by the page (`onboardingNext`). The ONE place that navigates on
 * is the effect below, keyed on `['me']` holding a contact: a member who arrives with one
 * already (another tab saved it, or Back returned here) is sent straight on, and a save lands
 * in the same place because `useUpdateContact` writes the contact into `['me']` before its
 * promise settles — so the gate on `next` already sees it, and nothing can navigate twice.
 */
export function OnboardingForm({ next }: { next: string }) {
  const router = useRouter();
  const { data: me, isPending, isFetching, isLoggedIn, refetch } = useMe();
  const hasContact = me?.contact != null;
  // The four states MY's screens read (`profileView`), for the same reason: the page's
  // session check is server-side and runs only on navigation, so a session that ends under this
  // form (it expired, another tab signed out) left it offering a retry that can only 401.
  const view = profileView({ isLoggedIn, isPending, isFetching, hasProfile: me !== undefined });

  useEffect(() => {
    if (hasContact) router.replace(next as Route);
  }, [hasContact, next, router]);

  if (view === 'pending' || hasContact) return <Skeleton height="64" />;

  // Back through the login screen to this same round trip, as the page's own redirect sends it.
  if (view === 'signedOut') {
    return (
      <EmptyState
        data-testid="onboarding-signed-out"
        message={copy.onboardingSignedOut}
        action={
          <Button asChild size="sm" variant="outline">
            <NextLink href={{ pathname: '/login', query: { next: onboardingPath(next) } }}>
              {copy.login}
            </NextLink>
          </Button>
        }
      />
    );
  }

  // Signed in, and `/me` settled without a profile. This is the one screen the gate leaves such
  // an account, so it must offer a way out of the error.
  if (!me) {
    return (
      <Stack gap="3" align="flex-start" data-testid="onboarding-unavailable">
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errProfileLoad}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          {copy.retry}
        </Button>
      </Stack>
    );
  }

  return <OnboardingFields />;
}

function OnboardingFields() {
  const update = useUpdateContact();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ContactFormValues>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: { realName: '', phone: '' },
  });

  const onSubmit = handleSubmit(async (contact) => {
    // The account the screen shows rides along (`expectedAccountId`, A-PG-24). Unreachable
    // while the button honours `ready`.
    if (update.accountId === undefined) return;
    try {
      await update.mutateAsync({ ...contact, expectedAccountId: update.accountId });
      toaster.create({ type: 'success', title: copy.contactSaved });
    } catch (error) {
      const fieldError = contactFieldError(error);
      if (fieldError) {
        setError(fieldError.field, { message: fieldError.message });
        return;
      }
      toaster.create({ type: 'error', title: contactSaveFailureMessage(error) });
    }
  });

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate data-testid="onboarding-form">
      <Stack gap="5">
        <ContactInputs
          realName={register('realName')}
          phone={register('phone')}
          errors={{ realName: errors.realName?.message, phone: errors.phone?.message }}
        />
        <Button
          type="submit"
          size="lg"
          loading={isSubmitting}
          disabled={!update.ready}
          data-testid="onboarding-submit"
        >
          {copy.onboardingSubmit}
        </Button>
      </Stack>
    </form>
  );
}
