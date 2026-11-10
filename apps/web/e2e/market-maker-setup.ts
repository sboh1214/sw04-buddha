import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { AdminTreasury, ReleaseSetting, TreasuryIssueWrite } from '@buddha/shared';
import { accountIdOf } from './helpers';
import { correctionFixtureUrls } from './reconciliation-correction-worker.mjs';

export type MarketMakerE2eProfile = 'regression' | 'quotes' | 'treasury';

/** Test fixtures only: none of these values is an approved launch setting. */
export const MARKET_MAKER_TEST_STAGES = {
  regression: [0, 0, 0],
  quotes: [7000, 9000, 5000],
  treasury: [0, 0, 0],
} as const;

const STAGE_KEYS = [
  'market_maker.reduce_at_bp',
  'market_maker.halt_at_bp',
  'market_maker.reduce_ratio_bp',
] as const;

/** 10,000 allocations of TEST_MARKET_LIQUIDITY's A; never a production default. */
const TEST_TREASURY_COIN = 100_000_000n;

export function marketMakerE2eProfile(value: unknown): MarketMakerE2eProfile {
  if (value === undefined) return 'regression';
  if (value === 'regression' || value === 'quotes' || value === 'treasury') return value;
  throw new Error('Unknown market-maker E2E profile');
}

async function dataOf<T>(response: APIResponse): Promise<T> {
  if (!response.ok())
    throw new Error(
      `Market-maker E2E setup failed at ${new URL(response.url()).pathname} (${String(response.status())})`,
    );
  return ((await response.json()) as { data: T }).data;
}

/**
 * A fresh, owned test stack is configured before scenarios create markets. A halt threshold of zero keeps
 * the general regression suite's initially flat makers from adding risk-raising orders. It does
 * not disable the worker, bypass allocation or change production defaults. Actual quoting runs
 * on a separate stack with the quotes profile; the insufficient-treasury profile starts unfunded.
 */
export async function prepareMarketMakerTestProfile(
  first: APIRequestContext,
  second: APIRequestContext,
  profile: MarketMakerE2eProfile,
): Promise<void> {
  // Reuse the native fixture's pure URL validation, before any new test setup writes. No DB
  // connection is opened here; all settings, requests and approvals use the real admin API.
  correctionFixtureUrls();
  const [firstId, secondId, readings] = await Promise.all([
    accountIdOf(first),
    accountIdOf(second),
    dataOf<ReleaseSetting[]>(await first.get('/api/v1/admin/release-settings')),
  ]);
  if (firstId === secondId)
    throw new Error('Treasury test setup needs two distinct administrators');
  const expected = MARKET_MAKER_TEST_STAGES[profile];
  const settings = STAGE_KEYS.map((key, index) => {
    const current = readings.find((entry) => entry.key === key);
    if (!current) throw new Error(`Missing market-maker release setting: ${key}`);
    const value = expected[index]!;
    // Validate every existing value before changing any setting. Never silently replace another
    // profile or an operator's value; run each profile on its own fresh DB/Redis pair.
    if (current.status !== 'undecided' && current.value !== value)
      throw new Error(`Market-maker E2E profile ${profile} conflicts with ${key}`);
    return { key, value, current };
  });
  for (const { key, value, current } of settings) {
    if (current.status !== 'undecided') continue;
    await dataOf(
      await first.patch(`/api/v1/admin/release-settings/${key}`, {
        data: {
          status: 'test',
          value,
          reason: `e2e: ${profile} 전용 시험 DB의 MM 단계 시험값 (운영 기본값 아님)`,
          expectedAccountId: firstId,
        },
      }),
    );
  }
  if (profile === 'treasury') return;

  const treasury = await dataOf<AdminTreasury>(await first.get('/api/v1/admin/treasury'));
  if (treasury.status === 'inconsistent')
    throw new Error('Treasury test setup refuses an inconsistent treasury');
  if (treasury.status === 'ready' && treasury.availableCoin === null)
    throw new Error('Treasury test setup received no available balance');
  const available = treasury.status === 'uninitialized' ? 0n : BigInt(treasury.availableCoin!);
  if (available >= TEST_TREASURY_COIN) return;
  const amountCoin = String(TEST_TREASURY_COIN - available);
  const requested = await dataOf<TreasuryIssueWrite>(
    await first.post('/api/v1/admin/treasury/issue-requests', {
      data: {
        amountCoin,
        reason: 'e2e: 시험 시장의 실제 초기 배정을 위한 시험 금고 재원 (운영 기본값 아님)',
        expectedAccountId: firstId,
      },
    }),
  );
  const approved = await dataOf<TreasuryIssueWrite>(
    await second.post(`/api/v1/admin/treasury/issue-requests/${requested.request.id}/approve`, {
      data: {
        reason: 'e2e: 다른 관리자가 시험 금고 발행 금액과 사유를 확인했습니다.',
        expectedAccountId: secondId,
      },
    }),
  );
  if (
    approved.request.status !== 'approved' ||
    approved.request.amountCoin !== amountCoin ||
    approved.request.ledgerEntryId === null ||
    approved.treasury.status !== 'ready' ||
    approved.treasury.availableCoin === null ||
    BigInt(approved.treasury.availableCoin) < TEST_TREASURY_COIN
  )
    throw new Error('Treasury test setup did not complete the fixed two-person issuance');
}
