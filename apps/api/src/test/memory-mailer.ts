import { type Mailer, type MailMessage } from '../mail/mailer.js';

export interface MemoryMailer extends Mailer {
  /** Every message sent so far, oldest first. */
  messages: MailMessage[];
  /** Makes the next sends reject (simulates SMTP outages). */
  failNext(times: number): void;
}

/** In-memory Mailer for tests: records messages instead of talking SMTP. */
export function createMemoryMailer(): MemoryMailer {
  let failures = 0;
  const messages: MailMessage[] = [];
  return {
    messages,
    failNext(times) {
      failures = times;
    },
    async send(message) {
      if (failures > 0) {
        failures -= 1;
        throw new Error('smtp unavailable (memory mailer)');
      }
      messages.push(message);
      await Promise.resolve();
    },
    async verify() {
      await Promise.resolve();
    },
    close() {
      /* nothing to release */
    },
  };
}
