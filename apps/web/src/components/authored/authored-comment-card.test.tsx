import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AuthoredComment } from '@/lib/api';
import { renderWithQueries } from '@/test/render';
import { AuthoredCommentCard } from './authored-comment-card';

const COMMENT: AuthoredComment = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3303',
  parentId: null,
  body: '동의합니다',
  author: { kind: 'former_member' },
  createdAt: '2026-10-19T00:00:00.000Z',
  editedAt: null,
  likeCount: 0,
  post: { state: 'deleted', id: '3f2504e0-4f89-11d3-9a0c-0305e82c3302' },
  market: {
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    slug: 'rate-cut-2026',
    title: '기준금리 인하?',
    status: 'open',
    judgementDelayed: false,
    category: { slug: 'economy', nameKo: '경제' },
  },
};

/** A 댓글 tab's item on a market sent back to a draft (#78 되돌리기, ADR-0099): as the post card. */
describe('AuthoredCommentCard market line', () => {
  it('links to a public market and says only that one sent back to a draft is not public', () => {
    const shown = renderWithQueries(<AuthoredCommentCard comment={COMMENT} />);
    expect(shown).toContain('기준금리 인하?');
    expect(shown).toContain('/markets/rate-cut-2026');
    const hidden = renderWithQueries(
      <AuthoredCommentCard comment={{ ...COMMENT, market: null }} />,
    );
    expect(hidden).toContain(copy.postMarketNotPublic);
    expect(hidden).not.toContain('/markets/');
  });
});
