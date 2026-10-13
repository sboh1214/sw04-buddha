'use client';

import {
  Alert,
  Badge,
  Button,
  Dialog,
  Field,
  HStack,
  Heading,
  Input,
  Portal,
  Skeleton,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  useAdminGrantCandidates,
  useAdminRoleChanges,
  useAdmins,
  useGrantAdmin,
  useRevokeAdmin,
} from '@/hooks/use-admin-accounts';
import { useSignOut } from '@/hooks/use-sign-out';
import {
  ADMIN_ROLE_CHANGE_PALETTE,
  type AdminRoleReasonValues,
  adminCountLabel,
  adminRoleChangeLabel,
  adminRoleChangeRefusal,
  adminRoleChangeTarget,
  adminRoleReasonFormSchema,
  formatAdminGrant,
  grantSearchRows,
} from '@/lib/admin-accounts';
import { type AdminAccount, type AdminRoleChange, type AdminUser } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { useSession } from '@/lib/use-session';

/**
 * 운영자 계정 (#171, ADR-0056): who holds the admin role, a grant to an account found by email or
 * nickname, a revoke, both with a required reason, and the record of both (who, whom, when,
 * why). One admin role and no other admin's approval for either (owner decision 2026-10-13);
 * the rules the server enforces — the grant conditions, at least two admins left, a revoked
 * account signed out everywhere — are stated up front and again in a refusal.
 */
export function AdminAccounts() {
  return (
    <Stack gap="8" data-testid="admin-accounts">
      <AdminList />
      <GrantSearch />
      <ChangeLog />
    </Stack>
  );
}

/** A grant or a revoke waiting for its reason. */
interface PendingRoleChange {
  kind: 'grant' | 'revoke';
  account: Pick<AdminAccount, 'id' | 'nickname' | 'email'>;
  /** The signed-in admin's own account (a revoke only). */
  self: boolean;
}

function AdminList() {
  const admins = useAdmins();
  const { data: session } = useSession();
  const selfId = session?.user.id;
  const [pending, setPending] = useState<PendingRoleChange | null>(null);

  return (
    <Stack gap="4">
      <HStack justify="space-between" align="baseline" gap="3" flexWrap="wrap">
        <Heading as="h3" size="lg">
          {copy.adminAccounts}
        </Heading>
        {admins.data !== undefined && (
          <Text fontSize="sm" color="fg.muted" data-testid="admin-accounts-count">
            {adminCountLabel(admins.data.length)}
          </Text>
        )}
      </HStack>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminAccountsIntro}
      </Text>
      <Stack as="ul" gap="1" fontSize="sm" ps="5" listStyleType="disc">
        <li>{copy.adminAccountsGrantRule}</li>
        <li>{copy.adminAccountsRevokeRule}</li>
        <li>{copy.adminAccountsRevokeEffect}</li>
      </Stack>

      {admins.isPending ? (
        <Skeleton height="24" />
      ) : admins.isError ? (
        <ErrorAlert />
      ) : (
        <Stack gap="2" data-testid="admin-accounts-list">
          {admins.data.map((account) => {
            const self = account.id === selfId;
            return (
              <AdminRow
                key={account.id}
                account={account}
                self={self}
                onRevoke={() => setPending({ kind: 'revoke', account, self })}
              />
            );
          })}
        </Stack>
      )}

      {pending !== null && <RoleChangeDialog change={pending} onClose={() => setPending(null)} />}
    </Stack>
  );
}

/** One admin: nickname (나 for the signed-in one), email, the grant on record, and 회수. */
function AdminRow({
  account,
  self,
  onRevoke,
}: {
  account: AdminAccount;
  self: boolean;
  onRevoke: () => void;
}) {
  return (
    <Stack borderWidth="1px" borderRadius="l2" p="3" gap="1" data-testid="admin-account-row">
      <HStack justify="space-between" align="start" gap="3" flexWrap="wrap">
        <Stack gap="0.5" minW="0">
          <HStack gap="2" flexWrap="wrap">
            <Text fontWeight="semibold">{account.nickname}</Text>
            {self && (
              <Badge colorPalette="gray" variant="subtle" data-testid="admin-account-self">
                {copy.adminAccountsSelf}
              </Badge>
            )}
          </HStack>
          <Text fontSize="sm" color="fg.muted" wordBreak="break-all">
            {account.email}
          </Text>
        </Stack>
        <Button
          size="xs"
          variant="outline"
          colorPalette="red"
          onClick={onRevoke}
          data-testid="admin-account-revoke"
        >
          {copy.adminAccountsRevoke}
        </Button>
      </HStack>
      <Text fontSize="xs" color="fg.muted" data-testid="admin-account-granted">
        {formatAdminGrant(account)}
      </Text>
    </Stack>
  );
}

/**
 * The grant: the 사용자 search (email or nickname), each match with its role — an admin is
 * badged, everyone else offered 부여. Whether the account may become one (verified email, real
 * name and phone) is the server's to say, and the dialog shows its answer. While a new term
 * loads, the previous term's matches stay dimmed with no 부여 (`grantSearchRows`).
 */
