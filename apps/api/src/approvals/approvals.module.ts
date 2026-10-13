import { Module } from '@nestjs/common';
import { DbModule } from '../infra/db/db.module.js';
import { ApprovalService } from './approval.service.js';

/**
 * The two-person rule (#171), for the modules whose work needs another admin's approval to
 * import. No route of its own: each consumer exposes its requests and decisions on its own
 * admin routes.
 */
@Module({
  imports: [DbModule],
  providers: [ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalsModule {}
