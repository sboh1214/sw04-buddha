import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationsFolder } from './migrator.js';

/**
 * The migration journal (`drizzle/meta/_journal.json`) as the migrator reads it. drizzle-orm's
 * Postgres migrator (0.45) looks only at the NEWEST row of `drizzle.__drizzle_migrations` and
 * applies a journal entry only when its `when` (the folder's millis) is later than that row's
 * `created_at`; it compares no hash or tag. So an entry whose `when` is not above every earlier
 * one is skipped without a word on a database that already applied the earlier ones — the
 * deployed one, a test or e2e database migrated run after run — while a fresh database (CI)
 * applies it and passes. That happens when a stacked PR's migration is renumbered behind one
 * generated later and its `when` is left as it was (ADR-0088 결과 3, '다시 쌓기'). Reads files
 * only: no database is needed.
 */

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const journal = JSON.parse(
  readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
) as { entries: JournalEntry[] };

describe('the migration journal', () => {
  it('numbers the migrations 0, 1, 2… with a file for each, its tag led by that number', () => {
    journal.entries.forEach((entry, position) => {
      expect(entry.idx).toBe(position);
      expect(entry.tag.startsWith(`${String(position).padStart(4, '0')}_`), entry.tag).toBe(true);
      expect(existsSync(join(migrationsFolder, `${entry.tag}.sql`)), entry.tag).toBe(true);
    });
  });

  it('has every `when` later than the one before, or the migrator would skip the entry', () => {
    for (let position = 1; position < journal.entries.length; position += 1) {
      const before = journal.entries[position - 1]!;
      const entry = journal.entries[position]!;
      expect(
        entry.when > before.when,
        `${entry.tag} (${String(entry.when)}) must be later than ${before.tag} (${String(before.when)})`,
      ).toBe(true);
    }
  });
});
