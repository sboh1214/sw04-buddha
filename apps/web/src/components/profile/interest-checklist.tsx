'use client';

import { Box, Checkbox, HStack, Stack } from '@chakra-ui/react';
import { type CategoryNode } from '@/lib/category-tree';

/**
 * The interest categories as checkboxes (#57-7 «상위 및 하위 카테고리, 상한 없음»): each top-level
 * category with its sub-categories under it — the header's grouping (`groupCategories`) — each a
 * checkbox of its own, as many as the member likes. A top-level category is a choice of its own,
 * not a shortcut for its sub-categories. The onboarding's interests step (#58) and MY 설정's card
 * (#41, ADR-0078) draw the same list, so a member picks the same way in both.
 */
export function InterestChecklist({
  tree,
  picked,
  onToggle,
}: {
  tree: readonly CategoryNode[];
  picked: ReadonlySet<number>;
  onToggle: (id: number, checked: boolean) => void;
}) {
  return (
    <Stack as="ul" gap="4" listStyleType="none" data-testid="interests-list">
      {tree.map((node) => (
        <Box as="li" key={node.category.id}>
          <Checkbox.Root
            checked={picked.has(node.category.id)}
            onCheckedChange={(details) => onToggle(node.category.id, details.checked === true)}
            colorPalette="brand"
            data-testid={`interest-${node.category.slug}`}
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control />
            <Checkbox.Label fontWeight="semibold">{node.category.nameKo}</Checkbox.Label>
          </Checkbox.Root>
          {node.children.length > 0 && (
            <HStack as="ul" listStyleType="none" gap="3" wrap="wrap" ps="7" pt="2">
              {node.children.map((child) => (
                <Box as="li" key={child.id}>
                  <Checkbox.Root
                    checked={picked.has(child.id)}
                    onCheckedChange={(details) => onToggle(child.id, details.checked === true)}
                    colorPalette="brand"
                    size="sm"
                    data-testid={`interest-${child.slug}`}
                  >
                    <Checkbox.HiddenInput />
                    <Checkbox.Control />
                    <Checkbox.Label>{child.nameKo}</Checkbox.Label>
                  </Checkbox.Root>
                </Box>
              ))}
            </HStack>
          )}
        </Box>
      ))}
    </Stack>
  );
}
