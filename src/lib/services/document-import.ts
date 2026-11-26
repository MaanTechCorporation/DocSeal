import { createHash } from "node:crypto";

import {
  EncryptedPDFError,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNull,
} from "pdf-lib";

import type { EnvelopePageRecord } from "../schemas/envelope.ts";
import { MAX_PDF_PAGES, MAX_UPLOAD_SIZE_BYTES } from "../types/domain.ts";
import { getDisplayedPageGeometry } from "./pdf-page-geometry.ts";

const PDF_MAGIC_HEADER = "%PDF-";

const PDF_IMPORT_ERROR_MESSAGES = {
  encrypted_pdf:
    "This PDF is password-protected or encrypted. Please upload an unlocked PDF.",
  invalid_type: "Only PDF files are supported. Please upload a valid PDF.",
  too_large: "This file exceeds the 20 MB limit.",
  too_many_pages: `This PDF has more than ${String(MAX_PDF_PAGES)} pages. Split it into smaller documents.`,
  unreadable_pdf: "We couldn't read this PDF. Please upload a valid file.",
  unsupported_variant:
    "This PDF uses an unsupported format. Please export it as a standard PDF.",
  upload_failed: "Upload failed. Please try again.",
} as const;

export const pdfImportFailureCodes = [
  "encrypted_pdf",
  "invalid_type",
  "too_large",
  "too_many_pages",
  "unreadable_pdf",
  "unsupported_variant",
  "upload_failed",
] as const;

export type PdfImportFailureCode = (typeof pdfImportFailureCodes)[number];

export type PdfImportError = {
  code: PdfImportFailureCode;
  message: string;
};

export type ImportedPdfPage = Pick<
  EnvelopePageRecord,
  "heightPt" | "pageNumber" | "widthPt"
>;

export type ImportedPdfDocument = {
  encrypted: boolean;
  filename: string;
  pageCount: number;
  pages: ImportedPdfPage[];
  pureXfa: boolean;
  sizeBytes: number;
  sourceHash: string;
};

type ImportPdfDocumentInput = {
  body: Uint8Array;
  contentType?: string | null;
  filename: string;
  maxSizeBytes?: number;
};

export class DocumentImportError extends Error {
  code: PdfImportFailureCode;

  constructor(
    code: PdfImportFailureCode,
    message = getPdfImportErrorMessage(code),
  ) {
    super(message);
    this.code = code;
    this.name = "DocumentImportError";
  }
}

export const DEFAULT_DOCUMENT_IMPORT_LIMITS = {
  maxSizeBytes: MAX_UPLOAD_SIZE_BYTES,
};

export function getPdfImportErrorMessage(code: PdfImportFailureCode): string {
  return PDF_IMPORT_ERROR_MESSAGES[code];
}

function assertImportRequest(input: {
  contentType?: string | null;
  filename: string;
  maxSizeBytes: number;
  sizeBytes: number;
}): void {
  if (!input.filename.toLowerCase().endsWith(".pdf")) {
    throw new DocumentImportError("invalid_type");
  }

  const normalizedContentType = input.contentType?.trim().toLowerCase() ?? "";

  if (
    normalizedContentType.length > 0 &&
    normalizedContentType !== "application/pdf"
  ) {
    throw new DocumentImportError("invalid_type");
  }

  if (input.sizeBytes > input.maxSizeBytes) {
    throw new DocumentImportError("too_large");
  }
}

function isEncryptedPdfError(error: unknown): boolean {
  if (error instanceof EncryptedPDFError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const normalizedMessage = error.message.trim().toLowerCase();

  return (
    error.name === "PasswordException" ||
    error.name === "EncryptedPDFError" ||
    normalizedMessage.includes("password") ||
    normalizedMessage.includes("encrypted")
  );
}

function looksLikePdf(body: Uint8Array): boolean {
  if (body.length < PDF_MAGIC_HEADER.length) {
    return false;
  }

  const header = new TextDecoder("latin1").decode(
    body.subarray(0, PDF_MAGIC_HEADER.length),
  );

  return header === PDF_MAGIC_HEADER;
}

function hasEncryptionEntry(document: PDFDocument): boolean {
  if (document.isEncrypted) {
    return true;
  }

  const encryptEntry = document.context.trailerInfo.Encrypt;

  return encryptEntry !== undefined && encryptEntry !== PDFNull;
}

function hasXfaForm(document: PDFDocument): boolean {
  if (!(document.catalog instanceof PDFDict)) {
    return false;
  }

  const acroForm = document.catalog.lookup(PDFName.of("AcroForm"));

  if (!(acroForm instanceof PDFDict)) {
    return false;
  }

  const xfaEntry = acroForm.get(PDFName.of("XFA"));

  if (xfaEntry === undefined || xfaEntry === PDFNull) {
    return false;
  }

  return document.context.lookup(xfaEntry) !== PDFNull;
}

async function parsePdfDocument(
  body: Uint8Array,
): Promise<{ pages: ImportedPdfPage[]; pureXfa: boolean }> {
  const document = await PDFDocument.load(body, {
    ignoreEncryption: false,
    updateMetadata: false,
  });

  if (hasEncryptionEntry(document)) {
    throw new DocumentImportError("encrypted_pdf");
  }

  if (hasXfaForm(document)) {
    throw new DocumentImportError("unsupported_variant");
  }

  if (document.getPageCount() > MAX_PDF_PAGES) {
    throw new DocumentImportError("too_many_pages");
  }

  // The size of each page as a reader shows it: the CropBox, with width and
  // height swapped on a page rotated a quarter turn. The field overlay is
  // laid out to this size, so it has to match what the browser draws.
  const pages = document.getPages().map((page, index) => {
    const { heightPt, widthPt } = getDisplayedPageGeometry(page);

    return { heightPt, pageNumber: index + 1, widthPt };
  });

  return {
    pages,
    pureXfa: false,
  };
}

function hashDocument(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export async function importPdfDocument({
  body,
  contentType,
  filename,
  maxSizeBytes = DEFAULT_DOCUMENT_IMPORT_LIMITS.maxSizeBytes,
}: ImportPdfDocumentInput): Promise<ImportedPdfDocument> {
  const normalizedFilename = filename.trim() || "document.pdf";
  const sizeBytes = body.length;

  assertImportRequest({
    contentType,
    filename: normalizedFilename,
    maxSizeBytes,
    sizeBytes,
  });

  if (!looksLikePdf(body)) {
    throw new DocumentImportError("invalid_type");
  }

  const sourceHash = hashDocument(body);

  try {
    const { pages, pureXfa } = await parsePdfDocument(body.slice());

    return {
      encrypted: false,
      filename: normalizedFilename,
      pageCount: pages.length,
      pages,
      pureXfa,
      sizeBytes,
      sourceHash,
    };
  } catch (error) {
    if (error instanceof DocumentImportError) {
      throw error;
    }

    if (isEncryptedPdfError(error)) {
      throw new DocumentImportError("encrypted_pdf");
    }

    throw new DocumentImportError("unreadable_pdf");
  }
}
