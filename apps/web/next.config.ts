import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { NextConfig } from 'next';

// Next.js only reads .env* files inside apps/web. The project keeps a single repo-root .env
// (PLAN 15), so load it here first; values already in process.env win. This runs when the
// config loads (next dev startup / next build), so build output is per environment.
loadEnv({ path: path.join(import.meta.dirname, '../../.env'), quiet: true });

const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

const nextConfig: NextConfig = {
  output: 'standalone',
  // Trace from the monorepo root so workspace packages are copied into .next/standalone.
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  typedRoutes: true,
  // Do not write AGENTS.md / CLAUDE.md into apps/web on `next dev`.
  agentRules: false,
  experimental: {
    optimizePackageImports: ['@chakra-ui/react'],
  },
  // reactCompiler needs babel-plugin-react-compiler (Babel); intentionally not enabled.
  rewrites() {
    // Same-origin /api/* for the browser; the API server handles /api/auth/* and /api/v1/*.
    return Promise.resolve([{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }]);
  },
};

export default nextConfig;
