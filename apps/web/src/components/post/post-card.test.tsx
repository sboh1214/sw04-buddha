import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type PostMarket, type PostSummary } from '@/lib/api';
import { renderWithQueries } from '@/test/render';
import { PostCard } from './post-card';

const MARKET: PostMarket = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  slug: 'rate-cut-2026',
  title: '기준금리 인하?',
  status: 'scheduled',
  judgementDelayed: false,
  disputeUnderReview: false,
  category: { slug: 'economy', nameKo: '경제' },
};

const POST: PostSummary = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
  title: '금리 이야기',
  excerpt: '첫 줄',
  thumbnailUrl: null,
  author: { kind: 'former_member' },
  market: MARKET,
  createdAt: '2026-10-19T00:00:00.000Z',
  editedAt: null,
  commentCount: 0,
  likeCount: 0,
};

/**
 * The card's market line (#78 되돌리기, ADR-0099, owner answer 2026-11-01): a market sent back to a
 * draft reaches the card as null, and the line says only '공개되지 않은 시장' — no title, badge or
 * link — until the market is public again.
 */
describe('PostCard market line', () => {
  it('links to a public market by its title and status', () => {
    const html = renderWithQueries(<PostCard post={POST} />);
    expect(html).toContain(MARKET.title);
    expect(html).toContain(`/markets/${MARKET.slug}`);
    expect(html).toContain(copy.marketStatusScheduled);
    expect(html).not.toContain(copy.postMarketNotPublic);
  });

  it('says only that the market is not public when the API names none of it', () => {
    const html = renderWithQueries(<PostCard post={{ ...POST, market: null }} />);
    expect(html).toContain(copy.postMarketNotPublic);
    expect(html).toContain('data-testid="post-card-market-hidden"');
    expect(html).not.toContain('/markets/');
    expect(html).not.toContain('data-testid="post-card-market"');
  });

  it('draws no market line at all in one market’s list', () => {
    const html = renderWithQueries(
      <PostCard post={{ ...POST, market: null }} showMarket={false} />,
    );
    expect(html).not.toContain(copy.postMarketNotPublic);
  });
});
