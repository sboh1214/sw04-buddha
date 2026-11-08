import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MarketRowWrite } from './market-stats.js';
import type { MarketTransition } from './market-transitions.js';

const ROOT = new URL('../../../', import.meta.url);

/**
 * The writers of a market's statistics (#121, ADR-0116; ADR-0107 결정 1 #177 11–13항): the five
 * columns `last_price`, `last_fill_at`, `volume_coin`, `trade_count` and `trader_count` are written
 * by market-stats.ts alone, which the intake (`placeOrder`) calls once per intake that filled, in
 * its transaction under the market's lock — so they always say what the fills say, and the open,
 * a transition, a cancel or an expiry, a judgement, a settlement and the seed write none of them.
 * Every other writer is listed with its reason.
 *
 * The scan reads a literal handed to `.set(…)`/`.values(…)` right after a drizzle write of
 * `markets`, the query or SQL handed to an insert's `.select(…)` (drizzle's insert from a select,
 * typed over every column, statistics included), the `set` of an `.onConflictDoUpdate(…)` in the
 * same statement (drizzle types it `PgUpdateSetSource`, not `MarketRowWrite`, so the compiler
 * would take a statistic there), and raw SQL (an UPDATE's SET, an INSERT's columns — an INSERT
 * with no column list writes every column by position, so it counts as a write —, its
 * `ON CONFLICT … DO UPDATE SET`, a MERGE's `UPDATE SET` and `INSERT`). It finds the table only
 * spelled `markets` or `schema.markets`: a handle bound under another name is not seen
 * (docs/GUARDS.md '검사하지 않는 것'). What it cannot read — a `set` object handed to
 * `transitionMarket` (which spreads it into its own `.set`), a variable, a spread or a function's
 * result passed to `.set(…)`/`.values(…)` — the compiler refuses instead: those writes are typed
 * `MarketRowWrite` (market-stats.ts), whose statistics are `never`, so a variable or a spread
 * carrying one fails as a literal does. The scan pins every such argument, each occurrence, with
 * the reason it is typed (OPAQUE_WRITES), so a new one — an untyped object drizzle's own `.set`
 * would take, an insert's `.select(…)`, or a second write passing a pinned name — fails here until
 * it is typed and listed; every declaration of a pinned variable in its file must be typed
 * `MarketRowWrite`, and every pinned helper must return one; and no other source names the row's
 * insert type in any spelling. The statement's end and its brackets are read outside comments and
 * strings, so a `;` in either hides nothing.
 */
const STATS_WRITERS: Record<string, string> = {
  'packages/db/src/market-stats.ts': 'the one writer, called by placeOrder under lockMarket',
  // `createMarket`'s statistics overrides: a row as a read test needs it (its doc says so).
  'packages/db/src/test/factories.ts': 'test fixture',
};

/** The trees the static guard scans, each `<group>/<name>/src` (order-writes.test.ts's). */
const SCANNED_GROUPS = ['apps', 'packages'];

/** Every source file of every app and package, tests aside, relative to the repository root. */
function sourceFiles(): string[] {
  return SCANNED_GROUPS.flatMap((group) =>
    readdirSync(new URL(`${group}/`, ROOT), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const src = `${group}/${entry.name}/src`;
        let files: string[];
        try {
          files = readdirSync(new URL(`${src}/`, ROOT), { recursive: true, encoding: 'utf8' });
        } catch {
          return [];
        }
        return files
          .filter((file) => /\.(ts|tsx|mts)$/.test(file) && !/\.test\.tsx?$/.test(file))
          .map((file) => `${src}/${file.replaceAll('\\', '/')}`);
      }),
  );
}

