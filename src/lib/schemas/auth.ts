import { z } from "zod";

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../password-messages.ts";
import {
  emailSchema,
  idSchema,
  nameSchema,
  unixTimestampSchema,
} from "./common.ts";

export const accountClosureConfirmationPhrase = "close my account" as const;

// Passwords are never trimmed: leading and trailing spaces are valid
// characters and must reach Better Auth verbatim on sign-up, sign-in,
// password change and password reset (issue #207).
const existingPasswordSchema = z.string().min(1);
const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH);

export const signUpSchema = z.object({
  fullName: nameSchema,
  email: emailSchema,
  password: newPasswordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: existingPasswordSchema,
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  newPassword: newPasswordSchema,
});

export const updateProfileSchema = z.object({
  fullName: nameSchema,
  email: emailSchema,
});

export const updatePasswordSchema = z.object({
  currentPassword: existingPasswordSchema,
  newPassword: newPasswordSchema,
});

export const accountClosureRequestSchema = z.object({
  confirmation: z.literal(accountClosureConfirmationPhrase),
});

export const senderProfileSchema = z.object({
  id: idSchema,
  fullName: nameSchema,
  email: emailSchema,
});

export const senderSessionSchema = z.object({
  user: senderProfileSchema,
  expiresAt: unixTimestampSchema.nullable().optional(),
});

export type SignUpInput = z.infer<typeof signUpSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type UpdatePasswordInput = z.infer<typeof updatePasswordSchema>;
export type AccountClosureRequestInput = z.infer<
  typeof accountClosureRequestSchema
>;
export type SenderProfile = z.infer<typeof senderProfileSchema>;
export type SenderSession = z.infer<typeof senderSessionSchema>;
