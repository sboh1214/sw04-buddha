'use client';

import { AuthoredCommentCard } from '@/components/authored/authored-comment-card';
import { AuthoredListBody } from '@/components/authored/authored-list';
import { AuthoredTabs } from '@/components/authored/authored-tabs';
import { PostCard } from '@/components/post/post-card';
import { copy } from '@/copy';
import { useProfileComments, useProfilePosts, useRedrawOnReturn } from '@/hooks/use-authored';
import { authoredTabSearch } from '@/lib/authored';
import { profilePath } from '@/lib/profile';

/**
 * A profile's 글·댓글 (#51, ADR-0080; ADR-0069 decision 3 #37-14): the member's posts and their 댓글
 * and 대댓글 on two tabs, newest first, what was deleted or hidden left out and what sits on an
 * ended or voided market kept, all of it while the member is under a restriction too (the owner's
 * «제재 중인 사람의 글») — the items the counts above count (ADR-0078), so a tab never holds more
 * or fewer than its number. Every reader gets the same lists, signed in or not (#37-1). Each item
 * opens its post and, by the market line, its market, an ended one too, and carries 신고 for every
 * reader but its author (owner decision 2026-10-21) — a visitor's press comes back to this tab.
 *
 * Read in the browser, after the page the server drew (`useProfilePosts`), so the per-address
 * bucket applies to whoever reads them — as the owner decided for a post's comments (2026-10-21,
 * which #48's follow-up records in ADR-0074) and for #47's discussion (ADR-0075); see ADR-0080
 * 7-10. A post is the community list's card, so its title is an `h4` under the section's `h3`.
 *
 * The counts above are the server's and the lists here the browser's, so a page Back or Forward
 * brings back — the counts as they were when the reader left, the lists read again — is drawn again
 * from the server (`useRedrawOnReturn`, ADR-0080 7-16): the tab and its number stay the same.
 */
export function ProfileAuthored({ publicId }: { publicId: string }) {
  useRedrawOnReturn();
  return (
    <AuthoredTabs
      label={copy.profilePostsHeading}
      testId="profile-authored"
      panels={{
        posts: <ProfilePosts publicId={publicId} />,
        comments: <ProfileComments publicId={publicId} />,
      }}
    />
  );
}

function ProfilePosts({ publicId }: { publicId: string }) {
  const list = useProfilePosts(publicId);
  return (
    <AuthoredListBody
      list={list}
      tab="posts"
      testId="profile-posts-list"
      renderRow={(post) => (
        <PostCard post={post} titleAs="h4" report={{ backPath: profilePath(publicId) }} />
      )}
    />
  );
}

function ProfileComments({ publicId }: { publicId: string }) {
  const list = useProfileComments(publicId);
  return (
    <AuthoredListBody
      list={list}
      tab="comments"
      testId="profile-comments-list"
      renderRow={(comment) => (
        <AuthoredCommentCard
          comment={comment}
          report={{
            backPath: `${profilePath(publicId)}${authoredTabSearch('', 'comments')}`,
          }}
        />
      )}
    />
  );
}
