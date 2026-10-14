// The API's sources read as a TypeScript program, for the static suites that check a rule over
// EVERY file rather than over a list someone has to remember to extend (surface/registry.test.ts,
// mail/templates.test.ts).
import { readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** `apps/api/src`. */
export const SRC = path.resolve(import.meta.dirname, '..');

/** The API's own sources under `dir`: not a test, not the test support. */
export function sources(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full === path.join(SRC, 'test') ? [] : sources(full);
    return /\.ts$/.test(entry.name) && !/\.(test|d)\.ts$/.test(entry.name) ? [full] : [];
  });
}

/** `realtime/realtime.gateway.ts`: a file's path under `src/`, with forward slashes. */
export const srcPath = (file: string) => path.relative(SRC, file).split(path.sep).join('/');

/** The API's compiler options (tsconfig.json), to read the types of what the code does. */
const COMPILER_OPTIONS: ts.CompilerOptions = (() => {
  const configFile = path.resolve(SRC, '../tsconfig.json');
  const { config } = ts.readConfigFile(configFile, (name) => ts.sys.readFile(name)) as {
    config: unknown;
  };
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configFile));
  return { ...options, noEmit: true };
})();

/** A program over `roots`, with `planted` files (path → text) held in memory. */
export function programOf(
  roots: readonly string[],
  planted: Readonly<Record<string, string>> = {},
): ts.Program {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const disk = ts.createCompilerHost(COMPILER_OPTIONS, true);
  host.fileExists = (name) => name in planted || disk.fileExists(name);
  host.readFile = (name) => planted[name] ?? disk.readFile(name);
  host.getSourceFile = (name, language, ...rest) =>
    name in planted
      ? ts.createSourceFile(name, planted[name]!, language, true)
      : disk.getSourceFile(name, language, ...rest);
  return ts.createProgram({
    rootNames: [...roots, ...Object.keys(planted)],
    options: COMPILER_OPTIONS,
    host,
  });
}
