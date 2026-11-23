import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  type AdminJudgementCompensationRecipientPage,
  adminJudgementCompensationRecipientsKey,
} from '@/hooks/use-admin-markets';
import { type AdminJudgementCompensationRecipient } from '@/lib/api';
import { byTagName, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { JudgementCompensationRecipients } from './market-judgement-compensation-recipients';

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const row = (
  id: string,
  nickname: string | null,
  amountCoin: string,
  state: AdminJudgementCompensationRecipient['state'],
): AdminJudgementCompensationRecipient => ({ account: { id, nickname }, amountCoin, state });

const drawn = (pages: AdminJudgementCompensationRecipientPage[]) =>
  renderWithQueries(<JudgementCompensationRecipients marketId={MARKET} />, [
    [
      adminJudgementCompensationRecipientsKey(MARKET),
      { pages, pageParams: pages.map((_, at) => (at === 0 ? undefined : `c${String(at)}`)) },
    ],
  ]);

/**
 * 판정 오류 보상's 대상 계정 (#144 part 2, ADR-0166; 144-7, 144-16, 144-19): each listed account in the
 * order answered (bytewise, the API's), its nickname, amount and state in the approved words.
 */
describe('JudgementCompensationRecipients', () => {
  it('draws each account with its amount and state, a closed one as 탈퇴한 사용자', () => {
    const html = drawn([
      {
        items: [
          row('A-user', '보유자갑', '100', 'pending'),
          row('B-user', '보유자을', '50', 'blocked'),
          row('a-user', null, '200', 'closed'),
        ],
        nextCursor: null,
      },
    ]);
    expect(
      testIdsStartingWith(html, 'market-judgement-compensation-recipient-').filter(
        (id) => !id.startsWith('market-judgement-compensation-recipients'),
      ),
    ).toEqual([
      'market-judgement-compensation-recipient-A-user',
      'market-judgement-compensation-recipient-B-user',
      'market-judgement-compensation-recipient-a-user',
    ]);
    // The columns are named, so the amount and state cells are not bare (WCAG 1.3.1).
    expect(byTagName(html, 'th').map((th) => th.text)).toEqual([
      copy.adminMarketJudgementCompensationRecipientsColAccount,
      copy.adminMarketJudgementCompensationRecipientsColAmount,
      copy.adminMarketJudgementCompensationRecipientsColState,
    ]);
    expect(byTestId(html, 'market-judgement-compensation-recipients-head')?.text).toBe(
      '계정보상액상태',
    );
    const first = byTestId(html, 'market-judgement-compensation-recipient-A-user');
    expect(first?.attributes['data-state']).toBe('pending');
    expect(first?.text).toContain('보유자갑');
    expect(first?.text).toContain('100 Coin');
    expect(first?.text).toContain('지급 대기');
    expect(byTestId(html, 'market-judgement-compensation-recipient-B-user')?.text).toContain(
      '원장 확인 필요',
    );
    const closed = byTestId(html, 'market-judgement-compensation-recipient-a-user');
    expect(closed?.text).toContain(copy.postAuthorFormer);
    expect(closed?.text).toContain('탈퇴로 지급 못 함');
    expect(byTestId(html, 'market-judgement-compensation-recipients-more')).toBeUndefined();
  });

  it('says 지급 완료 after the approval, and offers 더 보기 while a page follows', () => {
    const html = drawn([{ items: [row('A-user', '보유자갑', '100', 'paid')], nextCursor: 'c1' }]);
    expect(byTestId(html, 'market-judgement-compensation-recipient-A-user')?.text).toContain(
      '지급 완료',
    );
    expect(byTestId(html, 'market-judgement-compensation-recipients-more')?.text).toBe(
      copy.loadMore,
    );
  });

  it('says so when no account is listed', () => {
    expect(
      byTestId(
        drawn([{ items: [], nextCursor: null }]),
        'market-judgement-compensation-recipients-empty',
      )?.text,
    ).toBe(copy.adminMarketJudgementCompensationRecipientsEmpty);
  });
});
