'use client';

import { Box, Button, Heading, Link as ChakraLink, Stack, Text } from '@chakra-ui/react';
import NextLink from 'next/link';
import { useId, useState } from 'react';
import { copy } from '@/copy';
import { firstOrderTopics } from '@/lib/first-order-guide';
import { serviceGuideHref } from '@/lib/service-guide';

/**
 * 첫 주문 안내 (#59, ADR-0154) on 확인: open, with no way to fold it, while the account has no order
 * the server took (`Me.firstOrderPlaced`, owner answer 2026-11-21 #59-1); afterwards folded under
 * '첫 주문 안내 다시 보기', which opens the same text (#59-2). The topics are the confirmed order's
 * (#59-3). Nothing while the account is not known yet: 확인 opens on a fresh `GET /me`, so that is
 * only a moment.
 *
 * It ends on a link to the guide's 주문 방식 (#59-4 '그 이슈에서 연결을 더한다', #136, ADR-0177), in a
 * new tab: following it from 확인 must not throw the confirmed order away, as the consent step's
 * links to the 이용약관 do not.
 */
export function FirstOrderGuide({
  firstOrderPlaced,
  timeInForce,
  side,
}: {
  firstOrderPlaced: boolean | undefined;
  timeInForce: 'ioc' | 'gtc';
  side: 'buy' | 'sell';
}) {
  const [opened, setOpened] = useState(false);
  const bodyId = useId();
  if (firstOrderPlaced === undefined) return null;
  const folds = firstOrderPlaced;
  const open = !folds || opened;
  return (
    <Box data-testid="first-order-guide" data-folded={open ? 'false' : 'true'}>
      {folds && (
        <Button
          size="xs"
          variant="plain"
          px="0"
          color="fg.muted"
          textDecoration="underline"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setOpened((was) => !was);
          }}
          data-testid="first-order-guide-toggle"
        >
          {open ? copy.firstOrderGuideHide : copy.firstOrderGuideShow}
        </Button>
      )}
      <Box
        id={bodyId}
        hidden={!open}
        borderWidth="1px"
        borderRadius="md"
        bg="bg.subtle"
        px="3"
        py="2.5"
        mt={folds ? '1' : '0'}
        data-testid="first-order-guide-body"
      >
        <Heading as="h4" size="sm" mb="2">
          {copy.firstOrderGuideTitle}
        </Heading>
        <Stack as="ul" gap="2" listStyleType="none" ms="0">
          {firstOrderTopics(timeInForce, side).map((topic) => (
            <Box as="li" key={topic.id} data-testid={`first-order-guide-${topic.id}`}>
              <Text fontSize="xs" fontWeight="semibold">
                {topic.title}
              </Text>
              <Text fontSize="xs" color="fg.muted">
                {topic.body}
              </Text>
            </Box>
          ))}
        </Stack>
        <ChakraLink
          asChild
          display="inline-block"
          mt="2"
          fontSize="xs"
          color="fg.muted"
          textDecoration="underline"
          data-testid="first-order-guide-link"
        >
          <NextLink href={serviceGuideHref('orders')} target="_blank" rel="noopener">
            {copy.guideLinkOrders}
          </NextLink>
        </ChakraLink>
      </Box>
    </Box>
  );
}
