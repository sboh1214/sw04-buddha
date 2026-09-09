'use client';

import { useQuery } from '@tanstack/react-query';
import { api, unwrap, type LeaderboardEntry } from '@/lib/api';
import { LEADERBOARD_KEY } from '@/lib/market-keys';

/**
 * The global ranking (`GET /leaderboard`, public; PLAN M6 선택).
 *
 * Exported apart from the hook, like `adminMarketQueryOptions`, because the decision is the
 * options object and a component cannot be executed in this app's test runner. The page
 * prefetches with the same factory, so the server's payload lands on the key the hook reads.
 */
export function leaderboardQueryOptions() {
  return {
    queryKey: LEADERBOARD_KEY,
    queryFn: async (): Promise<LeaderboardEntry[]> =>
      unwrap(await api.GET('/api/v1/leaderboard')).data,
  };
}

export function useLeaderboard() {
  return useQuery(leaderboardQueryOptions());
}
