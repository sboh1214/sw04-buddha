import { windowLeaveGuard } from '@/lib/leave-guard-window';

/**
 * Runs in the browser before the app hydrates (Next.js `instrumentation-client`).
 *
 * The leave guard (owner decision 2026-10-19, ADR-0073: leaving a draft asks first) is installed
 * here, idle until a screen has something to lose, because its `popstate` listener has to be on
 * `window` before the App Router's — which the router adds once it has hydrated. The listeners of
 * `window` run in the order they were added, and the router re-renders inside its own, so a
 * listener added later by the screen would be gone with the screen before it heard Back
 * (lib/leave-guard.ts).
 */
windowLeaveGuard();
