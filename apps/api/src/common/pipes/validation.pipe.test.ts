import { type ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { AppError } from '../errors/app-error.js';
import { NUL_MESSAGE, createValidationPipe, findNulPaths } from './validation.pipe.js';

const NUL = String.fromCharCode(0);

describe('findNulPaths', () => {
  it('returns no path for values without NUL, whatever their shape', () => {
    for (const value of [
      'plain',
      '',
      42,
      10n,
      null,
      undefined,
      true,
      new Date(),
      { a: 'x', b: ['y', { c: 'z' }], d: 5n, e: new Date() },
      [],
    ]) {
      expect(findNulPaths(value)).toEqual([]);
    }
  });

  it('names a bare string as the empty path', () => {
    expect(findNulPaths(`a${NUL}b`)).toEqual([[]]);
    expect(findNulPaths(NUL)).toEqual([[]]);
  });

  it('walks plain objects and arrays, reporting every offending path', () => {
    const value = {
      title: `t${NUL}`,
      fine: 'ok',
      nested: { rules: ['a', `b${NUL}`], deeper: { x: NUL } },
      list: [{ v: 'ok' }, { v: `${NUL}` }],
    };
    expect(findNulPaths(value)).toEqual([
      ['title'],
      ['nested', 'rules', 1],
      ['nested', 'deeper', 'x'],
      ['list', 1, 'v'],
    ]);
  });

  it('does not descend into class instances or buffers', () => {
    class Box {
      value = NUL;
    }
    expect(findNulPaths(new Box())).toEqual([]);
    expect(findNulPaths(Buffer.from([0]))).toEqual([]);
    expect(findNulPaths(new Map([['k', NUL]]))).toEqual([]);
    // A null-prototype object is still a plain bag of user input.
    const bare = Object.create(null) as Record<string, unknown>;
    bare.q = NUL;
    expect(findNulPaths(bare)).toEqual([['q']]);
  });
});

describe('ApiValidationPipe', () => {
  const pipe = createValidationPipe();
  const bodySchema = z.object({ title: z.string().trim().min(1), tags: z.string().array() });
  const meta = (overrides: Partial<ArgumentMetadata> = {}): ArgumentMetadata => ({
    type: 'body',
    schema: bodySchema,
    ...overrides,
  });

  it('passes a clean, parsed value through', async () => {
    const parsed = await pipe.transform({ title: '  ok  ', tags: ['a'] }, meta());
    expect(parsed).toEqual({ title: 'ok', tags: ['a'] });
  });

  it('refuses NUL after the schema accepted the value, naming each path', async () => {
    const promise = pipe.transform({ title: `x${NUL}`, tags: ['a', `b${NUL}`] }, meta());
    await expect(promise).rejects.toBeInstanceOf(AppError);
    await expect(promise).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
      details: [
        { path: ['title'], message: NUL_MESSAGE },
        { path: ['tags', 1], message: NUL_MESSAGE },
      ],
    });
  });

  it('keeps the schema issue when the schema itself fails', async () => {
    const promise = pipe.transform({ title: '', tags: [] }, meta());
    await expect(promise).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ path: ['title'] }],
    });
  });

  it('sweeps a schema-less param but not a custom decorator', async () => {
    const param = meta({ type: 'param', schema: undefined, data: 'id' });
    await expect(pipe.transform(NUL, param)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ path: [], message: NUL_MESSAGE }],
    });
    const custom = meta({ type: 'custom', schema: undefined });
    const user = { id: NUL };
    await expect(pipe.transform(user, custom)).resolves.toBe(user);
  });
});
