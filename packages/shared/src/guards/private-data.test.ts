import { describe, expect, it } from 'vitest';
import {
  PRIVATE_DATA,
  PRIVATE_DATA_IDS,
  type PrivateDataId,
  findPrivateField,
} from './private-data.js';

const items = (name: string) => [...new Set(findPrivateField(name).map((hit) => hit.item))];

describe('PRIVATE_DATA (#113)', () => {
  it('lists each item once, in the order of its ids, with a basis and fields', () => {
    expect(PRIVATE_DATA.map((item) => item.id)).toEqual([...PRIVATE_DATA_IDS]);
    for (const item of PRIVATE_DATA) {
      expect(item.name.trim(), item.id).not.toBe('');
      expect(item.basis.trim(), item.id).not.toBe('');
      expect(item.fields.length, item.id).toBeGreaterThan(0);
      for (const run of item.fields) {
        expect(run.length, item.id).toBeGreaterThan(0);
        for (const word of run) expect(word, item.id).toMatch(/^[a-z]+$/);
      }
      for (const word of [...(item.owned?.words ?? []), ...(item.owned?.whose ?? [])]) {
        expect(word, item.id).toMatch(/^[a-z]+$/);
      }
      if (item.pending !== undefined) expect(item.pending.trim(), item.id).not.toBe('');
    }
  });

  it('names the items #113 lists, the ones nothing stores yet included', () => {
    expect(PRIVATE_DATA_IDS).toEqual(
      expect.arrayContaining([
        'email',
        'real-name',
        'phone',
        'identity-verification',
        'risk-flag',
        'author-holding',
      ]),
    );
    expect(
      PRIVATE_DATA.filter((item) => item.pending !== undefined).map((item) => item.id),
    ).toEqual(['identity-verification', 'risk-flag', 'author-holding']);
  });
});

describe('findPrivateField', () => {
  it.each<[string, PrivateDataId]>([
    ['balance', 'balance'],
    ['availableCoin', 'balance'],
    ['locked_coin', 'balance'],
    ['orderId', 'orders'],
    ['counterparty_order_id', 'orders'],
    ['orders', 'orders'],
    ['idempotencyKey', 'orders'],
    ['position', 'holdings'],
    ['holdings', 'holdings'],
    ['costBasisCoin', 'holdings'],
    ['realizedPnlCoin', 'pnl'],
    ['unrealizedProfit', 'pnl'],
    ['myFills', 'fills'],
    ['userFills', 'fills'],
    ['accountFills', 'fills'],
    ['fillsByUser', 'fills'],
    ['fills_by_account', 'fills'],
    ['traderFills', 'fills'],
    ['ownFills', 'fills'],
    ['memberTradeHistory', 'fills'],
    ['userTrades', 'fills'],
    ['userId', 'counterparty'],
    ['accountId', 'counterparty'],
    ['counterpartyType', 'counterparty'],
    ['makerOrderId', 'counterparty'],
    ['traderId', 'counterparty'],
    ['email', 'email'],
    ['realName', 'real-name'],
    ['buyer_full_name', 'real-name'],
    ['phone', 'phone'],
    ['mobileNumber', 'phone'],
    ['identityVerification', 'identity-verification'],
    ['otpSentAt', 'identity-verification'],
    ['ci', 'identity-verification'],
    ['birthDate', 'identity-verification'],
    ['passwordHash', 'auth-secret'],
    ['sessionToken', 'auth-secret'],
    ['riskFlags', 'risk-flag'],
    ['needsReview', 'risk-flag'],
    ['isSuspended', 'risk-flag'],
    ['authorPosition', 'author-holding'],
    ['author_side', 'author-holding'],
  ])('finds %s (%s)', (name, item) => {
    expect(items(name)).toContain(item);
  });

  it.each([
    'id',
    'marketId',
    'nameKo',
    'title',
    'lastPrice',
    'volumeCoin',
    'tradeCount',
    'traderCount',
    'participantCount',
    'fills',
    'recentFills',
    'fillCount',
    'lastFill',
    'marketFills',
    'trades',
    'outcome',
    'side',
    'qty',
    'priceAvgBp',
    'amountCoin',
    'orderBook',
    'statusEventId',
    'resolvedResult',
    'resolution',
    'uptimeSeconds',
    'latencyMs',
    'sortOrder',
    'parentId',
    'nextCursor',
    'myriad',
  ])('lets %s through', (name) => {
    expect(findPrivateField(name)).toEqual([]);
  });

  it('reports the item and the words that matched', () => {
    expect(findPrivateField('userRealName')).toEqual([{ item: 'real-name', words: 'real name' }]);
    expect(findPrivateField('fillsByUser')).toEqual([{ item: 'fills', words: 'user fills' }]);
    expect(findPrivateField('myBalance')).toEqual([
      { item: 'balance', words: 'balance' },
      { item: 'fills', words: 'my' },
    ]);
  });
});