const FIELDS = '(?:lastPrice|lastFillAt|volumeCoin|tradeCount|traderCount)';
const COLUMNS = '(?:last_price|last_fill_at|volume_coin|trade_count|trader_count)';
/** A key of an object literal: `lastPrice: …` or the shorthand `{ lastPrice, … }`. */
const NAMES_A_FIELD = new RegExp(`\\b${FIELDS}\\s*:|[{,]\\s*${FIELDS}\\s*[,}]`);
/** drizzle's `update(markets)` / `insert(markets)`, bare or through `schema.`. */
const DRIZZLE_WRITE = /\.(?:update|insert)\(\s*(?:schema\.)?markets\s*\)/g;
/** A raw UPDATE of markets (an alias allowed) up to its WHERE, RETURNING or the text's end. */
const RAW_UPDATE =
  /\bupdate\s+(?:only\s+)?(?:(?:public\.)?"?markets"?|\$\{\s*(?:schema\.)?markets\s*\})(?:\s+(?:as\s+)?"?\w+"?)?\s+set\b([\s\S]*?)(?:\bwhere\b|\breturning\b|`|$)/gi;
/** A raw INSERT into markets (an alias allowed) and its column list. */
const RAW_INSERT =
  /\binsert\s+into\s+(?:(?:public\.)?"?markets"?|\$\{\s*(?:schema\.)?markets\s*\})(?:\s+as\s+"?\w+"?)?\s*\(([^)]*)\)/gi;
/**
 * A raw INSERT into markets with no column list (`VALUES`, `SELECT`, `WITH`, `TABLE` or
 * `OVERRIDING` right after the table): it writes every column by position — a copy of another
 * row writes its statistics —, so it counts as a write. `DEFAULT VALUES` writes the defaults alone.
 */
const RAW_INSERT_BY_POSITION =
  /\binsert\s+into\s+(?:(?:public\.)?"?markets"?|\$\{\s*(?:schema\.)?markets\s*\})(?:\s+as\s+"?\w+"?)?\s+(?:values|select|with|table|overriding)\b/i;
/** A raw INSERT into markets' `ON CONFLICT … DO UPDATE SET`, up to its WHERE or RETURNING. */
const RAW_UPSERT =
  /\binsert\s+into\s+(?:(?:public\.)?"?markets"?|\$\{\s*(?:schema\.)?markets\s*\})[^`]*?\bon\s+conflict\b[^`]*?\bdo\s+update\s+set\b([^`]*?)(?:\bwhere\b|\breturning\b|`|$)/gi;
/** A raw MERGE into markets: its `UPDATE SET` and `INSERT (…)` clauses, up to the text's end. */
const RAW_MERGE =
  /\bmerge\s+into\s+(?:(?:public\.)?"?markets"?|\$\{\s*(?:schema\.)?markets\s*\})([\s\S]*?)(?:`|$)/gi;

/**
 * `code` with every comment blanked and, when `strings` is set, the text of every string, template
 * and regular expression too, each character a space (a line break stays): the length and every
 * offset are kept, the delimiters and a template's `${…}` code stay. The scan reads a statement's
 * end and its brackets on this, so a `;` or a bracket in a comment or a string hides nothing.
 * `code` starts outside any comment or string (the scan starts it right after a write's table).
 */
function blankNonCode(code: string, strings: boolean): string {
  const out = code.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  // Each open `${` of a template, so its `}` goes back into the template's text.
  const braces: ('{' | '${')[] = [];
  let last = '';
  let i = 0;
  const template = (from: number): number => {
    // From just after a template's opening backtick (or a `${…}`'s closing brace).
    let k = from;
    for (; k < code.length; k += 1) {
      if (code[k] === '\\') k += 1;
      else if (code[k] === '`') break;
      else if (code[k] === '$' && code[k + 1] === '{') {
        if (strings) blank(from, k);
        braces.push('${');
        return k + 2;
      }
    }
    if (strings) blank(from, k);
    return k + 1;
  };
  while (i < code.length) {
    const c = code[i]!;
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      const to = end === -1 ? code.length : end;
      blank(i, to);
      i = to;
    } else if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      const to = end === -1 ? code.length : end + 2;
      blank(i, to);
      i = to;
    } else if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < code.length && code[k] !== c && code[k] !== '\n') k += code[k] === '\\' ? 2 : 1;
      if (strings) blank(i + 1, k);
      i = k + 1;
      last = c;
    } else if (c === '`') {
      i = template(i + 1);
      last = c;
    } else if (c === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last))) {
      // A regular expression literal: where an operand starts, a `/` cannot divide.
      let k = i + 1;
      let inClass = false;
      for (; k < code.length && code[k] !== '\n'; k += 1) {
        if (code[k] === '\\') k += 1;
        else if (code[k] === '[') inClass = true;
        else if (code[k] === ']') inClass = false;
        else if (code[k] === '/' && !inClass) break;
      }
      if (strings) blank(i + 1, k);
      i = k + 1;
      last = '/';
    } else {
      if (c === '{') braces.push('{');
      else if (c === '}' && braces.pop() === '${') {
        i = template(i + 1);
        last = '`';
        continue;
      }
      if (!/\s/.test(c)) last = c;
      i += 1;
    }
  }
  return out.join('');
}

/**
 * The argument of the call whose `(` is at `open`, by balanced parentheses read on `code` (the
 * same text with its strings and comments blanked), taken from `text`.
 */
