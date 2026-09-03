import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { MeController } from './me.controller.js';
import { MeService } from './me.service.js';

@Module({
  imports: [DbModule, AuthModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
