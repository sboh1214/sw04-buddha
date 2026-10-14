import { createTransport, type Transporter } from 'nodemailer';

export interface MailerOptions {
  /** SMTP host (Mailpit locally, `email-smtp.<region>.amazonaws.com` for SES). */
  host: string;
  port: number;
  /** RFC 5322 From header: a bare address or `Name <address>`. */
  from: string;
  /** SMTP credentials (SES "SMTP credentials"). Absent for Mailpit. */
  auth?: { user: string; pass: string } | undefined;
  /** Implicit TLS from the first byte (port 465). Default false: plain or STARTTLS. */
  secure?: boolean | undefined;
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
 * SMTP mailer (nodemailer 9). Locally the target is Mailpit (docker/docker-compose.yml):
 * no auth, no TLS. In production it is AWS SES over its SMTP interface (PLAN 17 Q3,
 * decision 2026-09-03): with credentials present the connection must be encrypted, so
 * STARTTLS is required unless `secure` (implicit TLS) is on; credentials are never sent
 * over a plain connection.
 *
 * Tests must not hit SMTP: override the MAILER provider with an in-memory implementation
 * of this interface (see test/memory-mailer.ts).
 */
export function createMailer(options: MailerOptions): Mailer {
  const secure = options.secure ?? false;
  const transporter: Transporter = createTransport({
    host: options.host,
    port: options.port,
    secure,
    ...(options.auth ? { auth: options.auth, requireTLS: !secure } : {}),
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  });
  return {
    async send(message) {
      // Each key of the MailMessage by name, and nothing of the transport's own: what reaches
      // SMTP is what a template built and where it goes, never another key a caller's object
      // carries (attachments, amp, headers). templates.test.ts holds this file to it (#113).
      await transporter.sendMail({
        from: options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
    async verify() {
      await transporter.verify();
    },
    close() {
      transporter.close();
    },
  };
}
