/**
 * The operator's psql procedures (docs/OPERATIONS.md), run the way the doc has them run, for the
 * tests that need what they do: phone-change.test.ts runs and reads them statement by statement,
 * and the API's like tests (#49, ADR-0076) change a member's number with the real procedure to see
 * the likes go with it (`changePhoneAsOperator`).
 */
import type { Db } from '../client.js';
import { OPERATOR_PHONE_CHANGE_SQL } from '../phone-change.js';

/**
 * A psql script's statements as psql sends them: split at each `;` outside a dollar-quoted body
 * (a DO block's). No statement of the doc's has a `;` or `$$` inside a quoted literal. Throws on
 * an unclosed body or text after the last `;`.
 */
export function splitPsqlStatements(text: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('$$', i)) {
      quoted = !quoted;
      i++;
    } else if (!quoted && text[i] === ';') {
      statements.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quoted) throw new Error('an unclosed dollar-quoted body');
  if (text.slice(start).trim() !== '') throw new Error('text after the last statement');
  return statements;
}

/** A statement with psql's `:'name'` variables written in as quoted literals, as psql does. */
export function writePsqlVariables(text: string, vars: Record<string, string>): string {
  return text.replace(/:'(\w+)'/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`no value for :'${name}'`);
    return `'${value.replaceAll("'", "''")}'`;
  });
}

export interface OperatorPhoneChangeInput {
  userId: string;
  /** The new number, digits only. */
  phone: string;
  /** The keyed hash of `phone` (the API's `PhoneHasher`, or any 64 hex where no key is at hand). */
  phoneHash: string;
}

/**
 * Step 5 of the operator's change of a member's number (OPERATOR_PHONE_CHANGE_SQL), on one
 * connection of `db` (buddha_app, the doc's role): BEGIN, every statement, COMMIT. For tests whose
 * subject is what the change carries along, not its result table — any statement that fails, or an
 * `UPDATE 0` (no 본인확인 record for the id), rolls the whole of it back and throws. The result
 * table's rows are phone-change.test.ts's.
 */
export async function changePhoneAsOperator(db: Db, input: OperatorPhoneChangeInput) {
  const vars = { user_id: input.userId, new_phone: input.phone, new_hash: input.phoneHash };
  const client = await db.$client.connect();
  try {
    await client.query('BEGIN');
    try {
      const [update, ...rest] = splitPsqlStatements(OPERATOR_PHONE_CHANGE_SQL);
      const updated = await client.query(writePsqlVariables(update!, vars));
      if (updated.rowCount !== 1)
        throw new Error(`UPDATE ${String(updated.rowCount)}: no 본인확인`);
      for (const statement of rest) await client.query(writePsqlVariables(statement, vars));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}
