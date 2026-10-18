'use client';

import { Field, Input } from '@chakra-ui/react';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { copy } from '@/copy';

/**
 * The real-name input (ADR-0043, ADR-0070), shared by the two forms that ask for it: the
 * verification step on /onboarding, where it is given together with the number (#57-3), and MY
 * 설정's 본인확인 card, where it stays editable. Each form owns its `useForm` and its schema
 * (lib/phone-verification.ts); this is only the markup, so the label, hint, autofill hint and
 * test id cannot drift apart.
 *
 * No `maxLength`: the 30-character limit is counted after trimming and NFC normalisation, and a
 * name typed as decomposed Hangul (macOS) is several code units per syllable, so a browser-side
 * cap would cut off names the server accepts.
 */
export function RealNameField({
  registration,
  error,
  readOnly = false,
}: {
  registration: UseFormRegisterReturn;
  error: string | undefined;
  readOnly?: boolean;
}) {
  return (
    <Field.Root invalid={!!error} required readOnly={readOnly}>
      <Field.Label>{copy.realName}</Field.Label>
      <Input
        autoComplete="name"
        readOnly={readOnly}
        data-testid="verification-real-name"
        {...registration}
      />
      <Field.HelperText>{copy.realNameHint}</Field.HelperText>
      <Field.ErrorText>{error}</Field.ErrorText>
    </Field.Root>
  );
}
