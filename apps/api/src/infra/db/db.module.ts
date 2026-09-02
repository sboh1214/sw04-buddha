import { Inject, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { closeDb, type Db } from '@buddha/db';
import { DB, dbProvider } from './db.provider.js';

@Module({
  providers: [dbProvider],
  exports: [DB],
})
export class DbModule implements OnModuleDestroy {
  private readonly logger = new Logger(DbModule.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  async onModuleDestroy(): Promise<void> {
    // Triggered by enableShutdownHooks() in main.ts.
    await closeDb(this.db);
    this.logger.log('Postgres pool closed');
  }
}
