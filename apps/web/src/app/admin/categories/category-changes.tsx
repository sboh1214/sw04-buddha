'use client';

import { Table, Text } from '@chakra-ui/react';
import { OperationsQueue } from '@/app/admin/operations/operations-queue';
import { copy } from '@/copy';
import { useAdminCategoryChanges } from '@/hooks/use-admin-categories';
import { nicknameShown } from '@/lib/account-closure';
import {
  CATEGORY_CHANGE_LABEL,
  categoryChangeValues,
  categoryRefText,
} from '@/lib/admin-categories';
import { formatKst } from '@/lib/datetime';

const ROW = 'category-change';

/**
 * 변경 기록 (#145 part 2, ADR-0164; 145-10 "카테고리 화면에 보임", ADR-0096 결과 5): under the tree,
 * every category record newest first — 추가·이름 바꾸기·순서 바꾸기·숨기기·다시 보이기 — with its time,
 * the category (by its current name; 상위 카테고리 for a reorder of the top level), the admin and the
 * values before and after, 20 a page with 더 보기, in the 운영 대기열 frame. A category write marks it
 * with the tree (`ADMIN_CATEGORY_CHANGES_KEY`), so the write's record comes first. Read-only: the
 * records ask no reason and no other admin's approval (#172 item 1). The market-bound category and
 * tag changes are each market's 작업 이력's (145-10).
 */
export function CategoryChanges() {
  const list = useAdminCategoryChanges();
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <OperationsQueue
      prefix="category-changes"
      title={copy.adminCategoryChanges}
      intro={copy.adminCategoryChangesHint}
      empty={copy.adminCategoryChangesEmpty}
      list={list}
      count={rows.length}
      header={
        <Table.Row>
          <Table.ColumnHeader>{copy.adminMarketWorkColAt}</Table.ColumnHeader>
          <Table.ColumnHeader>{copy.adminMarketWorkColWork}</Table.ColumnHeader>
          <Table.ColumnHeader>{copy.adminCategoryChangesColCategory}</Table.ColumnHeader>
          <Table.ColumnHeader>{copy.adminMarketWorkColActor}</Table.ColumnHeader>
          <Table.ColumnHeader>{copy.adminCategoryChangesColValues}</Table.ColumnHeader>
        </Table.Row>
      }
    >
      {rows.map((change) => {
        const prefix = `${ROW}-${change.id}`;
        return (
          <Table.Row key={change.id} data-testid={prefix} data-type={change.type}>
            <Table.Cell whiteSpace="nowrap" verticalAlign="top" data-testid={`${prefix}-at`}>
              {formatKst(change.at)}
            </Table.Cell>
            <Table.Cell whiteSpace="nowrap" verticalAlign="top" data-testid={`${prefix}-type`}>
              {CATEGORY_CHANGE_LABEL[change.type]}
            </Table.Cell>
            <Table.Cell minW="32" verticalAlign="top" data-testid={`${prefix}-category`}>
              {categoryRefText(change.category)}
            </Table.Cell>
            <Table.Cell whiteSpace="nowrap" verticalAlign="top" data-testid={`${prefix}-actor`}>
              {nicknameShown(change.actor.nickname)}
            </Table.Cell>
            <Table.Cell minW="48" verticalAlign="top">
              <Text wordBreak="break-word" data-testid={`${prefix}-values`}>
                {categoryChangeValues(change)}
              </Text>
            </Table.Cell>
          </Table.Row>
        );
      })}
    </OperationsQueue>
  );
}
