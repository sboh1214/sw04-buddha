import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0092: the admin writes the server did not check before — 반복 링크 '확인함', 시장 (만들기·고치기·
 * 공개·마감·판정·관련 시장), 테마 (and its markets and notices), 운영 공지 (쓰기·수정·고정·고정 해제),
 * 시장 제안 처리, 출시 설정, 쿠폰, 충전 상품, and since the owner closed Q-PG-8 ① («이 PR에서 더함»)
 * 잔고 조정 and 환불 — name the admin on screen (`expectedAccountId`), which the API now compares
 * with the cookie's account. In the render between the session naming B and
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
  // Q-PG-8 ① (owner decision 2026-10-26 17:21 answer 4 «이 PR에서 더함»)
  '../app/admin/users/admin-users.tsx': [
    'body: { amountCoin: values.amountCoin, memo: values.memo, expectedAccountId: by },',
  ],
  '../app/admin/payments/admin-payments.tsx': [
    '{ id: payment.id, body: { reason: values.reason, expectedAccountId: operatorId } },',
  ],
};

/**
 * The screens whose `user.id` is a listed account's, never the session's: 사용자 — each card is one
 * account, its moderation page and its adjustment's target.
 */
const LISTS_ACCOUNTS: ReadonlySet<string> = new Set(['../app/admin/users/admin-users.tsx']);

describe('the admin the admin writes name (ADR-0092)', () => {
  it('is the admin of the `Me` the screen is drawn from, never the session’s', () => {
    for (const [file, sends] of Object.entries(SCREENS)) {
      const text = source(file);
      expect(text, file).toMatch(
        /import \{ (?:useHeldForOperator, )?useOperatorId \} from '@\/hooks\/use-operator';/,
      );
      expect(text, file).toContain('const operatorId = useOperatorId();');
      // Nothing on these screens reads the session's account; the session is only asked again.
      expect(text, file).not.toMatch(
        LISTS_ACCOUNTS.has(file)
          ? /useSession\b|session\.user/
          : /useSession\b|session\.user|user\.id/,
      );
      for (const send of sends) expect(text, `${file}: ${send}`).toContain(send);
    }
  });

  it('waits for `GET /me` before any of them can be pressed', () => {
    // A write before the admin on screen is known would name nobody; the API needs the field.
    // Since owner decision 2026-10-26 17:21 answer 1 the buttons that open a dialog held for the
    // admin and the fields of a form drawn for it wait too (the describe below).
    const waits: Readonly<Record<string, number>> = {
      // 확인함, and the button that opens its dialog
      '../app/admin/moderation/link-flags/admin-link-flags.tsx': 2,
      // 만들기, and the form's fields
      '../app/admin/markets/admin-markets.tsx': 2,
      // 공개, 마감's confirm, 판정's confirm, 저장 and its confirm, 연결, 해제's confirm; the buttons
      // opening 마감, 판정 and 해제, and the edit form's fields
      '../app/admin/markets/[id]/admin-market-detail.tsx': 11,
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
      // 조정, and the form's fields
      '../app/admin/users/admin-users.tsx': 2,
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
    // 마감 and 판정 (with its result and note), and a related market's 해제
    '../app/admin/markets/[id]/admin-market-detail.tsx': [
      "const [confirm, setConfirm] = useHeldForOperator<'close' | 'resolve'>();",
      'const [unlinking, setUnlinking] = useHeldForOperator<AdminRelatedMarket>();',
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
    // Each account's 잔고 조정 (Q-PG-8 ①, answer 4)
    '../app/admin/users/admin-users.tsx': {
      keys: ["<AdjustForm key={operatorId ?? ''} userId={user.id} />"],
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
        /useState<(?:'close' \| 'resolve'|AdminRelatedMarket|AdminThemeMarket|AdminThemeNotice|ReleaseSetting|RefundAction) \| null>|const \[(?:confirming|marking), set\w+\] = useState\(false\)|const \[editing, setEditing\] = useState<string/,
      );
    }
    // The 판정 dialog is mounted only while held, so its result and note go with it.
    expect(source('../app/admin/markets/[id]/admin-market-detail.tsx')).toContain(
      "{confirm === 'resolve' && <ResolveDialog market={market} onClose={closeDialog} />}",
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
        "disabled={operatorId === undefined}\n          onClick={() => setConfirm('close')}",
        "disabled={operatorId === undefined}\n          onClick={() => setConfirm('resolve')}",
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
