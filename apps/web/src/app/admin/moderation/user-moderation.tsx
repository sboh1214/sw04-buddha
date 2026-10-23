'use client';

import {
  Box,
  Button,
  HStack,
  Heading,
  Image,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { isAutoNickname } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useState } from 'react';
import { copy } from '@/copy';
import { useAdminProfileModeration, useAdminUserModeration } from '@/hooks/use-admin-moderation';
import { type AdminUserModeration, isApiError } from '@/lib/api';
import {
  ADMIN_REPORTS_PATH,
  concernsOperator,
  countText,
  pendingReportIds,
} from '@/lib/moderation';
import { profilePath } from '@/lib/profile';
import {
  ActionRows,
  Block,
  type DialogSpec,
  Line,
  LoadFailedNotice,
  ModerationDialog,
  OwnNotice,
  ReportRows,
  RequestRows,
  type SubjectOption,
  UserName,
  accountRestrictDialog,
  dismissDialog,
  restrictDialog,
  useOperatorId,
} from './moderation-parts';

/**
 * A member's moderation page (#50, ADR-0081; ADR-0069 decision 3 #37-10, decision 4 #50): the
 * public profile as it is now — nickname, 소개 and image (at its operator address) — the reports on
 * the profile with their reporters, and every action the member received, with what a profile
 * action took away (kept for operators for the retention period, never restored). The actions,
 * with a report or without one: 경고 (about the profile or about nothing in particular), the
 * nickname back to an auto nickname, the 소개 emptied, the image removed (each offered only while
 * there is something to take away), and 신고 기각 of the profile's pending reports. None on the
 * operator's own account (decision 4 #50). And 작성 제한 (#185, ADR-0082 — decision 4 #185
 * «운영자가 사용자를 골라 직접 걸 수 있다»): a term and a reason, about the profile (its pending
 * reports resolved) or nothing in particular, as a warning; its 조기 해제 and 감경 in the list.
 * And the request of 계정 제한 (#139, ADR-0085 — directly on the member, the brief's «admin user
 * detail»): the owner's eight reasons with a required explanation and a term, about the profile or
 * nothing in particular, in force once another admin approves it — the member's requests waiting
 * for a decision are listed here with 승인 and 거절 for an admin who did not ask (ADR-0056 decision
 * 1-7), and each standing account restriction's 감경, 조기 해제 and 취소 are requests too.
 */
export function UserModeration({ userId }: { userId: string }) {
  return <MemberModeration query={useAdminUserModeration(userId)} />;
}

/**
 * The same page reached from a public profile's '운영' link, which knows the profile's public id
 * only (owner decision 2026-10-21): read by it, then the same view and actions.
 */
export function ProfileModeration({ publicId }: { publicId: string }) {
  return <MemberModeration query={useAdminProfileModeration(publicId)} />;
}

function MemberModeration({ query }: { query: ReturnType<typeof useAdminUserModeration> }) {
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  return (
    <Stack gap="5" data-testid="admin-user-moderation">
      <ChakraLink asChild alignSelf="flex-start" fontSize="sm" color="fg.muted">
        <NextLink href={ADMIN_REPORTS_PATH}>{copy.adminReportQueue}</NextLink>
      </ChakraLink>
      {query.isPending ? (
        <Skeleton height="48" />
      ) : query.isError ? (
        <LoadFailedNotice
          notFound={isApiError(query.error, 'NOT_FOUND')}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <UserView member={query.data} onOpen={setDialog} />
      )}
      {dialog !== null && <ModerationDialog spec={dialog} onClose={() => setDialog(null)} />}
    </Stack>
  );
}

/** A profile item's dialog: the reason the member reads, the item kept for operators. */
function profileItemDialog(
  kind: 'nickname-reset' | 'bio-clear' | 'image-remove',
  userId: string,
): DialogSpec {
  const titles = {
    'nickname-reset': [
      copy.adminModerationNicknameResetTitle,
      copy.adminModerationNicknameResetDone,
    ],
    'bio-clear': [copy.adminModerationBioClearTitle, copy.adminModerationBioCleared],
    'image-remove': [copy.adminModerationImageRemoveTitle, copy.adminModerationImageRemoved],
  } as const;
  const [title, success] = titles[kind];
  return {
    kind: 'action',
    title,
    body:
      kind === 'nickname-reset'
        ? `${copy.adminModerationProfileItemBody} ${copy.adminModerationNicknameResetNote}`
        : copy.adminModerationProfileItemBody,
    success,
    testId: `moderation-${kind}-dialog`,
    build: ({ reason, note, expectedAccountId }) => ({
      kind,
      userId,
      body: { reason, note, expectedAccountId },
    }),
  };
}

