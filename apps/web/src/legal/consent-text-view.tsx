import { Stack, Text } from '@chakra-ui/react';
import { type LegalDocument } from './document';
import { LegalBlocks } from './legal-document-view';

/**
 * A consent text (consent-texts.ts, business facts already resolved) opened in place under the
 * control that agrees to it: the onboarding's consent step and MY 설정's marketing switch (#58,
 * ADR-0072). Its tables stack their columns (`stackedTables`): the box is about 240px wide on a
 * 375px screen. It scrolls on its own so a long text does not push the button off a phone screen,
 * and takes the focus so the keyboard can scroll it too. `id` is what the toggle's
 * `aria-controls` names.
 */
export function ConsentTextRegion({
  id,
  text,
  testId,
  indent = '0',
}: {
  id: string;
  text: LegalDocument;
  testId: string;
  /** The start margin: the consent step lines the box up with its checkbox labels. */
  indent?: string;
}) {
  return (
    <Stack
      id={id}
      role="region"
      aria-label={text.title}
      tabIndex={0}
      gap="3"
      mt="2"
      ms={indent}
      p="3"
      maxH="72"
      overflowY="auto"
      borderWidth="1px"
      borderRadius="md"
      fontSize="sm"
      wordBreak="keep-all"
      overflowWrap="break-word"
      data-testid={testId}
    >
      <Text fontWeight="semibold">{text.title}</Text>
      <LegalBlocks blocks={text.intro} stackedTables />
    </Stack>
  );
}
