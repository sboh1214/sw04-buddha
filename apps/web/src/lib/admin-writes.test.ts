import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0092: the admin writes the server did not check before — 반복 링크 '확인함', 시장 (만들기·고치기·
 * 공개·마감·판정·관련 시장), 테마 (and its markets and notices), 운영 공지 (쓰기·수정·고정·고정 해제),
 * 시장 제안 처리, 출시 설정, 쿠폰, 충전 상품 — name the admin on screen (`expectedAccountId`), which
 * the API now compares with the cookie's account. In the render between the session naming B and
 * SessionCacheGuard's reset the admin screens are still A's; a write from one went with B's cookie
 * and was recorded as B. No component renders under node (vitest's `environment: 'node'`), so the
 * wiring is pinned in the sources, as ADR-0091 pinned the operator writes it fixed
 * (admin-accounts.test.ts): each screen's admin is `useOperatorId` (`GET /me`'s — never the
 * session's), its writes name it, its buttons wait for it, and the refusal asks for the session
 * again (`useSessionChanged`). e2e admin-writes.spec.ts drives the screens.
 */
const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

/** Each screen, with the writes it must send as the admin on screen. */
const SCREENS: Readonly<Record<string, readonly string[]>> = {
  '../app/admin/moderation/link-flags/admin-link-flags.tsx': [
    'toLinkFlagReviewBody(group, chosen, note, by)',
  ],
  '../app/admin/markets/admin-markets.tsx': [
    '.mutateAsync({ ...toCreateMarketBody(values), expectedAccountId: operatorId })',
  ],
  '../app/admin/markets/[id]/admin-market-detail.tsx': [
    // 공개 and 마감
    "await api.POST('/api/v1/admin/markets/{id}/open', {\n          params: { path: { id: market.id } },\n          body: { expectedAccountId },",
    "await api.POST('/api/v1/admin/markets/{id}/close', {\n          params: { path: { id: market.id } },\n          body: { expectedAccountId },",
    // 판정
    'body: toResolveMarketBody(values, by),',
    // 수정, at once and after the open market's confirmation
    '.mutateAsync({ ...body, expectedAccountId: operatorId })',
    'update.mutate({ ...pending, expectedAccountId: operatorId });',
    // 관련 시장: the link's body, the unlink's query
    'body: { marketId: relatedId, expectedAccountId: by },',
    'query: { expectedAccountId: by },',
  ],
  '../app/admin/themes/admin-themes.tsx': [
    '.mutateAsync({ ...toCreateThemeBody(values), expectedAccountId: operatorId })',
  ],
  '../app/admin/themes/[id]/admin-theme-detail.tsx': [
    // 공개 · 비공개로 돌리기
    "await api.POST('/api/v1/admin/themes/{id}/publish', {\n              params: { path: { id: theme.id } },\n              body: { expectedAccountId: by },",
    "await api.POST('/api/v1/admin/themes/{id}/unpublish', {\n              params: { path: { id: theme.id } },\n              body: { expectedAccountId: by },",
    // 수정
    '.mutateAsync({ ...body, expectedAccountId: operatorId })',
    // the theme's markets: in, out (a DELETE's query)
    'body: { marketId, expectedAccountId: by },',
    'params: { path: { id: themeId, marketId }, query: { expectedAccountId: by } },',
    // its notices: written, edited, hidden, shown
    'body: { ...toThemeNoticeBody(values), expectedAccountId: by },',
    'body: { ...fields, expectedAccountId: by },',
    "await api.POST('/api/v1/admin/themes/{id}/notices/{noticeId}/hide', {\n              params: { path: { id: theme.id, noticeId } },\n              body: { expectedAccountId: by },",
    "await api.POST('/api/v1/admin/themes/{id}/notices/{noticeId}/show', {\n              params: { path: { id: theme.id, noticeId } },\n              body: { expectedAccountId: by },",
  ],
  '../app/admin/proposals/[id]/admin-proposal-detail.tsx': [
    'body: { expectedAccountId },',
    'body: toAdoptProposalBody(values, by),',
    'body: toLinkProposalMarketBody(values, by),',
    'body: toRejectProposalBody(values, by),',
    "body: { memo: memo.trim() === '' ? null : memo.trim(), expectedAccountId: by },",
  ],
  '../app/admin/settings/admin-release-settings.tsx': [
    'body: toReleaseSettingChangeBody(values, item.valueSchema, operatorId)',
  ],
  '../app/admin/coupons/admin-coupons.tsx': [
    'expectedAccountId: by,',
    'body: { isActive: !coupon.isActive, expectedAccountId: by },',
  ],
  '../app/admin/charge-packages/admin-charge-packages.tsx': [
    'expectedAccountId: by,',
    'body: { isActive: !pack.isActive, expectedAccountId: by },',
    'params: { path: { id }, query: { expectedAccountId: by } },',
  ],
  '../app/admin/notices/notice-forms.tsx': [
    '{ noticeId: notice.id, expectedAccountId: operatorId },',
  ],
  '../app/admin/notices/admin-notices.tsx': ['{ noticeId: id, expectedAccountId: operatorId },'],
};

describe('the admin the admin writes name (ADR-0092)', () => {
  it('is the admin of the `Me` the screen is drawn from, never the session’s', () => {
    for (const [file, sends] of Object.entries(SCREENS)) {
      const text = source(file);
      expect(text, file).toContain("import { useOperatorId } from '@/hooks/use-operator';");
      expect(text, file).toContain('const operatorId = useOperatorId();');
      // Nothing on these screens reads the session's account; the session is only asked again.
      expect(text, file).not.toMatch(/useSession\b|session\.user|user\.id/);
      for (const send of sends) expect(text, `${file}: ${send}`).toContain(send);
    }
  });

  it('waits for `GET /me` before any of them can be pressed', () => {
    // A write before the admin on screen is known would name nobody; the API needs the field.
    const waits: Readonly<Record<string, number>> = {
      '../app/admin/moderation/link-flags/admin-link-flags.tsx': 1,
      '../app/admin/markets/admin-markets.tsx': 1,
      // 공개, 마감's confirm, 판정's confirm, 저장 and its confirm, 연결, 해제's confirm
      '../app/admin/markets/[id]/admin-market-detail.tsx': 7,
      '../app/admin/themes/admin-themes.tsx': 1,
      // 공개, 비공개의 confirm, 저장, 넣기, 빼기의 confirm, 공지 쓰기·고치기, 보이기, 숨기기의 confirm
      '../app/admin/themes/[id]/admin-theme-detail.tsx': 9,
      // 검토 시작, 채택·연결·반려의 confirm, 메모 저장
      '../app/admin/proposals/[id]/admin-proposal-detail.tsx': 5,
      '../app/admin/settings/admin-release-settings.tsx': 1,
      '../app/admin/coupons/admin-coupons.tsx': 2,
      '../app/admin/charge-packages/admin-charge-packages.tsx': 3,
    };
    for (const [file, count] of Object.entries(waits)) {
      const off =
        source(file).match(
          /(?:disabled|confirmDisabled|submitDisabled)=\{[^}]*operatorId === undefined[^}]*\}/g,
        ) ?? [];
      expect(off, file).toHaveLength(count);
    }
    // The notices' 고정 and 고정 해제 are off through `busy`.
    for (const file of [
      '../app/admin/notices/notice-forms.tsx',
      '../app/admin/notices/admin-notices.tsx',
    ]) {
      expect(source(file), file).toMatch(/const busy = [^;]*\|\| operatorId === undefined;/);
    }
  });

  it('asks for the session again on the refusal that the cookie is another account’s', () => {
    const hook = source('../hooks/use-session-changed.ts');
    expect(hook).toContain('if (!isForAnotherAccount(error)) return false;');
    expect(hook).toContain('void refetchSession();');
    for (const file of Object.keys(SCREENS)) {
      if (file.includes('/notices/') || file.includes('/settings/')) continue;
      expect(source(file), file).toContain('const sessionChanged = useSessionChanged();');
    }
    // The notices' and the release settings' hooks ask it themselves.
    expect(source('../hooks/use-notices.ts')).toContain(
      'if (isForAnotherAccount(error)) {\n    onSessionChanged();\n    return;\n  }',
    );
    expect(source('../hooks/use-admin-release-settings.ts')).toContain(
      'if (isForAnotherAccount(error)) {\n        void refetchSession();\n        return;\n      }',
    );
    // A notice's write and edit name the admin the form is drawn for — its landing's too.
    const notices = source('../hooks/use-notices.ts');
    expect(notices.match(/body: \{ \.\.\.fields, expectedAccountId: accountId \},/g)).toHaveLength(
      2,
    );
    expect(notices).toContain('body: { expectedAccountId },');
  });
});
