import { cookies } from 'next/headers';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/** Shape of better-auth `GET /get-session` (dates arrive as ISO strings over JSON). */
export interface ServerSession {
  user: { id: string; email: string; name: string; emailVerified: boolean; image?: string | null };
  session: { id: string; expiresAt: string };
}

/**
 * The caller's role, read from `GET /api/v1/me` with the request cookies. Used by the admin
 * layout to keep a member from ever receiving the page; the API enforces the same rule on
 * every request (AdminGuard), so this is a UX guard, not the security boundary.
 * `undefined` means "no session, or the API could not answer".
 */
export async function getServerRole(): Promise<'user' | 'admin' | undefined> {
  const cookieHeader = (await cookies()).toString();
  if (!cookieHeader) return undefined;
  try {
    const res = await fetch(`${API_URL}/api/v1/me`, {
      headers: { cookie: cookieHeader },
      cache: 'no-store',
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: { profile?: { role?: 'user' | 'admin' } } };
    return body.data?.profile?.role;
  } catch {
    return undefined;
  }
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
