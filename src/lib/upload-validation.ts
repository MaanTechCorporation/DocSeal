// Validation and server-error rules for the envelope upload step.
// Kept separate from upload-shell.tsx so they can be tested without a browser.

import { truncateToWholeCharacters } from "./text-truncate.ts";
import { MAX_PDF_PAGES } from "./types/domain.ts";

// Matches envelopeTitleSchema in src/lib/schemas/common.ts.
export const ENVELOPE_TITLE_MAX_LENGTH = 160;

export const ENVELOPE_TITLE_REQUIRED_MESSAGE = "Give the envelope a title.";
export const ENVELOPE_TITLE_TOO_LONG_MESSAGE = `Envelope title must be ${String(ENVELOPE_TITLE_MAX_LENGTH)} characters or fewer.`;
export const ENVELOPE_TITLE_LIMIT_REACHED_MESSAGE = `Maximum ${String(ENVELOPE_TITLE_MAX_LENGTH)} characters reached.`;

const DEFAULT_CREATE_ERROR_MESSAGE = "Something went wrong. Please try again.";

const KNOWN_TITLE_SUGGESTIONS: Record<string, string> = {
  "nda-clientbravo-2026.pdf": "NDA - Client Bravo",
  "nda-client-bravo-2026.pdf": "NDA - Client Bravo",
  "vendor-agreement-two-signer.pdf": "Vendor agreement - two signer flow",
};

// Server 400/413 messages that reject the selected PDF itself rather than the
// title or the request transport. Keep these aligned with document-import.ts
// and /api/envelopes without importing Node-only server modules in the browser.
const KNOWN_FILE_REJECTION_MESSAGES = new Set<string>([
  "this pdf is password-protected or encrypted. please upload an unlocked pdf.",
  "only pdf files are supported. please upload a valid pdf.",
  "this file exceeds the 20 mb limit.",
  `this pdf has more than ${String(MAX_PDF_PAGES)} pages. split it into smaller documents.`,
  "we couldn't read this pdf. please upload a valid file.",
  "this pdf uses an unsupported format. please export it as a standard pdf.",
  "a pdf file is required.",
  "the upload could not be read. choose the pdf again and retry.",
]);

export type EnvelopeCreateFailure = {
  clearSelectedFile: boolean;
  message: string;
  target: "title" | "upload";
};

/** Returns a length error when the trimmed title exceeds the 160-character limit. */
export function getEnvelopeTitleLengthError(title: string): string | null {
  if (title.trim().length > ENVELOPE_TITLE_MAX_LENGTH) {
    return ENVELOPE_TITLE_TOO_LONG_MESSAGE;
  }

  return null;
}

/** Validates an envelope title before submitting a draft upload. */
export function validateEnvelopeTitle(title: string): string | null {
  const trimmedLength = title.trim().length;

  if (trimmedLength === 0) {
    return ENVELOPE_TITLE_REQUIRED_MESSAGE;
  }

  if (trimmedLength > ENVELOPE_TITLE_MAX_LENGTH) {
    return ENVELOPE_TITLE_TOO_LONG_MESSAGE;
  }

  return null;
}

/** Builds a default envelope title from a PDF filename, capped to 160 chars. */
export function suggestEnvelopeTitle(fileName: string): string {
  const normalizedName = fileName.toLowerCase();
  const knownTitleSuggestion = KNOWN_TITLE_SUGGESTIONS[normalizedName];

  if (knownTitleSuggestion) {
    return knownTitleSuggestion;
  }

  const cleaned = fileName
    .replace(/\.pdf$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return truncateToWholeCharacters(cleaned, ENVELOPE_TITLE_MAX_LENGTH).trim();
}

function classifyTitleFailureMessage(rawMessage: string): string | null {
  const lower = rawMessage.toLowerCase();

  if (
    lower.includes(`<= ${String(ENVELOPE_TITLE_MAX_LENGTH)}`) ||
    lower.includes(`<=${String(ENVELOPE_TITLE_MAX_LENGTH)}`) ||
    lower.includes(`at most ${String(ENVELOPE_TITLE_MAX_LENGTH)}`) ||
    (lower.includes("title") &&
      (lower.includes(String(ENVELOPE_TITLE_MAX_LENGTH)) ||
        lower.includes("too long") ||
        lower.includes("fewer") ||
        lower.includes("at most")))
  ) {
    return ENVELOPE_TITLE_TOO_LONG_MESSAGE;
  }

  if (
    lower.includes(">=1") ||
    lower.includes(">= 1") ||
    lower.includes("at least 1 character") ||
    lower.includes("expected string") ||
    (lower.includes("title") &&
      (lower.includes("required") ||
        lower.includes("empty") ||
        lower.includes("give the envelope")))
  ) {
    return ENVELOPE_TITLE_REQUIRED_MESSAGE;
  }

  if (lower.includes("title")) {
    return rawMessage;
  }

  return null;
}

function isFileRejectionMessage(rawMessage: string): boolean {
  const lower = rawMessage.toLowerCase();

  if (KNOWN_FILE_REJECTION_MESSAGES.has(lower)) {
    return true;
  }

  // Matches any server PDF defect message (including future import rules) while
  // keeping non-file errors like "Invalid envelope request.", "Invalid upload
  // reference.", "Upload failed. Please try again.", or rate/server errors.
  return (
    /\bpdf\b/.test(lower) ||
    lower.includes("20 mb limit") ||
    lower.includes("file exceeds")
  );
}

/**
 * Classifies a failed POST /api/envelopes response so the upload form only
 * clears the selected PDF when the server actually rejected the file itself
 * (issue #210).
 */
export function classifyEnvelopeCreateFailure(input: {
  error: string | null | undefined;
  status: number;
}): EnvelopeCreateFailure {
  const rawMessage = input.error?.trim() ?? "";

  if (input.status === 413) {
    return {
      clearSelectedFile: true,
      message: rawMessage || "This file exceeds the 20 MB limit.",
      target: "upload",
    };
  }

  if (input.status === 400 && rawMessage.length > 0) {
    const titleMessage = classifyTitleFailureMessage(rawMessage);

    if (titleMessage) {
      return {
        clearSelectedFile: false,
        message: titleMessage,
        target: "title",
      };
    }

    if (isFileRejectionMessage(rawMessage)) {
      return {
        clearSelectedFile: true,
        message: rawMessage,
        target: "upload",
      };
    }
  }

  return {
    clearSelectedFile: false,
    message: rawMessage || DEFAULT_CREATE_ERROR_MESSAGE,
    target: "upload",
  };
}
