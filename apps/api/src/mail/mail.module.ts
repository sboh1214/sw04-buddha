import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { MAILER, mailerProvider } from './mail.provider.js';
import { type Mailer } from './mailer.js';

@Module({
  providers: [mailerProvider],
  exports: [MAILER],
})
export class MailModule implements OnApplicationShutdown {
  constructor(@Inject(MAILER) private readonly mailer: Mailer) {}

  onApplicationShutdown(): void {
    this.mailer.close();
  }
}
