import { Container, Heading, List, Stack, Table, Text } from '@chakra-ui/react';
import { copy } from '@/copy';
import {
  type LegalBlock,
  type LegalDocument,
  type LegalListItem,
  resolveLegalDocument,
  sectionHeading,
} from './document';

/**
 * The one renderer behind `/terms`, `/privacy` and `/refund` (ADR-0044). A server component with
 * no data: each page is static and prerendered by `next build`, which is also where a
 * placeholder naming no business fact fails (`resolveLegalDocument` throws) instead of reaching
 * a visitor as literal braces.
 *
 * Reading width rather than the 1320px Kalshi chrome: this is running prose, and a 1272px line
 * of Korean is unreadable. `keep-all` keeps Korean words whole at a line break (the default
 * breaks between any two syllables); `break-word` still lets an over-long token — an email
 * address once the real one is filled in — wrap instead of widening a 375px page.
 */
export function LegalDocumentView({
  document,
  testId,
}: {
  document: LegalDocument;
  testId: string;
}) {
  const doc = resolveLegalDocument(document);
  return (
    <Container maxW="3xl" px="6" py={{ base: '6', md: '10' }}>
      <Stack
        as="article"
        gap="8"
        textStyle="bodyMd"
        wordBreak="keep-all"
        overflowWrap="break-word"
        data-testid={testId}
      >
        <Stack gap="3">
          <Heading as="h2" textStyle="headline">
            {doc.title}
          </Heading>
          <Blocks blocks={doc.intro} />
        </Stack>
        {doc.sections.map((section, index) => {
          const id = `${testId}-${String(index + 1)}`;
          return (
            <Stack as="section" key={id} gap="3" aria-labelledby={id}>
              <Heading as="h3" id={id} textStyle="titleLg">
                {sectionHeading(doc.numbering, index, section.heading)}
              </Heading>
              <Blocks blocks={section.blocks} />
            </Stack>
          );
        })}
        {doc.addendum.length > 0 && (
          <Stack
            as="section"
            gap="3"
            borderTopWidth="1px"
            pt="6"
            aria-labelledby={`${testId}-addendum`}
          >
            <Heading as="h3" id={`${testId}-addendum`} textStyle="titleLg">
              {copy.legalAddendum}
            </Heading>
            <Blocks blocks={doc.addendum} />
          </Stack>
        )}
      </Stack>
    </Container>
  );
}

function Blocks({ blocks }: { blocks: readonly LegalBlock[] }) {
  // Index keys: the blocks are a fixed document, never reordered at run time.
  return blocks.map((block, index) => <Block key={index} block={block} />);
}

function Block({ block }: { block: LegalBlock }) {
  switch (block.kind) {
    case 'paragraph':
      return <Text>{block.text}</Text>;
    case 'list':
      return <LegalList ordered={block.ordered} items={block.items} />;
    case 'table':
      return (
        // Scrolls sideways on its own at 375px rather than widening the page.
        <Table.ScrollArea borderWidth="1px" borderRadius="row">
          <Table.Root size="sm">
            <Table.Caption captionSide="top" textAlign="start" px="3" pt="2" color="fg.muted">
              {block.caption}
            </Table.Caption>
            <Table.Header>
              <Table.Row>
                {block.head.map((cell) => (
                  <Table.ColumnHeader key={cell} minW="24">
                    {cell}
                  </Table.ColumnHeader>
                ))}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {block.rows.map((row, rowIndex) => (
                <Table.Row key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <Table.Cell key={cellIndex} verticalAlign="top">
                      {cell}
                    </Table.Cell>
                  ))}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Table.ScrollArea>
      );
  }
}

/**
 * `1.`/`2.` for a numbered list and `가.`/`나.` for the items under one of its entries — the
 * 항·호 shape Korean terms are read in; bullets stay bullets at both levels.
 */
function LegalList({ ordered, items }: { ordered: boolean; items: readonly LegalListItem[] }) {
  return (
    <List.Root as={ordered ? 'ol' : 'ul'} gap="2" ps="6">
      {items.map((item, index) =>
        typeof item === 'string' ? (
          <List.Item key={index}>{item}</List.Item>
        ) : (
          <List.Item key={index}>
            {item.text}
            <List.Root
              as={ordered ? 'ol' : 'ul'}
              gap="1"
              ps="6"
              listStyleType={ordered ? 'hangul' : 'circle'}
            >
              {item.items.map((sub, subIndex) => (
                <List.Item key={subIndex}>{sub}</List.Item>
              ))}
            </List.Root>
          </List.Item>
        ),
      )}
    </List.Root>
  );
}
