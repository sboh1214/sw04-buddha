'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  HStack,
  Input,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { CATEGORY_NAME_MAX, CATEGORY_SLUG_MAX } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { OperatorFieldset } from '@/components/ui/operator-fieldset';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  applyAdminCategories,
  refreshAdminCategories,
  useAdminCategories,
} from '@/hooks/use-admin-categories';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import {
  type CategoryFormValues,
  type CategoryRenameValues,
  EMPTY_CATEGORY_FORM,
  type MoveDirection,
  adminCategoryState,
  categoryFormError,
  categoryFormSchema,
  categoryRenameFormSchema,
  categoryWriteErrorMessage,
  formatAdminCategoryMeta,
  groupAdminCategories,
  movedOrder,
  siblingIds,
  toCreateCategoryFields,
  toRenameCategoryFields,
} from '@/lib/admin-categories';
import { type AdminCategory, api, unwrap } from '@/lib/api';
import { RefreshFailedNotice } from '../markets/[id]/admin-market-detail';

/**
 * 카테고리 관리 (#17, ADR-0093 decision 2 #172 item 1 and decision 3's #17 rows): the two-level
 * tree, hidden rows too — each top-level category followed by its sub-categories, with its slug and
 * the markets filed under it. Per row: 이름 바꾸기 in place, 위로 · 아래로 within its sibling group
 * (the whole group's ids, hidden ones included, go to `PUT /admin/categories/order`), 숨기기 after a
 * confirmation and 다시 보이기; 상위 카테고리 추가 above the list and 하위 카테고리 추가 under each
 * shown top-level category. Nothing is deleted, the slug is fixed once made, and no category moves
 * to another parent (#17 implementation choices 1, 2 and 4). Every change is recorded by the API
 * with the admin and the time, and asks no reason.
 *
 * Every write names the admin on screen (`useOperatorId`, ADR-0092), so it waits for `GET /me`; the
 * cookie of another account is refused (`copy.sessionChanged`) and the session asked again
 * (`useSessionChanged`). The forms are drawn for that admin (keyed by it, their fields in an
 * `OperatorFieldset`), and what was opened — a rename, a hide's confirmation, a sub-category's
 * form — is held for the admin who opened it (`useHeldForOperator`), so `['me']` turning from A
 * to B in place drops it (owner decision 2026-10-26 17:21 answer 1). A write that succeeds marks
 * the admin list and the public `['categories']` (`applyAdminCategories`), so the header, the
 * sidebar and the pickers follow; one refused because the tree moved meanwhile reads both again.
 */
