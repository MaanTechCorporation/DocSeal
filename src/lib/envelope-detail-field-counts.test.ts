import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { QueryResult } from "pg";

import type { DbExecutor } from "./db/connection.ts";
import {
  getEnvelopeDetailDataForUser,
  getReviewEnvelopeDataForUser,
} from "./envelopes.ts";
import type {
  EnvelopeStatus,
  FieldType,
  RecipientRole,
} from "./types/domain.ts";

// Regression tests for issue #209: envelope detail signer summaries must count
// Date and Name fields (matching Place fields and Review) without disturbing
// approver rows or radio-group collapsing.

type MockSigner = {
  createdAt: number;
  declineReason: string | null;
  declinedAt: number | null;
  email: string;
  envelopeId: string;
  id: string;
  lastNotifiedAt: number | null;
  lastNudgedAt: number | null;
  name: string;
  role: RecipientRole;
  signatureMeaning: null;
  signedAt: number | null;
  signOrder: number;
  signingStep: number;
  signingTokenExpiresAt: number | null;
  signingTokenHash: string | null;
  status: "pending" | "notified" | "signed" | "declined";
  turnStartedAt: number | null;
  updatedAt: number;
};

type MockField = {
  checked: boolean | null;
  createdAt: number;
  envelopeId: string;
  groupId: string | null;
  height: number;
  id: string;
  imageKey: string | null;
  inputMethod: "auto" | "typed" | null;
  label: string | null;
  options: string[] | null;
  page: number;
  required: boolean;
  signerId: string;
  submittedAt: number | null;
  type: FieldType;
  updatedAt: number;
  value: string | null;
  width: number;
  x: number;
  y: number;
};

function queryResult<T>(rows: T[]): QueryResult {
  return {
    command: "",
    fields: [],
    oid: 0,
    rowCount: rows.length,
    rows,
  } as unknown as QueryResult;
}

function createMockDetailDb(input: {
  fields: MockField[];
  signers: MockSigner[];
  status: EnvelopeStatus;
}): { database: DbExecutor; envelopeId: string; userId: string } {
  const now = 1_800_000_000;
  const userId = "user-1";
  const envelopeId = "envelope-1";
  const envelope = {
    completedAt: input.status === "completed" ? now + 60 : null,
    createdAt: now,
    declinedAt: null,
    evidenceKey: null,
    expiresAt: null,
    id: envelopeId,
    pageCount: 1,
    part11: false,
    reminderIntervalDays: null,
    sentAt: input.status === "draft" ? null : now + 10,
    signatureLevel: "simple" as const,
    signatureProvider: null,
    signedPdfKey: null,
    sourcePdfFilename: "agreement.pdf",
    sourcePdfHash: "a".repeat(64),
    sourcePdfKey: "users/user-1/envelopes/envelope-1/original.pdf",
    sourcePdfSizeBytes: 1024,
    status: input.status,
    title: "Service Agreement",
    updatedAt: now,
    userId,
    voidedAt: null,
  };

  const database = {
    async query(text: string) {
      const sql = text.replace(/\s+/g, " ").trim();

      if (sql.includes("FROM envelopes WHERE id = $1 AND user_id = $2")) {
        return queryResult([envelope]);
      }

      if (
        sql.includes("FROM signers WHERE envelope_id IN") &&
        !sql.includes("role = 'cc'")
      ) {
        return queryResult(input.signers);
      }

      if (sql.includes("FROM signers") && sql.includes("role = 'cc'")) {
        return queryResult([]);
      }

      if (sql.includes("FROM fields WHERE envelope_id IN")) {
        return queryResult(input.fields);
      }

      if (sql.includes("FROM audit_events")) {
        return queryResult([]);
      }

      if (sql.toLowerCase().includes("app_settings")) {
        return queryResult([{ part11_mode: false }]);
      }

      throw new Error(`Unexpected SQL in mock detail DB: ${sql}`);
    },
  } as unknown as DbExecutor;

  return { database, envelopeId, userId };
}

