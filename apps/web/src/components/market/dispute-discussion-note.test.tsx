import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { byTestId, renderWithQueries } from '@/test/render';
import { SRC } from '../../test/screen-text';
import { DisputeDiscussionNote } from './dispute-discussion-note';

const DEADLINE = '2026-12-01T03:00:00.000Z';

/**
 * '토론 글은 판정 이의가 아닙니다.' and the link (ADR-0093 decision 3 '#175 토론의 이의 안내', #175,
 * ADR-0104): above the detail's discussion list and on the write screen with a market chosen, on a
 * 잠정 결과 while its 이의 기한 is ahead — the API's `disputeOpen`, then the screen's timer.
 */
describe('DisputeDiscussionNote', () => {
  const note = (disputeOpen: boolean, disputeDeadline: string | null = DEADLINE) =>
    renderWithQueries(
      <DisputeDiscussionNote
        market={{ slug: 'first-snow', disputeOpen, disputeDeadline }}
        testId="note"
      />,
    );

  it('says a post is no 판정 이의 and links the submission screen while disputes are taken', () => {
    const html = note(true);
    expect(byTestId(html, 'note')?.text).toContain(copy.discussionDisputeNote);
    expect(byTestId(html, 'note-link')?.attributes.href).toBe('/markets/first-snow/dispute');
    expect(byTestId(html, 'note-link')?.text).toBe(copy.marketDisputeSubmit);
  });

  it('is gone once the deadline came or before any judgement', () => {
    expect(note(false)).toBe('');
    expect(note(false, null)).toBe('');
  });

  it('stands above the discussion list and under the write screen’s market, outside the sanction banner', () => {
    const source = (file: string) => readFileSync(path.join(SRC, file), 'utf8');
    const discussion = source('app/markets/[slug]/market-discussion.tsx');
    const at = discussion.indexOf('<MarketDisputeDiscussionNote');
    expect(at).toBeGreaterThan(-1);
    // Above the list's rungs, below the heading row with 글쓰기.
    expect(at).toBeGreaterThan(discussion.indexOf('data-testid="market-discussion-write"'));
    expect(at).toBeLessThan(discussion.indexOf("view.body === 'pending'"));
    const write = source('app/community/write/write-screen.tsx');
    expect(write).toContain(
      '<DisputeDiscussionNote market={market} testId="post-write-dispute-note" />',
    );
    // In the form with a market chosen, not in the sanction banner (ADR-0084 6-11).
    expect(write.indexOf('<DisputeDiscussionNote')).toBeGreaterThan(
      write.indexOf('data-testid="post-write-market"'),
    );
    expect(write.indexOf('<DisputeDiscussionNote')).toBeGreaterThan(
      write.indexOf('testId="post-write-sanction-banner"'),
    );
  });
});
