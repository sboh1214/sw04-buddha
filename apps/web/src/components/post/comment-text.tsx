import { Text } from '@chakra-ui/react';
import { commentSegments } from '@buddha/shared';
import { useMemo } from 'react';

/**
 * A comment's text (#48, ADR-0074; #45-3: plain text, its web addresses as links, line breaks
 * kept). The text is cut into runs by `commentSegments` — the shared rule the API's tests hold too
 * — and each run is drawn as a text node or as one `<a>`: nothing is parsed as markup and no HTML
 * string is built, so whatever a comment says is text. A link is an http(s) address that passes the
 * post's own link check (`postLinkHref`: no user or password, at most 2,048 characters), opens in a
 * new tab and is marked as the writer's, not the service's (`nofollow ugc`), as a post's links are.
 *
 * `pre-wrap` keeps the writer's line breaks and spaces; `overflowWrap: anywhere` breaks a long
 * address or an unbroken run where it must, so neither pushes the page wider than a phone.
 *
 * The runs are cut once per body, not on every render of the thread (the `GET /me` answer, a 답글
 * box opening, a refetch): cutting one body costs at most about a millisecond (ADR-0074 decision
 * 3), but a page draws every comment of 20 threads.
 *
 * No directive: it renders only inside the post page's client components (comments-section.tsx).
 */
export function CommentText({ body }: { body: string }) {
  const segments = useMemo(() => commentSegments(body), [body]);
  return (
    <Text
      textStyle="bodyMd"
      color="fg"
      whiteSpace="pre-wrap"
      overflowWrap="anywhere"
      css={{
        '& a': { color: 'brand.fg', textDecoration: 'underline', textUnderlineOffset: '2px' },
      }}
      data-testid="comment-body"
    >
      {segments.map((segment, index) =>
        segment.type === 'link' ? (
          <a
            // The runs of one body never move: their order is the key.
            key={index}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
          >
            {segment.text}
          </a>
        ) : (
          segment.text
        ),
      )}
    </Text>
  );
}
