import { cookies } from 'next/headers';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/** Shape of better-auth `GET /get-session` (dates arrive as ISO strings over JSON). */
export interface ServerSession {
  user: { id: string; email: string; name: string; emailVerified: boolean; image?: string | null };
  session: { id: string; expiresAt: string };
}

/**
 * Reads the better-auth session on the server by forwarding the request cookies to the API
 * (`GET /api/auth/get-session`). Server components use it for redirects only; everything
 * rendered from session state uses `useSession()` (lib/auth-client) on the client.
 *
 * Next 16: `cookies()` is async and opts the route into dynamic rendering, which is what a
 * per-request session check needs. The fetch goes to the API origin directly, not through
 * the `/api/*` rewrite, so it never depends on the web server's own public URL.
 */
export async function getServerSession(): Promise<ServerSession | null> {
  const cookieHeader = (await cookies()).toString();
  if (!cookieHeader) return null;
  try {
    const res = await fetch(`${API_URL}/api/auth/get-session`, {
      headers: { cookie: cookieHeader },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ServerSession | null;
    return body?.user && body.session ? body : null;
  } catch {
    // API unreachable: render as logged out; the client surfaces the real error.
    return null;
  }
}