export function AdminCategories() {
  const categories = useAdminCategories();
  // The admin on screen: 상위 카테고리 추가 is drawn again for each (ADR-0092 answer 1).
  const operatorId = useOperatorId();
  return (
    <Stack gap="4">
      <Stack gap="1" data-testid="admin-categories-hint">
        <Text fontSize="sm" color="fg.muted">
          {copy.adminCategoriesHint}
        </Text>
        <Text fontSize="sm" color="fg.muted">
          {copy.adminCategoriesHintKeep}
        </Text>
      </Stack>
      <Card.Root>
        <Card.Header>
          <Text fontWeight="semibold">{copy.adminCategoryCreateTop}</Text>
        </Card.Header>
        <Card.Body>
          <CreateCategoryForm key={operatorId ?? ''} parent={null} testId={topFormTestId} />
        </Card.Body>
      </Card.Root>
      {categories.isRefetchError && (
        <RefreshFailedNotice
          testId="admin-categories-stale"
          onRetry={() => void categories.refetch()}
        />
      )}
      {categories.isPending ? (
        <Skeleton height="24" />
      ) : categories.isLoadingError ? (
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : categories.data.length === 0 ? (
        <Text color="fg.muted" data-testid="admin-categories-empty">
          {copy.adminCategoriesEmpty}
        </Text>
      ) : (
        <CategoryTree rows={categories.data} />
      )}
    </Stack>
  );
}

/**
 * The tree and the writes on its rows. One reorder at a time: while one is on its way every 위로 ·
 * 아래로 waits, so the next move is computed from the order the answer put on screen.
 */
function CategoryTree({ rows }: { rows: AdminCategory[] }) {
  const queryClient = useQueryClient();
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();
  const tree = useMemo(() => groupAdminCategories(rows), [rows]);
  const [renaming, setRenaming] = useHeldForOperator<number>();
  const [hiding, setHiding] = useHeldForOperator<AdminCategory>();
  const [addingTo, setAddingTo] = useHeldForOperator<number>();

  const onRefused = (error: unknown) => {
    // The cookie of another account: the session is asked again and its reset reads everything.
    if (!sessionChanged(error)) void refreshAdminCategories(queryClient);
    toaster.create({ type: 'error', title: categoryWriteErrorMessage(error) });
  };

  const reorder = useMutation({
    mutationFn: async ({
      parentId,
      ids,
      by,
    }: {
      parentId: number | null;
      ids: number[];
      by: string;
    }) =>
      unwrap(
        await api.PUT('/api/v1/admin/categories/order', {
          body: { parentId, ids, expectedAccountId: by },
        }),
      ).data,
    onSuccess: async (fresh) => {
      toaster.create({ type: 'success', title: copy.adminCategoryMoved });
      await applyAdminCategories(queryClient, fresh);
    },
    onError: onRefused,
  });

  const visibility = useMutation({
    mutationFn: async ({ id, to, by }: { id: number; to: 'hide' | 'show'; by: string }) =>
      unwrap(
        to === 'hide'
          ? await api.POST('/api/v1/admin/categories/{id}/hide', {
              params: { path: { id: String(id) } },
              body: { expectedAccountId: by },
            })
          : await api.POST('/api/v1/admin/categories/{id}/show', {
              params: { path: { id: String(id) } },
              body: { expectedAccountId: by },
            }),
      ).data,
    onSuccess: async (fresh, { to }) => {
      toaster.create({
        type: 'success',
        title: to === 'hide' ? copy.adminCategoryHidden : copy.adminCategoryShown,
      });
      setHiding(null);
      await applyAdminCategories(queryClient, [fresh]);
    },
    onError: (error) => {
      setHiding(null);
      onRefused(error);
    },
  });

  /** 위로 · 아래로: the whole sibling group, hidden ones too, in its new order. */
  const move = (category: AdminCategory, direction: MoveDirection) => {
    if (operatorId === undefined) return;
    const ids = movedOrder(siblingIds(rows, category.parentId), category.id, direction);
    if (ids !== undefined) reorder.mutate({ parentId: category.parentId, ids, by: operatorId });
  };

  const rowProps = (
    category: AdminCategory,
    index: number,
    count: number,
    parent?: AdminCategory,
  ) => ({
    category,
    parent,
    canMoveUp: index > 0,
    canMoveDown: index < count - 1,
    moving: reorder.isPending,
    showing: visibility.isPending && visibility.variables.id === category.id,
    renaming: renaming === category.id,
    onMove: (direction: MoveDirection) => move(category, direction),
    onRename: () => setRenaming(category.id),
    onRenameDone: () => setRenaming(null),
    onHide: () => setHiding(category),
    onShow: () => {
      if (operatorId !== undefined)
        visibility.mutate({ id: category.id, to: 'show', by: operatorId });
    },
  });

  return (
    <Stack gap="3" data-testid="admin-categories-list">
      {tree.map((node, index) => {
        const top = node.category;
        return (
          <Stack
            key={top.id}
            gap="3"
            borderWidth="1px"
            borderRadius="l2"
            p="3"
            data-testid={`admin-category-group-${top.slug}`}
          >
            <CategoryRow {...rowProps(top, index, tree.length)} />
            {node.children.length > 0 && (
              <Stack
                gap="3"
                ps="3"
                borderStartWidth="2px"
                data-testid={`admin-category-children-${top.slug}`}
              >
                {node.children.map((child, childIndex) => (
                  <CategoryRow
                    key={child.id}
                    {...rowProps(child, childIndex, node.children.length, top)}
                  />
                ))}
              </Stack>
            )}
            {/* 하위 카테고리 추가: under a shown top-level category only (a hidden parent takes none,
                CATEGORY_REFUSALS.parentInactive). */}
            {top.isActive &&
              (addingTo === top.id ? (
                <Stack
                  gap="3"
                  borderTopWidth="1px"
                  pt="3"
                  data-testid={`admin-category-child-panel-${top.slug}`}
                >
                  <Text fontWeight="medium" fontSize="sm">
                    {copy.adminCategoryCreateChild}
                  </Text>
                  {node.children.length === 0 && (
                    <Text fontSize="sm" color="fg.muted">
                      {copy.adminCategoryChildHint}
                    </Text>
                  )}
                  <CreateCategoryForm
                    key={operatorId ?? ''}
                    parent={top}
                    testId={(part) => `category-create-${part}-${top.slug}`}
                    onClose={() => setAddingTo(null)}
                  />
                </Stack>
              ) : (
                <Button
                  size="xs"
                  variant="ghost"
                  alignSelf="flex-start"
                  disabled={operatorId === undefined}
                  onClick={() => setAddingTo(top.id)}
                  data-testid={`admin-category-add-child-${top.slug}`}
                >
                  + {copy.adminCategoryCreateChild}
                </Button>
              ))}
          </Stack>
        );
      })}
      <ConfirmDialog
        testId="category-hide-dialog"
        open={hiding !== null}
        onClose={() => setHiding(null)}
        title={copy.adminCategoryHideTitle}
        confirmLabel={copy.adminCategoryHide}
        loading={visibility.isPending}
        confirmDisabled={operatorId === undefined}
        onConfirm={() => {
          if (hiding && operatorId !== undefined) {
            visibility.mutate({ id: hiding.id, to: 'hide', by: operatorId });
          }
        }}
      >
        <Stack gap="2">
          <Text fontWeight="medium">{hiding?.nameKo}</Text>
          <Text>{copy.adminCategoryHideBody}</Text>
          {hiding?.parentId === null && <Text>{copy.adminCategoryHideTopBody}</Text>}
        </Stack>
      </ConfirmDialog>
    </Stack>
  );
}

/**
 * One category: its name with 숨김 (its own flag off) or 상위 숨김 (a sub-category out with its
 * hidden parent), its slug and market count, and its buttons — or, while 이름 바꾸기 is open, the
 * rename form in its place. The buttons are a group named by the category, so a screen reader says
 * which 위로 it is.
 */
function CategoryRow({
  category,
  parent,
  canMoveUp,
  canMoveDown,
  moving,
  showing,
  renaming,
  onMove,
  onRename,
  onRenameDone,
  onHide,
  onShow,
}: {
  category: AdminCategory;
  /** The top-level category of a sub-category; `undefined` for a top-level one. */
  parent?: AdminCategory;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** A reorder is on its way: every move waits for its answer. */
  moving: boolean;
  /** This row's 다시 보이기 is on its way. */
  showing: boolean;
  renaming: boolean;
  onMove: (direction: MoveDirection) => void;
  onRename: () => void;
  onRenameDone: () => void;
  onHide: () => void;
  onShow: () => void;
}) {
  const operatorId = useOperatorId();
  const state = adminCategoryState(category, parent);
  const slug = category.slug;
  return (
    <Stack gap="2" minW="0" data-testid={`admin-category-row-${slug}`}>
      <Stack gap="0.5" minW="0">
        <HStack gap="2" flexWrap="wrap">
          <Text
            fontWeight={parent === undefined ? 'semibold' : 'medium'}
            color={state === 'shown' ? 'fg' : 'fg.muted'}
            wordBreak="break-word"
            data-testid={`admin-category-name-${slug}`}
          >
            {category.nameKo}
          </Text>
          {state === 'hidden' && (
            <Badge variant="subtle" data-testid={`admin-category-hidden-${slug}`}>
              {copy.adminCategoryHiddenTag}
            </Badge>
          )}
          {state === 'hiddenByParent' && (
            <Badge variant="subtle" data-testid={`admin-category-parent-hidden-${slug}`}>
              {copy.adminCategoryHiddenByParentTag}
            </Badge>
          )}
        </HStack>
        <Text fontSize="xs" color="fg.muted" fontFamily="mono" wordBreak="break-all">
          {formatAdminCategoryMeta(category)}
        </Text>
      </Stack>
      {renaming ? (
        <RenameCategoryForm category={category} onDone={onRenameDone} />
      ) : (
        <HStack gap="2" flexWrap="wrap" role="group" aria-label={category.nameKo}>
          <Button
            size="xs"
            variant="outline"
            disabled={!canMoveUp || moving || operatorId === undefined}
            onClick={() => onMove('up')}
            data-testid={`admin-category-up-${slug}`}
          >
            ↑ {copy.adminCategoryMoveUp}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!canMoveDown || moving || operatorId === undefined}
            onClick={() => onMove('down')}
            data-testid={`admin-category-down-${slug}`}
          >
            ↓ {copy.adminCategoryMoveDown}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={operatorId === undefined}
            onClick={onRename}
            data-testid={`admin-category-rename-open-${slug}`}
          >
            {copy.adminCategoryRename}
          </Button>
          {category.isActive ? (
            <Button
              size="xs"
              variant="outline"
              disabled={operatorId === undefined}
              onClick={onHide}
              data-testid={`admin-category-hide-${slug}`}
            >
              {copy.adminCategoryHide}
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              loading={showing}
              disabled={operatorId === undefined}
              onClick={onShow}
              data-testid={`admin-category-show-${slug}`}
            >
              {copy.adminCategoryShow}
            </Button>
          )}
        </HStack>
      )}
    </Stack>
  );
}

