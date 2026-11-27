import { Link as ChakraLink, Heading, List, Stack, Text } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { type LegalDocument, effectiveDateText } from './document';
import { LegalDocumentView } from './legal-document-view';
import {
  LEGAL_DOCUMENT_PATHS,
  LEGAL_VERSIONS,
  type LegalDocumentKind,
  currentLegalDocument,
  effectiveDateOf,
  legalVersionPath,
} from './versions';

/**
 * `/terms`, `/privacy`, `/refund` and each version under them (`/terms/2026-11-28`): one version of
 * a legal document with its 시행일 under the title and, after the 부칙, the versions that took
 * effect, newest first, the current one marked (owner answer 137-2c, #137, ADR-0176). A consent
 * record names the version a member agreed to (#57-5), so every listed version stays readable. A
 * past version says so and links to the one in force.
 *
 * A server component with no data, like the view it wraps: every page is prerendered by `next
 * build`. Kept apart from legal-document-view.tsx, whose blocks the client-side consent step also
 * draws: this one imports the three documents, which have no business in that bundle.
 */
export function LegalVersionView({
  kind,
  document,
}: {
  kind: LegalDocumentKind;
  document: LegalDocument;
}) {
  const testId = `legal-${kind}`;
  const current = currentLegalDocument(kind);
  const isCurrent = document === current;
  const newestFirst = [...LEGAL_VERSIONS[kind]].reverse();
  return (
    <LegalDocumentView
      document={document}
      testId={testId}
      header={
        <Stack gap="1">
          <Text color="fg.muted" data-testid={`${testId}-effective-date`}>
            {copy.legalEffectiveDate.replace(
              '{date}',
              effectiveDateText(effectiveDateOf(document)),
            )}
          </Text>
          {!isCurrent && (
            <Text data-testid={`${testId}-past-version`}>
              {copy.legalPastVersion}{' '}
              <ChakraLink asChild color="fg" textDecoration="underline">
                <NextLink href={LEGAL_DOCUMENT_PATHS[kind]}>
                  {copy.legalCurrentVersionLink}
                </NextLink>
              </ChakraLink>
            </Text>
          )}
        </Stack>
      }
      footer={
        <Stack
          as="nav"
          gap="3"
          borderTopWidth="1px"
          pt="6"
          aria-labelledby={`${testId}-versions`}
          data-testid={`${testId}-versions`}
        >
          <Heading as="h3" id={`${testId}-versions`} textStyle="titleLg">
            {copy.legalVersions}
          </Heading>
          <List.Root as="ul" gap="2" ps="6">
            {newestFirst.map((version) => {
              const date = effectiveDateOf(version);
              const label = copy.legalVersionItem.replace('{date}', effectiveDateText(date));
              return (
                <List.Item key={date}>
                  {version === document ? (
                    <Text as="span" fontWeight="semibold" aria-current="page">
                      {label}
                    </Text>
                  ) : (
                    <ChakraLink asChild color="fg" textDecoration="underline">
                      <NextLink href={legalVersionPath(kind, date) as Route}>{label}</NextLink>
                    </ChakraLink>
                  )}
                  {version === current && ` (${copy.legalVersionCurrent})`}
                </List.Item>
              );
            })}
          </List.Root>
        </Stack>
      }
    />
  );
}
