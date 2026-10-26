'use client';

import {
  Alert,
  Badge,
  Box,
  Button,
  Dialog,
  Field,
  HStack,
  Heading,
  Input,
  Portal,
  RadioGroup,
  Skeleton,
  Stack,
  Switch,
  Text,
  Textarea,
} from '@chakra-ui/react';
import {
  RELEASE_SETTING_STATUSES,
  type ReleaseSettingStatus,
  releaseSettingStatusSchema,
} from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useId, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  useChangeReleaseSetting,
  useReleaseSettingChanges,
  useReleaseSettings,
} from '@/hooks/use-admin-release-settings';
import { useHeldForOperator, useOperatorId } from '@/hooks/use-operator';
import { nicknameShown } from '@/lib/account-closure';
import { type ReleaseSetting, type ReleaseSettingChange } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { readFailed } from '@/lib/query-client';
import {
  NO_VALUE,
  RELEASE_SETTING_STATUS_BADGE,
  RELEASE_SETTING_STATUS_HINT,
  type ReleaseSettingFormValues,
  formatReleaseSettingState,
  formatReleaseSettingValue,
  releaseSettingChangeRefusal,
  releaseSettingFormDefaults,
  releaseSettingFormSchema,
  releaseSettingFormUnchanged,
  releaseSettingSchemaHint,
  releaseSettingStatusLabel,
  releaseSettingValueInput,
  releaseSettingsView,
  toReleaseSettingChangeBody,
} from '@/lib/release-settings';

/**
 * 출시 설정 (#170, ADR-0055, docs/SETTINGS.md): every registered item with its unit, meaning,
 * value and status, the undecided-only view #149's launch check reads, a change with a required
 * reason, and the change log (who, when, before → after, why). The shipped registry is empty
 * until the issues that own the values register them, so the list says 등록된 항목이 없습니다.
 */
export function AdminReleaseSettings() {
  return (
    <Stack gap="8" data-testid="release-settings">
      <SettingsList />
      <ChangeLog />
    </Stack>
  );
}

function StatusBadge({ status, testId }: { status: ReleaseSettingStatus; testId?: string }) {
  const { palette, variant } = RELEASE_SETTING_STATUS_BADGE[status];
  return (
    <Badge colorPalette={palette} variant={variant} data-testid={testId}>
      {releaseSettingStatusLabel(status)}
    </Badge>
  );
}

/** What each status means, so 설계 제안 and 시험값 are never taken for an approved value. */
function StatusLegend() {
  return (
    <Stack as="dl" gap="1" fontSize="sm" data-testid="release-settings-legend">
      {RELEASE_SETTING_STATUSES.map((status) => (
        <HStack key={status} gap="2" align="baseline">
          <Box as="dt" flexShrink="0">
            <StatusBadge status={status} />
          </Box>
          <Text as="dd" color="fg.muted">
            {RELEASE_SETTING_STATUS_HINT[status]}
          </Text>
        </HStack>
      ))}
    </Stack>
  );
}

function SettingsList() {
  const settings = useReleaseSettings();
  const [undecidedOnly, setUndecidedOnly] = useState(false);
  // The item whose change dialog is open, held for the admin who opened it (`useHeldForOperator`,
  // ADR-0091 결정 3): once `['me']` turns from A to B in place, before the session does (ADR-0090
  // 결정 4-2), the dialog closes with the status picked and the reason typed for A, which would
  // otherwise be saved as B (ADR-0092, owner decision 2026-10-26 17:21 answer 1).
  const [editing, setEditing] = useHeldForOperator<ReleaseSetting>();
  const view =
    settings.data === undefined ? null : releaseSettingsView(settings.data, undecidedOnly);

  return (
    <Stack gap="4">
      <Heading as="h3" size="lg">
        {copy.adminReleaseSettings}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminReleaseSettingsIntro}
      </Text>
      <StatusLegend />
      <HStack justify="space-between" gap="3" flexWrap="wrap">
        <Switch.Root
          checked={undecidedOnly}
          onCheckedChange={(details) => setUndecidedOnly(details.checked)}
          colorPalette="brand"
          data-testid="release-settings-undecided-only"
        >
          <Switch.HiddenInput />
          <Switch.Control />
          <Switch.Label>{copy.adminReleaseSettingsUndecidedOnly}</Switch.Label>
        </Switch.Root>
        {view !== null && (
          <Text fontSize="sm" color="fg.muted" data-testid="release-settings-count">
            {view.count}
          </Text>
        )}
      </HStack>

      {settings.isPending ? (
        <Skeleton height="24" />
      ) : view === null ? (
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : view.empty !== null ? (
        <Text color="fg.muted" data-testid="release-settings-empty">
          {view.empty}
        </Text>
      ) : (
        <Stack gap="2">
          {view.rows.map((item) => (
            <SettingRow key={item.key} item={item} onEdit={() => setEditing(item)} />
          ))}
        </Stack>
      )}

      {editing !== null && <ChangeDialog item={editing} onClose={() => setEditing(null)} />}
    </Stack>
  );
}

