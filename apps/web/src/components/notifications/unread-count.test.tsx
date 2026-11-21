import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomTabs } from '@/components/layout/bottom-tabs';
import { MyTabs } from '@/app/my/my-tabs';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import type { Me } from '@/lib/api';
import { BOTTOM_TABS_HEIGHT_PX } from '@/lib/nav';
import { notificationUnreadKey } from '@/lib/notifications';
import { byId, byTestId, renderWithQueries } from '@/test/render';

/**
 * The unread count beside MY and on the 알림 tab (#53, owner answers 53-1 and 53-11 ①), drawn as a
 * signed-in member's tab draws it after hydration: the session and the pathname are this file's.
 */
interface SessionState {
  data: { user: { id: string } } | null;
  isPending: boolean;
}
const state: { session: SessionState } = vi.hoisted(() => ({
  session: { data: { user: { id: 'account-1' } }, isPending: false },
}));
vi.mock('@/lib/use-session', () => ({
  useSession: () => ({ ...state.session, error: null, refetch: () => Promise.resolve() }),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/my/notifications' }));

const ME = { id: 'account-1' } as Me;

const drawn = (node: React.ReactNode, unread: number | undefined) =>
  renderWithQueries(node, [
    [ME_QUERY_KEY, ME],
    ...(unread === undefined
      ? []
      : ([[notificationUnreadKey(ME.id), unread]] as const satisfies readonly (readonly [
          readonly unknown[],
          unknown,
        ])[])),
  ]);

beforeEach(() => {
  state.session = { data: { user: { id: ME.id } }, isPending: false };
});

describe('the unread count beside MY and on the 알림 tab', () => {
  for (const [name, node, link, count, text] of [
    ['the bottom tabs', <BottomTabs key="b" />, 'bottom-tab-my', 'bottom-tab-my-unread', 'MY'],
    [
      'MY’s tab bar',
      <MyTabs key="m" />,
      'my-tab-notifications',
      'my-tab-notifications-unread',
      '알림',
    ],
  ] as const) {
    it(`${name}: draws the number beside the link, its words as the link’s description`, () => {
      const html = drawn(node, 3);
      const anchor = byTestId(html, link);
      // The link's text — and so its accessible name — stays as it was (nav.spec.ts, my.spec.ts).
      expect(anchor?.text).toBe(text);
      const describedBy = anchor?.attributes['aria-describedby'];
      expect(describedBy).toBe(`${count}-text`);
      const description = byId(html, describedBy ?? '');
      expect(description?.text).toBe('안 읽은 알림 3개');
      // `hidden`: the description reads it, and a screen reader does not stop on it a second time.
      expect(description?.attributes).toHaveProperty('hidden', '');
      // The number is a sibling of the link, hidden from assistive technology.
      const shown = byTestId(html, count);
      expect(shown?.text).toBe('3');
      expect(shown?.attributes['aria-hidden']).toBe('true');
      expect(html.indexOf(`data-testid="${count}"`)).toBeGreaterThan(html.indexOf('</a>'));
    });

    it(`${name}: says 99+ past 99, and nothing at all at 0 or before the count is read`, () => {
      const many = drawn(node, 100);
      expect(byTestId(many, count)?.text).toBe('99+');
      expect(byId(many, `${count}-text`)?.text).toBe('안 읽은 알림 99개 넘게');
      for (const unread of [0, undefined]) {
        const none = drawn(node, unread);
        expect(byTestId(none, count)).toBeUndefined();
        expect(byTestId(none, link)?.attributes).not.toHaveProperty('aria-describedby');
        expect(byId(none, `${count}-text`)).toBeUndefined();
      }
    });
  }

  it('draws nothing account-specific before the session is known (hydration) or signed out', () => {
    for (const session of [
      { data: null, isPending: true },
      { data: null, isPending: false },
    ]) {
      state.session = session;
      const html = drawn(<BottomTabs />, 3);
      expect(byTestId(html, 'bottom-tab-my')).toBeUndefined();
      expect(byTestId(html, 'bottom-tab-my-unread')).toBeUndefined();
      expect(byTestId(drawn(<MyTabs />, 3), 'my-tab-notifications-unread')).toBeUndefined();
    }
  });

  it('keeps the bottom bar’s cells a fixed height, the count over the cell (BOTTOM_TABS_HEIGHT_PX)', () => {
    const source = readFileSync(new URL('../layout/bottom-tabs.tsx', import.meta.url), 'utf8');
    expect(source).toContain('h={`${String(BOTTOM_TABS_HEIGHT_PX - 1)}px`}');
    expect(BOTTOM_TABS_HEIGHT_PX).toBe(46);
    expect(readFileSync(new URL('./unread-count.tsx', import.meta.url), 'utf8')).toContain(
      'position="absolute"',
    );
  });

  it('is drawn beside the header’s MY item the same way', () => {
    // The header renders the search form and the categories, which need the app router: its MY
    // item is pinned in its source — the same component, the same description, the link's text
    // untouched.
    const nav = readFileSync(new URL('../layout/nav.tsx', import.meta.url), 'utf8');
    expect(nav).toContain("const NAV_MY_UNREAD_ID = 'nav-primary-my-unread-text';");
    expect(nav).toContain('aria-describedby={count === null ? undefined : NAV_MY_UNREAD_ID}');
    expect(nav).toMatch(
      /<UnreadCount\s+unread=\{count\}\s+id=\{NAV_MY_UNREAD_ID\}\s+testId="nav-primary-my-unread"/,
    );
    expect(nav).toMatch(/>\s*\{item\.label\}\s*<\/NextLink>/);
  });
});
