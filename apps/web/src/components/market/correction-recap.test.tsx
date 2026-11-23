import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type RecapCompensation } from '@/lib/judgement-correction';
import { byTestId, renderWithQueries } from '@/test/render';
import { SRC } from '@/test/screen-text';
import { CorrectionRecapView } from './correction-recap';

const draw = (compensation: RecapCompensation, result: 'YES' | 'NO' | 'VOID' = 'NO') =>
  renderWithQueries(<CorrectionRecapView correction={{ result }} compensation={compensation} />);

/**
 * The recap's 판정 정정 (#144 part 2, ADR-0166; 144-11, 144-19): the corrected result, what this
 * account got — its own amount once paid, '보상 없음' when paid with nothing for it or none owed,
 * '보상 승인 대기' / '보상 준비 중' before — and the way to the public record.
 */
describe('CorrectionRecapView', () => {
  it('says the corrected result and the account’s own compensation once paid', () => {
    const html = draw({ kind: 'amount', coin: 100n });
    expect(byTestId(html, 'market-settled-correction')?.text).toContain('판정 정정');
    expect(byTestId(html, 'market-settled-corrected-result')?.text).toBe('정정된 결과 NO');
    expect(byTestId(html, 'market-settled-compensation')?.text).toBe('내 보상 100 Coin');
    expect(byTestId(html, 'market-settled-judging')?.text).toBe('판정 기록 보기');
    expect(byTestId(html, 'market-settled-judging')?.attributes.href).toBe('#judging-record');
  });

  it('never says 보상 없음 before the payout, and says it after for an account with nothing', () => {
    expect(byTestId(draw({ kind: 'pending' }), 'market-settled-compensation')?.text).toBe(
      '보상 승인 대기',
    );
    expect(byTestId(draw({ kind: 'preparing' }), 'market-settled-compensation')?.text).toBe(
      '보상 준비 중',
    );
    expect(byTestId(draw({ kind: 'none' }, 'YES'), 'market-settled-compensation')?.text).toBe(
      '보상 없음',
    );
    expect(byTestId(draw({ kind: 'none' }, 'VOID'), 'market-settled-corrected-result')?.text).toBe(
      '정정된 결과 무효',
    );
    expect(
      byTestId(draw({ kind: 'reading' }), 'market-settled-correction')?.attributes[
        'data-compensation'
      ],
    ).toBe('reading');
  });

  it('reads the amount from the ledger’s own entry, under the ledger’s key, once paid alone', () => {
    const source = readFileSync(new URL('./correction-recap.tsx', import.meta.url), 'utf8');
    expect(source).toContain(
      "const ledger = useLedger(\n    { kind: 'JUDGEMENT_COMPENSATION', market: marketId },\n    paid ? accountId : undefined,\n  );",
    );
    // The detail passes the record's correction to 내 포지션, which draws the block under the
    // records of a paid-out market alone.
    const position = readFileSync(new URL('./my-position.tsx', import.meta.url), 'utf8');
    expect(position).toContain("{view === 'recap' && correction !== null && (");
    const detail = readFileSync(path.join(SRC, 'app/markets/[slug]/market-detail.tsx'), 'utf8');
    expect(detail).toContain('correction={data?.judgingRecord.correction ?? null}');
  });
});
