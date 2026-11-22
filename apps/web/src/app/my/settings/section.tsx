import { Card, Heading, Text } from '@chakra-ui/react';

/**
 * One titled card per settings section. `id` makes it a link's anchor (`/my/settings#<id>`): it
 * then stops below the sticky header (65px on MY) rather than under it.
 */
export function SettingsSection({
  title,
  hint,
  children,
  testId,
  id,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  testId?: string;
  id?: string;
}) {
  return (
    <Card.Root
      as="section"
      data-testid={testId}
      id={id}
      scrollMarginTop={id === undefined ? undefined : '20'}
    >
      <Card.Header>
        <Heading as="h3" size="md">
          {title}
        </Heading>
        {hint && (
          <Text fontSize="sm" color="fg.muted">
            {hint}
          </Text>
        )}
      </Card.Header>
      <Card.Body>{children}</Card.Body>
    </Card.Root>
  );
}