function UserView({
  member,
  onOpen,
}: {
  member: AdminUserModeration;
  onOpen: (spec: DialogSpec) => void;
}) {
  const own = concernsOperator(member.user.id, useOperatorId());
  const pendingProfileReports = pendingReportIds(member.reports).length > 0;
  // About the profile first while its reports wait, so the warning resolves them by default.
  const profileSubject: SubjectOption = {
    value: 'profile',
    label: copy.adminModerationWarnSubjectProfile,
    subject: { type: 'profile' },
  };
  const noSubject: SubjectOption = {
    value: 'none',
    label: copy.adminModerationWarnSubjectNone,
    subject: null,
  };
  const subjects = pendingProfileReports
    ? [profileSubject, noSubject]
    : [noSubject, profileSubject];
  const warn: DialogSpec = {
    kind: 'action',
    title: copy.adminModerationWarnTitle,
    body: copy.adminModerationWarnBody,
    success: copy.adminModerationWarned,
    testId: 'moderation-warn-dialog',
    subjects,
    build: ({ reason, note, subject, expectedAccountId }) => ({
      kind: 'warn',
      userId: member.user.id,
      body: { reason, note, subject, expectedAccountId },
    }),
  };

  return (
    <Stack gap="5">
      <HStack gap="2" flexWrap="wrap" align="baseline">
        <Heading as="h3" size="lg" data-testid="moderation-user-nickname">
          <UserName user={member.user} link={false} />
        </Heading>
        {/* A member who closed the account (#140) has no public profile: its address answers as
            for no account (#37-16), so there is nothing to open. */}
        {member.user.nickname !== null && (
          <ChakraLink asChild fontSize="sm" color="brand.fg">
            <NextLink href={profilePath(member.user.publicId) as Route}>
              {copy.adminModerationOpenPublic}
            </NextLink>
          </ChakraLink>
        )}
      </HStack>

      {own === true && <OwnNotice />}
      {own === false && (
        <HStack gap="2" flexWrap="wrap" data-testid="moderation-action-bar">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpen(warn)}
            data-testid="moderation-warn"
          >
            {copy.adminModerationWarn}
          </Button>
          <Button
            size="sm"
            variant="outline"
            colorPalette="no"
            onClick={() => onOpen(restrictDialog(member.user, subjects))}
            data-testid="moderation-restrict"
          >
            {copy.adminModerationRestrict}
          </Button>
          <Button
            size="sm"
            variant="outline"
            colorPalette="no"
            onClick={() => onOpen(accountRestrictDialog(member.user, subjects))}
            data-testid="moderation-account-restrict"
          >
            {copy.adminModerationAccountRestrict}
          </Button>
          {member.user.nickname !== null && !isAutoNickname(member.user.nickname) && (
            <Button
              size="sm"
              variant="outline"
              colorPalette="no"
              onClick={() => onOpen(profileItemDialog('nickname-reset', member.user.id))}
              data-testid="moderation-nickname-reset"
            >
              {copy.adminModerationNicknameReset}
            </Button>
          )}
          {member.bio !== null && (
            <Button
              size="sm"
              variant="outline"
              colorPalette="no"
              onClick={() => onOpen(profileItemDialog('bio-clear', member.user.id))}
              data-testid="moderation-bio-clear"
            >
              {copy.adminModerationBioClear}
            </Button>
          )}
          {member.imageUrl !== null && (
            <Button
              size="sm"
              variant="outline"
              colorPalette="no"
              onClick={() => onOpen(profileItemDialog('image-remove', member.user.id))}
              data-testid="moderation-image-remove"
            >
              {copy.adminModerationImageRemove}
            </Button>
          )}
          {pendingProfileReports && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onOpen(dismissDialog(member.reports))}
              data-testid="moderation-dismiss"
            >
              {copy.adminModerationDismiss}
            </Button>
          )}
        </HStack>
      )}

      <Block title={copy.reportTargetProfile} testId="moderation-profile">
        <Stack gap="2">
          <Line label={copy.adminModerationBio} testId="moderation-profile-bio">
            {member.bio ?? copy.adminModerationNone}
          </Line>
          <Line label={copy.adminModerationImage} testId="moderation-profile-image">
            {member.imageUrl === null ? (
              copy.adminModerationNone
            ) : (
              <Box as="span" display="inline-block">
                <Image src={member.imageUrl} alt="" boxSize="16" borderRadius="full" />
              </Box>
            )}
          </Line>
        </Stack>
      </Block>
      <Block
        title={copy.adminModerationReports}
        testId="moderation-reports-block"
        aside={
          <Text fontSize="sm" color="fg.muted" data-testid="moderation-reporter-count">
            {countText(copy.adminReporterCount, member.reporterCount, copy.adminCountUnitPeople)}
          </Text>
        }
      >
        <ReportRows reports={member.reports} />
      </Block>
      <Block title={copy.adminAccountRequestsMember} testId="moderation-account-requests">
        <RequestRows
          requests={member.accountRestrictionRequests}
          onOpen={onOpen}
          empty={copy.adminAccountRequestsMemberEmpty}
        />
      </Block>
      <Block title={copy.adminModerationMemberActions} testId="moderation-author-actions">
        <ActionRows actions={member.actions} anchors onOpen={onOpen} />
      </Block>
    </Stack>
  );
}
