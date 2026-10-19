import { Box, Image } from '@chakra-ui/react';
import {
  mediaPath,
  type PostBlock,
  type PostDocument,
  type PostInline,
  type PostListItem,
  type PostMark,
  type PostTableRow,
} from '@buddha/shared';
import { type ReactNode } from 'react';
import { copy } from '@/copy';
import { isPostTextColor } from '@/lib/post-editor';
import { POST_CONTENT_CSS } from './post-content-style';

/**
 * A post's body (#46, ADR-0073), drawn node by node as React elements from the stored document —
 * never an HTML string, never `dangerouslySetInnerHTML` — so there is no markup for a script to
 * hide in: text is text whatever it says. The server already kept only what its allow-list names
 * (`sanitizePostDocument`); this draws exactly those nodes and marks and ignores anything else, so
 * a document from an older or newer server cannot draw something unexpected either.
 *
 * - A link opens in a new tab with `noopener noreferrer` and `nofollow ugc` (a writer's link is
 *   not an endorsement), and only an http(s) address is drawn as a link at all.
 * - An image is ours, by its media id (`GET /media/:id`, served only while a post shows it).
 * - A colour is a name drawn through the theme (`data-color`, post-content-style.ts).
 * - Headings are `h3`–`h5` under the page's `h1` and the post's `h2`.
 */
export function PostBody({ document }: { document: PostDocument }) {
  return (
    <Box css={POST_CONTENT_CSS} data-testid="post-body">
      {blocks(document.content)}
    </Box>
  );
}

/** Only an http(s) address is a link; the server keeps no other, this is the second lock. */
function safeHref(href: string): string | undefined {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** One mark around its content; an unknown mark (or a bad link) leaves the content as it is. */
function wrap(mark: PostMark, content: ReactNode, key: string): ReactNode {
  switch (mark.type) {
    case 'bold':
      return <strong key={key}>{content}</strong>;
    case 'italic':
      return <em key={key}>{content}</em>;
    case 'strike':
      return <s key={key}>{content}</s>;
    case 'code':
      return <code key={key}>{content}</code>;
    case 'textStyle':
      return isPostTextColor(mark.attrs.color) ? (
        <span key={key} data-color={mark.attrs.color}>
          {content}
        </span>
      ) : (
        content
      );
    case 'link': {
      const href = safeHref(mark.attrs.href);
      return href === undefined ? (
        content
      ) : (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow ugc">
          {content}
        </a>
      );
    }
    default:
      return content;
  }
}

/**
 * The order marks nest in, innermost first: the colour inside the emphasis inside the link, so a
 * coloured, bold link is one link around one bold run around one coloured run.
 */
const NESTING: readonly PostMark['type'][] = [
  'code',
  'textStyle',
  'strike',
  'italic',
  'bold',
  'link',
];

function inline(node: PostInline, key: string): ReactNode {
  if (node.type === 'hardBreak') return <br key={key} />;
  const marks = [...(node.marks ?? [])].sort(
    (a, b) => NESTING.indexOf(a.type) - NESTING.indexOf(b.type),
  );
  return marks.reduce<ReactNode>(
    (content, mark, index) => wrap(mark, content, `${key}-${String(index)}`),
    <span key={key}>{node.text}</span>,
  );
}

function inlines(content: PostInline[] | undefined): ReactNode[] {
  return (content ?? []).map((node, index) => inline(node, String(index)));
}

function listItems(items: PostListItem[]): ReactNode[] {
  return items.map((item, index) => <li key={index}>{blocks(item.content)}</li>);
}

function tableRows(rows: PostTableRow[]): ReactNode[] {
  return rows.map((row, rowIndex) => (
    <tr key={rowIndex}>
      {row.content.map((cell, cellIndex) => {
        const Cell = cell.type === 'tableHeader' ? 'th' : 'td';
        return (
          <Cell
            key={cellIndex}
            colSpan={cell.attrs.colspan > 1 ? cell.attrs.colspan : undefined}
            rowSpan={cell.attrs.rowspan > 1 ? cell.attrs.rowspan : undefined}
          >
            {blocks(cell.content)}
          </Cell>
        );
      })}
    </tr>
  ));
}

function block(node: PostBlock, key: number): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p key={key}>{inlines(node.content)}</p>;
    case 'heading': {
      const Tag = (['h3', 'h4', 'h5'] as const)[node.attrs.level - 1] ?? 'h5';
      return (
        <Tag key={key} data-heading={node.attrs.level}>
          {inlines(node.content)}
        </Tag>
      );
    }
    case 'blockquote':
      return <blockquote key={key}>{blocks(node.content)}</blockquote>;
    case 'bulletList':
      return <ul key={key}>{listItems(node.content)}</ul>;
    case 'orderedList':
      return (
        <ol key={key} start={node.attrs.start > 1 ? node.attrs.start : undefined}>
          {listItems(node.content)}
        </ol>
      );
    case 'codeBlock':
      return (
        <pre key={key}>
          <code>{node.content?.[0]?.text ?? ''}</code>
        </pre>
      );
    case 'horizontalRule':
      return <hr key={key} />;
    case 'image':
      return (
        // A plain <img> (Chakra's `Image`): the image is ours, revalidated on every use
        // (`no-cache` + ETag), so it stops the moment the post is hidden or deleted — no
        // optimiser in front to keep a copy.
        <Image
          key={key}
          src={mediaPath(node.attrs.mediaId)}
          alt={copy.postImageAlt}
          loading="lazy"
          data-testid="post-image"
        />
      );
    case 'table':
      return (
        <Box key={key} overflowX="auto">
          <table>
            <tbody>{tableRows(node.content)}</tbody>
          </table>
        </Box>
      );
    default:
      return null;
  }
}

function blocks(content: PostBlock[]): ReactNode[] {
  return content.map((node, index) => block(node, index));
}
