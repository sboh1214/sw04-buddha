import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { publicIdParamSchema, publicProfileSchema, type PublicProfile } from '@buddha/shared';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { ProfilesService } from './profiles.service.js';

/**
 * `/api/v1/profiles` (#41, ADR-0078): the public profile behind `/u/<publicId>`. Public — anyone
 * reads it, signed in or not (ADR-0069 decision 3 #37-1; the web keeps search engines away) — and
 * the same answer for every reader. It names the member by the public face alone (ADR-0069
 * decision 5; registry.ts `showsPerson`). The member's own edits are owner routes under `/me`
 * (`PUT /me/bio`, `PUT /me/interest-categories`, `PATCH /me`).
 */
@ApiTags('profiles')
@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get(':publicId')
  @ApiOperation({
    operationId: 'getProfile',
    summary:
      'A member’s public profile: the nickname, the image, the 운영자 mark, the bio, the interest ' +
      'categories, the month joined, and the counts of visible posts, comments and the likes they ' +
      'received; an unknown public id is NOT_FOUND',
  })
  @ApiData(publicProfileSchema)
  @ApiErrors('NOT_FOUND')
  get(
    @Param('publicId', { schema: publicIdParamSchema }) publicId: string,
  ): Promise<PublicProfile> {
    return this.profiles.getProfile(publicId);
  }
}
