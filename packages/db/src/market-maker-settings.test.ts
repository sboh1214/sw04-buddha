import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readMarketMakerStageSettings } from './market-maker-settings.js';
import { createUser, setReleaseSetting } from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';

describe.skipIf(!hasTestDb())('coupled MM stage settings snapshot (#129)', () => {
  let t: TestDb;
  let adminId: string;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    adminId = (await createUser(t.db, { role: 'admin' })).user.id;
  });
  const set = (field: string, value: number) =>
    setReleaseSetting(t.db, {
      adminId,
      key: `market_maker.${field}`,
      status: 'test',
      value,
    });

  it('cannot synthesize a valid combination from concurrently committed invalid versions', async () => {
    await set('reduce_at_bp', 9000);
    await set('halt_at_bp', 7000);
    await set('reduce_ratio_bp', 5000);
    let statements = 0;
    // After the first SELECT has obtained its actual PostgreSQL result, another connection
    // commits two edits. All three real database states are invalid (reduce > halt), while
    // the old three-query reader incorrectly combined 9000 from before with 9500 from after.
    const intercept = <T extends object>(target: T): T =>
      new Proxy(target, {
        get(object, key, receiver) {
          const value: unknown = Reflect.get(object, key, receiver);
          if (key === 'then')
            return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
              Promise.resolve(object as PromiseLike<unknown>)
                .then(async (rows) => {
                  statements++;
                  if (statements === 1) {
                    await set('reduce_at_bp', 10000);
                    await set('halt_at_bp', 9500);
                  }
                  return rows;
                })
                .then(resolve, reject);
          if (typeof value === 'function')
            return (...args: unknown[]) => {
              const result: unknown = Reflect.apply(value, object, args);
              return result !== null && typeof result === 'object' ? intercept(result) : result;
            };
          return value;
        },
      });
    const result = await t.db.transaction((tx) => readMarketMakerStageSettings(intercept(tx)), {
      isolationLevel: 'read committed',
    });
    expect(result).toEqual({ kind: 'unavailable', reason: 'invalid' });
    expect(statements).toBe(1);
    expect(await readMarketMakerStageSettings(t.db)).toEqual({
      kind: 'unavailable',
      reason: 'invalid',
    });
  });

  it('keeps absent settings undecided and reads one explicit valid combination', async () => {
    expect(await readMarketMakerStageSettings(t.db)).toEqual({
      kind: 'unavailable',
      reason: 'undecided',
    });
    await set('reduce_at_bp', 7000);
    await set('halt_at_bp', 9000);
    await set('reduce_ratio_bp', 5000);
    expect(await readMarketMakerStageSettings(t.db)).toEqual({
      kind: 'ready',
      settings: { reduceAtBp: 7000, haltAtBp: 9000, reduceRatioBp: 5000 },
    });
  });
});