/**
 * 이름 바꾸기, in the row's place: the name alone (the slug never changes). The same name again is
 * no request — the API would change nothing and record nothing — and closes the form. A name a
 * sibling has (hidden ones too) is refused on the field. Its fields wait for the admin on screen.
 */
function RenameCategoryForm({ category, onDone }: { category: AdminCategory; onDone: () => void }) {
  const queryClient = useQueryClient();
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CategoryRenameValues>({
    resolver: zodResolver(categoryRenameFormSchema),
    defaultValues: { nameKo: category.nameKo },
  });

  const rename = useMutation({
    mutationFn: async ({ nameKo, by }: { nameKo: string; by: string }) =>
      unwrap(
        await api.PATCH('/api/v1/admin/categories/{id}', {
          params: { path: { id: String(category.id) } },
          body: { nameKo, expectedAccountId: by },
        }),
      ).data,
    onSuccess: async (fresh) => {
      toaster.create({ type: 'success', title: copy.adminCategoryRenamed });
      onDone();
      await applyAdminCategories(queryClient, [fresh]);
    },
    onError: (error) => {
      if (!sessionChanged(error)) void refreshAdminCategories(queryClient);
      const fieldError = categoryFormError(error);
      if (fieldError?.field === 'nameKo') {
        setError('nameKo', { message: fieldError.message });
        return;
      }
      toaster.create({ type: 'error', title: categoryWriteErrorMessage(error) });
    },
  });

  const submit = handleSubmit(async (values) => {
    const fields = toRenameCategoryFields(values, category);
    if (fields === undefined) {
      onDone();
      return;
    }
    if (operatorId === undefined) return;
    // A refusal is reported by onError.
    await rename.mutateAsync({ ...fields, by: operatorId }).catch(() => undefined);
  });

  const testId = (part: string) => `admin-category-rename-${part}-${category.slug}`;
  return (
    <form onSubmit={(event) => void submit(event)} noValidate data-testid={testId('form')}>
      <OperatorFieldset disabled={operatorId === undefined}>
        <Stack gap="2">
          <Field.Root invalid={!!errors.nameKo} required>
            <Field.Label>{copy.adminCategoryName}</Field.Label>
            <Input
              size="sm"
              autoComplete="off"
              maxLength={CATEGORY_NAME_MAX}
              data-testid={testId('name')}
              {...register('nameKo')}
            />
            <Field.ErrorText>{errors.nameKo?.message}</Field.ErrorText>
          </Field.Root>
          <HStack gap="2">
            <Button
              type="submit"
              size="xs"
              loading={isSubmitting}
              disabled={operatorId === undefined}
              data-testid={testId('save')}
            >
              {copy.save}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={isSubmitting}
              onClick={onDone}
              data-testid={testId('cancel')}
            >
              {copy.cancel}
            </Button>
          </HStack>
        </Stack>
      </OperatorFieldset>
    </form>
  );
}

