import { createTransport, type Transporter } from 'nodemailer';

export interface MailerOptions {
  /** SMTP host (Mailpit locally). */
  host: string;
  port: number;
  /** RFC 5322 From header: a bare address or `Name <address>`. */
  from: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  /** Opens and closes one SMTP connection; rejects when the server is unreachable. */
  verify(): Promise<void>;
  close(): void;
}

/**
 * Plain SMTP mailer (nodemailer 9). No auth and no TLS: the only target in this milestone
 * is Mailpit (docker/docker-compose.yml). A real provider (M6+) adds SMTP_USER/SMTP_PASS
 * and `secure`/STARTTLS here; nodemailer still upgrades opportunistically when the server
 * advertises STARTTLS, which Mailpit does not by default.
 *
 * Tests must not hit SMTP: override the MAILER provider with an in-memory implementation
 * of this interface (see test/memory-mailer.ts).
 */
export function createMailer(options: MailerOptions): Mailer {
  const transporter: Transporter = createTransport({
    host: options.host,
    port: options.port,
    secure: false,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  });
  return {
    async send(message) {
      await transporter.sendMail({ from: options.from, ...message });
    },
    async verify() {
      await transporter.verify();
    },
    close() {
      transporter.close();
    },
  };
}
