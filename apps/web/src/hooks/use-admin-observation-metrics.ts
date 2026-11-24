'use client';

import { useQuery } from '@tanstack/react-query';
import { type AdminObservationMetrics, api, unwrap } from '@/lib/api';

/**
 * 관측 지표 (#96, ADR-0169): the one read of `/admin/observation-metrics` — all four tables in one
 * answer, one snapshot — under the private `['admin']` root (`PRIVATE_QUERY_ROOTS`, never
 * dehydrated). The client's defaults hold: 30 s stale, read again on window focus once stale.
 * Nothing polls and no realtime event touches it (ADR-0138; the request budget is
 * use-admin-observation-metrics.test.ts'). The options are exported apart from the hook for the
 * node test runner.
 */
export const ADMIN_OBSERVATION_METRICS_KEY = ['admin', 'observation-metrics'] as const;

export function adminObservationMetricsQueryOptions() {
  return {
    queryKey: ADMIN_OBSERVATION_METRICS_KEY,
    queryFn: async (): Promise<AdminObservationMetrics> =>
      unwrap(await api.GET('/api/v1/admin/observation-metrics')).data,
  };
}

export function useAdminObservationMetrics() {
  return useQuery(adminObservationMetricsQueryOptions());
}
