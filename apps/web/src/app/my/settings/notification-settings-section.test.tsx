import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { type Me, type NotificationSettings } from '@/lib/api';
import { notificationSettingsKey } from '@/lib/notifications';
import { byId, byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import {
  NotificationSettingsBody,
  NotificationSettingsSection,
} from './notification-settings-section';

const ACCOUNT = { id: 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46' } as Me;

const SETTINGS: NotificationSettings = {
  categories: [
    { category: 'trade', enabled: true },
    { category: 'market', enabled: false },
    { category: 'community', enabled: true },
  ],
};

/** The body drawn for ACCOUNT from what the cache holds (`useMe` waits for a session node lacks). */
const drawn = (held?: NotificationSettings, prepare?: Parameters<typeof renderWithQueries>[2]) =>
  renderWithQueries(
    <NotificationSettingsBody accountId={ACCOUNT.id} />,
    held === undefined ? [] : [[notificationSettingsKey(ACCOUNT.id), held]],
    prepare,
  );

/** The switches drawn, by their test ids. */
const switches = (html: string) =>
  testIdsStartingWith(html, 'settings-notifications-').filter((id) => id.endsWith('-switch'));

/** Whether a switch's box is checked, as its first paint has it. */
const checked = (html: string, category: string) =>
  byTestId(html, `settings-notifications-${category}-switch`)?.attributes['data-state'] ===
  'checked';

/**
 * MY › 설정's '알림 수신' card as drawn (#56, ADR-0162; owner answers 52-21, 52-23, 56-1…56-5): a
 * switch per category with a type, the 56-3 line and its way to the 정산 list.
 */
describe('NotificationSettingsSection', () => {
  it('is the card at its anchor, titled and hinted as approved, waiting for the account (56-4, 56-5)', () => {
    const html = renderWithQueries(<NotificationSettingsSection />, [
      [ME_QUERY_KEY, ACCOUNT],
      [notificationSettingsKey(ACCOUNT.id), SETTINGS],
    ]);
    const card = byTestId(html, 'settings-notifications');
    expect(card?.attributes.id).toBe('settings-notifications');
    expect(byId(html, 'settings-notifications')?.text).toContain('알림 수신');
    expect(card?.text).toContain(
      '분류마다 새 알림을 받을지 정합니다. 끈 동안 생긴 일은 다시 켜도 알림으로 오지 않고, 이미 받은 알림은 그대로 남습니다.',
    );
    // Nothing account-specific before the session and `Me` are known (no switches yet).
    expect(switches(html)).toEqual([]);
  });

  it('draws exactly three switches, each as the answer has it, named and explained (52-21, 56-2)', () => {
    const html = drawn(SETTINGS);
    expect(switches(html)).toEqual([
      'settings-notifications-trade-switch',
      'settings-notifications-market-switch',
      'settings-notifications-community-switch',
    ]);
    expect(checked(html, 'trade')).toBe(true);
    expect(checked(html, 'market')).toBe(false);
    expect(checked(html, 'community')).toBe(true);
    expect(byTestId(html, 'settings-notifications-trade-switch')?.text).toBe('거래 알림');
    expect(byTestId(html, 'settings-notifications-market-switch')?.text).toBe('시장 알림');
    expect(byTestId(html, 'settings-notifications-community-switch')?.text).toBe('커뮤니티 알림');
    expect(byTestId(html, 'settings-notifications-trade-hint')?.text).toBe(
      '대기 주문의 체결과 만료, 내가 하지 않은 대기 주문의 일괄 취소',
    );
    expect(byTestId(html, 'settings-notifications-market-hint')?.text).toBe(
      copy.notificationSettingMarketHint,
    );
    expect(byTestId(html, 'settings-notifications-community-hint')?.text).toBe(
      copy.notificationSettingCommunityHint,
    );
    // A checkbox each, named by its label (the accessible name), none locked (52-21).
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html.match(/aria-labelledby="[^"]*:label"/g)).toHaveLength(3);
    expect(html).not.toMatch(/\sdisabled=""|data-disabled/);
  });

  it('follows the shared order whatever the answer’s, and draws only what it lists (56-2)', () => {
    const html = drawn({
      categories: [
        { category: 'community', enabled: false },
        { category: 'trade', enabled: true },
      ],
    });
    expect(switches(html)).toEqual([
      'settings-notifications-trade-switch',
      'settings-notifications-community-switch',
    ]);
    expect(checked(html, 'community')).toBe(false);
  });

  it('says where the 정산 record is, with the link to the 정산 list (56-3, 52-23)', () => {
    for (const html of [drawn(SETTINGS), drawn()]) {
      expect(byTestId(html, 'settings-notifications-note')?.text).toBe(
        '알림을 꺼도 정산 기록은 MY 거래·정산 이력에서 볼 수 있습니다.',
      );
      const link = byTestId(html, 'settings-notifications-history-link');
      expect(link?.text).toBe('정산 기록 보기');
      expect(link?.attributes.href).toBe('/my/history?kind=settlements');
    }
  });

  it('draws no switch while reading, and the error with 다시 시도 when the read failed', () => {
    const pending = drawn();
    expect(switches(pending)).toEqual([]);
    expect(byTestId(pending, 'settings-notifications-pending')).toBeDefined();
    expect(pending).not.toContain('role="alert"');

    const failed = drawn(undefined, (queryClient) => {
      queryClient
        .getQueryCache()
        .build(queryClient, { queryKey: notificationSettingsKey(ACCOUNT.id) })
        .setState({ status: 'error', error: new Error('down') });
    });
    expect(switches(failed)).toEqual([]);
    expect(byTestId(failed, 'settings-notifications-pending')).toBeUndefined();
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(copy.errUnknown);
    expect(failed).toContain(copy.retry);

    // A read again that failed over what is held keeps the switches (TanStack keeps the data).
    const stale = drawn(SETTINGS, (queryClient) => {
      queryClient
        .getQueryCache()
        .find({ queryKey: notificationSettingsKey(ACCOUNT.id), exact: true })
        ?.setState({ status: 'error', error: new Error('read again failed') });
    });
    expect(switches(stale)).toHaveLength(3);
  });

  it('reads another account’s settings under its own key only (ADR-0091)', () => {
    const html = renderWithQueries(<NotificationSettingsBody accountId={ACCOUNT.id} />, [
      [notificationSettingsKey('another-account'), SETTINGS],
    ]);
    expect(switches(html)).toEqual([]);
  });
});

describe('the card’s place and its wiring (56-4, ADR-0157 결과 6)', () => {
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

  it('sits after 화면 모드 and before 조치·신고 내역, not beside the email 마케팅 card', () => {
    const page = source('./page.tsx');
    const at = (name: string) => page.indexOf(`<${name} />`);
    expect(at('ThemeSection')).toBeGreaterThan(-1);
    expect(at('NotificationSettingsSection')).toBeGreaterThan(at('ThemeSection'));
    expect(at('ModerationSection')).toBeGreaterThan(at('NotificationSettingsSection'));
    expect(at('MarketingSection')).toBeLessThan(at('TimeZoneSection'));
    expect(at('TimeZoneSection')).toBeLessThan(at('ThemeSection'));
  });

  it('is never held by a restriction, and names the drawn account in its writes', () => {
    const section = source('./notification-settings-section.tsx');
    expect(section).not.toMatch(/useMyRestriction|isRestricted|RESTRICTED/);
    expect(section).toContain('expectedAccountId: accountId');
    expect(section).toContain('<NotificationSettingsBody key={me.id} accountId={me.id} />');
    expect(section).not.toMatch(/session(?:\?)?\.user\.id/);
  });
});
