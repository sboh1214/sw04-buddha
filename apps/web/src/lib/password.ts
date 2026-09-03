import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@buddha/shared';
import * as z from 'zod';
import { copy } from '@/copy';

/** Same bounds as the API (PLAN 10.2); only the message is localised here. */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, copy.errPasswordTooShort)
  .max(PASSWORD_MAX_LENGTH, copy.errPasswordTooLong);

/** `{ newPassword, newPasswordConfirm }` with the confirmation checked. */
export const newPasswordSchema = z
  .object({ newPassword: passwordSchema, newPasswordConfirm: z.string() })
  .refine((v) => v.newPassword === v.newPasswordConfirm, {
    message: copy.errPasswordMismatch,
    path: ['newPasswordConfirm'],
  });
export type NewPasswordValues = z.infer<typeof newPasswordSchema>;
