import { Box, Container, HStack, Link as ChakraLink, Stack, Text } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { FOOTER_BUSINESS_LINES, fillBusinessInfo } from '@/legal/business-info';

/** The four links (ADR-0044). 개인정보처리방침 is set in bold, as Korean sites mark it. */
const LINKS: { key: string; href: Route; label: string; strong?: boolean }[] = [
  { key: 'terms', href: '/terms', label: copy.legalTermsTitle },
  { key: 'privacy', href: '/privacy', label: copy.legalPrivacyTitle, strong: true },
  { key: 'refund', href: '/refund', label: copy.legalRefundTitle },
  { key: 'charge', href: '/charge', label: copy.chargeGuideTitle },
];

/**
 * The site footer on every page (owner decision 2026-09-28 §7, ADR-0044): the policy links and
 * the 사업자 정보 a 통신판매업자 has to show. The facts come from `BUSINESS_INFO` through the
 * `copy` templates, so the footer and the legal pages can never disagree about them.
 *
 * A server component: nothing here reads the session, the URL or the API, so it costs the
 * statically prerendered pages nothing and renders the same for every visitor.
 *
 * Below `md` the bottom of the viewport belongs to the fixed tab bar. The footer is the last
 * thing in the document, so it pays that bar's height as extra bottom padding — `20`, the
 * clearance `<main>` used to pay — on top of its own `8`; otherwise its last lines would sit
 * under the bar with nothing left to scroll.
 * The chrome matches the header's (1320px, 24px side padding).
 */
export function Footer() {
  return (
    <Box as="footer" borderTopWidth="1px" bg="bg.subtle" data-testid="site-footer">
      <Container maxW="1320px" px="6" pt="8" pb={{ base: '28', md: '10' }}>
        <Stack gap="4">
          <HStack as="nav" aria-label={copy.footerNavLabel} wrap="wrap" columnGap="4" rowGap="2">
            {LINKS.map((link) => (
              <ChakraLink
                key={link.key}
                asChild
                textStyle="emphasisSm"
                color="fg"
                fontWeight={link.strong ? 'bold' : undefined}
                data-testid={`footer-link-${link.key}`}
              >
                <NextLink href={link.href}>{link.label}</NextLink>
              </ChakraLink>
            ))}
          </HStack>
          <Box
            as="ul"
            aria-label={copy.footerBusinessInfoLabel}
            display="flex"
            flexWrap="wrap"
            columnGap="3"
            rowGap="1"
            textStyle="bodyXs"
            // `fg.muted` on `bg.subtle`: 7.2:1 light, 7.1:1 dark — small text, still AA.
            color="fg.muted"
            wordBreak="keep-all"
            overflowWrap="anywhere"
          >
            {FOOTER_BUSINESS_LINES.map((template) => (
              <Box as="li" key={template}>
                {fillBusinessInfo(template)}
              </Box>
            ))}
          </Box>
          <Text textStyle="bodyXs" color="fg.muted">
            {fillBusinessInfo(copy.footerCopyright)}
          </Text>
        </Stack>
      </Container>
    </Box>
  );
}