function argumentAt(text: string, code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/**
 * What an `.onConflictDoUpdate(…)` argument writes: the value of its `set` member (shorthand
 * included) and each spread of the config, or the whole argument when it is no object literal.
 */
function upsertSetArguments(argument: string): string[] {
  const config = argument.trim();
  if (!/^\{[\s\S]*\}$/.test(config)) return [config];
  return membersOf(config.slice(1, -1)).flatMap((member) => {
    if (member.startsWith('...')) return [member];
    const set = /^set\s*(?::([\s\S]*))?$/.exec(member);
    if (set === null) return [];
    return [set[1] === undefined ? 'set' : set[1].trim()];
  });
}

/**
 * The argument of the first `.set(…)`/`.values(…)`/`.select(…)` that follows a drizzle write of
 * `markets` (an insert from a select hands over a query or SQL, never a literal, so it is pinned
 * as any opaque argument is), and what an `.onConflictDoUpdate(…)` later in the same statement
 * writes. The statement ends at the
 * first `;` outside a comment or a string, and the brackets are counted outside them too
 * (`blankNonCode`); each argument comes back with its comments blanked and its strings as written.
 */
function drizzleWriteArguments(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(DRIZZLE_WRITE)) {
    const rest = text.slice(match.index + match[0].length);
    const code = blankNonCode(rest, true);
    const written = blankNonCode(rest, false);
    const end = code.indexOf(';');
    const statement = end === -1 ? code : code.slice(0, end);
    const call = /\.(?:set|values|select)\(/.exec(statement);
    if (call !== null) found.push(argumentAt(written, code, call.index + call[0].length - 1));
    for (const upsert of statement.matchAll(/\.onConflictDoUpdate\(/g)) {
      found.push(
        ...upsertSetArguments(argumentAt(written, code, upsert.index + upsert[0].length - 1)),
      );
    }
  }
  return found;
}

/**
 * Whether `text` writes a statistic: the `.set(…)`, `.values(…)` or `.select(…)` that follows a
 * drizzle write of `markets` in the same statement names one of the fields, a raw UPDATE's SET or
 * INSERT's column list names one of the columns, or a raw INSERT has no column list. A read or a
 * mapper (`lastPrice: row.lastPrice`) is none.
 */
function writesStats(text: string): boolean {
  if (drizzleWriteArguments(text).some((argument) => NAMES_A_FIELD.test(argument))) return true;
  if (RAW_INSERT_BY_POSITION.test(text)) return true;
  for (const match of text.matchAll(RAW_UPDATE)) {
    if (new RegExp(`\\b${COLUMNS}\\b`, 'i').test(match[1]!)) return true;
  }
  for (const raw of [RAW_INSERT, RAW_UPSERT]) {
    for (const match of text.matchAll(raw)) {
      if (new RegExp(`\\b${COLUMNS}\\b`, 'i').test(match[1]!)) return true;
    }
  }
  for (const match of text.matchAll(RAW_MERGE)) {
    const clauses = match[1]!;
    const writes = [
      ...clauses.matchAll(/\bupdate\s+set\b([\s\S]*?)(?:\bwhen\b|$)/gi),
      ...clauses.matchAll(/\binsert\s*\(([^)]*)\)/gi),
    ];
    if (writes.some((write) => new RegExp(`\\b${COLUMNS}\\b`, 'i').test(write[1]!))) return true;
    // An INSERT with no column list writes every column by position.
    if (/\binsert\s+(?:overriding\s+\w+\s+value\s+)?values\b/i.test(clauses)) return true;
  }
  return false;
}

const read = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');

/**
 * The top-level members of an object literal's body, split at its commas: brackets nest, and a
 * string or a template's text never splits (a `${…}` inside a template nests as a brace).
 */
function membersOf(body: string): string[] {
  const members: string[] = [];
  const closers: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (quote !== null) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      else if (quote === '`' && c === '$' && body[i + 1] === '{') {
        closers.push('`');
        quote = null;
        i += 1;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') closers.push(c);
    else if (c === ')' || c === ']' || c === '}') {
      // The `}` of a template's `${…}` goes back into the template's text.
      if (closers.pop() === '`') quote = '`';
    } else if (c === ',' && closers.length === 0) {
      members.push(body.slice(start, i));
      start = i + 1;
    }
  }
  members.push(body.slice(start));
  return members.map((member) => member.trim()).filter((member) => member !== '');
}

/**
 * What a drizzle write of `markets` in `text` hands over that the scan cannot read: a whole
 * argument that is not an object literal, and each spread inside one — whitespace collapsed.
 */
function opaqueWrites(text: string): string[] {
  return drizzleWriteArguments(text).flatMap((written) => {
    const argument = written.trim();
    const parts = /^\{[\s\S]*\}$/.test(argument)
      ? membersOf(argument.slice(1, -1)).filter((member) => member.startsWith('...'))
      : [argument];
    return parts.map((part) => part.replace(/\s+/g, ' '));
  });
}

/** A pinned argument: how many times its file hands it over, why, and where its helper is. */
interface Pin {
  /** Each occurrence counts, so a second write passing a pinned name fails until listed. */
  count: number;
  why: string;
  /** For a helper's result (`...name(…)`): the file declaring it, when not the same file. */
  helperIn?: string;
}

/**
 * Every argument of a markets write the scan cannot read, by file, each occurrence, and why it has
 * no statistic. Each one is a `MarketRowWrite` (or a literal spread that the scan reads inside
 * it), so the compiler refuses a statistic in it; a new one lands here only once it is typed so.
 * The pin matches the text alone, so two more checks tie it to the type: every declaration of a
 * pinned variable (`set`, `...times`) in its file is typed `MarketRowWrite` — a statistic added
 * where an untyped variable of that name is built would otherwise get past both the pin and the
 * compiler (drizzle's `.set`/`.values` take it) —, and every pinned helper (`...name(…)`) is
 * declared returning `MarketRowWrite` or returns only literals `satisfies MarketRowWrite`.
 */
const OPAQUE_WRITES: Record<string, Record<string, Pin>> = {
  'apps/api/src/markets/market-admin.service.ts': {
    '...ruleItemColumns(items)': {
      count: 1,
      why: 'satisfies MarketRowWrite',
      helperIn: 'apps/api/src/markets/market-item-rules.ts',
    },
    '...timeColumns(times)': {
      count: 1,
      why: 'satisfies MarketRowWrite',
      helperIn: 'apps/api/src/markets/market-item-rules.ts',
    },
    set: { count: 1, why: 'the edit, typed MarketRowWrite' },
  },
  'apps/api/src/markets/market-supplement.service.ts': {
    '...this.changedColumns(checked)': { count: 1, why: 'returns MarketRowWrite' },
    '...(checked.storeGap === null ? {} : { leadCloseGapMinutes: checked.storeGap })': {
      count: 1,
      why: 'literals the scan reads',
    },
  },
  'packages/db/src/market-transitions.ts': {
    '...transition.set': { count: 1, why: 'MarketRowSet, built from MarketRowWrite' },
  },
  'packages/db/src/seed.ts': {
    '...seedRuleColumns(seed)': { count: 2, why: 'satisfies MarketRowWrite' },
    '...(blank.description ? { description: seed.description } : {})': {
      count: 1,
      why: 'literals the scan reads',
    },
    '...times': {
      count: 2,
      why: 'declared MarketRowWrite (from seedTimeColumns, which satisfies it)',
    },
  },
};

/** A pinned variable's name (`set`, `...times`), or undefined. */
const pinnedVariable = (part: string) => /^(?:\.\.\.)?([A-Za-z_]\w*)$/.exec(part)?.[1];
/** A pinned helper's name (`...timeColumns(times)`, `...this.changedColumns(c)`), or undefined. */
const pinnedHelper = (part: string) => /^\.\.\.(?:this\.)?([A-Za-z_]\w*)\(/.exec(part)?.[1];

/**
 * Whether every declaration of the variable `name` in `text` (comments and strings aside) is typed
 * `MarketRowWrite`, and there is at least one.
 */
function variableTyped(text: string, name: string): boolean {
  const code = blankNonCode(text, true);
  const declarations = [...code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`, 'g'))];
  return (
    declarations.length > 0 &&
    declarations.every((declaration) =>
      /^\s*:\s*MarketRowWrite\b/.test(code.slice(declaration.index + declaration[0].length)),
    )
  );
}

/**
 * Whether the function or method `name` declared in `text` is typed to give a `MarketRowWrite`:
 * its return type is `MarketRowWrite`, or every `return` in its body ends `satisfies
 * MarketRowWrite`. Read on the text with its comments and strings blanked.
 */
function helperTyped(text: string, name: string): boolean {
  const code = blankNonCode(text, true);
  const heads = code.matchAll(
    new RegExp(
      `(?:\\bfunction\\s+|^[ \\t]*(?:(?:private|protected|public|static|async)\\s+)*)${name}\\s*\\(`,
      'gm',
    ),
  );
  for (const head of heads) {
    const open = head.index + head[0].length - 1;
    const params = argumentAt(code, code, open);
    const after = code.slice(open + params.length + 2);
    if (/^\s*:\s*MarketRowWrite\s*\{/.test(after)) return true;
    const brace = /^\s*\{/.exec(after);
    if (brace === null) continue; // a call, not the declaration
    let depth = 0;
    let close = after.length;
    for (let i = brace[0].length - 1; i < after.length; i += 1) {
      if (after[i] === '{') depth += 1;
      else if (after[i] === '}' && (depth -= 1) === 0) {
        close = i;
        break;
      }
    }
    const body = after.slice(0, close);
    const returns = [...body.matchAll(/\breturn\b/g)].map((r) => {
      const end = body.indexOf(';', r.index);
      return body.slice(r.index, end === -1 ? body.length : end);
    });
    return returns.length > 0 && returns.every((r) => /\bsatisfies\s+MarketRowWrite\s*$/.test(r));
  }
  return false;
}

/**
 * The row's insert type named in any spelling: `markets.$inferInsert` (through `schema.`, or
 * `typeof markets['$inferInsert']`), drizzle's `InferInsertModel<typeof markets>`, or the
 * pg-core write types `PgInsertValue<typeof markets>`/`PgUpdateSetSource<typeof markets>` (what
 * `.values`/`.set` take, statistics included).
 */
const NAMES_INSERT_TYPE =
  /\bmarkets\s*\)?\s*(?:\.\s*\$inferInsert\b|\[\s*['"]\$inferInsert['"]\s*\])|\b(?:InferInsertModel|PgInsertValue|PgUpdateSetSource)\s*<\s*typeof\s+(?:schema\.)?markets\b/;

/** The sources that may name the row's insert type (any other typed write uses MarketRowWrite). */
const INSERT_TYPE_NAMERS: Record<string, string> = {
  'packages/db/src/market-stats.ts': 'defines MarketRowWrite from it',
};

describe('the writers of the market statistics (#121, static)', () => {
  it('reads the source tree (the scan is not empty)', () => {
    expect(sourceFiles()).toEqual(
      expect.arrayContaining([
        ...Object.keys(STATS_WRITERS),
        'packages/db/src/orders.ts',
        'apps/api/src/markets/market-admin.service.ts',
      ]),
    );
  });

  it('writes them nowhere else', () => {
    // Test files are not scanned: a test's own rows go through the factory or raw SQL on purpose.
    const writers = sourceFiles().filter((file) => writesStats(read(file)));
    expect(writers.sort()).toEqual(Object.keys(STATS_WRITERS).sort());
  });

  it('types every other market write without the statistics', () => {
    // Compile-time: `pnpm typecheck` fails when an expected error disappears.
    const transition: NonNullable<MarketTransition['set']>[] = [
      // @ts-expect-error a transition (open, pause, close, judgement, settlement, #20) sets none
      { lastPrice: null, lastFillAt: null },
      // @ts-expect-error nor the volume
      { volumeCoin: 0n },
    ];
    const edit: MarketRowWrite[] = [
      // @ts-expect-error an admin edit, a supplement or a seed column helper sets none
      { tradeCount: 0 },
      // @ts-expect-error nor the participants
      { traderCount: 0 },
    ];
    // Not only a literal: TypeScript checks a missing key on a fresh literal alone, so these pass
    // only because the statistics are `never` — a variable, a spread, a transition's `set` object.
    const now = new Date();
    const patch = { updatedAt: now, tradeCount: 0 };
    const extra = { lastPrice: 52, lastFillAt: now };
    const resultColumns = { resolvedResult: 'YES' as const, volumeCoin: 0n };
    // @ts-expect-error a variable carrying a statistic
    const fromVariable: MarketRowWrite = patch;
    // @ts-expect-error a spread carrying one
    const fromSpread: MarketRowWrite = { updatedAt: now, ...extra };
    // @ts-expect-error a transition's `set` held in a variable (judgement's end price, Q-M5-4)
    const fromSet: NonNullable<MarketTransition['set']> = resultColumns;
    // A clean variable still passes.
    const clean = { updatedAt: now, title: '제목' };
    const typed: MarketRowWrite = clean;
    expect([...transition, ...edit, fromVariable, fromSpread, fromSet, typed]).toHaveLength(8);
  });

  it('pins every markets write argument the scan cannot read, each occurrence, each typed', () => {
    // No Set: a second write passing a pinned name (a new `.set(set)`) fails until it is counted.
    const found = Object.fromEntries(
      sourceFiles()
        .map((file) => [file, opaqueWrites(read(file)).sort()] as const)
        .filter(([, parts]) => parts.length > 0),
    );
    expect(found).toEqual(
      Object.fromEntries(
        Object.entries(OPAQUE_WRITES).map(([file, parts]) => [
          file,
          Object.entries(parts)
            .flatMap(([part, pin]) => Array<string>(pin.count).fill(part))
            .sort(),
        ]),
      ),
    );
  });

  it('types every declaration of a pinned variable and every pinned helper MarketRowWrite', () => {
    const pins = Object.entries(OPAQUE_WRITES).flatMap(([file, parts]) =>
      Object.entries(parts).map(([part, pin]) => ({ file, part, pin })),
    );
    const variables = pins.filter(({ part }) => pinnedVariable(part) !== undefined);
    const helpers = pins.filter(({ part }) => pinnedHelper(part) !== undefined);
    expect(variables.length).toBeGreaterThan(0);
    expect(helpers.length).toBeGreaterThan(0);
    for (const { file, part } of variables) {
      expect(variableTyped(read(file), pinnedVariable(part)!), `${file}: ${part}`).toBe(true);
    }
    for (const { file, part, pin } of helpers) {
      const where = pin.helperIn ?? file;
      expect(helperTyped(read(where), pinnedHelper(part)!), `${where}: ${part}`).toBe(true);
    }
  });

  it('names the row insert type only where MarketRowWrite is made', () => {
    const naming = sourceFiles().filter((file) => NAMES_INSERT_TYPE.test(read(file)));
    expect(naming.sort()).toEqual(Object.keys(INSERT_TYPE_NAMERS).sort());
  });

  it('re-runs when any scanned file changes (turbo test inputs cover the trees it reads)', () => {
    const turbo = JSON.parse(read('packages/db/turbo.json')) as {
      tasks: { test: { inputs: string[] } };
    };
    expect(turbo.tasks.test.inputs).toEqual(
      expect.arrayContaining(SCANNED_GROUPS.map((group) => `$TURBO_ROOT$/${group}/*/src/**`)),
    );
  });

  it('reads the opaque arguments and the insert type in each spelling', () => {
    expect(opaqueWrites('tx.update(markets).set(patch).where(w)')).toEqual(['patch']);
    expect(opaqueWrites('tx.update(schema.markets)\n  .set(build(a, b))')).toEqual(['build(a, b)']);
    expect(
      opaqueWrites(
        "db.insert(markets).values({ slug, ...rest, note: 'a, ...b', at: sql`${x}, ${y}`, ...(c ? { d } : {}) })",
      ),
    ).toEqual(['...rest', '...(c ? { d } : {})']);
    expect(opaqueWrites("tx.update(markets).set({ status: 'open', updatedAt: now })")).toEqual([]);
    expect(opaqueWrites('tx.update(orders).set(patch)')).toEqual([]);
    // An upsert: the `set` of its onConflictDoUpdate is an argument as `.values` is.
    expect(
      opaqueWrites(
        'db.insert(markets).values({ slug }).onConflictDoUpdate({ target: markets.slug, set: patch })',
      ),
    ).toEqual(['patch']);
    expect(
      opaqueWrites(
        'db.insert(markets).values(row).onConflictDoUpdate({ target: markets.slug, set: { title, ...more } })',
      ),
    ).toEqual(['row', '...more']);
    expect(
      opaqueWrites('db.insert(schema.markets).values({ slug }).onConflictDoUpdate(config)'),
    ).toEqual(['config']);
    expect(
      opaqueWrites('db.insert(markets).values({ slug }).onConflictDoUpdate({ target, set })'),
    ).toEqual(['set']);
    expect(
      opaqueWrites(
        'db.insert(markets).values({ slug }); db.insert(orders).values(o).onConflictDoUpdate(c)',
      ),
    ).toEqual([]);
    // A `;` or a bracket in a comment or a string ends nothing, and a comment hides no spread.
    expect(
      opaqueWrites("tx\n  .update(markets)\n  // the fill's price; see #121\n  .set(patch)"),
    ).toEqual(['patch']);
    expect(opaqueWrites("tx.update(markets).set({ note: 'x)', /* a; ( */ ...rest })")).toEqual([
      '...rest',
    ]);
    expect(opaqueWrites('tx.update(markets).set({ title, // why\n ...rest })')).toEqual([
      '...rest',
    ]);
    expect(
      opaqueWrites('tx.update(markets).set({ re: /[;)]/g, at: sql`a; ${f(x)})` , ...rest })'),
    ).toEqual(['...rest']);
    // An insert from a select hands over a query or SQL: never a literal, so always pinned.
    expect(
      opaqueWrites(
        'await tx.insert(schema.markets).select(tx.select({ ...getTableColumns(schema.markets), id: sql`gen_random_uuid()`, slug }).from(schema.markets).where(eq(schema.markets.id, sourceId)))',
      ),
    ).toEqual([
      'tx.select({ ...getTableColumns(schema.markets), id: sql`gen_random_uuid()`, slug }).from(schema.markets).where(eq(schema.markets.id, sourceId))',
    ]);
    expect(opaqueWrites('tx.insert(markets).select(sql`SELECT * FROM markets`)')).toEqual([
      'sql`SELECT * FROM markets`',
    ]);
    expect(
      opaqueWrites('tx.insert(markets).select((qb) => qb.select({ slug }).from(other))'),
    ).toEqual(['(qb) => qb.select({ slug }).from(other)']);
    // A read whose own `.select(` follows an earlier write's statement is none.
    expect(opaqueWrites('tx.update(markets).set({ title }); tx.select({ slug }).from(m)')).toEqual(
      [],
    );
    // Each occurrence: a second write passing a pinned name is a second argument.
    expect(
      opaqueWrites(
        'const set: MarketRowWrite = { updatedAt: now };\nawait tx.update(schema.markets).set(set);\nconst set2 = 1;\nawait tx.update(schema.markets).set(set).where(w);',
      ),
    ).toEqual(['set', 'set']);
    for (const text of [
      'type R = typeof markets.$inferInsert;',
      'type R = typeof schema.markets.$inferInsert;',
      "type R = (typeof markets)['$inferInsert'];",
      'type R = InferInsertModel<typeof markets>;',
      'type R = InferInsertModel<typeof schema.markets>;',
      'const set: PgUpdateSetSource<typeof markets> = {};',
      'const row: PgInsertValue<typeof schema.markets> = r;',
    ]) {
      expect(NAMES_INSERT_TYPE.test(text), text).toBe(true);
    }
    for (const text of [
      'type R = typeof orders.$inferInsert;',
      'type R = typeof markets.$inferSelect;',
      'type R = InferInsertModel<typeof marketEvents>;',
    ]) {
      expect(NAMES_INSERT_TYPE.test(text), text).toBe(false);
    }
  });

  it('catches each way of writing them, and no read or mapper', () => {
    for (const text of [
      'await tx\n  .update(markets)\n  .set({ lastPrice: 52, updatedAt: now })',
      'tx.update(schema.markets).set({ status, volumeCoin: sql`x` }).where(w)',
      'db.insert(markets).values({ slug, tradeCount: 3 })',
      'tx.update(markets).set({ title, traderCount }).where(w)',
      'sql`UPDATE markets SET trade_count = trade_count + 1 WHERE id = ${id}`',
      'sql`update "markets" m set last_fill_at = now()`',
      'sql`UPDATE ${schema.markets} SET volume_coin = 0`',
      'sql`INSERT INTO public.markets (slug, last_price) VALUES ($1, $2)`',
      // Upserts: the conflict branch writes as an UPDATE does (drizzle and raw), and a MERGE.
      'db.insert(markets).values({ slug, title }).onConflictDoUpdate({ target: markets.slug, set: { title, tradeCount: 0, volumeCoin: 0n } })',
      'tx.insert(schema.markets)\n  .values(row)\n  .onConflictDoUpdate({\n    target: markets.slug,\n    set: { lastPrice: null },\n  })',
      'sql`INSERT INTO markets (slug, title) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET title = excluded.title, trade_count = 0`',
      'sql`MERGE INTO markets m USING src s ON m.slug = s.slug WHEN MATCHED THEN UPDATE SET volume_coin = 0`',
      'sql`MERGE INTO markets m USING src s ON m.slug = s.slug WHEN NOT MATCHED THEN INSERT (slug, trader_count) VALUES (s.slug, 0)`',
      // A `;` or an unbalanced bracket in a comment, a string or a template ends nothing.
      "tx\n  .update(markets)\n  // the fill's price; see #121\n  .set({ lastPrice: 52 })",
      "db.insert(markets).values({ slug, description: 'a; b' }).onConflictDoUpdate({ target: markets.slug, set: { tradeCount: 0 } })",
      'tx.update(markets) /* a; b */ .set({ volumeCoin: 0n })',
      "tx.update(markets).set({ note: 'x)', lastPrice: 1 })",
      'tx.update(markets).set({ at: sql`${a}; (`, traderCount: 0 })',
      // An insert from a select naming a field, and raw INSERTs with no column list (by position).
      'tx.insert(markets).select(tx.select({ slug, lastPrice: other.lastPrice }).from(other))',
      'tx.insert(schema.markets).select((qb) => qb.select({ slug, tradeCount: sql`3` }).from(o))',
      'sql`INSERT INTO markets SELECT * FROM markets WHERE id = ${id}`',
      'sql`insert into public.markets values ($1, $2)`',
      'sql`INSERT INTO ${schema.markets} AS m OVERRIDING SYSTEM VALUE VALUES ($1)`',
      'sql`INSERT INTO markets AS m (slug, volume_coin) VALUES ($1, 0)`',
      'sql`MERGE INTO markets m USING src s ON m.slug = s.slug WHEN NOT MATCHED THEN INSERT VALUES (s.slug)`',
    ]) {
      expect(writesStats(text), text).toBe(true);
    }
    for (const text of [
      'tx.select({ lastPrice: markets.lastPrice }).from(markets)',
      'return { lastPrice: row.lastPrice, tradeCount: row.tradeCount };',
      "tx.update(markets).set({ status: 'closed', updatedAt: now }).where(w); const x = { lastPrice: 1 };",
      'sql`SELECT last_price, trade_count FROM markets WHERE id = ${id}`',
      "sql`UPDATE markets SET status = 'open' WHERE trade_count = 0`",
      'tx.update(orders).set({ filledQty: 1 })',
      '// an update of markets moves volume_coin later',
      "db.insert(markets).values({ slug }).onConflictDoUpdate({ target: markets.slug, set: { title, status: 'draft' } })",
      'db.insert(markets).values({ slug }).onConflictDoNothing()',
      'sql`INSERT INTO markets (slug) VALUES ($1) ON CONFLICT (slug) DO UPDATE SET title = excluded.title WHERE markets.trade_count = 0`',
      'sql`MERGE INTO markets m USING src s ON m.id = s.id WHEN MATCHED AND m.trade_count = 0 THEN UPDATE SET title = s.title`',
      'sql`INSERT INTO markets DEFAULT VALUES`',
      'sql`INSERT INTO market_events (market_id, type) VALUES ($1, $2)`',
      'tx.insert(markets).select(tx.select({ slug, title }).from(drafts))',
    ]) {
      expect(writesStats(text), text).toBe(false);
    }
  });

  it('ties a pinned variable to its declarations and a pinned helper to its return type', () => {
    const typed = 'const set: MarketRowWrite = { updatedAt: now };';
    expect(variableTyped(typed, 'set')).toBe(true);
    // A second, untyped declaration of the same name in the file fails, wherever it is.
    expect(variableTyped(`${typed}\nconst set = { updatedAt: now, lastPrice: null };`, 'set')).toBe(
      false,
    );
    expect(variableTyped('let set = {};', 'set')).toBe(false);
    expect(variableTyped('// const set = {}\nconst settings = 1;', 'set')).toBe(false);
    expect(variableTyped(`${typed}\nconst settings = { lastPrice: 1 };`, 'set')).toBe(true);
    expect(
      helperTyped(
        'export function timeColumns(t: T) {\n  const at = (x) => x;\n  return { closeAt: at(t) } satisfies MarketRowWrite;\n}',
        'timeColumns',
      ),
    ).toBe(true);
    expect(
      helperTyped(
        '  private changedColumns(checked: C): MarketRowWrite {\n    return {};\n  }',
        'changedColumns',
      ),
    ).toBe(true);
    // Its annotation dropped, a `return` left bare, or only a call found: no.
    expect(
      helperTyped(
        'export function timeColumns(t: T) {\n  return { closeAt: t };\n}',
        'timeColumns',
      ),
    ).toBe(false);
    expect(
      helperTyped(
        'function f(t: T) {\n  if (t) return { a: 1 } satisfies MarketRowWrite;\n  return { lastPrice: 1 };\n}',
        'f',
      ),
    ).toBe(false);
    expect(helperTyped('const x = { ...timeColumns(times) };', 'timeColumns')).toBe(false);
  });
});
