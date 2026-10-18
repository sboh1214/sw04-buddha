import { PHONE_VERIFICATION_LIMITS } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { formatKst } from './datetime';
import { smsAsOf, smsCount, smsDayDate, smsDayRows, smsServiceUsage } from './admin-sms';

describe('SMS 발송 현황 (owner decision 2026-10-18, second round)', () => {
  it('says the counts in 건, with thousands grouped', () => {
    expect(smsCount(0)).toBe(`0${copy.adminSmsCountUnit}`);
    expect(smsCount(12)).toBe('12건');
    expect(smsCount(1_234)).toBe('1,234건');
  });

  it('puts the last 24 hours against the limit the API answered', () => {
    expect(
      smsServiceUsage({
        sent: 12,
        unknown: 1,
        refused: 3,
        serviceLimit: PHONE_VERIFICATION_LIMITS.serviceDailySends,
      }),
    ).toBe('12 / 500건');
    // The API's value, whatever it is: the screen states no number of its own.
    expect(smsServiceUsage({ sent: 0, unknown: 0, refused: 0, serviceLimit: 1_000 })).toBe(
      '0 / 1,000건',
    );
  });

  it('lays the seven days out newest first, today marked, the API date kept as the key', () => {
    const rows = smsDayRows([
      { date: '2026-10-18', sent: 3, unknown: 1, refused: 2 },
      { date: '2026-10-07', sent: 0, unknown: 0, refused: 0 },
    ]);
    expect(rows).toEqual([
      {
        date: '2026-10-18',
        label: `2026. 10. 18. (${copy.adminSmsToday})`,
        sent: '3건',
        unknown: '1건',
        refused: '2건',
      },
      { date: '2026-10-07', label: '2026. 10. 7.', sent: '0건', unknown: '0건', refused: '0건' },
    ]);
  });

  it('writes a day as the time above the table writes its date: one date style on the screen', () => {
    expect(smsDayDate('2026-01-05')).toBe('2026. 1. 5.');
    // The date part of `formatKst` (기준 시각) for an instant of that Korean day, at any hour.
    for (const iso of ['2026-10-17T15:00:00Z', '2026-10-18T03:00:00Z', '2026-10-18T14:59:00Z']) {
      expect(formatKst(iso).startsWith(`${smsDayDate('2026-10-18')} `), iso).toBe(true);
    }
    // Anything else is shown as it came rather than guessed at.
    expect(smsDayDate('soon')).toBe('soon');
  });

  it('labels the time the counts were read, in Seoul: 기준 시각 and then the time', () => {
    expect(smsAsOf('2026-10-18T10:55:00Z')).toBe('기준 시각 2026. 10. 18. 오후 7:55');
    expect(smsAsOf('2026-10-17T15:00:00Z')).toBe(`${copy.adminSmsAsOf} 2026. 10. 18. 오전 12:00`);
  });
});
