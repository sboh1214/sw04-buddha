import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  HStack,
  Heading,
  Link as ChakraLink,
  SimpleGrid,
  Stack,
  Text,
} from '@chakra-ui/react';
import {
  PAID_COIN_SALES_ENABLED,
  discountPercent,
  formatKrw,
  formatP,
  parsePAmount,
} from '@buddha/shared';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { fillBusinessInfo } from '@/legal/business-info';
import type { ChargePackage } from '@/lib/api';
import { fetchChargePackagesServer } from '@/lib/api.server';
import { chargeTiers, walletPackageHref } from '@/lib/charge-guide';
import { PackageIllustration } from './package-illustration';

/**
 * Rendered per request: the catalogue is admin-edited (ADR-0026) and openapi-fetch's
 * `cache: 'no-store'` never reaches the branch Next marks a scope dynamic on (see the home
 * page), so without this `next build` — which runs with no API listening — would try to
 * prerender a page whose whole content is a live list.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: `${copy.chargeGuideTitle} | ${copy.appName}` };

/**
 * `/charge` 충전 안내 (owner decision 2026-09-28 §8, ADR-0044): the public list of charge
 * packages with a price and a picture each — what PG screening asks a merchant to show before
 * approving it ("바로 판매 가능한 상품과 이미지"). No login: the catalogue is public
 * (`GET /charge-packages`), and the page reads it on the server so the products are in the
 * first HTML a reviewer's crawler sees.
 *
 * Buying still happens on `/wallet`: each card links there with `?package=<id>`, which the
 * wallet preselects, and the wallet sends an anonymous visitor to the login page first. This
 * page never starts a payment itself.
 *
 * A failed read is the page's own notice, not a 500 — there is no `app/error.tsx`, and Next's
 * default error screen is untranslated.
 *
 * Not found while paid Coin is closed (PAID_COIN_SALES_ENABLED, ADR-0049): the initial product
 * shows no price list (N06), the footer does not link here, and the catalogue route is closed
 * as well. Checked before anything is fetched.
 */
export default async function ChargeGuidePage() {
  if (!PAID_COIN_SALES_ENABLED) notFound();
  const packages = await fetchChargePackagesServer().catch(() => null);

  return (
    <Container maxW="1320px" px="6" py={{ base: '6', md: '10' }}>
      {/* `keep-all`: break Korean at spaces, not between any two syllables (legal-document-view). */}
      <Stack gap="6" wordBreak="keep-all" overflowWrap="break-word">
        <Stack gap="2">
          <Heading as="h2" textStyle="headline">
            {copy.chargeGuideTitle}
          </Heading>
          <Text color="fg.muted">{fillBusinessInfo(copy.chargeGuideIntro)}</Text>
        </Stack>

        {packages === null ? (
          <Stack gap="3" align="flex-start" data-testid="charge-guide-error">
            <Alert.Root status="error" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.chargeGuideLoadError}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
            <Button asChild size="sm" variant="outline">
              <NextLink href="/charge">{copy.retry}</NextLink>
            </Button>
          </Stack>
        ) : packages.length === 0 ? (
          <EmptyState message={copy.chargeNoPackages} data-testid="charge-guide-empty" />
        ) : (
          <PackageGrid packages={packages} />
        )}

        <Text>{fillBusinessInfo(copy.chargeGuideDelivery)}</Text>

        <Alert.Root status="info" data-testid="charge-guide-notice">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{copy.chargeGuideNoticeTitle}</Alert.Title>
            <Alert.Description>
              <Stack gap="2" mt="1">
                <Text>{copy.walletNotice}</Text>
                <Text>{fillBusinessInfo(copy.chargeGuideRefundSummary)}</Text>
                <ChakraLink asChild fontWeight="semibold" textDecoration="underline">
                  <NextLink href="/refund">{copy.chargeGuideRefundLink}</NextLink>
                </ChakraLink>
              </Stack>
            </Alert.Description>
          </Alert.Content>
        </Alert.Root>
      </Stack>
    </Container>
  );
}

function PackageGrid({ packages }: { packages: ChargePackage[] }) {
  const amounts = packages.map((pack) => parsePAmount(pack.amountP));
  const tiers = chargeTiers(amounts);

  return (
    <SimpleGrid as="ul" columns={{ base: 1, sm: 2, lg: 3, xl: 4 }} gap="4">
      {packages.map((pack, index) => {
        const amountP = amounts[index] ?? 0n;
        const discount = discountPercent(amountP, pack.priceKrw);
        const label = formatP(amountP);
        return (
          <Card.Root
            as="li"
            key={pack.id}
            borderRadius="card"
            bg="surface.card"
            data-testid={`charge-guide-package-${pack.id}`}
          >
            <Card.Body gap="4">
              <PackageIllustration tier={tiers[index] ?? 0} />
              <Stack gap="1">
                <HStack gap="2" wrap="wrap">
                  <Heading as="h3" textStyle="titleLg">
                    {label}
                  </Heading>
                  {discount > 0 && (
                    <Badge colorPalette="yes" variant="subtle">
                      {discount}% {copy.chargeDiscount}
                    </Badge>
                  )}
                </HStack>
                <Text textStyle="bodyMd">
                  <Text as="span" color="fg.muted">
                    {copy.chargeGuidePrice}{' '}
                  </Text>
                  <Text as="span" fontWeight="semibold">
                    {formatKrw(pack.priceKrw)}
                  </Text>
                </Text>
              </Stack>
            </Card.Body>
            <Card.Footer>
              <Button asChild width="full">
                <NextLink
                  href={walletPackageHref(pack.id)}
                  // Four identical "충전하기" links are one name four times to a screen reader.
                  aria-label={`${label} ${copy.chargeSubmit}`}
                  data-testid={`charge-guide-buy-${pack.id}`}
                >
                  {copy.chargeSubmit}
                </NextLink>
              </Button>
            </Card.Footer>
          </Card.Root>
        );
      })}
    </SimpleGrid>
  );
}
