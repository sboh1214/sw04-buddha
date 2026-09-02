import { Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { closeDb, type Db } from '@buddha/db';
import { DB, dbProvider } from './db.provider.js';

@Module({
  providers: [dbProvider],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  private readonly logger = new Logger(DbModule.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  // onApplicationShutdown runs after the HTTP server has closed (in-flight requests are
  // done); onModuleDestroy would run before that and could end the pool under a handler.
  async onApplicationShutdown(): Promise<void> {
    await closeDb(this.db);
    this.logger.log('Postgres pool closed');
  }
}
