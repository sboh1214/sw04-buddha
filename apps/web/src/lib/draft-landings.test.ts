import { describe, expect, it } from 'vitest';
import { draftLandings } from './draft-landings';

/**
 * The record of writes that landed, shared by the post and the comment drafts (ADR-0073 9-48,
 * ADR-0074 7-32): by the account that sent the write and the key of its screen or box.
 */
describe('draftLandings', () => {
  it('counts a write landed after a moment as saved, for that account and that key only', () => {
    const landings = draftLandings();
    const before = landings.moment();
    expect(landings.landedSince('box', 'account-a', before)).toBe(false);
    landings.landed('box', 'account-a');
    expect(landings.landedSince('box', 'account-a', before)).toBe(true);
    // Another account's form or box of the same key, and another key of the same account.
    expect(landings.landedSince('box', 'account-b', before)).toBe(false);
    expect(landings.landedSince('other', 'account-a', before)).toBe(false);
    // A form rendered after the landing has not been saved by it.
    expect(landings.landedSince('box', 'account-a', landings.moment())).toBe(false);
  });

  it('keeps each record apart: the post drafts’ landings say nothing of the comment drafts’', () => {
    const posts = draftLandings();
    const comments = draftLandings();
    const before = comments.moment();
    posts.landed('box', 'account-a');
    expect(comments.landedSince('box', 'account-a', before)).toBe(false);
  });
});
