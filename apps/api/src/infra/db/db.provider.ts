import { type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDb, type Db } from '@buddha/db';
import { type Env } from '../../config/env.js';

/** Injection token for the Drizzle database handle from packages/db. */
export const DB = Symbol('DB');

export const dbProvider: Provider<Db> = {
  provide: DB,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): Db =>
    // node-postgres pools lazily: no connection is opened until the first query,
    // so bootstrap never blocks on the database.
    createDb(config.get('DATABASE_URL', { infer: true }), { applicationName: 'buddha-api' }),
};
