import { describe, expect, it } from 'vitest';
import { parseLedgerAuditArgs } from './ledger-audit-args.js';

describe('manual reconciliation selection', () => {
  it('audits every scope by default and accepts one explicit target', () => {
    expect(parseLedgerAuditArgs([])).toEqual({ scope: 'all' });
    expect(parseLedgerAuditArgs(['--supply'])).toEqual({ scope: 'supply' });
    expect(parseLedgerAuditArgs(['--user-id', 'person-1'])).toEqual({
      scope: 'account',
      userId: 'person-1',
    });
    expect(parseLedgerAuditArgs(['--account-id', '23'])).toEqual({
      scope: 'account',
      accountId: 23,
    });
    expect(parseLedgerAuditArgs(['--market-id', 'A5F00AE2-0DAD-40B7-8093-E53FF610CF5E'])).toEqual({
      scope: 'market',
      marketId: 'a5f00ae2-0dad-40b7-8093-e53ff610cf5e',
    });
  });

  it.each([
    ['--market-id', 'bad'],
    ['--account-id', '0'],
    ['--account-id', '-1'],
    ['--account-id', '1.5'],
    ['--account-id', '9007199254740992'],
    ['--account-id', '2e2'],
    ['--user-id', '  '],
    ['--user-id'],
    ['--supply', '--market-id', 'a5f00ae2-0dad-40b7-8093-e53ff610cf5e'],
    ['--suply'],
  ])('rejects invalid or combined selectors before connecting: %j', (...args) => {
    expect(() => parseLedgerAuditArgs(args)).toThrow('Usage:');
  });
});
