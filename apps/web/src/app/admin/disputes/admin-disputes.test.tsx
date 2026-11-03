import { type AdminDisputeListStatus } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AdminMarketDisputePage, adminMarketDisputesKey } from '@/hooks/use-admin-markets';
import { type AdminDisputeQueueItem } from '@/lib/api';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { AdminDisputes } from './admin-disputes';

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const FIRST = 'e1b07384-d9a0-4c9b-8e2f-2d1c0f8a4b11';
const SECOND = 'e2b07384-d9a0-4c9b-8e2f-2d1c0f8a4b12';

const row = (id: string, fields: Partial<AdminDisputeQueueItem> = {}): AdminDisputeQueueItem => ({
  id,
  judgementVersion: 1,
  links: ['https://example.com/evidence'],
  reason: '규칙의 출처와 다릅니다.',
  status: 'pending',
  submittedAt: '2026-11-30T04:00:00.000Z',
  decidedAt: null,
  decisionReason: null,
  retractedAt: null,
  submitter: { id: 'member', nickname: '낸이' },
  decidedBy: null,
  purgedAt: null,
  market: { id: MARKET, slug: 'first-snow', title: '첫눈이 올까?', status: 'provisional' },
  ...fields,
});

/** A half as the server answered it, page by page. */
const drawn = (status: AdminDisputeListStatus, pages: AdminMarketDisputePage[]) =>
  renderWithQueries(<AdminDisputes status={status} />, [
    [
      adminMarketDisputesKey(status),
      { pages, pageParams: pages.map((_, at) => (at === 0 ? undefined : `c${String(at)}`)) },
    ],
  ]);

/**
 * 이의 접수 as drawn (#175, ADR-0104; N03 §8): each half in the order the API answers — 검토 대기 the
 * oldest first, 처리됨 the latest first (market-disputes.controller.test.ts) — one record each, its
 * market to its admin detail, 더 보기 while a page follows.
 */
describe('AdminDisputes', () => {
  it('draws one record per dispute in the order answered, its market to its admin detail', () => {
    const html = drawn('pending', [{ items: [row(FIRST), row(SECOND)], nextCursor: null }]);
    expect(byTestId(html, 'admin-disputes')?.attributes['data-status']).toBe('pending');
    expect(
      testIdsStartingWith(html, 'admin-dispute-').filter((id) =>
        /^admin-dispute-[0-9a-f-]{36}$/.test(id),
      ),
    ).toEqual([`admin-dispute-${FIRST}`, `admin-dispute-${SECOND}`]);
    expect(byTestId(html, `admin-dispute-${FIRST}-market`)?.attributes.href).toBe(
      `/admin/markets/${MARKET}`,
    );
    expect(byTestId(html, `admin-dispute-${FIRST}-market-status`)?.text).toBe('잠정 결과');
    expect(byTestId(html, `admin-dispute-${FIRST}-submitter`)?.text).toBe('낸이');
    expect(byTestId(html, `admin-dispute-${FIRST}-reason`)?.text).toBe('규칙의 출처와 다릅니다.');
    expect(byTestId(html, 'admin-disputes-more')).toBeUndefined();
    // The decisions are on the market's detail: no button here.
    expect(byTestId(html, `admin-dispute-${FIRST}-dismiss`)).toBeUndefined();
  });

  it('offers both halves, the one shown current', () => {
    const html = drawn('decided', [{ items: [], nextCursor: null }]);
    expect(byTestId(html, 'admin-disputes-queue-pending')?.attributes.href).toBe('/admin/disputes');
    expect(byTestId(html, 'admin-disputes-queue-decided')?.attributes.href).toBe(
      '/admin/disputes?status=decided',
    );
    expect(byTestId(html, 'admin-disputes-queue-decided')?.attributes['aria-current']).toBe('page');
    expect(
      byTestId(html, 'admin-disputes-queue-pending')?.attributes['aria-current'],
    ).toBeUndefined();
  });

  it('says each half empty in its own words', () => {
    expect(
      byTestId(drawn('pending', [{ items: [], nextCursor: null }]), 'admin-disputes-empty')?.text,
    ).toBe(copy.adminDisputesEmptyPending);
    expect(
      byTestId(drawn('decided', [{ items: [], nextCursor: null }]), 'admin-disputes-empty')?.text,
    ).toBe(copy.adminDisputesEmptyDecided);
  });

  it('shows a decided one with its decision, and 더 보기 while a page follows', () => {
    const decided = row(FIRST, {
      status: 'accepted',
      decidedAt: '2026-11-30T06:00:00.000Z',
      decisionReason: '정정이 필요합니다.',
      decidedBy: { id: 'approver', nickname: '승인한이' },
    });
    const html = drawn('decided', [{ items: [decided], nextCursor: 'c1' }]);
    expect(byTestId(html, `admin-dispute-${FIRST}-status`)?.text).toBe('수용');
    expect(byTestId(html, `admin-dispute-${FIRST}-decided-by`)?.text).toBe('승인한이');
    expect(byTestId(html, `admin-dispute-${FIRST}-decision-reason`)?.text).toBe(
      '정정이 필요합니다.',
    );
    expect(byTestId(html, 'admin-disputes-more')?.text).toBe(copy.loadMore);
  });
});
