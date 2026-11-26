import assert from "node:assert/strict";
import test from "node:test";

import { envelopeTitleSchema } from "./schemas/common.ts";
import {
  getPdfImportErrorMessage,
  type PdfImportFailureCode,
} from "./services/document-import.ts";
import {
  classifyEnvelopeCreateFailure,
  ENVELOPE_TITLE_MAX_LENGTH,
  ENVELOPE_TITLE_REQUIRED_MESSAGE,
  ENVELOPE_TITLE_TOO_LONG_MESSAGE,
  getEnvelopeTitleLengthError,
  suggestEnvelopeTitle,
  validateEnvelopeTitle,
} from "./upload-validation.ts";

test("envelope title validation enforces the 160-character trimmed limit (issue #210)", () => {
  const exactLimitTitle = "A".repeat(ENVELOPE_TITLE_MAX_LENGTH);
  const overLimitTitle = "A".repeat(ENVELOPE_TITLE_MAX_LENGTH + 1);

  assert.equal(getEnvelopeTitleLengthError(""), null);
  assert.equal(getEnvelopeTitleLengthError(exactLimitTitle), null);
  assert.equal(getEnvelopeTitleLengthError(`  ${exactLimitTitle}  `), null);
  assert.equal(
    getEnvelopeTitleLengthError(overLimitTitle),
    ENVELOPE_TITLE_TOO_LONG_MESSAGE,
  );
  assert.equal(
    getEnvelopeTitleLengthError(`  ${overLimitTitle}  `),
    ENVELOPE_TITLE_TOO_LONG_MESSAGE,
  );

  assert.equal(validateEnvelopeTitle(""), ENVELOPE_TITLE_REQUIRED_MESSAGE);
  assert.equal(validateEnvelopeTitle("   "), ENVELOPE_TITLE_REQUIRED_MESSAGE);
  assert.equal(validateEnvelopeTitle("NDA"), null);
  assert.equal(validateEnvelopeTitle(exactLimitTitle), null);
  assert.equal(validateEnvelopeTitle(` ${exactLimitTitle} `), null);
  assert.equal(
    validateEnvelopeTitle(overLimitTitle),
    ENVELOPE_TITLE_TOO_LONG_MESSAGE,
  );
});

test("suggested titles from long PDF filenames stay within 160 well-formed characters", () => {
  assert.equal(
    suggestEnvelopeTitle("nda-client-bravo-2026.pdf"),
    "NDA - Client Bravo",
  );
  assert.equal(
    suggestEnvelopeTitle("master_service-agreement2026.pdf"),
    "master service agreement2026",
  );

  const longSuggestion = suggestEnvelopeTitle(`${"a".repeat(185)}.pdf`);

  assert.equal(longSuggestion.length, ENVELOPE_TITLE_MAX_LENGTH);
  assert.equal(envelopeTitleSchema.safeParse(longSuggestion).success, true);

  // An emoji sitting across the 160-code-unit boundary is dropped whole rather
  // than split into a lone surrogate.
  const emojiBoundary = suggestEnvelopeTitle(`${"a".repeat(159)}📄rest.pdf`);

  assert.equal(emojiBoundary, "a".repeat(159));
  assert.equal(emojiBoundary.isWellFormed(), true);
  assert.equal(envelopeTitleSchema.safeParse(emojiBoundary).success, true);
});

test("HTTP 400 title validation errors keep the selected PDF and normalize Zod text", () => {
  const tooLongParse = envelopeTitleSchema.safeParse(
    "A".repeat(ENVELOPE_TITLE_MAX_LENGTH + 1),
  );

  assert.equal(tooLongParse.success, false);
  assert.deepEqual(
    classifyEnvelopeCreateFailure({
      error: tooLongParse.error.issues[0]?.message,
      status: 400,
    }),
    {
      clearSelectedFile: false,
      message: ENVELOPE_TITLE_TOO_LONG_MESSAGE,
      target: "title",
    },
  );

  const emptyParse = envelopeTitleSchema.safeParse("   ");

  assert.equal(emptyParse.success, false);
  assert.deepEqual(
    classifyEnvelopeCreateFailure({
      error: emptyParse.error.issues[0]?.message,
      status: 400,
    }),
    {
      clearSelectedFile: false,
      message: ENVELOPE_TITLE_REQUIRED_MESSAGE,
      target: "title",
    },
  );

  const missingParse = envelopeTitleSchema.safeParse(null);

  assert.equal(missingParse.success, false);
  assert.deepEqual(
    classifyEnvelopeCreateFailure({
      error: missingParse.error.issues[0]?.message,
      status: 400,
    }),
    {
      clearSelectedFile: false,
      message: ENVELOPE_TITLE_REQUIRED_MESSAGE,
      target: "title",
    },
  );
});

test("HTTP 400/413 PDF defects still clear the invalid selected PDF", () => {
  const fileDefectCodes: readonly PdfImportFailureCode[] = [
    "encrypted_pdf",
    "invalid_type",
    "too_large",
    "too_many_pages",
    "unreadable_pdf",
    "unsupported_variant",
  ];

  for (const code of fileDefectCodes) {
    const message = getPdfImportErrorMessage(code);

    assert.deepEqual(
      classifyEnvelopeCreateFailure({ error: message, status: 400 }),
      {
        clearSelectedFile: true,
        message,
        target: "upload",
      },
      `expected ${code} to clear the selected file`,
    );
  }

  for (const message of [
    "A PDF file is required.",
    "The upload could not be read. Choose the PDF again and retry.",
    "This PDF has no pages. Please upload a valid PDF.",
  ]) {
    assert.deepEqual(
      classifyEnvelopeCreateFailure({ error: message, status: 400 }),
      {
        clearSelectedFile: true,
        message,
        target: "upload",
      },
    );
  }

  assert.deepEqual(
    classifyEnvelopeCreateFailure({
      error: "This file exceeds the 20 MB limit.",
      status: 413,
    }),
    {
      clearSelectedFile: true,
      message: "This file exceeds the 20 MB limit.",
      target: "upload",
    },
  );
});

test("non-file upload, direct-upload, rate-limit, and server errors keep the selected PDF", () => {
  const nonFileFailures = [
    { error: getPdfImportErrorMessage("upload_failed"), status: 400 },
    { error: "Invalid envelope request.", status: 400 },
    { error: "Direct uploads are not available on this install.", status: 400 },
    { error: "Invalid upload reference.", status: 400 },
    {
      error: "The uploaded file was not found. Please upload it again.",
      status: 400,
    },
    { error: "Too many requests. Try again shortly.", status: 429 },
    { error: "Unable to create the draft envelope.", status: 500 },
  ];

  for (const failure of nonFileFailures) {
    assert.deepEqual(classifyEnvelopeCreateFailure(failure), {
      clearSelectedFile: false,
      message: failure.error,
      target: "upload",
    });
  }

  assert.deepEqual(
    classifyEnvelopeCreateFailure({ error: null, status: 400 }),
    {
      clearSelectedFile: false,
      message: "Something went wrong. Please try again.",
      target: "upload",
    },
  );
});
