import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0092: the admin writes the server did not check before — 반복 링크 '확인함', 시장 (만들기·고치기·
 * 공개·마감·판정·관련 시장; the one-admin 공개, 마감 and 판정 since gone, #21·#114·#152), 테마 (and its markets and
 * notices), 운영 공지 (쓰기·수정·고정·고정 해제), 시장 제안 처리, 출시 설정, 쿠폰, 충전 상품, and since the owner closed Q-PG-8 ①
 * («이 PR에서 더함») 환불 (and 잔고 조정 until #116) — name the admin on screen (`expectedAccountId`), which the API now
 * compares with the cookie's account. In the render between the session naming B and
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
  '../app/admin/audit-failures/reconciliation-correction-dialogs.tsx': [
    'expectedAccountId: by,',
    'body: { expectedAccountId: by, reason: draft.reason }',
    'body: { expectedAccountId: by }',
  ],
  '../app/admin/moderation/link-flags/admin-link-flags.tsx': [
    'toLinkFlagReviewBody(group, chosen, note, by)',
  ],
  '../app/admin/markets/admin-markets.tsx': [
    '.mutateAsync({ ...toCreateMarketBody(values), expectedAccountId: operatorId })',
  ],
  '../app/admin/markets/[id]/admin-market-detail.tsx': [
    // The interim 공개 went with #21 (ADR-0100: a market opens from 개장 예정 by itself, or by the
    // approval or the reschedule below), the one-admin 마감 with #114 (ADR-0102: a pause and
    // another admin's approved early close, below) and the one-admin 판정 with #152 (ADR-0103: a
    // registration and another admin's approval, below)
    // 수정, at once and after the open market's confirmation
    '.mutateAsync({ ...body, expectedAccountId: operatorId })',
    'update.mutate({ ...pending, expectedAccountId: operatorId });',
    // 관련 시장: the link's body, the unlink's query
    'body: { marketId: relatedId, expectedAccountId: by },',
    'query: { expectedAccountId: by },',
  ],
  // 개설 검수 (#78, ADR-0099), new since and written the same way: 검수 제출, then 승인 · 반려 ·
  // 초안으로 되돌리기 · 예정 개장 시각 변경 from their dialogs
  '../app/admin/markets/[id]/market-review-panel.tsx': [
    "await api.POST('/api/v1/admin/markets/{id}/submit', {\n          params: { path: { id: market.id } },\n          body: { expectedAccountId },",
  ],
  '../app/admin/markets/[id]/market-review-dialogs.tsx': [
    'body: { requestId, checklist, reason, expectedAccountId: by },',
    'body: { requestId, rejectReason, reason, expectedAccountId: by },',
    'body: { reason, expectedAccountId: by },',
    'body: { scheduledOpenAt, reason, expectedAccountId: by },',
  ],
  // 규칙 보충 (#80, ADR-0101), new since and written the same way: 보충 요청 from its form, then
  // 승인 · 반려 · 철회 from their dialogs (each naming the request in its path)
  '../app/admin/markets/[id]/market-supplement-panel.tsx': [
    'body: { baseVersion, changes, reason, settlementImpact, expectedAccountId: by },',
  ],
  '../app/admin/markets/[id]/market-supplement-dialogs.tsx': [
    'body: { reason, expectedAccountId: by },',
    'body: { rejectReason, reason, expectedAccountId: by },',
    'body: { expectedAccountId: by },',
  ],
  // 거래 일시 중단 (#114, ADR-0102), new since and written the same way: 거래 일시 중단 and 재개·조기
  // 마감 요청 (naming the pause its dialog opened on) from their dialogs, then 승인 · 반려 · 철회
  // (each naming the request in its path)
  '../app/admin/markets/[id]/market-pause-dialogs.tsx': [
    'body: { reason, note, resultPublishedAt, expectedAccountId: by },',
    'body: { pauseId, path, reviewResult, reason, expectedAccountId: by },',
    'body: { reason, expectedAccountId: by },',
    'body: { expectedAccountId: by },',
  ],
  // 판정 (#152, ADR-0103), new since and written the same way: 판정 등록 from its form, then 승인 (with
  // the event-deadline confirmation) · 반려 · 철회 from their dialogs (each naming the registration
  // in its path)
  '../app/admin/markets/[id]/market-judgement-panel.tsx': [
    'body: { ...registration, expectedAccountId: by, noConflictConfirmed: true },',
  ],
  '../app/admin/markets/[id]/market-judgement-dialogs.tsx': [
    'expectedAccountId: by,\n            noConflictConfirmed: true,',
    'body: { reason, expectedAccountId: by },',
    'body: { expectedAccountId: by },',
  ],
  // 판정 지연 기록 (#142, ADR-0106), new since and written the same way: one admin's 지연 기록 등록
  // from its dialog, the 판정 panel's section holding it for the admin who opened it
  '../app/admin/markets/[id]/market-judgement-delay-dialogs.tsx': [
    "await api.POST('/api/v1/admin/markets/{id}/judgement-delays', {\n          params: { path: { id: market.id } },\n          body: { reason, nextReviewAt, expectedAccountId: by },",
  ],
  // 판정 이의 (#175, ADR-0104), new since and written the same way: 기각 · 수용 from their dialog
  // (each naming the dispute in its path), the block holding it for the admin who opened it
  '../app/admin/markets/[id]/market-dispute-dialogs.tsx': [
    "await api.POST('/api/v1/admin/markets/{id}/disputes/{disputeId}/dismiss', {\n            params: { path: { id: market.id, disputeId } },\n            body: { reason, expectedAccountId: by, noConflictConfirmed: true },",
    "await api.POST('/api/v1/admin/markets/{id}/disputes/{disputeId}/accept', {\n            params: { path: { id: market.id, disputeId } },\n            body: { reason, expectedAccountId: by, noConflictConfirmed: true },",
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
  // 카테고리 (#17, ADR-0093), new since and written the same way: 추가, 이름 바꾸기, 위로 · 아래로,
  // 숨기기 and 다시 보이기
  '../app/admin/categories/admin-categories.tsx': [
    'body: { ...toCreateCategoryFields(values, parent?.id ?? null), expectedAccountId: by },',
    'body: { nameKo, expectedAccountId: by },',
    'body: { parentId, ids, expectedAccountId: by },',
    "await api.POST('/api/v1/admin/categories/{id}/hide', {\n              params: { path: { id: String(id) } },\n              body: { expectedAccountId: by },",
    "await api.POST('/api/v1/admin/categories/{id}/show', {\n              params: { path: { id: String(id) } },\n              body: { expectedAccountId: by },",
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
  // Q-PG-8 ① (owner decision 2026-10-26 17:21 answer 4 «이 PR에서 더함»); 잔고 조정, the other half,
  // went with #116 (ADR-0109, below)
  '../app/admin/payments/admin-payments.tsx': [
    '{ id: payment.id, body: { reason: values.reason, expectedAccountId: operatorId } },',
  ],
};

describe('the admin the admin writes name (ADR-0092)', () => {
  it('pins all four monetary correction writes to the operator on screen', () => {
    const text = source('../app/admin/audit-failures/reconciliation-correction-dialogs.tsx');
    expect(text.match(/api\.POST\(/g)).toHaveLength(4);
    expect(text.match(/expectedAccountId: by/g)).toHaveLength(4);
    expect(text.match(/body: \{ expectedAccountId: by, reason: draft.reason \}/g)).toHaveLength(2);
  });
  it('is the admin of the `Me` the screen is drawn from, never the session’s', () => {
    for (const [file, sends] of Object.entries(SCREENS)) {
      const text = source(file);
      expect(text, file).toMatch(
        /import \{ (?:useHeldForOperator, )?useOperatorId \} from '@\/hooks\/use-operator';/,
      );
      expect(text, file).toContain('const operatorId = useOperatorId();');
      // Nothing on these screens reads the session's account; the session is only asked again.
      expect(text, file).not.toMatch(/useSession\b|session\.user|user\.id/);
      for (const send of sends) expect(text, `${file}: ${send}`).toContain(send);
    }
  });

  it('leaves 사용자 with no write: no admin adjusts a balance (#116, ADR-0109)', () => {
    // ADR-0107 결정 2 #73 7항: the adjustment is gone in both directions — the route, the form and
    // the type — so the screen only lists accounts, and names no admin.
    const users = source('../app/admin/users/admin-users.tsx');
    expect(users).not.toMatch(/api\.(?:POST|PUT|PATCH|DELETE)\(|useMutation|balance-adjust/);
    expect(users).not.toMatch(/AdjustForm|adjust-submit|admin-user-closed|useOperatorId/);
  });

  it('waits for `GET /me` before any of them can be pressed', () => {
    // A write before the admin on screen is known would name nobody; the API needs the field.
    // Since owner decision 2026-10-26 17:21 answer 1 the buttons that open a dialog held for the
    // admin and the fields of a form drawn for it wait too (the describe below).
    const waits: Readonly<Record<string, number>> = {
      '../app/admin/audit-failures/reconciliation-correction-dialogs.tsx': 3,
      // 확인함, and the button that opens its dialog
      '../app/admin/moderation/link-flags/admin-link-flags.tsx': 2,
      // 만들기, and the form's fields
      '../app/admin/markets/admin-markets.tsx': 2,
      // 저장 and its confirm, 연결, 해제's confirm; the button opening 해제, and the edit form's fields
      // (공개 went with #21, 마감 with #114, 판정 with #152)
      '../app/admin/markets/[id]/admin-market-detail.tsx': 6,
      // 검수 제출, and the buttons opening 승인, 반려, 예정 개장 시각 변경 and 초안으로 되돌리기 (#78)
      '../app/admin/markets/[id]/market-review-panel.tsx': 5,
      // the confirms of 승인, 반려, 초안으로 되돌리기 and 예정 개장 시각 변경
      '../app/admin/markets/[id]/market-review-dialogs.tsx': 4,
      // the buttons opening 보충 요청, 승인, 반려 and 철회, the form's fields and its 보충 요청 (#80)
      '../app/admin/markets/[id]/market-supplement-panel.tsx': 6,
      // the confirms of 승인, 반려 and 철회 (#80)
      '../app/admin/markets/[id]/market-supplement-dialogs.tsx': 3,
      // the buttons opening 거래 일시 중단 (and the 의미 변경 반려's offer of it), 재개·조기 마감 요청,
      // 승인, 반려 and 철회 (#114)
      '../app/admin/markets/[id]/market-pause-panel.tsx': 6,
      // the confirms of 거래 일시 중단, 재개·조기 마감 요청, 승인, 반려 and 철회 (#114)
      '../app/admin/markets/[id]/market-pause-dialogs.tsx': 5,
      // the buttons opening 판정 등록, 판정 정정 (#176), 승인, 반려 and 철회, the form's fields and its
      // 판정 등록 (#152)
      '../app/admin/markets/[id]/market-judgement-panel.tsx': 7,
      // the confirms of 승인, 반려 and 철회 (#152)
      '../app/admin/markets/[id]/market-judgement-dialogs.tsx': 3,
      // the button opening 지연 기록 등록 (#142)
      '../app/admin/markets/[id]/market-judgement-delay-panel.tsx': 1,
      // the confirm of 지연 기록 등록 (#142)
      '../app/admin/markets/[id]/market-judgement-delay-dialogs.tsx': 1,
      // the buttons opening 기각 and 수용 (#175), and an accepted one's 정정 등록 (#176)
      '../app/admin/markets/[id]/market-dispute-panel.tsx': 3,
      // the confirm of 기각 or 수용 (#175: one dialog, its kind's route)
      '../app/admin/markets/[id]/market-dispute-dialogs.tsx': 1,
      // 만들기, and the form's fields
      '../app/admin/themes/admin-themes.tsx': 2,
      // 공개, 비공개의 confirm, 저장, 넣기, 빼기의 confirm, 공지 쓰기·고치기, 보이기, 숨기기의 confirm;
      // the buttons opening 비공개, 빼기, 공지 고치기 and 숨기기, and the edit form's fields
      '../app/admin/themes/[id]/admin-theme-detail.tsx': 14,
      // 위로, 아래로, 숨기기의 confirm, 다시 보이기, 이름 바꾸기의 저장, 추가; the buttons opening
      // 이름 바꾸기, 숨기기 and 하위 카테고리 추가, and the fields of the rename and add forms
      '../app/admin/categories/admin-categories.tsx': 11,
      // 검토 시작, 채택·연결·반려의 confirm, 메모 저장; the fields of 채택, 연결, 반려 and the memo
      '../app/admin/proposals/[id]/admin-proposal-detail.tsx': 9,
      // 저장, and the button that opens the dialog
      '../app/admin/settings/admin-release-settings.tsx': 2,
      // 발급, 중지·재개, and the form's fields
      '../app/admin/coupons/admin-coupons.tsx': 3,
      // 추가, 판매 중지·재개, 삭제, and the form's fields
      '../app/admin/charge-packages/admin-charge-packages.tsx': 4,
      // 환불 (and 다시 시도) and its confirm
      '../app/admin/payments/admin-payments.tsx': 2,
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
      if (['/notices/', '/settings/', '/payments/'].some((dir) => file.includes(dir))) continue;
      expect(source(file), file).toContain('const sessionChanged = useSessionChanged();');
    }
    // The refund's hook asks it itself, and its toast says so (Q-PG-8 ①).
    expect(source('../hooks/use-admin-payments.ts')).toContain(
      'if (isForAnotherAccount(error)) {\n        void refetchSession();\n        return;\n      }',
    );
    expect(source('./payments.ts')).toContain(
      'if (isForAnotherAccount(error)) return { title: copy.sessionChanged };',
    );
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

describe('what an admin screen opened or typed is the admin on screen’s (owner decision 2026-10-26 17:21 answer 1)', () => {
  /**
   * The reverse order (ADR-0090 결정 4-2): `['me']` turns from A to B in place, before the session
   * does — a window-focus refetch of `GET /me` answered with B's cookie, a realtime resnapshot — so
   * SessionCacheGuard resets nothing, and a write naming the admin on screen names B with B's
   * cookie: what A picked and typed, taken as B's. The owner chose «적용함»: every screen ADR-0092
   * changed takes ADR-0091 결정 3·5-5's way — an open dialog is held for the admin who opened it
   * (`useHeldForOperator`) and closes with what was typed in it, and a form on the screen is drawn
   * again for each admin (`key`), its fields off until that admin is known (`OperatorFieldset`),
   * as the wallet's coupon field is keyed by its account. Pinned in the sources, as ADR-0091 pinned
   * its own (admin-accounts.test.ts); e2e admin-writes.spec.ts ('탭의 세션이 아직 …') drives one of
   * each per area.
   */
  const HELD: Readonly<Record<string, readonly string[]>> = {
    '../app/admin/audit-failures/admin-reconciliation-corrections.tsx': [
      'const [dialog, setDialog] = useHeldForOperator<CorrectionDialogTarget>();',
    ],
    '../app/admin/audit-failures/admin-reconciliation.tsx': [
      'const [dialog, setDialog] = useHeldForOperator<DialogState>();',
    ],
    // A related market's 해제 (마감 went with #114, 판정 with #152 — the 판정 panel's, below)
    '../app/admin/markets/[id]/admin-market-detail.tsx': [
      'const [unlinking, setUnlinking] = useHeldForOperator<AdminRelatedMarket>();',
    ],
    // 개설 검수's four dialogs (#78), with what was checked, picked and typed in them
    '../app/admin/markets/[id]/market-review-panel.tsx': [
      'const [dialog, setDialog] = useHeldForOperator<ReviewDialogKind>();',
    ],
    // 규칙 보충 (#80): the request form and the three dialogs, with what was typed and picked
    '../app/admin/markets/[id]/market-supplement-panel.tsx': [
      'const [action, setAction] = useHeldForOperator<SupplementAction>();',
    ],
    // 거래 일시 중단 (#114): its dialogs, with the reason, the note, the instant, the path and the
    // review result picked and typed
    '../app/admin/markets/[id]/market-pause-panel.tsx': [
      'const [action, setAction] = useHeldForOperator<PauseAction>();',
    ],
    // 판정 (#152): the registration form — a first judgement's or a correction's (#176) — and the
    // three dialogs, with the result, the source, the reasons, the links, the instant, the
    // description and a correction's reason picked and typed, and the approval's event-deadline
    // confirmation
    '../app/admin/markets/[id]/market-judgement-panel.tsx': [
      'const [action, setAction] = useHeldForOperator<JudgementAction>();',
    ],
    // 판정 이의 (#175): the 기각 or 수용 dialog, with the dispute it was opened on and the reason
    '../app/admin/markets/[id]/market-dispute-panel.tsx': [
      'const [action, setAction] = useHeldForOperator<DisputeAction>();',
    ],
    // 판정 지연 기록 (#142): the 지연 기록 등록 dialog, with the reason and the time typed
    '../app/admin/markets/[id]/market-judgement-delay-panel.tsx': [
      'const [action, setAction] = useHeldForOperator<JudgementDelayAction>();',
    ],
    // 비공개로 돌리기, a market's 빼기, the notice opened for editing and a notice's 숨기기
    '../app/admin/themes/[id]/admin-theme-detail.tsx': [
      "const [confirming, setConfirming] = useHeldForOperator<'unpublish'>();",
      'const [removing, setRemoving] = useHeldForOperator<AdminThemeMarket>();',
      'const [editing, setEditing] = useHeldForOperator<string>();',
      'const [hiding, setHiding] = useHeldForOperator<AdminThemeNotice>();',
    ],
    // 이름 바꾸기 (with the name typed), 숨기기's confirmation and 하위 카테고리 추가 (#17)
    '../app/admin/categories/admin-categories.tsx': [
      'const [renaming, setRenaming] = useHeldForOperator<number>();',
      'const [hiding, setHiding] = useHeldForOperator<AdminCategory>();',
      'const [addingTo, setAddingTo] = useHeldForOperator<number>();',
    ],
    // the change dialog, with its status and reason
    '../app/admin/settings/admin-release-settings.tsx': [
      'const [editing, setEditing] = useHeldForOperator<ReleaseSetting>();',
    ],
    // 확인함으로 표시, with its outcome and note
    '../app/admin/moderation/link-flags/admin-link-flags.tsx': [
      'const [marking, setMarking] = useHeldForOperator<true>();',
    ],
    // 환불 (or 다시 시도), with its reason (Q-PG-8 ①, answer 4)
    '../app/admin/payments/admin-payments.tsx': [
      'const [refunding, setRefunding] = useHeldForOperator<RefundAction>();',
    ],
  };

  /** Each form drawn for the admin on screen: where it is keyed, and how many fieldsets wait. */
  const KEYED: Readonly<Record<string, { keys: readonly string[]; fieldsets: number }>> = {
    '../app/admin/markets/admin-markets.tsx': {
      keys: ["<CreateMarketCard key={operatorId ?? ''} />"],
      fieldsets: 1,
    },
    // The edit form, and with it the open market's confirmation
    '../app/admin/markets/[id]/admin-market-detail.tsx': {
      keys: [
        "<EditMarketForm key={operatorId ?? ''} market={market} categories={categories.data} />",
      ],
      fieldsets: 1,
    },
    // 보충 요청's form (#80), with the reason and the 정산 영향 검토 typed in it
    '../app/admin/markets/[id]/market-supplement-panel.tsx': {
      keys: ["<SupplementRequestForm\n              key={operatorId ?? ''}\n"],
      fieldsets: 1,
    },
    // 판정 등록's form (#152), with everything picked and typed in it — and 판정 정정's (#176), the
    // same form drawn again when the action turns from one to the other
    '../app/admin/markets/[id]/market-judgement-panel.tsx': {
      keys: ["<JudgementRegisterForm\n              key={`${action}:${operatorId ?? ''}`}\n"],
      fieldsets: 1,
    },
    '../app/admin/themes/admin-themes.tsx': {
      keys: ["<CreateThemeCard key={operatorId ?? ''} />"],
      fieldsets: 1,
    },
    // The edit form and the new notice's form (its fieldset is NoticeForm's `submitDisabled`)
    '../app/admin/themes/[id]/admin-theme-detail.tsx': {
      keys: [
        "<EditThemeCard key={operatorId ?? ''} theme={data} />",
        '<NoticeForm\n            key={operatorId ?? \'\'}\n            testId="theme-notice-new"',
      ],
      fieldsets: 1,
    },
    // 상위 카테고리 추가 and each 하위 카테고리 추가 (#17); 이름 바꾸기 is held instead (HELD), and
    // its fieldset is the second
    '../app/admin/categories/admin-categories.tsx': {
      keys: [
        "<CreateCategoryForm key={operatorId ?? ''} parent={null} testId={topFormTestId} />",
        "<CreateCategoryForm\n                    key={operatorId ?? ''}\n                    parent={top}",
      ],
      fieldsets: 2,
    },
    // 채택, 반려 and 연결 — each with its confirmation — and the internal memo
    '../app/admin/proposals/[id]/admin-proposal-detail.tsx': {
      keys: [
        "<AdoptForm key={`adopt-${data.status}-${operatorId ?? ''}`} proposal={data} />",
        "<RejectForm key={`reject-${data.status}-${operatorId ?? ''}`} proposal={data} />",
        "<LinkMarketForm key={`link-${operatorId ?? ''}`} proposal={data} />",
        "<InternalMemoCard key={operatorId ?? ''} proposal={data} />",
      ],
      fieldsets: 4,
    },
    '../app/admin/coupons/admin-coupons.tsx': {
      keys: ["<CreateCouponCard key={operatorId ?? ''} />"],
      fieldsets: 1,
    },
    '../app/admin/charge-packages/admin-charge-packages.tsx': {
      keys: ["<CreatePackageCard key={operatorId ?? ''} />"],
      fieldsets: 1,
    },
  };

  it('holds every dialog for the admin who opened it', () => {
    for (const [file, holds] of Object.entries(HELD)) {
      const text = source(file);
      expect(text, file).toContain('useHeldForOperator, useOperatorId }');
      for (const hold of holds) expect(text, `${file}: ${hold}`).toContain(hold);
      expect(text.match(/= useHeldForOperator</g), file).toHaveLength(holds.length);
      // No dialog of these is opened in plain state any more.
      expect(text, file).not.toMatch(
        /useState<(?:'close' \| 'resolve'|'resolve'|AdminRelatedMarket|PauseAction|JudgementAction|AdminThemeMarket|AdminThemeNotice|ReleaseSetting|RefundAction) \| null>|const \[(?:confirming|marking), set\w+\] = useState\(false\)|const \[editing, setEditing\] = useState<string/,
      );
    }
    // The one-admin 판정 dialog went with #152 (ADR-0103): nothing on the detail opens it.
    const detail = source('../app/admin/markets/[id]/admin-market-detail.tsx');
    expect(detail).not.toContain('ResolveDialog');
    expect(detail).not.toContain("'/api/v1/admin/markets/{id}/resolve'");
    // So is each review dialog (#78), with its checklist, reason and time.
    expect(source('../app/admin/markets/[id]/market-review-panel.tsx')).toContain(
      '{dialog !== null && (\n        <ReviewDialog kind={dialog} market={market} onClose={() => setDialog(null)} />',
    );
    // And each supplement dialog (#80), and the request form only while held for its admin.
    const supplement = source('../app/admin/markets/[id]/market-supplement-panel.tsx');
    expect(supplement).toContain(
      "{action !== null && action !== 'request' && (\n        <SupplementDialog kind={action} market={market} onClose={close} />",
    );
    expect(supplement).toContain("action === 'request' ? (");
    // And each pause dialog (#114).
    expect(source('../app/admin/markets/[id]/market-pause-panel.tsx')).toContain(
      '{action !== null && (\n        <PauseDialog kind={action} market={market} readAt={readAt} onClose={close} />',
    );
    // And each judgement dialog (#152), and the registration form — a correction's too (#176) —
    // only while held for its admin.
    const judgement = source('../app/admin/markets/[id]/market-judgement-panel.tsx');
    expect(judgement).toContain(
      '{action !== null && !isFormAction(action) && (\n        <JudgementDialog kind={action} market={market} readAt={readAt} onClose={close} />',
    );
    expect(judgement).toContain('isFormAction(action) ? (');
    // And the 판정 이의 block's 기각 or 수용 dialog (#175), drawn in the judgement panel.
    expect(source('../app/admin/markets/[id]/market-dispute-panel.tsx')).toContain(
      '{action !== null && (\n        <DisputeDecisionDialog\n          action={action}\n          market={market}',
    );
    // And the 판정 지연 기록 section's dialog (#142), drawn in the judgement panel.
    expect(source('../app/admin/markets/[id]/market-judgement-delay-panel.tsx')).toContain(
      '{action !== null && (\n        <JudgementDelayDialog\n          market={market}',
    );
    expect(judgement).toContain(
      'delays={<MarketJudgementDelays market={market} readAt={readAt} />}',
    );
    // An accepted dispute's 정정 등록 opens the panel's correction form, held as the panel's (#176):
    // every action opens through `open`, which holds it (and notes what opened a form, for focus).
    expect(judgement).toContain(
      "<MarketDisputes\n            market={market}\n            formOpen={isFormAction(action)}\n            onCorrect={() => open('correct')}\n          />",
    );
    expect(judgement).toContain(
      'const open = (next: JudgementAction) => {\n    if (isFormAction(next)) refocus.opened();\n    setAction(next);\n  };',
    );
    expect(source('../app/admin/settings/admin-release-settings.tsx')).toContain(
      '{editing !== null && <ChangeDialog item={editing} onClose={() => setEditing(null)} />}',
    );
    expect(source('../app/admin/moderation/link-flags/admin-link-flags.tsx')).toContain(
      '{marking !== null && (',
    );
    // The refund dialog too, with the reason typed in it.
    expect(source('../app/admin/payments/admin-payments.tsx')).toContain(
      '{refunding !== null && (\n        <RefundDialog payment={payment} action={refunding} onClose={() => setRefunding(null)} />',
    );
  });

  it('draws every form again for each admin, its fields off until that admin is known', () => {
    for (const [file, { keys, fieldsets }] of Object.entries(KEYED)) {
      const text = source(file);
      for (const key of keys) expect(text, `${file}: ${key}`).toContain(key);
      expect(text, file).toContain(
        "import { OperatorFieldset } from '@/components/ui/operator-fieldset';",
      );
      expect(
        text.match(/<OperatorFieldset disabled=\{operatorId === undefined\}>/g) ?? [],
        file,
      ).toHaveLength(fieldsets);
    }
    // A theme notice's form, the new one and the one opened for editing, waits through
    // `submitDisabled` — `operatorId === undefined` at both.
    const theme = source('../app/admin/themes/[id]/admin-theme-detail.tsx');
    expect(theme).toContain('<OperatorFieldset disabled={submitDisabled}>');
    expect(theme.match(/submitDisabled=\{operatorId === undefined\}/g)).toHaveLength(2);
    // The fieldset is a native one: what it holds off is every control inside, the radio items'
    // hidden inputs too, not only the buttons.
    expect(source('../components/ui/operator-fieldset.tsx')).toContain(
      "export const OperatorFieldset = chakra('fieldset', {",
    );
  });

  it('offers to open a held dialog only once `GET /me` has said which admin is on screen', () => {
    // Nothing is held for nobody (`operatorHold`): a button pressed then would open nothing.
    const opens: Readonly<Record<string, readonly string[]>> = {
      '../app/admin/markets/[id]/admin-market-detail.tsx': [
        'disabled={operatorId === undefined}\n                      onClick={() => setUnlinking(row)}',
      ],
      '../app/admin/themes/[id]/admin-theme-detail.tsx': [
        "disabled={operatorId === undefined}\n            onClick={() => setConfirming('unpublish')}",
        'disabled={operatorId === undefined}\n                      onClick={() => setRemoving(row)}',
        'disabled={operatorId === undefined}\n                          onClick={() => setEditing(notice.id)}',
        'disabled={operatorId === undefined}\n                            onClick={() => setHiding(notice)}',
      ],
      '../app/admin/settings/admin-release-settings.tsx': [
        'disabled={operatorId === undefined}\n          onClick={onEdit}',
      ],
      '../app/admin/categories/admin-categories.tsx': [
        'disabled={operatorId === undefined}\n                  onClick={() => setAddingTo(top.id)}',
        'disabled={operatorId === undefined}\n            onClick={onRename}',
        'disabled={operatorId === undefined}\n              onClick={onHide}',
      ],
      '../app/admin/moderation/link-flags/admin-link-flags.tsx': [
        'disabled={operatorId === undefined}\n            onClick={() => setMarking(true)}',
      ],
      '../app/admin/payments/admin-payments.tsx': [
        'disabled={operatorId === undefined}\n            onClick={() => setRefunding(action)}',
      ],
      // The panel is drawn for the admin `MarketReviewPanel` passes in (`useOperatorId`).
      '../app/admin/markets/[id]/market-review-panel.tsx': [
        "disabled={operatorId === undefined || exclusion !== null}\n                    onClick={() => onOpen('approve')}",
        "disabled={operatorId === undefined || exclusion !== null}\n                    onClick={() => onOpen('reject')}",
        "disabled={operatorId === undefined}\n                  onClick={() => onOpen('reschedule')}",
        "disabled={operatorId === undefined}\n                onClick={() => onOpen('revert')}",
        '<ReviewPanelBody market={market} readAt={readAt} operatorId={operatorId} onOpen={setDialog} />',
      ],
      // The supplement panel likewise (#80): 승인 and 반려 off for the requester, 철회 its alone.
      '../app/admin/markets/[id]/market-supplement-panel.tsx': [
        "disabled={operatorId === undefined}\n                onClick={() => onOpen('request')}",
        "disabled={operatorId === undefined || requester !== false || !approvable}\n          onClick={() => onOpen('approve')}",
        "disabled={operatorId === undefined || requester !== false}\n          onClick={() => onOpen('reject')}",
        "disabled={operatorId === undefined}\n            onClick={() => onOpen('retract')}",
        '<SupplementPanelBody\n        market={market}\n        readAt={readAt}\n        operatorId={operatorId}\n        onOpen={setAction}',
      ],
      // The pause panel likewise (#114): 승인 and 반려 off for the requester, 철회 its alone.
      '../app/admin/markets/[id]/market-pause-panel.tsx': [
        "disabled={operatorId === undefined}\n          onClick={() => onOpen('offer')}",
        "disabled={operatorId === undefined}\n      onClick={() => onOpen('pause')}",
        "disabled={operatorId === undefined}\n        onClick={() => onOpen('request')}",
        "disabled={operatorId === undefined || requester !== false || !approvable}\n          onClick={() => onOpen('approve')}",
        "disabled={operatorId === undefined || requester !== false}\n          onClick={() => onOpen('reject')}",
        "disabled={operatorId === undefined}\n            onClick={() => onOpen('retract')}",
        '<PausePanelBody\n        market={market}\n        readAt={readAt}\n        operatorId={operatorId}\n        onOpen={setAction}',
      ],
      // The judgement panel likewise (#152): 판정 등록 off while the dispute window is undecided,
      // 판정 정정 (#176) for any admin, 승인 and 반려 off for the registrant, 철회 its alone.
      '../app/admin/markets/[id]/market-judgement-panel.tsx': [
        "disabled={operatorId === undefined || unavailable !== null}\n                  onClick={() => onOpen('register')}",
        "disabled={operatorId === undefined}\n                onClick={() => onOpen('correct')}",
        "disabled={operatorId === undefined || requester !== false || !approvable}\n          onClick={() => onOpen('approve')}",
        "disabled={operatorId === undefined || requester !== false}\n          onClick={() => onOpen('reject')}",
        "disabled={operatorId === undefined}\n            onClick={() => onOpen('retract')}",
        '<JudgementPanelBody\n        market={market}\n        readAt={readAt}\n        operatorId={operatorId}\n        onOpen={open}',
      ],
      // The 판정 지연 기록 section likewise (#142): 지연 기록 등록 for any admin while the market reads
      // 판정 지연 — the registrant of a waiting judgement included (#173 item 2).
      '../app/admin/markets/[id]/market-judgement-delay-panel.tsx': [
        "disabled={operatorId === undefined || unavailable !== null}\n            onClick={() => onOpen('record')}",
        '<JudgementDelaysBody\n        market={market}\n        readAt={readAt}\n        operatorId={operatorId}\n        onOpen={setAction}',
      ],
    };
    for (const [file, buttons] of Object.entries(opens)) {
      const text = source(file);
      for (const button of buttons) expect(text, `${file}: ${button}`).toContain(button);
    }
  });
});

describe('a notice’s form is drawn for the admin on screen, and what A typed is kept as A’s (owner decision 2026-10-26 17:21 answer 2)', () => {
  /**
   * The reverse order (ADR-0090 결정 4-2): `['me']` turns from A to B in place, before the session
   * does. A notice's write and edit forms are drawn for the admin on screen — keyed by it, with
   * what they send and were refused — so B never gets the form A typed into, its button on; and
   * A's form, going, keeps what A typed in this tab as A's draft for the hour, as the onboarding
   * gate's move keeps it (ADR-0077 decision 8-20), which A opening the screen again takes back:
   * «A의 것으로 1시간 보관». The keep and the store are driven in hooks/use-notices.test.ts and
   * lib/post-drafts.test.ts; e2e admin-writes.spec.ts drives the screen.
   */
  const forms = source('../app/admin/notices/notice-forms.tsx');

  it('draws the new notice’s form, its write and its refusal for each admin', () => {
    expect(forms).toContain(
      '{(accountId) => <NewNoticeForm key={accountId} accountId={accountId} />}',
    );
    // The write, its refusal and its move to the list are the form's, not the screen's.
    expect(forms).toContain(
      'function NewNoticeForm({ accountId }: { accountId: string }) {\n  const router = useRouter();\n  const create = useCreateNotice();\n  const [refusal, setRefusal] = useState<string | undefined>(undefined);',
    );
    expect(forms.match(/= useCreateNotice\(\);/g)).toHaveLength(1);
  });

  it('draws a notice’s edit form for each admin as well as each notice and opening', () => {
    expect(forms).toContain('key={`${notice.data.id}:${String(generation)}:${accountId}`}');
    // The save, its refusal and its conflict are the form's (EditForm's own state).
    expect(forms).toContain(
      'const update = useUpdateNotice();\n  // The notice as the form opened',
    );
  });

  it('keeps what both forms hold as their admin’s when another admin is drawn', () => {
    expect(forms.match(/\n\s+accountId=\{accountId\}\n\s+keepOnAccountTurn\n/g)).toHaveLength(2);
    // The form hands it to the hook that keeps it, and takes back and clears only its account's.
    const form = source('../components/post/post-form.tsx');
    expect(form).toContain('      key: draftKey,\n      accountId,\n      keepOnAccountTurn,\n');
    expect(form).toContain('readSessionPostDraft(draftKey, accountId)');
    expect(form.match(/clearSessionPostDraft\(kept\.key, kept\.accountId\);/g)).toHaveLength(2);
    // The hook keeps it as the form goes with a turn of the tab's account: `['me']` naming
    // another, or — `['me']` emptied by SessionCacheGuard's reset — the session naming another, or
    // the writer after `['me']` did (ADR-0092 결정 10, 8-36, 오너 결정 2026-10-26 21:00 답 1).
    const hook = source('../hooks/use-post-draft.ts');
    expect(hook).toContain('const accountTurned = goesWithAccountTurn(last.accountId, me?.id);');
    expect(hook).toContain('if (accountTurned && last.keepOnAccountTurn !== true) return false;');
  });
});
