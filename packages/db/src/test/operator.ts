/**
 * The operator's psql procedures (docs/OPERATIONS.md), run the way the doc has them run, for the
 * tests that need what they do: phone-change.test.ts runs and reads them statement by statement,
 * and the API's like tests (#49, ADR-0076) change a member's number with the real procedure to see
 * the likes go with it (`changePhoneAsOperator`).
 */
import type { Db } from '../client.js';
import { OPERATOR_CURRENT_NUMBER_SQL, OPERATOR_PHONE_CHANGE_SQL } from '../phone-change.js';

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
  /**
   * The keyed hash of a number, as the hash CLI prints it (the API's `PhoneHasher`): of the new
   * number, and of the old one the account holds (owner decision 2026-10-21, ADR-0076).
   */
  hash: (phone: string) => string;
}

/**
 * Steps 3 and 5 of the operator's change of a member's number (OPERATOR_CURRENT_NUMBER_SQL, then
 * OPERATOR_PHONE_CHANGE_SQL), on one connection of `db` (buddha_app, the doc's role): the number
 * the account holds now read and hashed for `old_phone` and `old_hash`, the new one hashed for
 * `new_phone` and `new_hash`, then BEGIN, every statement, COMMIT. For tests whose subject is what
 * the change carries along, not its result table — no 본인확인 record to read, any statement that
 * fails, or an `UPDATE 0`, rolls the whole of it back and throws. The result table's rows are
 * phone-change.test.ts's.
 */
export async function changePhoneAsOperator(db: Db, input: OperatorPhoneChangeInput) {
  const client = await db.$client.connect();
  try {
    const current = await client.query<{ phone: string }>(
      writePsqlVariables(OPERATOR_CURRENT_NUMBER_SQL, { user_id: input.userId }),
    );
    const oldPhone = current.rows[0]?.phone;
    if (oldPhone === undefined) throw new Error('no 본인확인 to change');
    const vars = {
      user_id: input.userId,
      new_phone: input.phone,
      new_hash: input.hash(input.phone),
      old_phone: oldPhone,
      old_hash: input.hash(oldPhone),
    };
    await client.query('BEGIN');
    try {
      const [update, ...rest] = splitPsqlStatements(OPERATOR_PHONE_CHANGE_SQL);
      const updated = await client.query(writePsqlVariables(update!, vars));
      if (updated.rowCount !== 1)
        throw new Error(`UPDATE ${String(updated.rowCount)}: no 본인확인 on the old number`);
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
