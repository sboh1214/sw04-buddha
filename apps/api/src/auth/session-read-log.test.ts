/**
 * What the API writes to its log when the database fails while a session is read (ADR-0152).
 *
 * better-auth's session read binds the session token itself (`where "session"."token" = $1`), and
 * drizzle puts a failed query's values in its error's message. Since better-auth 1.7.12 a failed
 * `getSession` throws a 500 with that error as its `cause`, which pino writes; better-auth also
 * logs the error itself, on every version. This drives the three doors a session is read at —
 * SessionGuard, the upload gate (image-body.ts) and better-auth's own routes — with the real
 * better-auth, drizzle adapter and loggers, and only the driver's answer replaced: the pool refuses
 * any query on the `session` table, as a dropped connection would.
 */
import { schema } from '@buddha/db';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoggerOptions } from '../logger.js';
import { createTestApp, signUpTestUser, type TestApp } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

/** What the driver says when the connection is gone: the reason the log must keep. */
const DRIVER_REASON = 'Connection terminated unexpectedly';

/** better-auth's session read, as drizzle writes it into the error. */
const SESSION_QUERY = 'from "session" where "session"."token" = $1';

describe.skipIf(!hasTestInfra)('a session read the database fails (integration)', () => {
  let t: TestApp;
  /** Every line the API's pino wrote, parsed. */
  const lines: Record<string, unknown>[] = [];
  /** Everything printed to the console meanwhile — where better-auth's own logger used to write. */
  const printed: string[] = [];

  beforeAll(async () => {
    // The API's own options, as production builds them (level `info`, no pretty transport).
    const logger = pino(createLoggerOptions({ NODE_ENV: 'production' }), {
      write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    t = await createTestApp({ logger });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Makes the pool refuse every query on `session`, and records the console from then on. */
  function failSessionReads(): void {
    const pool = t.db.$client;
    const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
    vi.spyOn(pool, 'query').mockImplementation((...args: unknown[]) => {
      const config = args[0];
      const text = typeof config === 'string' ? config : (config as { text: string }).text;
      if (text.includes('from "session"')) return Promise.reject(new Error(DRIVER_REASON));
      return query(...args);
    });
    for (const method of ['error', 'warn', 'info', 'log', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '));
      });
    }
  }

  /** A signed-in account, its session's raw token and its cookie's value as the browser holds it. */
  async function signedIn() {
    const user = await signUpTestUser(t);
    const [row] = await t.db
      .select({ token: schema.session.token })
      .from(schema.session)
      .where(eq(schema.session.userId, user.id));
    if (!row) throw new Error('no session row');
    const value = decodeURIComponent(user.cookie.slice(user.cookie.indexOf('=') + 1));
    expect(value.startsWith(`${row.token}.`)).toBe(true);
    return { cookie: user.cookie, token: row.token, cookieValue: value };
  }

  const doors = [
    {
      name: 'SessionGuard (GET /api/v1/me)',
      request: (cookie: string) => ({
        method: 'GET' as const,
        url: '/api/v1/me',
        headers: { cookie },
      }),
      // The guard's 500 is answered by ApiExceptionFilter, which logs it with its causes.
      filterLogs: true,
    },
    {
      name: 'the upload gate (POST /api/v1/media/images)',
      request: (cookie: string) => ({
        method: 'POST' as const,
        url: '/api/v1/media/images',
        headers: { cookie, origin: 'http://localhost:3000', 'content-type': 'image/png' },
        payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      }),
      filterLogs: true,
    },
    {
      name: 'better-auth’s own route (GET /api/auth/get-session)',
      request: (cookie: string) => ({
        method: 'GET' as const,
        url: '/api/auth/get-session',
        headers: { cookie },
      }),
      // better-auth answers its own 500; only its logger writes.
      filterLogs: false,
    },
  ];

  it.each(doors)(
    'writes the failure with its SQL and reason, and not the session token: $name',
    async ({ request, filterLogs }) => {
      const { cookie, token, cookieValue } = await signedIn();
      lines.length = 0;
      printed.length = 0;
      failSessionReads();

      const res = await t.app.inject(request(cookie));
      expect(res.statusCode).toBe(500);

      // Nothing anywhere: not the token, not the signed cookie, not the secret that signs it.
      const everything = JSON.stringify([lines, printed]);
      expect(everything).not.toContain(token);
      expect(everything).not.toContain(cookieValue);
      expect(everything).not.toContain(process.env.BETTER_AUTH_SECRET ?? 'no secret set');
      // better-auth no longer prints its lines to the console: they are the API's.
      expect(printed).toEqual([]);

      // better-auth's own line: the error it caught, through the API's logger, as `Auth`.
      const fromBetterAuth = lines.filter((line) => line.context === 'Auth' && line.level === 50);
      expect(fromBetterAuth).toHaveLength(1);
      expect(fromBetterAuth[0]?.msg).toContain('INTERNAL_SERVER_ERROR DrizzleQueryError: ');
      expect(fromBetterAuth[0]?.msg).toContain(`${SESSION_QUERY}\nparams: [1 redacted]`);
      expect(fromBetterAuth[0]?.msg).toContain(DRIVER_REASON);
      expect(fromBetterAuth[0]?.stack).toContain(`${SESSION_QUERY}\nparams: [1 redacted]\n`);

      // The filter's line keeps the whole chain: better-auth's 500, drizzle's SQL, the driver.
      const unhandled = lines.filter(
        (line) => line.msg === 'unhandled failure: Internal server error',
      );
      expect(unhandled).toHaveLength(filterLogs ? 1 : 0);
      if (!filterLogs) return;
      const err = unhandled[0]?.err as { type: string; message: string; stack: string };
      expect(err.type).toBe('APIError');
      expect(err.message).toBe(
        `Failed to get session: Failed query: select "id", "expires_at", "token", "created_at", ` +
          `"updated_at", "ip_address", "user_agent", "user_id" ${SESSION_QUERY}\n` +
          `params: [1 redacted]: ${DRIVER_REASON}`,
      );
      expect(err.stack).toContain(`caused by: Error: Failed query: `);
      expect(err.stack).toContain(`caused by: Error: ${DRIVER_REASON}`);
    },
  );
});