function GrantSearch() {
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const candidates = useAdminGrantCandidates(term);
  const [pending, setPending] = useState<PendingRoleChange | null>(null);
  const { rows, stale } = grantSearchRows(
    term,
    candidates.data?.pages,
    candidates.isPlaceholderData,
  );

  return (
    <Stack gap="3" data-testid="admin-grant">
      <Heading as="h3" size="lg">
        {copy.adminAccountsGrantTitle}
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        {copy.adminAccountsGrantIntro}
      </Text>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setTerm(query.trim());
        }}
      >
        <HStack gap="2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy.adminUserSearch}
            aria-label={copy.adminUserSearch}
            autoComplete="off"
            data-testid="admin-grant-search"
          />
          <Button type="submit" flexShrink="0" data-testid="admin-grant-search-submit">
            {copy.adminSearch}
          </Button>
        </HStack>
      </form>

      {term === '' ? null : candidates.isPending ? (
        <Skeleton height="16" />
      ) : candidates.isError ? (
        <ErrorAlert />
      ) : rows.length === 0 ? (
        stale ? (
          <Skeleton height="16" />
        ) : (
          <Text color="fg.muted">{copy.adminNoUsers}</Text>
        )
      ) : (
        <Stack
          gap="2"
          aria-busy={stale}
          opacity={stale ? 0.5 : undefined}
          data-testid="admin-grant-results"
        >
          {rows.map((user) => (
            <CandidateRow
              key={user.id}
              user={user}
              disabled={stale}
              onGrant={() => setPending({ kind: 'grant', account: user, self: false })}
            />
          ))}
          {!stale && candidates.hasNextPage && (
            <Button
              alignSelf="center"
              size="sm"
              variant="ghost"
              loading={candidates.isFetchingNextPage}
              onClick={() => void candidates.fetchNextPage()}
              data-testid="admin-grant-more"
            >
              {copy.loadMore}
            </Button>
          )}
        </Stack>
      )}

      {pending !== null && <RoleChangeDialog change={pending} onClose={() => setPending(null)} />}
    </Stack>
  );
}

function CandidateRow({
  user,
  disabled,
  onGrant,
}: {
  user: AdminUser;
  /** Another search's match, on screen while the submitted term loads. */
  disabled: boolean;
  onGrant: () => void;
}) {
  return (
    <HStack
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      justify="space-between"
      align="start"
      gap="3"
      flexWrap="wrap"
      data-testid="admin-grant-candidate"
    >
      <Stack gap="0.5" minW="0">
        <HStack gap="2" flexWrap="wrap">
          <Text fontWeight="semibold">{user.nickname}</Text>
          {user.role === 'admin' && (
            <Badge colorPalette="brand" variant="subtle" data-testid="admin-grant-candidate-admin">
              {copy.adminTitle}
            </Badge>
          )}
        </HStack>
        <Text fontSize="sm" color="fg.muted" wordBreak="break-all">
          {user.email}
        </Text>
      </Stack>
      {user.role !== 'admin' && (
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={onGrant}
          data-testid="admin-grant-open"
        >
          {copy.adminAccountsGrant}
        </Button>
      )}
    </HStack>
  );
}

/**
 * The grant or the revoke, with its required reason. Pinned while the request runs, as the other
 * admin dialogs are. A refused reason goes under the field; a refusal by the rules (a missing
 * contact, fewer than two admins left, …) is explained inside the dialog, which stays; any other
 * answer is a toast that closes it (`adminRoleChangeRefusal`). A revoke of one's own role ends
 * as 로그아웃 does (`useSignOut`): the server has deleted every session of the account already, and
 * signing out drops the cookie, tells the other tabs, empties the cache and goes home.
 */
