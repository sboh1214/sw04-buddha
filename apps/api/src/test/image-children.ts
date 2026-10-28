// Conversions in a process of their own (`image-child.mjs`), for the memory suites of #46
// (`media/image-memory.test.ts`) and #141 (`media/profile-image-memory.test.ts`): what one whole
// conversion adds to a process's resident memory, which neither libvips' own count nor a test
// process that has converted before can tell (ADR-0073 9-8, ADR-0079).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const IMAGE_CHILD = path.join(import.meta.dirname, 'image-child.mjs');
const run = promisify(execFile);

/** What `image-child.mjs convert` and `convert-profile` print. */
export interface ChildConversion {
  peakBytes: number;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

/** The input a case converts, as `image-child.mjs make` takes it. */
export interface ChildInput {
  format: 'jpeg' | 'png' | 'gif' | 'webp';
  width: number;
  height: number;
  channels?: 3 | 4;
  frames?: number;
  content?: 'noise' | 'frames' | 'flat';
  alphaLevels?: number;
  /** A JPEG of four components. */
  colourspace?: 'cmyk';
  encoder?: Record<string, unknown>;
}

/** sharp's name of each image type, as the child's `toFormat` takes it. */
export const SHARP_FORMAT = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
} as const;

/**
 * The glibc allocator's setting the API's image starts the API with (the Dockerfile's `api` stage,
 * ADR-0073 9-46): the children convert with it, as production does.
 */
export function apiAllocatorEnv(): Record<string, string> {
  const dockerfile = readFileSync(new URL('../../../../Dockerfile', import.meta.url), 'utf8');
  const api = /^FROM \S+ AS api\n([\s\S]*?)^FROM /m.exec(dockerfile)?.[1] ?? '';
  const threshold = /MALLOC_MMAP_THRESHOLD_=(\d+)/.exec(api)?.[1];
  if (threshold === undefined) throw new Error('the api image sets no MALLOC_MMAP_THRESHOLD_');
  return { MALLOC_MMAP_THRESHOLD_: threshold };
}

/** Writes the file a case converts (`image-child.mjs make`), made in a process of its own. */
export async function makeInChild(input: ChildInput, file: string): Promise<void> {
  await run(process.execPath, [IMAGE_CHILD, 'make', JSON.stringify(input), file], {
    maxBuffer: 1024 * 1024,
  });
}

/**
 * Converts `file` in a process of its own with the allocator's setting of the API's image:
 * `convert` is processImage's pipeline, `convert-profile` processProfileImage's — `options` what
 * image.ts decides of the file, as JSON (`image-child.mjs` says which).
 */
export async function convertInChild(
  mode: 'convert' | 'convert-profile',
  file: string,
  options: object,
): Promise<ChildConversion> {
  const { stdout } = await run(
    process.execPath,
    [IMAGE_CHILD, mode, file, JSON.stringify(options)],
    { maxBuffer: 1024 * 1024, env: { ...process.env, ...apiAllocatorEnv() } },
  );
  return JSON.parse(stdout) as ChildConversion;
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * How many times a Linux check converts each case, each in a new process: one case moves by 10MiB
 * or so from run to run (the allocator, ADR-0073 결과 5), so the median is what is checked.
 */
export const CONVERSION_RUNS = 3;

/** The middle of an odd count of values. */
export const median = (values: readonly number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
