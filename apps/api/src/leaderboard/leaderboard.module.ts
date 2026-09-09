import { Module } from '@nestjs/common';
import { DbModule } from '../infra/db/db.module.js';
import { LeaderboardController } from './leaderboard.controller.js';
import { LeaderboardService } from './leaderboard.service.js';

/** PLAN M6's optional global ranking — the forerunner of the group milestone's rankings. */
@Module({
  imports: [DbModule],
  controllers: [LeaderboardController],
  providers: [LeaderboardService],
})
export class LeaderboardModule {}