function RoleChangeDialog({ change, onClose }: { change: PendingRoleChange; onClose: () => void }) {
  const grant = useGrantAdmin();
  const revoke = useRevokeAdmin();
  const signOut = useSignOut();
  const [refusal, setRefusal] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<AdminRoleReasonValues>({
    resolver: zodResolver(adminRoleReasonFormSchema),
    defaultValues: { reason: '' },
  });
  const loading = grant.isPending || revoke.isPending;
  const isGrant = change.kind === 'grant';

  const onError = (error: unknown) => {
    const outcome = adminRoleChangeRefusal(error);
    if ('field' in outcome) {
      setError('reason', { message: outcome.message });
      return;
    }
    if ('alert' in outcome) {
      setRefusal(outcome.alert);
      return;
    }
    toaster.create({ type: 'error', title: outcome.toast });
    if (!outcome.keepDialog) onClose();
  };

  const submit = handleSubmit(({ reason }) => {
    setRefusal(null);
    const userId = change.account.id;
    if (isGrant) {
      grant.mutate(
        { userId, reason },
        {
          onSuccess: () => {
            toaster.create({ type: 'success', title: copy.adminAccountsGrantDone });
            onClose();
          },
          onError,
        },
      );
      return;
    }
    revoke.mutate(
      { userId, reason, self: change.self },
      {
        onSuccess: () => {
          if (change.self) {
            void signOut();
            return;
          }
          toaster.create({ type: 'success', title: copy.adminAccountsRevokeDone });
          onClose();
        },
        onError,
      },
    );
  });

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
          <Dialog.Content data-testid="admin-role-dialog">
            <Dialog.Header>
              <Dialog.Title>
                {isGrant ? copy.adminAccountsGrantDialogTitle : copy.adminAccountsRevokeDialogTitle}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="4">
                <Stack gap="0.5">
                  <Text fontWeight="medium">{change.account.nickname}</Text>
                  <Text fontSize="sm" color="fg.muted" wordBreak="break-all">
                    {change.account.email}
                  </Text>
                </Stack>
                <Text fontSize="sm" color="fg.muted">
                  {isGrant ? copy.adminAccountsGrantNotice : copy.adminAccountsRevokeNotice}
                </Text>
                {change.self && (
                  <Alert.Root status="warning">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Description>{copy.adminAccountsRevokeSelfNotice}</Alert.Description>
                    </Alert.Content>
                  </Alert.Root>
                )}
                {refusal !== null && (
                  <Alert.Root status="error" role="alert" data-testid="admin-role-refusal">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Description>{refusal}</Alert.Description>
                    </Alert.Content>
                  </Alert.Root>
                )}
                <Field.Root invalid={!!errors.reason} required>
                  <Field.Label>{copy.adminAccountsReason}</Field.Label>
                  <Textarea rows={3} data-testid="admin-role-reason" {...register('reason')} />
                  {errors.reason ? (
                    <Field.ErrorText>{errors.reason.message}</Field.ErrorText>
                  ) : (
                    <Field.HelperText>{copy.adminAccountsReasonHint}</Field.HelperText>
                  )}
                </Field.Root>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={onClose}
                data-testid="admin-role-cancel"
              >
                {copy.cancel}
              </Button>
              <Button
                size="sm"
                colorPalette={isGrant ? undefined : 'red'}
                loading={loading}
                onClick={() => void submit()}
                data-testid="admin-role-submit"
              >
                {isGrant ? copy.adminAccountsGrant : copy.adminAccountsRevoke}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** Every grant and revoke, newest first: kind, account, time, reason and the admin who did it. */
function ChangeLog() {
  const changes = useAdminRoleChanges();
  const rows = changes.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Stack gap="3" data-testid="admin-role-changes">
      <Heading as="h3" size="lg">
        {copy.adminAccountsChanges}
      </Heading>
      {changes.isPending ? (
        <Skeleton height="24" />
      ) : changes.isError ? (
        <ErrorAlert />
      ) : rows.length === 0 ? (
        <Text color="fg.muted" data-testid="admin-role-changes-empty">
          {copy.adminAccountsChangesEmpty}
        </Text>
      ) : (
        <Stack gap="2">
          {rows.map((entry) => (
            <ChangeRow key={entry.id} entry={entry} />
          ))}
          {changes.hasNextPage && (
            <Button
              alignSelf="center"
              size="sm"
              variant="ghost"
              loading={changes.isFetchingNextPage}
              onClick={() => void changes.fetchNextPage()}
              data-testid="admin-role-changes-more"
            >
              {copy.loadMore}
            </Button>
          )}
        </Stack>
      )}
    </Stack>
  );
}

function ChangeRow({ entry }: { entry: AdminRoleChange }) {
  return (
    <Stack borderWidth="1px" borderRadius="l2" p="3" gap="1" data-testid="admin-role-change">
      <HStack justify="space-between" gap="3" flexWrap="wrap">
        <HStack gap="2" flexWrap="wrap" minW="0">
          <Badge
            colorPalette={ADMIN_ROLE_CHANGE_PALETTE[entry.type]}
            variant="subtle"
            data-testid="admin-role-change-type"
          >
            {adminRoleChangeLabel(entry.type)}
          </Badge>
          <Text fontWeight="semibold">{adminRoleChangeTarget(entry)}</Text>
          {entry.target.email !== null && (
            <Text fontSize="sm" color="fg.muted" wordBreak="break-all">
              {entry.target.email}
            </Text>
          )}
        </HStack>
        <Text fontSize="sm" color="fg.muted">
          {formatKst(entry.createdAt)}
        </Text>
      </HStack>
      <Text fontSize="sm" wordBreak="break-word" data-testid="admin-role-change-reason">
        <Text as="span" color="fg.muted">
          {copy.adminAccountsChangeReason}
        </Text>{' '}
        {entry.reason}
      </Text>
      <Text fontSize="xs" color="fg.muted" data-testid="admin-role-change-actor">
        {copy.adminAccountsChangeActor} {entry.actor.nickname}
      </Text>
    </Stack>
  );
}

function ErrorAlert() {
  return (
    <Alert.Root status="error" role="alert">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{copy.errUnknown}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}
