import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type { Pool, QueryResult } from "pg";

import { bulkSendFromTemplate, BulkSendError } from "./bulk-send.ts";
import {
  StorageObjectNotFoundError,
  type StorageService,
} from "./services/storage.ts";

// Unit tests for issue #223: bulk-send preview and confirm must refuse a
// template whose dropdown choices cannot be rendered at a readable size,
// before marking any row Ready or creating any draft envelopes or batches.

const LONG_CHOICES = [
  "Approved with the conditions listed in the schedule",
  "Rejected until the landlord answers the open questions",
];

async function makeLetterPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  return pdf.save();
}

function makeMemoryStorage(files: Record<string, Uint8Array>): StorageService {
  const refuse = async (): Promise<never> => {
    throw new Error("unexpected storage write/delete");
  };

  return {
    deleteObject: refuse,
    async getObject(key) {
      const body = files[key];

      if (!body) {
        throw new StorageObjectNotFoundError(key);
      }

      return {
        body,
        bucketName: "test-bucket",
        contentLength: body.byteLength,
        contentType: "application/pdf",
        key,
      };
    },
    getObjectStream: refuse,
    headObject: refuse,
    putObject: refuse,
  };
}

function makeBulkSendDb(templateRow: {
  fields: unknown;
  id: string;
  name: string;
  pageCount: number;
  roles: unknown;
  sourcePdfFilename: string;
  sourcePdfKey: string;
}) {
  const executedSql: string[] = [];

  const pool = {
    async connect() {
      throw new Error("unexpected transaction before template validation");
    },
    async query(text: string): Promise<QueryResult> {
      const sql = text.replace(/\s+/g, " ").trim();
      executedSql.push(sql);

      if (sql.includes("FROM templates WHERE id = $1 AND user_id = $2")) {
        return {
          command: "",
          fields: [],
          oid: 0,
          rowCount: 1,
          rows: [{ ...templateRow, createdAt: 1_800_000_000 }],
        } as unknown as QueryResult;
      }

      if (sql.toLowerCase().includes("app_settings")) {
        return {
          command: "",
          fields: [],
          oid: 0,
          rowCount: 1,
          rows: [{ part11_mode: false }],
        } as unknown as QueryResult;
      }

      throw new Error(`Unexpected SQL executed: ${sql}`);
    },
    totalCount: 1,
  } as unknown as Pool;

  return { executedSql, pool };
}

test("bulkSendFromTemplate refuses preview and confirm for an unreadable dropdown without creating drafts or batches (issue #223)", async () => {
  const pdfBytes = await makeLetterPdf();
  const key = "templates/narrow-dropdown.pdf";
  const storageService = makeMemoryStorage({ [key]: pdfBytes });
  const role = { id: "role-1", name: "Signer" };
  const { executedSql, pool } = makeBulkSendDb({
    fields: [
      {
        height: 0.04,
        page: 1,
        required: true,
        signerId: role.id,
        type: "signature",
        width: 0.25,
        x: 0.1,
        y: 0.1,
      },
      {
        height: 0.012,
        options: LONG_CHOICES,
        page: 1,
        required: true,
        signerId: role.id,
        type: "dropdown",
        width: 0.05,
        x: 0.1,
        y: 0.3,
      },
    ],
    id: "tpl-narrow",
    name: "Narrow dropdown",
    pageCount: 1,
    roles: [role],
    sourcePdfFilename: "narrow-dropdown.pdf",
    sourcePdfKey: key,
  });
  const csv = "name,email\nAnn,ann@example.test\nBen,ben@example.test\n";

  // Preview (confirm: false) must reject instead of marking rows Ready.
  await assert.rejects(
    bulkSendFromTemplate(
      "user-1",
      "tpl-narrow",
      { confirm: false, csv },
      { database: pool, storageService },
    ),
    (error: unknown) =>
      error instanceof BulkSendError &&
      error.statusCode === 400 &&
      /A dropdown for Signer on page 1 is too small to show its choices at a readable size/.test(
        error.message,
      ),
  );

  // Confirm (confirm: true) must also reject before claiming a batch or
  // creating any draft envelope.
  await assert.rejects(
    bulkSendFromTemplate(
      "user-1",
      "tpl-narrow",
      {
        batchKey: randomUUID(),
        confirm: true,
        csv,
        permittedUseConfirmed: true,
      },
      {
        database: pool,
        sender: { email: "sam@example.test", name: "Sam Sender" },
        storageService,
      },
    ),
    (error: unknown) =>
      error instanceof BulkSendError &&
      error.statusCode === 400 &&
      /A dropdown for Signer on page 1 is too small to show its choices at a readable size/.test(
        error.message,
      ),
  );

  assert.equal(
    executedSql.some(
      (sql) =>
        sql.includes("INSERT INTO envelopes") ||
        sql.includes("INSERT INTO bulk_send_batches"),
    ),
    false,
  );
});

test("bulkSendFromTemplate marks rows Ready on preview when the template's dropdown is wide enough (issue #223)", async () => {
  const pdfBytes = await makeLetterPdf();
  const key = "templates/wide-dropdown.pdf";
  const storageService = makeMemoryStorage({ [key]: pdfBytes });
  const role = { id: "role-1", name: "Signer" };
  const { pool } = makeBulkSendDb({
    fields: [
      {
        height: 0.04,
        page: 1,
        required: true,
        signerId: role.id,
        type: "signature",
        width: 0.25,
        x: 0.1,
        y: 0.1,
      },
      {
        height: 0.03,
        options: LONG_CHOICES,
        page: 1,
        required: true,
        signerId: role.id,
        type: "dropdown",
        width: 0.6,
        x: 0.1,
        y: 0.3,
      },
    ],
    id: "tpl-wide",
    name: "Wide dropdown",
    pageCount: 1,
    roles: [role],
    sourcePdfFilename: "wide-dropdown.pdf",
    sourcePdfKey: key,
  });
  const csv = "name,email\nAnn,ann@example.test\nBen,ben@example.test\n";

  const preview = await bulkSendFromTemplate(
    "user-1",
    "tpl-wide",
    { confirm: false, csv },
    { database: pool, storageService },
  );

  assert.equal(preview.summary.ok, 2);
  assert.equal(preview.summary.skipped, 0);
  assert.deepEqual(
    preview.rows.map((row) => row.status),
    ["ok", "ok"],
  );
});