function makeSigner(
  overrides: Partial<MockSigner> & Pick<MockSigner, "id" | "name" | "email">,
): MockSigner {
  const now = 1_800_000_000;

  return {
    createdAt: now,
    declineReason: null,
    declinedAt: null,
    envelopeId: "envelope-1",
    lastNotifiedAt: null,
    lastNudgedAt: null,
    role: "signer",
    signatureMeaning: null,
    signedAt: null,
    signOrder: 1,
    signingStep: 1,
    signingTokenExpiresAt: null,
    signingTokenHash: null,
    status: "pending",
    turnStartedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

function makeField(
  signerId: string,
  type: FieldType,
  overrides: Partial<MockField> = {},
): MockField {
  const now = 1_800_000_000;

  return {
    checked: null,
    createdAt: now,
    envelopeId: "envelope-1",
    groupId: null,
    height: 0.04,
    id: randomUUID(),
    imageKey: null,
    inputMethod: null,
    label: null,
    options: null,
    page: 1,
    required: true,
    signerId,
    submittedAt: null,
    type,
    updatedAt: now,
    value: null,
    width: 0.2,
    x: 0.1,
    y: 0.1,
    ...overrides,
  };
}

test("envelope detail counts Date and Name fields in draft and completed summaries (issue #209)", async () => {
  const signerId = "signer-1";
  const fields = [
    makeField(signerId, "signature", { y: 0.1 }),
    makeField(signerId, "date", { y: 0.2 }),
    makeField(signerId, "name", { y: 0.3 }),
  ];

  // Draft envelope: detail matches Review (3 fields).
  const draftMock = createMockDetailDb({
    fields,
    signers: [
      makeSigner({
        email: "riley@example.test",
        id: signerId,
        name: "Riley Recipient",
        status: "pending",
      }),
    ],
    status: "draft",
  });
  const draftDetail = await getEnvelopeDetailDataForUser(
    draftMock.userId,
    draftMock.envelopeId,
    draftMock.database,
  );
  const draftReview = await getReviewEnvelopeDataForUser(
    draftMock.userId,
    draftMock.envelopeId,
    draftMock.database,
  );

  assert.equal(draftDetail?.signers[0]?.metaLabel, "3 fields assigned");
  assert.deepEqual(draftReview?.signers[0]?.fieldSummaries, [
    "Signature",
    "Date",
    "Name",
  ]);

  // Completed envelope: all 3 rows submitted -> "3 fields completed".
  const completedAt = 1_800_000_060;
  const completedMock = createMockDetailDb({
    fields: [
      makeField(signerId, "signature", {
        inputMethod: "typed",
        submittedAt: completedAt,
        value: "Riley Recipient",
        y: 0.1,
      }),
      makeField(signerId, "date", {
        inputMethod: "auto",
        submittedAt: completedAt,
        value: "2026-11-25",
        y: 0.2,
      }),
      makeField(signerId, "name", {
        inputMethod: "auto",
        submittedAt: completedAt,
        value: "Riley Recipient",
        y: 0.3,
      }),
    ],
    signers: [
      makeSigner({
        email: "riley@example.test",
        id: signerId,
        name: "Riley Recipient",
        signedAt: completedAt,
        status: "signed",
      }),
    ],
    status: "completed",
  });
  const completedDetail = await getEnvelopeDetailDataForUser(
    completedMock.userId,
    completedMock.envelopeId,
    completedMock.database,
  );

  assert.equal(completedDetail?.signers[0]?.metaLabel, "3 fields completed");
});

test("Signature + Text control and approvers remain accurate on envelope detail (issue #209)", async () => {
  const signerId = "signer-1";
  const approverId = "approver-1";
  const groupId = randomUUID();
  const draftMock = createMockDetailDb({
    fields: [
      makeField(signerId, "signature", { y: 0.1 }),
      makeField(signerId, "text", { y: 0.2 }),
    ],
    signers: [
      makeSigner({
        email: "riley@example.test",
        id: signerId,
        name: "Riley Recipient",
        signOrder: 1,
        signingStep: 1,
        status: "pending",
      }),
      makeSigner({
        email: "alex@example.test",
        id: approverId,
        name: "Alex Approver",
        role: "approver",
        signOrder: 2,
        signingStep: 2,
        status: "pending",
      }),
    ],
    status: "draft",
  });
  const draftDetail = await getEnvelopeDetailDataForUser(
    draftMock.userId,
    draftMock.envelopeId,
    draftMock.database,
  );

  assert.deepEqual(
    draftDetail?.signers.map((signer) => signer.metaLabel),
    ["2 fields assigned", "Approver"],
  );

  const completedAt = 1_800_000_060;
  const completedMock = createMockDetailDb({
    fields: [
      makeField(signerId, "signature", { submittedAt: completedAt, y: 0.1 }),
      makeField(signerId, "text", {
        submittedAt: completedAt,
        value: "Hello",
        y: 0.2,
      }),
    ],
    signers: [
      makeSigner({
        email: "riley@example.test",
        id: signerId,
        name: "Riley Recipient",
        signedAt: completedAt,
        signOrder: 1,
        signingStep: 1,
        status: "signed",
      }),
      makeSigner({
        email: "alex@example.test",
        id: approverId,
        name: "Alex Approver",
        role: "approver",
        signedAt: completedAt,
        signOrder: 2,
        signingStep: 2,
        status: "signed",
      }),
    ],
    status: "completed",
  });
  const completedDetail = await getEnvelopeDetailDataForUser(
    completedMock.userId,
    completedMock.envelopeId,
    completedMock.database,
  );

  assert.deepEqual(
    completedDetail?.signers.map((signer) => signer.metaLabel),
    ["2 fields completed", "Approved"],
  );

  // Radio group still counts as one field alongside Date/Name; optional
  // checkboxes remain excluded from the signer summary count.
  const mixedMock = createMockDetailDb({
    fields: [
      makeField(signerId, "signature", { y: 0.1 }),
      makeField(signerId, "date", { y: 0.2 }),
      makeField(signerId, "name", { y: 0.3 }),
      makeField(signerId, "radio", { groupId, label: "Yes", y: 0.4 }),
      makeField(signerId, "radio", { groupId, label: "No", y: 0.45 }),
      makeField(signerId, "checkbox", { required: false, y: 0.5 }),
      makeField(signerId, "checkbox", { required: true, y: 0.55 }),
    ],
    signers: [
      makeSigner({
        email: "riley@example.test",
        id: signerId,
        name: "Riley Recipient",
        status: "pending",
      }),
    ],
    status: "draft",
  });
  const mixedDetail = await getEnvelopeDetailDataForUser(
    mixedMock.userId,
    mixedMock.envelopeId,
    mixedMock.database,
  );

  assert.equal(mixedDetail?.signers[0]?.metaLabel, "5 fields assigned");
});
