import type { Route } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { X_PATHNAME, X_SEARCH } from '@/proxy';
import { myLoginPath } from './my';
import { getServerSession } from './session.server';

/**
 * MY's session gate (#16): no session -> the login page, told to come back to the MY page that was
 * asked for (`myLoginPath`, from the headers `proxy.ts` stamps). Reading `cookies()` through
 * `getServerSession()` is also what marks every MY route dynamic.
 *
 * The MY layout AND every MY page call it. A layout shared by the tabs is not re-rendered on a
 * client navigation between them, so the layout alone would gate only a hard load or a
 * navigation into MY; the page is rendered on every navigation to it, which is where the old
 * `/portfolio`, `/wallet` and `/settings` each ran this check. The layout's call keeps the tab
 * bar and 로그아웃 from being drawn for a visitor on a hard load. React `cache` makes the two
 * calls one session round trip per request.
 */
export const requireMySession = cache(async (): Promise<void> => {
  if (await getServerSession()) return;
  const requestHeaders = await headers();
  redirect(myLoginPath(requestHeaders.get(X_PATHNAME), requestHeaders.get(X_SEARCH)) as Route);
});