/**
 * One item: its name and key, the status badge beside the name, what it controls, the value and
 * the unit as two labelled cells (never joined into one figure), and the last change. 변경 waits for
 * the admin on screen (`GET /me`): its dialog is held for that admin, and nothing is held for
 * nobody (`operatorHold`).
 */
function SettingRow({ item, onEdit }: { item: ReleaseSetting; onEdit: () => void }) {
  const operatorId = useOperatorId();
  return (
    <Stack
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      gap="2"
      data-testid={`release-setting-${item.key}`}
    >
      <HStack justify="space-between" align="start" gap="3" flexWrap="wrap">
        <Stack gap="0.5" minW="0">
          <HStack gap="2" flexWrap="wrap">
            <Text fontWeight="semibold">{item.label}</Text>
            <StatusBadge status={item.status} testId="release-setting-status" />
          </HStack>
          <Text fontSize="xs" fontFamily="mono" color="fg.muted" wordBreak="break-all">
            {item.key}
          </Text>
        </Stack>
        <Button
          size="xs"
          variant="outline"
          disabled={operatorId === undefined}
          onClick={onEdit}
          data-testid={`release-setting-edit-${item.key}`}
        >
          {copy.adminReleaseSettingEdit}
        </Button>
      </HStack>
      <Text fontSize="sm">{item.description}</Text>
      <HStack gap="6" flexWrap="wrap" fontSize="sm">
        <HStack gap="2" minW="0">
          <Text color="fg.muted">{copy.adminReleaseSettingValue}</Text>
          <Text fontWeight="medium" wordBreak="break-all" data-testid="release-setting-value">
            {formatReleaseSettingValue(item.value)}
          </Text>
        </HStack>
        <HStack gap="2">
          <Text color="fg.muted">{copy.adminReleaseSettingUnit}</Text>
          <Text>{item.unit ?? NO_VALUE}</Text>
        </HStack>
      </HStack>
      {item.updatedAt !== null && (
        <Text fontSize="xs" color="fg.muted">
          {copy.adminReleaseSettingLastChange} {formatKst(item.updatedAt)}
          {item.updatedBy !== null && ` · ${nicknameShown(item.updatedBy.nickname)}`}
        </Text>
      )}
    </Stack>
  );
}

/**
 * The change: status by radio, the value (typed as the item's shape asks, hidden while 미정 —
 * which drops it), and the required reason that goes into the record. 저장 is off while the
 * status and value are the item's own (`releaseSettingFormUnchanged`, owner decision: such a
 * change is refused), with 바뀐 내용이 없습니다 beside it. Pinned while the request runs, as the
 * admin confirmation dialogs are: the admin must see how the change ended. A refused reason or
 * value is shown under its field and the dialog stays; any other answer closes it over a
 * refreshed list (`releaseSettingChangeRefusal`). The change names the admin on screen
 * (`useOperatorId`, ADR-0092), so 저장 waits for `GET /me`; the cookie of another account is
 * refused and closes the dialog with `copy.sessionChanged`.
 */