/** The parts of an add form that carry a test id. */
type CreateFormPart = 'form' | 'slug' | 'name' | 'submit' | 'close';

/**
 * 상위 카테고리 추가's test ids, `category-create-top-<part>`. A sub-category's form puts the part
 * before its parent's slug (`category-create-<part>-<slug>`), as every row's test id puts its kind
 * before the slug: a slug may hold hyphens, so an id ending in a part could be another slug's.
 */
const topFormTestId = (part: CreateFormPart) => `category-create-top-${part}`;

/**
 * 상위 카테고리 추가 (`parent` null) or 하위 카테고리 추가 under a shown top-level one: the slug —
 * lower-case letters, digits and hyphens, fixed once made — and the name. The new category goes
 * last among its siblings. A slug any category has or a name a sibling has (hidden ones too) is
 * refused on its field; a parent hidden meanwhile is the toast's. A made category empties the form,
 * which stays open for the next; `onClose` adds 닫기 (the sub-category form's). Drawn for the admin
 * on screen by its caller's key, its fields waiting for that admin (`OperatorFieldset`).
 */
function CreateCategoryForm({
  parent,
  testId,
  onClose,
}: {
  parent: AdminCategory | null;
  /** Each part's test id: the form's, its two inputs' and its buttons'. */
  testId: (part: CreateFormPart) => string;
  onClose?: () => void;
}) {
  const queryClient = useQueryClient();
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CategoryFormValues>({
    resolver: zodResolver(categoryFormSchema),
    defaultValues: EMPTY_CATEGORY_FORM,
  });

  const create = useMutation({
    mutationFn: async ({ values, by }: { values: CategoryFormValues; by: string }) =>
      unwrap(
        await api.POST('/api/v1/admin/categories', {
          body: { ...toCreateCategoryFields(values, parent?.id ?? null), expectedAccountId: by },
        }),
      ).data,
    onSuccess: async (fresh) => {
      toaster.create({
        type: 'success',
        title: copy.adminCategoryCreated,
        description: fresh.nameKo,
      });
      reset(EMPTY_CATEGORY_FORM);
      await applyAdminCategories(queryClient, [fresh]);
    },
    onError: (error) => {
      if (!sessionChanged(error)) void refreshAdminCategories(queryClient);
      // A taken or malformed slug and a taken or malformed name land on their field; the rest is
      // the toast.
      const fieldError = categoryFormError(error);
      if (fieldError) {
        setError(fieldError.field, { message: fieldError.message });
        return;
      }
      toaster.create({ type: 'error', title: categoryWriteErrorMessage(error) });
    },
  });

  const submit = handleSubmit(async (values) => {
    if (operatorId === undefined) return;
    // A refusal is reported by onError.
    await create.mutateAsync({ values, by: operatorId }).catch(() => undefined);
  });

  return (
    <form onSubmit={(event) => void submit(event)} noValidate data-testid={testId('form')}>
      <OperatorFieldset disabled={operatorId === undefined}>
        <Stack gap="3">
          <Field.Root invalid={!!errors.slug} required>
            <Field.Label>{copy.adminCategorySlug}</Field.Label>
            <Input
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={CATEGORY_SLUG_MAX}
              data-testid={testId('slug')}
              {...register('slug')}
            />
            <Field.HelperText>{copy.adminCategorySlugHint}</Field.HelperText>
            <Field.ErrorText>{errors.slug?.message}</Field.ErrorText>
          </Field.Root>
          <Field.Root invalid={!!errors.nameKo} required>
            <Field.Label>{copy.adminCategoryName}</Field.Label>
            <Input
              autoComplete="off"
              maxLength={CATEGORY_NAME_MAX}
              data-testid={testId('name')}
              {...register('nameKo')}
            />
            <Field.ErrorText>{errors.nameKo?.message}</Field.ErrorText>
          </Field.Root>
          <HStack gap="2">
            <Button
              type="submit"
              size="sm"
              loading={isSubmitting}
              disabled={operatorId === undefined}
              data-testid={testId('submit')}
            >
              {copy.adminCategoryCreate}
            </Button>
            {onClose && (
              <Button
                size="sm"
                variant="ghost"
                disabled={isSubmitting}
                onClick={onClose}
                data-testid={testId('close')}
              >
                {copy.close}
              </Button>
            )}
          </HStack>
        </Stack>
      </OperatorFieldset>
    </form>
  );
}
