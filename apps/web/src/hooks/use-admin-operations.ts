'use client';

import { type OperationsClosingWindow, type OperationsJudgementFilter } from '@buddha/shared';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import {
  type AdminAwaitingJudgementMarket,
  type AdminClosingMarket,
  type AdminOperationsFailure,
  api,
  unwrap,
} from '@/lib/api';

/**
 * 운영 대기열's three lists (#145 part 1, ADR-0163) under one prefix of the private `['admin']` root
 * (`PRIVATE_QUERY_ROOTS`): `[…, 'closing', within]`, `[…, 'judgements', filter]` and
 * `[…, 'failures']`. Every admin write to a market asks the prefix again (`invalidateMarket`), and
 * so does 정산 다시 시도. Each list is 20 a page with 더 보기 (the API's default page), the previous
 * sub-choice's rows kept while the next loads, and nothing polls (ADR-0138; the request budget is
 * use-admin-operations.test.ts'). The options are exported apart from the hooks for the node test
 * runner.
 */
export const ADMIN_OPERATIONS_KEY = ['admin', 'operations'] as const;
export const adminOperationsClosingKey = (within: OperationsClosingWindow) =>
  [...ADMIN_OPERATIONS_KEY, 'closing', within] as const;
export const adminOperationsJudgementsKey = (filter: OperationsJudgementFilter) =>
  [...ADMIN_OPERATIONS_KEY, 'judgements', filter] as const;
export const ADMIN_OPERATIONS_FAILURES_KEY = [...ADMIN_OPERATIONS_KEY, 'failures'] as const;

/** One page of a 운영 대기열 list. */
export interface AdminOperationsPage<T> {
  items: T[];
  nextCursor: string | null;
}
export type AdminClosingPage = AdminOperationsPage<AdminClosingMarket>;
export type AdminJudgementsPage = AdminOperationsPage<AdminAwaitingJudgementMarket>;
export type AdminFailuresPage = AdminOperationsPage<AdminOperationsFailure>;

const cursorOf = (pageParam: string | undefined) =>
  pageParam === undefined ? {} : { cursor: pageParam };

/** 마감 예정 (145-1): OPEN and PAUSED markets closing within `within`, the nearest first. */
export function adminOperationsClosingQueryOptions(within: OperationsClosingWindow) {
  return {
    queryKey: adminOperationsClosingKey(within),
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<AdminClosingPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/operations/closing', {
          params: { query: { within, ...cursorOf(pageParam) } },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AdminClosingPage) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  };
}

export function useAdminOperationsClosing(within: OperationsClosingWindow) {
  return useInfiniteQuery(adminOperationsClosingQueryOptions(within));
}

/** 판정 대기·지연 (145-2): by scheduled judgement, every row or the delayed ones ('지연만'). */
export function adminOperationsJudgementsQueryOptions(filter: OperationsJudgementFilter) {
  return {
    queryKey: adminOperationsJudgementsKey(filter),
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<AdminJudgementsPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/operations/judgements', {
          params: { query: { filter, ...cursorOf(pageParam) } },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AdminJudgementsPage) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  };
}

export function useAdminOperationsJudgements(filter: OperationsJudgementFilter) {
  return useInfiniteQuery(adminOperationsJudgementsQueryOptions(filter));
}

/** 정산 실패 with 처리 멈춤 and 봇 자금 회수 실패 (145-4, 145-8): the oldest problem first. */
export function adminOperationsFailuresQueryOptions() {
  return {
    queryKey: ADMIN_OPERATIONS_FAILURES_KEY,
    queryFn: async ({
      pageParam,
    }: {
      pageParam: string | undefined;
    }): Promise<AdminFailuresPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/operations/failures', {
          params: { query: cursorOf(pageParam) },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AdminFailuresPage) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  };
}

export function useAdminOperationsFailures() {
  return useInfiniteQuery(adminOperationsFailuresQueryOptions());
}
