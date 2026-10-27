'use client';

import {
  Alert,
  Box,
  Button,
  Checkbox,
  HStack,
  Link,
  Separator,
  Stack,
  Text,
} from '@chakra-ui/react';
import { type ConsentItem } from '@buddha/shared';
import NextLink from 'next/link';
import { useId, useRef, useState } from 'react';
import { copy } from '@/copy';
import { useRecordConsents } from '@/hooks/use-onboarding';
import { MARKETING_CONSENT_TEXT, PRIVACY_CONSENT_TEXT } from '@/legal/consent-texts';
import { ConsentTextRegion } from '@/legal/consent-text-view';
import { type LegalDocument, resolveLegalDocument } from '@/legal/document';
import {
  CONSENT_LABELS,
  NO_CONSENTS,
  allConsentState,
  consentBody,
  consentFailure,
  consentTag,
  missingRequiredConsents,
  withAllConsents,
  type ConsentChoices,
} from '@/lib/consent';

/** The consent texts the step shows inline, resolved once (business facts filled in). */
const INLINE_TEXTS: Partial<Record<ConsentItem, LegalDocument>> = {
  privacy: resolveLegalDocument(PRIVACY_CONSENT_TEXT),
  marketing: resolveLegalDocument(MARKETING_CONSENT_TEXT),
};

/**
 * The documents an item links to, opened in a new tab: following one from a half-checked step must
 * not throw the boxes away. Both are exempt from the gate (lib/onboarding.ts).
 */
const LINKS: Partial<Record<ConsentItem, { href: '/terms' | '/privacy'; label: string }>> = {
  terms: { href: '/terms', label: copy.consentViewTerms },
  privacy: { href: '/privacy', label: copy.consentViewPrivacyPolicy },
};

/**
 * 약관 동의, the onboarding's first step (#58, ADR-0069 decision 1 #57-4·#57-5 and decision 4
 * #58): a checkbox per item asked — 이용약관, 개인정보 수집·이용 and '만 14세 이상입니다' required,
 * 마케팅 정보 수신 optional — and '전체 동의' over them, which checks or clears them all and shows
 * the mixed state when some are checked. `items` is what the step asks (`consentStepItems`): all
 * four the first time; in the re-consent after a revision that changed members' rights only the
 * items it left behind, so the marketing answer stays as it was (오너 결정 2026-10-19 (2차) 1) —
 * the stepper says above the heading why the account is here again. Every box starts empty
 * (`NO_CONSENTS`), the re-consent included.
 *
 * The 이용약관 and the 개인정보처리방침 open in a new tab; the two consent texts this step owns
 * (consent-texts.ts) open in place under their item ('내용 보기', a disclosure button). Going on
 * with a required item unchecked is refused here — an alert under the boxes, read out, and the
 * cursor on the first unchecked one — as the server would refuse the body. The answer of
 * `POST /me/consents` goes into `['me']` before the mutation settles (use-onboarding.ts), and the
 * stepper moves on with it.
 */