function ChangeDialog({ item, onClose }: { item: ReleaseSetting; onClose: () => void }) {
  const change = useChangeReleaseSetting();
  const operatorId = useOperatorId();
  const schema = useMemo(() => releaseSettingFormSchema(item.valueSchema), [item.valueSchema]);
  const input = releaseSettingValueInput(item.valueSchema);
  const {
    control,
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ReleaseSettingFormValues>({
    resolver: zodResolver(schema),
    defaultValues: releaseSettingFormDefaults(item),
  });
  const status = useWatch({ control, name: 'status' });
  const valueText = useWatch({ control, name: 'value' });
  const unchanged = releaseSettingFormUnchanged({ status, value: valueText }, item);
  const unchangedId = useId();
  const loading = change.isPending;

  const submit = handleSubmit((values) => {
    if (operatorId === undefined) return;
    change.mutate(
      { key: item.key, body: toReleaseSettingChangeBody(values, item.valueSchema, operatorId) },
      {
        onSuccess: () => {
          toaster.create({ type: 'success', title: copy.adminReleaseSettingSaved });
          onClose();
        },
        onError: (error) => {
          const refusal = releaseSettingChangeRefusal(error);
          if ('field' in refusal) {
            setError(refusal.field, { message: refusal.message });
            return;
          }
          toaster.create({ type: refusal.tone, title: refusal.toast });
          if (!refusal.keepDialog) onClose();
        },
      },
    );
  });

  const valueLabel =
    item.unit === null
      ? copy.adminReleaseSettingValue
      : `${copy.adminReleaseSettingValue}(${item.unit})`;

  return (
    <Dialog.Root
      open
      onOpenChange={(details) => {
        if (!details.open && !loading) onClose();
      }}
      lazyMount
      unmountOnExit
      closeOnInteractOutside={!loading}
      closeOnEscape={!loading}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content data-testid="release-setting-dialog">
            <Dialog.Header>
              <Dialog.Title>{copy.adminReleaseSettingEditTitle}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="4">
                <Stack gap="1">
                  <Text fontWeight="medium">{item.label}</Text>
                  <Text fontSize="xs" fontFamily="mono" color="fg.muted" wordBreak="break-all">
                    {item.key}
                  </Text>
                  {/* Where the item stands now, badged as in the list. */}
                  <HStack gap="2" fontSize="sm" flexWrap="wrap" minW="0">
                    <StatusBadge status={item.status} />
                    {item.value !== null && (
                      <Text wordBreak="break-all">{formatReleaseSettingValue(item.value)}</Text>
                    )}
                  </HStack>
                </Stack>
                <Text fontSize="sm" color="fg.muted">
                  {copy.adminReleaseSettingApplyNotice}
                </Text>
                <Field.Root invalid={!!errors.status} required>
                  <Controller
                    name="status"
                    control={control}
                    render={({ field }) => (
                      // The group's accessible name is its own Label part (zag's radiogroup
                      // `aria-labelledby`), as in the 판정 dialog.
                      <RadioGroup.Root
                        name={field.name}
                        value={field.value}
                        onValueChange={(details) => {
                          const parsed = releaseSettingStatusSchema.safeParse(details.value);
                          if (parsed.success) field.onChange(parsed.data);
                        }}
                        colorPalette="brand"
                      >
                        <RadioGroup.Label fontWeight="medium" mb="1">
                          {copy.adminReleaseSettingStatus}
                        </RadioGroup.Label>
                        <HStack gap="4" flexWrap="wrap">
                          {RELEASE_SETTING_STATUSES.map((value) => (
                            <RadioGroup.Item
                              key={value}
                              value={value}
                              data-testid={`release-setting-status-${value}`}
                            >
                              <RadioGroup.ItemHiddenInput onBlur={field.onBlur} />
                              <RadioGroup.ItemIndicator />
                              <RadioGroup.ItemText>
                                {releaseSettingStatusLabel(value)}
                              </RadioGroup.ItemText>
                            </RadioGroup.Item>
                          ))}
                        </HStack>
                      </RadioGroup.Root>
                    )}
                  />
                  <Field.ErrorText>{errors.status?.message}</Field.ErrorText>
                </Field.Root>
                {status === 'undecided' ? (
                  <Text fontSize="sm" color="fg.muted" data-testid="release-setting-value-dropped">
                    {copy.adminReleaseSettingValueUndecided}
                  </Text>
                ) : (
                  // A string item's blank field is a value (""), which its schema takes or refuses.
                  <Field.Root invalid={!!errors.value} required={input.kind === 'json'}>
                    <Field.Label>{valueLabel}</Field.Label>
                    {input.multiline ? (
                      <Textarea
                        rows={4}
                        fontFamily="mono"
                        autoComplete="off"
                        data-testid="release-setting-value-input"
                        {...register('value')}
                      />
                    ) : (
                      <Input
                        fontFamily={input.kind === 'json' ? 'mono' : undefined}
                        autoComplete="off"
                        data-testid="release-setting-value-input"
                        {...register('value')}
                      />
                    )}
                    {errors.value ? (
                      <Field.ErrorText>{errors.value.message}</Field.ErrorText>
                    ) : (
                      <Field.HelperText>
                        {input.kind === 'text'
                          ? copy.adminReleaseSettingValueTextHint
                          : copy.adminReleaseSettingValueJsonHint}
                      </Field.HelperText>
                    )}
                    <Text fontSize="xs" fontFamily="mono" color="fg.muted" wordBreak="break-all">
                      {copy.adminReleaseSettingValueFormat}:{' '}
                      {releaseSettingSchemaHint(item.valueSchema)}
                    </Text>
                  </Field.Root>
                )}
                <Field.Root invalid={!!errors.reason} required>
                  <Field.Label>{copy.adminReleaseSettingReason}</Field.Label>
                  <Textarea rows={3} data-testid="release-setting-reason" {...register('reason')} />
                  {errors.reason ? (
                    <Field.ErrorText>{errors.reason.message}</Field.ErrorText>
                  ) : (
                    <Field.HelperText>{copy.adminReleaseSettingReasonHint}</Field.HelperText>
                  )}
                </Field.Root>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer flexWrap="wrap">
              {unchanged && (
                <Text
                  fontSize="sm"
                  color="fg.muted"
                  me="auto"
                  id={unchangedId}
                  data-testid="release-setting-unchanged"
                >
                  {copy.adminReleaseSettingUnchanged}
                </Text>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={onClose}
                data-testid="release-setting-cancel"
              >
                {copy.cancel}
              </Button>
              <Button
                size="sm"
                loading={loading}
                disabled={unchanged || operatorId === undefined}
                aria-describedby={unchanged ? unchangedId : undefined}
                onClick={() => void submit()}
                data-testid="release-setting-submit"
              >
                {copy.adminReleaseSettingSubmit}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** Every change of every item, newest first: item, time, before → after, reason and admin. */
function ChangeLog() {
  const changes = useReleaseSettingChanges();
  const rows = changes.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Stack gap="3" data-testid="release-setting-changes">
      <Heading as="h3" size="lg">
        {copy.adminReleaseSettingChanges}
      </Heading>
      {changes.isPending ? (
        <Skeleton height="24" />
      ) : readFailed(changes) ? (
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : rows.length === 0 ? (
        <Text color="fg.muted" data-testid="release-setting-changes-empty">
          {copy.adminReleaseSettingChangesEmpty}
        </Text>
      ) : (
        <Stack gap="2">
          {rows.map((entry) => (
            <ChangeRow key={entry.id} entry={entry} />
          ))}
          {changes.hasNextPage && (
            <>
              <LoadMoreFailed
                list={changes}
                message={copy.errUnknown}
                data-testid="release-setting-changes-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={changes.isFetchingNextPage}
                onClick={() => void changes.fetchNextPage()}
                data-testid="release-setting-changes-more"
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/** One record. A key no longer registered keeps its history, named 등록되지 않은 항목. */
function ChangeRow({ entry }: { entry: ReleaseSettingChange }) {
  return (
    <Stack
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      gap="1"
      data-testid={`release-setting-change-${entry.id}`}
    >
      <HStack justify="space-between" gap="3" flexWrap="wrap">
        <HStack gap="2" flexWrap="wrap" minW="0">
          <Text fontWeight="semibold">{entry.label ?? copy.adminReleaseSettingUnregistered}</Text>
          <Text fontSize="xs" fontFamily="mono" color="fg.muted" wordBreak="break-all">
            {entry.key}
          </Text>
        </HStack>
        <Text fontSize="sm" color="fg.muted">
          {formatKst(entry.createdAt)}
        </Text>
      </HStack>
      <Text fontSize="sm" wordBreak="break-all" data-testid="release-setting-change-diff">
        {formatReleaseSettingState(entry.before)} → {formatReleaseSettingState(entry.after)}
      </Text>
      <Text fontSize="sm" wordBreak="break-word">
        <Text as="span" color="fg.muted">
          {copy.adminReleaseSettingChangeReason}
        </Text>{' '}
        {entry.reason}
      </Text>
      <Text fontSize="xs" color="fg.muted">
        {copy.adminReleaseSettingChangeActor} {nicknameShown(entry.actor.nickname)}
      </Text>
    </Stack>
  );
}
