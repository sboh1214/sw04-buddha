'use client';

import { Alert, Card, DataList, HStack, Skeleton, Stack, Table, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { copy } from '@/copy';
import { smsAsOf, smsCount, smsDayRows, smsServiceUsage } from '@/lib/admin-sms';
import { api, unwrap } from '@/lib/api';

const ADMIN_SMS_STATUS_KEY = ['admin', 'sms-status'] as const;

/** A count with what it means under it. */
function Item({
  label,
  hint,
  testId,
  children,
}: {
  label: string;
  hint: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue>
        <Stack gap="0.5">
          <Text fontWeight="semibold" fontVariantNumeric="tabular-nums" data-testid={testId}>
            {children}
          </Text>
          <Text fontSize="xs" color="fg.muted">
            {hint}
          </Text>
        </Stack>
      </DataList.ItemValue>
    </DataList.Item>
  );
}

/**
 * SMS 발송 현황 (#183, owner decision 2026-10-18, second round, ADR-0070): the counts of the
 * 본인확인 texts, read-only — the owner's answer to "how will we know the sends are going wrong"
 * is this screen rather than an alert. The last 24 hours are the window of the service's daily
 * limit: 보낸 문자 against it (the sends every limit counts, a text whose answer never came
 * included), 결과를 알 수 없음 (the provider's answer never came), 보내지 못함 (the provider
 * certainly refused: no limit counts it). Below, the same per Korean day for seven days, newest
 * first. No number, name, account or address reaches this screen: the API answers counts only.
 */
export function AdminSmsStatus() {
  const status = useQuery({
    queryKey: ADMIN_SMS_STATUS_KEY,
    queryFn: async () => unwrap(await api.GET('/api/v1/admin/sms/status')).data,
  });

  if (status.isPending) return <Skeleton height="48" />;
  if (status.isError) {
    return (
      <Alert.Root status="error" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{copy.errUnknown}</Alert.Description>
        </Alert.Content>
      </Alert.Root>
    );
  }
  const { asOf, last24Hours, days } = status.data;

  return (
    <Stack gap="4" data-testid="admin-sms">
      <Text color="fg.muted">{copy.adminSmsIntro}</Text>
      <Card.Root data-testid="admin-sms-last-24-hours">
        <Card.Header>
          <HStack justify="space-between" align="baseline" gap="3" flexWrap="wrap">
            <Text fontWeight="semibold">{copy.adminSmsLast24Hours}</Text>
            <Text fontSize="sm" color="fg.muted" data-testid="admin-sms-as-of">
              {smsAsOf(asOf)}
            </Text>
          </HStack>
        </Card.Header>
        <Card.Body>
          <DataList.Root orientation="vertical" size="sm" gap="4">
            <Item label={copy.adminSmsSent} hint={copy.adminSmsSentHint} testId="admin-sms-sent">
              {smsServiceUsage(last24Hours)}
            </Item>
            <Item
              label={copy.adminSmsUnknown}
              hint={copy.adminSmsUnknownHint}
              testId="admin-sms-unknown"
            >
              {smsCount(last24Hours.unknown)}
            </Item>
            <Item
              label={copy.adminSmsRefused}
              hint={copy.adminSmsRefusedHint}
              testId="admin-sms-refused"
            >
              {smsCount(last24Hours.refused)}
            </Item>
          </DataList.Root>
        </Card.Body>
      </Card.Root>
      <Card.Root data-testid="admin-sms-days">
        <Card.Header>
          <Text fontWeight="semibold">{copy.adminSmsDays}</Text>
        </Card.Header>
        <Card.Body>
          <Table.ScrollArea>
            <Table.Root size="sm">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{copy.adminSmsDate}</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">{copy.adminSmsSent}</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">{copy.adminSmsUnknown}</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">{copy.adminSmsRefused}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {smsDayRows(days).map((row) => (
                  <Table.Row key={row.date} data-testid={`admin-sms-day-${row.date}`}>
                    <Table.Cell whiteSpace="nowrap">{row.label}</Table.Cell>
                    <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">
                      {row.sent}
                    </Table.Cell>
                    <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">
                      {row.unknown}
                    </Table.Cell>
                    <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">
                      {row.refused}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Table.ScrollArea>
        </Card.Body>
      </Card.Root>
    </Stack>
  );
}
