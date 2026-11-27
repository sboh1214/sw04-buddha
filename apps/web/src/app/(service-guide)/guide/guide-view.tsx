import { Container, Heading, Link as ChakraLink, Stack, Text } from '@chakra-ui/react';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { LegalBlocks } from '@/legal/legal-document-view';
import type { ServiceGuide } from './guide-content';

/**
 * The guide's page body (#136, ADR-0177): the legal pages' reading frame (legal-document-view.tsx
 * — 3xl width, h2 title, h3 sections, `keep-all`) with each section under a fixed `id`, its
 * anchor, so `/guide#judgement` opens the same section whatever comes before it. The legal view's
 * own ids are numbered (`${testId}-${index}`), and its model has no inline link for the 이용약관
 * the head points to (owner answer 136-3), hence a view of its own; the blocks are the legal
 * view's (`LegalBlocks`).
 *
 * `scrollMarginTop`: a section opened by its anchor stops below the sticky header (65px on this
 * page, which has no category row), as MY 설정's sections do.
 *
 * A server component with no data, like the legal pages: the same HTML for every visitor.
 */
export function ServiceGuideView({ guide }: { guide: ServiceGuide }) {
  return (
    <Container maxW="3xl" px="6" py={{ base: '6', md: '10' }}>
      <Stack
        as="article"
        gap="8"
        textStyle="bodyMd"
        wordBreak="keep-all"
        overflowWrap="break-word"
        data-testid="service-guide"
      >
        <Stack gap="3">
          <Heading as="h2" textStyle="headline">
            {guide.title}
          </Heading>
          {guide.intro.map((text) => (
            <Text key={text}>{text}</Text>
          ))}
          <ChakraLink
            asChild
            alignSelf="flex-start"
            color="fg"
            textDecoration="underline"
            data-testid="service-guide-terms-link"
          >
            <NextLink href="/terms">{copy.serviceGuideTermsLink}</NextLink>
          </ChakraLink>
        </Stack>
        {guide.sections.map((section) => {
          const headingId = `${section.anchor}-heading`;
          return (
            <Stack
              as="section"
              key={section.anchor}
              id={section.anchor}
              gap="3"
              scrollMarginTop="20"
              aria-labelledby={headingId}
              data-testid={`service-guide-${section.anchor}`}
            >
              <Heading as="h3" id={headingId} textStyle="titleLg">
                {section.heading}
              </Heading>
              <LegalBlocks blocks={section.blocks} />
            </Stack>
          );
        })}
      </Stack>
    </Container>
  );
}
