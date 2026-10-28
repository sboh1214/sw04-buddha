import type { MetadataRoute } from 'next';

/**
 * `/robots.txt` (#47, ADR-0075, owner decision 2026-10-20 1): every crawler may read every page but
 * none may fetch `/api/` — served as two lines, `User-Agent: *` and `Disallow: /api/`. The market
 * detail is indexed, and its 토론 is read in the browser from
 * `GET /api/v1/markets/:id/posts`, never by the server page — so a crawler that runs the page's
 * scripts still finds no post title, text or author to index: the post page and the community list
 * are kept out of search, and so are the posts on the detail.
 *
 * `/api/*` is the one origin's API (deploy/Caddyfile routes it to the API; `next.config.ts`
 * rewrites it in development), and nothing a search engine should index lives there: every page's
 * server-rendered content is read by the server itself (`api.server.ts` dials the API directly),
 * a market's image is a URL an admin typed (elsewhere), and the post images under `/api/v1/media/`
 * are a post's content. A webhook or a sign-in callback is not a crawler and does
 * not read this file.
 *
 * No `allow: '/'`. Everything is allowed by default, so it adds nothing — and Next writes a
 * rule's `Allow` lines before its `Disallow` lines, so the file would read `Allow: /` first. A
 * crawler that takes the longest matching rule (RFC 9309: Google, Bing) still skips `/api/`, but
 * one that takes the FIRST matching line — Python's `urllib.robotparser`, which many scrapers use
 * — reads `Allow: /` and fetches `/api/` too. With the one `Disallow` both kinds read the same
 * (lib/robots.test.ts evaluates the served text both ways).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', disallow: '/api/' },
  };
}
