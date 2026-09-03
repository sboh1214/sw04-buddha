import { Card, Container, Heading, Stack, Text } from '@chakra-ui/react';

/** Narrow centred card used by /login, /signup and /reset-password. */
export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <Container maxW="sm" py={{ base: '8', md: '16' }}>
      <Card.Root>
        <Card.Header>
          <Stack gap="1">
            <Heading as="h2" size="xl">
              {title}
            </Heading>
            {subtitle && <Text color="fg.muted">{subtitle}</Text>}
          </Stack>
        </Card.Header>
        <Card.Body>{children}</Card.Body>
      </Card.Root>
    </Container>
  );
}
