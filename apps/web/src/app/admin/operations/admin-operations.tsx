'use client';

import { Button, HStack, Heading, Link as ChakraLink, Stack, Text } from '@chakra-ui/react';
import { OPERATIONS_CLOSING_WINDOWS, OPERATIONS_JUDGEMENT_FILTERS } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import type { ReactNode } from 'react';
import { copy } from '@/copy';
import {
  ADMIN_DISPUTES_QUEUE_PATH,
  ADMIN_OPERATIONS_LISTS,
  ADMIN_OPERATIONS_LIST_TEXT,
  type AdminOperationsView,
  OPERATIONS_FILTER_LABEL,
  OPERATIONS_WINDOW_LABEL,
  adminOperationsPath,
} from '@/lib/admin-operations';
import { OperationsClosing } from './operations-closing';
import { OperationsFailures } from './operations-failures';
import { OperationsJudgements } from './operations-judgements';

/**
 * 운영 대기열 (#145 part 1, ADR-0163; N03 §8): the intro; on every tab, the fixed line leading to the
 * two lists #145 does not build (개설 검수 → 검수 대기, 이의 접수 — links only, no count and no
 * request); the three lists as tabs — 마감 예정, 판정 대기·지연, 정산 실패 — each a link with its own
 * address (`?list=`), and under 마감 예정 its window (24시간·3일·7일, 145-1) and under 판정 대기·지연
 * its filter (전체·지연만, 145-2), links as well. One list per screen, so one read per screen. Every
 * admin's (ADR-0056 1-2); access is checked in the admin layout and by the API on every call.
 */
export function AdminOperations({ view }: { view: AdminOperationsView }) {
  return (
    <Stack gap="5" data-testid="admin-operations" data-list={view.list}>
      <Heading as="h3" size="lg">
        {copy.adminOperations}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminOperationsIntro}
      </Text>
      <HStack gap="3" flexWrap="wrap" fontSize="sm" data-testid="admin-operations-other-lists">
        <Text as="span">{copy.adminOperationsOtherLists}</Text>
        <ChakraLink asChild colorPalette="brand" color="colorPalette.fg">
          <NextLink href="/admin/markets/reviews" data-testid="admin-operations-to-reviews">
            {copy.adminMarketReviews}
          </NextLink>
        </ChakraLink>
        <ChakraLink asChild colorPalette="brand" color="colorPalette.fg">
          <NextLink href={ADMIN_DISPUTES_QUEUE_PATH} data-testid="admin-operations-to-disputes">
            {copy.adminDisputes}
          </NextLink>
        </ChakraLink>
      </HStack>
      <HStack gap="2" flexWrap="wrap" data-testid="admin-operations-lists">
        {ADMIN_OPERATIONS_LISTS.map((list) => (
          <Choice
            key={list}
            href={adminOperationsPath({ list })}
            current={list === view.list}
            size="sm"
            testId={`admin-operations-list-${list}`}
          >
            {ADMIN_OPERATIONS_LIST_TEXT[list].label}
          </Choice>
        ))}
      </HStack>
      {view.list === 'closing' && (
        <HStack gap="2" flexWrap="wrap" data-testid="admin-operations-within">
          <Text as="span" fontSize="sm" color="fg.muted">
            {copy.adminOperationsWithin}
          </Text>
          {OPERATIONS_CLOSING_WINDOWS.map((within) => (
            <Choice
              key={within}
              href={adminOperationsPath({ list: 'closing', within })}
              current={within === view.within}
              size="xs"
              testId={`admin-operations-within-${within}`}
            >
              {OPERATIONS_WINDOW_LABEL[within]}
            </Choice>
          ))}
        </HStack>
      )}
      {view.list === 'judgements' && (
        <HStack gap="2" flexWrap="wrap" data-testid="admin-operations-filter">
          {OPERATIONS_JUDGEMENT_FILTERS.map((filter) => (
            <Choice
              key={filter}
              href={adminOperationsPath({ list: 'judgements', filter })}
              current={filter === view.filter}
              size="xs"
              testId={`admin-operations-filter-${filter}`}
            >
              {OPERATIONS_FILTER_LABEL[filter]}
            </Choice>
          ))}
        </HStack>
      )}
      {view.list === 'closing' ? (
        <OperationsClosing within={view.within} />
      ) : view.list === 'judgements' ? (
        <OperationsJudgements filter={view.filter} />
      ) : (
        <OperationsFailures />
      )}
    </Stack>
  );
}

/** A tab or a sub-choice: a link drawn as a button, the current one solid and `aria-current`. */
function Choice({
  href,
  current,
  size,
  testId,
  children,
}: {
  href: string;
  current: boolean;
  size: 'xs' | 'sm';
  testId: string;
  children: ReactNode;
}) {
  return (
    <Button asChild size={size} variant={current ? 'solid' : 'outline'}>
      <NextLink
        href={href as Route}
        aria-current={current ? 'page' : undefined}
        data-testid={testId}
      >
        {children}
      </NextLink>
    </Button>
  );
}
