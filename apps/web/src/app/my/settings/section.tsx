import { Card, Heading, Text } from '@chakra-ui/react';

/** One titled card per settings section. */
export function SettingsSection({
  title,
  hint,
  children,
  testId,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Card.Root as="section" data-testid={testId}>
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
