/**
 * docker/postgres/init/01-roles.sql grants buddha_app full DML by default privileges and says, in
 * its comments, which tables the migrations take some of it back from (PLAN 6.4): the header
 * lists the restricted tables and the migrations that REVOKE, the footer each of those
 * migrations' tables. A migration that adds a REVOKE without the file leaves it saying the role
 * still holds that privilege (0030 did, ADR-0070). Reads files only.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROLES = readFileSync(
  new URL('../../../docker/postgres/init/01-roles.sql', import.meta.url),
  'utf8',
);
const MIGRATIONS = new URL('../drizzle/', import.meta.url);

/** The comment text of `lines`, `--` and indentation dropped, joined into one line. */
function commentText(lines: string[]): string {
  return lines
    .filter((line) => line.startsWith('--'))
    .map((line) => line.replace(/^--\s*/, ''))
    .join(' ');
}

const lines = ROLES.split('\n');
const firstStatement = lines.findIndex((line) => line.startsWith('CREATE ROLE'));
const footerStart = lines.findIndex((line) => line.startsWith('-- Later (M2+)'));
/** The comment above the first statement, which names the restrictions and their migrations. */
const HEADER = commentText(lines.slice(0, firstStatement));
/** The comment at the end, which names each REVOKE migration's tables. */
const FOOTER = commentText(lines.slice(footerStart));

/** Every migration's `REVOKE … ON TABLE … FROM buddha_app` statements, by migration number. */
function revokes(): { migration: string; tables: string[] }[] {
  return readdirSync(MIGRATIONS)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort()
    .flatMap((file) => {
      const sql = readFileSync(new URL(file, MIGRATIONS), 'utf8');
      const tables = [...sql.matchAll(/^REVOKE [A-Z, ]+ ON TABLE (.+?) FROM buddha_app;/gm)]
        .flatMap((match) => match[1]!.split(','))
        .map((table) => table.trim().replaceAll('"', ''));
      return tables.length === 0 ? [] : [{ migration: file.slice(0, 4), tables }];
    });
}

describe('docker/postgres/init/01-roles.sql names the restrictions the migrations apply', () => {
  const found = revokes();

  it('finds the REVOKE migrations (the parse is not empty)', () => {
    expect(firstStatement).toBeGreaterThan(0);
    expect(footerStart).toBeGreaterThan(firstStatement);
    expect(found.map((revoke) => revoke.migration)).toEqual(
      expect.arrayContaining(['0001', '0026', '0030', '0031', '0032']),
    );
  });

  it('lists every REVOKE migration in the header, and no other', () => {
    const listed = /migrations with REVOKE \(([\d, ]+)\)/.exec(HEADER);
    expect(listed, HEADER).not.toBeNull();
    const numbers = listed![1]!.split(',').map((number) => number.trim());
    expect(numbers).toEqual(found.map((revoke) => revoke.migration));
  });

  it('names every restricted table in the header and in the footer', () => {
    const missing = found.flatMap(({ migration, tables }) =>
      tables.flatMap((table) => [
        ...(HEADER.includes(table) ? [] : [`${migration} ${table}: header`]),
        ...(FOOTER.includes(table) ? [] : [`${migration} ${table}: footer`]),
      ]),
    );
    expect(missing).toEqual([]);
  });
});