export function ConsentStep({ items }: { items: readonly ConsentItem[] }) {
  const record = useRecordConsents();
  const [choices, setChoices] = useState<ConsentChoices>(NO_CONSENTS);
  const [triedWithMissing, setTriedWithMissing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<ConsentItem>>(new Set());
  const inputs = useRef<Partial<Record<ConsentItem, HTMLInputElement | null>>>({});
  const idPrefix = useId();

  const missing = missingRequiredConsents(choices, items);
  // Said once a submit met it, and only while it still holds: checking the last required box
  // takes the alert away.
  const showMissing = triedWithMissing && missing.length > 0;

  const setItem = (item: ConsentItem, checked: boolean) => {
    setChoices((previous) => ({ ...previous, [item]: checked }));
  };

  const toggleText = (item: ConsentItem) => {
    setOpened((previous) => {
      const nextOpened = new Set(previous);
      if (nextOpened.has(item)) nextOpened.delete(item);
      else nextOpened.add(item);
      return nextOpened;
    });
  };

  const onSubmit = async () => {
    // Unreachable while the button honours `ready`.
    const accountId = record.accountId;
    if (accountId === undefined) return;
    const body = consentBody(choices, items, accountId);
    if (body === null) {
      setTriedWithMissing(true);
      const first = missing[0];
      if (first !== undefined) inputs.current[first]?.focus();
      return;
    }
    setNotice(null);
    try {
      await record.mutateAsync(body);
    } catch (error) {
      setNotice(consentFailure(error));
    }
  };

  return (
    <Stack gap="5" data-testid="consent-step">
      <Text color="fg.muted">{copy.consentIntro}</Text>
      {notice && (
        <Alert.Root status="error" role="alert" data-testid="consent-notice">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{notice}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      <Stack gap="1">
        <Checkbox.Root
          checked={allConsentState(choices, items)}
          onCheckedChange={(details) =>
            setChoices((previous) => withAllConsents(previous, items, details.checked === true))
          }
          colorPalette="brand"
          size="lg"
          data-testid="consent-all"
        >
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label fontWeight="semibold">{copy.consentAll}</Checkbox.Label>
        </Checkbox.Root>
        {items.includes('marketing') && (
          <Text fontSize="sm" color="fg.muted" ps="8">
            {copy.consentAllHint}
          </Text>
        )}
      </Stack>
      <Separator />
      <Stack as="ul" gap="4" listStyleType="none" aria-label={copy.onboardingStepConsent}>
        {items.map((item) => {
          const text = INLINE_TEXTS[item];
          const link = LINKS[item];
          const regionId = `${idPrefix}-${item}-text`;
          const open = opened.has(item);
          return (
            <Box as="li" key={item} data-testid={`consent-item-${item}`}>
              <Checkbox.Root
                checked={choices[item]}
                onCheckedChange={(details) => setItem(item, details.checked === true)}
                colorPalette="brand"
                alignItems="flex-start"
                data-testid={`consent-${item}`}
              >
                <Checkbox.HiddenInput
                  ref={(element: HTMLInputElement | null) => {
                    inputs.current[item] = element;
                  }}
                />
                <Checkbox.Control mt="0.5" />
                <Checkbox.Label>
                  {CONSENT_LABELS[item]} {consentTag(item)}
                </Checkbox.Label>
              </Checkbox.Root>
              {(text !== undefined || link !== undefined) && (
                <HStack gap="3" ps="7" pt="1" wrap="wrap">
                  {text !== undefined && (
                    <Button
                      variant="plain"
                      size="xs"
                      px="0"
                      color="fg.muted"
                      textDecoration="underline"
                      // Named after its text, the visible words kept in the name: two buttons
                      // both read as '내용 보기' would not say which text each one opens.
                      aria-label={`${text.title} ${open ? copy.consentHideText : copy.consentShowText}`}
                      aria-expanded={open}
                      aria-controls={open ? regionId : undefined}
                      onClick={() => toggleText(item)}
                      data-testid={`consent-${item}-toggle`}
                    >
                      {open ? copy.consentHideText : copy.consentShowText}
                    </Button>
                  )}
                  {link !== undefined && (
                    <Link asChild fontSize="xs" color="fg.muted" textDecoration="underline">
                      <NextLink href={link.href} target="_blank" rel="noopener">
                        {link.label}
                      </NextLink>
                    </Link>
                  )}
                </HStack>
              )}
              {text !== undefined && open && (
                <ConsentTextRegion
                  id={regionId}
                  text={text}
                  indent="7"
                  testId={`consent-${item}-text`}
                />
              )}
            </Box>
          );
        })}
      </Stack>
      {showMissing && (
        <Text role="alert" color="fg.error" fontSize="sm" data-testid="consent-required-error">
          {copy.errConsentRequired}
        </Text>
      )}
      <Button
        size="lg"
        onClick={() => void onSubmit()}
        loading={record.isPending}
        disabled={!record.ready}
        data-testid="consent-submit"
      >
        {copy.consentSubmit}
      </Button>
    </Stack>
  );
}
