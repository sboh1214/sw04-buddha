import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { LEADERBOARD_LIMIT, leaderboardEntrySchema, type LeaderboardEntry } from '@buddha/shared';
import { ApiData } from '../common/openapi/api-response.decorators.js';
import { LeaderboardService } from './leaderboard.service.js';

/**
 * `GET /api/v1/leaderboard` (PLAN M6 선택). Public, with the same reasoning as the market reads:
 * PLAN 7.1's "정보 조회 (공개)" routes serve anonymous visitors, and a ranking of nicknames holds
 * nothing a signed-in session would be needed to see. It carries no cursor and no query
 * parameters, so it also has no `VALIDATION_ERROR` to document.
 */
@ApiTags('leaderboard')
@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  @ApiOperation({
    operationId: 'listLeaderboard',
    summary: `Top ${String(LEADERBOARD_LIMIT)} accounts by realized profit and loss, ties broken deterministically`,
  })
  @ApiData(leaderboardEntrySchema.array())
  listLeaderboard(): Promise<LeaderboardEntry[]> {
    return this.leaderboard.top();
  }
}
