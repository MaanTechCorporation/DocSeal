import assert from "node:assert/strict";
import test from "node:test";

import {
  loginSchema,
  resetPasswordSchema,
  signUpSchema,
  updatePasswordSchema,
} from "./auth.ts";
import { signingSubmissionSchema } from "./field.ts";
import { signerCheckRequestSchema } from "./signing.ts";

const PADDED_PASSWORD = "  amber river morning compass  ";

test("loginSchema preserves leading and trailing spaces in passwords while trimming email (issue #207)", () => {
  const parsed = loginSchema.parse({
    email: "  sender@example.com  ",
    password: PADDED_PASSWORD,
  });

  assert.equal(parsed.email, "sender@example.com");
  assert.equal(parsed.password, PADDED_PASSWORD);

  assert.equal(
    loginSchema.parse({
      email: "sender@example.com",
      password: "   leading only",
    }).password,
    "   leading only",
  );
  assert.equal(
    loginSchema.parse({
      email: "sender@example.com",
      password: "trailing only   ",
    }).password,
    "trailing only   ",
  );
  assert.equal(
    loginSchema.parse({
      email: "sender@example.com",
      password: " ".repeat(15),
    }).password,
    " ".repeat(15),
  );

  // Overlong passwords pass schema parsing so the login form can surface
  // Better Auth's PASSWORD_TOO_LONG message instead of "Enter your password" (#57).
  const overlong = `  ${"a".repeat(127)}  `;

  assert.equal(
    loginSchema.parse({ email: "sender@example.com", password: overlong })
      .password,
    overlong,
  );

  assert.equal(
    loginSchema.safeParse({ email: "sender@example.com", password: "" })
      .success,
    false,
  );
  assert.equal(
    loginSchema.safeParse({ email: "not-an-email", password: PADDED_PASSWORD })
      .success,
    false,
  );
});

test("signUpSchema preserves surrounding spaces and counts them in password length bounds", () => {
  const parsed = signUpSchema.parse({
    email: "  sender@example.com  ",
    fullName: "  Jane Smith  ",
    password: PADDED_PASSWORD,
  });

  assert.deepEqual(parsed, {
    email: "sender@example.com",
    fullName: "Jane Smith",
    password: PADDED_PASSWORD,
  });

  // 15 characters total (11 trimmed): valid because spaces are part of the password.
  const fifteenWithSpaces = "  elevenchars  ";

  assert.equal(fifteenWithSpaces.length, 15);
  assert.equal(
    signUpSchema.parse({
      email: "sender@example.com",
      fullName: "Jane Smith",
      password: fifteenWithSpaces,
    }).password,
    fifteenWithSpaces,
  );

  assert.equal(
    signUpSchema.safeParse({
      email: "sender@example.com",
      fullName: "Jane Smith",
      password: "  short  ",
    }).success,
    false,
  );
  assert.equal(
    signUpSchema.safeParse({
      email: "sender@example.com",
      fullName: "Jane Smith",
      password: "",
    }).success,
    false,
  );

  const atLimit = ` ${"a".repeat(126)} `;
  const overLimit = ` ${"a".repeat(127)} `;

  assert.equal(atLimit.length, 128);
  assert.equal(overLimit.length, 129);
  assert.equal(
    signUpSchema.parse({
      email: "sender@example.com",
      fullName: "Jane Smith",
      password: atLimit,
    }).password,
    atLimit,
  );
  assert.equal(
    signUpSchema.safeParse({
      email: "sender@example.com",
      fullName: "Jane Smith",
      password: overLimit,
    }).success,
    false,
  );
});

test("updatePasswordSchema preserves surrounding spaces in both current and new passwords", () => {
  const newPasswordWithSpaces = "  thirteenchars  ";

  assert.equal(newPasswordWithSpaces.length, 17);
  const parsed = updatePasswordSchema.parse({
    currentPassword: PADDED_PASSWORD,
    newPassword: newPasswordWithSpaces,
  });

  assert.deepEqual(parsed, {
    currentPassword: PADDED_PASSWORD,
    newPassword: newPasswordWithSpaces,
  });

  assert.equal(
    updatePasswordSchema.safeParse({
      currentPassword: "",
      newPassword: PADDED_PASSWORD,
    }).success,
    false,
  );
  assert.equal(
    updatePasswordSchema.safeParse({
      currentPassword: PADDED_PASSWORD,
      newPassword: "  too short  ",
    }).success,
    false,
  );
  assert.equal(
    updatePasswordSchema.safeParse({
      currentPassword: PADDED_PASSWORD,
      newPassword: ` ${"a".repeat(127)} `,
    }).success,
    false,
  );
});

test("resetPasswordSchema preserves surrounding spaces and enforces length bounds", () => {
  assert.equal(
    resetPasswordSchema.parse({ newPassword: PADDED_PASSWORD }).newPassword,
    PADDED_PASSWORD,
  );

  const fifteenWithSpaces = "  elevenchars  ";

  assert.equal(
    resetPasswordSchema.parse({ newPassword: fifteenWithSpaces }).newPassword,
    fifteenWithSpaces,
  );
  assert.equal(
    resetPasswordSchema.safeParse({ newPassword: "" }).success,
    false,
  );
  assert.equal(
    resetPasswordSchema.safeParse({ newPassword: "  too short  " }).success,
    false,
  );
  assert.equal(
    resetPasswordSchema.safeParse({ newPassword: ` ${"a".repeat(127)} ` })
      .success,
    false,
  );
});

test("Part 11 signing password schemas preserve surrounding spaces verbatim", () => {
  const accountCheck = signerCheckRequestSchema.parse({
    email: "  signer@example.com  ",
    method: "account",
    password: PADDED_PASSWORD,
  });

  assert.deepEqual(accountCheck, {
    email: "signer@example.com",
    method: "account",
    password: PADDED_PASSWORD,
  });
  assert.equal(
    signerCheckRequestSchema.safeParse({
      email: "signer@example.com",
      method: "account",
      password: "",
    }).success,
    false,
  );

  const submission = signingSubmissionSchema.parse({
    clientTimezoneOffsetMinutes: 0,
    fields: [],
    reauthentication: {
      email: "  signer@example.com  ",
      meaningConfirmed: true,
      password: PADDED_PASSWORD,
    },
  });

  assert.deepEqual(submission.reauthentication, {
    email: "signer@example.com",
    meaningConfirmed: true,
    password: PADDED_PASSWORD,
  });
});
