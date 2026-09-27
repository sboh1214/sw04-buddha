'use client';

import { Field, Input, Link, Stack, Text } from '@chakra-ui/react';
import NextLink from 'next/link';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { copy } from '@/copy';

/**
 * The real-name and mobile-number inputs (ADR-0043), shared by the three forms that ask for
 * them: /onboarding, the email sign-up's /set-password step and the settings card. Each form
 * owns its `useForm` and its schema (lib/contact-form.ts); this is only the markup, so the
 * labels, hints, autofill hints, the 본인인증 notice and the test ids cannot drift apart.
 *
 * No `maxLength` on the name: the 30-character limit is counted after trimming and NFC
 * normalisation, and a name typed as decomposed Hangul (macOS) is several code units per
 * syllable, so a browser-side cap would cut off names the server accepts.
 */
export function ContactInputs({
  realName,
  phone,
  errors,
}: {
  realName: UseFormRegisterReturn;
  phone: UseFormRegisterReturn;
  errors: { realName?: string | undefined; phone?: string | undefined };
}) {
  return (
    <Stack gap="4">
      <Field.Root invalid={!!errors.realName} required>
        <Field.Label>{copy.realName}</Field.Label>
        <Input autoComplete="name" data-testid="contact-real-name" {...realName} />
        <Field.HelperText>{copy.realNameHint}</Field.HelperText>
        <Field.ErrorText>{errors.realName}</Field.ErrorText>
      </Field.Root>
      <Field.Root invalid={!!errors.phone} required>
        <Field.Label>{copy.phone}</Field.Label>
        <Input
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder={copy.phonePlaceholder}
          maxLength={20}
          data-testid="contact-phone"
          {...phone}
        />
        <Field.HelperText>{copy.phoneHint}</Field.HelperText>
        <Field.ErrorText>{errors.phone}</Field.ErrorText>
      </Field.Root>
      <Text fontSize="sm" color="fg.muted" data-testid="contact-verification-notice">
        {copy.contactVerificationNotice}{' '}
        {/* A new tab: following it from a half-filled form must not throw the input away. */}
        <Link asChild colorPalette="brand" color="colorPalette.fg">
          <NextLink href="/privacy" target="_blank" rel="noopener">
            {copy.contactPrivacyLink}
          </NextLink>
        </Link>
      </Text>
    </Stack>
  );
}
