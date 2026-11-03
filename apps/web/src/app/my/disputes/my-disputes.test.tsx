import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type DisputePage } from '@/hooks/use-disputes';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { type Me, type MyDispute } from '@/lib/api';
import { myDisputesKey } from '@/lib/disputes';
import { byTestId, renderWithQueries } from '@/test/render';
import { type Disputes, DisputesBody, MyDisputes } from './my-disputes';

const ACCOUNT = { id: 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46' } as Me;

const dispute = (id: string, fields: Partial<MyDispute> = {}): MyDispute => ({
  id,
  judgementVersion: 1,
  links: ['https://example.com/a'],
  reason: '규칙의 출처와 다릅니다.',
  status: 'pending',
  submittedAt: '2026-11-30T03:00:00.000Z',
  decidedAt: null,
  decisionReason: null,
  retractedAt: null,
  closedAt: null,
  market: {
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    slug: 'first-snow',
    title: '첫눈이 올까?',
    status: 'provisional',
    judgementVersion: 1,
  },
  retractable: true,
  ...fields,
});

/**
 * The list's body as a settled read leaves it (`useMyDisputes` waits for the session, which node
 * never has: the page itself only draws its placeholder here).
 */
const drawn = (pages: DisputePage[], account: Me | null = ACCOUNT) => {
  const list: Disputes = {
    data: { pages, pageParams: pages.map(() => undefined) },
    hasNextPage: pages.at(-1)?.nextCursor != null,
    isPending: false,
    isLoadingError: false,
    isRefetchError: false,
    error: null,
    isFetchNextPageError: false,
    isFetchingNextPage: false,
    failureReason: null,
    refetch: () => Promise.reject(new Error('not in a test')),
    fetchNextPage: () => Promise.reject(new Error('not in a test')),
  };
  return renderWithQueries(<DisputesBody disputes={list} accountId={account?.id} />);
};

/**
 * MY '판정 이의' as drawn (#175, ADR-0104; #173 item 7: 처리 결과와 사유는 제출자에게 보인다): each of
 * the member's disputes with its market, status and the decision's reason, 철회 while it may be.
 */
describe('MyDisputes', () => {
  const PENDING = 'd1b07384-d9a0-4c9b-8e2f-2d1c0f8a4b11';
  const ACCEPTED = 'd2b07384-d9a0-4c9b-8e2f-2d1c0f8a4b12';

  it('waits for the session before drawing the list (MY’s ladder)', () => {
    const html = renderWithQueries(<MyDisputes />, [
      [myDisputesKey(ACCOUNT.id), { pages: [], pageParams: [] }],
      [ME_QUERY_KEY, ACCOUNT],
    ]);
    expect(byTestId(html, 'my-disputes')?.text).toContain(copy.myDisputes);
    expect(byTestId(html, 'my-disputes-intro')?.text).toBe(copy.myDisputesIntro);
    expect(byTestId(html, 'my-disputes-empty')).toBeUndefined();
  });

  it('lists each dispute with its market, its status and the decision’s reason, never the decider', () => {
    const html = drawn([
      {
        items: [
          dispute(PENDING),
          dispute(ACCEPTED, {
            status: 'accepted',
            decidedAt: '2026-11-30T06:00:00.000Z',
            decisionReason: '정정이 필요합니다.',
            retractable: false,
          }),
        ],
        nextCursor: null,
      },
    ]);
    expect(byTestId(html, `my-dispute-${PENDING}-market`)?.attributes.href).toBe(
      '/markets/first-snow',
    );
    expect(byTestId(html, `my-dispute-${PENDING}-status`)?.text).toBe('검토 중');
    expect(byTestId(html, `my-dispute-${PENDING}-retract`)?.text).toBe(copy.disputeRetract);
    expect(byTestId(html, `my-dispute-${ACCEPTED}-status`)?.text).toBe('수용');
    expect(byTestId(html, `my-dispute-${ACCEPTED}-decision-reason`)?.text).toBe(
      '정정이 필요합니다.',
    );
    expect(byTestId(html, `my-dispute-${ACCEPTED}-accepted-note`)?.text).toBe(
      copy.disputeAcceptedNote,
    );
    expect(byTestId(html, `my-dispute-${ACCEPTED}-retract`)).toBeUndefined();
    expect(byTestId(html, 'my-disputes-more')).toBeUndefined();
  });

  it('says the judgement was corrected for a dispute of an older version (#176, ADR-0105)', () => {
    const CLOSED = 'd3b07384-d9a0-4c9b-8e2f-2d1c0f8a4b13';
    // The market's judgement moved on to v2; both were filed on v1.
    const market = { ...dispute(PENDING).market, judgementVersion: 2 };
    const html = drawn([
      {
        items: [
          dispute(ACCEPTED, {
            status: 'accepted',
            decidedAt: '2026-11-30T06:00:00.000Z',
            decisionReason: '정정이 필요합니다.',
            retractable: false,
            market,
          }),
          dispute(CLOSED, {
            status: 'closed_by_correction',
            closedAt: '2026-11-30T07:00:00.000Z',
            retractable: false,
            market,
          }),
        ],
        nextCursor: null,
      },
    ]);
    expect(byTestId(html, `my-dispute-${ACCEPTED}-status`)?.text).toBe('수용');
    expect(byTestId(html, `my-dispute-${ACCEPTED}-corrected-note`)?.text).toBe(
      copy.disputeAcceptedCorrectedNote,
    );
    expect(byTestId(html, `my-dispute-${ACCEPTED}-accepted-note`)).toBeUndefined();
    const closed = `my-dispute-${CLOSED}`;
    expect(byTestId(html, closed)?.attributes['data-status']).toBe('closed_by_correction');
    expect(byTestId(html, `${closed}-status`)?.text).toBe('정정으로 종결');
    expect(byTestId(html, `${closed}-closed-note`)?.text).toBe(copy.disputeClosedByCorrectionNote);
    // Its closing time beside the submission's (MY's own zone formatting, ending in the minute).
    expect(byTestId(html, `${closed}-times`)?.text).toContain(copy.disputeClosedAt);
    expect(byTestId(html, `${closed}-times`)?.text).toContain('v1');
    expect(byTestId(html, `${closed}-retract`)).toBeUndefined();
    expect(byTestId(html, `${closed}-decision-reason`)).toBeUndefined();
  });

  it('holds 철회 off until `GET /me` has said whose list it is', () => {
    const html = drawn([{ items: [dispute(PENDING)], nextCursor: null }], null);
    expect(byTestId(html, `my-dispute-${PENDING}-retract`)?.attributes).toHaveProperty('disabled');
  });

  it('says none was filed, and offers 더 보기 while a page follows', () => {
    expect(byTestId(drawn([{ items: [], nextCursor: null }]), 'my-disputes-empty')?.text).toBe(
      copy.myDisputesEmpty,
    );
    expect(
      byTestId(drawn([{ items: [dispute(PENDING)], nextCursor: 'c2' }]), 'my-disputes-more')?.text,
    ).toBe(copy.loadMore);
  });

  it('is linked from MY 설정 and is a MY sub-page gated on the session (ADR-0089’s 내 제안 precedent)', () => {
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source('./page.tsx')).toContain('await requireMySession();');
    const settings = source('../settings/page.tsx');
    expect(settings).toContain('<DisputesSection />');
    expect(source('../settings/disputes-section.tsx')).toContain(
      '<NextLink href={MY_DISPUTES_PATH}>{copy.myDisputesOpen}</NextLink>',
    );
  });
});
